---
phase: 02-grammar-tier-store-and-stdio-host
plan: 09
subsystem: governor
tags: [governor, scheduling, priority-classes, backpressure, retry-after, clock-after, lease-pool, lru]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-02 Clock.after(ms, fn) with an idempotent cancel, and the FakeClock implementation"
  - phase: 01-foundations
    provides: "Governor interface, noop and fake doubles, validate.ts (frozen in Phase 1)"
provides:
  - "createGovernor(options): RealGovernor, the production scheduler behind the frozen Governor interface"
  - "DEFAULT_GOVERNOR_OPTIONS (concurrency 4, per-class maxQueue and busyRetryMs) copied from the approved 02-CONSTANTS.md"
  - "defineGovernorSchedulingContract(label, make) shared by the fake and the real Governor"
affects: [02-15 indexer, 02-17 mcp shim, 02-20 host, 04 HRD-05 weighted round-robin]

actuals:
  tokens: 11000
  tasks: 2
  commits: 4
plan_head_before: 3b4d67202b0d310d1750dced41c431287e4565b8
plan_head_after: d05bb2c533a75ecff88dedc3230fae9a3b39a098

tech-stack:
  added: []
  patterns:
    - "One arrival-ordered waiting list per priority class; the pump takes the first startable job of the highest class"
    - "Per-class admission: busy when the job's own class queue is at its bound, with that class's retry delay"
    - "Job limit armed with Clock.after when the job starts, cancelled in the settle path (no pending timer after a job settles)"
    - "Shared contract suites parameterised by a make function, run for every implementation of a seam"

key-files:
  created:
    - src/governor/real.ts
    - src/governor/defaults.ts
  modified:
    - src/governor/contract.ts
    - src/governor/governor.test.ts
    - src/governor/index.ts

key-decisions:
  - "Queue bounds are per class and must be finite non-negative integers; Infinity is rejected (unlike the fake), so no configuration can make a queue unbounded (T-02-25)."
  - "A lease that cannot be granted answers busy with the interactive class's retry delay: leases are taken on behalf of reads, and the interface has no class for them."
  - "Per-class option errors are RangeErrors that name the option and class (maxQueue.indexing, busyRetryMs.fresh), so a bad config line is found without reading the stack."
  - "The Governor interface is unchanged; the real Governor additionally exposes a read-only evictErrors counter (type RealGovernor), the same extra the fake already had, because the scheduling contract asserts a throwing onEvict is counted."
  - "Job.tenant is carried but unused for scheduling; a busy swarm in one tenant can fill a class. Accepted until HRD-05 (Phase 4), as flagged in the plan."

patterns-established:
  - "Test-only helpers (deferred, job, mustLease) live in contract.ts next to the contracts and are not re-exported from index.ts"
  - "A clock wrapper that counts live Clock.after timers is the way to prove a component leaves nothing pending"

requirements-completed: [HST-03]

coverage:
  - id: D1
    description: "createGovernor schedules interactive over fresh over indexing over maintenance, first come first served inside a class, under a concurrency cap; a later higher-priority job overtakes queued jobs but never a running one"
    requirement: HST-03
    verification:
      - kind: unit
        ref: "src/governor/governor.test.ts#real Governor: priority and admission; Governor contract: real"
        status: pass
    human_judgment: false
  - id: D2
    description: "A job whose own class queue is at its bound resolves busy with that class's retry_after and its function never runs; a class with room is still admitted; maxQueue 0 admits only into a free slot"
    requirement: HST-03
    verification:
      - kind: unit
        ref: "src/governor/governor.test.ts#real Governor: per-class bounds"
        status: pass
    human_judgment: false
  - id: D3
    description: "Per-job time limit on Clock.after, cancelled when the job settles (ok, rejection, timeout, saturation run): zero live timers afterwards"
    requirement: HST-03
    verification:
      - kind: unit
        ref: "src/governor/governor.test.ts#real Governor: job timers; per-class bounds#leaves no live timer once every job of a saturation run has settled"
        status: pass
    human_judgment: false
  - id: D4
    description: "One fresh slot per request, file-set keyed lease sharing and LRU eviction behave identically in the fake and the real Governor (shared scheduling contract)"
    requirement: HST-03
    verification:
      - kind: unit
        ref: "src/governor/governor.test.ts#fake Governor / real Governor scheduling contract suites"
        status: pass
    human_judgment: false
  - id: D5
    description: "Defaults are the approved constants (concurrency 4, maxQueue 64/64/1024/8, busyRetryMs 250/250/1000/5000), every class finite; invalid options throw RangeError naming the option"
    requirement: HST-03
    verification:
      - kind: unit
        ref: "src/governor/governor.test.ts#real Governor: option validation; per-class bounds#gives every class in the default options a finite bound"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 09: Real Governor Summary

**Production Governor with four priority classes, a concurrency cap, per-class bounded queues that answer busy with that class's retry_after, per-job limits on cancellable Clock.after timers and the file-set lease pool, passing one shared scheduling contract together with the pinned fake.**

## Performance

- **Duration:** about 25 min
- **Started:** approximate (start time not captured); completed 2026-10-16
- **Tasks:** 2 (TDD: 4 commits)
- **Files modified:** 5 (2 created)

## Accomplishments

- `createGovernor` implements HST-03 behind the Phase 1 interface without changing it: one waiting list per class, a pump that starts the first startable job of the highest class, fresh jobs of one request sharing a slot (D-17), and the lease pool with reference counting, recency and victims decided before any eviction.
- Saturation is bounded in every class by default (maxQueue 64, 64, 1024, 8) and answers `{kind: 'busy', retry_after}` with the class's own delay (250, 250, 1000, 5000 ms); nothing queues without bound.
- A job's limit is armed with `Clock.after` on start and cancelled in the settle path. A counting clock proves zero live timers after a normal finish, a rejection, a timeout and a 30-job saturation run, which the fake's uncancellable `Clock.sleep` race could not offer.
- The fake-only scheduling and lease cases moved into `defineGovernorSchedulingContract`; fake and real both pass them (74 tests at Task 1, 86 at Task 2, plus the 1306-test full suite green).

## Task Commits

1. **Task 1: Tracer, real Governor against the shared contracts** - RED `2016d07` (test), GREEN `d7ecb61` (feat)
2. **Task 2: Per-class bounds, busy under saturation, timer-leak check** - RED `0b45082` (test), GREEN `d05bb2c` (feat)

**Plan metadata:** committed separately after this summary (docs).

## TDD Gate Compliance

RED evidence (classifier verdict `RED_EVIDENCE_OK` for each; records kept untracked under `.planning/red-evidence-02-09-t{1,2}.json`):

- **Task 1:** target `leaves no live timer after a job with a timeoutMs completes normally`. The RED commit carries a stub `createGovernor` that throws, so the new real-Governor cases (35 in total, across the shared contract, the scheduling contract and the timer checks) fail inside the test body while noop and fake cases pass. The failure is the missing implementation, not a load fault.
- **Task 2:** target `throws RangeError naming maxQueue for a negative bound`. Per-class values were merged but not validated, so `assert.throws` failed; the two sibling validation cases failed identically. The per-class busy, `maxQueue 0`, default-bound, 100-job and timer-leak cases passed at RED because Task 1 already implemented per-class admission (the plan's Task 1 action step 3 requires it); they are characterization, not RED targets.

RED commits precede GREEN commits for both tasks; no REFACTOR commits were needed.

## Tracer feedback gate

Tracer `<verify>` is automated-only; re-run end to end after the GREEN commit (`node --test src/governor/governor.test.ts`, `npm run typecheck`, `npm run lint` all exit 0): tracer verified, expansion proceeded.

## Files Created/Modified

- `src/governor/real.ts` - `createGovernor`, `GovernorOptions`, `RealGovernor`
- `src/governor/defaults.ts` - `DEFAULT_GOVERNOR_OPTIONS`, `GovernorDefaults`; comment names 02-CONSTANTS.md as the source
- `src/governor/contract.ts` - `defineGovernorSchedulingContract` plus the shared helpers `deferred`, `job`, `mustLease`
- `src/governor/governor.test.ts` - contracts for noop, fake and real; counting-clock, per-class bound and validation cases for the real Governor
- `src/governor/index.ts` - exports `createGovernor`, `GovernorOptions`, `RealGovernor`, `DEFAULT_GOVERNOR_OPTIONS`, `GovernorDefaults`

## Decisions Made

See `key-decisions` above. Notable: finite-only queue bounds, lease busy uses the interactive delay, and no per-tenant fairness before HRD-05.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The shared busy case could not keep the fake's "interactive fourth submission"**
- **Found during:** Task 1 (moving the fake-only cases)
- **Issue:** The fake's busy test submitted three `indexing` jobs and then an `interactive` fourth, expecting busy because the fake has one global queue. Under the plan's per-class admission an interactive job has its own queue with room and is correctly admitted, so the case cannot be shared as written.
- **Fix:** The shared case submits the fourth job as `indexing` (same class), which both implementations answer with busy. The cross-class behaviour (a class with room still admits) is covered by a real-Governor-only test.
- **Files modified:** `src/governor/contract.ts`, `src/governor/governor.test.ts`
- **Commit:** `2016d07`

**2. [Rule 2 - Missing critical] RealGovernor type exposing evictErrors**
- **Found during:** Task 1
- **Issue:** The moved lease case asserts that a throwing `onEvict` is counted, which needs the fake's read-only `evictErrors`; the frozen `Governor` interface has no such member.
- **Fix:** `createGovernor` returns `RealGovernor` (the interface plus `evictErrors`), mirroring `FakeGovernor`; the interface is untouched.
- **Commit:** `d7ecb61`

**3. [Rule 3 - Blocking] Per-class validation sequenced into Task 2**
- **Found during:** Task 2 planning
- **Issue:** Task 1 requires per-class admission and Task 2 requires per-class resolution and validation; implementing both in Task 1 would leave Task 2 with no valid RED.
- **Fix:** Task 1 merges per-class values and validates `concurrency` and `memoryBudgetBytes`; Task 2 adds validation of each per-class value, which is the RED target.
- **Commits:** `d7ecb61`, `d05bb2c`

**Total deviations:** 3 auto-fixed (1 bug, 1 missing critical, 1 blocking). **Impact:** none on scope or interface.

## Issues Encountered

None.

## Known Stubs

None. (The RED-commit stub of `createGovernor` was replaced in the GREEN commit.)

## Threat Flags

None. T-02-25 (unbounded queue growth) is mitigated: every class has a finite default bound, `Infinity` is rejected, and the saturation tests assert busy for the default maintenance bound and the custom bounds. T-02-26 (leaked timers or stuck slots) is mitigated: the settle path always frees the slot and cancels the timer, covered for ok, synchronous throw, rejection and timeout. T-02-27 stays accepted (HRD-05).

## Next Phase Readiness

Ready for the Indexer (02-15, 02-17) and the Host (02-20) to take `createGovernor({ clock: systemClock })` and map `busy` to the wire's retry_after. Note for 02-15: `Job.timeoutMs` is measured from job start and aborts the signal, so long indexing jobs should pass `indexer.parseTimeoutMs`-scale limits per file, not per sweep.

## Self-Check: PASSED

Files verified on disk (`real.ts`, `defaults.ts`, `contract.ts`, `governor.test.ts`, `index.ts`) and commits `2016d07`, `d7ecb61`, `0b45082`, `d05bb2c` are ancestors of HEAD. `node --test src/governor/governor.test.ts` 86/86, `npm test` 1306/1306, `npm run typecheck`, `npm run lint` and `npm run build` exit 0.
