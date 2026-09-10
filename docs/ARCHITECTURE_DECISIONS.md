# Architecture decisions

This document records the design choices that shape the current implementation. Each decision describes the technical reason and its consequences rather than the development chronology.

## ADR-001: One Next.js application

**Status:** Accepted

The React interface and server routes live in one TypeScript/Next.js repository. This keeps authentication, input validation, rendering, and business services close enough to change coherently while preserving a clear boundary between browser code and server-only credentials.

**Consequence:** deployment is simple, but long-running background work and independent service scaling would require additional infrastructure.

## ADR-002: SQLite with Prisma for local-first state

**Status:** Accepted

SQLite matches the current local, single-instance runtime. Prisma supplies a typed schema and committed additive migrations. Room-scoped writes acquire SQLite's write lock before reading mutable authorization or capacity state, which prevents concurrent local processes from both claiming the final seat.

**Consequence:** the transaction design is valid for one SQLite database, not a claim of distributed admission safety. A public multi-instance deployment should move to a managed relational database and retest transaction semantics.

## ADR-003: SQL owns business authority

**Status:** Accepted

Approval, roles, capacity, hand state, focus, kicked status, history, and room lifecycle are durable application concepts. LiveKit transports media and invalidation hints but does not replace those rules. Every mutation reloads current session and SQL state; browser-supplied roles or online flags are never trusted.

**Consequence:** clients can recover after missed real-time packets by refetching SQL. Media and business state can temporarily diverge, so reconciliation and conservative intermediate states are required.

## ADR-004: Approval, seat, and token are separate grants

**Status:** Accepted

Approval grants durable eligibility. A seat represents scarce room capacity. A participant token grants short-lived access to one opaque LiveKit identity. Separating them prevents waiting users from consuming seats and prevents a stale page from silently reclaiming a newer connection generation.

**Consequence:** joining requires several checked steps, but each step has a precise failure and retry boundary.

## ADR-005: LiveKit Cloud for real-time media

**Status:** Accepted

LiveKit Cloud supplies WebRTC signaling, SFU transport, TURN support, participant management, and room deletion. The server SDK creates scoped participant tokens and performs exact-identity revocation; the browser never receives management credentials.

**Consequence:** real media depends on an external service. Cloud calls stay outside SQL transactions, and failures retain capacity until revocation or absence is confirmed.

## ADR-006: Persist first, signal second

**Status:** Accepted

Chat, hand, and focus changes are committed to SQL before the server broadcasts a LiveKit data packet. Packets tell clients to refresh; they do not carry authoritative role or state changes.

**Consequence:** a failed packet cannot lose accepted data. Visible clients poll as a recovery path because reliable data packets are retransmitted but not durably buffered.

## ADR-007: Durable intermediate states around external work

**Status:** Accepted

Kick marks a member KICKED before media revocation. Room end writes ENDING before teardown and writes ENDED only after Cloud cleanup. Summary generation writes GENERATING with an attempt ID before calling DeepSeek. Exact identity/attempt fences prevent delayed responses from overwriting newer state.

**Consequence:** partial failure is visible and retryable. The system favors conservative retained capacity over false success.

## ADR-008: Chat-only post-session summaries

**Status:** Accepted

The summary source is bounded persisted written chat plus room metadata. Audio and video are neither recorded nor transcribed. Only the Host can start or retry generation after the room ends; eligible members can read the persisted result.

**Consequence:** the summary cannot claim to represent unheard speech. Provider usage and result state remain inspectable without storing raw provider responses.
