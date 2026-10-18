---
phase: 03-typescript-module-and-mvp-eval
plan: 16
subsystem: testing
tags: [eval, pre-registration, freeze, sha256, ci, bootstrap]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-14 pilot, 75 questions and oracle keys, approved constants; 03-05 prereg.ts and verify-prereg.ts"
provides:
  - "docs/eval/preregistration.md: Status Frozen (Stage A, 2026-10-18, by Tom Boucher) with sha256 of the sixteen Stage A files"
  - "scripts/eval/freeze-prereg.ts and replacePreregBlock in prereg.ts: the freezer with refusal reasons dirty_registered_file, missing_file, tests_failed, parameter_mismatch, citation_criterion_unconfirmed, already_frozen"
  - "ci.yml static job step Pre-registration (frozen hashes) running node scripts/eval/verify-prereg.ts, asserted in scripts/ci-config.test.ts"
  - "03-CONSTANTS.md row eval.retryDelayMs 60000 (approval of DEFAULT_RETRY_DELAY_MS); 03-DECISIONS.md later OQ4 entry"
affects: [03-35 scored run, 03-33 Stage B freeze, all precise-tier plans (D-08 now satisfied)]

requirements-completed: [EVL-02]

status: complete
actuals:
  tasks: 4
  commits: 6
plan_head_before: 17979847f53d02f36d7768d8420d79367b90437e
plan_head_after: 8a1da047ad61aa6d2f41b69dae7de9206d654147

key-files:
  created:
    - docs/eval/preregistration.md
    - scripts/eval/freeze-prereg.ts
    - scripts/eval/freeze-prereg.test.ts
  modified:
    - scripts/eval/prereg.ts
    - .github/workflows/ci.yml
    - scripts/ci-config.test.ts
    - .planning/phases/03-typescript-module-and-mvp-eval/03-CONSTANTS.md
    - .planning/phases/03-typescript-module-and-mvp-eval/03-DECISIONS.md

key-decisions:
  - "Question set approved by the user: `approve questions` (all 75 scored questions and the pilot, no replacements)"
  - "Registered parameters approved by the user: `point_estimate, stricter point estimate, approve pre-registration`; the clarification `both unless they conflict and you didn't tell me` made both parts apply, resolved as approve + stricter oq4=point_estimate"
  - "citationJudgedOn = point_estimate (supersedes wilson_lower_bound from plan 03-01); tokenCriterion = upper-bound (95th percentile of the paired bootstrap difference below zero)"
  - "DEFAULT_RETRY_DELAY_MS 60000 (infrastructure failures only, at most 2 retries) approved with the pre-registration and recorded in 03-CONSTANTS.md; arms.ts not edited"
  - "The 03-DECISIONS.md OQ4 gate line and register row are left as written; a later-reply section is appended"

duration: continuation session
completed: 2026-10-18
---

# Phase 3 Plan 16: Pre-registration freeze Summary

**The MVP eval design (75 questions, keys, scorer, statistics, harness, run configuration) is frozen at Stage A with sha256 hashes over sixteen files, checked by `verify-prereg` in the CI static job.**

## What was done

- Tasks 1 to 3 (earlier executor, merged here): the freezer with CRLF-normalised hashing, `replacePreregBlock`, and the Draft document.
- Task 2 and 3 replies were applied: the Approvals section holds both replies and the clarification exchange verbatim, one line `OQ4 confirmed by the user: point_estimate`, and the prereg-json params `citationJudgedOn: point_estimate`, `tokenCriterion: upper-bound`. The prose of H2, H3, Token criterion, Citation criterion (159 of 198 sessions on the point estimate; Wilson interval reported) and Retry rule was updated to match.
- Task 4: approvals committed first (the freezer refuses a dirty tree), then `node scripts/eval/freeze-prereg.ts --stage A --by "Tom Boucher"` ran the eval test suite, exited 0 and registered 16 files. `verify-prereg` exits 0; a one-line append to `scripts/eval/oracle.ts` made it exit 1 naming that path (registered 8d83f5d8197f, now b2d52f1f2109); the file was restored and verification passed again.
- CI: step `Pre-registration (frozen hashes)` added to the static job after `npm ci --ignore-scripts`; a test asserts it exists, follows npm ci, runs the right command and appears in no other job (written red first).
- The freeze commit (8a1da04) touches only `docs/eval/preregistration.md`, `.github/workflows/ci.yml` and `scripts/ci-config.test.ts`; nothing under `scripts/eval/`.

## Verification

typecheck, lint and build clean. `npm test`: 3271 tests, 3270 pass, 0 fail, 1 skipped (pre-existing skip). `node scripts/eval/verify-prereg.ts` ok.

## Deviations from Plan

None in code. Process notes:

- The Task 3 reply did not use the `oq4=` grammar; the user's clarification resolved it. The exact wording of the clarifying question was not available to this continuation, so the document says only that the user was asked to clarify; the answers are verbatim.
- The OQ4 line in 03-DECISIONS.md was not rewritten (append only, per instruction).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

Verified: docs/eval/preregistration.md (Status: Frozen (Stage A, 2026-10-18, by Tom Boucher), one OQ4 line), freeze commit 8a1da04 and approvals commit 7f3f8a0 are ancestors of HEAD, verify-prereg ok.
