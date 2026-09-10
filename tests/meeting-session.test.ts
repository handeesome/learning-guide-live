import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MeetingSession,
  MeetingRequestError,
  ownsMedia,
  type MeetingApi,
  type MeetingConnection,
} from "../src/lib/meeting-session";
import { deviceError } from "../src/lib/meeting-copy";
import type { SeatStatus } from "../src/lib/seat-input";
import type { MediaGrant } from "../src/lib/media-input";

function fixture() {
  let seat: SeatStatus = {
    capacity: 8,
    occupied: 0,
    available: 8,
    active: false,
    mediaHeld: false,
    serverTime: new Date().toISOString(),
    reservation: null,
  };
  const calls: string[] = [];
  const grant: MediaGrant = {
    token: "synthetic-not-a-real-token",
    serverUrl: "wss://synthetic.livekit.cloud",
    identity: "synthetic",
    roomName: "synthetic",
    reservationId: "reserved",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const api: MeetingApi = {
    async seat() {
      calls.push("seat");
      return structuredClone(seat);
    },
    async sync() {
      calls.push("sync");
    },
    async reserve() {
      calls.push("reserve");
      seat = {
        ...seat,
        occupied: 1,
        available: 7,
        reservation: {
          id: "reserved",
          ownedByThisPage: true,
          expiresAt: grant.expiresAt,
        },
      };
      return structuredClone(seat);
    },
    async issue(id, takeover) {
      calls.push(takeover ? "takeover" : "issue");
      grant.reservationId = takeover ? "replacement" : id;
      seat = {
        ...seat,
        mediaHeld: true,
        reservation: {
          id: grant.reservationId,
          ownedByThisPage: true,
          expiresAt: grant.expiresAt,
        },
      };
      return { ...grant };
    },
    async release(id) {
      calls.push(`release:${id}`);
    },
  };
  const connection: MeetingConnection = {
    async connect() {
      calls.push("connect");
    },
    async disconnect() {
      calls.push("disconnect");
    },
  };
  return {
    api,
    connection,
    calls,
    grant,
    session: new MeetingSession(api),
    get seat() {
      return structuredClone(seat);
    },
    set seat(value) {
      seat = value;
    },
  };
}
test("entry reconciles, reserves, gets a token, rechecks ownership and only then connects", async () => {
  const f = fixture();
  assert.equal(await f.session.join(f.connection, f.seat), true);
  assert.deepEqual(f.calls, [
    "sync",
    "seat",
    "reserve",
    "issue",
    "seat",
    "connect",
  ]);
  await f.session.stop(true);
  assert.deepEqual(f.calls.slice(-2), ["disconnect", "release:reserved"]);
  assert.equal(f.session.reservationId, null);
});
test("explicit takeover uses the displayed generation without claiming an extra seat", async () => {
  const f = fixture();
  f.seat = {
    ...f.seat,
    mediaHeld: true,
    reservation: {
      id: "old",
      ownedByThisPage: false,
      expiresAt: f.grant.expiresAt,
    },
  };
  assert.equal(await f.session.join(f.connection, f.seat), true);
  assert.ok(f.calls.includes("takeover"));
  assert.ok(!f.calls.includes("reserve"));
  assert.equal(f.session.reservationId, "replacement");
});
test("a different page generation appearing after the click cannot be taken over silently", async () => {
  const f = fixture();
  const observed = f.seat;
  f.seat = {
    ...observed,
    mediaHeld: true,
    reservation: {
      id: "unexpected",
      ownedByThisPage: false,
      expiresAt: f.grant.expiresAt,
    },
  };
  await assert.rejects(
    f.session.join(f.connection, observed),
    (error: unknown) =>
      error instanceof MeetingRequestError && error.code === "SEAT_CHANGED",
  );
  assert.deepEqual(f.calls, ["sync", "seat"]);
});
test("failed reconciliation cannot request credentials or connect", async () => {
  const f = fixture();
  f.api.sync = async () => {
    throw new Error("offline");
  };
  await assert.rejects(f.session.join(f.connection, f.seat), /offline/);
  assert.deepEqual(f.calls, []);
});
test("lost issue response retains known reservation for explicit release", async () => {
  const f = fixture();
  f.api.issue = async () => {
    throw new Error("lost response");
  };
  await assert.rejects(f.session.join(f.connection, f.seat), /lost response/);
  assert.equal(f.session.reservationId, "reserved");
  await f.session.stop(true);
  assert.ok(f.calls.includes("release:reserved"));
  assert.ok(!f.calls.includes("connect"));
});
test("late token after unmount is released, never connected", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<MediaGrant>();
  f.api.issue = async () => {
    entered.resolve();
    return resume.promise;
  };
  const joining = f.session.join(f.connection, f.seat);
  await entered.promise;
  await f.session.stop(false);
  resume.resolve(f.grant);
  assert.equal(await joining, false);
  assert.ok(f.calls.includes("release:reserved"));
  assert.ok(!f.calls.includes("connect"));
});
test("late successful SDK connect is disconnected after stop, never treated as joined", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.connection.connect = async () => {
    entered.resolve();
    await resume.promise;
  };
  const joining = f.session.join(f.connection, f.seat);
  await entered.promise;
  await f.session.stop(false);
  resume.resolve();
  assert.equal(await joining, false);
  assert.equal(f.calls.filter((call) => call === "disconnect").length, 2);
});
test("ownership loss between issuance and connect rejects the stale token", async () => {
  const f = fixture();
  const issue = f.api.issue;
  f.api.issue = async (...args) => {
    const grant = await issue(...args);
    f.seat = {
      ...f.seat,
      reservation: { ...f.seat.reservation!, ownedByThisPage: false },
    };
    return grant;
  };
  await assert.rejects(
    f.session.join(f.connection, f.seat),
    (error: unknown) =>
      error instanceof MeetingRequestError && error.code === "SEAT_CHANGED",
  );
  assert.ok(!f.calls.includes("connect"));
});
test("release failure stops local media first and retains retry information", async () => {
  const f = fixture();
  await f.session.join(f.connection, f.seat);
  f.api.release = async () => {
    assert.equal(f.calls.at(-1), "disconnect");
    throw new Error("Cloud unavailable");
  };
  await assert.rejects(f.session.stop(true), /Cloud unavailable/);
  assert.equal(f.session.reservationId, "reserved");
});
test("seat ownership and device errors have bounded, actionable semantics", () => {
  const f = fixture();
  assert.equal(ownsMedia(f.seat, "reserved"), false);
  for (const name of [
    "NotAllowedError",
    "NotFoundError",
    "NotReadableError",
    "OtherError",
  ]) {
    const error = new Error("private driver detail");
    error.name = name;
    const result = deviceError(error);
    assert.ok(result.length > 20);
    assert.ok(!result.includes("private driver"));
  }
});
