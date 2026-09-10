import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MediaGateway } from "../src/lib/livekit";
import type { SummaryProvider } from "../src/lib/deepseek";

const directory = resolve(
  ".tmp",
  `delivery-smoke-${randomBytes(8).toString("hex")}`,
);
const databasePath = join(directory, "delivery.db");
mkdirSync(directory, { recursive: true });
process.env.DATABASE_URL = `file:${databasePath.replaceAll("\\", "/")}`;
process.env.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
process.env.BETTER_AUTH_URL = "http://localhost:3000";

function initializeDatabase() {
  const sql = new DatabaseSync(databasePath);
  sql.exec("PRAGMA foreign_keys = ON");
  for (const entry of readdirSync(resolve("prisma/migrations"), {
    withFileTypes: true,
  })
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    sql.exec(
      readFileSync(
        resolve("prisma/migrations", entry.name, "migration.sql"),
        "utf8",
      ),
    );
  }
  sql.close();
}

initializeDatabase();

const { auth } = await import("../src/lib/auth");
const { db } = await import("../src/lib/db");
const { demoPassword, seedDemo } = await import("../prisma/seed");
const { POST: createRoom } = await import("../src/app/api/rooms/route");
const {
  createInvitation,
  hashInvitation,
  submitJoinRequest,
  verifyInvitation,
} = await import("../src/lib/invitations");
const { reviewJoinRequest, setMemberRole } =
  await import("../src/lib/room-review");
const { reserveSeat } = await import("../src/lib/room-seats");
const { createRoomMedia } = await import("../src/lib/room-media");
const {
  endRoom,
  getCollaborationSnapshot,
  kickRoomMember,
  sendChatMessage,
  setHandRaised,
  setRoomFocus,
} = await import("../src/lib/room-collaboration");
const { generateRoomSummary, getRoomSummary } =
  await import("../src/lib/room-summary");
const { RoomApiError } = await import("../src/lib/room-api");

type Actor = { userId: string; sessionId: string; cookie: string };

async function actorFrom(response: Response): Promise<Actor> {
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  const cookie = setCookie.split(";")[0]!;
  const session = await auth.api.getSession({
    headers: new Headers({ Cookie: cookie }),
  });
  assert.ok(session);
  return {
    userId: session.user.id,
    sessionId: session.session.id,
    cookie,
  };
}

async function register(name: string, email: string): Promise<Actor> {
  return actorFrom(
    await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({ name, email, password: demoPassword }),
      }),
    ),
  );
}

async function signIn(email: string): Promise<Actor> {
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ email, password: demoPassword }),
    }),
  );
  return actorFrom(response);
}

function denied(code: string) {
  return (error: unknown) =>
    error instanceof RoomApiError && error.code === code;
}

function fakeMedia() {
  const state = {
    prepared: 0,
    signed: 0,
    broadcasts: 0,
    revoked: [] as string[],
    closed: 0,
    present: new Set<string>(),
  };
  const gateway: MediaGateway = {
    url: "wss://synthetic.livekit.cloud",
    async prepareRoom() {
      state.prepared += 1;
    },
    async sign() {
      state.signed += 1;
      return "synthetic-room-token";
    },
    async participants() {
      return [...state.present];
    },
    async revoke(_roomName, identity) {
      state.revoked.push(identity);
      state.present.delete(identity);
    },
    async broadcast() {
      state.broadcasts += 1;
    },
    async close() {
      state.closed += 1;
      state.present.clear();
    },
  };
  return { gateway, state };
}

const provider: SummaryProvider = {
  model: "offline-delivery-fake",
  async generate(source) {
    assert.match(source.transcript, /Durable chat/);
    assert.match(source.transcript, /focus state/);
    return {
      content:
        "Decisions\nPersist chat before signaling.\n\nOpen questions\nNone recorded.\n\nNext study actions\nReview the permission matrix.",
      model: "offline-delivery-fake",
      promptTokens: 120,
      completionTokens: 42,
    };
  },
};

let completed = false;

try {
  await seedDemo();
  const host = await register(
    "Delivery Host",
    `delivery-host-${randomBytes(4).toString("hex")}@guide.test`,
  );
  const participant = await signIn("morgan@guide.test");

  const roomResponse = await createRoom(
    new Request("http://localhost:3000/api/rooms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
        Cookie: host.cookie,
      },
      body: JSON.stringify({
        title: "Offline delivery smoke",
        description: "Synthetic end-to-end verification room",
        topic: "PHILOSOPHY",
      }),
    }),
  );
  assert.equal(roomResponse.status, 201);
  const { id: roomId } = (await roomResponse.json()) as { id: string };

  const invitation = await createInvitation(roomId, host.userId, {
    expiresInMinutes: 15,
  });
  const application = await submitJoinRequest(roomId, participant.userId, {
    code: invitation.code,
  });
  await reviewJoinRequest(roomId, host.userId, application.request.id, {
    decision: "APPROVE",
  });
  await setMemberRole(roomId, host.userId, participant.userId, {
    role: "MODERATOR",
  });

  const rejectedInvitation = await createInvitation(roomId, host.userId, {
    expiresInMinutes: 15,
  });
  const rejected = await submitJoinRequest(roomId, "demo-taylor", {
    code: rejectedInvitation.code,
  });
  await reviewJoinRequest(roomId, host.userId, rejected.request.id, {
    decision: "REJECT",
  });
  assert.equal(
    await db.roomMember.count({
      where: { roomId, userId: "demo-taylor" },
    }),
    0,
  );

  const expiredCode = randomBytes(32).toString("base64url");
  await db.invitation.create({
    data: {
      roomId,
      codeHash: hashInvitation(expiredCode),
      expiresAt: new Date(Date.now() - 1_000),
    },
  });
  await assert.rejects(
    verifyInvitation(roomId, { code: expiredCode }),
    denied("INVITATION_EXPIRED"),
  );

  const extraUsers = Array.from({ length: 7 }, (_, index) => ({
    id: `delivery-extra-${index}`,
    name: `Delivery Extra ${index}`,
    email: `delivery-extra-${index}@guide.test`,
  }));
  await db.user.createMany({ data: extraUsers });
  await db.roomMember.createMany({
    data: extraUsers.map((user) => ({ roomId, userId: user.id })),
  });

  const hostClientId = randomUUID();
  const participantClientId = randomUUID();
  const hostSeat = await reserveSeat(roomId, host.userId, {
    clientId: hostClientId,
    previousReservationId: null,
  });
  const participantSeat = await reserveSeat(roomId, participant.userId, {
    clientId: participantClientId,
    previousReservationId: null,
  });
  for (const user of extraUsers.slice(0, 6)) {
    await reserveSeat(roomId, user.id, {
      clientId: randomUUID(),
      previousReservationId: null,
    });
  }
  await assert.rejects(
    reserveSeat(roomId, extraUsers[6]!.id, {
      clientId: randomUUID(),
      previousReservationId: null,
    }),
    denied("ROOM_FULL"),
  );

  const media = fakeMedia();
  const roomMedia = createRoomMedia(media.gateway);
  const hostGrant = await roomMedia.issue(host, roomId, {
    clientId: hostClientId,
    reservationId: hostSeat.reservation!.id,
    takeover: false,
  });
  const participantGrant = await roomMedia.issue(participant, roomId, {
    clientId: participantClientId,
    reservationId: participantSeat.reservation!.id,
    takeover: false,
  });
  media.state.present.add(hostGrant.identity);
  media.state.present.add(participantGrant.identity);
  await roomMedia.sync(host, roomId);
  assert.equal(media.state.signed, 2);

  await sendChatMessage(media.gateway, roomId, host.userId, {
    body: "Decision: Durable chat is the source of truth.",
  });
  await sendChatMessage(media.gateway, roomId, participant.userId, {
    body: "Open question: how should focus state recover after sharing?",
  });
  await setHandRaised(media.gateway, roomId, participant.userId, {
    raised: true,
  });
  await setRoomFocus(media.gateway, roomId, participant.userId, {
    targetUserId: host.userId,
  });
  const snapshot = await getCollaborationSnapshot(roomId, host.userId);
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.focusedUserId, host.userId);

  const kickedTarget = extraUsers[0]!;
  await db.roomMember.update({
    where: { roomId_userId: { roomId, userId: kickedTarget.id } },
    data: {
      status: "ACTIVE",
      mediaIdentity: "synthetic-kick-target",
      mediaTokenExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  await kickRoomMember(
    media.gateway,
    roomId,
    participant.userId,
    kickedTarget.id,
  );
  assert.equal(
    (
      await db.roomMember.findUniqueOrThrow({
        where: { roomId_userId: { roomId, userId: kickedTarget.id } },
      })
    ).status,
    "KICKED",
  );

  assert.equal(
    (
      await roomMedia.release(participant, roomId, {
        clientId: participantClientId,
        reservationId: participantGrant.reservationId,
      })
    ).released,
    true,
  );

  await endRoom(media.gateway, roomId, host.userId);
  await assert.rejects(
    sendChatMessage(media.gateway, roomId, participant.userId, {
      body: "This must not be saved after ending.",
    }),
    denied("ROOM_CLOSED"),
  );
  const summary = await generateRoomSummary(provider, roomId, host.userId);
  assert.equal(summary.status, "READY");
  assert.equal(summary.sourceMessageCount, 2);
  assert.equal(
    (await getRoomSummary(roomId, participant.userId)).status,
    "READY",
  );
  assert.equal(media.state.closed, 1);
  assert.ok(media.state.revoked.includes("synthetic-kick-target"));
  completed = true;
} finally {
  await db.$disconnect();
  assert.ok(directory.startsWith(resolve(".tmp") + sep));
  rmSync(directory, { recursive: true, force: true });
}

if (completed) {
  console.log(
    "Offline delivery smoke passed: registration/auth -> room -> invite/request/review -> 8-seat/token -> chat/roles -> kick/leave/end -> persisted fake summary. Temporary SQLite removed; no Cloud or LLM calls.",
  );
}
