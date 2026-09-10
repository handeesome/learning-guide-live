// Explicit, opt-in Cloud management smoke. Never run as part of npm test.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  RoomServiceClient,
  TokenVerifier,
  ServerError,
} from "livekit-server-sdk";
import { liveKitConfiguration, liveKitGateway } from "../src/lib/livekit";

let phase = "configuration";
function safeFailure(error: unknown) {
  if (error instanceof ServerError)
    return `HTTP ${error.status}, ${/^[a-z_]+$/.test(error.code ?? "") ? error.code : "no RPC code"}`;
  if (error instanceof Error && error.name === "TimeoutError")
    return "request timeout";
  return "configuration or transport failure";
}

async function main() {
  const config = liveKitConfiguration();
  const gateway = liveKitGateway(config);
  const service = new RoomServiceClient(
    config.url.replace(/^wss:/, "https:"),
    config.apiKey,
    config.apiSecret,
    { requestTimeout: 10, failover: false },
  );
  const roomName = `lg-smoke-${randomUUID()}`;
  // Cleanup is limited to the exact random room created by this invocation.
  try {
    phase = "room setup";
    await gateway.prepareRoom(roomName);
    phase = "local token verification";
    const identity = `p-${randomUUID()}`;
    const token = await gateway.sign({
      roomName,
      identity,
      name: "Synthetic smoke",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const claims = await new TokenVerifier(
      config.apiKey,
      config.apiSecret,
    ).verify(token, 0);
    if (claims.video?.room !== roomName || claims.video.roomAdmin !== false)
      throw new Error("scope-check-failed");
    phase = "participant query";
    if ((await gateway.participants(roomName)).length !== 0)
      throw new Error("unexpected-participant");
    // Tests Cloud's explicit revocation cutoff even when no client connected.
    phase = "absent identity revocation";
    await gateway.revoke(roomName, identity);
    console.log(
      "LiveKit Cloud smoke passed: capacity 8, local JWT verification, empty participant list, absent-identity revocation acknowledged. No media connection or recording.",
    );
  } finally {
    try {
      await service.deleteRoom(roomName);
      console.log(
        "Temporary Cloud smoke room deleted; no application rooms touched.",
      );
    } catch (error) {
      if (!(error instanceof ServerError && error.code === "not_found")) {
        console.error(
          `Cleanup could not be confirmed (${safeFailure(error)}). Check only temporary room ${roomName} in the Cloud console.`,
        );
        process.exitCode = 1;
      }
    }
  }
}
try {
  await main();
} catch (error) {
  // Deliberately exclude SDK message/stack/request data, JWT and configuration.
  console.error(
    `LiveKit smoke failed at ${phase} (${safeFailure(error)}). No credentials or tokens logged.`,
  );
  process.exitCode = 1;
}
