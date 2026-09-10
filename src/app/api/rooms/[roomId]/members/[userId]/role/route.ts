import { setMemberRole } from "@/lib/room-review";
import { liveKitGateway } from "@/lib/livekit";
import { kickRoomMember } from "@/lib/room-collaboration";
import { emptyCommandInput } from "@/lib/collaboration-input";
import {
  roomApiFailure,
  roomApiUser,
  roomJson,
  roomJsonBody,
  limitRoomRequests,
  RoomApiError,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ roomId: string; userId: string }> },
) {
  try {
    const actorId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    limitRoomRequests(`role-action:${actorId}`, 30);
    const { roomId, userId: targetUserId } = await context.params;
    return roomJson(await setMemberRole(roomId, actorId, targetUserId, input));
  } catch (error) {
    return roomApiFailure(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ roomId: string; userId: string }> },
) {
  try {
    const actorId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    if (!emptyCommandInput.safeParse(input).success)
      throw new RoomApiError(
        400,
        "INVALID_INPUT",
        "Remove the selected member without supplying role or room state.",
      );
    limitRoomRequests(`kick-action:${actorId}`, 20);
    const { roomId, userId: targetUserId } = await context.params;
    return roomJson(
      await kickRoomMember(liveKitGateway(), roomId, actorId, targetUserId),
    );
  } catch (error) {
    return roomApiFailure(error);
  }
}
