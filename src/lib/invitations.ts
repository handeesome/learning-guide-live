import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { loadRoomAccess } from "./room-access";
import { canPerformRoomAction, roomRole } from "./room-policy";
import { RoomApiError } from "./room-api";
import { invitationInput, joinInput } from "./invitation-input";
import type { Prisma } from "../generated/prisma/client";
import type { EntryState } from "./content";
import { openRoomForWrite } from "./room-transaction";

export function hashInvitation(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

async function validInvitation(
  tx: Prisma.TransactionClient,
  roomId: string,
  code: string,
) {
  const invitation = await tx.invitation.findUnique({
    where: { codeHash: hashInvitation(code) },
  });
  if (!invitation || invitation.roomId !== roomId) {
    throw new RoomApiError(
      404,
      "INVITATION_INVALID",
      "This invitation isn't valid for this room. Ask the host for a new link.",
    );
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw new RoomApiError(
      410,
      "INVITATION_EXPIRED",
      "This invitation has expired. Ask the host for a new link.",
    );
  }
  return invitation;
}

export async function createInvitation(
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = invitationInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Choose an invitation duration of 15 minutes, 1 hour, or 24 hours.",
    );
  return db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await loadRoomAccess(roomId, userId, tx);
    if (
      !access ||
      !canPerformRoomAction(access.policy, { action: "create_invitation" })
    ) {
      throw new RoomApiError(
        403,
        "HOST_REQUIRED",
        "Only the room host can create invitations.",
      );
    }
    const code = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + parsed.data.expiresInMinutes * 60_000,
    );
    await tx.invitation.create({
      data: { roomId, codeHash: hashInvitation(code), expiresAt },
    });
    return { code, expiresAt: expiresAt.toISOString() };
  });
}

export async function verifyInvitation(roomId: string, input: unknown) {
  const parsed = joinInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVITATION_INVALID",
      "Check the full invitation link or code and try again.",
    );
  const room = await db.room.findUnique({ where: { id: roomId } });
  if (!room)
    throw new RoomApiError(
      404,
      "ROOM_NOT_FOUND",
      "This room is unavailable. Check the link.",
    );
  if (room.status !== "OPEN")
    throw new RoomApiError(
      409,
      "ROOM_CLOSED",
      "This room is closing or has ended. New requests are closed.",
    );
  const invitation = await validInvitation(db, roomId, parsed.data.code);
  // Preview does not persist approval or grant access; POST must recheck later.
  return { expiresAt: invitation.expiresAt.toISOString() };
}

const requestSelection = { id: true, status: true, createdAt: true } as const;

export async function submitJoinRequest(
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = joinInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Use a valid invitation code to request entry.",
    );
  return db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await loadRoomAccess(roomId, userId, tx);
    if (!access)
      throw new RoomApiError(
        404,
        "ROOM_NOT_FOUND",
        "This room is unavailable.",
      );
    const { member } = access.policy;
    if (member?.status === "KICKED")
      throw new RoomApiError(
        403,
        "REMOVED_FROM_ROOM",
        "You were removed from this room and cannot request entry.",
      );
    if (member && !roomRole(access.policy))
      throw new RoomApiError(
        403,
        "MEMBERSHIP_INVALID",
        "Your room access couldn't be verified. Contact the host.",
      );
    if (
      roomRole(access.policy) === "HOST" ||
      member?.status === "ACTIVE" ||
      member?.status === "APPROVED"
    ) {
      throw new RoomApiError(
        409,
        "ALREADY_MEMBER",
        "You already have membership in this room.",
      );
    }
    await validInvitation(tx, roomId, parsed.data.code);
    const where = { roomId_userId: { roomId, userId } };
    const existing = await tx.joinRequest.findUnique({
      where,
      select: requestSelection,
    });
    if (existing?.status === "REJECTED")
      throw new RoomApiError(
        409,
        "REQUEST_REJECTED",
        "The host declined your request. Contact the host before trying again.",
      );
    if (existing?.status === "APPROVED")
      throw new RoomApiError(
        409,
        "ALREADY_APPROVED",
        "Your request is already approved. No new request is needed.",
      );
    if (existing) return { request: existing, created: false };
    const request = await tx.joinRequest.create({
      data: { roomId, userId, status: "PENDING" },
      select: requestSelection,
    });
    // No roomMember, role, seat lease or media token is created here.
    return { request, created: true };
  });
}

export async function ownJoinStatus(roomId: string, userId: string) {
  const access = await loadRoomAccess(roomId, userId);
  if (!access)
    throw new RoomApiError(
      404,
      "ROOM_NOT_FOUND",
      "This room is unavailable. Check the link.",
    );
  const request = await db.joinRequest.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: requestSelection,
  });
  const role = roomRole(access.policy);
  const member = access.policy.member;
  const state: EntryState =
    access.room.status !== "OPEN"
      ? "CLOSED"
      : member?.status === "KICKED"
        ? "KICKED"
        : member && !role
          ? "UNAVAILABLE"
          : role === "HOST"
            ? "HOST"
            : member?.status === "ACTIVE" || member?.status === "APPROVED"
              ? "MEMBER"
              : (request?.status ?? "NONE");
  return { state, request };
}
