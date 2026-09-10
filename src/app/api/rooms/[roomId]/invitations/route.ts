import { createInvitation } from "@/lib/invitations";
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
    limitRoomRequests(`invite:${userId}`, 10);
    const { roomId } = await context.params;
    return roomJson(await createInvitation(roomId, userId, input), 201);
  } catch (error) {
    return roomApiFailure(error);
  }
}
