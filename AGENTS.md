# Learning Guide Live contribution instructions

## Start and scope

- Read `README.md`, `docs/DESIGN.md`, `docs/ARCHITECTURE_DECISIONS.md`, and the relevant contract before changing behavior.
- Preserve existing work. Start with `git status --short` and a short recent log, then inspect relevant files with `rg`.
- Keep changes inside the product's current domain: authenticated study rooms, bounded admission, LiveKit media, durable collaboration, moderation, and chat-based summaries.
- Prefer a small vertical slice over speculative architecture, broad dependency upgrades, or unrelated cleanup.
- Record reusable technical decisions and evidence, not personal context or chat transcripts.

## Work in coherent batches

- Select one bounded, observable outcome and completion criteria before editing. Implement its related changes together.
- Prefer a small vertical slice over speculative architecture, unrelated refactors, broad dependency upgrades, or isolated cosmetic edits.
- Reuse maintained components with attribution. Never submit the default LiveKit Meet page as the product.
- Search official documentation only when a relevant API/version or behavior is uncertain; do not repeat settled research every session.
- Explain completed architectural choices through code, tests, and architecture notes.
- Keep progress updates concise. Do not narrate unchanged checks, repeated plans, or every file edit.
- Keep source readable rather than compressing JSX, TypeScript, CSS, or configuration onto single lines. At each coherent code or documentation batch boundary, run `npm run format` before reviewing the diff; use `npm run format:check` when only a non-mutating formatting check is appropriate. Formatting is not a substitute for the risk-based verification below.

## Risk-based verification

| Change                                           | Default check at batch boundary                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Docs, comments, agent instructions               | Relevant diff, links, syntax; no app build or business tests                    |
| Styling/layout only                              | Focused visual inspection; no repeated live-media/LLM calls                     |
| Local business behavior                          | Relevant unit/API tests; add coverage for the changed observable requirement    |
| Auth, admission, SQL constraints, permissions    | Targeted positive and negative cases, including relevant concurrency boundaries |
| Cross-layer integration, dependency/build config | Relevant integration/type/build checks once after the batch                     |
| Release or broad integration                     | Full agreed check set, reproducible setup and controlled live-service smoke     |

- Do not run test/build/lint after every small edit or file. Do not run an application suite merely because a commit is about to happen.
- Choose checks that could detect a plausible regression; state the reason when expanding beyond the default.
- Reuse passing evidence if the checked code, dependencies and relevant environment are unchanged. Documentation-only changes do not invalidate business-test evidence.
- Record command, checked revision or changed-file scope, result, and limitations in `docs/VERIFICATION.md` when the evidence materially changes.
- On failure, inspect evidence and make a hypothesis-driven fix before rerunning the failed subset. After two unsuccessful attempts with no new evidence, change diagnostic approach or report the actual missing input; do not spin or hide failure.
- Avoid duplicate test runs on the same code revision. Use one scoped review, fix substantive issues, then recheck affected behavior.
- Mock tests are not proof that real media or LLM integration works. Mark real-service and device evidence separately.
- Do not replace useful negative tests with superficial “green” tests, weaken assertions to pass, or claim reduced token use has been measured when it has not.

## Domain guardrails

- SQLite is authoritative for identity, approval, roles, capacity, hand/focus state, kicked/ended status, history, and summary state.
- LiveKit handles media transport and server-managed participant operations. Data packets are invalidation hints, never durable business authority.
- Keep approval, capacity reservation, and participant-token issuance as separate checked steps.
- Keep external network calls outside SQL transactions and fence their results with the exact identity, reservation generation, or summary attempt.
- Preserve deterministic display priority: screen share, then valid focus, then gallery.

## Security and real-service boundaries

- LiveKit API secrets, LLM keys, passwords, session cookies and tokens never go in frontend bundles, logs, screenshots, Git or chat. Use server-only env variables; `.env.example` contains placeholders only.
- Never trust a client-supplied role, room approval, hand-management or focus-management event without server authority.
- Enforce max eight participants, host approval, role permissions and ended/kicked membership on the server. Check current LiveKit behavior for already-issued tokens; UI-only blocking is insufficient.
- No production user data, audio recording or transcription by default. Do not invent meeting content that was not in the LLM input.
- Do not make paid service calls, publish, deploy, or push without explicit authorization.
- Configure credentials through server-only environment variables; never request that secrets be committed or displayed.
- Never delete a user database or overwrite user changes to make seed/tests pass. Use isolated test data and explicitly safe targets.

## Repository hygiene

- Commit coherent product changes or meaningful fixes rather than every tiny edit.
- Before committing, inspect staged filenames/diff for unrelated files and secrets. Stage named paths; do not blindly add everything. Local commits are authorized; pushing is not.
- Keep generated files, dependency folders, local databases, real env files and private review artifacts out of Git. Commit migrations and a lockfile when they exist.
- Update architecture decisions, verification evidence, and the roadmap only when their public project state changes.
- Keep README and documentation links valid. Describe known limitations without presenting mock or layout evidence as real media behavior.
