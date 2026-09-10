import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = resolve(".tmp", `review-${randomBytes(8).toString("hex")}`);
mkdirSync(directory, { recursive: true });
const databasePath = join(directory, "test.db");
process.env.DATABASE_URL = `file:${databasePath.replaceAll("\\", "/")}`;
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const sql = new DatabaseSync(databasePath);
sql.exec("PRAGMA foreign_keys = ON");
for (const entry of readdirSync(resolve("prisma/migrations"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))) {
  sql.exec(
    readFileSync(
      resolve("prisma/migrations", entry.name, "migration.sql"),
      "utf8",
    ),
  );
}
sql.close();

const { auth } = await import("../src/lib/auth");
const { db } = await import("../src/lib/db");
const { seedDemo, demoPassword } = await import("../prisma/seed");
const { createInvitation, submitJoinRequest, ownJoinStatus } =
  await import("../src/lib/invitations");
const { loadRoomAccess } = await import("../src/lib/room-access");
const { canReadRoomHistory } = await import("../src/lib/room-policy");
const { GET: queue } =
  await import("../src/app/api/rooms/[roomId]/review/route");
const { POST: review } =
  await import("../src/app/api/rooms/[roomId]/join-requests/[requestId]/review/route");
const { PATCH: role } =
  await import("../src/app/api/rooms/[roomId]/members/[userId]/role/route");
const cookies: Record<string, string> = {};
const roomId = "demo-philosophy";
let firstRequestId: string;

type Handler = (
  request: Request,
  context: {
    params: Promise<{ roomId: string; requestId: string; userId: string }>;
  },
) => Promise<Response>;
function call(
  handler: Handler,
  actor: string | null,
  body?: object,
  options: {
    roomId?: string;
    requestId?: string;
    target?: string;
    origin?: string;
  } = {},
) {
  const selectedRoom = options.roomId ?? roomId;
  const method =
    handler === queue ? "GET" : handler === role ? "PATCH" : "POST";
  return handler(
    new Request(`http://localhost:3000/api/rooms/${selectedRoom}/test`, {
      method,
      headers: {
        Origin: options.origin ?? "http://localhost:3000",
        "Content-Type": "application/json",
        ...(actor ? { Cookie: cookies[actor] } : {}),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }),
    {
      params: Promise.resolve({
        roomId: selectedRoom,
        requestId: options.requestId ?? firstRequestId,
        userId: options.target ?? "demo-morgan",
      }),
    },
  );
}

async function candidate(tag: string, selectedRoom = roomId) {
  const userId = `candidate-${tag}`;
  await db.user.create({
    data: { id: userId, name: `Candidate ${tag}`, email: `${tag}@guide.test` },
  });
  const request = await db.joinRequest.create({
    data: { id: `request-${tag}`, roomId: selectedRoom, userId },
  });
  return { userId, requestId: request.id };
}

before(async () => {
  await seedDemo();
  for (const name of ["alex", "morgan", "taylor"]) {
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          email: `${name}@guide.test`,
          password: demoPassword,
        }),
      }),
    );
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    cookies[name] = cookie.split(";")[0];
  }
  const invitation = await createInvitation(roomId, "demo-alex", {
    expiresInMinutes: 60,
  });
  firstRequestId = (
    await submitJoinRequest(roomId, "demo-morgan", { code: invitation.code })
  ).request.id;
  // Expiry after a valid submission must not erase the independent application.
  await db.invitation.updateMany({
    where: { roomId },
    data: { expiresAt: new Date(0) },
  });
});
after(async () => {
  await db.$disconnect();
  assert.equal(directory.startsWith(resolve(".tmp") + sep), true);
  rmSync(directory, { recursive: true, force: true });
});

test("only the current room host can read the private review queue", async () => {
  assert.equal((await call(queue, null)).status, 401);
  assert.equal((await call(queue, "morgan")).status, 403);
  assert.equal((await call(queue, "taylor")).status, 403);
  const response = await call(queue, "alex");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const data = await response.json();
  assert.equal(data.requests[0].id, firstRequestId);
  assert.equal(data.requests[0].name, "Morgan Lee");
  assert.equal(data.hasMoreRequests, false);
  assert.equal(JSON.stringify(data).includes("morgan@guide.test"), false);
  assert.equal(JSON.stringify(data).includes("codeHash"), false);
});

test("approval atomically creates participant membership and preserves an independent application", async () => {
  const response = await call(review, "alex", { decision: "APPROVE" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).changed, true);
  const request = await db.joinRequest.findUniqueOrThrow({
    where: { id: firstRequestId },
  });
  const member = await db.roomMember.findUniqueOrThrow({
    where: { roomId_userId: { roomId, userId: "demo-morgan" } },
  });
  assert.equal(request.status, "APPROVED");
  assert.equal(member.role, "PARTICIPANT");
  assert.equal(member.status, "APPROVED");
  assert.equal(member.seatExpiresAt, null);
  assert.equal((await ownJoinStatus(roomId, "demo-morgan")).state, "MEMBER");
  const access = await loadRoomAccess(roomId, "demo-morgan");
  assert.ok(access);
  assert.equal(canReadRoomHistory(access.policy), true);
  assert.equal((await (await call(queue, "alex")).json()).requests.length, 0);
});

test("role updates are host-only, idempotent and preserve status and seat state", async () => {
  assert.equal((await call(role, "alex", { role: "MODERATOR" })).status, 200);
  assert.equal(
    (await (await call(role, "alex", { role: "MODERATOR" })).json()).changed,
    false,
  );
  assert.equal((await call(queue, "morgan")).status, 403);
  assert.equal(
    (await call(review, "morgan", { decision: "REJECT" })).status,
    403,
  );
  assert.equal(
    (await call(role, "morgan", { role: "PARTICIPANT" })).status,
    403,
  );
  const where = { roomId_userId: { roomId, userId: "demo-morgan" } };
  const expiresAt = new Date(Date.now() + 60_000);
  await db.roomMember.update({
    where,
    data: { status: "ACTIVE", seatExpiresAt: expiresAt, handRaised: true },
  });
  assert.equal((await call(role, "alex", { role: "PARTICIPANT" })).status, 200);
  const member = await db.roomMember.findUniqueOrThrow({ where });
  assert.equal(member.status, "ACTIVE");
  assert.ok(member.seatExpiresAt);
  assert.equal(member.seatExpiresAt.getTime(), expiresAt.getTime());
  assert.equal(member.handRaised, true);
  assert.equal((await call(role, "alex", { role: "MODERATOR" })).status, 200);
  const retried = await call(review, "alex", { decision: "APPROVE" });
  assert.equal((await retried.json()).changed, false);
  assert.equal(
    (await db.roomMember.findUniqueOrThrow({ where })).role,
    "MODERATOR",
  );
  assert.equal(
    (await db.roomMember.findUniqueOrThrow({ where })).status,
    "ACTIVE",
  );
  assert.equal(
    (await call(review, "alex", { decision: "REJECT" })).status,
    409,
  );
});

test("rejection persists without creating membership and cannot be silently reversed", async () => {
  const target = await candidate("declined");
  assert.equal(
    (await call(review, "alex", { decision: "REJECT" }, target)).status,
    200,
  );
  assert.equal(
    (await (await call(review, "alex", { decision: "REJECT" }, target)).json())
      .changed,
    false,
  );
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" }, target)).status,
    409,
  );
  assert.equal(
    await db.roomMember.count({ where: { roomId, userId: target.userId } }),
    0,
  );
  assert.equal((await ownJoinStatus(roomId, target.userId)).state, "REJECTED");
});

test("concurrent matching and conflicting reviews produce one durable decision", async () => {
  for (const conflicting of [false, true]) {
    const target = await candidate(conflicting ? "conflict" : "repeat");
    const responses = await Promise.all([
      call(review, "alex", { decision: "APPROVE" }, target),
      call(
        review,
        "alex",
        { decision: conflicting ? "REJECT" : "APPROVE" },
        target,
      ),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      conflicting ? [200, 409] : [200, 200],
    );
    const stored = await db.joinRequest.findUniqueOrThrow({
      where: { id: target.requestId },
    });
    assert.notEqual(stored.status, "PENDING");
    assert.equal(
      await db.roomMember.count({ where: { roomId, userId: target.userId } }),
      stored.status === "APPROVED" ? 1 : 0,
    );
    if (!conflicting) {
      const results = await Promise.all(
        responses.map((response) => response.json()),
      );
      assert.equal(results.filter((result) => result.changed).length, 1);
    }
  }
});

test("a database failure rolls back membership and leaves the request pending", async () => {
  const target = await candidate("rollback");
  const fixture = new DatabaseSync(databasePath);
  fixture.exec(
    "CREATE TRIGGER fail_review BEFORE UPDATE ON join_requests WHEN NEW.id = 'request-rollback' AND NEW.status = 'APPROVED' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  fixture.close();
  try {
    const response = await call(
      review,
      "alex",
      { decision: "APPROVE" },
      target,
    );
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("test failure"), false);
    assert.equal(
      await db.roomMember.count({ where: { roomId, userId: target.userId } }),
      0,
    );
    assert.equal(
      (
        await db.joinRequest.findUniqueOrThrow({
          where: { id: target.requestId },
        })
      ).status,
      "PENDING",
    );
  } finally {
    const cleanup = new DatabaseSync(databasePath);
    cleanup.exec("DROP TRIGGER fail_review");
    cleanup.close();
  }
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" }, target)).status,
    200,
  );
});

test("guest, cross-origin and forged authority inputs cannot mutate review state", async () => {
  assert.equal((await call(review, null, { decision: "APPROVE" })).status, 401);
  assert.equal((await call(role, null, { role: "MODERATOR" })).status, 401);
  assert.equal(
    (
      await call(
        review,
        "alex",
        { decision: "APPROVE" },
        { origin: "https://outside.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        role,
        "alex",
        { role: "MODERATOR" },
        { origin: "https://outside.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE", userId: "demo-alex" }))
      .status,
    400,
  );
  assert.equal((await call(role, "alex", { role: "HOST" })).status, 400);
  assert.equal(
    (await call(role, "alex", { role: "MODERATOR", status: "ACTIVE" })).status,
    400,
  );
  assert.equal(
    (await db.room.findUniqueOrThrow({ where: { id: roomId } })).hostId,
    "demo-alex",
  );
});

test("targets must belong to this room; ownership and removed members remain protected", async () => {
  const other = await candidate("other-room", "demo-biology");
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" }, other)).status,
    404,
  );
  assert.equal(
    (await call(role, "alex", { role: "MODERATOR" }, { target: other.userId }))
      .status,
    404,
  );
  assert.equal(
    (await call(role, "alex", { role: "PARTICIPANT" }, { target: "demo-alex" }))
      .status,
    403,
  );
  const removed = await candidate("removed");
  await db.roomMember.create({
    data: { roomId, userId: removed.userId, status: "KICKED" },
  });
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" }, removed)).status,
    403,
  );
  assert.equal(
    (
      await call(
        role,
        "alex",
        { role: "MODERATOR" },
        { target: removed.userId },
      )
    ).status,
    403,
  );
  const stray = await candidate("stray-host");
  await db.roomMember.create({
    data: { roomId, userId: stray.userId, role: "HOST", status: "LEFT" },
  });
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" }, stray)).status,
    403,
  );
  assert.equal(
    (
      await call(
        role,
        "alex",
        { role: "PARTICIPANT" },
        { target: stray.userId },
      )
    ).status,
    403,
  );
});

test("approval retries do not resurrect a subsequently kicked or missing member", async () => {
  const where = { roomId_userId: { roomId, userId: "demo-morgan" } };
  await db.roomMember.update({ where, data: { status: "KICKED" } });
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" })).status,
    403,
  );
  assert.equal(
    (await db.roomMember.findUniqueOrThrow({ where })).status,
    "KICKED",
  );
  await db.roomMember.delete({ where });
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" })).status,
    409,
  );
  assert.equal(
    await db.roomMember.count({ where: { roomId, userId: "demo-morgan" } }),
    0,
  );
});

test("room closure and current host membership are rechecked for every command", async () => {
  for (const state of ["ENDING", "ENDED"] as const) {
    await db.room.update({ where: { id: roomId }, data: { status: state } });
    assert.equal((await call(queue, "alex")).status, 409);
    assert.equal(
      (await call(review, "alex", { decision: "APPROVE" })).status,
      409,
    );
    assert.equal((await call(role, "alex", { role: "MODERATOR" })).status, 409);
  }
  await db.room.update({ where: { id: roomId }, data: { status: "OPEN" } });
  const where = { roomId_userId: { roomId, userId: "demo-alex" } };
  await db.roomMember.update({ where, data: { status: "KICKED" } });
  assert.equal((await call(queue, "alex")).status, 403);
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" })).status,
    403,
  );
  await db.roomMember.update({ where, data: { status: "LEFT" } });
});

test("a revoked session cannot replay review or role commands", async () => {
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-out", {
      method: "POST",
      headers: {
        Cookie: cookies.alex,
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await call(queue, "alex")).status, 401);
  assert.equal(
    (await call(review, "alex", { decision: "APPROVE" })).status,
    401,
  );
  assert.equal((await call(role, "alex", { role: "MODERATOR" })).status, 401);
});
