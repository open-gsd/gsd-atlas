---
phase: 02-grammar-tier-store-and-stdio-host
plan: 30
subsystem: fact-store
tags: [sqlite, vacuum, wal-checkpoint, maintenance, lease, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "plan 02-18 compaction and lifecycle, plan 02-12 lease and Lease.info()"
provides:
  - "FactStore.maintain(budgetMs, options?) with StoreMaintainOptions and the frozen IDLE_MAINTENANCE policy"
  - "second-chance full-compaction check and the no-dbstat fallback (afterChurn) in compactStore"
  - "non-blocking truncating WAL checkpoint (busy timeout 0 for the call, restored in finally)"
  - "collision-free last-insert-rowid reset (random NUL-prefixed sentinel in names)"
  - "COMPACT_SLICE_LIMITS, resetLifecycleTestHooks, resetRecoveryCounters"
  - "StoreStatus.leaseHolder (pid, startedAt, version)"
affects: [02-37 size gate, 02-40 Tenant idle loop and lease messages, 02-42 ADR amendment]
tech-stack:
  added: []
  patterns:
    - "idle policy is one exported frozen constant shared by the Tenant loop and the size gate"
    - "structural (not wall-clock) assertions for time-boxed slices"
key-files:
  created:
    - src/fact-store/lease-holder.test.ts
  modified:
    - src/fact-store/lifecycle.ts
    - src/fact-store/maintain.ts
    - src/fact-store/store.ts
    - src/fact-store/types.ts
    - src/fact-store/index.ts
    - src/fact-store/recovery.ts
    - src/fact-store/maintain.test.ts
    - src/fact-store/lifecycle.test.ts
    - src/fact-store/durability.test.ts
    - src/fact-store/fact-store.test.ts
key-decisions:
  - "Idle upkeep requests a full compaction only after a completed collect; the VACUUM decision is taken before the slices and once more after them, so one call converges"
  - "Without dbstat the full request vacuums only after churn in the same call (afterChurn); a direct compact({ full: true }) keeps the free-page rule"
  - "The rowid-reset sentinel goes into names (rowid table), not meta (WITHOUT ROWID), built with exec and char(0) so no prepared run() reads the out-of-range rowid"
  - "Checkpoint busy timeout 0 means do not wait; it is a derived value, not a duration"
requirements-completed: [STO-05, STO-10, STO-08]
status: complete
actuals:
  tokens: 13000
  tasks: 3
  commits: 3
plan_head_before: 27ae4745b8b40d2ef56534198753f39e59ef3085
plan_head_after: 37329677e11edd980c9adccf4477c23f4a8f0115
completed: 2026-10-17
---

# Phase 2 Plan 30: Idle maintenance policy and store-side review fixes Summary

**`maintain(budget, IDLE_MAINTENANCE)` now leaves a fragmented store at or below the fresh-equivalent size in one call, only after collect finished; the WAL checkpoint can no longer wait on a reader; the lease holder is visible in `status()`.**

## Performance

- **Duration:** about 35 minutes (2026-10-17)
- **Tasks:** 3 of 3
- **Commits:** 3 (measured from the plan base 27ae474; the per-plan ledger file could not be written inside the worktree guard, so the base is the fast-forward commit named in the task)

## Accomplishments

- STO-05 / D-16 (store side): `StoreMaintainOptions` (`{ full?: boolean }`), frozen `IDLE_MAINTENANCE`, `maintain(budgetMs, options?)` (validated with a RangeError). `maintainStore` forwards `full: true` and `afterChurn` to the compact step only when `options.full === true` and the collect step completed.
- `compactStore` keeps the existing pre-slice check and adds a second evaluation when the slices returned every free page (free list 0, complete, no VACUUM yet). A store at 22 percent free pages and 32 percent in-page empty space (600 files, 540 scattered edits) is vacuumed within one call; the empty space is 41 percent of the smaller file.
- I4 fallback: `lifecycleTestHooks.noDbstat` forces the missing-`dbstat` path on every build. Then `worthVacuuming` answers from `afterChurn`: vacuum after a collect that deleted files, nothing on the next call, and a direct `compact({ full: true })` follows the free-page rule only.
- WR-04: the checkpoint runs with `busy_timeout` set to 0 and restored in a `finally` (also on throw). `onCheckpoint({ mode, busyTimeoutMs, previousBusyTimeoutMs })` observes it. With a second connection holding a read snapshot, `compact` returns and the log is left to drain; after the reader ends the next run truncates it.
- WR-05 part a: `resetLastInsertRowid` inserts `char(0) || '<uuid>'` into `names` and deletes it by the same expression. A live fact named `''` no longer makes `collect` throw after deleting rows.
- IN-01: the slice test asserts structure through exported `COMPACT_SLICE_LIMITS` ({ firstPages: 64, maxPages: 16384, maxGrowth: 4 }); no wall-clock comparison remains in any fact-store test.
- WR-02 input: `StoreStatus.leaseHolder` from `Lease.info()` (own when held, `lease.json` for a follower, absent after the leader released or with `lease: 'none'`).
- IN-08: `resetLifecycleTestHooks()` and `resetRecoveryCounters()`; `afterEach` resets plus a hygiene guard case in `maintain.test.ts`, `lifecycle.test.ts` and `durability.test.ts`.

## Task Commits

1. **Task 1 (tracer): idle maintenance requests a full compaction** - `c3e9260` (feat)
2. **Task 2: non-blocking checkpoint, collision-free rowid reset, structural slice test** - `7e09ee2` (fix)
3. **Task 3: lease holder in store status, test-hook resets** - `3732967` (feat)

## Verification

- `node --test` over the plan's files: all pass, both drivers. Full `npm test`: 2271 tests, 0 failures.
- `npm run typecheck`, `npm run lint`, `npm run schema:check`: exit 0.
- Tracer gate: the idle-policy cases re-ran end to end on both drivers before expanding.

### Mutation checks (recorded as required)

| Mutation | Result |
|----------|--------|
| `maintainStore` ignores the option (never passes `full`) | idle-policy, second-chance, collect-not-finished and no-dbstat cases fail (10 failures across both drivers) |
| Drop the `collected.complete` guard | the `collect not finished` case fails on both drivers |
| Disable the second evaluation in `compactStore` | the `second chance` case fails on both drivers |
| Checkpoint without the zero busy timeout (old TRUNCATE call) | the checkpoint-mode case fails on both drivers; the reader-snapshot case then takes about 5.5 s (the busy timeout) instead of about 0.3 s |

### dbstat availability

`SELECT sum(unused) FROM dbstat` is answered by both `node:sqlite` and `better-sqlite3` on this machine (the idle-policy cases read it through a second connection on both drivers). The fallback rule is therefore a safety net, exercised through the `noDbstat` hook.

### Elapsed-time assertions

None remain in `src/fact-store/*.test.ts` (searched for `slice.ms`, `performance.now`, `.ms`, `Date.now`).

## Deviations from Plan

**1. [Rule 1 - Bug] Export-list test failed after Task 1 added `IDLE_MAINTENANCE` to the Fact Store index**
- **Found during:** full `npm test` after Task 3
- **Issue:** `fact-store.test.ts` pins the exact list of runtime exports of `index.ts`.
- **Fix:** added `IDLE_MAINTENANCE` to the expected list, asserted it is frozen `{ full: true }`, and added compile-time usage of `maintain(50, IDLE_MAINTENANCE)` and `leaseHolder`.
- **Files modified:** `src/fact-store/fact-store.test.ts` (not in the plan's file list)
- **Commit:** `3732967` (it should have been in Task 1's commit; the break was found only by the full run)

**2. [Rule 3 - Blocking] 02-CONSTANTS.md addendum is not in this base**
- The plan cites rows `compact.fullFreeFraction`, `compact.fullUnusedFraction`, `compact.checkpointBusyTimeoutMs` of the 2026-10-17 addendum, which plan 02-29 writes. 02-29 has no SUMMARY in this base. I used only the values the plan itself states (one quarter, one third, busy timeout 0) and cited the keys in code comments; no other constant was invented.

**3. Plan-head ledger**
- The plan's persisted ledger file (`gsd-plan-head-before-02-30` in the git dir) could not be written from inside the worktree guard. `commits: 3` is measured with `git rev-list --count 27ae474..HEAD` against the known fast-forward base. The same number is recorded in `plan_head_before` and `plan_head_after`.

**Total deviations:** 1 auto-fixed bug, 2 process notes. No behaviour of the plan changed.

## Known Stubs

None.

## Threat Flags

None. T-02-104, T-02-105 and T-02-106 are mitigated as planned (thresholds plus completed-collect gate; zero busy timeout restored in finally; random NUL-prefixed sentinel). No new endpoint, file access or trust-boundary surface was added. T-02-107 (pid and version in status) accepted as in the plan.

## Notes for downstream plans

- Plan 02-40: call `store.maintain(budget, IDLE_MAINTENANCE)`; read `status().leaseHolder` for the `lease_held` and `not_indexed` messages.
- Plan 02-37: the gate runs the same `IDLE_MAINTENANCE` call and records whether `dbstat` or the fallback path ran (`noDbstat` hook is test-only).
- IN-08 remains partly open as the plan recorded: the hooks are still one module-level mutable object; reset helpers plus `afterEach` remove the leak risk.

## Self-Check: PASSED

- FOUND: src/fact-store/lease-holder.test.ts, src/fact-store/maintain.ts, src/fact-store/lifecycle.ts
- FOUND commits: c3e9260, 7e09ee2, 3732967 (all ancestors of HEAD)
