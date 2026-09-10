import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canReadRoomHistory,
  canPerformRoomAction,
  canTransitionRoom,
  roomRole,
  type RoomPolicyContext,
  type RoomAction,
  type RoomPolicyMember,
} from "../src/lib/room-policy";
import type {
  MemberRole,
  MemberStatus,
  RoomStatus,
} from "../src/generated/prisma/enums";

function context(
  role: MemberRole = "PARTICIPANT",
  status: MemberStatus = "ACTIVE",
  roomStatus: RoomStatus = "OPEN",
): RoomPolicyContext {
  const userId = role === "HOST" ? "host" : "viewer";
  return {
    room: { id: "room-a", hostId: "host", status: roomStatus },
    userId,
    member: { roomId: "room-a", userId, role, status },
  };
}

test("history is available to genuine members across the room lifecycle", () => {
  for (const role of ["HOST", "MODERATOR", "PARTICIPANT"] as const) {
    for (const status of ["APPROVED", "ACTIVE", "LEFT"] as const) {
      for (const state of ["OPEN", "ENDING", "ENDED"] as const) {
        assert.equal(roomRole(context(role, status, state)), role);
        assert.equal(canReadRoomHistory(context(role, status, state)), true);
      }
    }
  }
});

test("guests, nonmembers and kicked members cannot read room history", () => {
  const member = context();
  assert.equal(canReadRoomHistory({ ...member, userId: null }), false);
  assert.equal(canReadRoomHistory({ ...member, member: null }), false);
  for (const role of ["HOST", "MODERATOR", "PARTICIPANT"] as const) {
    assert.equal(canReadRoomHistory(context(role, "KICKED")), false);
  }
});

test("membership must match both the authenticated user and requested room", () => {
  const member = context();
  assert.ok(member.member);
  for (const invalid of [
    { ...member.member, userId: "somebody-else" },
    { ...member.member, roomId: "another-room" },
    { ...member.member, role: "HOST" as const },
  ]) {
    assert.equal(roomRole({ ...member, member: invalid }), null);
    assert.equal(canReadRoomHistory({ ...member, member: invalid }), false);
  }
  const host = context("HOST");
  assert.ok(host.member);
  assert.equal(
    roomRole({ ...host, member: { ...host.member, role: "PARTICIPANT" } }),
    null,
  );
});

test("room lifecycle has only two forward edges and cannot skip media teardown", () => {
  const states = ["OPEN", "ENDING", "ENDED"] as const;
  for (const from of states) {
    for (const to of states) {
      assert.equal(
        canTransitionRoom(from, to),
        (from === "OPEN" && to === "ENDING") ||
          (from === "ENDING" && to === "ENDED"),
        `${from} -> ${to}`,
      );
    }
  }
});

const participant: RoomPolicyMember = {
  roomId: "room-a",
  userId: "target",
  role: "PARTICIPANT",
  status: "ACTIVE",
};
const allCommands: RoomAction[] = [
  { action: "create_invitation" },
  { action: "review_requests" },
  { action: "end_room" },
  { action: "generate_summary" },
  { action: "send_chat" },
  { action: "raise_hand" },
  { action: "clear_focus" },
  { action: "set_moderator", target: participant },
  { action: "lower_hand", target: participant },
  { action: "set_focus", target: participant },
  { action: "kick_member", target: participant },
];

test("open-room role matrix distinguishes ownership from in-meeting moderation", () => {
  const permitted: Record<MemberRole, RoomAction["action"][]> = {
    HOST: allCommands
      .map((command) => command.action)
      .filter((action) => action !== "generate_summary"),
    MODERATOR: [
      "send_chat",
      "raise_hand",
      "clear_focus",
      "lower_hand",
      "set_focus",
      "kick_member",
    ],
    PARTICIPANT: ["send_chat", "raise_hand"],
  };
  for (const role of ["HOST", "MODERATOR", "PARTICIPANT"] as const) {
    for (const command of allCommands) {
      assert.equal(
        canPerformRoomAction(context(role), command),
        permitted[role].includes(command.action),
        `${role}: ${command.action}`,
      );
    }
  }
});

test("ending permits only end retry, while ended permits only host summary generation", () => {
  for (const state of ["ENDING", "ENDED"] as const) {
    for (const role of ["HOST", "MODERATOR", "PARTICIPANT"] as const) {
      for (const command of allCommands) {
        assert.equal(
          canPerformRoomAction(context(role, "ACTIVE", state), command),
          role === "HOST" &&
            ((state === "ENDING" && command.action === "end_room") ||
              (state === "ENDED" && command.action === "generate_summary")),
          `${state}/${role}: ${command.action}`,
        );
      }
    }
  }
});

test("leaving does not end the room; host administration survives without live controls", () => {
  const administration = [
    "create_invitation",
    "review_requests",
    "set_moderator",
    "end_room",
  ];
  for (const status of ["APPROVED", "LEFT"] as const) {
    for (const role of ["HOST", "MODERATOR", "PARTICIPANT"] as const) {
      const actor = context(role, status);
      for (const command of allCommands) {
        assert.equal(
          canPerformRoomAction(actor, command),
          role === "HOST" && administration.includes(command.action),
          `${status}/${role}: ${command.action}`,
        );
      }
      assert.equal(actor.room.status, "OPEN");
    }
  }
});

test("unauthenticated, missing, mismatched and kicked memberships deny every command", () => {
  const actor = context("HOST");
  assert.ok(actor.member);
  const invalid: RoomPolicyContext[] = [
    { ...actor, userId: null },
    { ...actor, member: null },
    { ...actor, member: { ...actor.member, roomId: "other-room" } },
    { ...actor, member: { ...actor.member, userId: "other-user" } },
    { ...actor, member: { ...actor.member, role: "PARTICIPANT" } },
    context("HOST", "KICKED"),
    context("MODERATOR", "KICKED"),
    context("PARTICIPANT", "KICKED"),
  ];
  for (const entry of invalid) {
    for (const command of allCommands) {
      assert.equal(canPerformRoomAction(entry, command), false);
    }
  }
});

test("target rules protect ownership, peers, self and cross-room members", () => {
  const host = context("HOST");
  const moderator = context("MODERATOR");
  assert.ok(host.member);
  assert.ok(moderator.member);
  const otherModerator: RoomPolicyMember = {
    ...participant,
    role: "MODERATOR",
  };
  assert.equal(
    canPerformRoomAction(host, {
      action: "kick_member",
      target: otherModerator,
    }),
    true,
  );
  assert.equal(
    canPerformRoomAction(moderator, {
      action: "kick_member",
      target: otherModerator,
    }),
    false,
  );
  for (const actor of [host, moderator]) {
    assert.equal(
      canPerformRoomAction(actor, {
        action: "kick_member",
        target: host.member,
      }),
      false,
    );
    assert.ok(actor.member);
    assert.equal(
      canPerformRoomAction(actor, {
        action: "kick_member",
        target: actor.member,
      }),
      false,
    );
    for (const action of [
      "set_moderator",
      "lower_hand",
      "set_focus",
      "kick_member",
    ] as const) {
      for (const target of [
        { ...participant, roomId: "other-room" },
        { ...participant, status: "KICKED" as const },
        { ...participant, role: "HOST" as const },
      ]) {
        assert.equal(canPerformRoomAction(actor, { action, target }), false);
      }
    }
  }
  assert.equal(
    canPerformRoomAction(host, {
      action: "set_moderator",
      target: host.member,
    }),
    false,
  );
  assert.equal(
    canPerformRoomAction(moderator, {
      action: "set_moderator",
      target: moderator.member,
    }),
    false,
  );
  for (const action of ["lower_hand", "set_focus", "kick_member"] as const) {
    assert.equal(
      canPerformRoomAction(host, {
        action,
        target: { ...participant, status: "LEFT" },
      }),
      false,
    );
  }
});
