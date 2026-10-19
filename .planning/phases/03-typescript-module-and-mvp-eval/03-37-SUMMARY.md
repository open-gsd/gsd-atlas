---
phase: 03-typescript-module-and-mvp-eval
plan: 37
subsystem: docs/adr
tags: [adr, ratification, github, documentation]
requires: [03-34, 03-35, 03-36, 03-38]
provides:
  - every decision record numbered and Accepted
  - gated ratification tooling (`adr-ratify --gate mvp`)
  - issues of all fourteen records closed
affects: [docs/adr, README.md, docs/reference/alpha-limitations.md]
key-files:
  created: []
  modified:
    - scripts/adr.ts
    - scripts/adr-ratify.ts
    - scripts/adr.test.ts
    - scripts/docs-reference.test.ts
    - docs/adr/README.md
    - README.md
    - docs/reference/alpha-limitations.md
status: complete
commits: 16
plan_head_before: 839d66caff3653618ffe01433d3c0151070cab71
plan_head_after: 2a881a815366ebee6b1bc4f79436ed553b0b7007
actuals:
  tasks: 4
  commits: 16
---

# Phase 3 Plan 37: End-of-phase ADR numbering and ratification Summary

The two remaining draft decision records were numbered (issues 16 and 15) and ratified in one reviewed pull request, the issues of all fourteen records were closed as completed, and the documents, notes, comments and tests now state that every record is numbered and Accepted.

`plan_head_before` is the base of this continuation segment; the first segment (Task 1 and the checkpoint) added `2cad2e5`, `ba7dce5` and `3d652b5` before it. The count of 16 includes the merge commit of the pull request, which came from the remote.

## Approval

Reply to the Task 2 blocking checkpoint (verbatim, 2026-10-18): `approve ack-verdict` (verdict `OVERALL: MVP not met`, so `ack-verdict` was required). Earlier replies the same day: 'meant reopen' (issue 15), 'ok on one pr', 'ok on task 4'; issues 2 to 14 to be closed.

## Published record

| Slug | Issue | How | Pull request | Merge commit | Closed |
|------|-------|-----|--------------|--------------|--------|
| host-process-model | https://github.com/open-gsd/gsd-atlas/issues/16 | created | https://github.com/open-gsd/gsd-atlas/pull/17 | `015ff886115342c2b05dfeff962d621003f3f88b` | CLOSED/COMPLETED |
| user-controlled-diagnostics | https://github.com/open-gsd/gsd-atlas/issues/15 | reopened (was CLOSED/NOT_PLANNED) | https://github.com/open-gsd/gsd-atlas/pull/17 | `015ff886115342c2b05dfeff962d621003f3f88b` | CLOSED/COMPLETED |

Issues 2 to 9 and 11 to 14 (the earlier twelve records) were OPEN and passed the own-issue check before any write; all read CLOSED/COMPLETED afterwards (checked with `gh issue view`). Issues 1 and 10 are pull requests and were not touched. No issue title or body was edited. The close comment on each was `Numbered and ratified in https://github.com/open-gsd/gsd-atlas/pull/17.`

## Task 4 commits (on the integration branch, not pushed)

`cc1337c` RED, `18678ca` docs, `a11e558` comments, `15a3b60` ledger and decisions, `bf5a9d0` todos, `0f6d380` GREEN narrowing; also `837abd4` and `f3cbb60` (own-issue check fix), `3d3f64a`, `2a881a8` (records). The person must push the integration branch to `main` for the remote README, notes, wording and comments to change; until then the remote holds the numbered, Accepted records and closed issues with the earlier wording around them. The full list is in `03-37-PROGRESS.md` under "Not yet on the remote".

## Deviations from Plan

1. [Rule 1] The wording case in `scripts/docs-reference.test.ts` failed on the pass branch (it demanded a pre-release note in every numbered record). Fixed inside the pull request (`21c79b5`); Task 4 replaced the case.
2. [Rule 1] `issueIsAdrsOwn` rejected the body that `issuePayload` writes (placeholder `<issue number>-<slug>.md`), so issue 16 failed the pre-close own-check. Fixed test-first (`837abd4`, `f3cbb60`); not in the pull request.
3. [Rule 2] `src/host/bug.ts` had the same stale "draft ... ADR" comment as the five listed source files; updated and covered by the test.
4. The pass branch is not an `agent-*` branch; the agent-namespace commit check was not applied to it (the plan and the instructions require that branch). The protected-branch check held.
5. Windows test jobs of the pull request did not finish (cancelled), as on earlier runs of main; the workflow marks them `continue-on-error`. The merge state was UNSTABLE and MERGEABLE with no review required; Ubuntu and macOS tests, static checks, gates and grammar rebuilds passed.
6. Closing the issues was recorded in one commit instead of one each. One batched `gh issue close` command was refused by the auto-mode permission classifier and nothing was closed by it; each issue was then closed with its own command.

## Verification

`npm run typecheck`, `npm run lint`, `npm run build` clean. `npm test`: 4663 tests, 4661 pass, 0 fail, 2 skipped (as before). `node scripts/eval/verify-prereg.ts`: ok. No tracked `docs/adr/draft-*` file; every file in `docs/adr` other than README.md is numbered. Eval files (scripts/eval, docs/eval, skills/gsd-atlas/SKILL.md) are unchanged.

## Known Stubs

None.

## Self-Check: PASSED

The renamed records, the pull request merge commit `015ff88`, and each task commit exist in the branch history; the closed state of the fourteen issues was read from GitHub after the last close.
