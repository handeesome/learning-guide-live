import { reviewJoinRequest } from "@/lib/room-review";
import {
  roomApiFailure,
  roomApiUser,
  roomJson,
  roomJsonBody,
  limitRoomRequests,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ roomId: string; requestId: string }> },
) {
  try {
    const userId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    limitRoomRequests(`review-action:${userId}`, 30);
    const { roomId, requestId } = await context.params;
    return roomJson(await reviewJoinRequest(roomId, userId, requestId, input));
  } catch (error) {
    return roomApiFailure(error);
  }
}
