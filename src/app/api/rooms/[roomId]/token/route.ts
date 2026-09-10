import { liveKitGateway } from "@/lib/livekit";
import { createRoomMedia } from "@/lib/room-media";
import {
  roomApiActor,
  roomApiFailure,
  roomJson,
  roomJsonBody,
  limitRoomRequests,
} from "@/lib/room-api";

export const runtime = "nodejs";
type Context = { params: Promise<{ roomId: string }> };
async function handle(request: Request, context: Context, release: boolean) {
  try {
    const actor = await roomApiActor(request);
    const body = await roomJsonBody(request);
    limitRoomRequests(`media-command:${actor.userId}`, 20);
    const { roomId } = await context.params;
    const media = createRoomMedia(liveKitGateway());
    return roomJson(
      release
        ? await media.release(actor, roomId, body)
        : await media.issue(actor, roomId, body),
    );
  } catch (error) {
    return roomApiFailure(error);
  }
}
export const POST = (request: Request, context: Context) =>
  handle(request, context, false);
export const DELETE = (request: Request, context: Context) =>
  handle(request, context, true);
