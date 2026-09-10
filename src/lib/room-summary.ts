import { randomUUID } from "node:crypto";
import type { Prisma, SessionSummary } from "../generated/prisma/client";
import type { SummaryProvider, SummarySource } from "./deepseek";
import { SummaryProviderError } from "./deepseek";
import { db } from "./db";
import { loadRoomAccess } from "./room-access";
import { RoomApiError } from "./room-api";
import { canPerformRoomAction, canReadRoomHistory } from "./room-policy";
import type { SummarySnapshot } from "./summary-input";

const MAX_SOURCE_CHARACTERS = 12_000;
const MAX_MESSAGE_CHARACTERS = 1_000;
const GENERATION_LEASE_MS = 2 * 60_000;

function snapshot(summary: SessionSummary | null): SummarySnapshot {
  if (!summary)
    return {
      status: "PENDING",
      content: null,
      model: null,
      error: null,
      requestedAt: null,
      updatedAt: null,
      promptTokens: null,
      completionTokens: null,
      sourceMessageCount: null,
    };
  return {
    status: summary.status,
    content: summary.content,
    model: summary.model,
    error: summary.error,
    requestedAt: summary.requestedAt?.toISOString() ?? null,
    updatedAt: summary.updatedAt.toISOString(),
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    sourceMessageCount: summary.sourceMessageCount,
  };
}

async function summaryAccess(
  tx: Prisma.TransactionClient,
  roomId: string,
  userId: string,
) {
  const access = await loadRoomAccess(roomId, userId, tx);
  if (!access)
    throw new RoomApiError(
      404,
      "ROOM_NOT_FOUND",
      "This room is unavailable. Check the link.",
    );
  if (!canReadRoomHistory(access.policy))
    throw new RoomApiError(
      403,
      "MEMBERSHIP_REQUIRED",
      "The session summary is available to current room members.",
    );
  if (access.room.status !== "ENDED")
    throw new RoomApiError(
      409,
      "ROOM_NOT_ENDED",
      "End the discussion before generating its summary.",
    );
  return access;
}

export async function getRoomSummary(
  roomId: string,
  userId: string,
  now = new Date(),
) {
  return db.$transaction(async (tx) => {
    // A crashed request cannot leave the UI polling GENERATING forever. The
    // same write lock as generation serializes expiry against a new attempt.
    await tx.$executeRaw`UPDATE rooms SET id = id WHERE id = ${roomId}`;
    await summaryAccess(tx, roomId, userId);
    await tx.sessionSummary.updateMany({
      where: {
        roomId,
        status: "GENERATING",
        OR: [
          { requestedAt: null },
          {
            requestedAt: { lte: new Date(now.getTime() - GENERATION_LEASE_MS) },
          },
        ],
      },
      data: {
        status: "FAILED",
        attemptId: null,
        error: "Summary generation timed out. The host can retry.",
      },
    });
    return snapshot(await tx.sessionSummary.findUnique({ where: { roomId } }));
  });
}

function buildSource(
  room: { title: string; topic: string },
  messages: Array<{ body: string; user: { name: string } }>,
) {
  const lines: string[] = [];
  let size = 0;
  for (const message of messages) {
    const body = message.body.slice(0, MAX_MESSAGE_CHARACTERS);
    const line = `${message.user.name.slice(0, 100)}: ${body}`;
    if (size + line.length + 1 > MAX_SOURCE_CHARACTERS) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  const source: SummarySource = {
    roomTitle: room.title.slice(0, 200),
    topic: room.topic,
    transcript: lines.join("\n"),
  };
  return { source, sourceMessageCount: lines.length };
}

function providerFailureMessage(error: unknown) {
  if (error instanceof SummaryProviderError) {
    if (error.code === "MISSING_CONFIGURATION")
      return "DeepSeek is not configured on this computer.";
    if (error.code === "TIMEOUT")
      return "DeepSeek timed out. Retry when the network is stable.";
    if (error.code === "REQUEST_REJECTED")
      return "DeepSeek rejected the request. Check the key and available balance.";
  }
  return "DeepSeek returned an unusable response. Retry the summary.";
}

export async function generateRoomSummary(
  provider: SummaryProvider,
  roomId: string,
  userId: string,
  now = new Date(),
) {
  const prepared = await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE rooms SET id = id WHERE id = ${roomId}`;
    const access = await summaryAccess(tx, roomId, userId);
    if (!canPerformRoomAction(access.policy, { action: "generate_summary" }))
      throw new RoomApiError(
        403,
        "SUMMARY_FORBIDDEN",
        "Only the host can generate this session summary.",
      );
    const existing = await tx.sessionSummary.findUnique({ where: { roomId } });
    if (existing?.status === "READY")
      return { kind: "ready" as const, summary: existing };
    if (
      existing?.status === "GENERATING" &&
      existing.requestedAt &&
      existing.requestedAt.getTime() > now.getTime() - GENERATION_LEASE_MS
    )
      throw new RoomApiError(
        409,
        "SUMMARY_IN_PROGRESS",
        "A summary is already being generated. Refresh shortly.",
      );
    const messages = await tx.chatMessage.findMany({
      where: { roomId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      include: { user: { select: { name: true } } },
    });
    const { source, sourceMessageCount } = buildSource(access.room, messages);
    if (!sourceMessageCount) {
      const failed = await tx.sessionSummary.upsert({
        where: { roomId },
        create: {
          roomId,
          status: "FAILED",
          error: "No written chat is available to summarize.",
          requestedAt: now,
          sourceMessageCount: 0,
        },
        update: {
          status: "FAILED",
          content: null,
          error: "No written chat is available to summarize.",
          requestedAt: now,
          attemptId: null,
          promptTokens: null,
          completionTokens: null,
          sourceMessageCount: 0,
        },
      });
      return { kind: "empty" as const, summary: failed };
    }
    const attemptId = randomUUID();
    await tx.sessionSummary.upsert({
      where: { roomId },
      create: {
        roomId,
        status: "GENERATING",
        model: provider.model,
        requestedAt: now,
        attemptId,
        sourceMessageCount,
      },
      update: {
        status: "GENERATING",
        content: null,
        model: provider.model,
        error: null,
        requestedAt: now,
        attemptId,
        promptTokens: null,
        completionTokens: null,
        sourceMessageCount,
      },
    });
    return { kind: "generate" as const, attemptId, source };
  });

  if (prepared.kind === "ready") return snapshot(prepared.summary);
  if (prepared.kind === "empty")
    throw new RoomApiError(
      422,
      "SUMMARY_SOURCE_EMPTY",
      prepared.summary.error ?? "No written chat is available to summarize.",
    );

  let generated;
  try {
    generated = await provider.generate(prepared.source);
  } catch (error) {
    const message = providerFailureMessage(error);
    const updated = await db.sessionSummary.updateMany({
      where: {
        roomId,
        status: "GENERATING",
        attemptId: prepared.attemptId,
      },
      data: { status: "FAILED", error: message, attemptId: null },
    });
    if (!updated.count)
      throw new RoomApiError(
        409,
        "SUMMARY_SUPERSEDED",
        "A newer summary attempt replaced this result. Refresh the page.",
      );
    throw new RoomApiError(503, "SUMMARY_PROVIDER_FAILED", message);
  }
  const updated = await db.sessionSummary.updateMany({
    where: {
      roomId,
      status: "GENERATING",
      attemptId: prepared.attemptId,
    },
    data: {
      status: "READY",
      content: generated.content,
      model: generated.model,
      error: null,
      attemptId: null,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
    },
  });
  if (!updated.count)
    throw new RoomApiError(
      409,
      "SUMMARY_SUPERSEDED",
      "A newer summary attempt replaced this result. Refresh the page.",
    );
  return snapshot(
    await db.sessionSummary.findUniqueOrThrow({ where: { roomId } }),
  );
}
