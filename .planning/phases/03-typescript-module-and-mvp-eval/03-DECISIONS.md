# Phase 3 Decisions: the nine open research questions and the diagnostics ADR

Status: Proposed
Status: Confirmed (2026-10-18, by the user)

This file records the human decisions Phase 3 could not make for itself (plan 03-01, Task 2). Each of the nine open questions in 03-RESEARCH.md has one answer below. Plans that depend on an answer name it (OQ1 to OQ9) and halt at a precondition if this file is not Confirmed. The reply that produced these answers is recorded verbatim under "Approvals".

## Register

| ID | Question | Default (researcher recommendation) | User answer | Plans that depend on it |
|----|----------|-------------------------------------|-------------|-------------------------|
| OQ1 | Relation storage for `extends`, `implements`, `overrides` (G3) | An optional `relations()` method on the PreciseResolver plus a `resolved_relations` table; ADR 6 and ADR 7 amendments (plan 03-08) | Default accepted | 03-08, 03-20, 03-25 |
| OQ2 | Where the memory watch lives (D-21 says "parent RSS watch") | An in-worker RSS sampler thread that kills the process past the budget, with `--max-old-space-size` as the V8 backstop (a deviation from the literal "parent RSS watch") | Default accepted; the deviation is approved (see Stop-gates) | 03-08, 03-19, 03-27, 03-30 |
| OQ3 | Meaning of "no fact points under `outDir`" (TSM-03) | A file that is the emit output of an included source never receives facts and is skipped by the Indexer. The 17 tracked hand-written files in `gsd-core/bin/lib` keep their facts | Default accepted | 03-22 |
| OQ4 | EVL-03 citation criterion (verifiable file:line in at least 80% of answers) | No default: the choice is the user's | `wilson_lower_bound` (the Wilson lower bound must be at or above 80%; 46 of 50 at N = 50). Supersedes the earlier reply `point_estimate`; re-asked at the pre-registration freeze (plan 03-16) | 03-05, 03-16, 03-35 |
| OQ5 | Scope of `precise.command` in Phase 3 | The gate only: an approved command runs through the CommandRunner during `maintain resolve` and its exit status is recorded; no importer (SCIP is Phase 9) | Default accepted | 03-15, 03-29 |
| OQ6 | Skill distribution | Add `skills` to the package `files`; `gsd-atlas init` does not copy skills in Phase 3; the eval loads the skill with `--plugin-dir`; install steps are documented | Default accepted | 03-11, 03-33 |
| OQ7 | Number of eval questions | 50 minimum; the pilot (plan 03-14) estimates disagreement and cost and the user chooses N there | Default accepted | 03-09, 03-14 |
| OQ8 | Corpus preparation for the eval | Run `npm ci --ignore-scripts` in a throwaway checkout at the pinned gsd-core SHA so the project's own TypeScript 6.x is used (D-13), and record it in the pre-registration | Default accepted | 03-07, 03-16 |
| OQ9 | Edge-precision sample (PRD criterion 1: at least 98% of hand-verified EXTRACTED edges) | Included in this phase as plan 03-31: a seeded sample of 100 edges verified against the compiler and reviewed by a person | Default accepted | 03-31 |

No default was overturned, so no dependent plan needs revision.

## Stop-gates

Gate OQ2 (D-21 deviation): Approved
Gate OQ4 (EVL-03 citation criterion): Confirmed wilson_lower_bound

Both lines are derived from the reply under "Approvals" by the plan 03-01 reply grammar: `approve-all` implies `oq2=approve`; the OQ4 value comes only from the explicit `oq4=` token of the newest reply.

## Diagnostics ADR ratification

The user approved ratifying the user-controlled-diagnostics ADR as written (Part A of the Task 2 decision). Execution status: PENDING. The auto-mode permission classifier denied the `gh issue create` call (public action), so no GitHub issue exists yet, the draft file is not renamed and docs/adr is untouched. Finish with the steps in 03-01-SUMMARY.md, then replace this paragraph with the issue number.

## Approvals

Task 2 (blocking-human checkpoint) replies, in order, verbatim:

1. `approve-all oq4=point_estimate`
2. `approve-all oq4=wilson_lower_bound` (a newer genuine reply from the user that supersedes reply 1; this is the reply the gate lines and the OQ4 answer follow)

Both replies ratify the ADR and accept all nine defaults OQ1 to OQ9; they differ only in the OQ4 value. The ratification itself (GitHub issue, rename) was approved by both and is unchanged.
