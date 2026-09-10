import { liveKitGateway } from "@/lib/livekit";
import { sendChatMessage } from "@/lib/room-collaboration";
import {
  limitRoomRequests,
  roomApiFailure,
  roomApiUser,
  roomJson,
  roomJsonBody,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const userId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    limitRoomRequests(`chat:${userId}`, 20);
    const { roomId } = await context.params;
    const result = await sendChatMessage(
      liveKitGateway(),
      roomId,
      userId,
      input,
    );
    return roomJson(result, result.broadcast ? 201 : 202);
  } catch (error) {
    return roomApiFailure(error);
  }
}
