---
phase: 02-grammar-tier-store-and-stdio-host
plan: 12
subsystem: fact-store
tags: [sqlite, lease, begin-exclusive, follower, takeover, dirty-sentinel, quick-check, quarantine, store-location, sigkill, node-test]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-06 Fact Store core (openFactStore, StoreParts, Writer, canCache and degradedNow hooks, WriterBusy, StoreStatus.rebuiltAfterCorruption); 02-03 SQLite kit (quick_check and wal_checkpoint pragmas, DbError busy and sqliteCode); 02-02 Clock.after; 02-05 SourceTree identity (storeId, commonDir); 02-11 Reader refs with the canCache cache write that this plan wires to the lease"
provides:
  - "createLease and startTakeover: one writer per store directory from a BEGIN EXCLUSIVE lock on lease.db that the operating system drops when the holder dies; lease.json diagnostics by rename; busy opens retried with jitter; followers retry on a jittered timer"
  - "openFactStore options lease, takeover, dirtyIdleMs, onLeaseChange, schemaVersion (StoreOpenOptions): a follower never writes, writer() throws WriterBusy, every answer says follower, canCache follows the lease, close releases it"
  - "resolveStoreLocation, isSyncedFolderPath, defaultCacheRoot: git common dir by default, cache directory for non-git, unwritable, synced-folder, network-mount and symbolic-link store directories, user-level store.dir override, owner-only idempotent creation"
  - "Recovery: dirty sentinel on every mutating writer call, quick_check on open when the sentinel is found, quarantine to facts.db.corrupt-<time> (newest two kept) and rebuild, SchemaTooNew for a newer store and delete-and-recreate for an older one, rebuilding degraded state until a full overlay is written"
  - "Durability proofs against real damage: a writer child killed with SIGKILL at 1, 4, 9 commits and at a random time, overwritten database pages, text files and foreign SQLite files"
affects: [02-15 indexer (onLeaseChange starts it), 02-17 host and shim, 02-18 maintenance (check and compact replace the stubs), 02-20 tenant, 02-25 follower fresh paths, 02-28 host idle loop, phase 4 socket host]

actuals:
  tokens: 31700
  tasks: 3
  commits: 6
plan_head_before: 3634108b54b306532f738e53399fa60df3f3dbea
plan_head_after: 0e6f7218670bef5c37beb64ce6169dde5fe35138

tech-stack:
  added: []
  patterns:
    - "Authority split: openFactStore decides once whether this process may change the files (the leader, or any process with no lease). Only that process runs the sentinel check, moves files aside, rebuilds or touches an existing schema; a follower reads and reports trouble as an error"
    - "Connections live in a holder that StoreParts reads through getters, so a takeover that finds a damaged store replaces them in place without recreating the store object"
    - "Child-process tests go through the CommandRunner with allowAll; line-by-line stdout reading and test-only ceilings live in scripts/test-helpers, outside src, unlinted and unbuilt"

key-files:
  created:
    - src/fact-store/lease.ts
    - src/fact-store/location.ts
    - src/fact-store/recovery.ts
    - src/fact-store/lease.test.ts
    - src/fact-store/location.test.ts
    - src/fact-store/durability.test.ts
    - scripts/test-helpers/lease-child.ts
    - scripts/test-helpers/store-writer-child.ts
    - scripts/test-helpers/child-lines.ts
    - scripts/test-helpers/store-facts.ts
  modified:
    - src/fact-store/open.ts
    - src/fact-store/store.ts
    - src/fact-store/index.ts
    - src/fact-store/fact-store.test.ts

key-decisions:
  - "The lease database is opened through the kit with a zero busy timeout and the kit's WAL default (ADR 11 allows it): a held write lock excludes a second BEGIN EXCLUSIVE either way. A busy open is retried four times with a 20 to 80 ms jittered pause on real timers, then the process is a follower; busy at CREATE or BEGIN is definitive, which still guarantees at least one leader because every transient lock holder finishes its creation before its own BEGIN"
  - "A follower never writes: with tables present it skips createSchema and the seed transaction, reads the fuzzy-name path the leader recorded in meta.fuzzy_path, and does not run the sentinel check or move any file; the sentinel belongs to the process that set it (DirtyGuard flushes only what it created)"
  - "Recovery runs for any process with write authority, with or without a lease. A takeover checks the sentinel a killed leader left; a failing check closes the connections, quarantines, recreates in place and clears the snapshot-id cache; writer() answers WriterBusy while that runs"
  - "The rebuild is recorded in the new store's meta (rebuild_pending, rebuilt_moved_to, rebuilt_at): degradedNow reads rebuild_pending from the database so a follower sees rebuilding end when the leader's first setOverlay completes, and status().rebuiltAfterCorruption survives a reopen"
  - "A valid SQLite file that has no fact-store meta is treated like a damaged one and moved aside, not deleted and not an error (the old open threw a plain Error telling the user to remove it)"
  - "The store.dir override comes only from the parameter or GSD_ATLAS_STORE_DIR in the caller's environment, must be absolute, and gets the storeId appended; nothing in location.ts opens a file inside the repository or the git directory"
  - "lease.ts takes an injected openDb instead of a driver option: the store test that confines driver vocabulary to open.ts stays true, and the busy-retry cases inject a flaky opener"

patterns-established:
  - "RED commits carry a typed placeholder module so the suite loads and the target test fails on an assertion; small fixture helpers (markDirty and friends) are real in the RED commit because the tests use them to stage state"
  - "Tests that stage damage under open connections fold the WAL into the main file first (wal_checkpoint TRUNCATE) so the overwritten range holds the data the check will read"

requirements-completed: [STO-06, STO-07, STO-08]

coverage:
  - id: D1
    description: "One writer per store directory across processes: exactly one process holds lease.db, a second is a follower, the lock survives nothing the holder does not (SIGKILL releases it), and ten concurrent two-process starts always give exactly one leader"
    requirement: STO-08
    verification:
      - kind: unit
        ref: "src/fact-store/lease.test.ts#writer lease"
        status: pass
      - kind: integration
        ref: "src/fact-store/lease.test.ts#lease across processes (SIGKILL takeover and ten concurrent starts through the CommandRunner)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A follower reads the leader's facts with degraded follower, cannot take a writer (WriterBusy), refuses derived-cache writes (refs report cache_unavailable), and after the leader closes takes over on a jittered timer, fires onLeaseChange(true) once and loses the follower code"
    requirement: STO-08
    verification:
      - kind: integration
        ref: "src/fact-store/lease.test.ts#store leader and follower (node:sqlite and better-sqlite3)"
        status: pass
      - kind: unit
        ref: "src/fact-store/lease.test.ts#startTakeover"
        status: pass
    human_judgment: false
  - id: D3
    description: "Store location: git common dir when safe, cache directory for non-git, unwritable, synced-folder, network-mount and symbolic-link store directories, an absolute user-level override that wins, owner-only idempotent creation, and no repository content able to place the store"
    requirement: STO-07
    verification:
      - kind: unit
        ref: "src/fact-store/location.test.ts"
        status: pass
      - kind: integration
        ref: "src/fact-store/durability.test.ts#[edge STO-07/concurrency] a child process and the parent create the same store directory at the same moment"
        status: pass
    human_judgment: false
  - id: D4
    description: "Dirty sentinel and recovery: set by all five mutating writer calls, removed after the idle window, release or close; quick_check on open when found; overwritten pages, text files and foreign SQLite files are moved aside (newest two kept) and rebuilt with rebuilding until a full overlay is written; reopening a rebuilt store checks nothing and moves nothing"
    requirement: STO-06
    verification:
      - kind: unit
        ref: "src/fact-store/durability.test.ts#dirty sentinel, quick_check on open, quarantine and pruneQuarantine (both drivers)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Schema-version policy: a newer store throws SchemaTooNew naming the host version and is left untouched; an older store is deleted and recreated with no moved-aside copy and answers rebuilding"
    requirement: STO-06
    verification:
      - kind: unit
        ref: "src/fact-store/durability.test.ts#schema version policy (both drivers)"
        status: pass
    human_judgment: false
  - id: D6
    description: "A writer process killed with SIGKILL at 1, 4, 9 acknowledged commits and at a random time leaves a store that passes quick_check on reopen, with every committed file all-or-none (20 symbols, 20 references, 3 imports) and a watermark not below the last acknowledged sequence number"
    requirement: STO-06
    verification:
      - kind: integration
        ref: "src/fact-store/durability.test.ts#killing a real writer process"
        status: pass
    human_judgment: false
  - id: D7
    description: "The lease, sentinel and SIGKILL behaviour is the same on Linux and Windows as measured on macOS (research assumption A1), including release of the exclusive lock on process kill"
    requirement: STO-08
    verification: []
    human_judgment: true
    rationale: "Only macOS arm64 was available; the two-process SIGKILL and concurrent-start tests are written to run on all three operating systems in CI, and a failure on one reopens the pid-file alternative"

duration: 17min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 12: Lifecycle skin for the Fact Store Summary

**A cross-process writer lease (BEGIN EXCLUSIVE on lease.db, released by the OS on SIGKILL) with read-only followers that take over on a jittered timer, a store location resolver with cache fallback, and a dirty-sentinel, quick_check, quarantine and rebuild path proven against a killed writer child and overwritten pages**

## Performance

- **Duration:** 17 min
- **Started:** 2026-10-16T20:33:56Z
- **Completed:** 2026-10-16T20:50:49Z
- **Tasks:** 3 (1 tracer, 2 auto, all TDD)
- **Files modified:** 14 (10 created, 4 modified)

## Accomplishments

- STO-08: `lease.ts` gives one writer per store directory. The leader keeps a `BEGIN EXCLUSIVE` connection on `lease.db` for its whole life and writes `lease.json` by rename; a follower gets `WriterBusy` from `writer()`, `writerLeaseHeld: false`, `degraded: ['follower']` on every answer and `cache_unavailable` from `refs` (the 02-11 `canCache` option is now wired to the lease). `startTakeover` retries on a jittered timer between the approved 10 s and 30 s and fires `onLeaseChange(true)` once. Ten two-process races each produced exactly one leader, and a SIGKILLed child's lock was free for the parent at once.
- STO-07: `location.ts` returns the git common dir's `gsd-atlas` folder, or `{cacheRoot}/gsd-atlas/{storeId}` with a reason (`not_a_git_repo`, `not_writable`, `synced_folder`, `network_mount`, `store_dir_is_symlink`), or the user's absolute override plus the store id. Directories are created `0700`, recursively and idempotently; a parent and a child process creating the same directory at the same moment both succeed.
- STO-06: every mutating writer call sets a `dirty` sentinel that goes after the approved 1000 ms of quiet (or at release and close). A sentinel at open runs `quick_check`; a failed check, a non-database or a foreign SQLite file is moved to `facts.db.corrupt-<time>` (newest two kept), a fresh store is created and answers `rebuilding` until its first completed `setOverlay`. `status().rebuiltAfterCorruption` reports it and survives a reopen. A newer schema throws `SchemaTooNew`; an older one is deleted and recreated.
- The durability proof uses real damage: a writer child killed with SIGKILL at 1, 4, 9 commits and at a random time (the sentinel is left behind, the parent's open checks the store and finds it healthy, every file is all-or-none, the watermark never goes back), and overwritten pages that fail `quick_check`.

## Task Commits

Each task followed RED, GREEN (the plan marks all three `tdd="true"`):

1. **Task 1 (tracer): lease, followers, takeover** - `3a411c8` (test), `c8353e1` (feat)
2. **Task 2: store location** - `a5b0386` (test), `33a5bff` (feat)
3. **Task 3: sentinel, quarantine, schema policy, SIGKILL and corruption proofs** - `30686fc` (test), `0e6f721` (feat)

**Plan metadata:** recorded by the docs commit that follows this summary.

## TDD Gate Compliance

All three tasks have a `test(02-12)` commit before their `feat(02-12)` commit. Each RED record passed `check tdd-red-evidence` (`RED_EVIDENCE_OK`):

- **Task 1 RED** (`.planning/red-evidence-02-12-t1.json`): target "takes the lease in a fresh directory and records the holder in lease.json" failed on `false !== true` from the placeholder lease; 20 of 20 cases failed on assertions.
- **Task 2 RED** (`.planning/red-evidence-02-12-t2.json`): target "uses {commonDir}/gsd-atlas for a writable git common dir ..." failed on the `deepStrictEqual` of the location; 21 of 22 failed.
- **Task 3 RED** (`.planning/red-evidence-02-12-t3.json`): target "dirty sentinel (node:sqlite) > the first write creates the sentinel ..." failed on `isDirty` false; 27 of 38 failed. The five SIGKILL cases and the `SchemaTooNew` case already passed at RED because atomic commits and the newer-schema refusal exist from plan 02-06; they stay as regression proofs. Semantic assessment: the target executed and failed on the planned assertion in each task, with no load, syntax or fixture fault.

The tracer gate: the Task 1 `<verify>` is automated-only; it was re-run after the tracer commit (146 tests across lease and store contract, typecheck, lint) and passed before any expansion.

## Files Created/Modified

- `src/fact-store/lease.ts` - `createLease` (exclusive lock on `lease.db`, `lease.json` by rename, busy-open retries, in-flight attempt sharing, `release` that removes diagnostics only if they still name this pid) and `startTakeover`
- `src/fact-store/location.ts` - `resolveStoreLocation`, `isSyncedFolderPath`, `defaultCacheRoot`, the network filesystem type table
- `src/fact-store/recovery.ts` - sentinel helpers, `runQuickCheck`, `quarantine`, `pruneQuarantine`, `DirtyGuard`, `recoveryCounters`
- `src/fact-store/open.ts` - `StoreOpenOptions`, the authority split, `attemptOpen`/`openWithRecovery`, takeover recovery, connection holder behind `StoreParts` getters
- `src/fact-store/store.ts` - `StoreLifecycle`, `processDegraded` (follower and rebuilding), the guarded writer, `rebuiltAfterCorruption` in `status`, lease release at `close`
- `src/fact-store/index.ts` - exports the location functions and types and `StoreOpenOptions`
- `src/fact-store/lease.test.ts`, `location.test.ts`, `durability.test.ts` - 20, 19 and 39 cases
- `src/fact-store/fact-store.test.ts` - the exported-values list gains the three location functions
- `scripts/test-helpers/lease-child.ts`, `store-writer-child.ts`, `child-lines.ts`, `store-facts.ts` - child processes and shared test support, outside `src`

## Decisions Made

See `key-decisions` above. The two that later plans must know: the sentinel check, quarantine and schema creation belong to the process with write authority only, so plan 02-25's follower `fresh` path must not expect a follower to repair anything; and `rebuild_pending` lives in the database, so any code that rebuilds a store (plan 02-18's `check`, which still reports ok) should call the same `noteRebuild` step.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] A follower must not write at open**
- **Found during:** Task 1 (store wiring)
- **Issue:** `openFactStore` always ran `createSchema` and a `BEGIN IMMEDIATE` seed transaction, so a follower would take the write lock (and could fail with busy while the leader indexes) and could rebuild the fuzzy-name index. STO-08 says a follower never writes.
- **Fix:** with the schema present a non-authority process skips the bootstrap transaction and reads `meta.fuzzy_path` to decide whether to use the trigram table.
- **Files modified:** src/fact-store/open.ts
- **Verification:** `a second store is a follower ...` and the contract suite on both drivers
- **Committed in:** c8353e1, reshaped in 0e6f721

**2. [Rule 2 - Missing critical] Recovery when a follower takes over**
- **Found during:** Task 3
- **Issue:** a killed leader leaves the sentinel; the follower that takes over would never check the store until its next open, and could be serving a damaged file.
- **Fix:** the takeover callback checks the sentinel, runs `quick_check`, and on failure closes the connections, quarantines, recreates the store in place and clears the snapshot-id cache; `writer()` answers `WriterBusy` while that runs. `onLeaseChange(true)` fires after it.
- **Files modified:** src/fact-store/open.ts, src/fact-store/store.ts
- **Verification:** two tests in `durability.test.ts` (healthy and damaged takeover)
- **Committed in:** 0e6f721

**3. [Rule 3 - Blocking] Two existing fact-store assertions**
- **Found during:** Task 3 (full `npm test`)
- **Issue:** `fact-store.test.ts` asserts the exact exported values (the plan adds three) and that no file but `open.ts` names a driver option (my first `lease.ts` took a `driver` option).
- **Fix:** the export list gained `defaultCacheRoot`, `isSyncedFolderPath`, `resolveStoreLocation`; `createLease` now takes an injected `openDb` that `open.ts` binds to its driver.
- **Files modified:** src/fact-store/fact-store.test.ts, src/fact-store/lease.ts, src/fact-store/lease.test.ts
- **Verification:** full suite, 1515 tests passing
- **Committed in:** 0e6f721

**4. [Rule 2 - Missing critical] A foreign SQLite file is no longer a plain error**
- **Found during:** Task 3
- **Issue:** the old open threw a plain `Error` ("remove it to rebuild") for a valid database without the fact-store meta, which would wedge the Host until a human deleted a file.
- **Fix:** such a file is moved aside like a damaged one (kept as evidence), never deleted.
- **Files modified:** src/fact-store/open.ts
- **Verification:** `not a database: a valid SQLite file that is not a fact store is moved aside, never deleted`
- **Committed in:** 0e6f721

### Additions beyond the plan's file list

`scripts/test-helpers/child-lines.ts` and `scripts/test-helpers/store-facts.ts` hold code both child scripts and both test files share (stdout line reader with test-only ceilings, generated facts of a known shape). `GSD_ATLAS_STORE_DIR` names the environment form of the `store.dir` override, which the plan left unnamed.

---

**Total deviations:** 4 auto-fixed (3 missing critical, 1 blocking)
**Impact on plan:** all four are needed for the plan's own truths (follower never writes, a killed leader is replaced safely, the suite stays green). No scope creep beyond two shared test helpers.

## Issues Encountered

- A first takeover-corruption test damaged nothing: the main file was 4 KB because the follower's open connections kept the leader's facts in the WAL. The test now folds the WAL in with `wal_checkpoint(TRUNCATE)` before overwriting.
- The busy-open test's flaky opener failed the kit's own `:memory:` self-test; it now passes that open through.

## Known Limitations

- Linux and Windows are unverified (research assumption A1): the lease, SIGKILL and concurrent-start tests run on all three in CI, which was not available here. A failure on one OS reopens the pid-file alternative.
- During a takeover rebuild, a read that arrives between closing the old connections and opening the new ones fails with a closed-database `DbError`. The window is one asynchronous open of an empty file.
- `eslint` covers `src` only, so `scripts/test-helpers` is typechecked but not linted.
- `statfs` type numbers are the Linux magic values; macOS reports different numbers, so a network mount on macOS is not detected by that check (the synced-folder path rules still apply).
- The dirty-sentinel timer is a real `setTimeout` that is not unref'd, so a process that wrote keeps running up to the idle window after its last write unless it closes the store.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-15 (Indexer) can start from `onLeaseChange(true)` and `status().writerLeaseHeld`; plan 02-17 and 02-20 pass `lease: 'acquire'` and the location from `resolveStoreLocation`.
- Plan 02-18 replaces the `check`, `compact`, `collect` and `maintain` stubs; `check` should reuse `runQuickCheck`, `quarantine` and the rebuild notes.
- No blockers.

## Self-Check: PASSED

- Created files exist on disk: lease.ts, location.ts, recovery.ts, the three test files and the four helpers under scripts/test-helpers (checked with `[ -f ]`).
- Commits `3a411c8`, `c8353e1`, `a5b0386`, `33a5bff`, `30686fc`, `0e6f721` are on this branch (`git log 3634108..HEAD`; measured count 6).
- `npm run typecheck`, `npm run lint`, `npm run build` exit 0; `dist` holds no file from `scripts/test-helpers`; the full suite passes (1515 tests); the lease and durability files passed five repeated runs.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
