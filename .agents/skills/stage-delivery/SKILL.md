---
name: stage-delivery
description: Execute a bounded product change, select proportionate verification, and make a meaningful Git checkpoint without repeating unchanged work.
---

# Bounded change delivery

Read `AGENTS.md` and the relevant architecture, contract, and verification documents. Reuse already loaded, unchanged context.

1. Establish the intended outcome, affected files/layers, existing edits, and a concrete exit condition.
2. Implement the related changes as one coherent batch. Keep external writes, paid services and optional features within recorded authority. Do not invoke every skill or agent simply because it exists.
3. At the batch boundary run the repository formatter once, then select the cheapest check set that detects plausible regressions using AGENTS' verification table. Reuse valid evidence. Do not run formatting, build or tests after each file.
4. Diagnose failures from evidence; only rerun affected checks after a meaningful change. Escalate the diagnostic approach after two non-progressing attempts, not the number of repetitive commands.
5. Inspect the final diff and staged filenames for scope and secrets. Make one or a few logically meaningful commits if authorized; never push without authorization.
6. Update `docs/VERIFICATION.md` when evidence changes and `docs/ARCHITECTURE_DECISIONS.md` only when a durable design choice changes.
7. Hand off briefly: outcome, evidence, limitations, next required decision. Do not mark a phase complete merely because its time estimate was reached.

For a release, check reproducible setup, documentation links, secret exclusions, known limitations, and template attribution. Never report an unexecuted command as passed.
