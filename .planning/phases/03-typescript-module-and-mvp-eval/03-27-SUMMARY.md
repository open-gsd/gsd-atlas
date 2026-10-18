---
phase: 03-typescript-module-and-mvp-eval
plan: 27
subsystem: precise-resolver-typescript
tags: [memory-budget, rss-sampler, worker-pool, lru, memory-stop-latch, program-eviction, no-break-trace, tdd]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-23 compiler worker, client, tier and the exact worker shape (heap flag pattern of 1 to 6 digits, one env key); 03-25 relations over the same worker; 03-16 frozen Stage A (D-08 precondition); 03-CONSTANTS.md precise.* rows; Gate OQ2 (D-21 deviation): Approved in 03-DECISIONS.md"
provides:
  - "src/precise-resolver/typescript/budget.ts: deriveBudget, createMemoryBudget (LRU reservation ledger), MEMORY_DEFAULTS (the approved precise.* values), PROGRAM_EVICT_FRACTION"
  - "sampler.ts and sampler-url.ts: the in-worker RSS sampler thread (marker line GSD_ATLAS_MEMORY_LIMIT, SIGKILL), shouldKill, startSampler, MARKER_PATTERN"
  - "pool.ts: createWorkerPool, the machine-wide LRU pool with in-flight protection, idle release, replacement and the per-tenant memory-stop latch"
  - "client.ts: createResolverMemory (one budget and pool), createTuningMemory, CompilerWorker handle, WorkerInfo.programs/lastRssMb/peakRssMb/sampler, clearMemoryStop; the heap flag AND the sampler limit are always derived from the budget"
  - "worker.ts: sampler started before the compiler loads; programs kept most recently used first and dropped past 70 percent of the RSS limit; done carries programs and rssMb"
  - "protocol: init.rssLimitMb and sampleMs, ready.sampler, done.programs and rssMb (all optional)"
  - "src/host/tiers.ts createTierMemory and src/bin/compose.ts: exactly one budget and pool per composed Host, from os.totalmem() (ComposeOptions.totalMemBytes injectable)"
  - "scripts/precise-gate.ts --nobreak and --budget-mb (both modes)"
affects: [03-29, 03-30, 03-31]
tech-stack:
  added: []
  patterns:
    - "The memory watch is a thread of the worker process: it sees process-wide RSS and kills the process while the main thread is blocked; the V8 heap flag is the backstop; the parent tells a memory stop from a crash by the marker line"
    - "One budget and one pool per Host: a worker holds its RSS limit as its reservation, a request that does not fit evicts idle workers least recently used first and never one with a request in flight"
    - "A project stopped for memory costs one failed start: the latch answers memory_budget until the context key (context id, config hashes, compiler directory) changes, clearMemoryStop is called, or the tier is rebuilt"
key-files:
  created:
    - src/precise-resolver/typescript/budget.ts
    - src/precise-resolver/typescript/budget.test.ts
    - src/precise-resolver/typescript/sampler.ts
    - src/precise-resolver/typescript/sampler-url.ts
    - src/precise-resolver/typescript/pool.ts
    - src/precise-resolver/typescript/memory.test.ts
    - src/precise-resolver/typescript/__fixtures__/spin-alloc-worker.ts
    - scripts/precise-gate.test.ts
  modified:
    - src/precise-resolver/typescript/worker.ts
    - src/precise-resolver/typescript/client.ts
    - src/precise-resolver/typescript/tier.ts
    - src/precise-resolver/typescript/protocol.ts
    - src/precise-resolver/typescript/index.ts
    - src/precise-resolver/typescript/resolver.test.ts
    - src/precise-resolver/index.ts
    - src/host/tiers.ts
    - src/host/index.ts
    - src/bin/compose.ts
    - src/bin/compose.test.ts
    - scripts/precise-gate.ts
key-decisions:
  - "A worker's reservation is its RSS limit, and by default that is the whole budget (rssLimitMb equals budgetMb, heap is 0.8 of it). One worker lives machine-wide by default: the sum of limits can never exceed the budget, so the machine bound holds without measuring. A tuning (workerMb, rssLimitMb) lets several fit; the default is the conservative reading of 'its share'."
  - "The sampler starts at the beginning of init, before the compiler is loaded (the plan says right after init): a budget that cannot hold the compiler itself is then stopped before ready, and the limit of 60 MB in the test proves it."
  - "The latch key is the resolution context id plus its config hashes plus the compiler directory. The context id alone does not move when a tsconfig changes (it is 'typescript:6.0.3:bundled'), the config hashes do. The latch lives in the pool, per tenant (the tenant id is the worktree plus a counter), so a Host-wide pool serves many tenants without mixing them."
  - "A memory stop is tied to the project context, not to one owner config: after the first stop every read in the same context answers memory_budget, small packages included. That is the plan's contract (one failed start per project) and it is honest (the code is on every answer); a per-config latch would allow more precision on a monorepo at the cost of more failed starts and is left to a later plan."
  - "Program eviction measures RSS with process.memoryUsage.rss() every time it decides. V8 returns memory later than a program is dropped, so the rule may drop every older program in one go; that costs a rebuild and never a wrong answer. It runs before a program is built, after it is built and before every done."
  - "No new timer or constant for the latch. The 70 percent share is in the plan text but not in 03-CONSTANTS.md (flagged in Deviations)."
  - "The Host's idle timers use the injected Clock when given and unref'd real timers otherwise, so a CLI process that forgot to close the Host does not wait five minutes to exit."
requirements-completed: [TSM-05]
status: complete
commits: 6
plan_head_before: 5cd98f2e35aa7dcb2d67578f45db9739c940b0d9
plan_head_after: bc918124f3b610f8b8d10e3a61772a1b70607adc
actuals:
  tokens: 29400
  tasks: 3
  commits: 6
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 27: Bounded compiler memory Summary

**A compiler worker past its RSS limit is ended by a sampler thread of its own within a fraction of a second (even with its main thread spinning), every ending is mapped to `memory_budget` or `resolver_failed`, one machine-wide LRU pool shares 25 percent of RAM across all tenants, and the pinned gsd-pi traces without a crash, a breach or an unexplained answer.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | A worker past its RSS limit is ended by its own sampler and the read degrades with memory_budget | 4a6bd18 | 133552a |
| 2 | The machine-wide LRU pool, idle release, and least-recently-used programs inside a worker | 876c226 | 2108f59 |
| 3 | The gsd-pi no-break trace and the small-budget runs | a945c70 | bc91812 |

The tracer gate (task type `tracer`, no `gate` attribute, auto mode off, `HUMAN_VERIFY_MODE` end-of-phase): the automated `<verify>` was re-run end to end after the commit and passed, so execution continued.

## What was built

- **Budget** (`budget.ts`): `deriveBudget({totalMemBytes, percent, heapShare, minMb})` gives whole-megabyte `budgetMb`, `heapMb` (clamped to the six digits the worker shape accepts), `rssLimitMb` (the budget) and `usable` (budget at least `precise.minBudgetMb`); a percent outside 1 to 90 or a RAM value that is not positive and finite is a RangeError. `createMemoryBudget` keeps the reservation ledger in recency order and serialises decisions, so two requests that cannot both fit are decided one at a time.
- **Sampler** (`sampler.ts`): a `worker_threads` thread inside the compiler process. Every `precise.rssSampleMs` it reads process RSS; past the limit it writes `GSD_ATLAS_MEMORY_LIMIT rss=<bytes> limit=<bytes>` to fd 2 and calls `process.kill(process.pid, 'SIGKILL')`. A fixture whose main thread allocates in a loop that never yields is ended with a 50 ms period and an 80 MB limit, and the whole test (process start, thread start, allocation, kill) takes about 110 ms; the test allows 1000 ms from the first `spinning` line.
- **Client mapping**: the marker line, a V8 abort text, SIGABRT and the Windows abort codes are `memory_budget`; a SIGKILL without the marker is `resolver_failed`. The client always sends both limits in `init`; a budget below the floor never reaches the pool's `start`.
- **Pool** (`pool.ts`): one pool per Host. `acquire` returns the running worker or reserves a share (evicting idle workers least recently used first, never one with a request in flight, asking the pool's `start` last); a request that cannot be held, an unusable budget and a closed pool answer `memory_budget` and start nothing. `release` arms the idle timer (`precise.idleExitMs`, cancellable through the injected Clock), a worker that ended by itself is dropped at release or on `notifyExit`. `drop` ends a tenant; `close` ends everything and cancels every timer.
- **Worker**: programs for owner configs are kept most recently used first; before a new program is built, after it is built and before each `done`, the oldest are dropped while RSS is over 70 percent of the limit, never the one a request uses. `done` reports `programs` and `rssMb`.
- **Wiring**: `composeHost` builds exactly one budget and pool from `os.totalmem()` (or `totalMemBytes`), passes them to every tenant's tier through the tier tuning, and closes the pool in `dispose`.
- **Gate script**: `--nobreak --corpus <id> --dir <checkout> [--budget-mb n] [--seed n] [--symbols n]`, and `--budget-mb` for `--trace`.

## Memory budget check (03-23 figures against this plan's budget)

03-23 measured the gsd-core worker at 92.8 MB at `ready` and 403.4 MB sampled after the program was built. Against the budget this plan owns:

| Machine RAM | Budget (25 percent) | Heap flag | RSS limit | gsd-core worker (about 400 MB) |
|-------------|---------------------|-----------|-----------|--------------------------------|
| 128 GiB (this machine) | 32,768 MB | 26,214 MB | 32,768 MB | 1 percent |
| 16 GiB | 4,096 MB | 3,276 MB | 4,096 MB | 10 percent |
| 4 GiB | 1,024 MB | 819 MB | 1,024 MB | 39 percent |
| 2 GiB (the floor) | 512 MB | 409 MB | 512 MB | 78 percent |
| below 2 GiB | under 512 MB | no worker starts | | `memory_budget` on every read |

Measured here with the floor budget (`--trace --budget-mb 512` on the pinned gsd-core): the first precise answer came after 698 ms, no degraded code, worker 108.7 MB at `ready` and 399.9 MB sampled. gsd-core resolves inside the smallest usable budget (D-22). At `--budget-mb 300` (below the floor) the answer is the 11 grammar references flagged `degraded: ["memory_budget"]`, no worker, exit 0.

## D-22 trace on this machine

Machine: 131,072 MB RAM, derived budget 32,768 MB (heap 26,214 MB), macOS arm64, Node 26.11.1. Pinned gsd-pi `bb86b6c` prepared without an install (`--no-npm-ci`, pnpm layout, no dependencies), pinned gsd-core `10ac3a7` prepared with `npm ci --ignore-scripts`. Index build of gsd-pi: 8.9 to 9.3 s. Every run exited 0.

| Run (gsd-pi, seed 27) | Symbols | Resolved | Degraded (codes) | Empty | Worker peak RSS | Limit | Elapsed |
|-----------------------|---------|----------|------------------|-------|-----------------|-------|---------|
| default budget, 12 symbols | 12 | 4 | 7 (`precise_unavailable` 8, `compiler_fallback` 5 on answers) | 1 | 725.0 MB | 32,768 MB | 12.3 s |
| default budget, 40 requested (22 packages have a candidate) | 22 | 7 | 12 | 3 | 822.4 MB | 32,768 MB | 13.6 s |
| `--budget-mb 600`, 12 symbols | 12 | 4 | 7 | 1 | 584.3 MB | 600 MB | 12.2 s |
| `--budget-mb 600`, 22 symbols | 22 | 7 | 12 | 3 | 585.0 MB | 600 MB | 13.7 s |
| `--budget-mb 512` (the floor), 22 symbols | 22 | 1 | 18 (`memory_budget` on 7, `precise_unavailable` on 14, `compiler_fallback` on 2) | 3 | 469.3 MB | 512 MB | 13.5 s |

The growth allowance recorded in each output (the largest rise between two consecutive samples of one worker) was 168 to 180 MB. No run had a crash, an unexplained answer or a worker above its limit.

The 512 MB run, symbol by symbol, for the answers that matter: `packages/rpc-client serializeJsonLine` resolved precisely (141 MB worker); `src/resources/shared pathStartsWith` was the first read whose program did not fit, the worker was stopped by the sampler (721 ms), and the answers for `packages/daemon`, `packages/gsd-agent-modes`, `packages/pi-agent-core`, `packages/native`, `packages/mcp-server` and `vscode-extension` came back as grammar facts with `memory_budget` and no second start (the latch). Worker count after the stop was 0.

Why the 600 MB run shows no `memory_budget`: the program rule (70 percent of the limit, 420 MB) dropped older programs as RSS crossed it, so the worker peaked at 584 MB without a stop. That is the rule working, and it is the reason the floor budget (512) is the one that shows the degrade on gsd-pi.

Two facts about gsd-pi that the plan did not expect. The 1.45 GB program (`tsconfig.extensions.json`) is never built, because the ProjectModel only owns files through a config it discovers and no file maps to that one; `src/resources/extensions/*` files answer `precise_unavailable`. And a memory stop latches the whole project context, so after the first stop the small packages degrade too (honest, flagged, one failed start). Resolved cross-package edges on gsd-pi are not a criterion (D-22).

## Verification

`npm run typecheck`, `npm run lint`, `npm run build` clean. The built worker (`dist/precise-resolver/typescript/worker.js`) was started directly with a limit and reports `sampler: true`, so the compiled `.js` sampler layout works. `npm test`: 4,049 tests, 4,047 pass, 0 fail, 2 skipped (both pre-existing). `node scripts/eval/verify-prereg.ts`: ok (no Stage A file touched; the 16 files under `scripts/eval` and `docs/eval/preregistration.md` have no diff). The spin-and-allocate, program-LRU and no-break tests were run repeatedly (3 to 5 times each) with no flake. New cases: `budget.test.ts` 17, `memory.test.ts` 26, `compose.test.ts` 1, `precise-gate.test.ts` 5 (49 in all); one existing assertion in `resolver.test.ts` changed (see Deviations).

## Deviations from Plan

**1. [Rule 1 - Bug] An existing test contradicted the mandated latch**
- **Found during:** Task 1
- **Issue:** `resolver.test.ts` asserted that after a heap abort the next read starts a fresh worker (two workers). The plan's truth says the opposite: after a memory stop the tier answers `memory_budget` until the context changes.
- **Fix:** the test now asserts the second read is `memory_budget` with the worker count still 1; the restart conditions are covered in `memory.test.ts`.
- **Files modified:** src/precise-resolver/typescript/resolver.test.ts. **Commit:** 133552a

**2. [Rule 3 - Blocking] Files outside `files_modified`**
- `protocol.ts` (the plan's own text names the new optional `init` fields; `ready.sampler` and `done.programs`/`rssMb` were added with them), `typescript/index.ts` and `precise-resolver/index.ts` (exports), and `host/index.ts` (one export, `createTierMemory`, because the layering lint forbids importing `host/tiers.ts` from `bin/compose.ts` by path). **Commits:** 133552a, 2108f59

**3. [Rule 2 - Design] The latch key**
- The plan says "until the project context changes". The context id alone is `typescript:6.0.3:bundled` and does not move when a tsconfig is edited, so the key is the context id, its config hashes and the compiler directory. A tsconfig is not an indexed file, so an edit moves the key only when a source edit moves the snapshot (the project provider re-reads configs per snapshot, an existing behaviour). The test edits a source file and runs `maintain reconcile` for that reason.

**4. [Plan-list difference] `maintain resolve` is not wired to the latch**
- The plan's truth lists "an explicit `maintain resolve` asks again". The API exists (`PreciseTier.clearMemoryStop()`, `TypeScriptResolver.clearMemoryStop()`, `WorkerPool.clearMemoryStop(tenant?)`) and is tested, but the tenant's `maintain` handler is in `src/tenant/create.ts`, outside this plan's files and owned by 03-29 (eager resolution). 03-29 should call `tier.clearMemoryStop()` from `maintain resolve`.

**5. [Detail] The sampler starts before the compiler loads, and one worker per machine by default**
- See key decisions. Both are conservative readings of the plan text.

**6. [Flag] The 70 percent share is not in 03-CONSTANTS.md**
- It is in the plan text (and research Pitfall 4's transient-double reasoning), so it is exported as `PROGRAM_EVICT_FRACTION = 0.7` rather than invented. `precise.idleExitMs`, `precise.rssSampleMs` and `precise.minBudgetMb` are added to `PRECISE_DEFAULTS` from the approved table; `minHeapMb` (256, a 03-23 detail) is gone because the floor now decides.

**7. [Process] Test-first order**
- Three RED commits, each run against the previous commit and failing before the GREEN commit (Task 1: 6 of 11 cases; Task 2: the module `pool.ts` and the ledger did not exist; Task 3: `runNoBreak` was not exported). In Task 1 the first `createMemoryBudget` only records values and the ledger was added in Task 2, as the plan says.

## Open items

- **Windows (T-03-274, research A3):** `process.kill(process.pid, 'SIGKILL')` from a worker thread is believed to end a Windows process but is unverified here (macOS only). The V8 heap flag remains the backstop. The three-OS CI run of `memory.test.ts` (the spin-and-allocate case accepts any non-zero exit with the marker on Windows) is the verification; record its result when CI reports it.
- **`maintain resolve` wiring** to `clearMemoryStop` (deviation 4), for plan 03-29.
- **Per-config latch** on monorepos (decision 4) if a later plan wants more precision after a stop.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-03-271 (heap flag, sampler, pool, program eviction, floor) and T-03-272 (latch, a test counts starts) are mitigated and tested; T-03-273 (a spoofed marker line only degrades an answer, the pattern is anchored to a whole stderr line) and T-03-274 (above) are as planned. The sampler is a thread of the existing worker process and adds no process, port, file or permission.

## Self-Check: PASSED

- Files present: all eight created files and the twelve modified files listed in the frontmatter exist in the worktree.
- Commits 4a6bd18, 133552a, 876c226, 2108f59, a945c70 and bc91812 are ancestors of HEAD.
