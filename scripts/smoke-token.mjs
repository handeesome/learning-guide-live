import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const base = new URL(origin);
if (
  base.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
)
  throw new Error("Token smoke is restricted to local HTTP.");
const body = JSON.stringify({
  clientId: randomUUID(),
  reservationId: randomUUID(),
});
const headers = { Origin: origin, "Content-Type": "application/json" };
for (const [path, method] of [
  ["token", "POST"],
  ["token", "DELETE"],
  ["media-sync", "POST"],
]) {
  const response = await fetch(`${origin}/api/rooms/demo-philosophy/${path}`, {
    method,
    headers,
    body,
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
}
const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    email: "alex@guide.test",
    password: "LearnTogether!2026",
  }),
});
assert.equal(signIn.status, 200);
const cookie = signIn.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert.ok(cookie);
try {
  const authenticated = { ...headers, Cookie: cookie };
  const stale = await fetch(`${origin}/api/rooms/demo-philosophy/token`, {
    method: "POST",
    headers: authenticated,
    body,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "SEAT_CHANGED");
  assert.match(stale.headers.get("cache-control") ?? "", /no-store/);
  const nonmember = await fetch(`${origin}/api/rooms/demo-biology/token`, {
    method: "POST",
    headers: authenticated,
    body,
  });
  assert.equal(nonmember.status, 403);
  const page = await fetch(`${origin}/rooms/demo-philosophy`, {
    headers: { Cookie: cookie },
  });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("Seat reservation"));
} finally {
  assert.equal(
    (
      await fetch(`${origin}/api/auth/sign-out`, {
        method: "POST",
        headers: { ...headers, Cookie: cookie },
        body: "{}",
      })
    ).status,
    200,
  );
}
console.log(
  "Token HTTP smoke passed: guest, nonmember and stale-generation denial, no-store, authenticated room page. No grants issued or Cloud calls.",
);
