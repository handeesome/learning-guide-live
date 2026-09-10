import type {
  MemberRole,
  MemberStatus,
  RoomStatus,
} from "../generated/prisma/enums";

export type RoomPolicyRoom = {
  id: string;
  hostId: string;
  status: RoomStatus;
};

export type RoomPolicyMember = {
  roomId: string;
  userId: string;
  role: MemberRole;
  status: MemberStatus;
};

export type RoomPolicyContext = {
  room: RoomPolicyRoom;
  userId: string | null;
  member: RoomPolicyMember | null;
};

/**
 * This policy only consumes server-loaded identity and SQL state. A browser's
 * role or approval claim is never a substitute for constructing this context.
 */
export function roomRole(context: RoomPolicyContext): MemberRole | null {
  const { room, userId, member } = context;
  if (
    !userId ||
    !member ||
    member.userId !== userId ||
    member.roomId !== room.id ||
    member.status === "KICKED"
  ) {
    return null;
  }

  // Fail closed on inconsistent ownership, even if a row happens to say HOST.
  if ((member.role === "HOST") !== (room.hostId === userId)) return null;
  return member.role;
}

export function canReadRoomHistory(context: RoomPolicyContext): boolean {
  // Leaving and room ending retain history; removal revokes membership access.
  return roomRole(context) !== null;
}

export type RoomAction =
  | {
      action:
        | "create_invitation"
        | "review_requests"
        | "end_room"
        | "generate_summary"
        | "send_chat"
        | "raise_hand"
        | "clear_focus";
    }
  | {
      action: "set_moderator" | "lower_hand" | "set_focus" | "kick_member";
      target: RoomPolicyMember;
    };

/**
 * Coarse business authorization, not an implemented command or a media grant.
 * Mutation handlers must load fresh SQL state and enforce it in the write's
 * transaction/condition. Admission, seat leases and Token checks come later.
 * Targets must also be loaded from SQL, not accepted as client role objects.
 */
export function canPerformRoomAction(
  context: RoomPolicyContext,
  command: RoomAction,
): boolean {
  const role = roomRole(context);
  if (!role) return false;

  // Only the host can start or retry ending. Repeated requests must not reopen
  // the room, skip teardown, or turn a completed room back into ENDING.
  if (command.action === "end_room") {
    return (
      role === "HOST" &&
      (context.room.status === "OPEN" || context.room.status === "ENDING")
    );
  }
  if (command.action === "generate_summary") {
    return role === "HOST" && context.room.status === "ENDED";
  }
  if (context.room.status !== "OPEN") return false;

  if (
    command.action === "create_invitation" ||
    command.action === "review_requests"
  ) {
    return role === "HOST";
  }

  if ("target" in command) {
    const targetRole = roomRole({
      room: context.room,
      userId: command.target.userId,
      member: command.target,
    });
    if (!targetRole) return false;
    if (command.action === "set_moderator") {
      // Promote/demote other non-host members, never replace the room owner.
      return role === "HOST" && targetRole !== "HOST";
    }
    if (command.target.status !== "ACTIVE") return false;
  }

  // Leaving retains history and the host's room-level administration, but not
  // live-chat or in-meeting controls. ACTIVE is SQL state, not a browser flag.
  if (context.member?.status !== "ACTIVE") return false;
  if (command.action === "send_chat" || command.action === "raise_hand") {
    return true;
  }
  if (role !== "HOST" && role !== "MODERATOR") return false;
  if (command.action === "kick_member") {
    if (command.target.userId === context.userId) return false;
    return (
      command.target.role === "PARTICIPANT" ||
      (role === "HOST" && command.target.role === "MODERATOR")
    );
  }
  return (
    command.action === "lower_hand" ||
    command.action === "set_focus" ||
    command.action === "clear_focus"
  );
}

/**
 * Allowed persisted edges, not a command to close the media room. The end
 * workflow authorizes the actor, uses a conditional SQL write, and confirms teardown
 * before completing ENDING -> ENDED. No client can declare teardown successful.
 */
export function canTransitionRoom(from: RoomStatus, to: RoomStatus): boolean {
  return (
    (from === "OPEN" && to === "ENDING") ||
    (from === "ENDING" && to === "ENDED")
  );
}
