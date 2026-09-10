import { emptyCommandInput } from "@/lib/collaboration-input";
import { liveKitGateway } from "@/lib/livekit";
import { endRoom } from "@/lib/room-collaboration";
import {
  limitRoomRequests,
  RoomApiError,
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
    if (!emptyCommandInput.safeParse(input).success)
      throw new RoomApiError(
        400,
        "INVALID_INPUT",
        "End the room without supplying client-owned room state.",
      );
    limitRoomRequests(`end-room:${userId}`, 10);
    const { roomId } = await context.params;
    return roomJson(await endRoom(liveKitGateway(), roomId, userId));
  } catch (error) {
    return roomApiFailure(error);
  }
}
