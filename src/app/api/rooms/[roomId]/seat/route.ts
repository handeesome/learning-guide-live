import { getSeatStatus, releaseSeat, reserveSeat } from "@/lib/room-seats";
import {
  limitRoomRequests,
  roomApiFailure,
  roomApiUser,
  roomJson,
  roomJsonBody,
} from "@/lib/room-api";

export const runtime = "nodejs";
type Context = { params: Promise<{ roomId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const userId = await roomApiUser(request);
    limitRoomRequests(`seat-read:${userId}`, 60);
    const { roomId } = await context.params;
    return roomJson(
      await getSeatStatus(roomId, userId, {
        clientId: request.headers.get("x-room-client"),
      }),
    );
  } catch (error) {
    return roomApiFailure(error);
  }
}

async function mutate(request: Request, context: Context, release: boolean) {
  try {
    const userId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    limitRoomRequests(`seat-write:${userId}`, 30);
    const { roomId } = await context.params;
    if (release) return roomJson(await releaseSeat(roomId, userId, input));
    const result = await reserveSeat(roomId, userId, input);
    return roomJson(result, result.created ? 201 : 200);
  } catch (error) {
    return roomApiFailure(error);
  }
}

export const POST = (request: Request, context: Context) =>
  mutate(request, context, false);
export const DELETE = (request: Request, context: Context) =>
  mutate(request, context, true);
