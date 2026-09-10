import { z } from "zod";

export const invitationDurations = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "24 hours" },
] as const;

export const invitationInput = z
  .object({
    expiresInMinutes: z.union([z.literal(15), z.literal(60), z.literal(1440)]),
  })
  .strict();

export const invitationCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const joinInput = z.object({ code: invitationCode }).strict();

// Fragments are never sent in HTTP requests, referrers, or server route logs.
export function invitationPath(roomId: string, code: string) {
  return `/rooms/${encodeURIComponent(roomId)}/join#invite=${encodeURIComponent(code)}`;
}

export function codeFromFragment(fragment: string): string | null {
  return new URLSearchParams(fragment.replace(/^#/u, "")).get("invite");
}
