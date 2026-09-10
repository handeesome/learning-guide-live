import { randomUUID } from "node:crypto";
import type { Prisma, RoomMember } from "../generated/prisma/client";
import { db } from "./db";
import { RoomApiError } from "./room-api";
import { roomRole } from "./room-policy";
import { openRoomForWrite } from "./room-transaction";
import { mediaRoomName, type MediaGateway } from "./livekit";
import {
  mediaGrantInput,
  mediaReleaseInput,
  type MediaActor,
  type MediaGrant,
} from "./media-input";

const TOKEN_WINDOW_MS = 60_000;
const RECONNECT_GRACE_MS = 30_000;

async function access(
  tx: Prisma.TransactionClient,
  actor: MediaActor,
  roomId: string,
) {
  const session = await tx.session.findFirst({
    where: {
      id: actor.sessionId,
      userId: actor.userId,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (!session)
    throw new RoomApiError(401, "SIGN_IN_REQUIRED", "Sign in to continue.");
  const room = await tx.room.findUnique({ where: { id: roomId } });
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
      "This room is closing or has ended. New connections are unavailable.",
    );
  const member = await tx.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId: actor.userId } },
    include: { user: { select: { name: true } } },
  });
  if (!member || !roomRole({ room, member, userId: actor.userId }))
    throw new RoomApiError(
      403,
      "MEMBERSHIP_REQUIRED",
      "You need current host-approved membership to connect.",
    );
  return member;
}

function generation(member: RoomMember, reservationId: string) {
  if (member.seatReservationId !== reservationId)
    throw new RoomApiError(
      409,
      "SEAT_CHANGED",
      "Another page changed this seat. Refresh before continuing.",
    );
}

const newMediaHold = () => ({
  mediaIdentity: `p-${randomUUID()}`,
  mediaTokenExpiresAt: new Date(Date.now() + TOKEN_WINDOW_MS),
  mediaAbsentSince: new Date(),
  mediaRevoking: false,
});
const clearedMedia = {
  mediaIdentity: null,
  mediaTokenExpiresAt: null,
  mediaAbsentSince: null,
  mediaRevoking: false,
  seatExpiresAt: null,
  seatOwnerId: null,
  seatReservationId: null,
  handRaised: false,
};

/** Network calls never hold a SQL write lock. Identity/generation fences each
 * continuation, including a response arriving after another page's takeover. */
export function createRoomMedia(gateway: MediaGateway) {
  async function clearRevoked(member: RoomMember) {
    await db.$transaction(async (tx) => {
      // Cleanup can finish after room ending, kicking or logout: it removes
      // this already-authorized generation only and never restores access.
      await tx.$executeRaw`UPDATE rooms SET id = id WHERE id = ${member.roomId}`;
      const current = await tx.roomMember.findUnique({
        where: { id: member.id },
      });
      if (
        !current ||
        current.mediaIdentity !== member.mediaIdentity ||
        !current.mediaRevoking
      )
        return;
      await tx.roomMember.update({
        where: { id: current.id },
        data: {
          ...clearedMedia,
          status: current.status === "ACTIVE" ? "LEFT" : current.status,
        },
      });
      await tx.room.updateMany({
        where: { id: member.roomId, focusedUserId: member.userId },
        data: { focusedUserId: null },
      });
    });
  }

  async function issue(
    actor: MediaActor,
    roomId: string,
    input: unknown,
  ): Promise<MediaGrant> {
    const parsed = mediaGrantInput.safeParse(input);
    if (!parsed.success)
      throw new RoomApiError(
        400,
        "INVALID_INPUT",
        "Use the current page's reservation to request connection access.",
      );
    const { clientId, reservationId, takeover } = parsed.data;
    const roomName = mediaRoomName(roomId);
    const prepared = await db.$transaction(async (tx) => {
      await openRoomForWrite(tx, roomId);
      const member = await access(tx, actor, roomId);
      generation(member, reservationId);
      const replacing = member.seatOwnerId !== clientId;
      if (replacing && !takeover)
        throw new RoomApiError(
          409,
          "TAKEOVER_REQUIRED",
          "Another page owns this seat. Choose to take over before connecting.",
        );
      if (replacing && member.mediaIdentity) {
        return {
          member: await tx.roomMember.update({
            where: { id: member.id },
            data: { mediaRevoking: true },
          }),
          replacing: true,
        };
      }
      if (member.mediaRevoking)
        throw new RoomApiError(
          409,
          "MEDIA_REMOVAL_PENDING",
          "The previous connection is being released. Retry release before connecting.",
        );
      if (member.status === "ACTIVE" && !member.mediaIdentity)
        throw new RoomApiError(
          409,
          "MEDIA_STATE_UNAVAILABLE",
          "The active connection cannot be verified. Contact the app operator.",
        );
      if (
        !member.mediaIdentity &&
        (!member.seatExpiresAt || member.seatExpiresAt <= new Date())
      )
        throw new RoomApiError(
          409,
          "SEAT_EXPIRED",
          "Your reservation expired. Reserve a seat again.",
        );
      if (replacing)
        throw new RoomApiError(
          409,
          "TAKEOVER_REQUIRED",
          "Take over this reservation before requesting connection access.",
        );
      const held = member.mediaIdentity
        ? member
        : await tx.roomMember.update({
            where: { id: member.id },
            data: newMediaHold(),
          });
      return { member: held, replacing: false };
    });
    let held = prepared.member;
    if (prepared.replacing) {
      await gateway.revoke(roomName, held.mediaIdentity!);
      held = await db.$transaction(async (tx) => {
        await openRoomForWrite(tx, roomId);
        const current = await access(tx, actor, roomId);
        generation(current, reservationId);
        if (
          current.mediaIdentity !== held.mediaIdentity ||
          !current.mediaRevoking
        )
          throw new RoomApiError(
            409,
            "SEAT_CHANGED",
            "Connection ownership changed. Refresh and try again.",
          );
        // Keep the same counted row until the new identity replaces the revoked
        // identity. There is no capacity-release gap for a ninth claimant.
        const hold = newMediaHold();
        await tx.room.updateMany({
          where: { id: roomId, focusedUserId: actor.userId },
          data: { focusedUserId: null },
        });
        return tx.roomMember.update({
          where: { id: current.id },
          data: {
            ...hold,
            seatOwnerId: clientId,
            seatReservationId: randomUUID(),
            seatExpiresAt: hold.mediaTokenExpiresAt,
            status: current.status === "ACTIVE" ? "LEFT" : current.status,
            handRaised: false,
          },
        });
      });
    }
    await gateway.prepareRoom(roomName);
    return db.$transaction(async (tx) => {
      await openRoomForWrite(tx, roomId);
      const current = await access(tx, actor, roomId); // Recheck logout/closure during Cloud I/O.
      generation(current, held.seatReservationId!);
      if (
        current.mediaIdentity !== held.mediaIdentity ||
        current.seatOwnerId !== clientId ||
        current.mediaRevoking
      )
        throw new RoomApiError(
          409,
          "SEAT_CHANGED",
          "Connection ownership changed. Refresh before connecting.",
        );
      if (
        !current.mediaTokenExpiresAt ||
        current.mediaTokenExpiresAt.getTime() - Date.now() < 1000
      )
        throw new RoomApiError(
          409,
          "TOKEN_WINDOW_EXPIRED",
          "The connection window expired. Release this seat and reserve again.",
        );
      const token = await gateway.sign({
        roomName,
        identity: current.mediaIdentity!,
        name: current.user.name,
        expiresAt: current.mediaTokenExpiresAt,
      });
      return {
        token,
        serverUrl: gateway.url,
        identity: current.mediaIdentity!,
        roomName,
        reservationId: current.seatReservationId!,
        expiresAt: current.mediaTokenExpiresAt.toISOString(),
      };
    });
  }

  async function release(actor: MediaActor, roomId: string, input: unknown) {
    const parsed = mediaReleaseInput.safeParse(input);
    if (!parsed.success)
      throw new RoomApiError(
        400,
        "INVALID_INPUT",
        "Use your current reservation to release connection access.",
      );
    const member = await db.$transaction(async (tx) => {
      await openRoomForWrite(tx, roomId);
      const current = await access(tx, actor, roomId);
      if (current.seatReservationId !== parsed.data.reservationId) return null;
      if (current.seatOwnerId !== parsed.data.clientId)
        throw new RoomApiError(
          403,
          "SEAT_OWNER_REQUIRED",
          "This page no longer owns the connection.",
        );
      if (!current.mediaIdentity)
        throw new RoomApiError(
          409,
          "NO_MEDIA_GRANT",
          "No connection access was issued. Cancel the reservation instead.",
        );
      return tx.roomMember.update({
        where: { id: current.id },
        data: { mediaRevoking: true },
      });
    });
    if (!member) return { released: false };
    await gateway.revoke(mediaRoomName(roomId), member.mediaIdentity!);
    await clearRevoked(member);
    return { released: true };
  }

  async function sync(actor: MediaActor, roomId: string) {
    await db.$transaction((tx) => access(tx, actor, roomId));
    const held = await db.roomMember.findMany({
      where: { roomId, mediaIdentity: { not: null } },
    });
    if (!held.length) return { checked: 0 };
    const roomName = mediaRoomName(roomId);
    const present = new Set(await gateway.participants(roomName));
    for (const observed of held) {
      const revoke = await db.$transaction(async (tx) => {
        await openRoomForWrite(tx, roomId);
        await access(tx, actor, roomId);
        const member = await tx.roomMember.findUnique({
          where: { id: observed.id },
        });
        if (!member || member.mediaIdentity !== observed.mediaIdentity)
          return null;
        const room = await tx.room.findUniqueOrThrow({ where: { id: roomId } });
        if (
          member.mediaRevoking ||
          !roomRole({ room, member, userId: member.userId })
        ) {
          return tx.roomMember.update({
            where: { id: member.id },
            data: { mediaRevoking: true },
          });
        }
        if (present.has(member.mediaIdentity!)) {
          await tx.roomMember.update({
            where: { id: member.id },
            data: { status: "ACTIVE", mediaAbsentSince: null },
          });
          return null;
        }
        const now = new Date();
        const absentSince = member.mediaAbsentSince ?? now;
        if (
          now.getTime() >=
          Math.max(
            member.mediaTokenExpiresAt?.getTime() ?? Infinity,
            absentSince.getTime() + RECONNECT_GRACE_MS,
          )
        ) {
          return tx.roomMember.update({
            where: { id: member.id },
            data: { mediaRevoking: true },
          });
        }
        if (!member.mediaAbsentSince)
          await tx.roomMember.update({
            where: { id: member.id },
            data: { mediaAbsentSince: absentSince },
          });
        return null;
      });
      if (revoke) {
        await gateway.revoke(roomName, revoke.mediaIdentity!);
        await clearRevoked(revoke);
      }
    }
    return { checked: held.length };
  }
  return { issue, release, sync };
}
