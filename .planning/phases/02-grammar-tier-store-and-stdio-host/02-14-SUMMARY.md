---
phase: 02-grammar-tier-store-and-stdio-host
plan: 14
subsystem: grammar-engine
tags: [worker_threads, web-tree-sitter, pool, recycling, parse-deadline, lng-07]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-07 GrammarEngine with matchLimit and parseTimeoutMs, withTree; 02-13 typescript and javascript modules; 02-CONSTANTS.md (approved)"
provides:
  - "createPooledGrammarEngine: a GrammarEngine backed by a bounded, recycled pool of worker threads, plus poolStatus()"
  - "POOL_DEFAULTS: the approved pool.size, pool.recycleAfterFiles, indexer.parseTimeoutMs and the shared matchLimit in one constant"
  - "resolveWorkerUrl: one helper for the worker file in src (.ts) and dist (.js)"
affects: [02-15 Indexer, 02-24 history, 02-26 gates, 02-28 Host]

actuals:
  tokens: 12000
  tasks: 3
  commits: 5
plan_head_before: 7806892df0959d3b1b55b4e64f588cb7ea34033e
plan_head_after: d68fe92d9c695a0d83efd0b99b26093549234769

tech-stack:
  added: []
  patterns:
    - "Slot-based pool: one job per worker, FIFO queue, lazy spawn, lazy per-worker grammar load, supervision by detach(slot, error)"
    - "A worker file hosts the real engine; the pool never constructs an engine on the main thread"
    - "Hard deadline by terminating the worker, with an unref'd timer, on top of the engine's own cancellable parse deadline"

key-files:
  created:
    - src/grammar-engine/pool/pool.ts
    - src/grammar-engine/pool/worker.ts
    - src/grammar-engine/pool/protocol.ts
    - src/grammar-engine/pool/worker-url.ts
    - src/grammar-engine/pool/pool.test.ts
    - src/grammar-engine/pool/__fixtures__/spin-worker.ts
  modified:
    - src/grammar-engine/index.ts
    - src/grammar-engine/contract.ts
    - tsconfig.build.json

key-decisions:
  - "The shared matchLimit is GRAMMAR_LIMITS.matchLimitMax (65536), the value plan 02-13's recall engine already uses; 02-CONSTANTS.md has no row for it, so no number was invented"
  - "runTimeoutMs defaults to indexer.parseTimeoutMs (5000) and the engine inside each worker gets the same value; at equal values the pool deadline normally fires first (terminate and lazy reload), both end in parse_timeout"
  - "An invalid engine option surfaces from the worker as a coded load error, not as a RangeError from createPooledGrammarEngine; the pool itself throws RangeError for size, recycleAfterRuns and runTimeoutMs"
  - "Crash and deadline tests use a fixture worker that speaks the real protocol (spin, crash, throw on request) instead of reaching into the pool for a Worker object"

patterns-established:
  - "Pool supervision: every way a worker ends (deadline, exit, error, recycle, dispose) goes through one detach() that fails or resolves in-flight requests, clears the grammar set and terminates in the background"
  - "Stale worker events are ignored by comparing slot.worker with the worker the handler was bound to"

requirements-completed: [LNG-07]

coverage:
  - id: D1
    description: "Parsing runs in a bounded pool of worker threads behind the GrammarEngine interface; results, error classes and codes equal the in-process engine"
    requirement: LNG-07
    verification:
      - kind: unit
        ref: "src/grammar-engine/pool/pool.test.ts#Grammar Engine contract: pooled"
        status: pass
      - kind: unit
        ref: "src/grammar-engine/pool/pool.test.ts#pooled engine against the in-process engine"
        status: pass
    human_judgment: false
  - id: D2
    description: "Pool size follows the approved rule, further runs wait in a FIFO queue, and a grammar loads lazily into each worker that receives a run"
    requirement: LNG-07
    verification:
      - kind: unit
        ref: "src/grammar-engine/pool/pool.test.ts#pool scheduling"
        status: pass
    human_judgment: false
  - id: D3
    description: "A run past the deadline terminates its worker and rejects with parse_timeout; a crashed or exited worker rejects its run with parse_failed; both respawn; dispose rejects queued runs"
    requirement: LNG-07
    verification:
      - kind: unit
        ref: "src/grammar-engine/pool/pool.test.ts#pool supervision"
        status: pass
    human_judgment: false
  - id: D4
    description: "Workers are recycled after the configured number of runs and the grammar reloads transparently"
    requirement: LNG-07
    verification:
      - kind: unit
        ref: "src/grammar-engine/pool/pool.test.ts#pool recycling"
        status: pass
    human_judgment: false
  - id: D5
    description: "The pool runs both built-in modules and the toy language without cross-contamination, and process memory stays bounded over 1,200 files"
    requirement: LNG-07
    verification:
      - kind: unit
        ref: "src/grammar-engine/pool/pool.test.ts#pool against the built-in modules and the toy language"
        status: pass
      - kind: unit
        ref: "src/grammar-engine/pool/pool.test.ts#pool memory plateau (LNG-07)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The compiled package finds its worker file in dist and exits cleanly after dispose"
    requirement: LNG-07
    verification:
      - kind: other
        ref: "npm run build, then a node script loading dist/grammar-engine/pool/pool.js and running the toy grammar"
        status: pass
    human_judgment: true
    rationale: "Checked once by hand on this machine; no committed test loads dist. Linux and Windows are unverified until three-OS CI runs the pool tests."

duration: 16min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 14: Worker Pool Summary

**A bounded, recycled pool of worker threads behind the existing GrammarEngine interface: FIFO queue, lazy per-worker grammar load, a hard per-run deadline that terminates the worker, crash recovery, and a measured RSS plateau over 1,200 files.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-10-16T21:27:23Z
- **Completed:** 2026-10-16T21:43:16Z
- **Tasks:** 3
- **Files modified:** 9 (6 created, 3 modified)

## Accomplishments

- `createPooledGrammarEngine(options)` returns a `GrammarEngine` plus `poolStatus()`. It passes the shared `defineGrammarEngineContract` suite and returns results deep-equal to the in-process engine (BOM stripping, CRLF, UTF-16 columns, `match` indexes), so LNG-08 holds through the pool.
- Scheduling: up to `size` workers (default `min(4, cpus-1)`, at least 1), one job per worker, a FIFO queue, workers spawned on demand, and a grammar loaded into a worker only when that worker first receives a run for it.
- Supervision: every run has a hard deadline (an unref'd timer). A run past it terminates its worker and rejects with `parse_timeout`. A worker that exits or throws rejects its in-flight run with `parse_failed`, counts one crash and is replaced; queued runs behind it are unaffected. `dispose()` rejects queued and in-flight runs with `parse_failed` "pool disposed", terminates every worker and is idempotent.
- Recycling: a worker is replaced after `recycleAfterRuns` completed runs (default 2000) and the grammar reloads in the replacement.
- Memory (LNG-07): 1,200 distinct ~8 KB TypeScript files through two workers recycling every 400 runs gave RSS 60 (baseline), 222, 307, 348 MiB on the last run of five (222-230, 306-308, 348-352 across the five). The assertion is relative (`last <= max(first two warm samples) * 1.25 + 64 MiB`). A longer exploration with the same synthetic files (24 rounds of 400, two workers, recycling every 400) levelled off at about 397 MiB from round 11 on, so the early climb is warm-up, not a leak.
- `resolveWorkerUrl()` returns `worker.ts` from source and `worker.js` from dist; a built `dist/grammar-engine/pool/pool.js` ran the toy grammar and exited cleanly.

## Task Commits

1. **Task 1: Tracer, one worker runs the toy grammar like the main thread** - `33d9ab5` (test, RED), `0f5d8a8` (feat, GREEN)
2. **Task 2: Many workers, FIFO queue, recycling, deadline and crash recovery** - `505fd50` (test, RED), `577f2d0` (feat, GREEN)
3. **Task 3: Memory plateau and the pool against both built-in modules** - `d68fe92` (test)

**Plan metadata:** the docs commit that carries this file and the state updates.

## TDD Gate Compliance

The plan is `type: execute` with `tdd="true"` tasks, so the gate sequence applies per task.

- **Task 1 RED:** target `names worker.ts when this module is a .ts file` in `pool.test.ts`; the stub `resolveWorkerUrl` returned `worker.js` and the stub pooled engine rejected every load. 19 of 20 cases failed. `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK`. Semantic assessment: the target ran and failed on its own URL-suffix assertion, the contract and pool cases failed because the stub rejects load; no syntax, import or fixture fault. GREEN `0f5d8a8`.
- **Task 2 RED:** target `recycles a worker after recycleAfterRuns runs and reloads the grammar in the replacement`; failed on `recycled 0` (ERR_ASSERTION) against the single-worker pool of Task 1. `RED_EVIDENCE_OK` on a report limited with `--test-name-pattern="pool scheduling|pool recycling"`. Semantic assessment: size, lazy-load and option cases failed on their own assertions in the same report. The supervision cases (deadline, crash, dispose) are not in that report because against the Task 1 pool a spinning fixture worker never answers, so the file cannot finish; they are the GREEN evidence (all pass, 36 of 36). A first RED capture over the whole file was rejected by the classifier ("interrupted by timeout") and was redone. GREEN `577f2d0`.
- **Task 3:** tests only, no production change, so there is no RED commit. The tests passed on first run because Tasks 1 and 2 had already built the behaviour. To show the cross-contamination test can fail, the worker's grammar map was temporarily keyed by a constant: the test failed with the wrong captures, and the change was reverted (no diff remains in `worker.ts`).

## Files Created/Modified

- `src/grammar-engine/pool/pool.ts` - pool, `POOL_DEFAULTS`, `PoolOptions`, `PoolStatus`
- `src/grammar-engine/pool/worker.ts` - worker entry; the only `createGrammarEngine` call in the pool directory
- `src/grammar-engine/pool/protocol.ts` - structured-clone message types
- `src/grammar-engine/pool/worker-url.ts` - `resolveWorkerUrl`
- `src/grammar-engine/pool/pool.test.ts` - contract wiring, scheduling, recycling, supervision, two-module and plateau tests
- `src/grammar-engine/pool/__fixtures__/spin-worker.ts` - test-only worker that spins, exits or throws on request
- `src/grammar-engine/index.ts` - exports `createPooledGrammarEngine`, `POOL_DEFAULTS` and the option types
- `src/grammar-engine/contract.ts` - `runInProcess` helper (see deviations)
- `tsconfig.build.json` - excludes `src/**/__fixtures__/**`; `dist` has `pool/worker.js` and no fixture

## Decisions Made

- Shared `matchLimit` is `GRAMMAR_LIMITS.matchLimitMax` because `02-CONSTANTS.md` has no matchLimit row and plan 02-13 already runs its recall engine with that value. No number was invented.
- The pool deadline and the engine's own parse deadline are both `indexer.parseTimeoutMs`. They race; the pool deadline usually wins because it starts at post time, which costs one worker respawn and grammar reload but gives the same `parse_timeout`. A grace period would be a new constant, so none was added.
- A bad engine option reaches the worker and comes back as a coded error on load (the worker answers every request with the construction error), so the pool never has a dead-on-arrival worker. Pool options themselves are validated with `RangeError` at creation.
- Crash, exit and deadline paths are tested with a fixture worker speaking the real protocol rather than exposing worker handles from the pool.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `runInProcess` helper added to `contract.ts`**
- **Found during:** Task 3
- **Issue:** The Task 3 behaviour needs the in-process engine's captures and facts for the two real modules, but Task 1's acceptance criterion says `worker.ts` is the only file in the pool directory that calls `createGrammarEngine`. `scenarios.expected` only covers the toy module.
- **Fix:** Added `runInProcess(input, sources)` to `src/grammar-engine/contract.ts`, next to the existing real-engine helper, and called it from `pool.test.ts`. `contract.ts` is not in the plan's file list.
- **Files modified:** `src/grammar-engine/contract.ts`
- **Verification:** `codegraph callers createGrammarEngine` shows `src/grammar-engine/pool/worker.ts` as the only caller in `src/grammar-engine/pool/`; the pool and grammar-engine suites pass.
- **Committed in:** `d68fe92`

**2. [Rule 1 - Bug] Test sampler could outlive a failed assertion**
- **Found during:** Task 2 RED capture
- **Issue:** The concurrency test's sampling loop only stopped after the assertions, so a failing assertion left a `setImmediate` loop running and the test process never exited (two RED captures hung).
- **Fix:** Wrapped the assertions and the await in `try/finally` that stops and awaits the sampler.
- **Files modified:** `src/grammar-engine/pool/pool.test.ts`
- **Verification:** RED capture then finished with the expected failures.
- **Committed in:** `577f2d0`

**3. [Interpretation] Plan line for the plan-commit ledger**
- The shared `.git/worktrees/...` directory cannot be written from this isolated session, so the base commit for `commits:` was recorded in the session scratchpad (`7806892`) and measured from there: `git rev-list --count 7806892..HEAD` is 5.

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug), 1 interpretation note
**Impact on plan:** No scope change. The contract.ts helper is test-support code excluded from the build.

## Issues Encountered

- The first Task 2 RED report was rejected by the classifier as interrupted; rerun limited to the suites that can finish against the Task 1 pool.
- The harness memtrace guard denies `grep` on indexed source files, so two acceptance greps (`Math.random` count, `unref` present) were verified by construction and by `codegraph callers`, not by grep. `Math.random` is not used: file generators are seeded by index.
- Pre-existing, out of scope: none found; `npm test` passes in full (1598 of 1598).

## Known Stubs

None.

## Threat Flags

None. T-02-44 (hang) is covered by the deadline and the spinning-worker test, T-02-45 (memory) by recycling and the plateau test, T-02-46 (tampered wasm) by the hash check inside each worker's engine (contract case `rejects a wrong hash`). T-02-47 (unbounded queue) is accepted as planned: callers bound submissions through the Governor.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 02-15 (Indexer) can take `createPooledGrammarEngine()` and `POOL_DEFAULTS` from `src/grammar-engine/index.ts`. Every engine in one process must use the same `matchLimit`; the pool's workers do, and the Indexer should pass the pool defaults rather than its own value.
- Linux and Windows are unverified for worker termination, `process.exit` in a worker thread and the RSS plateau until three-OS CI runs `pool.test.ts`; the plateau bound is relative for that reason.
- If a hosted runner is slower, reduce the file count in the plateau test rather than loosening the bound (plan instruction).

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*

## Self-Check: PASSED

- Files: pool.ts, worker.ts, protocol.ts, worker-url.ts, pool.test.ts, `__fixtures__/spin-worker.ts`, index.ts and tsconfig.build.json all exist.
- Commits `33d9ab5`, `0f5d8a8`, `505fd50`, `577f2d0`, `d68fe92` are ancestors of HEAD.
- `node --test src/grammar-engine/pool/pool.test.ts src/grammar-engine/grammar-engine.test.ts`, `npm run typecheck`, `npm run lint`, `npm run build` and the full `npm test` (1598 of 1598) pass.
