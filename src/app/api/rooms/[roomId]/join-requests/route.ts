import { ownJoinStatus, submitJoinRequest } from "@/lib/invitations";
import {
  limitRoomRequests,
  roomApiFailure,
  roomApiUser,
  roomJson,
  roomJsonBody,
} from "@/lib/room-api";

export const runtime = "nodejs";
type Context = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const userId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    limitRoomRequests(`join:${userId}`, 30);
    const { roomId } = await context.params;
    const result = await submitJoinRequest(roomId, userId, input);
    return roomJson({ request: result.request }, result.created ? 201 : 200);
  } catch (error) {
    return roomApiFailure(error);
  }
}

export async function GET(request: Request, context: Context) {
  try {
    const userId = await roomApiUser(request);
    limitRoomRequests(`join-status:${userId}`, 60);
    const { roomId } = await context.params;
    return roomJson(await ownJoinStatus(roomId, userId));
  } catch (error) {
    return roomApiFailure(error);
  }
}
