import { deepSeekProvider } from "@/lib/deepseek";
import { generateRoomSummary, getRoomSummary } from "@/lib/room-summary";
import { generateSummaryInput } from "@/lib/summary-input";
import {
  limitRoomRequests,
  RoomApiError,
  roomApiFailure,
  roomApiUser,
  roomJson,
  roomJsonBody,
} from "@/lib/room-api";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const userId = await roomApiUser(request);
    limitRoomRequests(`read-summary:${userId}`, 30);
    const { roomId } = await context.params;
    return roomJson(await getRoomSummary(roomId, userId));
  } catch (error) {
    return roomApiFailure(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ roomId: string }> },
) {
  try {
    const userId = await roomApiUser(request);
    const input = await roomJsonBody(request);
    if (!generateSummaryInput.safeParse(input).success)
      throw new RoomApiError(
        400,
        "INVALID_INPUT",
        "Generate the summary without supplying client-owned content.",
      );
    limitRoomRequests(`generate-summary:${userId}`, 3);
    const { roomId } = await context.params;
    return roomJson(
      await generateRoomSummary(deepSeekProvider(), roomId, userId),
    );
  } catch (error) {
    return roomApiFailure(error);
  }
}
