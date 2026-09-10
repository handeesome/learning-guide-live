import { test } from "node:test";
import assert from "node:assert/strict";
import { LatestRead, commitThenRefresh } from "../src/lib/client-refresh";

test("late snapshots cannot overwrite a newer successful refresh", async () => {
  const reads = new LatestRead();
  const older = Promise.withResolvers<string>();
  const values: string[] = [];
  const first = reads.run(
    () => older.promise,
    (value) => values.push(value),
  );
  await reads.run(
    async () => "new",
    (value) => values.push(value),
  );
  older.resolve("old");
  await first;
  assert.deepEqual(values, ["new"]);
});

test("unmount or mutation invalidates pending results and errors", async () => {
  for (const fails of [false, true]) {
    const reads = new LatestRead();
    const response = Promise.withResolvers<string>();
    const pending = reads.run(
      () => response.promise,
      () => assert.fail("stale result applied"),
    );
    reads.invalidate();
    if (fails) response.reject(new Error("stale failure"));
    else response.resolve("stale result");
    await pending;
  }
});

test("current read failures remain visible and refresh can recover", async () => {
  const reads = new LatestRead();
  await assert.rejects(
    reads.run(
      async () => {
        throw new Error("offline");
      },
      () => {},
    ),
    /offline/,
  );
  await reads.run(
    async () => "recovered",
    (value) => assert.equal(value, "recovered"),
  );
});

test("successful message persistence stays successful when the following refresh fails", async () => {
  let commits = 0;
  const outcome = await commitThenRefresh(
    async () => {
      commits++;
      return { id: "saved-message" };
    },
    async () => {
      throw new Error("read failed");
    },
  );
  assert.deepEqual(outcome, {
    result: { id: "saved-message" },
    refreshFailed: true,
  });
  assert.equal(commits, 1);
});

test("failed commands never report success, and successful reads need no retry notice", async () => {
  await assert.rejects(
    commitThenRefresh(
      async () => {
        throw new Error("write failed");
      },
      async () => assert.fail("no commit to refresh"),
    ),
    /write failed/,
  );
  assert.deepEqual(
    await commitThenRefresh(
      async () => "saved",
      async () => {},
    ),
    { result: "saved", refreshFailed: false },
  );
});
