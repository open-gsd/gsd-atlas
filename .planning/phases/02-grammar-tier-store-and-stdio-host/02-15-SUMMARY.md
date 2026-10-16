---
phase: 02-grammar-tier-store-and-stdio-host
plan: 15
subsystem: indexer
tags: [indexer, coalescing-queue, ensure-fresh, hash-parse-race, source-set, governor, fact-store-writer]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: SourceTree (02-05), Fact Store writer and reader (02-06, 02-11, 02-12), Grammar Engine and extractor (02-07, 02-13), Governor (02-09), Clock.after (02-02), approved constants (02-04)
provides:
  - "createIndexer(deps): build, submit, ensureFresh, attach, status, stop over a real store, Source Tree, engine and Governor"
  - "createCoalescingQueue: per-(worktree, path) debounce with a maximum wait on one Clock.after timer, in-flight rerun, flushNow, close"
  - "createModuleHost: claimed extensions, lazy grammar load per module, FileFacts extraction with the lock's upstream ref as grammarVersion"
  - "EventSource port and createManualEventSource test double"
  - "processBatch: ignore filter, one batched hashPaths, sourceSet, link-or-parse, null commits, stamp-checked race retries, per-path locks"
affects: [02-16, 02-17, 02-18, 02-22, 02-23, 02-25, 02-26, 02-28]

actuals:
  tokens: 26800
  tasks: 3
  commits: 6
plan_head_before: 6511ff496a156c8642e055fd46de731f34909c92
plan_head_after: 5161a53a9e3ca6ea002221e3b7200357f1f2b227

tech-stack:
  added: []
  patterns:
    - "One timer for the earliest deadline; a later event only moves a deadline later, so submit rarely re-arms"
    - "Stamp (size, mtime, ctime, inode) before hashing must equal the stamp before the link and after the read, else requeue (STO-02)"
    - "Ignored watcher paths are decided by snapshot membership, remembered per worktree, and invalidated by a .gitignore event"
    - "A request's jobs all carry one requestId in the fresh class, so the Governor gives the request one slot"

key-files:
  created:
    - src/indexer/types.ts
    - src/indexer/defaults.ts
    - src/indexer/event-source.ts
    - src/indexer/modules.ts
    - src/indexer/process.ts
    - src/indexer/build.ts
    - src/indexer/queue.ts
    - src/indexer/ignore.ts
    - src/indexer/paths.ts
    - src/indexer/indexer.ts
    - src/indexer/index.ts
    - src/indexer/indexer.test.ts
    - src/indexer/queue.test.ts
  modified: []

key-decisions:
  - "A worktree is named by its root directory exactly as SourceTree.worktrees() reports it; that string is the store's worktree id, Source Tree's worktree argument and every notice's worktree. The plan's 'main' was a placeholder"
  - "hashPaths does not consult ignore rules and git check-ignore is outside the CommandRunner allowlist, so the Indexer drops ignored watcher paths itself: known (seen in a snapshot), vanished (kept, hashing reports it missing), or settled by ONE snapshot per batch and remembered; a .gitignore event clears the memory"
  - "flushNow(worktree, paths) hands the pending entries back (path to first-event time) instead of delivering them, so ensureFresh can process them in the fresh class; the queue never runs what was handed back"
  - "Null commits are idempotent, so deleted and no-longer-source paths always get one; only unclaimed-extension and ignored paths first check that the overlay holds the path, to keep event floods from costing a write each"
  - "Build asks store.reconcile which paths need work and hands only those to processBatch, which hashes them again before reading; a failed or oversize path keeps the hash of its existing facts in the final setOverlay, or its on-disk hash as pending"
  - "Two internal bounds not in 02-CONSTANTS.md: IN_FLIGHT_PATHS 8 (paths handed to the Governor at once) and IGNORED_MEMORY 100000 (ignored paths remembered per worktree). Neither is a timeout, queue bound or gate threshold of the Governor"

patterns-established:
  - "Failures are values: a failing file is a PathResult with a stable code (parse_timeout, source_too_large, unstable, module_load_failed ...), recorded in status().failed until a later success, and never stops the queue"
  - "Tests drive the real store, Source Tree, engine and Governor with a SpyClock that counts live timers; the store keeps one dirty-sentinel timer of its own, so Indexer timers are counted over that baseline"

requirements-completed: [IDX-02, IDX-04, STO-02, LNG-05]

coverage:
  - id: D1
    description: "Build over a real three-file toy repository stores facts that find returns, under the blob id git computes; a rebuild parses nothing and moves no watermark; shared content is linked, not parsed again; CRLF under eol=lf and a BOM file index correctly"
    requirement: STO-02
    verification:
      - kind: integration
        ref: "src/indexer/indexer.test.ts#Indexer tracer: build a three-file toy repository and find a definition"
        status: pass
    human_judgment: false
  - id: D2
    description: "IDX-02 coalescing queue: a burst is one job, a stream is bounded by the maximum wait, paths and worktrees never merge, a path in flight is rerun once, events arrive sorted, flushNow and close leave no timer"
    requirement: IDX-02
    verification:
      - kind: unit
        ref: "src/indexer/queue.test.ts"
        status: pass
      - kind: integration
        ref: "src/indexer/indexer.test.ts#Indexer events: the coalescing queue and the event source"
        status: pass
    human_judgment: false
  - id: D3
    description: "IDX-04 ensureFresh: indexes named paths ahead of the debounce in one fresh-class request, refuses absolute, dot-dot, NUL and symlink-escape paths unread, answers incomplete on timeout while the work continues"
    requirement: IDX-04
    verification:
      - kind: integration
        ref: "src/indexer/indexer.test.ts#Indexer ensureFresh, the hash and parse race, failures and status"
        status: pass
    human_judgment: false
  - id: D4
    description: "STO-02 race handling: a file edited between stamp, hash and read is read again and never stored under a stale hash; a file that never settles is reported stale with the code unstable"
    requirement: STO-02
    verification:
      - kind: integration
        ref: "src/indexer/indexer.test.ts#race: a file edited while it is read is read again, and the stored facts match its final content"
        status: pass
      - kind: integration
        ref: "src/indexer/indexer.test.ts#race: a file that changes on every read is given up after the configured retries and reported stale"
        status: pass
    human_judgment: false
  - id: D5
    description: "LNG-05 in the Indexer: only claimed, non-generated, non-vendored, non-binary, non-LFS, non-oversize, non-ignored files are parsed; a path that stops qualifying or disappears leaves the overlay; failures keep earlier facts"
    requirement: LNG-05
    verification:
      - kind: integration
        ref: "src/indexer/indexer.test.ts#binary: a path that becomes binary leaves the overlay, and so does a path whose extension is no longer claimed"
        status: pass
      - kind: integration
        ref: "src/indexer/indexer.test.ts#an event for an ignored file never reaches hashPaths or the parser, even with a claimed extension"
        status: pass
    human_judgment: false
  - id: D6
    description: "Three-OS behaviour of the Indexer (mtime resolution in the stamp check, symlink creation, realpath forms on Windows and Linux) is unverified until the CI matrix runs it"
    verification: []
    human_judgment: true
    rationale: "Only macOS arm64 ran; the Windows and Linux legs of CI are the check and have not run for this plan"

duration: 22 min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 15: Indexer Summary

**Indexer core: a coalescing queue with debounce and maximum wait, ensureFresh in one fresh-class Governor request, snapshot-based ignored-path filtering before hashPaths, and a stamp-checked hash-then-parse race that never files facts under a stale hash, tested on a real repository, store, engine and Governor with a counting fake clock**

## Performance

- **Duration:** 22 min
- **Started:** 2026-10-16T21:46:00Z (estimated from the previous plan's commit time)
- **Completed:** 2026-10-16T22:09:00Z
- **Tasks:** 3 (one tracer, two auto; all TDD)
- **Files created:** 13 (all under `src/indexer/`)

## Accomplishments

- **Build and batch processing (tracer).** `build` snapshots a worktree, filters it with `sourceSet`, asks `store.reconcile` which paths need work, runs only those through `processBatch` and records the overlay. Over a real temp repository: three toy files give `files 3, parsed 3, linked 0`; `find('helper')` returns `b.toy`; the stored hash equals `git hash-object` output; a second build parses 0, links 3 and leaves the watermark seq unchanged; a copy of `b.toy` is linked (parsed 0); three identical files in one build parse once and link twice; a CRLF copy under `eol=lf` is stored under the blob id of its LF text with LF spans; a BOM file's first token is at line 0, column 0.
- **Coalescing queue (IDX-02, D-12).** One `Clock.after` timer for the earliest deadline, `min(last + 100 ms, first + 500 ms)` with the approved values, events grouped per worktree and delivered with paths sorted in code-unit order. A path whose batch is running is rerun exactly once afterwards. `flushNow` and `close` leave zero Indexer timers (counted by a spy clock).
- **ensureFresh (IDX-04).** Validates every path (absolute, `..`, NUL, realpath outside the worktree go to `invalid` and are never hashed or read), takes over pending queue entries, runs the paths as `fresh` jobs under one request id, and races the work against `clock.after(waitMs)`. On timeout the work keeps running and finishes later.
- **Hash and parse race (STO-02, T-02-50).** The `lstat` stamp before hashing must equal the stamp just before the link and right after the read; otherwise nothing is committed, a `requeued` notice is sent and the path is hashed and read again, up to `maxRaceRetries` (3) more times, then fails as `unstable` with the earlier facts kept. A per-path lock stops an older job committing after a newer one.
- **Failure accounting and status.** Parse timeouts, oversize files and engine errors become coded `FailedPath` entries in `status().failed` until a later success, with `failed` and `indexed` notices (lag from the first event of the entry); the next path in the batch is still processed. `status()` reports queued, running, failed, the Clock time of the last commit and watcher problems.
- **Ignored watcher paths dropped before `hashPaths` (recorded as required by plan 02-05).** `hashPaths` hashes what it is asked and `git check-ignore` is outside the CommandRunner allowlist, so `src/indexer/ignore.ts` decides from snapshot membership. Test `an event for an ignored file never reaches hashPaths or the parser, even with a claimed extension` asserts the recorded `hashPaths` calls never contain the ignored path, that exactly one snapshot settled the verdict, and that a second event for the same path costs no second snapshot.

## Task Commits

1. **Task 1: Tracer, build a three-file toy repository** - `73a9e78` (test, RED), `996332d` (feat, GREEN)
2. **Task 2: Coalescing queue, EventSource port and submit** - `26eb6ea` (test, RED), `dd838a5` (feat, GREEN)
3. **Task 3: ensureFresh, race handling, failures and status** - `3c29e11` (test, RED), `5161a53` (feat, GREEN)

**Plan metadata:** recorded by the docs commit that adds this file.

## TDD Gate Compliance

All three tasks have a `test(02-15)` commit that precedes its `feat(02-15)` commit. No refactor commits.

| Task | RED target test | Classifier | Semantic assessment |
|------|-----------------|------------|---------------------|
| 1 | `stores facts that find returns, with the blob id git computes as the overlay hash` | RED_EVIDENCE_OK (`target_test_failed`) | Ran to its first `build()` call and failed there; the stub is the only cause. 8 of 8 failed; no syntax, import or fixture fault. |
| 2 | `burst: 50 events for one path inside one debounce window are one batch, after the window` | RED_EVIDENCE_OK | Queue stub throws on `submit`; 16 new cases failed, the 8 task-1 tests still passed. |
| 3 | `race: a file edited while it is read is read again, and the stored facts match its final content` | RED_EVIDENCE_OK | Ran through build, edit and race hook to the `ensureFresh` call, which rejected as unimplemented; all 12 new cases failed, the 24 earlier ones passed. |

The RED evidence files (`.planning/red-evidence-02-15-t1.json` to `-t3.json`) are untracked, as for the other plans.

## Files Created/Modified

- `src/indexer/types.ts` - IndexerDeps, IndexerConfig, Indexer, BuildResult, FreshResult, IndexerStatus, notices, `IndexerError` (`lease_held`, `unknown_worktree`, `stopped`)
- `src/indexer/defaults.ts` - `DEFAULT_INDEXER_CONFIG` from the approved constants (100, 500, 2000), `maxFileBytes` from `GRAMMAR_LIMITS.sourceBytes`, 3 race retries
- `src/indexer/event-source.ts` - `EventSource`, `FsChange`, `WatchProblem`, `createManualEventSource`
- `src/indexer/modules.ts` - `createModuleHost` over `resolveModules` and `readModuleInputs`
- `src/indexer/process.ts` - `processBatch`, `runJob`, `createPathLocks`, stamp checks
- `src/indexer/build.ts` - `runBuild`
- `src/indexer/queue.ts` - `createCoalescingQueue`
- `src/indexer/ignore.ts` - `createPathFilter` (ignored-path decisions)
- `src/indexer/paths.ts` - `isRepoRelative`, `realRoot`, `staysInside`
- `src/indexer/indexer.ts` - `createIndexer`
- `src/indexer/index.ts` - public surface
- `src/indexer/indexer.test.ts` (26 cases), `src/indexer/queue.test.ts` (10 cases)

## Decisions Made

See `key-decisions` above. In short: worktree id is the root path; ignore decisions come from snapshots; `flushNow` hands entries back; null commits are idempotent; build is reconcile-driven and hashes again before reading; two internal non-timeout bounds (8 in flight, 100,000 remembered ignored paths) are not in the constants file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Plan defect] A cross-file call cannot be an extracted reference site for the toy language**
- **Found during:** Task 1 (test design)
- **Issue:** The plan has `a.toy` call `helper` (defined in `b.toy`) and expects a reference site named `helper` with enclosing `main`. The 02-07 extractor keeps a site only when its name is a top-level definition of the same file, an import binding or an export name, and the toy `use` statement has no bindings, so that site is always dropped.
- **Fix:** `a.toy` defines `main` and `boot` and `main` calls `boot`; the test asserts a `call` site named `boot` with enclosing symbol 0 (`main`). `find('helper')` still returns `b.toy`.
- **Files modified:** `src/indexer/indexer.test.ts`
- **Committed in:** `73a9e78`, `996332d`

**2. [Rule 3 - Blocking] No way to learn which event paths git ignores**
- **Found during:** Task 2
- **Issue:** The brief and the 02-05 summary require the Indexer to drop ignored watcher paths before `hashPaths`, but `SourceTree` has no ignore query and `check-ignore` is outside the 02-03 allowlist.
- **Fix:** `src/indexer/ignore.ts`: snapshot membership as described above, one snapshot per batch for new existing paths, remembered verdicts, `.gitignore` invalidation. `src/indexer/paths.ts` was also added for the shared path rules. Neither file is in the plan's `files_modified` list.
- **Verification:** the ignored-file test in `indexer.test.ts`
- **Committed in:** `dd838a5`

**3. [Rule 2 - Missing critical] The worktree identity was left open**
- **Found during:** Task 1
- **Issue:** The plan writes `build('main')` while `SourceTree` methods take a directory and Query tests use the root path as the worktree.
- **Fix:** the id is the root directory reported by `SourceTree.worktrees()`; `build` and `ensureFresh` throw `IndexerError('unknown_worktree')` for anything else; the other methods use the id as the directory.
- **Committed in:** `996332d`

**4. [Rule 1 - Plan interpretation] `flushNow`, `attach` and `status` shapes**
- **Issue:** `flushNow` "flushes immediately" would have run the entries in the indexing class, but ensureFresh must run them as `fresh`. `IndexerStatus` had no place for the watcher problems the plan says are recorded.
- **Fix:** `flushNow` returns the taken entries (queue tests assert that the queue then does not process them); `status().watchProblems` counts problems per worktree and kind; `attach(source, worktrees)` was added to the `Indexer` interface, as Task 2 describes it.
- **Committed in:** `dd838a5`, `5161a53`

**5. [Rule 1 - Plan interpretation] Failure scripts use a wrapper over the real engine**
- **Issue:** The plan suggests the fake Grammar Engine for failure scripts; the fake answers only exact scripted source strings and would have needed per-test scripts of captures.
- **Fix:** `scriptedEngine` wraps the real engine and rejects with `GrammarRunError('parse_timeout')` or waits on a gate before a parse. The behaviour asserted is the same.
- **Committed in:** `3c29e11`

**6. [Rule 1 - Plan interpretation] Null commits**
- **Issue:** The plan says to commit a null "when it is currently in the overlay (look it up with `fileFacts`)". `fileFacts` is also null for a pending path, so a deleted pending path would never leave the overlay.
- **Fix:** deleted and no-longer-source paths always get the (idempotent) null commit; unclaimed-extension and ignored paths, the flood-prone ones, check `fileFacts` first.
- **Committed in:** `996332d`, `dd838a5`

---

**Total deviations:** 6 (1 plan defect, 1 blocking, 1 missing critical, 3 interpretations)
**Impact on plan:** none changes a stated behaviour; the ignored-path decision and the worktree identity are the two that later plans must know.

## Issues Encountered

- The first `ensureFresh` test counted live timers as 1 after an event but saw 2: the Fact Store keeps its own dirty-sentinel timer (`store.dirtyIdleMs`) after a commit. The tests now count Indexer timers over that baseline.
- Nothing hit the timeout guard.

## Known Stubs

None. `src/indexer` contains no placeholder text, empty data flowing to a consumer or TODO.

## Authentication Gates

None.

## Threat Flags

None. All new file access goes through `SourceTree` or the confinement helpers in `paths.ts`; no network, process or SQLite import in `src/indexer`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- **02-16 (Query):** `ensureFresh(worktree, paths, waitMs?)` returns `{complete, stalePaths, invalid}` for the `fresh` port; `complete: false` maps to `fresh_timeout`, `invalid` to the `invalid_fresh_path` warning.
- **02-17 (Reconcile, watcher):** the `EventSource` port lacks `subscribeGit` and `emitHead` (add them there); `ProcessContext` and `processBatch` are ready for chunks; `link` attaches a file that is marked stale without re-extracting it, so Reconcile or `markStale` handling must force a parse for stale paths; a `.gitignore` change clears ignore memory but does not re-evaluate paths already stored; a build that overlaps queue batches writes its overlay last (Reconcile repairs it).
- **Performance follow-ups:** a build hashes the paths that need work a second time (deliberate, STO-02); a new existing file costs one snapshot; both are within the 1 s p99 budget on gsd-core only if measured by 02-26.
- **Platform:** Linux and Windows are unverified until three-OS CI runs these tests (stamp comparison depends on mtime resolution; the symlink case is skipped on Windows).

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*

## Self-Check: PASSED
