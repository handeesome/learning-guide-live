import assert from "node:assert/strict";

// Exercises the running Next.js integration without logging credentials or cookies.
const origin = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const url = new URL(origin);
if (
  url.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
) {
  throw new Error(
    "The demo-account smoke is restricted to a local HTTP application.",
  );
}

const firstMessage = "Which desires does Epicurus consider necessary";
async function assertRequiresSignIn(response) {
  let destination;
  if ([303, 307].includes(response.status)) {
    destination = response.headers.get("location");
  } else {
    // Next.js streams an explicit redirect meta tag after a layout has flushed.
    // A bare 200 is not enough: require the exact redirect and no protected form.
    assert.equal(response.status, 200);
    const body = await response.text();
    const meta = body.match(/<meta\b[^>]*id="__next-page-redirect"[^>]*>/)?.[0];
    assert.ok(
      meta,
      "A streamed guest response must include Next.js's redirect tag.",
    );
    destination = meta.match(/content="\d+;url=([^"]+)"/)?.[1];
    assert.equal(
      body.includes("<form"),
      false,
      "A guest must not receive the protected room form.",
    );
  }
  assert.ok(destination);
  const target = new URL(destination, origin);
  assert.equal(target.origin, origin);
  assert.equal(target.pathname, "/sign-in");
  assert.equal(target.searchParams.get("next"), "/rooms/new");
}
const guestHistory = await fetch(`${origin}/rooms/demo-past-philosophy`);
assert.equal(guestHistory.status, 200);
assert.equal((await guestHistory.text()).includes(firstMessage), false);
const guestNewRoom = await fetch(`${origin}/rooms/new`, { redirect: "manual" });
await assertRequiresSignIn(guestNewRoom);

const login = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({
    email: "alex@guide.test",
    password: "LearnTogether!2026",
  }),
});
assert.equal(login.status, 200, "The seeded local demo account must sign in.");
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
assert.ok(cookie);
try {
  const memberHistory = await fetch(`${origin}/rooms/demo-past-philosophy`, {
    headers: { Cookie: cookie },
  });
  assert.equal(memberHistory.status, 200);
  assert.ok((await memberHistory.text()).includes(firstMessage));
  const memberNewRoom = await fetch(`${origin}/rooms/new`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  assert.equal(memberNewRoom.status, 200);
} finally {
  const logout = await fetch(`${origin}/api/auth/sign-out`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(logout.status, 200);
}
const revoked = await fetch(`${origin}/rooms/new`, {
  headers: { Cookie: cookie },
  redirect: "manual",
});
await assertRequiresSignIn(revoked);
console.log(
  "HTTP smoke passed: protected pages, member-only history, login and logout revocation.",
);
