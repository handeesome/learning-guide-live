import type { Prisma } from "../generated/prisma/client";
import { RoomApiError } from "./room-api";

export async function openRoomForWrite(
  tx: Prisma.TransactionClient,
  roomId: string,
) {
  // Start SQLite's write transaction before permission reads. No logical field
  // or updatedAt changes; all related business writes stay in this transaction.
  await tx.$executeRaw`UPDATE rooms SET id = id WHERE id = ${roomId}`;
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
      "This room is closing or has ended. Room controls are unavailable.",
    );
  return room;
}
