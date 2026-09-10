import { createHash } from "node:crypto";
import {
  AccessToken,
  DataPacket_Kind,
  RoomConfiguration,
  RoomServiceClient,
  ServerError,
  TrackSource,
} from "livekit-server-sdk";
import { RoomApiError } from "./room-api";

export type LiveKitConfiguration = {
  url: string;
  apiKey: string;
  apiSecret: string;
};
export type TokenDetails = {
  roomName: string;
  identity: string;
  name: string;
  expiresAt: Date;
};
export interface MediaGateway {
  readonly url: string;
  prepareRoom(roomName: string): Promise<void>;
  sign(details: TokenDetails): Promise<string>;
  participants(roomName: string): Promise<string[]>;
  revoke(roomName: string, identity: string): Promise<void>;
  broadcast(roomName: string, payload: Uint8Array): Promise<void>;
  close(roomName: string): Promise<void>;
}

export function liveKitConfiguration(env = process.env): LiveKitConfiguration {
  const apiKey = env.LIVEKIT_API_KEY?.trim();
  const apiSecret = env.LIVEKIT_API_SECRET?.trim();
  let url: URL;
  try {
    url = new URL(env.LIVEKIT_URL?.trim() ?? "");
  } catch {
    throw new RoomApiError(
      503,
      "LIVEKIT_NOT_CONFIGURED",
      "LiveKit is not configured. Ask the app operator to complete local setup.",
    );
  }
  if (
    !apiKey ||
    !apiSecret ||
    url.protocol !== "wss:" ||
    !/^[a-z0-9-]+\.livekit\.cloud$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    // Revocation is a Cloud-only guarantee; do not silently accept self hosting.
    throw new RoomApiError(
      503,
      "LIVEKIT_NOT_CONFIGURED",
      "Use this project's LiveKit Cloud URL, API key and secret in the server configuration.",
    );
  }
  return { url: url.origin, apiKey, apiSecret };
}

export function mediaRoomName(roomId: string) {
  return `lg-${createHash("sha256").update(roomId).digest("hex").slice(0, 32)}`;
}

export async function signMediaToken(
  config: LiveKitConfiguration,
  details: TokenDetails,
) {
  const seconds = Math.floor((details.expiresAt.getTime() - Date.now()) / 1000);
  if (seconds < 1 || seconds > 60)
    throw new RoomApiError(
      409,
      "TOKEN_WINDOW_EXPIRED",
      "The connection window expired. Release this seat and reserve again.",
    );
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: details.identity,
    name: details.name,
    ttl: seconds,
  });
  token.addGrant({
    room: details.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishSources: [
      TrackSource.CAMERA,
      TrackSource.MICROPHONE,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ],
    canPublishData: false,
    canUpdateOwnMetadata: false,
    roomAdmin: false,
    roomCreate: false,
    roomList: false,
    roomRecord: false,
  });
  // If an empty room vanished between prepare and connect, auto-creation must
  // keep the capacity defense too. Existing rooms are checked in prepareRoom.
  token.roomConfig = new RoomConfiguration({
    maxParticipants: 8,
    emptyTimeout: 120,
    departureTimeout: 60,
  });
  return token.toJwt();
}

export function liveKitGateway(config = liveKitConfiguration()): MediaGateway {
  const client = new RoomServiceClient(
    config.url.replace(/^wss:/, "https:"),
    config.apiKey,
    config.apiSecret,
    { requestTimeout: 10, failover: false },
  );
  async function participants(roomName: string) {
    try {
      return (await client.listParticipants(roomName)).map(
        (person) => person.identity,
      );
    } catch (error) {
      if (error instanceof ServerError && error.code === "not_found") return [];
      throw error;
    }
  }
  return {
    url: config.url,
    async prepareRoom(roomName) {
      const room = await client.createRoom({
        name: roomName,
        maxParticipants: 8,
        emptyTimeout: 120,
        departureTimeout: 60,
      });
      if (room.maxParticipants !== 8)
        throw new RoomApiError(
          503,
          "MEDIA_CAPACITY_MISMATCH",
          "The media room has incompatible capacity settings. Contact the app operator.",
        );
    },
    sign: (details) => signMediaToken(config, details),
    participants,
    async revoke(roomName, identity) {
      // Explicit cutoff yields success even for an absent participant on Cloud.
      // +10s covers JWT second rounding; each generation uses a fresh identity,
      // so this cutoff cannot invalidate the new page's replacement identity.
      await client.removeParticipant(roomName, identity, {
        revokeTokenTs: BigInt(Math.floor(Date.now() / 1000) + 10),
      });
      if ((await participants(roomName)).includes(identity))
        throw new RoomApiError(
          503,
          "MEDIA_REMOVAL_PENDING",
          "The old connection has not closed yet. Retry without opening another connection.",
        );
    },
    broadcast: (roomName, payload) =>
      client.sendData(roomName, payload, DataPacket_Kind.RELIABLE, {
        topic: "learning-guide",
      }),
    async close(roomName) {
      try {
        await client.deleteRoom(roomName);
      } catch (error) {
        if (error instanceof ServerError && error.code === "not_found") return;
        throw error;
      }
      if ((await participants(roomName)).length > 0)
        throw new RoomApiError(
          503,
          "MEDIA_ROOM_CLOSE_PENDING",
          "The media room still has participants. Retry ending the room.",
        );
    },
  };
}
