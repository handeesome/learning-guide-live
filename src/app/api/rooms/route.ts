import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { roomInput } from "@/lib/room-input";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    return Response.json(
      { error: "Sign in to create a room." },
      { status: 401 },
    );
  if (
    request.headers.get("origin") !==
    new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin
  ) {
    return Response.json(
      { error: "This request wasn't sent from this application." },
      { status: 403 },
    );
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json(
      { error: "Send room details as JSON." },
      { status: 415 },
    );
  }
  const parsed = roomInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  const room = await db.room.create({
    data: {
      ...parsed.data,
      hostId: session.user.id,
      members: {
        create: { userId: session.user.id, role: "HOST", status: "LEFT" },
      },
    },
    select: { id: true },
  });
  return Response.json(room, { status: 201 });
}
