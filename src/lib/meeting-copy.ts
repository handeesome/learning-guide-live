export const meetingCopy = {
  title: "Join the discussion",
  privacy:
    "Camera and microphone start off. Preview stays on this device; nothing is recorded.",
  join: "Join discussion",
  takeover: "Take over and join",
  elsewhere: "Another page holds your seat. Taking over disconnects that page.",
  release: "Release held connection",
  released: "Connection released. Your membership is unchanged.",
  left: "You left the discussion. The room remains open.",
  failed:
    "Couldn't connect. Refresh seats or release held access before trying again.",
  releaseFailed:
    "Local media stopped, but server release is unconfirmed. Refresh and retry release.",
  refreshFailed:
    "Couldn't verify connection access. Check your network and refresh.",
  stopped: "Connection ended. This page will not rejoin automatically.",
  replaced:
    "This seat changed or access ended. This page has stopped connecting.",
  stale:
    "Access could not be verified. Local media stopped; refresh before rejoining.",
  preview: "Preview camera",
  stopPreview: "Stop preview",
  shareScreen: "Share screen",
  stopSharing: "Stop sharing",
  shareInProgress:
    "Another participant is sharing. Their screen stays in the main area.",
  shareFailed:
    "Couldn't start screen sharing. Choose a window or screen in the browser prompt, then try again.",
  audioFailed: "Sound is blocked. Select Enable sound to try again.",
  states: {
    idle: "Not connected",
    joining: "Connecting…",
    connected: "Connected",
    reconnecting: "Reconnecting…",
    leaving: "Leaving…",
  },
} as const;

export function deviceError(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError")
    return "Device access was denied. Allow access in browser settings, then try again. You can still join with devices off.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return "No device was found. Connect a camera or microphone and try again.";
  if (name === "NotReadableError" || name === "TrackStartError")
    return "The device is unavailable or in use. Close other apps using it and try again.";
  return "Couldn't start the device. Check browser permissions and device connections, then try again.";
}
