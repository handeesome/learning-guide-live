# Technical references and dependency notes

Last reviewed: 2026-09-10. External documentation and pricing can change; implementation behavior is also checked against installed types and executable tests.

## Application stack

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation): App Router, local development, and production builds. The project currently uses Next.js 16.3.4 and Node.js 24 for verification.
- [Better Auth installation](https://better-auth.com/docs/installation), [Prisma adapter](https://better-auth.com/docs/adapters/prisma), and [Next.js integration](https://better-auth.com/docs/integrations/next): email/password authentication and persisted sessions.
- [Prisma SQLite quickstart](https://docs.prisma.io/docs/prisma-orm/quickstart/sqlite): Prisma 7.10.0 with the better-sqlite3 adapter and committed SQL migrations.
- [SQLite transactions](https://www.sqlite.org/lang_transaction.html): SQLite write serialization and transaction-upgrade behavior. Application writers acquire the write lock before mutable authorization/capacity reads.

## LiveKit

- [Tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/): participant token lifetime and grants. Initial JWT expiry does not terminate a connected client that receives refreshed tokens.
- [Rooms, participants, and tracks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/): participant removal and Cloud token revocation behavior.
- [Room management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/rooms/) and [server SDK](https://docs.livekit.io/reference/server-sdk-js/): room capacity, create/query/delete, and participant management.
- [Room Service API](https://docs.livekit.io/reference/other/roomservice-api/): server-side `SendData`, `RemoveParticipant`, and `DeleteRoom` operations.
- [Data packets](https://docs.livekit.io/home/client/data/packets/): packets are not durably buffered, so the application uses them only as invalidation hints.
- [JavaScript client Room](https://docs.livekit.io/reference/client-sdk-js/classes/Room.html) and [LocalParticipant](https://docs.livekit.io/reference/client-sdk-js/classes/LocalParticipant.html): connection, devices, publication, and cleanup APIs.

The project locks `livekit-server-sdk@2.19.0`, `livekit-client@2.22.3`, and `@livekit/components-react@2.9.24`. It reuses SDK primitives and small React components but does not use the default LiveKit Meet page or copy a meeting template.

## DeepSeek

- [Models and pricing](https://api-docs.deepseek.com/quick_start/pricing/): available models and token-based charging.
- [Chat completions](https://api-docs.deepseek.com/api/create-chat-completion/): non-streaming message requests and usage fields.

The adapter sends bounded persisted written chat, disables thinking, caps output, validates completion/usage, and stores only the accepted result plus accounting fields. API keys remain server-side.

## Dependency advisory notes

`npm audit` currently reports four high-severity entries in the Prisma CLI dependency chain:

| Advisory                                                                                                                                                                            | Applicability                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [deepmerge-ts recursive graph stack exhaustion](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)                                                                                  | Reached through `@prisma/config`; the project uses local static configuration and does not merge user-created recursive graphs. The finding remains unresolved in the lockfile. |
| [mysql2 authentication downgrade](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr) and [compressed protocol decompression DoS](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3) | Reached through Prisma CLI tooling; the application is configured only for SQLite and does not connect to MySQL. The finding must be reassessed if that changes.                |

npm currently offers Prisma 6.19.3 as the automatic change and marks it semver-major relative to the installed Prisma 7 toolchain. This would be a cross-major downgrade of the current adapter/configuration path, not a compatible patch, so no forced audit fix is applied. This is an applicability assessment, not a complete security audit.

## Reuse and templates

No website template, generated image set, copied product design, or default LiveKit meeting page is included. The interface and application composition are project-specific. Open-source packages and versions are recorded in `package-lock.json`; their own license terms continue to apply.
