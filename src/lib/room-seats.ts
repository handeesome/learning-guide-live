import { randomUUID } from "node:crypto";
import type { Prisma, RoomMember } from "../generated/prisma/client";
import { db } from "./db";
import { RoomApiError } from "./room-api";
import { roomRole } from "./room-policy";
import { openRoomForWrite } from "./room-transaction";
import {
  releaseSeatInput,
  reserveSeatInput,
  seatStatusInput,
  type SeatStatus,
} from "./seat-input";

export const ROOM_CAPACITY = 8;
export const RESERVATION_MS = 60_000;

async function seatAccess(
  tx: Prisma.TransactionClient,
  roomId: string,
  userId: string,
) {
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
      "This room is closing or has ended. Seats are unavailable.",
    );
  const member = await tx.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
  if (!member || !roomRole({ room, userId, member })) {
    throw new RoomApiError(
      403,
      "MEMBERSHIP_REQUIRED",
      "You need the host's approval before reserving a seat.",
    );
  }
  return member;
}

function hasReservation(member: RoomMember, now: Date) {
  return (
    (member.mediaIdentity !== null || member.status !== "ACTIVE") &&
    member.seatExpiresAt !== null &&
    (member.mediaIdentity !== null || member.seatExpiresAt > now)
  );
}

async function snapshot(
  tx: Prisma.TransactionClient,
  member: RoomMember,
  clientId: string,
  now: Date,
): Promise<SeatStatus> {
  const occupied = await tx.roomMember.count({
    where: {
      roomId: member.roomId,
      OR: [
        // An issued (or revoking) grant holds capacity even when kicked/expired.
        { mediaIdentity: { not: null } },
        // Never free an ACTIVE media participant just because a timer elapsed.
        // Media departure must be confirmed before this durable hold is released.
        { status: "ACTIVE" },
        { status: { in: ["APPROVED", "LEFT"] }, seatExpiresAt: { gt: now } },
      ],
    },
  });
  const reservation =
    hasReservation(member, now) &&
    member.seatReservationId &&
    member.seatExpiresAt
      ? {
          id: member.seatReservationId,
          expiresAt: member.seatExpiresAt.toISOString(),
          ownedByThisPage: member.seatOwnerId === clientId,
        }
      : null;
  return {
    capacity: ROOM_CAPACITY,
    occupied,
    available: Math.max(0, ROOM_CAPACITY - occupied),
    active: member.status === "ACTIVE",
    mediaHeld: member.mediaIdentity !== null,
    serverTime: now.toISOString(),
    reservation,
  };
}

export async function getSeatStatus(
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = seatStatusInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Reload this page to check seats.",
    );
  return db.$transaction(async (tx) => {
    const member = await seatAccess(tx, roomId, userId);
    return snapshot(tx, member, parsed.data.clientId, new Date());
  });
}

export async function reserveSeat(
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = reserveSeatInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Refresh seat status before reserving a seat.",
    );
  const { clientId, previousReservationId } = parsed.data;
  return db.$transaction(async (tx) => {
    // All claimers, including other server processes, serialize before counting.
    await openRoomForWrite(tx, roomId);
    const member = await seatAccess(tx, roomId, userId);
    const now = new Date();
    if (member.status === "ACTIVE" || member.mediaIdentity !== null) {
      throw new RoomApiError(
        409,
        "MEDIA_SESSION_ACTIVE",
        "Your account already has an active media session. This reservation control cannot transfer it.",
      );
    }
    const current = hasReservation(member, now);
    if (current && (!member.seatOwnerId || !member.seatReservationId)) {
      throw new RoomApiError(
        409,
        "SEAT_UNAVAILABLE",
        "An earlier reservation is still held. Wait for it to expire and refresh.",
      );
    }
    if (current && member.seatOwnerId === clientId) {
      // Retrying a lost response neither adds a seat nor extends its lifetime.
      return { ...(await snapshot(tx, member, clientId, now)), created: false };
    }
    if (previousReservationId !== (current ? member.seatReservationId : null)) {
      throw new RoomApiError(
        409,
        "SEAT_CHANGED",
        "Your reservation changed or expired. Refresh before reserving again.",
      );
    }
    const state = await snapshot(tx, member, clientId, now);
    if (!current && state.occupied >= ROOM_CAPACITY) {
      throw new RoomApiError(
        409,
        "ROOM_FULL",
        "All 8 seats are held, including the host's when present. Wait for a seat to open and try again.",
      );
    }
    const updated = await tx.roomMember.update({
      where: { id: member.id },
      data: {
        seatOwnerId: clientId,
        seatReservationId: randomUUID(),
        // A takeover replaces one reservation; it does not extend or add a seat.
        seatExpiresAt: current
          ? member.seatExpiresAt
          : new Date(now.getTime() + RESERVATION_MS),
      },
    });
    return {
      ...(await snapshot(tx, updated, clientId, now)),
      created: !current,
    };
  });
}

export async function releaseSeat(
  roomId: string,
  userId: string,
  input: unknown,
) {
  const parsed = releaseSeatInput.safeParse(input);
  if (!parsed.success)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Refresh seat status before cancelling a reservation.",
    );
  return db.$transaction(async (tx) => {
    await openRoomForWrite(tx, roomId);
    const member = await seatAccess(tx, roomId, userId);
    if (member.status === "ACTIVE" || member.mediaIdentity !== null) {
      throw new RoomApiError(
        409,
        "MEDIA_SESSION_ACTIVE",
        "This control cannot release an active media session. Use the meeting's leave control.",
      );
    }
    const now = new Date();
    if (member.seatReservationId !== parsed.data.reservationId) {
      // A delayed cancellation must not release a newer reservation (ABA race).
      return {
        ...(await snapshot(tx, member, parsed.data.clientId, now)),
        released: false,
      };
    }
    if (member.seatOwnerId !== parsed.data.clientId) {
      throw new RoomApiError(
        403,
        "SEAT_OWNER_REQUIRED",
        "This reservation belongs to another page. Refresh to see its status.",
      );
    }
    const updated = await tx.roomMember.update({
      where: { id: member.id },
      data: { seatOwnerId: null, seatReservationId: null, seatExpiresAt: null },
    });
    return {
      ...(await snapshot(tx, updated, parsed.data.clientId, now)),
      released: true,
    };
  });
}
