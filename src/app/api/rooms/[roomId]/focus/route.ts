import { liveKitGateway } from "@/lib/livekit";
import { setRoomFocus } from "@/lib/room-collaboration";
import {
  limitRoomRequests,
  roomApiFailure,
  roomApiUser,
  roomJson,
  roomJsonBody,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const userId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    limitRoomRequests(`focus:${userId}`, 30);
    const { roomId } = await context.params;
    return roomJson(
      await setRoomFocus(liveKitGateway(), roomId, userId, input),
    );
  } catch (error) {
    return roomApiFailure(error);
  }
}
