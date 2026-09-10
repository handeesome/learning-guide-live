import { z } from "zod";
import type { MemberRole, MemberStatus } from "../generated/prisma/enums";

export const reviewInput = z
  .object({ decision: z.enum(["APPROVE", "REJECT"]) })
  .strict();
export const memberRoleInput = z
  .object({ role: z.enum(["MODERATOR", "PARTICIPANT"]) })
  .strict();

export type ReviewQueue = {
  requests: { id: string; userId: string; name: string; createdAt: string }[];
  members: {
    userId: string;
    name: string;
    role: MemberRole;
    status: MemberStatus;
  }[];
  hasMoreRequests: boolean;
  hasMoreMembers: boolean;
};
