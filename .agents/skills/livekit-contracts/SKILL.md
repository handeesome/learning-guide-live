---
name: livekit-contracts
description: Implement or review this project's LiveKit admission, roles, room limits, chat, hand raising, focus, kick, and ended-room behavior when a change crosses SQL business state and real-time media authority.
---

# Business and media contract

Read `docs/DESIGN.md`, `docs/ARCHITECTURE_DECISIONS.md`, and `docs/ROOM_RULES.md` first. Consult current official LiveKit API docs only for the behavior being implemented; this skill does not pin API signatures.

- Keep the business database authoritative for identities, approvals, roles, kicked/ended status and history. Room membership history is not an online participant counter.
- Enforce eight seats including host with atomic admission and defined reservation expiry; check simultaneous approvals and rejoin paths. Use the media server's limit as defense in depth, not a substitute for business constraints.
- Invitations expire and do not bypass authentication or host approval. Mint bounded, room-scoped tokens only on the server after checking current authorization.
- Inspect already-issued token behavior when implementing kick/end; combine business revocation with real Room Service operations and visible error/retry handling. Do not call a UI removal a kick.
- Define ownership, payload and initial-state source for each custom event. Hand/focus management requires host/moderator authority; ordinary clients must not spoof administrative events.
- Persist authorized chat before broadcast, deduplicate by message ID and reconcile recent history. Explicitly handle database success + broadcast failure.
- Render screen share, focus and gallery according to the decided priority across all clients. Clear stale focus when its participant leaves.
- Do not assume cloud webhooks can reach localhost. Specify reachable callbacks or use the documented local polling/reconciliation strategy.
- Separate leaving from ending, business lifetime from ephemeral LiveKit room lifetime, and temporary disconnect from permanent removal.
- A chat-based summary is not an audio transcript. Preserve source scope, idempotency, failure and retry state.

At a coherent batch boundary test only the touched risks: unauthorized token/action, expired invite, ninth/concurrent seat, kicked/ended reentry, chat history, custom state and real disconnect as applicable. Full suite at integration/final gates; no repeated paid/media calls for cosmetic changes.
