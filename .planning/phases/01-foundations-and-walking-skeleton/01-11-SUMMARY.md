---
phase: 01-foundations-and-walking-skeleton
plan: 11
subsystem: module-seams
status: complete
tags: [governor, precise-resolver, contract-suite, fake-clock, test-doubles]

requires:
  - phase: 01-03
    provides: boundary lint (governor and precise-resolver already in MODULES), production-purity rule for contract.ts
  - phase: 01-04
    provides: Clock and the resolution types (OverlaySnapshot, ResolutionContext, RefSiteKey, ResolvedEdge) in the kernel, FakeClock in the test kit
provides:
  - "Governor interface frozen: run(job, fn(signal)), lease(key, estimatedBytes, onEvict), status()"
  - "createNoopGovernor and createFakeGovernor (priority queue, busy, fake-clock limits, per-request fresh slot, file-set-keyed lease LRU)"
  - "defineGovernorContract, registered for both doubles"
  - "PreciseResolver interface, createScriptedResolver, definePreciseResolverContract with a PreciseResolverSubject shape adapters implement"
affects: [phase-02-indexer, phase-02-query, phase-03-compiler-pool, phase-04-governor]

plan_head_before: 8c9202eb4ca2e5b89d617f9ce2aa2a79b3d5b625
plan_head_after: 3709d669220dcd2e0e5bd32a05de278b5d70c9f4

actuals:
  tokens: 12500   # chars/4 over the 11 hand-written files (50.2 KB)
  tasks: 2
  commits: 2      # MEASURED: git rev-list --count 8c9202e..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "Doubles are production-safe (no node:test, no test-kit); the contract and FakeClock are test-only, imported by *.test.ts"
    - "Argument checks shared by both doubles live in one validate.ts so they reject the same input the same way"
    - "Lease eviction picks its victims before evicting, so a request that cannot fit evicts nothing"

key-files:
  created:
    - src/governor/types.ts
    - src/governor/validate.ts
    - src/governor/noop.ts
    - src/governor/fake.ts
    - src/governor/contract.ts
    - src/governor/index.ts
    - src/governor/governor.test.ts
    - src/precise-resolver/index.ts
    - src/precise-resolver/stub.ts
    - src/precise-resolver/contract.ts
    - src/precise-resolver/precise-resolver.test.ts
  modified: []

key-decisions:
  - "A fresh job joins a running slot with the same requestId even when the queue is non-empty, so a queued sibling never waits behind a different request (D-17)"
  - "The job time limit starts when the function starts running, not at submission; a late settle after timeout is swallowed and cannot free a slot twice"
  - "A shared lease entry is charged at the first estimate and keeps the latest onEvict; entries stay charged (idle) after the last release until evicted; recency is the latest lease grant"
  - "createFakeGovernor returns FakeGovernor, which adds a read-only evictErrors counter for T-01-28; the Governor interface itself is unchanged"
  - "createScriptedResolver takes site+target pairs and stamps confidence EXTRACTED and its own id, so a script cannot violate the contract; a site requested twice is answered once"
  - "PreciseResolverSubject (resolver, overlay, context, resolvable sites, one unresolvable site, closeCount) is the shape a later adapter fills to run the contract unchanged"

patterns-established:
  - "Seam = interface + production-safe doubles in index.ts, shared contract in contract.ts registered per double in the module's test file"

requirements-completed: [FND-05]
---

# Phase 1 Plan 11: Governor and PreciseResolver seams Summary

**Governor signature frozen (priority classes, busy/retry_after, fake-clock limits, one fresh slot per request, file-set-keyed lease LRU) with a no-op and a fake sharing one contract, plus a PreciseResolver interface with a scripted stub and an adapter-ready contract.**

## Accomplishments
- Task 1 (tracer): `src/governor` with the final `Governor` interface, `createNoopGovernor`, `createFakeGovernor` and `defineGovernorContract` registered for both (labels `noop`, `fake`). The fake covers priority order with FIFO inside a class, busy at `maxQueue` with `busyRetryMs`, concurrency, per-job limits on the injected clock (signal aborted, slot freed), D-17 per-request fresh slot, and a lease pool keyed on `fileSetId` with refcounted sharing, LRU eviction of idle entries, and caught-and-counted `onEvict` errors (T-01-28).
- Task 2: `src/precise-resolver` with the `PreciseResolver` interface (JSDoc: EXTRACTED, precise supersedes grammar INFERRED at the same site and the Fact Store applies that in Phase 2), `createScriptedResolver`, and a contract proving requested-sites-only, request order, EXTRACTED plus resolver id, determinism, empty request, and cleanup exactly once on finish, early break and consumer throw.
- Tracer gate: the tracer slice is the Governor suite; re-ran end to end (`node --test src/governor/governor.test.ts`, 38 tests) before expanding to Task 2. Passed.
- Full gate: `npm test` 395 pass / 0 fail, `npm run typecheck` and `npm run lint` clean.

## Task Commits
1. Task 1 (tracer): `0075d71` feat(01-11): freeze Governor seam with no-op and fake doubles
2. Task 2: `3709d66` feat(01-11): add PreciseResolver seam with scripted stub and shared contract

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] Added `src/governor/validate.ts`**
- **Found during:** Task 1
- **Issue:** Both doubles must reject malformed input identically (unknown job class, bad `timeoutMs`, negative or fractional `estimatedBytes`), otherwise the shared status contract (non-negative integers) can be broken by a bad estimate.
- **Fix:** One small internal helper file, not exported from `index.ts`. Not in the plan's `files_modified` list.
- **Commit:** 0075d71

**2. [Plan wording] Red phase not committed separately.** Tests were written before the implementation, but a red commit would fail typecheck and the repo-wide hooks, so each task landed as one commit with tests and implementation together.

Otherwise the plan was executed as written. No auth gates.

## Known Stubs
None. `createScriptedResolver` and the two Governor doubles are intentional Phase 1 doubles (D-10); real scheduling lands in Phases 2 and 4 and the precise adapters in Phase 3 onward (see roadmap), and no UI or runtime path consumes them yet.

## Threat Flags
None. T-01-27 accepted (no-op admits everything; the bounded fake pins busy semantics). T-01-28 mitigated (`onEvict` errors caught and counted, covered by a test that keeps evicting past a throwing callback).

## Notes for later phases
- `cost` is carried on `Job` but ignored by the doubles; the real Governor weighs it in Phase 4.
- The fake races `clock.sleep` against the job and never cancels the sleep, so it is meant for a fake clock (documented in `fake.ts`).
- A lease larger than the whole budget returns busy forever in the fake; the real Governor should decide whether to reject it outright.
- An adapter placed in another module cannot import `precise-resolver/contract.ts` (D-12); the adding phase must make a deliberate, dated lint exception, as the plan notes.

## Self-Check: PASSED
- All 11 files exist; commits 0075d71 and 3709d66 are ancestors of HEAD.
