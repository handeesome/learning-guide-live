import { z } from "zod";

export const mediaGrantInput = z
  .object({
    clientId: z.uuid(),
    reservationId: z.uuid(),
    takeover: z.boolean().default(false),
  })
  .strict();
export const mediaReleaseInput = z
  .object({ clientId: z.uuid(), reservationId: z.uuid() })
  .strict();
export const mediaSyncInput = z.object({}).strict();

export type MediaActor = { userId: string; sessionId: string };
export type MediaGrant = {
  token: string;
  serverUrl: string;
  identity: string;
  roomName: string;
  reservationId: string;
  expiresAt: string;
};
