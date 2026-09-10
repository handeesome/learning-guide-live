import { liveKitGateway } from "@/lib/livekit";
import { createRoomMedia } from "@/lib/room-media";
import { mediaSyncInput } from "@/lib/media-input";
import {
  roomApiActor,
  roomApiFailure,
  roomJson,
  roomJsonBody,
  limitRoomRequests,
  RoomApiError,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const actor = await roomApiActor(request);
    const body = await roomJsonBody(request);
    if (!mediaSyncInput.safeParse(body).success)
      throw new RoomApiError(
        400,
        "INVALID_INPUT",
        "Refresh connection state without supplying participant or role data.",
      );
    limitRoomRequests(`media-sync:${actor.userId}`, 12);
    const { roomId } = await context.params;
    return roomJson(
      await createRoomMedia(liveKitGateway()).sync(actor, roomId),
    );
  } catch (error) {
    return roomApiFailure(error);
  }
}
