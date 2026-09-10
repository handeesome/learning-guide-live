import assert from "node:assert/strict";

// Read-only guest checks of actual Next.js routing, not a browser/media test.
const origin = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const base = new URL(origin);
if (
  base.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
) {
  throw new Error(
    "Entry-route smoke is restricted to a local HTTP application.",
  );
}

const page = await fetch(`${origin}/rooms/demo-philosophy/join`);
assert.equal(page.status, 200);
const html = await page.text();
assert.ok(html.includes("Request room entry"));
assert.ok(html.includes("Sign in to request entry"));
assert.equal(html.includes("demo-message-1"), false);

for (const [endpoint, method, input, expected] of [
  ["invitations", "POST", { expiresInMinutes: 60 }, 401],
  ["join-requests", "POST", { code: "invalid" }, 401],
  ["join-requests", "GET", null, 401],
  ["invitations/verify", "POST", { code: "invalid" }, 400],
]) {
  const response = await fetch(
    `${origin}/api/rooms/demo-philosophy/${endpoint}`,
    {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
    },
  );
  assert.equal(response.status, expected, `${method} ${endpoint}`);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
}
console.log(
  "Entry-route HTTP smoke passed: join page, guest gates and invalid invitation preview. No records were created.",
);
