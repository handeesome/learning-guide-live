import { liveKitGateway } from "@/lib/livekit";
import { setHandRaised } from "@/lib/room-collaboration";
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
    limitRoomRequests(`hand:${userId}`, 30);
    const { roomId } = await context.params;
    return roomJson(
      await setHandRaised(liveKitGateway(), roomId, userId, input),
    );
  } catch (error) {
    return roomApiFailure(error);
  }
}
