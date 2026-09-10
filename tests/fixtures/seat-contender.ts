// A separate OS process and Prisma connection; only the isolated test DB is used.
import { reserveSeat } from "../../src/lib/room-seats";
import { RoomApiError } from "../../src/lib/room-api";
import { db } from "../../src/lib/db";

process.once(
  "message",
  async (message: {
    roomId: string;
    userId: string;
    clientId: string;
    previousReservationId: string | null;
  }) => {
    try {
      const result = await reserveSeat(message.roomId, message.userId, {
        clientId: message.clientId,
        previousReservationId: message.previousReservationId,
      });
      process.send?.({ status: result.created ? 201 : 200, result });
    } catch (error) {
      process.send?.({
        status: error instanceof RoomApiError ? error.status : 503,
        code:
          error instanceof RoomApiError
            ? error.code
            : "UNEXPECTED_DATABASE_FAILURE",
      });
    } finally {
      await db.$disconnect();
      process.disconnect();
    }
  },
);
process.send?.({ ready: true });
