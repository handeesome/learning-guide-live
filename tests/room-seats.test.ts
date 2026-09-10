import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { SeatStatus } from "../src/lib/seat-input";

const directory = resolve(".tmp", `seats-${randomBytes(8).toString("hex")}`);
mkdirSync(directory, { recursive: true });
const databasePath = join(directory, "test.db");
process.env.DATABASE_URL = `file:${databasePath.replaceAll("\\", "/")}`;
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const migrations = readdirSync(resolve("prisma/migrations"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) =>
    readFileSync(
      resolve("prisma/migrations", entry.name, "migration.sql"),
      "utf8",
    ),
  );
const sql = new DatabaseSync(databasePath);
sql.exec("PRAGMA foreign_keys = ON");
for (const migration of migrations) sql.exec(migration);
sql.close();

const { db } = await import("../src/lib/db");
const { auth } = await import("../src/lib/auth");
const { seedDemo, demoPassword } = await import("../prisma/seed");
const { reserveSeat, releaseSeat, getSeatStatus, RESERVATION_MS } =
  await import("../src/lib/room-seats");
const { reviewJoinRequest } = await import("../src/lib/room-review");
const { RoomApiError } = await import("../src/lib/room-api");
const { GET, POST, DELETE } =
  await import("../src/app/api/rooms/[roomId]/seat/route");
const clientId = randomUUID();
let cookie: string;

before(async () => {
  await seedDemo();
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "alex@guide.test",
        password: demoPassword,
      }),
    }),
  );
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  cookie = header.split(";")[0];
});
after(async () => {
  await db.$disconnect();
  assert.ok(directory.startsWith(resolve(".tmp") + sep));
  rmSync(directory, { recursive: true, force: true });
});

function call(
  method: "GET" | "POST" | "DELETE",
  roomId: string,
  body?: object,
  options: { guest?: boolean; origin?: string } = {},
) {
  const handler = { GET, POST, DELETE }[method];
  return handler(
    new Request(`http://localhost:3000/api/rooms/${roomId}/seat`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: options.origin ?? "http://localhost:3000",
        "X-Room-Client": clientId,
        ...(options.guest ? {} : { Cookie: cookie }),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    }),
    { params: Promise.resolve({ roomId }) },
  );
}
const claim = (id = clientId, previousReservationId: string | null = null) => ({
  clientId: id,
  previousReservationId,
});
const denied = (code: string) => (error: unknown) =>
  error instanceof RoomApiError && error.code === code;

async function room(tag: string, count = 0) {
  const roomId = `seats-${tag}`;
  await db.room.create({
    data: {
      id: roomId,
      title: "Seat test",
      description: "Synthetic admission test",
      topic: "PHILOSOPHY",
      hostId: "demo-alex",
      members: {
        create: { userId: "demo-alex", role: "HOST", status: "LEFT" },
      },
    },
  });
  const users = [];
  for (let i = 0; i < count; i++) {
    const userId = `${roomId}-${i}`;
    await db.user.create({
      data: {
        id: userId,
        name: `Seat candidate ${i}`,
        email: `${userId}@guide.test`,
      },
    });
    await db.roomMember.create({ data: { roomId, userId } });
    users.push(userId);
  }
  return { roomId, users };
}

test("additive migration preserves existing membership and lease data", () => {
  const upgrade = new DatabaseSync(join(directory, "upgrade.db"));
  try {
    upgrade.exec(migrations[0]);
    upgrade.exec(
      "INSERT INTO users (id,name,email,updatedAt) VALUES ('old-user','Before upgrade','old@guide.test',0)",
    );
    upgrade.exec(
      "INSERT INTO rooms (id,title,description,topic,hostId,updatedAt) VALUES ('old-room','Preserve','Preserve','PHILOSOPHY','old-user',0)",
    );
    upgrade.exec(
      "INSERT INTO room_members (id,roomId,userId,role,status,handRaised,seatExpiresAt,updatedAt) VALUES ('old-member','old-room','old-user','HOST','LEFT',1,123456,0)",
    );
    const baseline = upgrade.prepare("SELECT * FROM room_members").get();
    for (const migration of migrations.slice(1)) upgrade.exec(migration);
    assert.deepEqual(
      { ...upgrade.prepare("SELECT * FROM room_members").get() },
      {
        ...baseline,
        seatOwnerId: null,
        seatReservationId: null,
        mediaIdentity: null,
        mediaTokenExpiresAt: null,
        mediaRevoking: 0,
        mediaAbsentSince: null,
      },
    );
  } finally {
    upgrade.close();
  }
});

test("seat routes enforce authentication, origin, strict input and server membership", async () => {
  for (const method of ["GET", "POST", "DELETE"] as const) {
    const response = await call(method, "demo-philosophy", claim(), {
      guest: true,
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.equal(
    (
      await call("POST", "demo-philosophy", claim(), {
        origin: "https://untrusted.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("POST", "demo-philosophy", {
        ...claim(),
        role: "HOST",
        userId: "demo-morgan",
        seatExpiresAt: "2099-01-01",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("POST", "demo-philosophy", { clientId: "bad" })).status,
    400,
  );
  assert.equal((await call("GET", "demo-biology")).status, 403);
  const response = await call("POST", "demo-philosophy", claim());
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.occupied, 1);
  assert.equal(result.active, false);
  assert.equal(result.token, undefined);
  assert.equal(
    (
      await call("DELETE", "demo-philosophy", {
        clientId,
        reservationId: result.reservation.id,
      })
    ).status,
    200,
  );
});

test("approval and history do not consume seats; the host counts and the ninth claim is refused", async () => {
  const { roomId, users } = await room("capacity", 9);
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).occupied,
    0,
  );
  await reserveSeat(roomId, "demo-alex", claim());
  for (const userId of users.slice(0, 7))
    await reserveSeat(roomId, userId, claim());
  const full = await getSeatStatus(roomId, "demo-alex", { clientId });
  assert.equal(full.occupied, 8);
  assert.equal(full.available, 0);
  await assert.rejects(
    reserveSeat(roomId, users[7], claim()),
    denied("ROOM_FULL"),
  );
  const unseated = await db.roomMember.findUniqueOrThrow({
    where: { roomId_userId: { roomId, userId: users[7] } },
  });
  assert.equal(unseated.seatExpiresAt, null);
  assert.equal(unseated.status, "APPROVED");
  const host = await db.roomMember.findUniqueOrThrow({
    where: { roomId_userId: { roomId, userId: "demo-alex" } },
  });
  assert.equal(host.status, "LEFT"); // A reservation is not online presence.
});

test("repeat claims are idempotent without extending a reservation or spending another seat", async () => {
  const { roomId } = await room("repeat");
  const results = await Promise.all(
    Array.from({ length: 3 }, () => reserveSeat(roomId, "demo-alex", claim())),
  );
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(
    new Set(results.map((result) => result.reservation?.id)).size,
    1,
  );
  assert.equal(
    new Set(results.map((result) => result.reservation?.expiresAt)).size,
    1,
  );
  assert.equal(results[0].occupied, 1);
  assert.ok(results[0].reservation);
  assert.equal(
    Date.parse(results[0].reservation.expiresAt) -
      Date.parse(results[0].serverTime),
    RESERVATION_MS,
  );
});

test("a new page takes over one seat and stale claims/cancellations cannot reclaim it", async () => {
  const { roomId } = await room("takeover");
  const first = await reserveSeat(roomId, "demo-alex", claim());
  assert.ok(first.reservation);
  const secondPage = randomUUID();
  const transferred = await reserveSeat(
    roomId,
    "demo-alex",
    claim(secondPage, first.reservation.id),
  );
  assert.ok(transferred.reservation);
  assert.equal(transferred.occupied, 1);
  assert.notEqual(transferred.reservation.id, first.reservation.id);
  assert.equal(transferred.reservation.expiresAt, first.reservation.expiresAt);
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).reservation
      ?.ownedByThisPage,
    false,
  );
  await assert.rejects(
    reserveSeat(roomId, "demo-alex", claim()),
    denied("SEAT_CHANGED"),
  );
  const delayed = await releaseSeat(roomId, "demo-alex", {
    clientId,
    reservationId: first.reservation.id,
  });
  assert.equal(delayed.released, false);
  assert.equal(delayed.reservation?.id, transferred.reservation.id);
  await assert.rejects(
    releaseSeat(roomId, "demo-alex", {
      clientId,
      reservationId: transferred.reservation.id,
    }),
    denied("SEAT_OWNER_REQUIRED"),
  );
  const released = await releaseSeat(roomId, "demo-alex", {
    clientId: secondPage,
    reservationId: transferred.reservation.id,
  });
  assert.equal(released.released, true);
  assert.equal(released.occupied, 0);
  assert.equal(
    (
      await releaseSeat(roomId, "demo-alex", {
        clientId: secondPage,
        reservationId: transferred.reservation.id,
      })
    ).released,
    false,
  );
});

test("expired reservations free capacity without erasing membership; stale release cannot undo reacquisition", async () => {
  const { roomId } = await room("expiry");
  const first = await reserveSeat(roomId, "demo-alex", claim());
  assert.ok(first.reservation);
  const where = { roomId_userId: { roomId, userId: "demo-alex" } };
  await db.roomMember.update({ where, data: { seatExpiresAt: new Date(0) } });
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).occupied,
    0,
  );
  assert.equal((await db.roomMember.findUniqueOrThrow({ where })).role, "HOST");
  await assert.rejects(
    reserveSeat(roomId, "demo-alex", claim(clientId, first.reservation.id)),
    denied("SEAT_CHANGED"),
  );
  const next = await reserveSeat(roomId, "demo-alex", claim());
  assert.ok(next.reservation);
  assert.notEqual(next.reservation.id, first.reservation.id);
  const stale = await releaseSeat(roomId, "demo-alex", {
    clientId,
    reservationId: first.reservation.id,
  });
  assert.equal(stale.released, false);
  assert.equal(stale.reservation?.id, next.reservation.id);
});

test("pending/rejected/kicked/inconsistent identities and closed rooms cannot reserve or release", async () => {
  const { roomId, users } = await room("permissions", 2);
  const where = { roomId_userId: { roomId, userId: users[0] } };
  await db.roomMember.delete({ where });
  await db.joinRequest.create({ data: { roomId, userId: users[0] } });
  await assert.rejects(
    reserveSeat(roomId, users[0], claim()),
    denied("MEMBERSHIP_REQUIRED"),
  );
  await db.joinRequest.update({ where, data: { status: "REJECTED" } });
  await assert.rejects(
    reserveSeat(roomId, users[0], claim()),
    denied("MEMBERSHIP_REQUIRED"),
  );
  const target = { roomId_userId: { roomId, userId: users[1] } };
  const held = await reserveSeat(roomId, users[1], claim());
  assert.ok(held.reservation);
  for (const data of [
    { status: "KICKED" as const },
    { status: "APPROVED" as const, role: "HOST" as const },
  ]) {
    await db.roomMember.update({ where: target, data });
    await assert.rejects(
      reserveSeat(roomId, users[1], claim()),
      denied("MEMBERSHIP_REQUIRED"),
    );
    await assert.rejects(
      releaseSeat(roomId, users[1], {
        clientId,
        reservationId: held.reservation.id,
      }),
      denied("MEMBERSHIP_REQUIRED"),
    );
  }
  for (const status of ["ENDING", "ENDED"] as const) {
    await db.room.update({ where: { id: roomId }, data: { status } });
    await assert.rejects(
      reserveSeat(roomId, "demo-alex", claim()),
      denied("ROOM_CLOSED"),
    );
    await assert.rejects(
      getSeatStatus(roomId, "demo-alex", { clientId }),
      denied("ROOM_CLOSED"),
    );
    await assert.rejects(
      releaseSeat(roomId, "demo-alex", {
        clientId,
        reservationId: held.reservation.id,
      }),
      denied("ROOM_CLOSED"),
    );
  }
});

test("ACTIVE participants count even with expired or missing timers and cannot be freed by reservation commands", async () => {
  const { roomId, users } = await room("active", 8);
  for (const [index, userId] of users.entries()) {
    await db.roomMember.update({
      where: { roomId_userId: { roomId, userId } },
      data: { status: "ACTIVE", seatExpiresAt: index % 2 ? null : new Date(0) },
    });
  }
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).occupied,
    8,
  );
  await assert.rejects(
    reserveSeat(roomId, "demo-alex", claim()),
    denied("ROOM_FULL"),
  );
  await assert.rejects(
    reserveSeat(roomId, users[0], claim()),
    denied("MEDIA_SESSION_ACTIVE"),
  );
  await assert.rejects(
    releaseSeat(roomId, users[0], { clientId, reservationId: randomUUID() }),
    denied("MEDIA_SESSION_ACTIVE"),
  );
  assert.equal(
    await db.roomMember.count({ where: { roomId, status: "ACTIVE" } }),
    8,
  );
});

test("parallel host approvals create eligibility, then competing claims allocate only the eighth seat", async () => {
  const { roomId, users } = await room("approvals", 8);
  await reserveSeat(roomId, "demo-alex", claim());
  for (const userId of users.slice(0, 6))
    await reserveSeat(roomId, userId, claim());
  for (const userId of users.slice(6)) {
    await db.roomMember.delete({
      where: { roomId_userId: { roomId, userId } },
    });
    await db.joinRequest.create({ data: { roomId, userId } });
  }
  const requests = await db.joinRequest.findMany({ where: { roomId } });
  await Promise.all(
    requests.map((request) =>
      reviewJoinRequest(roomId, "demo-alex", request.id, {
        decision: "APPROVE",
      }),
    ),
  );
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).occupied,
    7,
  );
  const results = await Promise.allSettled(
    users.slice(6).map((userId) => reserveSeat(roomId, userId, claim())),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const refused = results.find((result) => result.status === "rejected");
  assert.ok(
    refused &&
      refused.status === "rejected" &&
      denied("ROOM_FULL")(refused.reason),
  );
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).occupied,
    8,
  );
});

type ContenderResult = { status: number; code?: string; result?: SeatStatus };
async function raceAcrossProcesses(roomId: string, users: string[]) {
  const children: ChildProcess[] = [];
  const jobs = users.map((userId) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("tests/fixtures/seat-contender.ts")],
      {
        env: { ...process.env },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    children.push(child);
    let readyResolve: () => void;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const done = new Promise<ContenderResult>((resolve, reject) => {
      let received: ContenderResult | undefined;
      const deadline = setTimeout(() => {
        child.kill();
        reject(new Error("Seat contender exceeded 30 seconds"));
      }, 30_000);
      child.on("message", (message: { ready?: boolean } & ContenderResult) => {
        if (message.ready) readyResolve();
        else received = message;
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(deadline);
        if (code === 0 && received) resolve(received);
        else
          reject(new Error("Seat contender exited before returning a result"));
      });
    });
    return { child, ready, done, userId };
  });
  try {
    // Fail on an early child exit rather than hanging at the ready barrier.
    await Promise.race([
      Promise.all(jobs.map((job) => job.ready)),
      Promise.all(jobs.map((job) => job.done)),
    ]);
    for (const job of jobs)
      job.child.send({
        roomId,
        userId: job.userId,
        clientId,
        previousReservationId: null,
      });
    return await Promise.all(jobs.map((job) => job.done));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}

test("independent processes competing for the final seat cannot oversell", async () => {
  const { roomId, users } = await room("processes", 8);
  await reserveSeat(roomId, "demo-alex", claim());
  for (const userId of users.slice(0, 6))
    await reserveSeat(roomId, userId, claim());
  const results = await raceAcrossProcesses(roomId, users.slice(6));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(
    results.find((result) => result.status === 409)?.code,
    "ROOM_FULL",
  );
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).occupied,
    8,
  );
});

test("independent processes repeating one account's claim get the same reservation", async () => {
  const { roomId } = await room("process-repeat");
  const results = await raceAcrossProcesses(roomId, ["demo-alex", "demo-alex"]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
  assert.equal(
    results[0].result?.reservation?.id,
    results[1].result?.reservation?.id,
  );
  assert.equal(
    (await getSeatStatus(roomId, "demo-alex", { clientId })).occupied,
    1,
  );
});

test("revoked sessions cannot read, acquire or cancel seats", async () => {
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-out", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(response.status, 200);
  for (const method of ["GET", "POST", "DELETE"] as const)
    assert.equal((await call(method, "demo-philosophy", claim())).status, 401);
});
