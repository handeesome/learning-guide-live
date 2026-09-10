# Product roadmap

Learning Guide Live currently supports the complete small-group room lifecycle: authentication, invitations, approval, bounded admission, LiveKit media, durable collaboration, moderation, ending, and chat-based summaries.

The roadmap below describes possible product evolution. It is not a promise of delivery order.

## Reliability and scale

- Move durable application state from local SQLite to PostgreSQL for multi-instance deployment.
- Replace process-local rate limits with a shared limiter and add explicit client idempotency keys for chat commands.
- Run media reconciliation in a reachable background worker or authenticated webhook flow instead of relying on active pages.
- Add structured metrics for admission, revocation, room teardown, and summary failures.

## Media experience

- Add microphone, camera, and speaker device selection.
- Complete a browser/device compatibility matrix for camera, microphone, autoplay, screen sharing, and reconnect behavior.
- Add network-quality indicators and clearer degraded-connection states.
- Expand responsive and keyboard-only validation across meeting layouts.

## Collaboration

- Add cursor-based chat history pagination and message-level retry/deduplication.
- Add optional invitation delivery integrations without exposing invitation codes to logs or analytics.
- Add room discovery filters, search, and host-managed room metadata updates.

## Operations and security

- Add CI across supported Node versions and operating systems.
- Define production secret rotation, account recovery, moderation audit, retention, and deletion procedures.
- Add load, abuse, and multi-region failure testing before public deployment.
- Re-evaluate dependency advisories whenever Prisma or the database topology changes.
