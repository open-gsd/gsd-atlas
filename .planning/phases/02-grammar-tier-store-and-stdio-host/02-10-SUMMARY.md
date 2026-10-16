---
phase: 02-grammar-tier-store-and-stdio-host
plan: 10
subsystem: metrics
tags: [metrics, sqlite, migrations, histograms, rollup, privacy, bounded-queue, node-sqlite, better-sqlite3]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-02 Clock.after with idempotent cancel and FakeClock; DEGRADED_CODES from src/facts"
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-03/02-04 approved constants (02-CONSTANTS.md) and the src/sqlite kit with metrics as an allowed owner"
provides:
  - "openMetrics(path, {clock}, options): a never-throwing Metrics over its own metrics.db with forward-only migrations"
  - "validateEvent: the closed, allow-listed event vocabulary (answer, freshness, index_health) checked at runtime"
  - "Bounded non-blocking recorder, hourly counters, 7-day rollup into daily rows, 30-day expiry, latest-wins index-health gauges"
  - "report(range): Answers, Freshness, Index health and Tokens served panel data, tokens labelled estimate"
  - "createNoopMetrics(reason?): same interface, records nothing"
affects: [02-22 status panels, 02-28 Host recording and idle rollup, 08 dashboard]

actuals:
  tokens: 16600
  tasks: 3
  commits: 6
plan_head_before: 08023892b304df386769d42ce905bdece739ece8
plan_head_after: bb4652d09a14acdabecdbaf909c82a82a1ff2990

tech-stack:
  added: []
  patterns:
    - "One promise chain serialises every database operation (flush, report, reset, rollup, close); op bodies never throw, failures are counted"
    - "Failed batches are requeued ahead of newer events, bounded by queueMax, and the single flush timer re-arms so recovery resumes writing"
    - "A validator written without a schema library returns fixed reason codes and a rebuilt copy, never the caller's object or text"
    - "Failure injection through a wrapping DriverModule passed as the driver option"

key-files:
  created:
    - src/metrics/index.ts
    - src/metrics/types.ts
    - src/metrics/validate.ts
    - src/metrics/migrations.ts
    - src/metrics/store.ts
    - src/metrics/rollup.ts
    - src/metrics/report.ts
    - src/metrics/noop.ts
    - src/metrics/metrics.test.ts
  modified: []

key-decisions:
  - "A batch that fails to write is requeued in front of newer events (oldest dropped past queueMax and counted) rather than discarded, and the flush timer re-arms, so a read-only or locked period loses nothing within the bound."
  - "Percentiles in the overflow bucket report the largest finite edge and set overflow: true (a lower bound); Infinity was rejected because JSON turns it into null, which would read as 'no samples'."
  - "report() flushes first, so status shows events recorded a moment ago; a read failure returns the all-zero report and counts in writeFailures instead of failing status."
  - "Rejected and dropped totals are persisted as dropped_events and rejected_events counters with the next flush; a rejected event alone does not arm the timer, so a stream of bad events cannot cause writes."
  - "Callers cannot set time: an 'at' key is an unknown key and rejects the event; the recorder stamps accepted events from the injected Clock and buckets by that stamp, so a late flush still lands in the right hour."
  - "Open failures, newer schemas and unusable options all return the noop instance with a fixed reason (open_failed, newer_schema, invalid_migrations, invalid_options); no path from openMetrics throws."

patterns-established:
  - "Closed vocabulary lists (TOOL_NAMES, COUNTER_METRICS, GAUGE_METRICS, META_KEYS, bucket labels) double as the privacy test's allow-set"
  - "Counting-clock wrapper in tests to prove no Clock.after timer is left pending"

requirements-completed: [MET-01, MET-02]

coverage:
  - id: D1
    description: "metrics.db is a separate database opened through the SQLite kit with numbered forward-only migrations keyed by PRAGMA user_version, each in its own transaction; a newer database disables recording with reason newer_schema"
    requirement: MET-01
    verification:
      - kind: unit
        ref: "src/metrics/metrics.test.ts#metrics database and migrations (node:sqlite / better-sqlite3): creates metrics.db...; upgrades a version 1 database...; opens a database newer than the code..."
        status: pass
    human_judgment: false
  - id: D2
    description: "Events are an allow-listed union validated at runtime (closed tool, degraded and kind sets, finite non-negative numbers, booleans); unknown keys, unknown enums and non-numbers are rejected and counted"
    requirement: MET-01
    verification:
      - kind: unit
        ref: "src/metrics/metrics.test.ts#validateEvent; rejected events increment status().rejected..."
        status: pass
    human_judgment: false
  - id: D3
    description: "Privacy: every string in every table is a member of the closed vocabulary or an hour or day string, and events carrying a path, symbol or repo key change nothing in the dump or the file bytes"
    requirement: MET-01
    verification:
      - kind: unit
        ref: "src/metrics/metrics.test.ts#privacy: every string stored is a member of the closed vocabulary..."
        status: pass
    human_judgment: false
  - id: D4
    description: "record never blocks or throws: bounded oldest-first queue with drop counting, one flush timer, serialised flushes, write failures swallowed and counted, recording stays true and writing resumes"
    requirement: MET-02
    verification:
      - kind: unit
        ref: "src/metrics/metrics.test.ts#dropped events...; write failure: record never throws...; write failure: the flush timer keeps retrying...; leaves no pending timer...; events recorded while a flush is running..."
        status: pass
    human_judgment: false
  - id: D5
    description: "Latency and freshness histograms with bucket-edge semantics, percentiles as bucket upper bounds, degraded and truncation counters, latest-wins index-health gauges, all-zero report on an empty database"
    requirement: MET-02
    verification:
      - kind: unit
        ref: "src/metrics/metrics.test.ts#bucket edge...; percentiles are the upper edges...; freshness events fill the lag histogram...; degraded values and truncation...; a report over an empty database..."
        status: pass
    human_judgment: false
  - id: D6
    description: "rollup merges hourly rows older than 7 days into daily rows, deletes days older than 30, is idempotent and never splits an event across buckets; reset empties counters and gauges and keeps the schema; token figures carry label 'estimate'"
    requirement: MET-01
    verification:
      - kind: unit
        ref: "src/metrics/metrics.test.ts#rollup merges...; rollup deletes day rows older than 30 days; rollup is idempotent...; an event recorded while a rollup runs...; reset deletes every counter and gauge..."
        status: pass
    human_judgment: false
  - id: D7
    description: "The gsd-atlas status panel layout built on this report data"
    requirement: MET-02
    verification: []
    human_judgment: true
    rationale: "Panel layout is decided in plan 02-22; this plan guarantees only the report data and its estimate labels."

duration: 9min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 10: Metrics Module Summary

**Metrics module with its own migrated metrics.db, a closed-vocabulary event validator, a bounded non-blocking recorder, hourly counters rolled into daily rows with 30-day expiry, and the estimate-labelled report that feeds the status panels, tested on node:sqlite and better-sqlite3.**

## Performance

- **Duration:** about 9 min
- **Started:** 2026-10-16T19:47:03Z
- **Completed:** 2026-10-16T19:56:19Z
- **Tasks:** 3 (TDD: 6 commits)
- **Files modified:** 9 (all created)

## Accomplishments

- `openMetrics` opens `metrics.db` through the `src/sqlite` kit with the approved 5000 ms busy timeout, applies numbered migrations (each in its own transaction, `PRAGMA user_version` set before commit) and never throws: a newer database, a path that is a directory or bad options yield a noop instance whose `status().reason` names the cause.
- `validateEvent` accepts exactly three shapes (`answer`, `freshness`, `index_health`) with exact key sets, closed tool and degraded enums, finite non-negative numbers and booleans, written with relative imports only. A rejection carries a fixed reason code, never the input, and the accepted event is a rebuilt copy.
- The recorder is bounded (`queueMax` 1000, oldest evicted and counted), arms one `Clock.after` flush timer (`flushIntervalMs` 5000), serialises every database operation on one promise chain, and requeues a failed batch so a read-only or locked period costs nothing within the bound. Dropped and rejected totals persist as counters.
- Histograms use less-than-or-equal bucket edges (latency 1 to 5000 ms plus overflow, lag 10 to 5000 ms plus overflow); `rollup()` merges hourly rows older than 7 days into daily rows and deletes days older than 30 in one transaction, idempotently; `reset()` clears counters, gauges and the queue.
- `report(range)` returns Answers, Freshness, Index health and Tokens served data, with percentiles as bucket upper bounds and tokens labelled `estimate`. The privacy test dumps every string in every table and the raw file bytes and finds only vocabulary members.
- Full suite: 1375 tests pass; `npm run typecheck`, `npm run lint` and `npm run build` exit 0.

## Task Commits

1. **Task 1: Tracer - open metrics.db, record one answer, read it back** - `51ee0d1` (test, RED), `426f1ba` (feat, GREEN)
2. **Task 2: Allow-listed events, bounded recorder, swallowed write failures, noop** - `9994fe8` (test, RED), `a426245` (feat, GREEN)
3. **Task 3: Histograms, rollups with retention, full report, privacy scan** - `89290a3` (test, RED), `bb4652d` (feat, GREEN)

**Plan metadata:** the `docs(02-10)` commits that follow this SUMMARY (summary, then state and roadmap).

## TDD Gate Compliance

Each task has a `test(02-10)` commit before its `feat(02-10)` commit. RED evidence was validated with `gsd_run check tdd-red-evidence` (`RED_EVIDENCE_OK`, format tap) for all three, with the target named by its qualified `suite > test` name because test titles repeat across the two driver suites. Records are in `.planning/red-evidence-02-10-t{1,2,3}.json` (untracked by instruction).

- **T1 RED:** target "reports a recorded answer after a flush" failed `answers.total 0 !== 1` against an inert placeholder recorder; all 8 cases failed on assertions, none on import. Semantic assessment: intended failure.
- **T2 RED:** target "dropped events" failed `queued 5 !== 3` (unbounded tracer queue); validation, noop, timer and requeue cases failed on their planned assertions. Semantic assessment: intended failure.
- **T3 RED:** target "rollup merges hourly rows" failed on the missing day row (rollup was a placeholder); bucket edge, freshness, degraded, retention and reset cases failed on their own assertions. Some cases (percentiles, empty report, idempotency, privacy) already passed in RED because the tracer and the placeholder satisfied them; they stayed as regression guards.
- No REFACTOR commit was needed. The tracer `<verify>` (tests, typecheck, lint) was re-run before expansion and passed (tracer verified end-to-end).

## Files Created/Modified

- `src/metrics/types.ts` - closed vocabularies, approved defaults, event union, bucket and UTC hour/day helpers, public types
- `src/metrics/validate.ts` - allow-list validation with fixed reason codes
- `src/metrics/migrations.ts` - ordered `MIGRATIONS` (version 1: counters, gauges, meta) and the forward-only runner
- `src/metrics/store.ts` - `openMetrics`, the recorder, batch writer, timer and serialised operation chain
- `src/metrics/rollup.ts` - hourly-to-daily merge and retention in one transaction
- `src/metrics/report.ts` - `buildReport`, `emptyReport`, histogram and percentile assembly
- `src/metrics/noop.ts` - `createNoopMetrics(reason?)`
- `src/metrics/index.ts` - public surface (`openMetrics`, `createNoopMetrics`, vocabulary constants, types)
- `src/metrics/metrics.test.ts` - 69 cases; database cases run for both drivers

## Decisions Made

See `key-decisions` above. The two that 02-22 and 02-28 must know: percentiles in the overflow bucket set `overflow: true` and report the largest finite edge; `report()` flushes before reading and returns the all-zero report on a database error.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Write-failure test uses an injected failing driver, not a directory swapped over the file**
- **Found during:** Task 2 (write failure case)
- **Issue:** The plan's technique (replace the database file with a directory so writes fail) does not make writes fail on POSIX: the open connection keeps its inode and the WAL descriptor.
- **Fix:** The test wraps a real `DriverModule` so `transaction` throws a `DbError('readonly')` on demand and passes it as the `driver` option, then recovers; a separate case proves a path that is a directory at open time gives a disabled instance with reason `open_failed`. Both behaviours the plan names (swallowed failure with `recording` staying true, and recovery resuming writes) are asserted, on both drivers.
- **Files modified:** src/metrics/metrics.test.ts
- **Verification:** `node --test src/metrics/metrics.test.ts` (69 pass)
- **Committed in:** 9994fe8, a426245

**2. [Rule 2 - Missing Critical] Failed batches are requeued and the flush timer re-arms**
- **Found during:** Task 2
- **Issue:** The plan says a write failure is swallowed and counted but also that a later flush writes after recovery; discarding the failed batch would make recovery lose everything recorded during the outage.
- **Fix:** The batch returns to the front of the queue (bounded by queueMax, overflow dropped and counted) and the timer re-arms.
- **Files modified:** src/metrics/store.ts
- **Verification:** "write failure" cases assert 100 events written after recovery, by explicit flush and by timer.
- **Committed in:** a426245

**3. [Rule 2 - Missing Critical] Additive report fields**
- **Found during:** Task 1 and 3
- **Issue:** The plan's report shape had no way to expose the latency histogram the plan's own tracer behaviour requires, and a bucket-bound percentile is wrong for the overflow bucket.
- **Fix:** Added `answers.latency` and `freshness` as `HistogramReport` (`count`, `p50UpperBoundMs`, `p95UpperBoundMs`, `overflow`, `buckets`). All planned fields are present unchanged.
- **Files modified:** src/metrics/types.ts, src/metrics/report.ts
- **Committed in:** 426f1ba, bb4652d

---

**Total deviations:** 3 auto-fixed (1 blocking test technique, 2 missing critical)
**Impact on plan:** No scope change; all planned behaviours are covered and the report is a superset of the planned shape.

## Issues Encountered

- Two Bash calls were denied by the MEMTRACE-FIRST hook (a `git show` and a `sed -i`, both naming indexed source files). Neither was needed for the work and neither was retried or rephrased; the edits went through the Edit tool and reads through CodeGraph. One compound pin-check command was refused by the harness as a too-complex git form; the pin was checked with two plain `git rev-parse --show-toplevel` commands (actual root equals the pinned root) before every write batch and every commit.
- Open design items for later plans: nothing prunes `meta`/`gauges` beyond `reset()`; the Host (02-28) decides when to call `rollup()` and how often.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The report's `indexHealth` is null until an `index_health` event is recorded by the Host (plan 02-28); that is data absence, not a stub.

## Next Phase Readiness

- 02-28 can record `answer`, `freshness` and `index_health` events and call `rollup()` from its idle loop; 02-22 can print `report(range)` using `tokens.label` and `HistogramReport.overflow` honestly.
- The Host must pass the metrics path beside the fact store and a `Clock`; `openMetrics` creates the parent directory.

## Self-Check: PASSED

All nine files under `src/metrics/` exist; commits 51ee0d1, 426f1ba, 9994fe8, a426245, 89290a3 and bb4652d are on the branch history.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
