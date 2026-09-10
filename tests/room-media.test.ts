import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TokenVerifier } from "livekit-server-sdk";
import type { MediaActor } from "../src/lib/media-input";
import type { MediaGateway, TokenDetails } from "../src/lib/livekit";

const directory = resolve(".tmp", `media-${randomBytes(8).toString("hex")}`);
mkdirSync(directory, { recursive: true });
const databasePath = join(directory, "test.db");
process.env.DATABASE_URL = `file:${databasePath.replaceAll("\\", "/")}`;
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.BETTER_AUTH_URL = "http://localhost:3000";
// Synthetic keys override any host configuration. No test contacts Cloud.
process.env.LIVEKIT_URL = "wss://synthetic.livekit.cloud";
process.env.LIVEKIT_API_KEY = randomBytes(12).toString("hex");
process.env.LIVEKIT_API_SECRET = randomBytes(48).toString("base64url");
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
const { db } = await import("../src/lib/db");
const { auth } = await import("../src/lib/auth");
const { seedDemo, demoPassword } = await import("../prisma/seed");
const { reserveSeat, releaseSeat, getSeatStatus } =
  await import("../src/lib/room-seats");
const { createRoomMedia } = await import("../src/lib/room-media");
const { liveKitConfiguration, signMediaToken, mediaRoomName } =
  await import("../src/lib/livekit");
const { RoomApiError, roomApiFailure } = await import("../src/lib/room-api");
const tokenRoute = await import("../src/app/api/rooms/[roomId]/token/route");
const syncRoute =
  await import("../src/app/api/rooms/[roomId]/media-sync/route");
const config = liveKitConfiguration();
const verifier = new TokenVerifier(config.apiKey, config.apiSecret);
let cookie: string;
let actor: MediaActor;

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
  const session = await auth.api.getSession({
    headers: new Headers({ Cookie: cookie }),
  });
  assert.ok(session);
  actor = { userId: session.user.id, sessionId: session.session.id };
});
after(async () => {
  await db.$disconnect();
  assert.ok(directory.startsWith(resolve(".tmp") + sep));
  rmSync(directory, { recursive: true, force: true });
});
const denied = (code: string) => (error: unknown) =>
  error instanceof RoomApiError && error.code === code;
const where = (roomId: string, userId = "demo-alex") => ({
  roomId_userId: { roomId, userId },
});

function fakeCloud() {
  const state = {
    signed: 0,
    prepared: 0,
    revoked: [] as string[],
    present: [] as string[],
    failRevoke: false,
  };
  const gateway: MediaGateway = {
    url: config.url,
    async prepareRoom() {
      state.prepared++;
    },
    async sign(details: TokenDetails) {
      state.signed++;
      return signMediaToken(config, details);
    },
    async participants() {
      return [...state.present];
    },
    async revoke(_room, identity) {
      if (state.failRevoke) throw new Error("synthetic network failure");
      state.revoked.push(identity);
      state.present = state.present.filter((id) => id !== identity);
    },
    async broadcast() {},
    async close() {
      state.present = [];
    },
  };
  return { state, gateway, media: createRoomMedia(gateway) };
}

async function fixture(reserve = true) {
  const roomId = `media-${randomUUID()}`;
  await db.room.create({
    data: {
      id: roomId,
      title: "Media test",
      description: "Synthetic permission test",
      topic: "PHILOSOPHY",
      hostId: "demo-alex",
      members: {
        create: { userId: "demo-alex", role: "HOST", status: "LEFT" },
      },
    },
  });
  const clientId = randomUUID();
  const seat = reserve
    ? await reserveSeat(roomId, actor.userId, {
        clientId,
        previousReservationId: null,
      })
    : null;
  return {
    roomId,
    input: { clientId, reservationId: seat?.reservation?.id ?? randomUUID() },
    ...fakeCloud(),
  };
}

test("real SDK JWT is room scoped, short lived and has no business admin/data authority", async () => {
  const f = await fixture();
  const grant = await f.media.issue(actor, f.roomId, f.input);
  const claims = await verifier.verify(grant.token, 0);
  assert.equal(claims.sub, grant.identity);
  assert.match(grant.identity, /^p-[a-f0-9-]+$/);
  assert.equal(claims.video?.room, mediaRoomName(f.roomId));
  assert.equal(claims.video?.roomJoin, true);
  for (const field of [
    "roomAdmin",
    "roomCreate",
    "roomList",
    "roomRecord",
    "canPublishData",
    "canUpdateOwnMetadata",
  ] as const)
    assert.equal(claims.video?.[field], false);
  assert.equal(claims.video?.canPublish, true);
  assert.equal(claims.video?.canSubscribe, true);
  assert.equal(claims.video?.canPublishSources?.length, 4);
  assert.equal(claims.roomConfig?.maxParticipants, 8);
  assert.ok(claims.exp && claims.nbf && claims.exp - claims.nbf <= 60);
  assert.equal(claims.metadata, undefined);
  assert.equal(grant.serverUrl, config.url);
  const member = await db.roomMember.findUniqueOrThrow({
    where: where(f.roomId),
  });
  assert.equal(
    member.status,
    "LEFT",
    "Signing does not prove a media connection",
  );
  assert.equal(member.mediaIdentity, grant.identity);
  const retry = await f.media.issue(actor, f.roomId, f.input);
  assert.equal(retry.identity, grant.identity);
  assert.equal(
    retry.expiresAt,
    grant.expiresAt,
    "Retry must not renew the window",
  );
  assert.equal(
    (
      await getSeatStatus(f.roomId, actor.userId, {
        clientId: f.input.clientId,
      })
    ).occupied,
    1,
  );
});

test("input, membership, generation, owner, expired seat and session deny before Cloud/signing", async () => {
  const f = await fixture();
  await assert.rejects(
    f.media.issue(actor, f.roomId, { ...f.input, role: "HOST" }),
    denied("INVALID_INPUT"),
  );
  await assert.rejects(
    f.media.issue(actor, f.roomId, { ...f.input, reservationId: randomUUID() }),
    denied("SEAT_CHANGED"),
  );
  await assert.rejects(
    f.media.issue(actor, f.roomId, { ...f.input, clientId: randomUUID() }),
    denied("TAKEOVER_REQUIRED"),
  );
  await assert.rejects(
    f.media.issue({ ...actor, sessionId: "missing" }, f.roomId, f.input),
    denied("SIGN_IN_REQUIRED"),
  );
  await assert.rejects(
    f.media.issue(actor, "demo-biology", f.input),
    denied("MEMBERSHIP_REQUIRED"),
  );
  await db.roomMember.update({
    where: where(f.roomId),
    data: { seatExpiresAt: new Date(0) },
  });
  await assert.rejects(
    f.media.issue(actor, f.roomId, f.input),
    denied("SEAT_EXPIRED"),
  );
  assert.equal(f.state.prepared, 0);
  assert.equal(f.state.signed, 0);
});

test("pending/rejected requests, kicked members, inconsistent host and closing/ended rooms cannot mint", async () => {
  for (const status of ["PENDING", "REJECTED"] as const) {
    const f = await fixture(false);
    await db.roomMember.delete({ where: where(f.roomId) });
    await db.joinRequest.create({
      data: { roomId: f.roomId, userId: actor.userId, status },
    });
    await assert.rejects(
      f.media.issue(actor, f.roomId, f.input),
      denied("MEMBERSHIP_REQUIRED"),
    );
    assert.equal(f.state.signed, 0);
  }
  for (const status of ["ENDING", "ENDED"] as const) {
    const f = await fixture();
    await db.room.update({ where: { id: f.roomId }, data: { status } });
    await assert.rejects(
      f.media.issue(actor, f.roomId, f.input),
      denied("ROOM_CLOSED"),
    );
    assert.equal(f.state.prepared, 0);
  }
  const f = await fixture();
  await db.roomMember.update({
    where: where(f.roomId),
    data: { status: "KICKED" },
  });
  await assert.rejects(
    f.media.issue(actor, f.roomId, f.input),
    denied("MEMBERSHIP_REQUIRED"),
  );
  await db.roomMember.update({
    where: where(f.roomId),
    data: { status: "LEFT", role: "PARTICIPANT" },
  });
  await assert.rejects(
    f.media.issue(actor, f.roomId, f.input),
    denied("MEMBERSHIP_REQUIRED"),
  );
  assert.equal(f.state.signed, 0);
});

test("route auth, CSRF, strict fields, no-store and error redaction work without network", async () => {
  const call = (
    handler: typeof tokenRoute.POST,
    method: string,
    body: object,
    guest = false,
    origin = "http://localhost:3000",
  ) =>
    handler(
      new Request("http://localhost:3000/api/rooms/demo-philosophy/token", {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          ...(guest ? {} : { Cookie: cookie }),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ roomId: "demo-philosophy" }) },
    );
  for (const [handler, method] of [
    [tokenRoute.POST, "POST"],
    [tokenRoute.DELETE, "DELETE"],
    [syncRoute.POST, "POST"],
  ] as const) {
    const response = await call(handler, method, {}, true);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(
      (await call(handler, method, {}, false, "https://untrusted.test")).status,
      403,
    );
    assert.equal((await call(handler, method, { role: "HOST" })).status, 400);
  }
  const missing = await call(tokenRoute.POST, "POST", {
    clientId: randomUUID(),
    reservationId: randomUUID(),
  });
  assert.equal(missing.status, 409);
  const failure = await roomApiFailure(
    new Error("sensitive upstream detail"),
  ).json();
  assert.equal(failure.code, "TEMPORARILY_UNAVAILABLE");
  assert.ok(!JSON.stringify(failure).includes("sensitive"));
});

test("Cloud-only configuration fails closed; no secret goes in the safe error", () => {
  for (const url of [
    "",
    "wss://localhost:7880",
    "https://synthetic.livekit.cloud",
    "wss://synthetic.livekit.cloud/path",
    "wss://synthetic.livekit.cloud?key=x",
  ]) {
    assert.throws(
      () => liveKitConfiguration({ ...process.env, LIVEKIT_URL: url }),
      denied("LIVEKIT_NOT_CONFIGURED"),
    );
  }
  assert.throws(
    () => liveKitConfiguration({ ...process.env, LIVEKIT_API_SECRET: "" }),
    denied("LIVEKIT_NOT_CONFIGURED"),
  );
});

test("an expired issued grant stays counted, cannot renew, and cannot use SQL-only cancel or takeover", async () => {
  const f = await fixture();
  await f.media.issue(actor, f.roomId, f.input);
  await db.roomMember.update({
    where: where(f.roomId),
    data: { seatExpiresAt: new Date(0), mediaTokenExpiresAt: new Date(0) },
  });
  const state = await getSeatStatus(f.roomId, actor.userId, {
    clientId: f.input.clientId,
  });
  assert.equal(state.occupied, 1);
  assert.equal(state.mediaHeld, true);
  assert.ok(state.reservation);
  await assert.rejects(
    f.media.issue(actor, f.roomId, f.input),
    denied("TOKEN_WINDOW_EXPIRED"),
  );
  await assert.rejects(
    releaseSeat(f.roomId, actor.userId, f.input),
    denied("MEDIA_SESSION_ACTIVE"),
  );
  await assert.rejects(
    reserveSeat(f.roomId, actor.userId, {
      clientId: randomUUID(),
      previousReservationId: f.input.reservationId,
    }),
    denied("MEDIA_SESSION_ACTIVE"),
  );
  assert.equal(f.state.signed, 1);
});

test("takeover revokes before new identity and stale release cannot touch the replacement", async () => {
  const f = await fixture();
  const old = await f.media.issue(actor, f.roomId, f.input);
  f.state.present = [old.identity];
  await f.media.sync(actor, f.roomId);
  await db.room.update({
    where: { id: f.roomId },
    data: { focusedUserId: actor.userId },
  });
  const newClient = randomUUID();
  const replacement = await f.media.issue(actor, f.roomId, {
    ...f.input,
    clientId: newClient,
    takeover: true,
  });
  assert.deepEqual(f.state.revoked, [old.identity]);
  assert.notEqual(replacement.identity, old.identity);
  assert.notEqual(replacement.reservationId, old.reservationId);
  assert.equal(
    (await f.media.release(actor, f.roomId, f.input)).released,
    false,
  );
  await assert.rejects(
    f.media.issue(actor, f.roomId, f.input),
    denied("SEAT_CHANGED"),
  );
  assert.equal(
    (await getSeatStatus(f.roomId, actor.userId, { clientId: newClient }))
      .occupied,
    1,
  );
  assert.equal(
    (await db.room.findUniqueOrThrow({ where: { id: f.roomId } }))
      .focusedUserId,
    null,
  );
  assert.equal(
    (
      await f.media.release(actor, f.roomId, {
        clientId: newClient,
        reservationId: replacement.reservationId,
      })
    ).released,
    true,
  );
  assert.equal(
    (await getSeatStatus(f.roomId, actor.userId, { clientId: newClient }))
      .occupied,
    0,
  );
});

test("revocation failure retains the seat and blocks signing until retry succeeds", async () => {
  const f = await fixture();
  const grant = await f.media.issue(actor, f.roomId, f.input);
  f.state.failRevoke = true;
  const takeover = { ...f.input, clientId: randomUUID(), takeover: true };
  await assert.rejects(
    f.media.issue(actor, f.roomId, takeover),
    /synthetic network/,
  );
  assert.equal(f.state.signed, 1);
  assert.equal(
    (
      await getSeatStatus(f.roomId, actor.userId, {
        clientId: f.input.clientId,
      })
    ).occupied,
    1,
  );
  assert.equal(
    (await db.roomMember.findUniqueOrThrow({ where: where(f.roomId) }))
      .mediaIdentity,
    grant.identity,
  );
  await assert.rejects(
    f.media.issue(actor, f.roomId, f.input),
    denied("MEDIA_REMOVAL_PENDING"),
  );
  await assert.rejects(
    f.media.release(actor, f.roomId, f.input),
    /synthetic network/,
  );
  f.state.failRevoke = false;
  const next = await f.media.issue(actor, f.roomId, takeover);
  assert.notEqual(next.identity, grant.identity);
});

test("Cloud setup failure retains a recoverable hold and returns no token", async () => {
  const f = await fixture();
  f.gateway.prepareRoom = async () => {
    throw new Error("synthetic setup failure");
  };
  await assert.rejects(
    f.media.issue(actor, f.roomId, f.input),
    /synthetic setup/,
  );
  assert.equal(f.state.signed, 0);
  assert.equal(
    (
      await getSeatStatus(f.roomId, actor.userId, {
        clientId: f.input.clientId,
      })
    ).mediaHeld,
    true,
  );
  assert.equal(
    (await f.media.release(actor, f.roomId, f.input)).released,
    true,
  );
});

test("final SQL recheck rejects closure, kicking or logout during Cloud I/O", async () => {
  for (const scenario of ["close", "kick", "logout"] as const) {
    const f = await fixture();
    const session = await db.session.create({
      data: {
        id: randomUUID(),
        token: randomUUID(),
        userId: actor.userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const currentActor = { ...actor, sessionId: session.id };
    f.gateway.prepareRoom = async () => {
      if (scenario === "close")
        await db.room.update({
          where: { id: f.roomId },
          data: { status: "ENDING" },
        });
      if (scenario === "kick")
        await db.roomMember.update({
          where: where(f.roomId),
          data: { status: "KICKED" },
        });
      if (scenario === "logout")
        await db.session.delete({ where: { id: session.id } });
    };
    await assert.rejects(
      f.media.issue(currentActor, f.roomId, f.input),
      denied(
        {
          close: "ROOM_CLOSED",
          kick: "MEMBERSHIP_REQUIRED",
          logout: "SIGN_IN_REQUIRED",
        }[scenario],
      ),
    );
    assert.equal(f.state.signed, 0);
  }
});

test("a late issuance response cannot sign after another page takes over", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let calls = 0;
  f.gateway.prepareRoom = async () => {
    if (++calls === 1) {
      entered.resolve();
      await resume.promise;
    }
  };
  const late = f.media.issue(actor, f.roomId, f.input);
  const deniedLate = assert.rejects(late, denied("SEAT_CHANGED"));
  await entered.promise;
  try {
    await f.media.issue(actor, f.roomId, {
      ...f.input,
      clientId: randomUUID(),
      takeover: true,
    });
  } finally {
    resume.resolve();
  }
  await deniedLate;
  assert.equal(f.state.signed, 1);
});

test("Cloud presence activates; absence gets a grace period then revocation before clearing", async () => {
  const f = await fixture();
  const grant = await f.media.issue(actor, f.roomId, f.input);
  f.state.present = [grant.identity];
  await f.media.sync(actor, f.roomId);
  assert.equal(
    (await db.roomMember.findUniqueOrThrow({ where: where(f.roomId) })).status,
    "ACTIVE",
  );
  f.state.present = [];
  await db.roomMember.update({
    where: where(f.roomId),
    data: { mediaTokenExpiresAt: new Date(0) },
  });
  await f.media.sync(actor, f.roomId);
  assert.equal(
    f.state.revoked.length,
    0,
    "First absence preserves reconnect grace",
  );
  await db.roomMember.update({
    where: where(f.roomId),
    data: { mediaAbsentSince: new Date(Date.now() - 31_000) },
  });
  f.state.failRevoke = true;
  await assert.rejects(f.media.sync(actor, f.roomId), /synthetic network/);
  assert.equal(
    (
      await getSeatStatus(f.roomId, actor.userId, {
        clientId: f.input.clientId,
      })
    ).occupied,
    1,
  );
  f.state.failRevoke = false;
  await f.media.sync(actor, f.roomId);
  const member = await db.roomMember.findUniqueOrThrow({
    where: where(f.roomId),
  });
  assert.equal(member.status, "LEFT");
  assert.equal(member.mediaIdentity, null);
  assert.equal(member.seatReservationId, null);
  assert.deepEqual(f.state.revoked, [grant.identity]);
});

test("expired/kicked issued identities still block a ninth seat until Cloud cleanup", async () => {
  const f = await fixture();
  const people = [];
  for (let i = 0; i < 8; i++) {
    const id = randomUUID();
    await db.user.create({
      data: { id, name: "Capacity test", email: `${id}@guide.test` },
    });
    await db.roomMember.create({
      data: {
        roomId: f.roomId,
        userId: id,
        ...(i < 7
          ? {
              status: "KICKED",
              mediaIdentity: `p-${randomUUID()}`,
              mediaTokenExpiresAt: new Date(0),
              mediaAbsentSince: new Date(0),
            }
          : {}),
      },
    });
    people.push(id);
  }
  await assert.rejects(
    reserveSeat(f.roomId, people[7], {
      clientId: randomUUID(),
      previousReservationId: null,
    }),
    denied("ROOM_FULL"),
  );
  await f.media.sync(actor, f.roomId);
  assert.equal(f.state.revoked.length, 7);
  assert.equal(
    await db.roomMember.count({
      where: { roomId: f.roomId, status: "KICKED" },
    }),
    7,
    "Cleanup never restores kicked membership",
  );
  const seat = await reserveSeat(f.roomId, people[7], {
    clientId: randomUUID(),
    previousReservationId: null,
  });
  assert.equal(seat.occupied, 2);
});
