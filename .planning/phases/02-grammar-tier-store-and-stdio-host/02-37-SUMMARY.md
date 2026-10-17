---
phase: 02-grammar-tier-store-and-stdio-host
plan: 37
subsystem: testing
tags: [size-gate, sqlite, maintenance, STO-05, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "IDLE_MAINTENANCE and store.maintain(budget, options) from plan 02-30; lifecycle onVacuum / noDbstat test hooks"
provides:
  - "scripts/size-gate.ts asserts the idle-only edited-to-fresh ratio (<= 1.25) before any explicit full compaction"
  - "informational vacuums, longestMaintainMs and dbstat fields on the result and the CLI line"
affects: [ci-gate, verification-truth-4]
tech-stack:
  added: []
  patterns: ["gate runs the shared IDLE_MAINTENANCE policy and proves it fails on the old policy"]
key-files:
  created: []
  modified: [scripts/size-gate.ts, scripts/size-gate.test.ts]
key-decisions:
  - "ratio and ok now use idleBytes; the explicit final compaction is kept only as editedBytes / settledRatio (informational)"
  - "SizeGateOptions.idle (default IDLE_MAINTENANCE) lets a test pass {} to reproduce the old policy"
  - "vacuums is snapshotted right after the idle loop, so the explicit final compactions do not count"
requirements-completed: [STO-05, STO-10]
duration: 25min
completed: 2026-10-17
status: complete
commits: 2
plan_head_before: 7a3fbead7eaa8ecc28b579597aef5edf9fd3dae2
plan_head_after: 5d865c9f6c4d244f03c2f9b3d3f7952a8ebd4e56
actuals:
  tokens: 5000
  tasks: 2
  commits: 2
---

# Phase 2 Plan 37: STO-05 idle-only size gate Summary

**The 20,000-edit size gate now asserts the idle-only ratio with the shared `IDLE_MAINTENANCE` policy; the old policy is proven OVER at 1.3938 and the fixed one measures 1.0000.**

## Accomplishments
- `ratio` / `ok` are `idleBytes / freshBytes`, read before any explicit `compact({ full: true })`. The explicit compaction is reported only as `settledBytes` / `settledRatio`.
- `store.maintain` is called with `IDLE_MAINTENANCE` (override: `SizeGateOptions.idle`). A negative control (`--maintain-every 0`) is OVER (4.65 at 2,000 edits).
- Informational `vacuums`, `longestMaintainMs` (wall clock) and `dbstat present|absent` are returned and printed. Lifecycle hooks are reset in `finally`.

## Measured scale for the mutation test
Test scale: 150 files, 8 symbols, 1,500 edits, maintain every 100 (under 1 s). Scales tried under the old policy (idle ratio): 60/600/100 gives 1.1296, 100/1000/100 gives 1.2368 (still passes), 150/1500/100 gives 1.3441 (smallest over), 300/2000/200 gives 1.3375.
At 150/1500/100: old policy (`idle: {}`) idleRatio 1.3441 (settled 1.0323, vacuums 0); `IDLE_MAINTENANCE` idleRatio 1.0323; zero edits exactly 1.0000.

## Full-scale measurements (files 300, edits 20,000, maintain every 200)
```
node:sqlite:
size-gate: files 300 symbols 8 edits 20000 maintain-every 200 freshBytes 655360 idleBytes 655360 idleRatio 1.0000 max 1.25 settledBytes 655360 settledRatio 1.0000 vacuums 100 longestMaintainMs 21.2 dbstat present maintainRuns 101 seconds 6.3 OK

--driver better-sqlite3:
size-gate: files 300 symbols 8 edits 20000 maintain-every 200 freshBytes 655360 idleBytes 655360 idleRatio 1.0000 max 1.25 settledBytes 655360 settledRatio 1.0000 vacuums 100 longestMaintainMs 221.0 dbstat present maintainRuns 101 seconds 16.8 OK
```
Both drivers took the in-page (`dbstat`) rule. The forced no-`dbstat` (after-churn fallback) rule passes at test scale (test `names the in-page rule it used`). Old policy at full scale: idleRatio 1.3938, settledRatio 1.0000, vacuums 0, OVER. Note `longestMaintainMs` is the one unsliced pause (a full VACUUM), 21 ms and 221 ms on this machine for the two drivers; it is not asserted. ci.yml is unchanged and now enforces the idle-only bound on all three OSes (figures for Linux and Windows come from the next hosted CI run).

## Task Commits
1. Task 1 (tracer): `9e81494` test(02-37): the size gate asserts the idle-only ratio (STO-05)
2. Task 2: `5d865c9` test(02-37): size gate reports vacuum count and the longest maintain call

## Deviations from Plan
None - plan executed exactly as written. `src/sqlite/index.ts` is imported by the script (as `scripts/corpus-gates.ts` already does) to probe `dbstat`; `lifecycleTestHooks` is imported from `src/fact-store/lifecycle.ts` because the fact-store index does not export it. `npm run lint` covers `src` only, so the script is checked by `tsc` (typecheck).

## Issues Encountered
None. `parcel-source.test.ts` was not run (the plan's verify commands do not include it), so the SIGTRAP flake did not occur. The CodeGraph index in this worktree session points at the main checkout and showed pre-change source; edits were verified against the real files.

## Known Stubs
None.

## Threat Flags
None. T-02-118 mitigated: measured before any explicit compaction, shared policy, old-policy case proven OVER.

## Self-Check: PASSED
- scripts/size-gate.ts, scripts/size-gate.test.ts: FOUND
- 9e81494, 5d865c9 reachable from HEAD: FOUND
- verify: `node --test scripts/size-gate.test.ts scripts/ci-config.test.ts` 43/43 pass; `npm run typecheck` and `npm run lint` exit 0; `node scripts/size-gate.ts` exit 0
