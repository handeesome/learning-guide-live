import type { Prisma, RoomMember } from "../generated/prisma/client";
import type { MediaGateway } from "./livekit";
import { mediaRoomName } from "./livekit";
import { db } from "./db";
import { loadRoomAccess } from "./room-access";
import { RoomApiError } from "./room-api";
import {
  canPerformRoomAction,
  canReadRoomHistory,
  roomRole,
} from "./room-policy";
import { openRoomForWrite } from "./room-transaction";
import {
  chatInput,
  focusInput,
  handInput,
  type CollaborationSnapshot,
} from "./collaboration-input";

const encoder = new TextEncoder();
type SignalType = "chat" | "state";

async function notify(
  gateway: MediaGateway,
  roomId: string,
  type: SignalType,
  entityId?: string,
) {
  try {
    await gateway.broadcast(
      mediaRoomName(roomId),
      encoder.encode(JSON.stringify({ version: 1, type, entityId })),
    );
    return true;
  } catch {
    // SQL remains authoritative. Clients reconcile on their bounded poll.
    return false;
  }
}

async function activeAccess(
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
  return access;
}

export async function getCollaborationSnapshot(
  roomId: string,
  userId: string,
): Promise<CollaborationSnapshot> {
  return db.$transaction(async (tx) => {
    const access = await activeAccess(tx, roomId, userId);
    const selfRole = roomRole(access.policy);
    if (!selfRole || !canReadRoomHistory(access.policy))
      throw new RoomApiError(
        403,
        "MEMBERSHIP_REQUIRED",
        "Room collaboration is available to current members.",
      );
    const [messages, members] = await Promise.all([
      tx.chatMessage.findMany({
        where: { roomId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        include: { user: { select: { name: true } } },
      }),
      tx.roomMember.findMany({
        where: {
          roomId,
          OR: [
            { status: { not: "KICKED" } },
            {
              status: "KICKED",
              mediaIdentity: { not: null },
              mediaRevoking: true,
            },
          ],
        },
        // Current media holders must not disappear behind old membership rows.
        orderBy: [
          { mediaRevoking: "desc" },
          { status: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        take: 100,
        include: { user: { select: { name: true } } },
      }),
    ]);
    const focused = members.some(
      (member) =>
        member.userId === access.room.focusedUserId &&
        member.status === "ACTIVE",
    )
      ? access.room.focusedUserId
      : null;
    return {
      roomStatus: access.room.status,
      selfUserId: userId,
      selfRole,
      focusedUserId: focused,
      messages: messages
        .toReversed()
        .map(({ user, createdAt, id, userId: senderId, body }) => ({
          id,
          userId: senderId,
          name: user.name,
          body,
          createdAt: createdAt.toISOString(),
        })),
      members: members
        .filter(
          (member) =>
            member.status !== "KICKED" || retryKickAllowed(access, member),
        )
        .map(({ user, ...member }) => ({
          userId: member.userId,
          name: user.name,
          role: member.role,
          status: member.status,
          handRaised: member.handRaised,
          mediaIdentity: member.mediaIdentity,
          mediaRemovalPending:
            member.status === "KICKED" &&
            member.mediaRevoking &&
            Boolean(member.mediaIdentity),
        })),
      serverTime: new Date().toISOString(),
    };
  });
}

export async function sendChatMessage(
  gateway: MediaGateway,
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = chatInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Write a message between 1 and 2,000 characters.",
    );
  const message = await db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await activeAccess(tx, roomId, userId);
    if (!canPerformRoomAction(access.policy, { action: "send_chat" }))
      throw new RoomApiError(
        403,
        "ACTIVE_MEMBER_REQUIRED",
        "Join the live discussion before sending a message.",
      );
    return tx.chatMessage.create({
      data: { roomId, userId, body: parsed.data.body },
      include: { user: { select: { name: true } } },
    });
  });
  const broadcast = await notify(gateway, roomId, "chat", message.id);
  return {
    message: {
      id: message.id,
      userId: message.userId,
      name: message.user.name,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    },
    broadcast,
  };
}

export async function setHandRaised(
  gateway: MediaGateway,
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = handInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Choose whether to raise or lower a current member's hand.",
    );
  const result = await db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await activeAccess(tx, roomId, userId);
    const targetUserId = parsed.data.targetUserId ?? userId;
    const target = await tx.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: targetUserId } },
    });
    if (!target)
      throw new RoomApiError(
        404,
        "MEMBER_NOT_FOUND",
        "This participant is no longer in the room.",
      );
    const changingSelf = targetUserId === userId;
    const allowed = changingSelf
      ? canPerformRoomAction(access.policy, { action: "raise_hand" })
      : !parsed.data.raised &&
        canPerformRoomAction(access.policy, {
          action: "lower_hand",
          target,
        });
    if (!allowed)
      throw new RoomApiError(
        403,
        "HAND_ACTION_FORBIDDEN",
        "You cannot change this participant's hand state.",
      );
    if (target.handRaised === parsed.data.raised)
      return {
        changed: false,
        userId: target.userId,
        raised: target.handRaised,
      };
    const updated = await tx.roomMember.update({
      where: { id: target.id },
      data: { handRaised: parsed.data.raised },
      select: { userId: true, handRaised: true },
    });
    return {
      changed: true,
      userId: updated.userId,
      raised: updated.handRaised,
    };
  });
  return { ...result, broadcast: await notify(gateway, roomId, "state") };
}

export async function setRoomFocus(
  gateway: MediaGateway,
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = focusInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Choose an active participant to focus, or clear the focus.",
    );
  const result = await db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await activeAccess(tx, roomId, userId);
    let target: RoomMember | null = null;
    if (parsed.data.targetUserId) {
      target = await tx.roomMember.findUnique({
        where: {
          roomId_userId: { roomId, userId: parsed.data.targetUserId },
        },
      });
      if (!target)
        throw new RoomApiError(
          404,
          "MEMBER_NOT_FOUND",
          "This participant is no longer in the room.",
        );
    }
    const allowed = target
      ? canPerformRoomAction(access.policy, { action: "set_focus", target })
      : canPerformRoomAction(access.policy, { action: "clear_focus" });
    if (!allowed)
      throw new RoomApiError(
        403,
        "FOCUS_ACTION_FORBIDDEN",
        "Only an active host or moderator can change the focus.",
      );
    if (access.room.focusedUserId === parsed.data.targetUserId)
      return { changed: false, focusedUserId: access.room.focusedUserId };
    const room = await tx.room.update({
      where: { id: roomId },
      data: { focusedUserId: parsed.data.targetUserId },
      select: { focusedUserId: true },
    });
    return { changed: true, focusedUserId: room.focusedUserId };
  });
  return { ...result, broadcast: await notify(gateway, roomId, "state") };
}

function retryKickAllowed(
  access: Awaited<ReturnType<typeof loadRoomAccess>>,
  target: RoomMember,
) {
  if (!access || access.policy.member?.status !== "ACTIVE") return false;
  const actorRole = roomRole(access.policy);
  if (
    (actorRole !== "HOST" && actorRole !== "MODERATOR") ||
    target.userId === access.policy.userId
  )
    return false;
  return (
    target.role === "PARTICIPANT" ||
    (actorRole === "HOST" && target.role === "MODERATOR")
  );
}

export async function kickRoomMember(
  gateway: MediaGateway,
  roomId: string,
  userId: string,
  targetUserId: string,
) {
  const prepared = await db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await activeAccess(tx, roomId, userId);
    const target = await tx.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: targetUserId } },
    });
    if (!target)
      throw new RoomApiError(
        404,
        "MEMBER_NOT_FOUND",
        "This participant is no longer in the room.",
      );
    const retry = target.status === "KICKED";
    if (
      (!retry &&
        !canPerformRoomAction(access.policy, {
          action: "kick_member",
          target,
        })) ||
      (retry && !retryKickAllowed(access, target))
    )
      throw new RoomApiError(
        403,
        "KICK_FORBIDDEN",
        "You cannot remove this participant.",
      );
    if (target.status === "KICKED" && !target.mediaIdentity)
      return { member: target, changed: false };
    const updated = await tx.roomMember.update({
      where: { id: target.id },
      data: {
        status: "KICKED",
        handRaised: false,
        mediaRevoking: Boolean(target.mediaIdentity),
      },
    });
    await tx.room.updateMany({
      where: { id: roomId, focusedUserId: target.userId },
      data: { focusedUserId: null },
    });
    return { member: updated, changed: target.status !== "KICKED" };
  });
  const identity = prepared.member.mediaIdentity;
  if (identity) {
    try {
      await gateway.revoke(mediaRoomName(roomId), identity);
    } catch {
      throw new RoomApiError(
        503,
        "MEDIA_REMOVAL_PENDING",
        "Room access is blocked, but media disconnection is unconfirmed. Retry removal.",
      );
    }
    await db.roomMember.updateMany({
      where: {
        id: prepared.member.id,
        status: "KICKED",
        mediaIdentity: identity,
        mediaRevoking: true,
      },
      data: {
        mediaIdentity: null,
        mediaTokenExpiresAt: null,
        mediaAbsentSince: null,
        mediaRevoking: false,
        seatExpiresAt: null,
        seatOwnerId: null,
        seatReservationId: null,
      },
    });
  }
  return {
    changed: prepared.changed,
    userId: targetUserId,
    broadcast: await notify(gateway, roomId, "state"),
  };
}

export async function endRoom(
  gateway: MediaGateway,
  roomId: string,
  userId: string,
) {
  const prepared = await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE rooms SET id = id WHERE id = ${roomId}`;
    const access = await activeAccess(tx, roomId, userId);
    if (!canPerformRoomAction(access.policy, { action: "end_room" }))
      throw new RoomApiError(
        403,
        "END_ROOM_FORBIDDEN",
        "Only the host can end this room.",
      );
    const changed = access.room.status === "OPEN";
    if (changed) {
      await tx.room.update({
        where: { id: roomId },
        data: { status: "ENDING", focusedUserId: null },
      });
      await tx.roomMember.updateMany({
        where: { roomId },
        data: { handRaised: false },
      });
    }
    const members = await tx.roomMember.findMany({
      where: { roomId, mediaIdentity: { not: null } },
      select: { mediaIdentity: true },
    });
    return {
      changed,
      identities: members.flatMap((member) =>
        member.mediaIdentity ? [member.mediaIdentity] : [],
      ),
    };
  });
  try {
    for (const identity of prepared.identities)
      await gateway.revoke(mediaRoomName(roomId), identity);
    await gateway.close(mediaRoomName(roomId));
  } catch {
    throw new RoomApiError(
      503,
      "ROOM_ENDING_PENDING",
      "The room is closing, but media teardown is unconfirmed. Retry ending the room.",
    );
  }
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE rooms SET id = id WHERE id = ${roomId}`;
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (!room || room.status === "ENDED") return;
    if (room.status !== "ENDING")
      throw new RoomApiError(
        409,
        "ROOM_STATE_CHANGED",
        "The room state changed. Refresh before trying again.",
      );
    await tx.roomMember.updateMany({
      where: { roomId },
      data: {
        handRaised: false,
        seatExpiresAt: null,
        seatOwnerId: null,
        seatReservationId: null,
        mediaIdentity: null,
        mediaTokenExpiresAt: null,
        mediaRevoking: false,
        mediaAbsentSince: null,
      },
    });
    await tx.roomMember.updateMany({
      where: { roomId, status: { in: ["ACTIVE", "APPROVED"] } },
      data: { status: "LEFT" },
    });
    await tx.room.update({
      where: { id: roomId },
      data: { status: "ENDED", endedAt: new Date(), focusedUserId: null },
    });
  });
  return { changed: true, status: "ENDED" as const };
}
