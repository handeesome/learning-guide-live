import type { Prisma } from "../generated/prisma/client";
import { db } from "./db";
import { loadRoomAccess } from "./room-access";
import { RoomApiError } from "./room-api";
import { canPerformRoomAction, roomRole } from "./room-policy";
import { openRoomForWrite } from "./room-transaction";
import { memberRoleInput, reviewInput, type ReviewQueue } from "./review-input";

async function hostAccess(
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
  if (access.room.status !== "OPEN")
    throw new RoomApiError(
      409,
      "ROOM_CLOSED",
      "This room is closing or has ended. Room controls are unavailable.",
    );
  if (!canPerformRoomAction(access.policy, { action: "review_requests" })) {
    throw new RoomApiError(
      403,
      "HOST_REQUIRED",
      "Only the room host can review requests or change roles.",
    );
  }
  return access;
}

export async function getReviewQueue(
  roomId: string,
  userId: string,
): Promise<ReviewQueue> {
  // The authorization read and private lists share one database snapshot.
  return db.$transaction(async (tx) => {
    await hostAccess(tx, roomId, userId);
    const requests = await tx.joinRequest.findMany({
      where: { roomId, status: "PENDING" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 51,
      select: {
        id: true,
        userId: true,
        createdAt: true,
        user: { select: { name: true } },
      },
    });
    const members = await tx.roomMember.findMany({
      where: { roomId, status: { not: "KICKED" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 101,
      select: {
        userId: true,
        role: true,
        status: true,
        user: { select: { name: true } },
      },
    });
    return {
      requests: requests.slice(0, 50).map(({ user, createdAt, ...entry }) => ({
        ...entry,
        name: user.name,
        createdAt: createdAt.toISOString(),
      })),
      members: members
        .slice(0, 100)
        .map(({ user, ...entry }) => ({ ...entry, name: user.name })),
      hasMoreRequests: requests.length > 50,
      hasMoreMembers: members.length > 100,
    };
  });
}

export async function reviewJoinRequest(
  roomId: string,
  userId: string,
  requestId: string,
  input: unknown,
) {
  const parsed = reviewInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Choose Approve or Reject for this request.",
    );
  const desired = parsed.data.decision === "APPROVE" ? "APPROVED" : "REJECTED";
  return db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await hostAccess(tx, roomId, userId);
    const request = await tx.joinRequest.findFirst({
      where: { id: requestId, roomId },
    });
    if (!request)
      throw new RoomApiError(
        404,
        "REQUEST_NOT_FOUND",
        "This request is no longer available. Refresh the list.",
      );
    if (request.userId === access.room.hostId)
      throw new RoomApiError(
        403,
        "HOST_PROTECTED",
        "The host cannot be an entry-request target.",
      );
    const memberWhere = { roomId_userId: { roomId, userId: request.userId } };
    const member = await tx.roomMember.findUnique({ where: memberWhere });
    if (member?.status === "KICKED")
      throw new RoomApiError(
        403,
        "REMOVED_FROM_ROOM",
        "This person was removed from the room. Approval cannot restore access.",
      );
    if (
      member &&
      !roomRole({ room: access.room, userId: request.userId, member })
    ) {
      throw new RoomApiError(
        403,
        "MEMBERSHIP_INVALID",
        "This person's room access couldn't be verified. Refresh the list.",
      );
    }
    // A retry must not recreate a removed membership or reset roles/seat state.
    if (request.status === desired) {
      if (desired === "APPROVED" && !member)
        throw new RoomApiError(
          409,
          "MEMBERSHIP_INVALID",
          "The approved membership is missing. Refresh the room before continuing.",
        );
      return {
        request: { id: request.id, status: request.status },
        changed: false,
      };
    }
    if (request.status !== "PENDING")
      throw new RoomApiError(
        409,
        "REQUEST_ALREADY_REVIEWED",
        "This request was already reviewed. Refresh the list to see the decision.",
      );
    if (member?.status === "ACTIVE" || member?.status === "APPROVED") {
      throw new RoomApiError(
        409,
        "ALREADY_MEMBER",
        "This person already has membership. Refresh the list.",
      );
    }
    if (desired === "APPROVED") {
      await tx.roomMember.upsert({
        where: memberWhere,
        create: {
          roomId,
          userId: request.userId,
          role: "PARTICIPANT",
          status: "APPROVED",
        },
        // A returning LEFT member retains the role previously assigned by host.
        update: { status: "APPROVED", handRaised: false, seatExpiresAt: null },
      });
    }
    const updated = await tx.joinRequest.update({
      where: { id: request.id },
      data: { status: desired },
      select: { id: true, status: true },
    });
    // Approval creates eligibility only; it issues no seat or media token.
    return { request: updated, changed: true };
  });
}

export async function setMemberRole(
  roomId: string,
  userId: string,
  targetUserId: string,
  input: unknown,
) {
  const parsed = memberRoleInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Choose Moderator or Participant. Host ownership cannot be changed here.",
    );
  return db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const access = await hostAccess(tx, roomId, userId);
    const where = { roomId_userId: { roomId, userId: targetUserId } };
    const member = await tx.roomMember.findUnique({ where });
    if (!member)
      throw new RoomApiError(
        404,
        "MEMBER_NOT_FOUND",
        "This person is not a member of this room. Refresh the list.",
      );
    if (
      !canPerformRoomAction(access.policy, {
        action: "set_moderator",
        target: member,
      })
    ) {
      throw new RoomApiError(
        403,
        "ROLE_CHANGE_FORBIDDEN",
        "This member's role cannot be changed. The host and removed members are protected.",
      );
    }
    if (member.role === parsed.data.role)
      return {
        member: {
          userId: member.userId,
          role: member.role,
          status: member.status,
        },
        changed: false,
      };
    const updated = await tx.roomMember.update({
      where,
      data: { role: parsed.data.role },
      select: { userId: true, role: true, status: true },
    });
    return { member: updated, changed: true };
  });
}
