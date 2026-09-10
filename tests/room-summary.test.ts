import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SummaryGeneration,
  SummaryProvider,
  SummarySource,
} from "../src/lib/deepseek";

const directory = resolve(".tmp", `summary-${randomBytes(8).toString("hex")}`);
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
const { deepSeekProvider, SummaryProviderError } =
  await import("../src/lib/deepseek");
const { generateRoomSummary, getRoomSummary } =
  await import("../src/lib/room-summary");
const { RoomApiError } = await import("../src/lib/room-api");

before(seedDemo);
after(async () => {
  await db.$disconnect();
  assert.ok(directory.startsWith(resolve(".tmp") + sep));
  rmSync(directory, { recursive: true, force: true });
});

const denied = (code: string) => (error: unknown) =>
  error instanceof RoomApiError && error.code === code;

function fakeProvider() {
  const state = {
    calls: [] as SummarySource[],
    failure: null as Error | null,
    result: {
      content:
        "Decisions\nKeep durable chat.\n\nOpen questions\nNone.\n\nNext study actions\nReview the notes.",
      model: "synthetic-summary-model",
      promptTokens: 123,
      completionTokens: 45,
    } satisfies SummaryGeneration,
  };
  const provider: SummaryProvider = {
    model: "synthetic-summary-model",
    async generate(source) {
      state.calls.push(source);
      if (state.failure) throw state.failure;
      return state.result;
    },
  };
  return { state, provider };
}

async function fixture(withMessages = true) {
  const roomId = `summary-${randomUUID()}`;
  await db.room.create({
    data: {
      id: roomId,
      title: "Summary test discussion",
      description: "Synthetic post-session summary fixture",
      topic: "PHILOSOPHY",
      status: "ENDED",
      endedAt: new Date(),
      hostId: "demo-alex",
      members: {
        create: [
          { userId: "demo-alex", role: "HOST", status: "LEFT" },
          { userId: "demo-morgan", role: "PARTICIPANT", status: "LEFT" },
        ],
      },
      messages: withMessages
        ? {
            create: [
              { userId: "demo-alex", body: "Choose durable chat as truth." },
              {
                userId: "demo-morgan",
                body: "Use realtime packets only to request a refresh.",
              },
            ],
          }
        : undefined,
    },
  });
  return { roomId, ...fakeProvider() };
}

test("host generates one persisted summary with bounded source and usage", async () => {
  const f = await fixture();
  const result = await generateRoomSummary(f.provider, f.roomId, "demo-alex");
  assert.equal(result.status, "READY");
  assert.equal(result.content, f.state.result.content);
  assert.equal(result.promptTokens, 123);
  assert.equal(result.completionTokens, 45);
  assert.equal(result.sourceMessageCount, 2);
  assert.equal(f.state.calls.length, 1);
  assert.ok(f.state.calls[0]!.transcript.length <= 12_000);
  assert.match(f.state.calls[0]!.transcript, /durable chat/);
  const memberView = await getRoomSummary(f.roomId, "demo-morgan");
  assert.equal(memberView.content, result.content);
  const duplicate = await generateRoomSummary(
    f.provider,
    f.roomId,
    "demo-alex",
  );
  assert.equal(duplicate.status, "READY");
  assert.equal(f.state.calls.length, 1);
});

test("only the host of an ended room can generate", async () => {
  const f = await fixture();
  await assert.rejects(
    generateRoomSummary(f.provider, f.roomId, "demo-morgan"),
    denied("SUMMARY_FORBIDDEN"),
  );
  await db.room.update({
    where: { id: f.roomId },
    data: { status: "OPEN", endedAt: null },
  });
  await assert.rejects(
    generateRoomSummary(f.provider, f.roomId, "demo-alex"),
    denied("ROOM_NOT_ENDED"),
  );
  assert.equal(f.state.calls.length, 0);
});

test("empty chat becomes a visible failure without calling the provider", async () => {
  const f = await fixture(false);
  await assert.rejects(
    generateRoomSummary(f.provider, f.roomId, "demo-alex"),
    denied("SUMMARY_SOURCE_EMPTY"),
  );
  const result = await getRoomSummary(f.roomId, "demo-alex");
  assert.equal(result.status, "FAILED");
  assert.equal(result.sourceMessageCount, 0);
  assert.match(result.error ?? "", /No written chat/);
  assert.equal(f.state.calls.length, 0);
});

test("provider failure persists safely and a later retry can complete", async () => {
  const f = await fixture();
  f.state.failure = new SummaryProviderError("REQUEST_REJECTED");
  await assert.rejects(
    generateRoomSummary(f.provider, f.roomId, "demo-alex"),
    denied("SUMMARY_PROVIDER_FAILED"),
  );
  let result = await getRoomSummary(f.roomId, "demo-alex");
  assert.equal(result.status, "FAILED");
  assert.match(result.error ?? "", /key and available balance/);
  f.state.failure = null;
  result = await generateRoomSummary(f.provider, f.roomId, "demo-alex");
  assert.equal(result.status, "READY");
  assert.equal(f.state.calls.length, 2);
});

test("a fresh generation is single-flight while a stale lease is retryable", async () => {
  const f = await fixture();
  await db.sessionSummary.create({
    data: {
      roomId: f.roomId,
      status: "GENERATING",
      requestedAt: new Date(),
      attemptId: "first-attempt",
      model: f.provider.model,
    },
  });
  await assert.rejects(
    generateRoomSummary(f.provider, f.roomId, "demo-alex"),
    denied("SUMMARY_IN_PROGRESS"),
  );
  assert.equal(f.state.calls.length, 0);
  const later = new Date(Date.now() + 3 * 60_000);
  const result = await generateRoomSummary(
    f.provider,
    f.roomId,
    "demo-alex",
    later,
  );
  assert.equal(result.status, "READY");
  assert.equal(f.state.calls.length, 1);
});

test("summary reads expire abandoned generation and enable an explicit retry", async () => {
  const f = await fixture();
  const started = new Date();
  await db.sessionSummary.create({
    data: {
      roomId: f.roomId,
      status: "GENERATING",
      requestedAt: started,
      attemptId: "abandoned",
    },
  });
  assert.equal(
    (await getRoomSummary(f.roomId, "demo-morgan", started)).status,
    "GENERATING",
  );
  const expiredAt = new Date(started.getTime() + 120_000);
  const expired = await getRoomSummary(f.roomId, "demo-morgan", expiredAt);
  assert.equal(expired.status, "FAILED");
  assert.match(expired.error!, /timed out/);
  assert.equal(
    (await db.sessionSummary.findUniqueOrThrow({ where: { roomId: f.roomId } }))
      .attemptId,
    null,
  );
  assert.equal(f.state.calls.length, 0);
  assert.equal(
    (await generateRoomSummary(f.provider, f.roomId, "demo-alex", expiredAt))
      .status,
    "READY",
  );
  assert.equal(f.state.calls.length, 1);
});

test("expired in-flight success or failure cannot overwrite a newer ready summary", async () => {
  for (const fails of [false, true]) {
    const f = await fixture();
    const started = new Date();
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<SummaryGeneration>();
    const oldProvider: SummaryProvider = {
      model: "old-attempt",
      generate: async () => {
        entered.resolve();
        return response.promise;
      },
    };
    const old = generateRoomSummary(
      oldProvider,
      f.roomId,
      "demo-alex",
      started,
    );
    const rejected = assert.rejects(old, denied("SUMMARY_SUPERSEDED"));
    await entered.promise;
    const later = new Date(started.getTime() + 120_000);
    await getRoomSummary(f.roomId, "demo-alex", later);
    await generateRoomSummary(f.provider, f.roomId, "demo-alex", later);
    if (fails) response.reject(new Error("old provider failed"));
    else response.resolve({ ...f.state.result, content: "Stale content" });
    await rejected;
    const saved = await getRoomSummary(f.roomId, "demo-morgan", later);
    assert.equal(saved.status, "READY");
    assert.equal(saved.content, f.state.result.content);
  }
});

test("nonmembers and kicked members cannot read or expire an in-flight summary", async () => {
  const f = await fixture();
  await db.sessionSummary.create({
    data: {
      roomId: f.roomId,
      status: "GENERATING",
      requestedAt: new Date(0),
      attemptId: "keep",
    },
  });
  await assert.rejects(
    getRoomSummary(f.roomId, "demo-taylor"),
    denied("MEMBERSHIP_REQUIRED"),
  );
  await db.roomMember.update({
    where: { roomId_userId: { roomId: f.roomId, userId: "demo-morgan" } },
    data: { status: "KICKED" },
  });
  await assert.rejects(
    getRoomSummary(f.roomId, "demo-morgan"),
    denied("MEMBERSHIP_REQUIRED"),
  );
  assert.equal(
    (await db.sessionSummary.findUniqueOrThrow({ where: { roomId: f.roomId } }))
      .attemptId,
    "keep",
  );
});

test("DeepSeek adapter sends bounded non-thinking request and validates usage", async () => {
  let inspected = false;
  const provider = deepSeekProvider(
    {
      DEEPSEEK_API_KEY: "synthetic-test-key-not-a-real-secret",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
    },
    async (input, init) => {
      assert.equal(input, "https://api.deepseek.com/chat/completions");
      assert.match(
        String(new Headers(init?.headers).get("authorization")),
        /^Bearer /,
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "deepseek-v4-flash");
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.equal(body.max_tokens, 700);
      assert.equal(body.stream, false);
      assert.match(body.messages[1].content, /<chat-data>/);
      inspected = true;
      return Response.json({
        model: "deepseek-v4-flash",
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Decisions\nA concise result." },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  );
  const result = await provider.generate({
    roomTitle: "Synthetic room",
    topic: "PHILOSOPHY",
    transcript: "Alex: Test only",
  });
  assert.equal(result.promptTokens, 10);
  assert.equal(result.completionTokens, 5);
  assert.equal(inspected, true);
  await assert.rejects(
    deepSeekProvider({}, fetch).generate({
      roomTitle: "No key",
      topic: "PHILOSOPHY",
      transcript: "Test",
    }),
    (error: unknown) =>
      error instanceof SummaryProviderError &&
      error.code === "MISSING_CONFIGURATION",
  );
});
