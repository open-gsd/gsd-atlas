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

Ratification was deliberately NOT performed, by the user's decision of 2026-10-18: "adr ratification is just part of the phase doesn't need its own pr we are developing for mvp release nothing is ratified as it's not done".

- GitHub issue open-gsd/gsd-atlas#15 was opened and then closed as not planned.
- `docs/adr/draft-user-controlled-diagnostics.md` keeps its draft filename and stays a draft until the MVP is done. `docs/adr/README.md` and `scripts/adr.test.ts` (REMAINING / RATIFIED) are as plan 03-01 Task 1 left them; nothing was renamed or ratified.
- The nine OQ answers in the Register and the two gate lines under "Stop-gates" are unchanged.
- Consequence: the ratified-ADR precondition of SKL-03 is not met (see 03-01-SUMMARY.md).

## Approvals

Task 2 (blocking-human checkpoint) replies, in order, verbatim:

1. `approve-all oq4=point_estimate`
2. `approve-all oq4=wilson_lower_bound` (a newer genuine reply from the user that supersedes reply 1; this is the reply the gate lines and the OQ4 answer follow)

Both replies accept all nine defaults OQ1 to OQ9; they differ only in the OQ4 value. Both replies also approved ratifying the ADR, but the user later decided not to ratify it (see "Diagnostics ADR ratification" above), so no ratification took place.

## Later reply: OQ4 re-asked at the pre-registration freeze (plan 03-16)

The OQ4 line above (`Gate OQ4 (EVL-03 citation criterion): Confirmed wilson_lower_bound`) and the replies above are kept as they were. Plan 03-16 re-asks OQ4 at its blocking checkpoint because the freezer needs an explicit `OQ4 confirmed by the user:` line. The user answered on 2026-10-18 (verbatim): `point_estimate, stricter point estimate, approve pre-registration`; asked whether the replies conflicted, the user answered (verbatim): `both unless they conflict and you didn't tell me`. The replies do not conflict. The newest reply therefore sets OQ4 to `point_estimate`, which supersedes `wilson_lower_bound` for the frozen pre-registration (`docs/eval/preregistration.md`, `params.citationJudgedOn`). The Register row for OQ4 is not rewritten; this section is the later entry.

## Later reply: Stage A reopened (plan 03-38)

Dated 2026-10-18. Earlier lines above are not rewritten; this section is the later entry.

At the blocking-human checkpoint of plan 03-33 the user instructed (verbatim): `re-open stage a and run with the skill now that it's built`. Plan 03-38 reopened Stage A as Revision 1 of `docs/eval/preregistration.md`: the atlas arm gains the Skill tool and the registered skill; only the four run-configuration files (`scripts/eval/arms.ts`, `claude-session.ts`, `harness.ts`, `prereg.ts`) change; every parameter, question, key, the oracle, the scorer, the statistics and the grep arm are unchanged.

At the Task 4 blocking-human checkpoint of plan 03-38 the user replied (verbatim): `approve oq4=point_estimate`. OQ4 stays `point_estimate` (`params.citationJudgedOn`); the reply contains exactly one `oq4=` token and it matches the registered value, so no registered parameter changes. The line `OQ4 re-confirmed by the user at Revision 1: point_estimate` is recorded in the document under `Approvals (Revision 1)`.

## Later reply: ratification at the end of Phase 3 (plan 03-37)

Dated 2026-10-18. Earlier lines above are not rewritten; this section is the later entry.

The user instructed (verbatim): "any ADR at the end of phase 3 must be assigned a number. when we release the MVP every adr needs that number. if that is option a, then get it done. if you need to submit an issue to get that number, do so and then renumber the ADR file with a pr and close it."

Replies that settled the plan (verbatim): "push main first." / "ok on reopen." / "meant reopen" (issue #15 is reopened, not replaced) / "ok on one pr." / "ok on task 4." / "why leave issues open if they're being used for adrs. they should have been closed with the adr update." / "yes we aren't released yet the end result is important not a short step." The issues named by the earlier records (#2 to #9 and #11 to #14) are therefore closed by this pass.

Reply to the blocking checkpoint of plan 03-37 Task 2 (verbatim, 2026-10-18): `approve ack-verdict`. The checkpoint printed `VERDICT: NOT MET OR NOT FINAL` (docs/eval/analysis.md: `OVERALL: MVP not met`), so the reply needed `ack-verdict`; it contains both tokens and satisfies the reply grammar.
