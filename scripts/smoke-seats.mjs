import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const base = new URL(origin);
if (
  base.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
) {
  throw new Error("Seat smoke is restricted to a local HTTP application.");
}
const endpoint = `${origin}/api/rooms/demo-philosophy/seat`;
const clientId = randomUUID();
for (const method of ["GET", "POST", "DELETE"]) {
  const response = await fetch(endpoint, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Room-Client": clientId,
    },
    ...(method === "GET"
      ? {}
      : { body: JSON.stringify({ clientId, previousReservationId: null }) }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
}
const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
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
  const response = await fetch(endpoint, {
    headers: { Cookie: cookie, "X-Room-Client": clientId },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const data = await response.json();
  assert.equal(data.capacity, 8);
  assert.ok(Number.isInteger(data.occupied) && data.occupied >= 0);
  assert.equal(data.available, Math.max(0, 8 - data.occupied));
  assert.equal(data.token, undefined);
  const page = await fetch(`${origin}/rooms/demo-philosophy`, {
    headers: { Cookie: cookie },
  });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("Seat reservation"));
  assert.equal(
    (
      await fetch(`${origin}/api/rooms/demo-biology/seat`, {
        headers: { Cookie: cookie, "X-Room-Client": clientId },
      })
    ).status,
    403,
  );
} finally {
  const response = await fetch(`${origin}/api/auth/sign-out`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
}
console.log(
  "Seat HTTP smoke passed: authenticated status/page, guest and cross-room denial. No reservation or membership writes.",
);
