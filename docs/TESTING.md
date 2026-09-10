# Testing strategy

## Standard checks

Use Node.js 22.22 or newer:

```sh
npm run format:check
npm run typecheck
npm test
npm run smoke:delivery
npm run build
```

The test suite runs serially because many integration cases create isolated SQLite databases and exercise transaction boundaries. Tests cover positive, negative, concurrency, stale-generation, and external-failure behavior.

## Test layers

| Layer                      | Main evidence                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Pure policy/state tests    | Room lifecycle, role/target permissions, layout priority, latest-read fencing, meeting-session ordering                            |
| SQLite integration tests   | Authentication, invitations, review, capacity, cross-process contention, media grants, collaboration, moderation, summary recovery |
| Route tests                | Session identity, origin/JSON/body limits, no-store responses, strict inputs, error redaction                                      |
| Offline journey smoke      | Registration through persisted summary using real application services and fake external adapters                                  |
| Local HTTP smoke           | Protected pages, room history, login, and logout revocation against a running production server                                    |
| Opt-in real-service checks | LiveKit room management, two-browser presence/collaboration/moderation, and one bounded DeepSeek summary                           |

## Offline journey smoke

`npm run smoke:delivery` creates an ignored random directory under `.tmp`, applies every committed migration, seeds synthetic data, and then verifies:

1. registration and sign-in;
2. room creation and expiring invitations;
3. request approval and rejection;
4. Host assignment of a Moderator;
5. eight occupied seats and rejection of the ninth;
6. token orchestration through a fake LiveKit adapter;
7. chat, hand, focus, Moderator kick, and explicit leave;
8. room ending and rejection of post-end chat;
9. persisted summary generation through a fake provider.

The script removes only its own verified temporary directory. It makes no LiveKit Cloud or DeepSeek request and must not be cited as external-service evidence.

## Real-service boundaries

`npm run smoke:livekit` is opt-in. With server-only credentials it creates one random temporary Cloud room, confirms capacity configuration and participant-management access, then deletes only that room. It does not publish device media.

Two independent browser sessions are the appropriate check for participant presence, real-time chat, role changes, focus, kick, and room ending. Camera, microphone, autoplay, and screen capture require explicit browser/device permission and should be tested with synthetic accounts and non-sensitive content.

DeepSeek validation should use a small ended room containing synthetic written chat. A READY result must persist across refresh and must not trigger a second provider call. Deterministic failure and concurrency branches remain covered by injected-provider tests.

## Safe test data

- Never reset or delete an existing user database to make a test pass.
- Use disposable SQLite paths and synthetic users for automated checks.
- Keep `.env`, databases, tokens, logs, generated clients, dependencies, build output, and temporary browser artifacts out of Git.
- Do not display or log API secrets, participant tokens, session cookies, invitation codes, or raw provider error bodies.

See [verification evidence](VERIFICATION.md) for the most recent recorded results and [references](REFERENCES.md) for dependency advisory notes.
