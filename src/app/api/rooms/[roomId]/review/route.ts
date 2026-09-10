import { getReviewQueue } from "@/lib/room-review";
import {
  roomApiFailure,
  roomApiUser,
  roomJson,
  limitRoomRequests,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const userId = await roomApiUser(request);
    limitRoomRequests(`review-list:${userId}`, 60);
    const { roomId } = await context.params;
    return roomJson(await getReviewQueue(roomId, userId));
  } catch (error) {
    return roomApiFailure(error);
  }
}
