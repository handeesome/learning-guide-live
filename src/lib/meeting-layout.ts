export type MeetingLayout =
  | { mode: "screen-share"; primaryIdentity: string }
  | { mode: "focus"; primaryIdentity: string }
  | { mode: "gallery"; primaryIdentity: null };

type MeetingLayoutInput = {
  screenShareIdentities: string[];
  focusedIdentity: string | null;
  participantIdentities: string[];
};

/** Screen share always wins. A stable identity sort makes an unexpected
 * simultaneous-share race render the same primary track on every client. */
export function selectMeetingLayout({
  screenShareIdentities,
  focusedIdentity,
  participantIdentities,
}: MeetingLayoutInput): MeetingLayout {
  const primaryShare = [...new Set(screenShareIdentities)].sort()[0];
  if (primaryShare)
    return { mode: "screen-share", primaryIdentity: primaryShare };
  if (focusedIdentity && participantIdentities.includes(focusedIdentity))
    return { mode: "focus", primaryIdentity: focusedIdentity };
  return { mode: "gallery", primaryIdentity: null };
}
