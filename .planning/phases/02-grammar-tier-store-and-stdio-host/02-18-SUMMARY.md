---
phase: 02-grammar-tier-store-and-stdio-host
plan: 18
subsystem: database
tags: [sqlite, fts5, wal, incremental-vacuum, vacuum, gc, size-gate, node-sqlite, better-sqlite3]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "Fact Store core (02-06), names_fts and cache tables (02-11), lease, quarantine and the open path (02-12), SQLite kit pragmas incremental_vacuum, wal_checkpoint, optimize (02-03)"
provides:
  - "store.collect: retired file versions and unused names removed in guarded, chunked, resumable transactions"
  - "store.compact: incremental vacuum in slices sized from a measured first slice, optimize, WAL truncated; full VACUUM on request"
  - "store.check: quick_check with the open path's quarantine and rebuild on damage"
  - "store.maintain: collect, compact, check under one budget; takes the writer slot and throws WriterBusy"
  - "scripts/size-gate.ts: runSizeGate and a command line proving the 20,000-edit size bound"
affects: [02-20 Host maintenance task mapping, 02-26 CI gate job and npm script, 02-28 idle maintenance loop]

actuals:
  tokens: 22800
  tasks: 3
  commits: 8
plan_head_before: e690ad5a07447be179e70e1c77a844ee89e66a5d
plan_head_after: 09b84355d38cfee6aa37fa4be96dc04fcfa05406
commits: 8

tech-stack:
  added: []
  patterns:
    - "Upkeep tasks return {complete, spentMs, processed}, always do one unit of work, and keep a resume cursor in a WeakMap keyed by the store parts"
    - "Every delete of file rows repeats the retired-and-unreferenced guard inside one transaction (T-02-60)"
    - "Module-level test hooks (lifecycleTestHooks) in the way of recoveryCounters, never set outside tests"

key-files:
  created:
    - src/fact-store/lifecycle.ts
    - src/fact-store/maintain.ts
    - src/fact-store/lifecycle.test.ts
    - src/fact-store/maintain.test.ts
    - scripts/size-gate.ts
    - scripts/size-gate.test.ts
  modified:
    - src/fact-store/store.ts
    - src/fact-store/open.ts
    - src/fact-store/parts.ts
    - src/fact-store/types.ts

key-decisions:
  - "Collect deletes a retired file only through guards repeated in every statement of one transaction (state = 'retired' and no overlay row), so a version revived or mapped between selection and delete survives"
  - "collect keeps a resume position per store so retired versions that must wait (git lacks them, grace running) at the front of the order cannot starve the ones behind them; a call that reaches the end forgets it"
  - "Deleting from the contentless FTS5 table leaves the connection's last-insert rowid above 2^53 and the kit then throws on the next run(); the names pass inserts and deletes one ordinary row afterwards to reset it"
  - "A full compaction vacuums when a quarter of the file is free pages or over a third of it is empty space inside pages (dbstat), because scattered deletes leave pages half empty that incremental vacuum never returns"
  - "store.maintain takes the in-process writer slot and throws WriterBusy while the Indexer's writer is out; collect, compact and check need write authority only"

patterns-established:
  - "FTS5 contentless deletes through exec with integer id lists, never a prepared run(), because the change count they report is meaningless"
  - "Gate scripts report an informational idle-loop-only size beside the asserted settled size"

requirements-completed: [STO-05, STO-10]

coverage:
  - id: D1
    description: "collect removes retired versions once git has them or the grace has passed, in chunks and a time box, resumable and idempotent, never touching a revived or referenced version"
    requirement: STO-05
    verification:
      - kind: integration
        ref: "src/fact-store/lifecycle.test.ts#tracer, grace, referenced, revival, chunk (both drivers)"
        status: pass
    human_judgment: false
  - id: D2
    description: "collect deletes names no fact uses and their trigram rows, with and without FTS5 contentless_delete"
    requirement: STO-05
    verification:
      - kind: integration
        ref: "src/fact-store/lifecycle.test.ts#names (trigram on, no contentless delete, trigram off)"
        status: pass
    human_judgment: false
  - id: D3
    description: "compact returns free pages in measured slices, truncates the WAL, vacuums fully only on request, and is resumable and idempotent"
    requirement: STO-10
    verification:
      - kind: integration
        ref: "src/fact-store/maintain.test.ts#slice, full vacuum (both drivers)"
        status: pass
    human_judgment: false
  - id: D4
    description: "check runs quick_check and on damage quarantines and rebuilds through the open path; maintain runs collect, compact, check under one budget and throws WriterBusy"
    requirement: STO-10
    verification:
      - kind: integration
        ref: "src/fact-store/maintain.test.ts#check corrupt, budget, WriterBusy (both drivers)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A stale file refreshes through commitFile and the flag clears (behaviour already in the Writer; now covered by a test)"
    requirement: STO-10
    verification:
      - kind: integration
        ref: "src/fact-store/maintain.test.ts#refresh"
        status: pass
    human_judgment: false
  - id: D6
    description: "The 20,000-edit size gate: edited store at most 1.25 times a fresh build, with a negative control that fails"
    requirement: STO-05
    verification:
      - kind: integration
        ref: "scripts/size-gate.test.ts#scaled, negative control; node scripts/size-gate.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "Whether the idle loop alone should ever run a full compaction, given that it leaves the file 1.39 times a fresh build until one runs"
    verification: []
    human_judgment: true
    rationale: "A scheduling policy for plan 02-28 (how often to ask for a full compaction); the numbers are measured, the cadence is a product choice"

duration: 24min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 18: Store upkeep and the size gate Summary

**Fact Store collect, compact, check and maintain with guarded retired-version collection, measured incremental-vacuum slices and corruption rebuild, plus a 20,000-edit size gate that measures 655,360 bytes edited against 655,360 fresh (ratio 1.0000) in 8.2 seconds.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-10-16T22:57:00Z (approximate; the start was not stamped)
- **Completed:** 2026-10-16T23:21:00Z
- **Tasks:** 3 (eight commits: four test, four feat)
- **Files modified:** 10

## Accomplishments

- `collect` frees retired versions in 50-file transactions guarded by the retired state, resumes behind versions that must wait, and removes the names (and trigram rows) nothing uses. A revival hook test proves a version recommitted between selection and delete survives.
- `compact` sizes each incremental-vacuum slice from the first slice's measured time (aim: half the approved 200 ms), runs `optimize`, then truncates the WAL; `full` adds a VACUUM when a quarter of the file is free pages or over a third of it is empty inside pages.
- `check` finds overwritten pages with `quick_check` and rebuilds through the same quarantine and `noteRebuild` path as open (`lifecycle.rebuild` closure in `open.ts`); reads say `rebuilding` until a full overlay is written.
- `maintain` splits one budget (collect half, compact a third plus unused time, then check), takes the writer slot and throws `WriterBusy` for a follower or while an in-process writer is out.
- `scripts/size-gate.ts` default run: **files 300, edits 20000, maintain every 200: freshBytes 655360, editedBytes 655360, ratio 1.0000, OK, 8.2 s** (101 maintain runs). The idle loop alone leaves 913,408 bytes (**idleRatio 1.3938**) until the final full compaction vacuums the fragmented file.

## Task Commits

1. **Task 1: Tracer - collect retired versions and unused names** - `500aafe` (test), `c1a9e17` (feat)
2. **Task 2: compact, check, maintain, refresh** - `8117e15` (test), `9693395` (feat)
3. **Task 3: 20,000-edit size gate** - `73454fa` (test), `7cb54b6` (test, fragmentation case), `870163a` (feat, fragmentation-aware full vacuum), `09b8435` (feat, gate)

**Plan metadata:** recorded in the docs commit that follows this file.

## Files Created/Modified

- `src/fact-store/lifecycle.ts` - `collectRetired`, `compactStore`, `checkStore`, test hooks, the FTS rowid reset
- `src/fact-store/maintain.ts` - `maintainStore` and `MaintainTasks`
- `src/fact-store/store.ts` - delegation, write-authority check, dirty-sentinel wrapper, `maintain` slot handling, `StoreLifecycle.rebuild`
- `src/fact-store/open.ts` - approved defaults (`DEFAULT_GC_GRACE_MS` 86400000, `DEFAULT_COLLECT_CHUNK_SIZE` 50, `DEFAULT_SLICE_MS` 200), settings validation, the `rebuild` closure, TEST ONLY `contentlessDelete`
- `src/fact-store/parts.ts` - `LifecycleSettings` on `StoreParts`
- `src/fact-store/types.ts` - `MaintenanceOptions.full`, `StoreOptions.graceMs/chunkSize/sliceMs`
- `src/fact-store/lifecycle.test.ts`, `src/fact-store/maintain.test.ts`, `scripts/size-gate.test.ts` - 26, 33 and 6 cases (both drivers where the store is opened)
- `scripts/size-gate.ts` - `runSizeGate`, `runCli`, deterministic generator `factsFor`

## Decisions Made

See `key-decisions`. In short: guards repeated in every delete; a resume position per store; an FTS-rowid reset after trigram deletes; a fragmentation-aware full vacuum; `maintain` owns the writer slot.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] FTS5 contentless deletes poisoned the next `run()`**
- **Found during:** Task 1 (chunk case, second call)
- **Issue:** after `DELETE FROM names_fts` the connection's last-insert rowid is an internal FTS5 segment id (9009535716950016, above 2^53). The kit's `run()` converts `lastInsertRowid` strictly and threw `IntegerOutOfRangeError` on the next `DELETE`/`UPDATE`, which would also have broken the Writer's first statement of a later `link` or revival.
- **Fix:** trigram rows go through `exec` with integer id lists (never a prepared `run()`), and an ordinary insert-then-delete on `names` resets the rowid after the pass. The names test now also runs `link` and `commitFile` straight after.
- **Files modified:** `src/fact-store/lifecycle.ts`, `src/fact-store/lifecycle.test.ts`
- **Verification:** both drivers, three trigram variants
- **Committed in:** `c1a9e17`

**2. [Rule 1 - Bug] The planned full-VACUUM rule left the size gate at 1.34**
- **Found during:** Task 3 (scaled run: edited 876,544 bytes against fresh 655,360, ratio 1.337, with no free page and every row count equal)
- **Issue:** scattered deletes leave pages about 45 percent empty inside; incremental vacuum returns only empty pages and the plan's rule (VACUUM only when over a quarter of the file is free pages) never fires. The plan says to fix the lifecycle code rather than the gate.
- **Fix:** a full request also vacuums when over a third of the file is unused space inside pages (`dbstat`; a build without it keeps the free-page rule). A fresh build is about 26 percent empty inside, so it is left alone. Still only on request.
- **Files modified:** `src/fact-store/lifecycle.ts`, `src/fact-store/maintain.test.ts`
- **Verification:** new test (45 percent empty inside, freelist 0, one VACUUM, 262 to about 150 pages, idempotent) and a mutation check that disabling the new branch fails it
- **Committed in:** `7cb54b6` (test), `870163a` (feat)

**3. [Rule 3 - Blocking] Test hooks as module state, plus one TEST ONLY open option**
- **Found during:** Task 1
- **Issue:** the plan wanted `onSelected` as an option on the lifecycle parts, but the store builds its parts internally; tests open real stores.
- **Fix:** `lifecycleTestHooks` (`onSelected`, `onSlice`, `onVacuum`, `onTask`) exported from `lifecycle.ts`, in the way of `recoveryCounters`; `OpenFactStoreOptions.contentlessDelete` (TEST ONLY, can only switch the capability off) so the no-`contentless_delete` path is tested.
- **Files modified:** `src/fact-store/lifecycle.ts`, `src/fact-store/open.ts`
- **Committed in:** `500aafe`, `c1a9e17`

**4. [Rule 1 - Bug] `optimize` before the checkpoint, not after**
- **Found during:** Task 2 (WAL file 24,752 bytes after a TRUNCATE checkpoint)
- **Issue:** `PRAGMA optimize` writes planner statistics, so running it after the checkpoint refilled the log. It also takes a few free pages for the statistics table.
- **Fix:** `optimize` first, then the checkpoint (TRUNCATE on a finished run, PASSIVE on an unfinished one so a reader cannot stall the slice). Tests allow the few pages `optimize` takes.
- **Files modified:** `src/fact-store/lifecycle.ts`, `src/fact-store/maintain.test.ts`
- **Committed in:** `9693395`

### Plan items that needed no change

- **`writer.ts` refresh semantics:** `commitFile` already rewrites the facts of a stale hash and clears the flag (`rewriteFile` sets `stale = 0`, bumps the watermark, and a repeat is `unchanged`) from plan 02-06. No code change; the `refresh` case in `maintain.test.ts` pins it and passed on its first run (a characterisation, not a RED).

---

**Total deviations:** 4 auto-fixed (3 Rule 1, 1 Rule 3) and 1 item already delivered.
**Impact on plan:** deviation 2 changes a plan truth in the safe direction (more reclaimable cases, still only on request) and is what lets the gate pass honestly; the rest are correctness fixes.

## TDD Gate Compliance

Four RED/GREEN cycles, each with `RED_EVIDENCE_OK` from `gsd_run check tdd-red-evidence` (records `.planning/red-evidence-02-18-t1.json` to `t4.json`, untracked by instruction):

- **RED t1** (`500aafe`): 10 of 12 node:sqlite collect cases failed on the planned assertions (processed counts, WriterBusy rejection, the revival hook never running); target: the tracer case. The better-sqlite3 suite was excluded by name pattern so test names are unique in the report.
- **RED t2** (`8117e15`): 15 of 17 failed (compact processed 0 against 168 free pages, `check` returning ok on overwritten pages, maintain order and slot, the budget split which threw not implemented); 2 passed as characterisation (healthy check, stale refresh).
- **RED t3** (`73454fa`): all 6 gate cases failed on the not-implemented stubs, the precedent of plan 02-17. A blank line inside a TAP error block made the first record read as `invalid_record`; the CLI case was rewritten to give single-line messages and the record regenerated.
- **RED t4** (`7cb54b6`): the fragmentation case failed at its planned assertion (one VACUUM expected, none ran). Its setup was then changed from a three-way retire pattern (which left only 25 percent empty) to a seeded random edit run (45 percent); a mutation check confirmed the final test fails without the new branch.

`git log` shows `test(02-18)` before `feat(02-18)` for every cycle; no REFACTOR commits.

## Issues Encountered

- The first overwritten-page fixture hit the schema pages (open failed); the second hit pages `status()` reads. The final fixture overwrites the root page of the `refs` table, read by neither the open nor `status()`.
- Both `node:sqlite` and `better-sqlite3` ship the `dbstat` table here; a build without it falls back to the free-page rule.

## Open items for other plans

1. **Reconcile still does not re-extract a stale file (02-17 note).** `Writer.commitFile` now has a tested refresh path, but `processBatch` in `src/indexer/process.ts` tries `Writer.link` first and `link` attaches the known hash of a stale file. The plan that maps the `refresh` maintenance task onto the Indexer (02-20, with the Host) must make the Indexer extract and commit a path the store reports stale, or `link` must refuse stale hashes. Not implemented here: the Indexer is outside this plan's files.
2. **`maintain` and the Indexer's writer.** `store.maintain` throws `WriterBusy` while any in-process writer is out, as specified. The Host (02-20, 02-28) either releases the Indexer's writer around `maintain` or calls `collect`, `compact` and `check` directly, which need write authority only.
3. **Idle loop and fragmentation.** The idle loop never vacuums a fragmented file (full only on request). Measured at 20,000 edits: 913,408 bytes after the loop (1.39 times fresh), 655,360 after a full compaction. 02-28 should schedule a `full` compaction occasionally (for example when `status().sizeBytes` is well over the last settled size) and 02-20 should expose `full` on the CLI `maintain` path.
4. **`npm run size-gate`** is added to package.json by plan 02-26, which also owns the CI gate job and the 10,000-file nightly variant.
5. **Kit hazard** (`src/sqlite/wrap.ts`, plan 02-03): `run()` reads `lastInsertRowid` even for statements that insert nothing, so any code that deletes from the FTS5 table must reset it as `lifecycle.ts` does. A kit-level fix (read it only for inserts) would remove the hazard.

## Internal bounds not in 02-CONSTANTS.md

None is a timeout, queue bound or gate threshold, so none needed approval, but each is recorded: first slice 64 pages, at most 16,384 pages and 4 times growth per slice, slice target half of `maintenance.sliceMs`; 500 ids per FTS or names delete statement; fragmented-file fraction 1/3; in the gate script, a 600,000 ms maintain budget and a settle limit of 100 rounds.

## Measured

- Gate default run: 8.2 s on macOS arm64, node:sqlite. Linux and Windows are unverified until three-OS CI (the temp-directory removal retries for Windows but has not run there).
- The slice test asserts each real slice under five times the approved 200 ms (a generous tolerance for a noisy machine); it does not assert 200 ms itself.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Store methods `collect`, `compact`, `check`, `maintain` are real; plan 02-20 can map the Host task names onto them and 02-28 can run them in idle time.
- Blockers: none. See the open items above.

## Known Stubs

None.

## Threat Flags

None. The rebuild closure reuses the existing quarantine path; the size gate touches only its own temp directory.

## Self-Check: PASSED

- Created files exist: `src/fact-store/lifecycle.ts`, `src/fact-store/maintain.ts`, `src/fact-store/lifecycle.test.ts`, `src/fact-store/maintain.test.ts`, `scripts/size-gate.ts`, `scripts/size-gate.test.ts`.
- Commits `500aafe c1a9e17 8117e15 9693395 73454fa 7cb54b6 870163a 09b8435` are ancestors of HEAD.
- `npm test` 1851 pass, 0 fail; `npm run typecheck` and `npm run lint` clean; `node scripts/size-gate.ts` prints OK.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
