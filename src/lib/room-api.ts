import { auth } from "./auth";

export class RoomApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function roomJson(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export function roomApiFailure(error: unknown) {
  if (error instanceof RoomApiError) {
    return roomJson({ code: error.code, error: error.message }, error.status);
  }
  // Never log request bodies, invite codes, sessions, or raw database errors.
  return roomJson(
    {
      code: "TEMPORARILY_UNAVAILABLE",
      error: "Couldn't complete the request. Please try again.",
    },
    503,
  );
}

export async function roomApiUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    throw new RoomApiError(401, "SIGN_IN_REQUIRED", "Sign in to continue.");
  return session.user.id;
}

export async function roomApiActor(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    throw new RoomApiError(401, "SIGN_IN_REQUIRED", "Sign in to continue.");
  // The session ID (not its cookie/token) lets multi-step commands recheck SQL.
  return { userId: session.user.id, sessionId: session.session.id };
}

export async function roomJsonBody(request: Request): Promise<unknown> {
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
    .origin;
  if (request.headers.get("origin") !== origin) {
    throw new RoomApiError(
      403,
      "ORIGIN_REJECTED",
      "Open this application and try again.",
    );
  }
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    throw new RoomApiError(415, "JSON_REQUIRED", "Send the request as JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader)
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Check the request details and try again.",
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new RoomApiError(
          413,
          "REQUEST_TOO_LARGE",
          "The request is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RoomApiError(
      400,
      "INVALID_INPUT",
      "Check the request details and try again.",
    );
  }
}

// Single-process local protection, not a distributed/public deployment limiter.
const runtime = globalThis as unknown as {
  roomRequestBuckets?: Map<string, { count: number; until: number }>;
};
const buckets = (runtime.roomRequestBuckets ??= new Map());
export function limitRoomRequests(key: string, max: number, now = Date.now()) {
  for (const [entry, bucket] of buckets) {
    if (bucket.until <= now) buckets.delete(entry);
  }
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= 1000)
      throw new RoomApiError(
        429,
        "RATE_LIMITED",
        "Too many requests. Wait a minute and try again.",
      );
    bucket = { count: 0, until: now + 60_000 };
    buckets.set(key, bucket);
  }
  if (bucket.count >= max)
    throw new RoomApiError(
      429,
      "RATE_LIMITED",
      "Too many requests. Wait a minute and try again.",
    );
  bucket.count += 1;
}
