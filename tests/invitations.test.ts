import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  codeFromFragment,
  invitationCode,
  invitationPath,
} from "../src/lib/invitation-input";
import { safeReturnPath } from "../src/lib/content";

const directory = resolve(
  ".tmp",
  `invitations-${randomBytes(8).toString("hex")}`,
);
mkdirSync(directory, { recursive: true });
process.env.DATABASE_URL = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const sql = new DatabaseSync(join(directory, "test.db"));
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
const { hashInvitation } = await import("../src/lib/invitations");
const { RoomApiError, limitRoomRequests, roomApiFailure } =
  await import("../src/lib/room-api");
const { POST: invite } =
  await import("../src/app/api/rooms/[roomId]/invitations/route");
const { POST: verify } =
  await import("../src/app/api/rooms/[roomId]/invitations/verify/route");
const { POST: apply, GET: status } =
  await import("../src/app/api/rooms/[roomId]/join-requests/route");
const cookies: Record<string, string> = {};
const roomId = "demo-philosophy";
let code: string;

type Handler = typeof invite;
function call(
  handler: Handler,
  user: string | null,
  body: unknown,
  targetRoom = roomId,
  extraHeaders: Record<string, string> = {},
) {
  const request = new Request(
    `http://localhost:3000/api/rooms/${targetRoom}/test`,
    {
      method: handler === status ? "GET" : "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
        ...(user ? { Cookie: cookies[user] } : {}),
        ...extraHeaders,
      },
      ...(handler === status
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
  );
  return handler(request, { params: Promise.resolve({ roomId: targetRoom }) });
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
});
after(async () => {
  await db.$disconnect();
  assert.equal(directory.startsWith(resolve(".tmp") + sep), true);
  rmSync(directory, { recursive: true, force: true });
});

test("only the actual host creates bounded, hashed invitations", async () => {
  const response = await call(invite, "alex", { expiresInMinutes: 60 });
  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const result = await response.json();
  code = result.code;
  assert.equal(invitationCode.safeParse(code).success, true);
  const stored = await db.invitation.findUniqueOrThrow({
    where: { codeHash: hashInvitation(code) },
  });
  assert.notEqual(stored.codeHash, code);
  assert.equal(stored.roomId, roomId);
  assert.equal(stored.expiresAt.toISOString(), result.expiresAt);
  assert.ok(stored.expiresAt.getTime() - Date.now() > 59 * 60_000);
  assert.ok(stored.expiresAt.getTime() - Date.now() <= 60 * 60_000);
  assert.equal(JSON.stringify(stored).includes(code), false);
  assert.equal(
    (await call(invite, null, { expiresInMinutes: 60 })).status,
    401,
  );
  assert.equal(
    (await call(invite, "morgan", { expiresInMinutes: 60 })).status,
    403,
  );
  assert.equal(
    (await call(invite, "alex", { expiresInMinutes: 60 }, "demo-biology"))
      .status,
    403,
  );
});

test("mutation boundaries reject forged identity, origin, invalid JSON and large bodies", async () => {
  for (const body of [
    { expiresInMinutes: 0 },
    { expiresInMinutes: 1441 },
    { expiresInMinutes: "60" },
    { expiresInMinutes: 60, hostId: "demo-alex" },
  ]) {
    assert.equal((await call(invite, "alex", body)).status, 400);
  }
  assert.equal(
    (
      await call(invite, "alex", { expiresInMinutes: 60 }, roomId, {
        Origin: "https://outside.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(invite, "alex", "{}", roomId, { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal((await call(invite, "alex", "{")).status, 400);
  assert.equal((await call(invite, "alex", "x".repeat(4097))).status, 413);
  assert.equal(
    (await call(invite, "alex", { expiresInMinutes: 60 }, "missing-room"))
      .status,
    404,
  );
});

test("public preview checks the room and expiry but creates no application or membership", async () => {
  const members = await db.roomMember.count();
  const response = await call(verify, null, { code });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()), ["expiresAt"]);
  assert.equal(await db.joinRequest.count(), 0);
  assert.equal(await db.roomMember.count(), members);
  assert.equal(
    (await call(verify, null, { code }, "demo-biology")).status,
    404,
  );
  assert.equal(
    (await call(verify, null, { code: randomBytes(32).toString("base64url") }))
      .status,
    404,
  );
  assert.equal((await call(verify, null, { code: "short" })).status, 400);
});

test("an invitation never bypasses login, origin checks, or trusted applicant identity", async () => {
  assert.equal((await call(apply, null, { code })).status, 401);
  assert.equal(
    (
      await call(apply, "morgan", { code }, roomId, {
        Origin: "https://outside.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(apply, "morgan", {
        code,
        userId: "demo-alex",
        role: "HOST",
        status: "APPROVED",
      })
    ).status,
    400,
  );
  assert.equal((await call(apply, "morgan", {})).status, 400);
  assert.equal(
    (await call(apply, "morgan", { code }, "demo-biology")).status,
    409,
  );
  // Morgan owns biology; a different nonmember still cannot use this code there.
  assert.equal(
    (await call(apply, "taylor", { code }, "demo-biology")).status,
    404,
  );
});

test("concurrent repeat submissions produce one pending request and no seat or membership", async () => {
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => call(apply, "morgan", { code })),
  );
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 200, 201],
  );
  const results = await Promise.all(
    responses.map((response) => response.json()),
  );
  assert.equal(new Set(results.map((result) => result.request.id)).size, 1);
  assert.equal(results[0].request.status, "PENDING");
  assert.equal(
    await db.joinRequest.count({ where: { roomId, userId: "demo-morgan" } }),
    1,
  );
  assert.equal(
    await db.roomMember.count({ where: { roomId, userId: "demo-morgan" } }),
    0,
  );
  assert.equal(Object.hasOwn(results[0], "token"), false);
});

test("status is persisted, no-store and scoped to the signed-in applicant", async () => {
  assert.equal((await call(status, null, null)).status, 401);
  const own = await call(status, "morgan", null);
  assert.equal(own.status, 200);
  assert.match(own.headers.get("cache-control") ?? "", /no-store/);
  assert.equal((await own.json()).state, "PENDING");
  const other = await call(status, "taylor", null);
  assert.deepEqual(await other.json(), { state: "NONE", request: null });
  assert.equal((await (await call(status, "alex", null)).json()).state, "HOST");
});

test("expiry is checked again on submit even after a successful preview", async () => {
  assert.equal((await call(verify, null, { code })).status, 200);
  await db.invitation.update({
    where: { codeHash: hashInvitation(code) },
    data: { expiresAt: new Date(Date.now() - 1) },
  });
  for (const handler of [verify, apply]) {
    const response = await call(handler, "taylor", { code });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).code, "INVITATION_EXPIRED");
  }
  assert.equal(
    await db.joinRequest.count({ where: { userId: "demo-taylor" } }),
    0,
  );
  // Expiry does not retroactively erase a request that was validly submitted.
  assert.equal(
    (await (await call(status, "morgan", null)).json()).state,
    "PENDING",
  );
  await db.invitation.update({
    where: { codeHash: hashInvitation(code) },
    data: { expiresAt: new Date(Date.now() + 60_000) },
  });
});

test("terminal application states cannot be reset by resubmitting an invitation", async () => {
  const where = { roomId_userId: { roomId, userId: "demo-morgan" } };
  for (const state of ["REJECTED", "APPROVED"] as const) {
    await db.joinRequest.update({ where, data: { status: state } });
    assert.equal((await call(apply, "morgan", { code })).status, 409);
    assert.equal(
      (await db.joinRequest.findUniqueOrThrow({ where })).status,
      state,
    );
    assert.equal(
      (await (await call(status, "morgan", null)).json()).state,
      state,
    );
  }
  await db.joinRequest.update({ where, data: { status: "PENDING" } });
});

test("kicked, already admitted and inconsistent members cannot create new requests", async () => {
  const where = { roomId_userId: { roomId, userId: "demo-taylor" } };
  await db.roomMember.create({
    data: {
      roomId,
      userId: "demo-taylor",
      role: "PARTICIPANT",
      status: "KICKED",
    },
  });
  assert.equal((await call(apply, "taylor", { code })).status, 403);
  assert.equal(
    (await (await call(status, "taylor", null)).json()).state,
    "KICKED",
  );
  for (const state of ["APPROVED", "ACTIVE"] as const) {
    await db.roomMember.update({ where, data: { status: state } });
    assert.equal((await call(apply, "taylor", { code })).status, 409);
  }
  await db.roomMember.update({ where, data: { role: "HOST", status: "LEFT" } });
  assert.equal((await call(apply, "taylor", { code })).status, 403);
  assert.equal(
    (await call(invite, "taylor", { expiresInMinutes: 15 })).status,
    403,
  );
  await db.roomMember.delete({ where });
});

test("closing and ended rooms reject invitation creation, preview and applications", async () => {
  for (const state of ["ENDING", "ENDED"] as const) {
    await db.room.update({ where: { id: roomId }, data: { status: state } });
    assert.equal(
      (await call(invite, "alex", { expiresInMinutes: 15 })).status,
      409,
    );
    assert.equal((await call(verify, null, { code })).status, 409);
    assert.equal((await call(apply, "morgan", { code })).status, 409);
    assert.equal(
      (await (await call(status, "morgan", null)).json()).state,
      "CLOSED",
    );
  }
  assert.equal(await db.joinRequest.count({ where: { roomId } }), 1);
  await db.room.update({ where: { id: roomId }, data: { status: "OPEN" } });
});

test("bounded local request limits expire and unknown failures expose no secrets", async () => {
  const key = `test:${randomBytes(8).toString("hex")}`;
  limitRoomRequests(key, 2, 1000);
  limitRoomRequests(key, 2, 1001);
  assert.throws(
    () => limitRoomRequests(key, 2, 1002),
    (error: unknown) => error instanceof RoomApiError && error.status === 429,
  );
  assert.doesNotThrow(() => limitRoomRequests(key, 2, 61_000));
  const failure = roomApiFailure(new Error("private-database-detail"));
  assert.equal(failure.status, 503);
  assert.equal(
    (await failure.text()).includes("private-database-detail"),
    false,
  );
});

test("invite codes stay in fragments and never in login return paths", () => {
  const link = new URL(invitationPath(roomId, code), "http://localhost:3000");
  assert.equal(link.search, "");
  assert.equal(codeFromFragment(link.hash), code);
  assert.equal(codeFromFragment(""), null);
  assert.equal(codeFromFragment("#invite="), "");
  const returnTo = safeReturnPath(link.pathname);
  assert.equal(returnTo, `/rooms/${roomId}/join`);
  assert.equal(returnTo.includes(code), false);
});
