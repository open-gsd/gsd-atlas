---
phase: 03-typescript-module-and-mvp-eval
plan: 02
subsystem: dependencies-and-constants
tags: [constants, approval, typescript, jsonc-parser, package-legitimacy]
requires: []
provides:
  - "03-CONSTANTS.md with Status: Approved (the precondition every consuming plan checks)"
  - "typescript 6.0.3 and jsonc-parser 3.3.1 as runtime dependencies; typescript-7 dev alias"
affects: [03-05, 03-10, 03-14, 03-16, 03-18, 03-19, 03-23, 03-24, 03-27, 03-28, 03-29, 03-30, 03-31, 03-32]
tech-stack:
  added: [typescript@6.0.3 (runtime), jsonc-parser@3.3.1 (runtime), typescript-7 = npm:typescript@7.0.2 (dev)]
  patterns: ["exact pins, installs with --ignore-scripts", "constants approved by a human before consuming plans run"]
key-files:
  created:
    - .planning/phases/03-typescript-module-and-mvp-eval/03-02-SUMMARY.md
  modified:
    - .planning/phases/03-typescript-module-and-mvp-eval/03-CONSTANTS.md
    - package.json
    - package-lock.json
    - scripts/package.test.ts
key-decisions:
  - "User replied approve-all: every constant approved unchanged, including gate.buildPrCeilingMs 90000, gate.updatePrCeilingMs 15000, gate.warmQueryPrCeilingMs 6000 (D-10)."
  - "All three packages approved and installed exact with scripts disabled; none refused, so plan 03-18 uses jsonc-parser rather than its own tokenizer."
  - "eval.maxBudgetUsdPerSession and eval.sessionWallClockMs stay deferred to plans 03-14 and 03-16."
requirements-completed: [TSM-05, TSM-06, TSM-07, EVL-02]
status: complete
commits: 2
plan_head_before: 4369f3fa391427b7f6fdc8ea669e9a48879ba121
plan_head_after: 1eebbfdbae3727081e8bbf5ec57c60949c9226dd
actuals:
  tokens: 6000
  tasks: 3
  commits: 2
---

# Phase 3 Plan 02: Constants approval and dependency install Summary

Phase 3 constants approved by the user ("approve-all") and typescript 6.0.3, jsonc-parser 3.3.1 and the typescript-7 dev alias installed exact with install scripts disabled.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Propose constants and gather package evidence | 632d39e |
| 2 | Human approval checkpoint (blocking-human) | answered "approve-all", recorded in 03-CONSTANTS.md |
| 3 | Record approval and install the approved packages | 1eebbfd |

## What changed

- `03-CONSTANTS.md`: `Status: Approved (2026-10-18, by the user)`; the reply is recorded verbatim under "Approvals". The table is unchanged.
- `package.json` / `package-lock.json`: `dependencies.typescript` 6.0.3 (removed from devDependencies), `dependencies.jsonc-parser` 3.3.1, `devDependencies.typescript-7` `npm:typescript@7.0.2`.
- `scripts/package.test.ts`: the exact-pin test now accepts an npm alias whose target version is exact; new test asserts the Phase 3 dependency layout.

## Verification

`npm ci --ignore-scripts`, `node --test scripts/package.test.ts` (10 of 10 pass), `npm run typecheck`, `npm run lint` and `npm run build` all pass. `require('typescript-7/package.json').version` prints 7.0.2; devDependencies no longer contains `typescript`.

## Deviations from Plan

**1. [Rule 3 - Blocking] `npm install typescript@6.0.3` left it in devDependencies**
- **Found during:** Task 3
- **Issue:** The version already matched, so npm kept the package under devDependencies; the plan requires it under dependencies.
- **Fix:** Re-ran with `--save-prod --save-exact --ignore-scripts`; npm moved it.
- **Files modified:** package.json, package-lock.json
- **Commit:** 1eebbfd

**2. [Rule 1 - Bug] Exact-pin test rejected the alias form**
- **Found during:** Task 3 (anticipated from reading scripts/package.test.ts)
- **Issue:** Regex `^\d+\.\d+\.\d+$` would fail on `npm:typescript@7.0.2`.
- **Fix:** Regex now allows an optional `npm:<name>@` prefix before an exact version. This is the "update package.test.ts if it asserts dependency lists" step in the plan.
- **Files modified:** scripts/package.test.ts
- **Commit:** 1eebbfd

## Auth gates / Known stubs / Threat flags

None. Threat mitigations T-03-21 to T-03-23 and T-03-SC applied as planned (evidence shown before install, exact versions, scripts disabled, values approved by a person).

## Notes

- STATE.md and ROADMAP.md were deliberately not updated (orchestrator instruction).
- `commits: 2` is measured from the ledger base 4369f3f (Task 1 commit 632d39e plus Task 3 commit 1eebbfd); this SUMMARY is committed separately.

## Self-Check: PASSED

- 03-CONSTANTS.md, package.json, package-lock.json, scripts/package.test.ts present and modified.
- Commits 632d39e and 1eebbfd are ancestors of HEAD.
