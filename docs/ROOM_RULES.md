# Room lifecycle and permission contract

These rules define the current authorization and lifecycle contract across application state and LiveKit media. The room-history page, APIs, and meeting client all use the same SQL-backed policy.

## Identity and authority

The server reads the authenticated user from Better Auth, then loads the requested room and that user's membership from SQL. A browser may identify an action or a target user; it cannot supply an authoritative role, approval or membership object.

`rooms.hostId` and the `HOST` membership must agree. A missing, kicked, wrong-room, wrong-user or inconsistent membership gets no member permissions. Being a host in one room grants nothing in another room. Public room metadata remains readable without membership.

## Permission matrix

These are business-policy permissions; a permitted result does not implement the operation or grant a LiveKit token.

| Operation                                  | Host                     | Moderator         | Participant       |
| ------------------------------------------ | ------------------------ | ----------------- | ----------------- |
| Read room history                          | Yes                      | Yes               | Yes               |
| Read post-session summary                  | Yes                      | Yes               | Yes               |
| Generate/retry post-session summary        | Yes, when ended          | No                | No                |
| Create invitations                         | Yes                      | No                | No                |
| Approve/reject join requests               | Yes                      | No                | No                |
| Assign/remove a moderator                  | Other non-host members   | No                | No                |
| Start/retry ending the room                | Yes                      | No                | No                |
| Send chat / raise own hand                 | Yes, while active        | Yes, while active | Yes, while active |
| Lower a member's hand / set or clear focus | Yes, while active        | Yes, while active | No                |
| Kick an active member                      | Moderator or participant | Participant only  | No                |

- Invitations, approvals, role changes and live controls require `OPEN`.
- `ENDING` blocks those actions immediately. Only the host can retry ending; history remains readable by members.
- `ENDED` has no live commands or reopening path. Existing non-kicked members can still read history and the persisted summary.
- Leaving does not end a room or remove historical membership. An absent host retains room-level administration. `APPROVED` and `LEFT` members cannot use live controls; `ACTIVE` is server-managed SQL state, not proof supplied by a browser.
- Kicked members lose member permissions, including history access and new token issuance. The kick workflow also revokes the current media identity; policy denial alone is not treated as proof of disconnection.
- Targets must be real members of the same room. Hand/focus/kick targets must be active. No one can kick themselves or the host; a moderator cannot kick another moderator or promote themselves. Host ownership cannot be transferred through role assignment.

Requiring `ACTIVE` for live controls and their targets separates historical membership from current meeting authority. Pre-connection leases, media reconciliation, and same-account takeover all use the same generation-fenced member row.

## Lifecycle

`OPEN → ENDING → ENDED`

Only these two forward edges are permitted. Starting or retrying ending requires host authorization. The policy helper is deliberately pure: it neither writes a status nor closes a LiveKit room.

The end command enters `ENDING` with a conditional SQL update, stops new approvals and tokens, performs real media teardown, and only then persists `ENDED`. On external failure it retains a visible, retryable state. The browser cannot report teardown success to authorize the final transition. Repeated requests are idempotent in the command handler; a retry is not a new `ENDING → ENDING` transition.

## Code and evidence

- [room-access.ts](../src/lib/room-access.ts): load the requested room and the authenticated viewer's SQL membership; no role parameter or cross-request permission cache.
- [room-policy.ts](../src/lib/room-policy.ts): ownership consistency, history visibility, role/action/target rules and allowed state edges.
- [Room detail](../src/app/rooms/[roomId]/page.tsx): apply the common policy before loading private messages and membership history.
- [Policy tests](../tests/room-policy.test.ts): roles, room states, absent/kicked members, target restrictions, cross-room and inconsistent identities.
- [Foundation integration tests](../tests/foundation.test.ts): real SQLite lookup and fresh-load revocation, alongside existing authentication and creation checks.

Mutation handlers recheck relevant state in their transaction or conditional write. An earlier page snapshot, data packet, or client-displayed permission is never authorization. Integration tests cover the concrete invitation, review, reservation, Cloud-admission, collaboration, kick, and end services in addition to the pure policy.

## Invitations and applications

| Endpoint under `/api/rooms/:roomId` | Authority and result                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /invitations`                 | Signed-in host of an open room; accepts `expiresInMinutes` 15, 60 or 1440; returns a one-time display of the random code and server-calculated expiry |
| `POST /invitations/verify`          | Same-origin public preview; accepts only `code`; returns expiry, never members, requests or access grants                                             |
| `POST /join-requests`               | Signed-in applicant with a valid same-room invitation; creates one `PENDING` request or returns the existing pending request                          |
| `GET /join-requests`                | Signed-in viewer's own request/state only; no peer-request listing or host review interface yet                                                       |

- Invitations contain 32 random bytes encoded as a 43-character base64url code. Only a SHA-256 digest is stored in SQL. Codes are reusable until expiry, but never confer approval or membership. Creating a second invitation does not revoke the first.
- Current engineering default: a new application requires a valid invitation, including when arriving from the public directory. Removing a code is not a way to bypass an expired invitation. Expiry is checked again when applying; a prior successful preview is not authorization.
- A validly submitted request remains after its invitation expires. Pending, approved and rejected application states are independent of invitation lifetime. Duplicate pending submissions are idempotent; applicants cannot reset rejected or approved records. Reservation expiry does not require an approved member to reapply.
- `OPEN` is required for invitation creation, preview and application. Kicked members and inconsistent ownership/memberships cannot apply. A host or already admitted member does not create a new request. No `room_members` row, role, lease or media token is created on application.
- Mutations acquire SQLite's write lock with a parameterized no-op update before reading permission and application state in the same Prisma transaction. The room's logical data and `updatedAt` are not changed by this lock. Keep these transactions short and do no external network work inside them. Busy/database failures return a visible 503, not success; future state-changing handlers must also respect transactional checks.
- The unique `(roomId, userId)` constraint is a second duplicate-request safeguard. Invitation concurrency tests use handlers sharing the actual local adapter; separate seat tests cover cross-process capacity.
- All POSTs enforce exact configured origin, JSON and a 4 KB body limit. Inputs reject unexpected identity/role/status fields. Responses are `private, no-store`; unexpected failures return generic errors without logging raw request bodies or database details.
- Local rate limits use bounded, one-process buckets: 10 invitation creations per user/minute, 30 applications per user/minute, 60 own-status reads per user/minute, and one shared public-preview limit of 60/minute. This is not distributed or public-hosting protection.
- Shared links use URL fragments, which do not travel in HTTP requests. The client stores the code per room in tab-scoped session storage across sign-in and removes it after a successful application. If storage is blocked, reopen the original link after signing in. Neither cached code nor UI state is server authority.

Implementation: [invitation service](../src/lib/invitations.ts), [HTTP safeguards](../src/lib/room-api.ts), [request form](../src/components/join-request-form.tsx), and [handler/SQLite tests](../tests/invitations.test.ts). Pending applications use visible-tab polling plus manual refresh.

## Host review and role assignment

| Endpoint under `/api/rooms/:roomId`     | Contract                                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /review`                           | Open-room host only; private snapshot of oldest 50 pending requests and first 100 non-kicked members, with explicit truncation flags; no emails or invite secrets |
| `POST /join-requests/:requestId/review` | Host only; strict `{decision: "APPROVE" \| "REJECT"}`; requested record must belong to this room                                                                  |
| `PATCH /members/:userId/role`           | Host only; strict `{role: "MODERATOR" \| "PARTICIPANT"}`; target must be a valid same-room non-host, non-kicked member                                            |

- Every write uses [the shared SQLite write-transaction gate](../src/lib/room-transaction.ts), then rereads the current host, room, request and target inside the transaction. Queue authorization and private lists share a read transaction. No browser-supplied actor/role/state can stand in for those reads.
- Approval updates both the pending application and membership in one transaction. New membership is `PARTICIPANT / APPROVED`, not `ACTIVE`; approval creates no seat lease or Token. A valid returning LEFT member retains their previously assigned role. Capacity is enforced when a member requests a reservation, not at approval time; historical/approved membership is not an online headcount.

- Rejection changes the application only. First decision wins; same-decision retries are no-ops and opposite decisions return 409. Approvals cannot be reversed into rejections through this endpoint. The UI removes completed requests from the pending queue.
- An approval retry checks for a missing/kicked/inconsistent membership before returning a no-op, never resurrects it, and never resets a role, active state or lease changed after approval. Approval is allowed after an invitation expires if the application was validly submitted earlier.
- Role assignment/demotion is idempotent and changes only `role`. It cannot transfer ownership, remove a ban, create membership or grant live media access. A moderator cannot promote themselves, assign peers or review requests.
- `ENDING`/`ENDED` and loss of host authority block review/list/role calls. Existing exact-origin, JSON/body limits, no-store responses and generic unexpected-error handling are reused. Local limits: 60 queue reads, 30 decisions and 30 role writes per user per minute.
- Host lists and pending applicant status use non-overlapping 5-second polling while visible, with failure backoff up to 30 seconds, abort on cleanup/manual actions, and a manual refresh option. Applicant polling stops at a non-pending state or session expiry. This is UI status synchronization, not LiveKit signaling or online detection.
- The queue exposes bounded snapshots rather than unbounded lists. More than 50 pending requests are handled oldest-first; more than 100 historical members are explicitly flagged and have no further pagination in this local demo. These are listing limits, not admission capacity controls.

Implementation: [review service](../src/lib/room-review.ts), [host panel](../src/components/host-review-panel.tsx), [polling lifecycle](../src/components/use-room-polling.ts), [SQLite/handler tests](../tests/room-review.test.ts). The rollback test uses a trigger in a disposable database to fail the application write after membership creation and verifies that neither partial change remains.

## Pre-connection seats

| Route                            | Authority / input                                                                                                | Result                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /api/rooms/:roomId/seat`    | Session, current valid membership, OPEN room; UUID `X-Room-Client` header                                        | Private no-store counts plus only this account's reservation         |
| `POST /api/rooms/:roomId/seat`   | Same authority; strict JSON `{ clientId, previousReservationId }` (`null` when no live reservation was observed) | 201 new reservation, 200 retry/takeover, 409 full/stale/active       |
| `DELETE /api/rooms/:roomId/seat` | Same authority; strict JSON `{ clientId, reservationId }`                                                        | Cancel the matching page's reservation; stale ID is a harmless no-op |

- Current SQL membership is required; an invitation or PENDING/REJECTED application alone is insufficient. KICKED, inconsistent owner/role, missing membership and ENDING/ENDED fail closed. The server never accepts a user ID, role, online flag, capacity or expiry from the browser.
- Held seats are `ACTIVE` members, APPROVED/LEFT members with `seatExpiresAt > serverNow`, and any member with a non-null `mediaIdentity`, counted once per member row. The last category includes expired/KICKED/revoking grants until Cloud revocation is confirmed. The host counts identically to any other account. Approval and mere history use no capacity. Expired pre-connection reservations do not count; no destructive history deletion is needed.
- Claimers begin the shared SQLite write transaction before reading permissions and counting, then write the reservation before commit. The unique `(roomId,userId)` membership bounds one account to one row. Capacity is an application transaction invariant, not a database trigger that protects arbitrary direct SQL writes. Other admission writers must use this gate; the Cloud room limit is a second defense.
- A new reservation lasts 60 seconds. It has a page-owner UUID and a fresh server reservation UUID. A same-page retry returns the original deadline; takeover changes owner and reservation ID but not the deadline or seat count. The new page must present the last reservation ID it observed. This compare-and-swap prevents an old delayed claim from stealing the seat back. Cancellation is likewise fenced by ID and owner, and cannot affect another account or a newer reservation.
- Client/page IDs and reservation IDs are not authentication or media credentials. A Session and current SQL authority are required for every operation; response DTOs never include another account's reservation or any page-owner ID. UI status polls are read-only, pause in hidden tabs and never renew or reclaim a seat automatically.
- Page reloads create a new UUID rather than sharing cloned sessionStorage. New-page takeover is the confirmed D22 policy; old pages show that they no longer own the reservation. Network loss after a successful POST is recoverable by refreshing/retrying. Reservations expire if the page disappears, without relying on unload requests. No automatic takeover loops.
- `ACTIVE` always counts, even with an expired/missing timer. This checkpoint never writes ACTIVE, releases ACTIVE or transfers an active media connection. Missing owner/ID on a legacy live reservation is conservatively blocked until expiry. Membership status, roles, hands and approval records are unchanged by claim/cancel.
- Media token issuance and connection are coupled to the current reservation generation. Once a token is issued, simple reservation expiry is not proof it cannot still connect: the server uses bounded JWT/held-seat lifetime, LiveKit reconciliation, and confirmed revocation before freeing capacity. Kicked and ended users follow the same conservative removal rule. No Cloud webhook to localhost is assumed.

Implementation: [seat service](../src/lib/room-seats.ts), [seat panel](../src/components/seat-panel.tsx), [isolated SQLite / process tests](../tests/room-seats.test.ts). The narrow cross-process tests exercise the installed adapter against one local database file; they do not certify a distributed deployment or real media capacity. The additive migration preserves existing memberships/leases and adds nullable page-owner/reservation columns.

## Media grants

| Route under `/api/rooms/:roomId` | Input and effect                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /token`                    | Strict `{clientId, reservationId, takeover?: boolean}`; current Session, OPEN room, valid approved membership and matching reservation; returns `{token, serverUrl, identity, roomName, reservationId, expiresAt}` |
| `DELETE /token`                  | Strict `{clientId, reservationId}`; same authority, current page owner; revoke Cloud identity then clear exactly that SQL generation; stale ID is a no-op                                                          |
| `POST /media-sync`               | Strict `{}`; same current SQL authority; reconcile held identities against a server-side Cloud participant query, never a client-supplied online flag                                                              |

- All routes use exact-origin/JSON/4 KB safeguards and private no-store responses. Local limits are 20 Token/release commands and 12 sync calls per user/minute. Unexpected SDK/SQL errors are redacted and retriable, not success. The API key/secret pair is configured only on the server, and the secret is never returned; the key identifier is readable in the SDK JWT's `iss` claim and is not confidential. Page IDs are not credentials. See the [environment and secret boundary](../README.md#environment).
- Token issuance writes `mediaIdentity`, `mediaTokenExpiresAt`, `mediaAbsentSince`, `mediaRevoking` before network calls. This conservative durable hold survives request failure or server restart even if signing never happens. Network I/O never holds the SQL write lock. After preparing Cloud, a second write transaction checks the persisted Session ID/expiry, room, membership, owner and reservation generation before local signing. Logout/kick/closure/takeover during I/O cannot use an earlier snapshot to obtain a Token.
- Initial issuance gives a fixed window of at most 60 seconds; retries reuse the identity/deadline. Expired grants require release/reconcile or explicit new-page takeover, not silent renewal. JWT expiry limits initial connect, not an ongoing LiveKit session or its refreshed Tokens, so **issued capacity never expires solely by time**.
- All roles receive the same room-scoped camera/microphone/screen-share publish and subscribe grants. No room administration, recording, arbitrary data publishing or self metadata updates. Business roles, hands/focus, and chat remain server-authorized SQL operations. Room name is hashed from the internal room ID and participant identity is a fresh opaque UUID, not an email. The display name remains the user's chosen public meeting name.
- Before signing, `createRoom` must return maxParticipants 8. JWT `roomConfig` also specifies 8 for auto-recreation after an empty room vanishes. The adapter intentionally targets standard LiveKit Cloud only; it uses server SDK 2.19.0, a 10-second request timeout and no automatic region retry loop.
- On explicit takeover, the old media identity is marked revoking while its seat remains counted. Cloud `RemoveParticipant` uses an explicit `revokeTokenTs` cutoff (server now + 10 seconds, within Cloud's documented 60-second window), including absent participants. A subsequent participant query must not find that identity. Only then can the SQL row atomically become a new identity, page owner, reservation ID and initial window; no release gap admits a ninth person. Hand/focus is cleared. The old page never automatically takes back ownership.
- Release follows the same mark → Cloud revoke/absence → exact-generation SQL clear pattern. Partial failure holds capacity and blocks old-page signing until retry/cleanup succeeds. Cleanup may finish after logout/kick/closure but can only clear the exact already-revoked identity, never restore membership or clear a replacement. It preserves KICKED and maps ACTIVE to LEFT.
- Sync changes SQL to ACTIVE only when Cloud reports that same current identity. Absence retains the seat until both the original Token window has elapsed and at least 30 seconds have passed since absence was observed, followed by confirmed revocation. Revoking/kicked holds are revoked immediately. Cloud errors retain the hold. No poll extends a grant. Never treat a JWT alone as proof of ACTIVE.
- Reconciliation is an application service, **not** a scheduler or localhost webhook. The client calls it before entry and on a non-overlapping 20-second timer while the waiting page is visible or a connection is live. Cleanup with no remaining page waits for the next eligible page or entry request. Room-wide ending and kick use explicit Cloud revocation; denying new tokens alone is not proof of disconnection.

Implementation: [Cloud adapter](../src/lib/livekit.ts), [SQL/media orchestration](../src/lib/room-media.ts), [media contract tests](../tests/room-media.test.ts), [opt-in Cloud smoke](../scripts/smoke-livekit.ts). Unit/integration tests use actual SQLite/session/SDK JWTs with synthetic keys and mocked Cloud transport. Current real-service results and limitations are recorded in [verification evidence](VERIFICATION.md).

## Browser media lifecycle

- A fresh mount gets a unique page ID. Join is explicit: reconcile → current seat → reserve if needed → request Token/takeover of observed generation → verify current ownership → SDK connect. A different foreign generation discovered after the click returns conflict, never implicit takeover. The Token remains in the request/SDK memory; SDK verbose logs are disabled and no credentials enter browser storage or application URLs.
- `MeetingSession` fences asynchronous continuations with an operation number. Stop/unmount invalidates pending work; a late successful Token response is released using its exact reservation ID, and a late SDK connect is disconnected. Cleanup errors never fabricate server release. Terminal SDK disconnection does not cause fresh Token acquisition. Network retries use the same SDK session and stop scheduling after 20 seconds elapsed; media revoke/identity checks remain authoritative.
- Camera and microphone start off; preview asks for camera only, publishes nothing and has explicit cancellation. Preview stop/join/unmount stops tracks, including late responses after cancellation. Device commands are serialized and show bounded errors without raw driver details. The microphone is tested through explicit in-meeting enable, not automatically captured for preview. This version uses default browser inputs; no device chooser or recording is included.
- Leave detaches the local room/stops tracks before requesting generation-fenced server release. Refresh exposes held access for retry on failure. Pagehide/unmount stops local media but does not rely on unload delivery to release SQL capacity. Unexpected disconnect does not automatically claim another seat.
- Cloud/SQL refresh is serialized per page and paused while joining/leaving; no 5-second host-review refresh calls Cloud. On lost ownership or denied access the page disconnects. On failed verification beyond 45 seconds since the last success, an attempted check stops local media; timer throttling/network timeout can delay this, so it is not a server-enforced deadline.
- Rendering reuses RoomContext, RoomAudioRenderer, VideoTrack, useTracks and useParticipants, with custom markup/styles and explicit controls. See the [product walkthrough](WALKTHROUGH.md), [client flow](../src/lib/meeting-session.ts), and [injected transport tests](../tests/meeting-session.test.ts).

## Meeting layout and screen share

- Camera and screen-share publications are mapped into custom neutral UI rather than the stock LiveKit meeting page. Gallery mode keeps the local participant first; a share moves all camera tiles into a filmstrip and renders one screen track in the main stage. Remote audio, including any published share audio, remains handled by `RoomAudioRenderer`; this UI only requests video screen capture itself.
- The pure layout rule is `screen share > valid focus > gallery`. The selector verifies that stopping a share restores a still-valid focus and otherwise restores the gallery. A departed or stale focused identity cannot create an empty stage.
- The client disables starting its own share while it observes a remote share, but transport races can still yield multiple publications. The primary share is therefore selected by stable media identity on every client. This is a display rule, not server authority or proof that only one publication exists.
- Starting/stopping a local share uses LiveKit's local participant API and the same serialized device-operation guard as microphone/camera controls. Cancellation or browser denial does not disconnect the room. Leaving, takeover, and access-loss cleanup stop every local publication through the shared browser-media lifecycle.
- Tests cover priority, restoration, and deterministic simultaneous-share selection without Cloud or capture permission. Actual capture pixels and a true narrow-viewport pass remain manual evidence gaps. See the [product walkthrough](WALKTHROUGH.md), [selector](../src/lib/meeting-layout.ts), and [layout tests](../tests/meeting-layout.test.ts).

## Durable collaboration and moderation

- `POST /messages` accepts one trimmed message of 1–2000 characters from an ACTIVE member in an OPEN room. It inserts the message before broadcasting an invalidation packet. `GET /collaboration` returns at most the latest 50 messages and non-kicked member state; an ACTIVE manager additionally sees pending KICKED media removals they are permitted to retry. Kicked/nonmembers cannot read it.
- `PATCH /hand` lets an ACTIVE member toggle their own hand. Host/Moderator may lower another ACTIVE member's hand, never raise it for them. `PATCH /focus` lets Host/Moderator focus one ACTIVE target or clear focus. Every action is authorized again inside the SQL write transaction.
- Data packets use the server-only Room Service client and topic `learning-guide`. Participant JWTs retain `canPublishData: false`. Packets contain a version, event kind and optional entity ID only; clients use them to refetch SQL and do not apply roles, messages or focus directly. Visible tabs also poll every five seconds because even reliable packets are not durable or buffered.
- Client reads use a generation fence so a late snapshot/error cannot replace a newer result or survive cleanup. Initial read failure remains retryable. An acknowledged command remains successful if the following refresh fails; clients never automatically resend it. A lost POST response is still ambiguous: there is no message idempotency key or exactly-once guarantee.
- `DELETE /members/:userId/role` is the kick command. SQL changes the member to KICKED and clears dependent hand/focus state before Cloud removal. A failed removal retains the exact media identity and returns a retryable error; the business ban is already effective. Successful retries clear only the matching generation. Host cannot be kicked; Moderator cannot kick peers.
- `POST /end` is Host-only and accepts OPEN or a retryable ENDING room. OPEN becomes ENDING before external calls. The server revokes every retained identity, deletes/verifies the Cloud room, clears media holds, maps ACTIVE/APPROVED members to LEFT, then writes ENDED. Any external failure keeps ENDING and capacity conservatively held for a later retry.
- Screen share remains above moderator focus; focus remains above gallery. A focused user without a current camera still gets a named placeholder. A LEFT/kicked target is normalized away by the collaboration snapshot.

Implementation: [collaboration service](../src/lib/room-collaboration.ts), [server Cloud adapter](../src/lib/livekit.ts), [meeting panel](../src/components/collaboration-panel.tsx), [end control](../src/components/room-end-panel.tsx), and [SQL/permission tests](../tests/room-collaboration.test.ts). Real two-browser and Cloud evidence is in [verification evidence](VERIFICATION.md).

## Post-session summary

- Existing non-kicked members may read a summary only after the room is ENDED. Only the consistent Host membership may start/retry generation; Host need not remain ACTIVE. The browser sends `{}` and cannot submit its own transcript, prompt, model, role or token accounting.
- The server reads at most the newest 100 persisted chat messages and constructs a chronological source capped at 1,000 characters per message and 12,000 characters total. The provider receives room title/topic plus that source only—no audio/video, sessions, email addresses, invitation data or media credentials.
- Summary rows use `PENDING → GENERATING → READY | FAILED`. GENERATING has a random `attemptId` and two-minute lease. A fresh lease rejects concurrent clicks; a stale lease may be replaced. Provider completion/failure updates only the matching attempt, so a delayed result cannot overwrite a newer retry. READY is idempotent and never spends again.
- An authorized summary read expires abandoned GENERATING rows to FAILED under the same room write lock, clearing the attempt ID. Polling therefore exposes a working Host retry button even after an app restart; a late result from the expired attempt is rejected. No read automatically calls DeepSeek. Initial read failure and stalled reads have bounded retry/refresh controls in the UI.
- Empty chat becomes a persisted FAILED result without contacting DeepSeek. Missing configuration, rejection/balance, timeout and invalid output are converted to bounded safe errors; raw response bodies and secrets are not logged. Host may explicitly retry FAILED. The local endpoint allows three POST attempts per user per minute.
- The DeepSeek adapter defaults to `deepseek-v4-flash`, disables thinking, caps output at 700 tokens and accepts only a normal complete response up to 8,000 characters. It stores returned model, prompt tokens, completion tokens and source message count. The UI renders output as plain text and labels it as based on written chat only.

Implementation: [summary orchestration](../src/lib/room-summary.ts), [DeepSeek adapter](../src/lib/deepseek.ts), [summary route](../src/app/api/rooms/[roomId]/summary/route.ts), [summary panel](../src/components/summary-panel.tsx), and [isolated SQLite/provider tests](../tests/room-summary.test.ts). Real-service evidence and actual token use are in [verification evidence](VERIFICATION.md).
