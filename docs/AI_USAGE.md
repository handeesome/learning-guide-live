# AI-assisted development

Learning Guide Live was developed with substantial assistance from OpenAI Codex. Assistance included implementation drafts, test generation, repository inspection, API research, browser automation, and documentation review.

AI output was not treated as verification by itself. Observable behavior was checked through isolated SQLite integration tests, permission and concurrency tests, production builds, local HTTP smoke tests, controlled LiveKit Cloud flows, and one bounded DeepSeek request. Known device and screen-capture evidence gaps remain documented in `VERIFICATION.md`.

## Product AI feature

The application uses DeepSeek only for post-session summaries of persisted written chat. The server:

- accepts generation only from the Host of an ended room;
- reads a bounded number of recent messages and limits transcript/output size;
- labels room metadata and chat as untrusted source material;
- sends no audio, video, email addresses, invitations, sessions, or media tokens;
- stores result status, model, source count, and provider-reported token usage;
- prevents concurrent or delayed attempts from overwriting a newer result;
- exposes failures for explicit retry rather than fabricating a summary.

Automated tests and `npm run smoke:delivery` inject a fake provider so they are deterministic and make no paid request. Real-provider evidence is recorded separately in `VERIFICATION.md`.

## Reuse and attribution

No website template, default LiveKit Meet page, copied product design, or generated image set is included. The UI and application composition are project-specific.

The runtime builds on Next.js/React, Better Auth, Prisma/better-sqlite3, LiveKit client/server SDKs, Zod, and DeepSeek's HTTP API. Versions are locked in `package-lock.json`; documentation and advisory references are listed in `REFERENCES.md`.

## Data and secrets

Demo identities and conversations are synthetic. Secrets, session cookies, participant tokens, local databases, generated clients, build output, logs, and temporary browser/test artifacts are excluded from version control. AI summaries never receive recorded media because the application does not record or transcribe it.
