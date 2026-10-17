---
phase: 02-grammar-tier-store-and-stdio-host
plan: 39
subsystem: grammar-engine
tags: [worker-pool, timeouts, lng-07, wr-09, in-06]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-29 approved addendum (pool.loadTimeoutMs, pool.terminateGraceMs) in 02-CONSTANTS.md"
provides:
  - "Grammar loads in the parser pool have a deadline (30000 ms); a hung load costs one worker and one rejected job"
  - "The engine's parse cut-off (5000) fires before the pool's terminate deadline (7000); a slow parse no longer costs the worker"
  - "poolStatus().limits {parseTimeoutMs, runTimeoutMs, loadTimeoutMs}"
affects: [parser-pool, status]
tech-stack:
  added: []
  patterns: ["deadline timer around an in-flight worker request: unref'd, cleared in finally, detach() terminates the worker"]
key-files:
  created:
    - src/grammar-engine/pool/__fixtures__/silent-worker.ts
    - src/grammar-engine/pool/__fixtures__/echo-start-worker.ts
  modified:
    - src/grammar-engine/pool/pool.ts
    - src/grammar-engine/pool/pool.test.ts
key-decisions:
  - "Test-only `workerUrl` also accepts a function of the 1-based spawn count, so the lazy-load-before-a-run case can give the first worker a responsive fixture and the next one a silent fixture."
  - "POOL_DEFAULTS.runTimeoutMs becomes the literal 7000 (parseTimeoutMs 5000 plus terminateGraceMs 2000); a test asserts the sum."
  - "The pool now validates engineOptions.parseTimeoutMs at construction (RangeError), where it used to surface only as a worker startup error."
requirements-completed: [LNG-07]
status: complete
commits: 2
plan_head_before: 7a3fbead7eaa8ecc28b579597aef5edf9fd3dae2
plan_head_after: 6ee0887a866a87712f51b4dc418a3b6bb8951ed4
actuals:
  tokens: 5000
  tasks: 2
  commits: 2
---

# Phase 2 Plan 39: Pool load deadline and parse cut-off below the terminate deadline Summary

A grammar load in the parser pool now has a 30000 ms deadline that terminates the stuck worker, and the pool's own per-run deadline moved to 7000 ms so the engine's 5000 ms cooperative cut-off ends a slow parse before any worker is killed.

## What was built

- **Task 1 (tracer, WR-09), commit a2299f8.** `loadInto` arms an unref'd timer of `loadTimeoutMs` (default `POOL_DEFAULTS.loadTimeoutMs` = 30000, copied from the Approved addendum in 02-CONSTANTS.md, named in a comment). On expiry, if the slot still holds the same worker, `detach` rejects the load with `GrammarLoadError('engine_init_failed', '<grammar>: the grammar load timed out after N ms; the parser worker was terminated')`. The timer is cleared in `finally`. `slot.busy` is cleared by the existing `finally` in `execute`, so the queue goes on; a lazy load before a run fails with `parse_failed` carrying the load error. `loadTimeoutMs` is a new `PoolOptions` entry validated like `runTimeoutMs`.
- **Task 2 (IN-06), commit 6ee0887.** `POOL_DEFAULTS` gains `parseTimeoutMs` 5000 (unchanged) and `terminateGraceMs` 2000 (addendum); `runTimeoutMs` default is 7000. Compatibility rules: only `runTimeoutMs` set means the cut-off follows it (today's behaviour); only `engineOptions.parseTimeoutMs` set means the deadline is that value plus the grace; both set means both as given. `poolStatus().limits` exposes the effective values.

## Verification

- `node --test src/grammar-engine/pool/pool.test.ts src/grammar-engine/grammar-engine.test.ts src/bin/compose.test.ts`: 119 pass, 0 fail.
- `node --test "src/grammar-engine/**/*.test.ts"`: 148 pass, 0 fail. `npm run typecheck` and `npm run lint` exit 0.
- Red-first: the Task 1 cases were run before the implementation and failed (silent load and queue-continues hung until their test timeouts; the others failed on the missing option). The Task 2 limits cases failed before the implementation.
- **Mutation check (Task 1 acceptance):** replacing the timer delay with `2 ** 30` makes `silent load` fail by its 10 s test guard; the file was restored from a backup afterwards.
- The survival case (real worker, cut-off 1 ms against a 2001 ms deadline, `hugeSource` from the engine's own deadline test) asserts `parse_timeout`, `timedOut` 0, `crashed` 0, `recycled` 0, one live worker, and a following correct parse on the same grammar. It uses the same input size the engine's existing cut-off test relies on, which already runs on all three OSes, so it is asserted directly; the echo-fixture cases separately prove the cut-off handed to the worker.
- `npm test` (whole suite): 2404 of 2405 pass. The one failure, `scripts/parity.test.ts` "health: identical JSON ...", took 12 s under full-suite load and passes (12 of 12) when the file is run alone; it does not touch the pool. No SIGTRAP from `parcel-source.test.ts` was seen.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test-only `workerUrl` accepts a function**
- **Found during:** Task 1 (lazy-load case)
- **Issue:** One fixture URL cannot express "first worker answers the caller's load, a later worker never answers the lazy load".
- **Fix:** `PoolOptions.workerUrl` is `URL | ((spawnCount: number) => URL)`; documented as test-only.
- **Files modified:** `src/grammar-engine/pool/pool.ts`
- **Commit:** a2299f8

**2. [Rule 2 - Missing validation] `engineOptions.parseTimeoutMs` validated at construction**
- **Found during:** Task 2
- **Issue:** The plan requires invalid values to throw `RangeError` at construction; an invalid cut-off previously only surfaced as a worker startup error.
- **Fix:** shared `checkPositiveFinite` for `runTimeoutMs`, `parseTimeoutMs`, `loadTimeoutMs`.
- **Commit:** 6ee0887

Otherwise the plan was executed as written. No constant was invented; values come from the Approved addendum (2026-10-17). No guard hook refused a constant.

## Known Stubs

None.

## Threat Flags

None. T-02-122 (hung load occupying a worker) is mitigated: silent-load, queue-continues, lazy-load and dispose-during-load cases cover it.

## Self-Check: PASSED

- FOUND: src/grammar-engine/pool/__fixtures__/silent-worker.ts, src/grammar-engine/pool/__fixtures__/echo-start-worker.ts
- FOUND commits: a2299f8, 6ee0887
