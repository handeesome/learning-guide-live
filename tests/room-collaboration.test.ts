import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MediaGateway } from "../src/lib/livekit";
import { canRemoveCollaborationMember } from "../src/lib/collaboration-input";

const directory = resolve(
  ".tmp",
  `collaboration-${randomBytes(8).toString("hex")}`,
);
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
  .sort((left, right) => left.name.localeCompare(right.name))) {
  sql.exec(
    readFileSync(
      resolve("prisma/migrations", entry.name, "migration.sql"),
      "utf8",
    ),
  );
}
sql.close();

const { db } = await import("../src/lib/db");
const { seedDemo } = await import("../prisma/seed");
const {
  endRoom,
  getCollaborationSnapshot,
  kickRoomMember,
  sendChatMessage,
  setHandRaised,
  setRoomFocus,
} = await import("../src/lib/room-collaboration");
const { RoomApiError } = await import("../src/lib/room-api");

before(seedDemo);
after(async () => {
  await db.$disconnect();
  assert.ok(directory.startsWith(resolve(".tmp") + sep));
  rmSync(directory, { recursive: true, force: true });
});

const denied = (code: string) => (error: unknown) =>
  error instanceof RoomApiError && error.code === code;

function fakeCloud() {
  const state = {
    broadcasts: [] as string[],
    revoked: [] as string[],
    closed: 0,
    failBroadcast: false,
    failRevoke: false,
    failClose: false,
  };
  const gateway: MediaGateway = {
    url: "wss://synthetic.livekit.cloud",
    async prepareRoom() {},
    async sign() {
      return "synthetic";
    },
    async participants() {
      return [];
    },
    async revoke(_room, identity) {
      if (state.failRevoke) throw new Error("synthetic revoke failure");
      state.revoked.push(identity);
    },
    async broadcast(_room, payload) {
      if (state.failBroadcast) throw new Error("synthetic broadcast failure");
      state.broadcasts.push(new TextDecoder().decode(payload));
    },
    async close() {
      if (state.failClose) throw new Error("synthetic close failure");
      state.closed++;
    },
  };
  return { state, gateway };
}

async function fixture() {
  const roomId = `collaboration-${randomUUID()}`;
  await db.room.create({
    data: {
      id: roomId,
      title: "Collaboration test",
      description: "Synthetic state and permission checks",
      topic: "PHILOSOPHY",
      hostId: "demo-alex",
      members: {
        create: [
          {
            userId: "demo-alex",
            role: "HOST",
            status: "ACTIVE",
            mediaIdentity: "media-alex",
            mediaTokenExpiresAt: new Date(Date.now() + 60_000),
            seatOwnerId: "page-alex",
            seatReservationId: "seat-alex",
          },
          {
            userId: "demo-morgan",
            role: "MODERATOR",
            status: "ACTIVE",
            mediaIdentity: "media-morgan",
            mediaTokenExpiresAt: new Date(Date.now() + 60_000),
            seatOwnerId: "page-morgan",
            seatReservationId: "seat-morgan",
          },
          {
            userId: "demo-taylor",
            role: "PARTICIPANT",
            status: "ACTIVE",
            mediaIdentity: "media-taylor",
            mediaTokenExpiresAt: new Date(Date.now() + 60_000),
            seatOwnerId: "page-taylor",
            seatReservationId: "seat-taylor",
          },
        ],
      },
    },
  });
  return { roomId, ...fakeCloud() };
}

test("chat is authorized by ACTIVE SQL membership and persists before broadcast", async () => {
  const f = await fixture();
  f.state.failBroadcast = true;
  const result = await sendChatMessage(f.gateway, f.roomId, "demo-taylor", {
    body: "  A persisted question  ",
  });
  assert.equal(result.message.body, "A persisted question");
  assert.equal(result.broadcast, false);
  assert.equal(await db.chatMessage.count({ where: { roomId: f.roomId } }), 1);
  const snapshot = await getCollaborationSnapshot(f.roomId, "demo-morgan");
  assert.equal(snapshot.messages[0]?.id, result.message.id);
  assert.equal(snapshot.members[2]?.mediaIdentity, "media-taylor");
  await db.roomMember.update({
    where: {
      roomId_userId: { roomId: f.roomId, userId: "demo-taylor" },
    },
    data: { status: "LEFT" },
  });
  await assert.rejects(
    sendChatMessage(f.gateway, f.roomId, "demo-taylor", { body: "No" }),
    denied("ACTIVE_MEMBER_REQUIRED"),
  );
});

test("hand state allows self service and moderator lowering, never peer control", async () => {
  const f = await fixture();
  const raised = await setHandRaised(f.gateway, f.roomId, "demo-taylor", {
    raised: true,
  });
  assert.equal(raised.raised, true);
  await assert.rejects(
    setHandRaised(f.gateway, f.roomId, "demo-taylor", {
      raised: false,
      targetUserId: "demo-morgan",
    }),
    denied("HAND_ACTION_FORBIDDEN"),
  );
  const lowered = await setHandRaised(f.gateway, f.roomId, "demo-morgan", {
    raised: false,
    targetUserId: "demo-taylor",
  });
  assert.equal(lowered.raised, false);
  assert.equal(f.state.broadcasts.length, 2);
});

test("focus is moderator controlled and rejects departed targets", async () => {
  const f = await fixture();
  await assert.rejects(
    setRoomFocus(f.gateway, f.roomId, "demo-taylor", {
      targetUserId: "demo-morgan",
    }),
    denied("FOCUS_ACTION_FORBIDDEN"),
  );
  const focused = await setRoomFocus(f.gateway, f.roomId, "demo-morgan", {
    targetUserId: "demo-taylor",
  });
  assert.equal(focused.focusedUserId, "demo-taylor");
  await db.roomMember.update({
    where: {
      roomId_userId: { roomId: f.roomId, userId: "demo-taylor" },
    },
    data: { status: "LEFT" },
  });
  await assert.rejects(
    setRoomFocus(f.gateway, f.roomId, "demo-morgan", {
      targetUserId: "demo-taylor",
    }),
    denied("FOCUS_ACTION_FORBIDDEN"),
  );
  const snapshot = await getCollaborationSnapshot(f.roomId, "demo-alex");
  assert.equal(snapshot.focusedUserId, null);
});

test("kick blocks SQL access before Cloud removal and retries the exact identity", async () => {
  const f = await fixture();
  f.state.failRevoke = true;
  await assert.rejects(
    kickRoomMember(f.gateway, f.roomId, "demo-morgan", "demo-taylor"),
    denied("MEDIA_REMOVAL_PENDING"),
  );
  let target = await db.roomMember.findUniqueOrThrow({
    where: {
      roomId_userId: { roomId: f.roomId, userId: "demo-taylor" },
    },
  });
  assert.equal(target.status, "KICKED");
  assert.equal(target.mediaIdentity, "media-taylor");
  assert.equal(target.mediaRevoking, true);
  const retryView = await getCollaborationSnapshot(f.roomId, "demo-morgan");
  const pendingTarget = retryView.members.find(
    (member) => member.userId === "demo-taylor",
  );
  assert.ok(
    pendingTarget,
    "failed removal must remain visible to its moderator",
  );
  assert.equal(pendingTarget.mediaRemovalPending, true);
  assert.equal(canRemoveCollaborationMember(retryView, pendingTarget), true);
  await assert.rejects(
    getCollaborationSnapshot(f.roomId, "demo-taylor"),
    denied("MEMBERSHIP_REQUIRED"),
  );
  f.state.failRevoke = false;
  await kickRoomMember(f.gateway, f.roomId, "demo-morgan", "demo-taylor");
  target = await db.roomMember.findUniqueOrThrow({
    where: {
      roomId_userId: { roomId: f.roomId, userId: "demo-taylor" },
    },
  });
  assert.equal(target.mediaIdentity, null);
  assert.deepEqual(f.state.revoked, ["media-taylor"]);
  assert.ok(
    !(await getCollaborationSnapshot(f.roomId, "demo-morgan")).members.some(
      (member) => member.userId === "demo-taylor",
    ),
  );
  const retry = await kickRoomMember(
    f.gateway,
    f.roomId,
    "demo-morgan",
    "demo-taylor",
  );
  assert.equal(retry.changed, false);
  assert.deepEqual(f.state.revoked, ["media-taylor"]);
});

test("moderator cannot remove another moderator, while host can", async () => {
  const f = await fixture();
  await assert.rejects(
    kickRoomMember(f.gateway, f.roomId, "demo-morgan", "demo-alex"),
    denied("KICK_FORBIDDEN"),
  );
  await assert.rejects(
    kickRoomMember(f.gateway, f.roomId, "demo-taylor", "demo-morgan"),
    denied("KICK_FORBIDDEN"),
  );
  const result = await kickRoomMember(
    f.gateway,
    f.roomId,
    "demo-alex",
    "demo-morgan",
  );
  assert.equal(result.changed, true);
  assert.deepEqual(f.state.revoked, ["media-morgan"]);
});

test("pending moderator removals are visible only to an active host who may retry", async () => {
  const f = await fixture();
  f.state.failRevoke = true;
  await assert.rejects(
    kickRoomMember(f.gateway, f.roomId, "demo-alex", "demo-morgan"),
    denied("MEDIA_REMOVAL_PENDING"),
  );
  const host = await getCollaborationSnapshot(f.roomId, "demo-alex");
  const pending = host.members.find(
    (member) => member.userId === "demo-morgan",
  );
  assert.ok(pending);
  assert.equal(canRemoveCollaborationMember(host, pending), true);
  const participant = await getCollaborationSnapshot(f.roomId, "demo-taylor");
  assert.ok(
    !participant.members.some((member) => member.userId === "demo-morgan"),
  );
  assert.equal(canRemoveCollaborationMember(participant, pending), false);
  await db.roomMember.update({
    where: { roomId_userId: { roomId: f.roomId, userId: "demo-taylor" } },
    data: { role: "MODERATOR" },
  });
  const peer = await getCollaborationSnapshot(f.roomId, "demo-taylor");
  assert.ok(!peer.members.some((member) => member.userId === "demo-morgan"));
  assert.equal(canRemoveCollaborationMember(peer, pending), false);
  await assert.rejects(
    kickRoomMember(f.gateway, f.roomId, "demo-taylor", "demo-morgan"),
    denied("KICK_FORBIDDEN"),
  );
});

test("end remains ENDING on teardown failure and retries to durable ENDED", async () => {
  const f = await fixture();
  await db.roomMember.update({
    where: {
      roomId_userId: { roomId: f.roomId, userId: "demo-alex" },
    },
    data: { status: "LEFT" },
  });
  f.state.failClose = true;
  await assert.rejects(
    endRoom(f.gateway, f.roomId, "demo-alex"),
    denied("ROOM_ENDING_PENDING"),
  );
  assert.equal(
    (await db.room.findUniqueOrThrow({ where: { id: f.roomId } })).status,
    "ENDING",
  );
  await assert.rejects(
    sendChatMessage(f.gateway, f.roomId, "demo-morgan", { body: "Too late" }),
    denied("ROOM_CLOSED"),
  );
  f.state.failClose = false;
  const ended = await endRoom(f.gateway, f.roomId, "demo-alex");
  assert.equal(ended.status, "ENDED");
  const room = await db.room.findUniqueOrThrow({ where: { id: f.roomId } });
  assert.equal(room.status, "ENDED");
  assert.ok(room.endedAt);
  const members = await db.roomMember.findMany({ where: { roomId: f.roomId } });
  assert.ok(members.every((member) => member.mediaIdentity === null));
  assert.ok(
    members
      .filter((member) => member.status !== "KICKED")
      .every((member) => member.status === "LEFT"),
  );
});
