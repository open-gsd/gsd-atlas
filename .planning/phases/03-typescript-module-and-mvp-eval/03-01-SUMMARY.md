---
phase: 03-typescript-module-and-mvp-eval
plan: 01
subsystem: adr-tooling
tags: [adr, decisions, stop-gates]
requires: []
provides:
  - PHASE3_SLUGS and RATIFIED_SLUGS (13) in scripts/adr.ts
  - 03-DECISIONS.md with OQ1-OQ9 answers and the two stop-gate lines
  - 03-RESEARCH.md Open Questions marked RESOLVED
affects: [03-05, 03-08, 03-16, 03-19, 03-21, 03-27, 03-30]
key-files:
  created:
    - .planning/phases/03-typescript-module-and-mvp-eval/03-DECISIONS.md
  modified:
    - scripts/adr.ts
    - scripts/adr-ratify.ts
    - scripts/adr.test.ts
    - .planning/phases/03-typescript-module-and-mvp-eval/03-RESEARCH.md
key-decisions:
  - "OQ1-OQ3, OQ5-OQ9: researcher defaults accepted"
  - "OQ2: in-worker RSS sampler approved as a deviation from D-21"
  - "OQ4: EVL-03 citation criterion judged on wilson_lower_bound (supersedes an earlier point_estimate reply)"
  - "The user-controlled-diagnostics ADR is NOT ratified; it stays a draft until the MVP is done (user decision 2026-10-18)"
metrics:
  completed: 2026-10-18
status: complete
# commits is measured from plan_head_before to plan_head_after; it excludes this SUMMARY's own commit.
commits: 6
plan_head_before: 4369f3fa391427b7f6fdc8ea669e9a48879ba121
plan_head_after: ef846abf297cfee43a010c93915f8a05194e8efe
actuals:
  tasks: 3
  commits: 6
---

# Phase 3 Plan 1: ADR tooling, assumptions record and diagnostics ADR status Summary

The ADR scripts know the Phase 3 slug, all nine open research questions are answered in 03-DECISIONS.md with both stop-gates passing, and the diagnostics ADR deliberately stays a draft by the user's decision.

## Done

- Task 1 (fc09cd1): the ADR scripts know the Phase 3 slug; `RATIFIED_SLUGS` has 13 entries; dry-run test added.
- Task 2: user reply recorded. The user sent two replies; the newer one supersedes: `approve-all oq4=wilson_lower_bound` (first: `approve-all oq4=point_estimate`). Both are recorded verbatim, in order, under "Approvals" in 03-DECISIONS.md.
- Task 3 (9ce4911, 4452ce7, ef846ab): 03-DECISIONS.md written with all nine answers and exactly these gate lines:
  - `Gate OQ2 (D-21 deviation): Approved`
  - `Gate OQ4 (EVL-03 citation criterion): Confirmed wilson_lower_bound`

  03-RESEARCH.md heading is `## Open Questions (RESOLVED)` with nine `RESOLVED: see 03-DECISIONS.md OQn.` markers. The "Diagnostics ADR ratification" section of 03-DECISIONS.md records that ratification was not performed, and why.

## Deviations from Plan

### User-decided skip

**1. [User decision] Task 3 ratification steps skipped**
- **Plan said:** open a GitHub issue for the user-controlled-diagnostics ADR, rename the draft to a numbered ADR, update the README table, Ratification log and schedule, and move the slug from REMAINING to RATIFIED in `scripts/adr.test.ts`.
- **What happened:** on 2026-10-18 the user decided not to ratify: "adr ratification is just part of the phase doesn't need its own pr we are developing for mvp release nothing is ratified as it's not done". Issue open-gsd/gsd-atlas#15 was opened and then closed as not planned. A ratification commit (247fb61) had already landed on this branch; it was reverted in 4452ce7 (a plain `git revert`, no history rewrite), so `docs/adr/draft-user-controlled-diagnostics.md`, `docs/adr/README.md` and `scripts/adr.test.ts` are byte-for-byte as in 4b6c344 (the state Task 1 left them).
- **Consequence for later plans:** SKL-03's ratified-ADR precondition is NOT met. Plan 03-21 (and anything else gated on a ratified diagnostics ADR) should be flagged to the orchestrator. ROADMAP row 3 ("ADR ratified before Phase 3 diagnostics code") is not satisfied by design; SKL-03 should not be marked complete on this plan's account.
- **Commits:** 4452ce7 (revert), ef846ab (03-DECISIONS.md record).

No code deviations. The OQ answers and the two gate lines are unchanged.

## Stop-gate outcome

Neither gate line ends STOP, so no dependent plan is blocked by OQ2 or OQ4.

## Verification

`node --test scripts/adr.test.ts` passes (41 of 41) and `npm run lint` is clean.

## Known Stubs

None.

## Self-Check: PASSED

- 03-DECISIONS.md, 03-RESEARCH.md and scripts changes committed; fc09cd1, 9ce4911, 4452ce7 and ef846ab are ancestors of HEAD.
- `docs/adr/draft-user-controlled-diagnostics.md` exists; `docs/adr/15-user-controlled-diagnostics.md` does not.
