# Verification evidence

Last updated: 2026-09-10.

## Current automated evidence

The checked application revision passed:

- Prettier formatting validation;
- Next.js route type generation and TypeScript checking;
- 99 Node test-runner cases with 99 passing;
- the complete offline journey smoke;
- Prisma client generation and production Next.js build;
- production startup followed by the local HTTP foundation smoke.

The test suite uses real Better Auth handlers, Prisma/SQLite transactions, application route/services, and LiveKit JWT signing. External Cloud transport and the LLM provider are injected fakes unless a check is explicitly labeled real-service.

The public-release documentation and brand pass then changed only documentation, package metadata, comments, and visible product naming. Its focused checks found valid local links across 13 Markdown files, no retired planning terminology in the current tree, a passing TypeScript check, 8/8 passing authentication/foundation tests, and a fresh production build after the rename. The unchanged business logic continues to use the 99-test evidence above.

The repository includes a GitHub Actions workflow for formatting, types, tests, the offline journey smoke, and the production build. It has been reviewed and formatted locally; the first hosted run must be confirmed in GitHub Actions after the initial push.

## Reproducibility evidence

An isolated copy created from tracked content successfully:

1. generated a unique local configuration;
2. applied all four committed migrations;
3. seeded three synthetic accounts, four rooms, and historical messages;
4. ran the offline journey, formatting, type, and 99-test checks;
5. built and started the production application;
6. passed the HTTP authentication/history smoke;
7. removed its temporary database and verification directory.

On this Windows host, two clean `npm ci` attempts downloaded the package graph but lost the `better-sqlite3` prebuilt-binary connection. npm then attempted a source build, which requires an unavailable Visual Studio C++ toolchain. An offline `npm ci --ignore-scripts` installed the cached 250-package graph; the isolated run used the same-version native binary from the already verified checkout, with matching SHA-256 before and after the copy. The application checks above are valid, but this is not evidence that the host completed a fresh native-binary download.

## Real-service evidence

### LiveKit Cloud

- Server credentials authenticated against a standard LiveKit Cloud project.
- The management smoke created a random room with an eight-participant limit, verified a scoped JWT locally, queried participants, confirmed absent-identity revocation, and removed its own room.
- Two independent browsers connected with devices off and observed participant presence, explicit leave, and same-account takeover.
- A two-browser room synchronized durable chat, hand state, focus, role changes, server-side kick, and room ending. The kicked participant disconnected and could not regain application access.

### DeepSeek

- One controlled request used an ended synthetic room with two written messages.
- The request selected `deepseek-v4-flash`; the provider returned model `deepseek-flash`.
- Provider-reported usage was 169 prompt tokens and 61 completion tokens.
- The READY summary persisted across refresh and did not generate again.

## Known evidence gaps

- Camera and microphone publication were not completed in the automated browser environment.
- Screen-share layout logic is tested, but actual shared pixels were not transmitted during automation.
- Manual replay of an already issued old JWT and a full narrow-viewport browser pass remain unrecorded.
- Real-service smoke is not load, regional-failure, browser-matrix, or production-security testing.

These gaps are intentionally kept distinct from passing fake-adapter and layout tests.

## Dependency audit

`npm audit` and `npm audit --omit=dev` currently report four high-severity entries through Prisma CLI's transitive `deepmerge-ts` and `mysql2` dependencies, with zero critical entries. npm's offered automatic change is a cross-major downgrade from Prisma 7.10.0 to 6.19.3 rather than a compatible Prisma 7 patch, so no forced audit fix was applied. The current application uses local static Prisma configuration and SQLite rather than MySQL; this applicability assessment is not a complete security audit.
