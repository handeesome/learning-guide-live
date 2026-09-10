import { getCollaborationSnapshot } from "@/lib/room-collaboration";
import {
  limitRoomRequests,
  roomApiFailure,
  roomApiUser,
  roomJson,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const userId = await roomApiUser(request);
    limitRoomRequests(`collaboration-read:${userId}`, 30);
    const { roomId } = await context.params;
    return roomJson(await getCollaborationSnapshot(roomId, userId));
  } catch (error) {
    return roomApiFailure(error);
  }
}
