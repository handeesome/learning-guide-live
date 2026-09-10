# Product walkthrough and engineering rationale

## Ten-minute walkthrough

Use two independent browsers and synthetic accounts. Start with camera and microphone off; use headphones if audio will be enabled.

1. Sign in as Alex in browser A and Morgan in browser B.
2. As Alex, create a room with a title, description, and learning topic. Show it in the directory and detail view.
3. Create a 15-minute invitation and open it in browser B. Morgan requests entry. The request creates neither a seat nor a media token.
4. Alex approves Morgan and promotes Morgan to Moderator. Explain that approval, capacity, and media authority are separate server decisions.
5. Join from both browsers with devices off. Show participant presence and the two-of-eight capacity state.
6. Exchange messages, raise and lower a hand, set and clear focus, and refresh one page to show recovery from durable SQL state.
7. If browser permissions allow it, share only a safe blank/test window. Show the shared main stage and camera filmstrip, then stop sharing and confirm that focus or gallery is restored.
8. Use a Participant target to demonstrate a Moderator kick. Confirm that the removed browser disconnects and cannot read history or request a new token.
9. As Alex, end the room. Explain why `OPEN → ENDING → ENDED` exposes retryable teardown instead of displaying false success.
10. Generate the chat-only summary once, then refresh to show that the result and provider usage are persisted.

Invitation rejection, expiry, and the ninth-seat boundary can be demonstrated deterministically with `npm run smoke:delivery` when creating many browser identities would distract from the main path.

## Engineering rationale

### Why LiveKit Cloud?

It supplies managed WebRTC signaling, SFU transport, TURN infrastructure, and participant management. The application still owns admission, roles, capacity, history, and moderation; Cloud is media infrastructure rather than the business database.

### What does the application server own?

It authenticates sessions, validates same-origin inputs, executes authorization and transactions, manages seats and token generations, calls Room Service for revocation/ending, persists collaboration state, and calls DeepSeek only after a room ends. Browser state never grants an administrative capability.

### Why SQLite and explicit write transactions?

SQLite keeps the local-first deployment small. A room-scoped write lock is acquired before mutable authorization and capacity reads, preventing concurrent local processes from both winning the final seat. This choice would be revisited for multi-instance deployment.

### Why separate approval, seats, and tokens?

Approval is durable eligibility, a seat is capacity, and a token is bounded media authority for one opaque identity. The separation prevents waiting users from consuming seats and lets the server recheck authority after Cloud work.

### How are real-time updates made durable?

The server writes SQL before broadcasting a LiveKit invalidation hint. Clients refetch the source of truth and poll while visible because data packets are not a durable queue.

### Why is kicking more than hiding a tile?

SQL first marks the member KICKED, which immediately blocks history and new tokens. Room Service then revokes the precise current identity. If Cloud fails, the retained identity and retry control remain visible to an authorized manager.

### How do screen share and focus coexist?

The deterministic display rule is screen share, then a still-valid moderator focus, then gallery. Stopping a share restores focus only if the focused media identity remains active; otherwise the UI returns to the gallery.

### How are partial failures handled?

Chat remains readable when signaling fails. Kick and leave retain media holds until exact revocation succeeds. Room ending remains ENDING until Cloud cleanup completes. Summary attempts use durable status and an attempt fence so delayed provider responses cannot overwrite a retry.

### What would change for production?

A public multi-instance deployment would need shared rate limiting, managed relational storage, background reconciliation, observability, secret rotation, account recovery, retention/deletion policies, and broader browser/load/security testing.
