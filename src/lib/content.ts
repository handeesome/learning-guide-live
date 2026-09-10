// Shared interface copy; no network-based translation or runtime content generation.
export const copy = {
  brand: "Learning Guide Live",
  rooms: "Discussion rooms",
  newRoom: "Create room",
  signIn: "Sign in",
  signUp: "Create account",
  signOut: "Sign out",
  displayName: "Display name",
  email: "Email address",
  password: "Password",
  passwordHint: "Use 10–128 characters.",
  signInTitle: "Welcome back",
  signUpTitle: "Join the discussion",
  signInHelp: "Sign in to host or join a learning discussion.",
  signUpHelp: "Create an account to take part in a learning discussion.",
  badCredentials: "Email or password doesn't match. Check both and try again.",
  connectionError: "Couldn't connect. Check your connection and try again.",
  signUpError:
    "Couldn't create your account. Check your details or try signing in.",
  throttled: "Too many attempts. Wait a minute, then try again.",
  emptyRooms: "No rooms here yet",
  emptyRoomsHelp: "Create a room around a question you'd like to explore.",
  roomUnavailable: "This room isn't available",
  roomUnavailableHelp: "Check the link or return to the discussion rooms.",
  roomSaveError: "Couldn't create the room. Check your details and try again.",
  inviteTitle: "Invite people",
  inviteHelp: "Invitees sign in and request entry. You decide who joins.",
  inviteDuration: "Invitation expires after",
  createInvitation: "Create invitation",
  creatingInvitation: "Creating invitation…",
  invitationLink: "Invitation link",
  copyInvitation: "Copy link",
  invitationCopied: "Invitation link copied.",
  invitationCopyFallback:
    "Couldn't copy automatically. Select the link and copy it.",
  invitationSaveHint:
    "Copy this link now. It won't be shown again after you leave this page.",
  invitationFailed:
    "Couldn't create an invitation. Try again or refresh the room.",
  entryTitle: "Request room entry",
  entryHelp: "An invitation lets you apply. Only the host can approve entry.",
  invitationCode: "Invitation code",
  invitationCodeHelp:
    "Open the host's full invitation link, or paste its code here.",
  checkInvitation: "Check invitation",
  checkingInvitation: "Checking invitation…",
  requestEntry: "Request to join",
  requestingEntry: "Sending request…",
  signInForEntry: "Sign in to request entry",
  refreshEntry: "Refresh status",
  refreshingEntry: "Refreshing…",
  reviewTitle: "Requests and roles",
  reviewHelp: "Only you, the host, can approve entry or change roles.",
  approvalHelp:
    "Approval adds room membership. It does not connect audio or video.",
  pendingRequests: "Pending requests",
  noPendingRequests: "No requests waiting for review.",
  membersAndRoles: "Members and roles",
  approveRequest: "Approve",
  rejectRequest: "Reject",
  makeModerator: "Make moderator",
  removeModerator: "Remove moderator",
  reviewSaved: "Decision saved.",
  roleSaved: "Role updated.",
  reviewUnchanged: "This change was already saved.",
  reviewLoading: "Loading requests and roles…",
  reviewFailed: "Couldn't save this change. Refresh the list and try again.",
  reviewRefreshFailed:
    "Couldn't refresh the list. We'll retry, or you can refresh now.",
  reviewAutoRefresh: "Updates every 5 seconds while this tab is visible.",
  reviewMoreRequests:
    "Showing the oldest 50 requests. Review these to see the next requests.",
  reviewMoreMembers:
    "Showing the first 100 members. This local demo does not paginate larger member histories.",
  viewRoom: "View room",
  entryFailed:
    "Couldn't send the request. Check your connection and try again.",
  statusFailed: "Couldn't refresh your status. Please try again.",
  invitationStorageFailed:
    "Your browser couldn't keep this invitation. After signing in, open the original link again.",
  entryStatus: {
    PENDING: "Request sent. Waiting for the host to review it.",
    APPROVED: "Your request is approved. No new request is needed.",
    REJECTED:
      "The host declined your request. Contact the host before trying again.",
    HOST: "You're the host. You don't need to request entry.",
    MEMBER:
      "You already have membership in this room. No new request is needed.",
    KICKED: "You were removed from this room and cannot request entry.",
    CLOSED: "This room is closing or has ended. New requests are closed.",
    UNAVAILABLE: "Your room access couldn't be verified. Contact the host.",
  },
} as const;

export type EntryState = keyof typeof copy.entryStatus | "NONE";
export const seatCopy = {
  title: "Seat reservation",
  help: "Up to 8 seats, including the host. Approval alone does not hold a seat.",
  preview:
    "Reservations last 60 seconds. Audio and video are not connected yet.",
  reserve: "Reserve a seat",
  takeover: "Take over reservation",
  cancel: "Cancel reservation",
  refresh: "Refresh seats",
  loading: "Loading seat status…",
  saving: "Saving…",
  available: "No seat reserved for you.",
  full: "All seats are held. Wait for a seat to open, then try again.",
  elsewhere:
    "Another page holds your reservation. You can take it over without using an extra seat.",
  replaced:
    "Another page took over your reservation. This page no longer holds it.",
  saved: "Seat reserved. This does not connect audio or video.",
  cancelled: "Reservation cancelled. Your membership is unchanged.",
  mediaHeld:
    "Connection access holds this seat until the server confirms release. Audio and video controls are coming in the next stage.",
  releaseMedia: "Release connection access",
  mediaReleased: "Connection access released. Your membership is unchanged.",
  refreshFailed: "Couldn't refresh seats. We'll retry, or you can refresh now.",
  failed: "Couldn't update your reservation. Refresh seats and try again.",
  active:
    "Your account has an active media session. Reservation controls cannot change it.",
} as const;
export const memberRoleLabels = {
  HOST: "Host",
  MODERATOR: "Moderator",
  PARTICIPANT: "Participant",
} as const;
export const memberStatusLabels = {
  APPROVED: "Approved",
  ACTIVE: "In room",
  LEFT: "Left",
  KICKED: "Removed",
} as const;
export const roomStatusLabels = {
  OPEN: "Open room",
  ENDING: "Closing",
  ENDED: "Ended",
} as const;

export const topics = [
  { id: "PHILOSOPHY", label: "Philosophy" },
  { id: "MATHEMATICAL_BIOLOGY", label: "Mathematical biology" },
  { id: "GERMAN_HISTORY", label: "German history simulation" },
] as const;

export function topicLabel(id: string) {
  return (
    topics.find((topic) => topic.id === id)?.label ?? "Learning discussion"
  );
}

export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function safeReturnPath(value: string | null | undefined) {
  // Restrict redirects to our room routes; reject protocol-relative/backslash URLs.
  return value && /^\/rooms(?:\/[^\\\s?#]*)?(?:\?[^\\\s#]*)?$/u.test(value)
    ? value
    : "/rooms";
}
