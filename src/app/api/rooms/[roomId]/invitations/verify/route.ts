import { verifyInvitation } from "@/lib/invitations";
import {
  limitRoomRequests,
  roomApiFailure,
  roomJson,
  roomJsonBody,
} from "@/lib/room-api";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const input = await roomJsonBody(request);
    // Shared, bounded public preview bucket for this local-only application.
    limitRoomRequests("invite-preview", 60);
    const { roomId } = await context.params;
    return roomJson(await verifyInvitation(roomId, input));
  } catch (error) {
    return roomApiFailure(error);
  }
}
