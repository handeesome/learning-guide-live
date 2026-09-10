import { z } from "zod";
import type {
  MemberRole,
  MemberStatus,
  RoomStatus,
} from "../generated/prisma/enums";

export const chatInput = z
  .object({ body: z.string().trim().min(1).max(2000) })
  .strict();
export const handInput = z
  .object({ raised: z.boolean(), targetUserId: z.string().min(1).optional() })
  .strict();
export const focusInput = z
  .object({ targetUserId: z.string().min(1).nullable() })
  .strict();
export const emptyCommandInput = z.object({}).strict();

export type CollaborationMessage = {
  id: string;
  userId: string;
  name: string;
  body: string;
  createdAt: string;
};
export type CollaborationMember = {
  userId: string;
  name: string;
  role: MemberRole;
  status: MemberStatus;
  handRaised: boolean;
  mediaIdentity: string | null;
  mediaRemovalPending: boolean;
};
export type CollaborationSnapshot = {
  roomStatus: RoomStatus;
  selfUserId: string;
  selfRole: MemberRole;
  focusedUserId: string | null;
  messages: CollaborationMessage[];
  members: CollaborationMember[];
  serverTime: string;
};

/** Presentation only. The mutation still reloads and authorizes SQL state. */
export function canRemoveCollaborationMember(
  snapshot: CollaborationSnapshot,
  target: CollaborationMember,
) {
  const self = snapshot.members.find(
    (member) => member.userId === snapshot.selfUserId,
  );
  return (
    snapshot.roomStatus === "OPEN" &&
    self?.status === "ACTIVE" &&
    (snapshot.selfRole === "HOST" || snapshot.selfRole === "MODERATOR") &&
    target.userId !== snapshot.selfUserId &&
    (target.status === "ACTIVE" ||
      (target.status === "KICKED" && target.mediaRemovalPending)) &&
    (target.role === "PARTICIPANT" ||
      (snapshot.selfRole === "HOST" && target.role === "MODERATOR"))
  );
}
