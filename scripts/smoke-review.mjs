import assert from "node:assert/strict";

// Real HTTP checks with public demo accounts. No review or role write succeeds.
const origin = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const base = new URL(origin);
if (
  base.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
) {
  throw new Error("Review smoke is restricted to a local HTTP application.");
}
const prefix = `${origin}/api/rooms/demo-philosophy`;
const cookies = [];
async function login(name) {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${name}@guide.test`,
      password: "LearnTogether!2026",
    }),
  });
  assert.equal(response.status, 200, "The local demo account must sign in.");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  cookies.push(cookie);
  return cookie;
}
try {
  for (const [path, method, body] of [
    ["review", "GET", null],
    ["join-requests/missing-request/review", "POST", { decision: "APPROVE" }],
    ["members/demo-morgan/role", "PATCH", { role: "MODERATOR" }],
  ]) {
    const response = await fetch(`${prefix}/${path}`, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  const host = await login("alex");
  const hostQueue = await fetch(`${prefix}/review`, {
    headers: { Cookie: host },
  });
  assert.equal(hostQueue.status, 200);
  const data = await hostQueue.json();
  assert.ok(Array.isArray(data.requests) && Array.isArray(data.members));
  const hostPage = await fetch(`${origin}/rooms/demo-philosophy`, {
    headers: { Cookie: host },
  });
  assert.equal(hostPage.status, 200);
  assert.ok((await hostPage.text()).includes("Requests and roles"));
  const participant = await login("morgan");
  assert.equal(
    (await fetch(`${prefix}/review`, { headers: { Cookie: participant } }))
      .status,
    403,
  );
  const forged = await fetch(`${prefix}/members/demo-morgan/role`, {
    method: "PATCH",
    headers: {
      Cookie: participant,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "MODERATOR" }),
  });
  assert.equal(forged.status, 403);
} finally {
  for (const cookie of cookies) {
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
}
console.log(
  "Review HTTP smoke passed: host page/queue, guest rejection and non-host role rejection. No room, request or role data changed.",
);
