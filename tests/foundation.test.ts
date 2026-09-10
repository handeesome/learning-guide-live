import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { safeReturnPath } from "../src/lib/content";
import { roomInput } from "../src/lib/room-input";

const testDirectory = resolve(
  ".tmp",
  `foundation-${randomBytes(8).toString("hex")}`,
);
mkdirSync(testDirectory, { recursive: true });
process.env.DATABASE_URL = `file:${join(testDirectory, "test.db").replaceAll("\\", "/")}`;
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const sql = new DatabaseSync(join(testDirectory, "test.db"));
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
const { loadRoomAccess } = await import("../src/lib/room-access");
const { canReadRoomHistory, canPerformRoomAction } =
  await import("../src/lib/room-policy");
const { POST: createRoom } = await import("../src/app/api/rooms/route");
const { seedDemo, demoPassword } = await import("../prisma/seed");
let cookie: string;

function authRequest(
  path: string,
  body?: Record<string, unknown>,
  sessionCookie?: string,
  origin = "http://localhost:3000",
) {
  return auth.handler(
    new Request(`http://localhost:3000/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json", Origin: origin } : {}),
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

before(async () => {
  await seedDemo();
});
after(async () => {
  await db.$disconnect();
  // Only remove the exact disposable directory created by this test process.
  assert.equal(
    testDirectory.startsWith(
      resolve(".tmp") + (process.platform === "win32" ? "\\" : "/"),
    ),
    true,
  );
  rmSync(testDirectory, { recursive: true, force: true });
});

test("demo seed is idempotent and preserves edited user data", async () => {
  const counts = await Promise.all([
    db.user.count(),
    db.room.count(),
    db.chatMessage.count(),
  ]);
  await db.room.update({
    where: { id: "demo-philosophy" },
    data: { title: "A title edited by the host" },
  });
  await seedDemo();
  assert.deepEqual(
    await Promise.all([
      db.user.count(),
      db.room.count(),
      db.chatMessage.count(),
    ]),
    counts,
  );
  assert.equal(
    (await db.room.findUniqueOrThrow({ where: { id: "demo-philosophy" } }))
      .title,
    "A title edited by the host",
  );
  const account = await db.account.findFirstOrThrow({
    where: { userId: "demo-alex" },
  });
  assert.notEqual(account.password, demoPassword);
});

test("registration issues an HttpOnly session and a hashed credential", async () => {
  const response = await authRequest("sign-up/email", {
    name: "Test reader",
    email: "reader@guide.test",
    password: "A-valid-test-password!",
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Registration must return a session cookie.");
  assert.ok(setCookie.includes("HttpOnly"));
  assert.match(setCookie, /SameSite=Lax/i);
  cookie = setCookie.split(";")[0];
  const result = await response.json();
  assert.equal(result.user.email, "reader@guide.test");
  const account = await db.account.findFirstOrThrow({
    where: { userId: result.user.id },
  });
  assert.notEqual(account.password, "A-valid-test-password!");
  assert.ok(await auth.api.getSession({ headers: new Headers({ cookie }) }));
});

test("wrong password and cross-origin sign-in are rejected", async () => {
  const wrong = await authRequest("sign-in/email", {
    email: "alex@guide.test",
    password: "not-the-password",
  });
  assert.equal(wrong.status, 401);
  const crossOrigin = await authRequest(
    "sign-in/email",
    { email: "alex@guide.test", password: demoPassword },
    undefined,
    "https://untrusted.example",
  );
  assert.equal(crossOrigin.status, 403);
});

test("a seeded demo account can sign in", async () => {
  const response = await authRequest("sign-in/email", {
    email: "alex@guide.test",
    password: demoPassword,
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("set-cookie"));
});

test("room creation rejects guests, spoofed origins and invalid topics", async () => {
  const data = {
    title: "A good question",
    description: "An interesting question for a small group.",
    topic: "PHILOSOPHY",
  };
  function request(body: object, headers = {}) {
    return new Request("http://localhost:3000/api/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  assert.equal((await createRoom(request(data))).status, 401);
  assert.equal(
    (
      await createRoom(
        request(data, { Cookie: cookie, Origin: "https://untrusted.example" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await createRoom(
        request({ ...data, topic: "UNRELATED" }, { Cookie: cookie }),
      )
    ).status,
    400,
  );
  const result = await createRoom(
    request({ ...data, hostId: "demo-alex" }, { Cookie: cookie }),
  );
  assert.equal(result.status, 201);
  const { id } = await result.json();
  const room = await db.room.findUniqueOrThrow({
    where: { id },
    include: { members: true },
  });
  assert.notEqual(room.hostId, "demo-alex");
  assert.equal(room.members[0].role, "HOST");
  assert.equal(room.members[0].userId, room.hostId);
});

test("sign-out revokes the persisted session, including replay of the old cookie", async () => {
  assert.ok(await auth.api.getSession({ headers: new Headers({ cookie }) }));
  const response = await authRequest("sign-out", {}, cookie);
  assert.equal(response.status, 200);
  assert.equal(
    await auth.api.getSession({ headers: new Headers({ cookie }) }),
    null,
  );
});

test("input validation and return URLs have bounded, local behavior", () => {
  assert.equal(
    roomInput.safeParse({
      title: " ",
      description: "too short",
      topic: "PHILOSOPHY",
    }).success,
    false,
  );
  for (const value of [
    "https://outside.example",
    "//outside.example",
    "/\\outside.example",
    "/rooms\\outside.example",
  ])
    assert.equal(safeReturnPath(value), "/rooms");
  assert.equal(
    safeReturnPath("/rooms/demo-philosophy"),
    "/rooms/demo-philosophy",
  );
});

test("room access loads the viewer's SQL membership and rechecks revocation", async () => {
  const roomId = "demo-past-philosophy";
  const guest = await loadRoomAccess(roomId, null);
  assert.ok(guest);
  assert.equal(guest.policy.member, null);
  assert.equal(canReadRoomHistory(guest.policy), false);
  const stranger = await loadRoomAccess(roomId, "not-a-member");
  assert.ok(stranger);
  assert.equal(canReadRoomHistory(stranger.policy), false);
  assert.equal(await loadRoomAccess("missing-room", "demo-alex"), null);

  const member = await loadRoomAccess(roomId, "demo-morgan");
  assert.ok(member);
  assert.equal(member.policy.member?.role, "MODERATOR");
  assert.equal(canReadRoomHistory(member.policy), true);
  assert.equal(
    canPerformRoomAction(member.policy, { action: "review_requests" }),
    false,
  );

  const where = { roomId_userId: { roomId, userId: "demo-morgan" } };
  await db.roomMember.update({ where, data: { status: "KICKED" } });
  const revoked = await loadRoomAccess(roomId, "demo-morgan");
  assert.ok(revoked);
  assert.equal(canReadRoomHistory(revoked.policy), false);

  // Same-room lookup alone is insufficient: a stray HOST role must not override
  // rooms.hostId. This fixture is confined to this test's disposable database.
  await db.roomMember.update({ where, data: { status: "LEFT", role: "HOST" } });
  const inconsistent = await loadRoomAccess(roomId, "demo-morgan");
  assert.ok(inconsistent);
  assert.equal(canReadRoomHistory(inconsistent.policy), false);
  await db.roomMember.update({
    where,
    data: { status: "LEFT", role: "MODERATOR" },
  });

  const host = await loadRoomAccess("demo-philosophy", "demo-alex");
  assert.ok(host);
  assert.equal(
    canPerformRoomAction(host.policy, { action: "review_requests" }),
    true,
  );
  const otherRoom = await loadRoomAccess("demo-biology", "demo-alex");
  assert.ok(otherRoom);
  assert.equal(
    canPerformRoomAction(otherRoom.policy, { action: "review_requests" }),
    false,
  );
});
