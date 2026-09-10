import { db } from "./db";
import type { RoomPolicyContext } from "./room-policy";
import type { Prisma } from "../generated/prisma/client";

/** userId must come from a validated server session, never from request data. */
export async function loadRoomAccess(
  roomId: string,
  userId: string | null,
  client: Prisma.TransactionClient = db,
) {
  const result = await client.room.findUnique({
    where: { id: roomId },
    include: {
      host: { select: { name: true } },
      members: {
        // A guest loads no memberships. No caller-provided role enters the query.
        where: { userId: userId ?? { in: [] } },
        select: { roomId: true, userId: true, role: true, status: true },
        take: 1,
      },
    },
  });
  if (!result) return null;
  const { members, ...room } = result;
  const policy: RoomPolicyContext = {
    room,
    userId,
    member: members[0] ?? null,
  };
  return { room, policy };
}
