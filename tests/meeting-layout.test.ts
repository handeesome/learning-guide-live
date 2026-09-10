import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMeetingLayout } from "../src/lib/meeting-layout";

test("screen sharing owns the primary region ahead of a selected focus", () => {
  assert.deepEqual(
    selectMeetingLayout({
      screenShareIdentities: ["participant-b"],
      focusedIdentity: "participant-a",
      participantIdentities: ["participant-a", "participant-b"],
    }),
    { mode: "screen-share", primaryIdentity: "participant-b" },
  );
});

test("stopping a share restores a valid focus, then the gallery", () => {
  const participants = ["participant-a", "participant-b"];
  assert.deepEqual(
    selectMeetingLayout({
      screenShareIdentities: [],
      focusedIdentity: "participant-a",
      participantIdentities: participants,
    }),
    { mode: "focus", primaryIdentity: "participant-a" },
  );
  assert.deepEqual(
    selectMeetingLayout({
      screenShareIdentities: [],
      focusedIdentity: "departed",
      participantIdentities: participants,
    }),
    { mode: "gallery", primaryIdentity: null },
  );
});

test("an unexpected simultaneous-share race has one stable primary track", () => {
  const input = {
    focusedIdentity: null,
    participantIdentities: ["participant-a", "participant-b"],
  };
  assert.deepEqual(
    selectMeetingLayout({
      ...input,
      screenShareIdentities: ["participant-b", "participant-a"],
    }),
    selectMeetingLayout({
      ...input,
      screenShareIdentities: ["participant-a", "participant-b"],
    }),
  );
});
