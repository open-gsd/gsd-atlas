---
phase: 02-grammar-tier-store-and-stdio-host
plan: 17
subsystem: indexer
tags: [reconcile, file-watcher, parcel-watcher, git-worktrees, branch-switch, freshness, event-source]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "Source Tree snapshot, sourceSet, worktrees() and identity().commonDir (02-05); Fact Store reconcile, Writer.link, setOverlay, dropOverlay and Reader.refs (02-06, 02-11); TypeScript module and queries (02-13); Indexer core, EventSource port, coalescing queue, ensureFresh (02-15); approved constants (02-CONSTANTS.md)"
provides:
  - "reconcileWorktree: the correctness mechanism (IDX-03). Snapshot, source set, store.reconcile, chunked processBatch, setOverlay; a full build is the same run"
  - "Indexer.start, attach(worktree), reconcile and status().watchMode, reconciling, lastReconcile; Reconcile on start, on any watcher or git-watch problem, on a HEAD change and on the idle timer (600000 ms, maintenance priority, Clock.after)"
  - "EventSource port extended: subscribeGit, watchMode, optional writeSnapshot and eventsSince; the manual source gains emitHead, emitWorktrees, emitGitProblem"
  - "Worktree management (STO-03): eligibleWorktrees, syncWorktrees, gitDirNameOf and isInside with the realpath confinement check (T-02-56)"
  - "createParcelEventSource on @parcel/watcher 2.6.0 (exact, scripts disabled)"
affects: [02-18, 02-19, 02-20, 02-26, 02-27, 02-28]

actuals:
  tokens: 27095
  tasks: 3
  commits: 6
plan_head_before: eae1bd319b2aa0d17aa1bc87dc211acf119e2ca0
plan_head_after: a747888de03dc202cfe94d3e0b81b8042c0fed7f

tech-stack:
  added: ["@parcel/watcher 2.6.0 (exact; MIT; prebuilt platform packages as optional dependencies)"]
  patterns:
    - "Events are an accelerator, Reconcile is the truth: every watcher event means only 'hash this path'; a missed event, an overflow or an unwatched period is repaired by the next Reconcile"
    - "One Reconcile slot per worktree: plain requests share the run in progress, trailing requests (HEAD change, watcher problem) wait for it and share one follow-up run that begins after the request"
    - "Paths committed by file events or ensureFresh while a Reconcile runs are tracked, and the Reconcile's whole-overlay write takes the store's current hash for them instead of its older snapshot hash"
    - "Anything a repository file names is evidence, not an instruction: the git directory that is watched is always Source Tree's identity().commonDir, and a worktree's .git must lead into it"

key-files:
  created:
    - src/indexer/reconcile.ts
    - src/indexer/worktrees.ts
    - src/indexer/git-dir.ts
    - src/indexer/parcel-source.ts
    - src/indexer/harness.test.ts
    - src/indexer/reconcile.test.ts
    - src/indexer/worktree.test.ts
    - src/indexer/parcel-source.test.ts
    - src/indexer/freshness.test.ts
  modified:
    - src/indexer/indexer.ts
    - src/indexer/types.ts
    - src/indexer/event-source.ts
    - src/indexer/defaults.ts
    - src/indexer/index.ts
    - src/indexer/build.ts
    - src/indexer/process.ts
    - src/indexer/indexer.test.ts
    - package.json
    - package-lock.json

key-decisions:
  - "A worktree that is mid-Reconcile is not locked against file events. The overlay write replaces the whole overlay, so a commit that lands between the snapshot and the write would be undone; instead every path committed by a queue batch or ensureFresh during a run is remembered and the overlay takes the store's current hash for it (mutation-checked: without it the 'during reconcile' test fails)"
  - "Trailing Reconcile requests: a HEAD change or watcher problem that arrives while a run is in progress waits for it and runs once more, because the run in progress may have taken its snapshot before the change; plain reconcile() calls still share the one run"
  - "The old attach(source, worktrees) form is kept (it only listens and counts problems); attach(worktree) is the Tenant's form. The source for start and attach(worktree) comes from IndexerDeps.source; without one the Indexer is reconcile-only"
  - "idleReconcileIntervalMs 0 switches the periodic Reconcile off; negative, NaN and infinite values are rejected when the Indexer is made"
  - "A worktree whose .git file does not lead into the common git directory (a gitdir outside it, a look-alike worktrees directory, or an entry that is not <common>/worktrees/NAME) is neither watched, mapped nor indexed; start({worktrees}) naming it rejects with unknown_worktree"
  - "start({worktrees}) covers only the named worktrees and never adds a new one on a worktrees event (D-11: nothing is indexed without an explicit build); start() with no names covers every worktree and follows additions and removals"
  - "Internal bound not in 02-CONSTANTS.md: RECONCILE_CHUNK = 256 paths handed to processBatch at a time (not a timeout, queue bound or gate threshold; record it if the constants file is reopened)"

patterns-established:
  - "src/indexer/harness.test.ts: a real repository, store, Source Tree, engine and Governor with a FakeClock, a counting engine for parse counts, a spy Governor and addWorktree; the Reconcile, worktree and watcher tests share it"
  - "Real-watcher tests wait with a polling helper and let the operating system finish reporting before a quiet period is measured"

requirements-completed: [IDX-01, IDX-03, STO-03, STO-04]

coverage:
  - id: D1
    description: "Reconcile repairs a missed event (edit, delete, add), an overflow and an error, on start and on the idle timer, is idempotent, shares one run per worktree, and keeps a mid-run event"
    requirement: IDX-03
    verification:
      - kind: integration
        ref: "src/indexer/reconcile.test.ts#missed event: an unreported edit, delete and add are repaired by reconcile and reported as changed 3"
        status: pass
      - kind: integration
        ref: "src/indexer/reconcile.test.ts#overflow: a watcher overflow starts a Reconcile at the indexing priority even if no file event arrived"
        status: pass
      - kind: integration
        ref: "src/indexer/reconcile.test.ts#idle timer: the approved interval starts a Reconcile at the maintenance priority, re-arms, and stop cancels it"
        status: pass
      - kind: integration
        ref: "src/indexer/reconcile.test.ts#idempotent: a second Reconcile of an unchanged tree changes nothing, parses nothing and keeps the watermark"
        status: pass
      - kind: integration
        ref: "src/indexer/reconcile.test.ts#shared run: two requests for one worktree at the same time share one Reconcile"
        status: pass
      - kind: integration
        ref: "src/indexer/reconcile.test.ts#during reconcile: a file event that arrives mid-run is not lost and the final facts equal the working tree"
        status: pass
    human_judgment: false
  - id: D2
    description: "Worktrees share one store under one leader; added and removed worktrees are subscribed or dropped; a hostile .git is never watched"
    requirement: STO-03
    verification:
      - kind: integration
        ref: "src/indexer/worktree.test.ts#start subscribes both worktree roots and the common git directory once, and the store holds each content once"
        status: pass
      - kind: integration
        ref: "src/indexer/worktree.test.ts#a worktree added after start is subscribed and indexed, and a removed one is unsubscribed and its overlay dropped"
        status: pass
      - kind: integration
        ref: "src/indexer/worktree.test.ts#a worktree whose .git file names a directory outside the common git directory is not watched or indexed"
        status: pass
      - kind: unit
        ref: "src/indexer/worktree.test.ts#refuses a .git file that names a directory outside the common git directory"
        status: pass
    human_judgment: false
  - id: D3
    description: "A branch switch parses only the changed files (3 of 31, then 0 on the way back) and an unchanged importer resolves to src/b.ts on one branch and src/b/index.ts on the other through the real Reader"
    requirement: STO-04
    verification:
      - kind: integration
        ref: "src/indexer/worktree.test.ts#branch switch: parses exactly the 3 changed files, links the rest, and switching back parses 0"
        status: pass
      - kind: integration
        ref: "src/indexer/worktree.test.ts#two-branch targets: an unchanged importer resolves to src/b.ts on one branch and src/b/index.ts on the other"
        status: pass
    human_judgment: false
  - id: D4
    description: "The real @parcel/watcher feeds the Indexer: file and git-directory events with ignore lists, reconcile-only fallback, optional start-up hints"
    requirement: IDX-01
    verification:
      - kind: integration
        ref: "src/indexer/parcel-source.test.ts#delivers a change for a created, modified, renamed-over and deleted file, never for .git or node_modules, and stops on unsubscribe"
        status: pass
      - kind: integration
        ref: "src/indexer/parcel-source.test.ts#delivers head for a checkout in the main and in a linked worktree, worktrees for git worktree add, and nothing for object writes"
        status: pass
      - kind: integration
        ref: "src/indexer/parcel-source.test.ts#watchMode becomes reconcile-only when subscribe throws, and the Indexer still starts and stays fresh through Reconcile"
        status: pass
    human_judgment: false
  - id: D5
    description: "A saved file reaches find within the approved 3000 ms PR ceiling with the real watcher (measured 146 to 169 ms over five runs); an identical re-save moves no watermark"
    requirement: IDX-01
    verification:
      - kind: e2e
        ref: "src/indexer/freshness.test.ts#find returns the new definition after a save, and saving identical content again leaves the watermark alone"
        status: pass
    human_judgment: true
    rationale: "macOS arm64 only. The Linux and Windows watcher backends (inotify, ReadDirectoryChangesW) and the strict 1 second nightly figure are checked by three-OS CI and the gate script of plan 02-26, not here"

duration: 21min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 17: Reconcile, Worktrees and the Native Watcher Summary

**Reconcile as the correctness mechanism (start, watcher problems, HEAD changes, a 10 minute idle timer), one leader over every worktree of a repository with confined git-directory watching, branch switches that parse only the changed files, and the @parcel/watcher event source that puts a save into `find` in about 150 ms**

## Performance

- **Duration:** 21 min
- **Started:** 2026-10-16T22:34:50Z
- **Completed:** 2026-10-16T22:55:48Z
- **Tasks:** 3 (each RED then GREEN)
- **Files modified:** 19 (9 created, 10 modified)

## Accomplishments

- `reconcileWorktree` compares the working tree with the store and indexes exactly what differs; a deliberately unreported edit, delete and add are repaired (changed 3), a second run on an unchanged tree parses nothing, hashes nothing and moves no watermark. A full build is the same run at the indexing priority.
- Reconcile runs on `start()`, on every watcher or git-watch `overflow` or `error`, on a HEAD change, and from an idle timer armed through `Clock.after` at the approved 600000 ms (maintenance class, re-armed, cancelled by `stop()`). Requests for one worktree share a run; a HEAD change that arrives mid-run gets one follow-up run.
- Branch switch (STO-03): 31 files, feature changes 2 and adds 1. The HEAD event runs a Reconcile in which the engine parses exactly 3 files; switching back parses 0. Two branches with an unchanged importer resolve `run` to `src/b.ts` or `src/b/index.ts` through the real `Reader.refs`, and `src/main.ts` is parsed once across both switches (STO-04).
- Worktrees: `start()` subscribes every eligible worktree root and the common git directory once; a worktree added later is subscribed and indexed, a removed one is unsubscribed and its overlay dropped (`at(removed)` rejects with UnknownWorktree) while the others and the shared facts remain.
- `createParcelEventSource` on `@parcel/watcher` 2.6.0 delivers repo-relative POSIX paths without the event type, ignores `.git` and `node_modules`, maps the common git directory to `head` and `worktrees` events only, turns watcher errors into problem events, and reports `reconcile-only` when the package cannot load or `subscribe` throws (the Indexer still starts and stays fresh).
- Freshness with everything real (watcher, store, TypeScript module, Governor, system clock): a save reached `find` in 146, 148, 147, 151 and 169 ms against the 3000 ms ceiling; re-saving identical content moved no watermark.

## Task Commits

1. **Task 1 (tracer): Reconcile repairs a missed event and an overflow, on start and on the idle timer**
   - RED `751c0c4` (test)
   - GREEN `4f4c8fe` (feat)
2. **Task 2: Worktrees, branch switches and the two-branch correctness proof**
   - RED `9db6fed` (test)
   - GREEN `3b6f2a7` (feat)
3. **Task 3: The @parcel/watcher dependency, the real event source and the real-watcher freshness test**
   - RED `f8231f4` (test)
   - GREEN `a747888` (feat)

**Plan metadata:** the docs commit that adds this file.

## TDD Gate Compliance

Each task has a `test(02-17)` RED commit before its `feat(02-17)` GREEN commit, and no refactor commit was needed.

- **RED evidence** (`gsd_run check tdd-red-evidence`, all `RED_EVIDENCE_OK`; records kept untracked at `.planning/red-evidence-02-17-t1.json` to `-t3.json`):
  - T1: target "missed event: an unreported edit, delete and add are repaired by reconcile and reported as changed 3" failed with "reconcile is not implemented yet" (RED stubs for `start` and `reconcile`); all 12 cases failed on the stubs or the missing config validation. Semantic assessment: real repository, store and tree were built and indexed, three unreported edits were made, and the test failed at its first `reconcile()` call, not on syntax, import or fixture faults.
  - T2: target "branch switch: parses exactly the 3 changed files, links the rest, and switching back parses 0" failed on the planned wait ("timed out waiting for the branch switch to be reconciled") because the Indexer subscribed no git directory yet; 7 of 13 cases failed, the 5 gitDirNameOf and file-event cases already held.
  - T3: target "find returns the new definition after a save, and saving identical content again leaves the watermark alone" failed on the RED stub of `createParcelEventSource` ("the parcel event source is not implemented yet"); 13 of 14 cases failed, the hint-failure case on its assertion that the Indexer calls the optional hints.
- **Mutation check:** disabling the touched-path overlay repair makes "during reconcile" fail (expected 1, actual 0); it was restored before the GREEN commit.

## Files Created/Modified

- `src/indexer/reconcile.ts` - `reconcileWorktree`, `ReconcileReport`, the chunked run and the overlay write with touched-path repair
- `src/indexer/worktrees.ts` - `eligibleWorktrees` and `syncWorktrees` (removals first, additions only when covering all)
- `src/indexer/git-dir.ts` - `gitDirNameOf` (fs only, reads at most 4 KiB, requires `<common>/worktrees/NAME`) and `isInside` (realpaths, trailing separator)
- `src/indexer/parcel-source.ts` - `createParcelEventSource`, the `WatcherApi` seam for tests, ignore lists, git event mapping, snapshot hints
- `src/indexer/indexer.ts` - `start`, `reconcile`, `attach(worktree)`, Reconcile slots, idle timer, git handler, worktree sync, hints, status fields
- `src/indexer/types.ts`, `event-source.ts`, `defaults.ts`, `index.ts` - new config key, `StartOptions`, `ReconcileOutcome`, `WatchMode`, the git events and the extended port
- `src/indexer/build.ts`, `process.ts` - `runBuild` is now a wrapper over `reconcileWorktree`; `ProcessContext` gains `now()`
- `src/indexer/harness.test.ts` and the four new test files; `src/indexer/indexer.test.ts` (two status assertions gain the new fields)
- `package.json`, `package-lock.json` - `@parcel/watcher` 2.6.0

## Decisions Made

See `key-decisions` above. In short: overlay-write safety against concurrent commits instead of serialising events, trailing runs for HEAD changes and problems, a kept legacy `attach`, confinement of everything a repository file names, and one internal chunk size.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reconcile's whole-overlay write could undo a concurrent commit**
- **Found during:** Task 1 design (the plan says an event that arrives mid-run must be processed and the final state must equal the working tree)
- **Issue:** `setOverlay` replaces the whole overlay. A file event or `ensureFresh` that committed a path between the Reconcile's snapshot and its overlay write would be reverted to the snapshot's older hash (and a path created after the snapshot would be removed).
- **Fix:** the Indexer remembers every path a queue batch or `ensureFresh` commits while a Reconcile is running; the overlay write takes the store's current hash for those paths.
- **Files modified:** src/indexer/reconcile.ts, src/indexer/indexer.ts
- **Verification:** `reconcile.test.ts` "during reconcile" (fails without the repair, passes with it)
- **Committed in:** 4f4c8fe

**2. [Rule 3 - Blocking] A shared test world was needed, and two existing assertions had to follow the status shape**
- **Found during:** Task 1 (the plan says to import or copy the Task 1 setup helper from indexer.test.ts, but importing a test file re-runs its suites)
- **Fix:** `src/indexer/harness.test.ts` (not listed in `files_modified`) holds the shared world; `indexer.test.ts` gained `watchMode`, `reconciling` and `lastReconcile` in its two `status()` deep-equal assertions.
- **Files modified:** src/indexer/harness.test.ts, src/indexer/indexer.test.ts
- **Committed in:** 751c0c4

**3. [Rule 3 - Blocking] Reconcile had to replace the build body, so `build.ts` and `process.ts` changed**
- **Found during:** Task 1 (the plan wants `reconcile.ts` itself to call `store.reconcile` and `setOverlay`; a build was already exactly that sequence)
- **Fix:** the build body moved into `reconcileWorktree`; `runBuild` calls it at the indexing priority with the same result shape (all 02-15 build tests still pass). `ProcessContext` gained `now()` for durations.
- **Files modified:** src/indexer/build.ts, src/indexer/process.ts
- **Committed in:** 4f4c8fe

**4. [Rule 2 - Missing Critical] Confinement is stricter than "inside the common git directory"**
- **Found during:** Task 2 (T-02-56)
- **Issue:** the plan's wording accepts any directory inside the common git directory. A `.git` file naming `<common>/objects` is inside it but is not a worktree entry.
- **Fix:** `gitDirNameOf` accepts only the common directory itself (name empty) or `<common>/worktrees/NAME`; an unreadable, missing or over-long `.git` gives null. The file is read with `fs` only and at most 4 KiB.
- **Files modified:** src/indexer/git-dir.ts
- **Verification:** `worktree.test.ts` (outside directory, look-alike worktrees directory, objects directory, no gitdir line, missing `.git`, relative gitdir, gitdir beyond the bytes read)
- **Committed in:** 751c0c4

**5. [Rule 3 - Blocking] Real-watcher test needed a quiet period after earlier git operations**
- **Found during:** Task 3
- **Issue:** the "nothing for object writes" check saw a late HEAD event of the linked worktree checkout that preceded it (the OS reports it after the awaited one).
- **Fix:** the test waits 700 ms before clearing its event list. Five repeated runs of the real-watcher, worktree and freshness files all passed.
- **Files modified:** src/indexer/parcel-source.test.ts
- **Committed in:** a747888

---

**Total deviations:** 5 auto-fixed (1 bug, 1 missing critical, 3 blocking)
**Impact on plan:** all necessary for correctness or to make the plan's own tests possible; no scope creep.

### Plan wording that was interpreted

- "A file event that arrives while Reconcile is running is processed afterwards": the event is processed concurrently and the Reconcile does not undo it (final state equals the working tree), instead of being held back behind the run. This keeps `ensureFresh` fast during a long start-up Reconcile.
- `package-lock.json` shows more than "only the watcher and its optional platform packages added": `@parcel/watcher`'s own runtime dependencies `detect-libc` and a nested `node-addon-api` are new, and `is-extglob`, `is-glob` and `picomatch`, already present as dev dependencies, are now runtime ones. The 12 optional platform packages (android, darwin, freebsd, linux glibc and musl, win32) were added; only `darwin-arm64` is installed on this machine. The integrity of `@parcel/watcher` equals the one recorded in 02-CONSTANTS.md.

## Issues Encountered

- **Reconcile does not re-extract a stale file.** `store.reconcile` lists paths whose facts are stale (after `Writer.markStale` for a newer grammar) in `reindex`, but `processBatch` tries `Writer.link` first and the store still holds facts for that hash, so the path is attached, not re-parsed, and the stale marker is not cleared by a Reconcile. Plan 02-18 (or whichever plan owns grammar upgrades) must add a re-extract path, for example a `force` flag for stale paths; this plan only notes it.
- Linux (inotify) and Windows (ReadDirectoryChangesW) watcher behaviour is covered only by the Reconcile backstop and by three-OS CI; everything here was run on macOS arm64 (assumption A2).
- The strict 1 second save-to-find figure is the gate script of plan 02-26; this plan checks the approved 3000 ms PR ceiling.

## Known Stubs

None. No hardcoded empty value flows to a consumer, and no placeholder or TODO text was added.

## Threat Flags

None. The new surface (a native watcher on worktree roots and the common git directory, reading each worktree's `.git` file) is the one the plan's threat model covers: T-02-56 (confined `.git` and watched directory), T-02-57 (ignore globs, Reconcile on overflow and error and on a timer), T-02-58 (exact pin, scripts disabled, integrity checked), T-02-59 (reconcile-only mode).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for 02-18 (collect and compact; consider the stale-file re-extract above), 02-19 (the other four tools reuse Query's FindContext), 02-26 (freshness gate: `gate.freshnessPrCeilingMs` is checked in `freshness.test.ts`, the nightly 1 second figure there) and 02-27 and 02-28 (the Tenant calls `start({worktrees})` with the worktrees the store already indexes and `attach(worktree)` after a successful build; 02-28 owns the Metrics rollup from the idle loop).
- `IndexerDeps.source` is how the Tenant passes `createParcelEventSource({snapshotDir})`; without a source the Indexer runs reconcile-only.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*

## Self-Check: PASSED
