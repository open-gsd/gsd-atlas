---
phase: 02-grammar-tier-store-and-stdio-host
plan: 28
subsystem: tenant-runtime
tags: [metrics, recording, startup-reconcile, lease-takeover, idle-maintenance, index-health, clock-after]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "Tenant composition and status port (02-20), Metrics and its closed event vocabulary (02-10), store lease with takeover and onLeaseChange (02-12), Indexer with start/refresh/notices (02-15, 02-17), Governor (02-09), approved constants (02-CONSTANTS.md)"
provides:
  - "answerEvent: closed-vocabulary answer event built from the envelope structure only (counts and codes), recorded after the envelope exists inside a swallowed block"
  - "freshness events from Indexer `indexed` notices; index_health gauge after a build and after every idle round; status flushes the recorder first"
  - "Start-up Reconcile deadline (indexer.startupReconcileDeadlineMs) with `reconciling` on late answers; Clock.after timer cancelled when start wins"
  - "Follower takeover: takeover bounds and onLeaseChange passed to the store; Indexer started on gain, stopped on loss, nothing started after close"
  - "createIdleMaintainer and the Tenant idle round (store upkeep in slices, Indexer.refresh per worktree, metrics rollup, gauge) at the Governor's maintenance class, yielding to requests"
  - "WorktreeStatus.files (additive): paths held by a worktree's overlay"
affects: [02-27 follower overlay, 02-24 status panels, phase 4 daemon host (idle loop moves with the Tenant)]

actuals:
  tokens: 85000
  tasks: 3
  commits: 6
plan_head_before: 899603f7b08a9268f5448673271a99edbc537459
plan_head_after: 6e97df1232acc7fb01208bc0b8089ac6d561df0a

tech-stack:
  added: []
  patterns:
    - "Side effects after the envelope: recording runs in an empty-catch block, the envelope object is returned untouched"
    - "All waiting through Clock.after with one held cancel function; close sets the closed flag before anything else"
    - "A yield flag plus re-arm-on-request instead of a self-re-arming timer"

key-files:
  created:
    - src/tenant/idle.ts
    - src/tenant/idle.test.ts
    - src/fact-store/status-files.test.ts
  modified:
    - src/tenant/create.ts
    - src/tenant/types.ts
    - src/tenant/index.ts
    - src/fact-store/types.ts
    - src/fact-store/store.ts
    - src/fact-store/contract.ts
    - src/query/status.test.ts

key-decisions:
  - "The idle round calls store.maintain and, when it answers WriterBusy (the Indexer holds the in-process writer slot for its whole life), falls back to collect and compact slices plus one check, the same calls the maintain request makes. Without the fallback store.maintain would fail on every round of a Tenant that runs an Indexer"
  - "WorktreeStatus.files counts every overlay path of the worktree, pending paths included, so stalePaths is always a subset of files"
  - "A round that yielded is not counted as a finished round; idle.rounds and lastRoundAt move only when the rollup and the gauge were reached"
  - "Idle refresh covers only worktrees git still lists and only when an Indexer exists, so a removed worktree does not fail a step on every round"

patterns-established:
  - "createIdleMaintainer({clock, idleAfterMs, run, onError}): one timer, one round at a time, touch() during a round asks it to yield and re-arms after it returns"

requirements-completed: [MET-02, STO-08, STO-10]

coverage:
  - id: D1
    description: "Every answer of the five tenant-served tools is recorded as one answer event (counts and closed-vocabulary codes only); a throwing, noop or full Metrics never changes the envelope"
    requirement: MET-02
    verification:
      - kind: unit
        ref: "src/tenant/recording.test.ts#answerEvent"
        status: pass
      - kind: e2e
        ref: "src/host/recording.test.ts (status report totals, privacy scan of metrics.db bytes)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The first request waits at most the approved deadline for the start-up Reconcile, answers say reconciling until start settles, the deadline timer is cancelled when start wins, and a repository with no indexed worktree starts nothing"
    requirement: STO-08
    verification:
      - kind: unit
        ref: "src/tenant/startup.test.ts#start-up Reconcile deadline"
        status: pass
    human_judgment: false
  - id: D3
    description: "A follower takes over the lease without a restart and starts indexing; a lost lease stops the Indexer; a lease change racing close starts nothing and leaves no timer"
    requirement: STO-08
    verification:
      - kind: unit
        ref: "src/tenant/takeover.test.ts#follower takeover (STO-08)"
        status: pass
    human_judgment: false
  - id: D4
    description: "After the approved quiet period a leader runs store upkeep in slices, Indexer.refresh, the rollup and the gauge at the maintenance class; a follower runs the rollup and the gauge only; a request stops the round after the current slice and the next quiet period restarts it; a failing step does not stop later steps; no timer is left behind"
    requirement: STO-10
    verification:
      - kind: unit
        ref: "src/tenant/idle.test.ts#Tenant idle round"
        status: pass
      - kind: unit
        ref: "src/tenant/idle.test.ts#createIdleMaintainer"
        status: pass
    human_judgment: false
  - id: D5
    description: "The index-health gauge reports real file, error and stale counts and the store size, read back through the Metrics report; WorktreeStatus.files tracks commits and deletes and is zero for an empty worktree"
    requirement: STO-10
    verification:
      - kind: unit
        ref: "src/tenant/idle.test.ts#index-health gauge"
        status: pass
      - kind: unit
        ref: "src/fact-store/status-files.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Idle maintenance under a real long-lived Host on Linux and Windows, and against a store large enough for slices to matter"
    verification: []
    human_judgment: true
    rationale: "Only macOS ran locally with a fake clock and a small toy store; three-OS CI and the Phase 2 size gate are the real checks."
---

# Phase 2 Plan 28: Recording, start-up deadline, takeover and idle maintenance Summary

**Tenant runtime behaviours: counts-only answer recording that cannot touch an answer, a bounded start-up Reconcile wait, follower takeover without a restart, and lease-aware idle maintenance that yields to requests, with an additive `files` count feeding the index-health gauge.**

## Performance

- **Tasks:** 3 of 3
- **Commits:** 6 (three RED, three GREEN)
- **Scope of this run:** tasks 1 and 2 were already committed on the base; this run completed task 3 (idle maintenance, gauge, `files`)

## Accomplishments

- Task 1 (committed earlier): `answerEvent` and recording inside a swallowed block, freshness events from Indexer notices, status flushing the recorder first.
- Task 2 (committed earlier): start-up deadline with `reconciling`, takeover bounds and `onLeaseChange`, close-first flag.
- Task 3: `createIdleMaintainer`, the Tenant idle round, the `index_health` gauge (after a build and after each round), and `WorktreeStatus.files`.
- The full suite passes (2106 tests), as do `npm run typecheck` and `npm run lint`.

## Task Commits

| Task | Commit | Type |
| ---- | ------ | ---- |
| 1 RED | c5de698 | test(02-28) |
| 1 GREEN | bed8dea | feat(02-28) |
| 2 RED | a38445a | test(02-28) |
| 2 GREEN | a5e6cdf | feat(02-28) |
| 3 RED | d3bddba | test(02-28) |
| 3 GREEN | 6e97df1 | feat(02-28) |

## TDD Gate Compliance

Each task has a failing-test commit followed by its implementation commit. The task 3 RED run failed on the missing `files` field and the missing idle behaviour before any production code changed.

## Files Created/Modified

- Created: `src/tenant/idle.ts`, `src/tenant/idle.test.ts`, `src/fact-store/status-files.test.ts`
- Modified: `src/tenant/create.ts`, `src/tenant/types.ts`, `src/tenant/index.ts`, `src/fact-store/types.ts`, `src/fact-store/store.ts`, `src/fact-store/contract.ts`, `src/query/status.test.ts`

## Decisions Made

See `key-decisions` above. The main one: the idle round tolerates `WriterBusy` from `store.maintain` by running the same collect, compact and check work directly, because the Indexer keeps the in-process writer slot for its whole life.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] store.maintain can never run while the Indexer is up**
- **Found during:** Task 3
- **Issue:** The plan has the idle round call `store.maintain`, but that wrapper takes the in-process writer slot, which a running Indexer holds (the Tenant's own `maintain` request already works around this). In production every leader round would have failed.
- **Fix:** `maintenanceSlice` calls `store.maintain` first and on `WriterBusy` runs `collect`, `compact` and, when both complete, `check`. A test covers both paths.
- **Files modified:** `src/tenant/create.ts`, `src/tenant/idle.test.ts`
- **Commit:** 6e97df1

**2. [Rule 2 - Missing visibility] Failed idle steps were invisible**
- **Found during:** Task 3
- **Issue:** The plan says a failing step becomes a notice, but the Tenant has no notice sink.
- **Fix:** `TenantStatus.idle` gained `failedSteps` next to `lastRoundAt` and `rounds`, so swallowed failures are countable without a new channel.
- **Files modified:** `src/tenant/types.ts`, `src/tenant/create.ts`
- **Commit:** 6e97df1

**3. [Rule 3 - Blocking] Existing status assertions had to name the new field**
- **Found during:** Task 3
- **Issue:** `files` is required on `WorktreeStatus`, so three `deepStrictEqual` expectations in `src/fact-store/contract.ts` and one fixture in `src/query/status.test.ts` no longer compiled or matched.
- **Fix:** Added the expected `files` values; no existing field changed.
- **Files modified:** `src/fact-store/contract.ts`, `src/query/status.test.ts`
- **Commit:** 6e97df1

## Issues Encountered

- The idle test that reads the gauge back needed its fake clock to start at real time, because the tenant that built the store had recorded a gauge at real time and the newest gauge wins.
- The store's own dirty-sentinel timer can stay pending on a Clock after upkeep wrote, until the store closes. The no-timer test therefore asserts on the idle timer specifically and on zero timers after close.

## Known Stubs

None.

## Threat Flags

None. The gauge records four integers and the answer event records counts and closed-vocabulary codes (T-02-98, T-02-99 covered by earlier tests). Idle rounds run at the maintenance class and yield (T-02-100). No Indexer starts without the lease and close sets its flag first (T-02-101).

## User Setup Required

None.

## Next Phase Readiness

Plan 02-27 (follower overlay) can replace the `fresh_timeout` degrade on followers; the follower idle round already runs the rollup and the gauge without touching the store as a writer.

## Self-Check: PASSED

- Created files exist: `src/tenant/idle.ts`, `src/tenant/idle.test.ts`, `src/fact-store/status-files.test.ts`
- Commits exist: c5de698, bed8dea, a38445a, a5e6cdf, d3bddba, 6e97df1
