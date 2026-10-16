---
phase: 02-grammar-tier-store-and-stdio-host
plan: 05
subsystem: source-tree
tags: [git, hash-object, check-attr, worktree, linguist, git-lfs, confined-read, node-test]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-03 built-in git rule (check-attr, hash-object, ls-tree, worktree list --porcelain -z); 02-04 approved git timeouts in 02-CONSTANTS.md"
provides:
  - "SourceTree.hashPaths: coalesced paths, one batched hash-object, clean filters and eol rules applied, two git starts"
  - "SourceTree.sourceSet: extension, linguist-generated/vendored, binary, LFS pointer and size filters with stable diagnostic codes"
  - "SourceTree.worktrees: every worktree from one porcelain -z run, canonical paths, short branch names"
  - "SourceTree.readText: realpath-confined, link-refusing, capped text read that answers instead of throwing"
  - "SourceTreeIdentity.commonDir (canonical real path of the common git directory)"
  - "One shared contract suite (fake and real) extended for all four methods"
affects: [02-12 store location, 02-15 indexer, 02-16 query, 02-24 history, 02-19 impact]

actuals:
  tokens: 25000
  tasks: 3
  commits: 6
plan_head_before: febbdd5a494c9a0a62797f4925e5bedffb692a9e
plan_head_after: b219e715a6488e8d21e658ff5edf4589ce6b3416

tech-stack:
  added: []
  patterns:
    - "Rules shared by fake and real through a function that takes the I/O as arguments (filterSourceSet with checkAttr and peek), so codes and order cannot drift"
    - "Per-path vetting factored once (vetPaths) and used by snapshot and hashPaths; one batch helper (hashBatch) carries the approved batch timeout"
    - "Real-harness attribute realisation through .git/info/attributes so attributes never appear in a snapshot"

key-files:
  created:
    - src/source-tree/source-set.ts
    - src/source-tree/worktrees.ts
    - src/source-tree/read-text.ts
  modified:
    - src/source-tree/types.ts
    - src/source-tree/real.ts
    - src/source-tree/fake.ts
    - src/source-tree/contract.ts
    - src/source-tree/index.ts
    - src/source-tree/validate.ts
    - src/source-tree/source-tree.test.ts

key-decisions:
  - "hashPaths hashes what it is asked to and does not consult ignore rules; the Indexer (plan 02-15) must drop ignored watcher paths before calling it"
  - "git.timeoutMs = 60000 goes on every spec Source Tree builds, including snapshot's two ls-files runs; git.hashBatchTimeoutMs = 120000 on the one hash batch of both snapshot and hashPaths (both approved in 02-CONSTANTS.md)"
  - "sourceSet precedence per file: extension, name safety, generated, vendored, then size, binary, LFS pointer; each dropped file gets exactly one diagnostic"
  - "readText answers instead of throwing: escape for empty/NUL/absolute/drive-relative/.. and for a path whose realpath leaves the worktree, not_file for any final-component link or non-regular file, missing for ENOENT/ENOTDIR, too_large over the cap"
  - "unhashableReason moved to validate.ts so fake and real share one name rule; escapesWorktree lives beside it for the same reason"

patterns-established:
  - "Contract worlds per concern (CONTRACT_WORLD, SOURCE_SET_WORLD, READ_TEXT_WORLD) instead of growing one world and disturbing earlier expectations"
  - "Real-only cases cover what a data world cannot express (symlinks, linked worktrees, recorded git starts)"

requirements-completed: [LNG-05, STO-02, STO-03]

coverage:
  - id: D1
    description: "hashPaths returns git blob ids (clean filters and eol applied) for a coalesced list through two git starts"
    requirement: STO-02
    verification:
      - kind: unit
        ref: "src/source-tree/source-tree.test.ts#real Source Tree hashPaths and SourceTree contract hashPaths cases"
        status: pass
    human_judgment: false
  - id: D2
    description: "sourceSet drops unclaimed extensions, linguist-generated/vendored, binary, LFS pointers and oversize files with stable codes, one check-attr run"
    requirement: LNG-05
    verification:
      - kind: unit
        ref: "src/source-tree/source-tree.test.ts#real Source Tree sourceSet and SourceTree contract sourceSet cases"
        status: pass
    human_judgment: false
  - id: D3
    description: "worktrees() lists main, detached, branch, locked and prunable worktrees with canonical paths; identity exposes commonDir"
    requirement: STO-03
    verification:
      - kind: unit
        ref: "src/source-tree/source-tree.test.ts#real Source Tree worktrees and identity, parseWorktreeList"
        status: pass
    human_judgment: false
  - id: D4
    description: "readText never leaves the worktree: .., absolute, NUL, symlinked directory and final-component link cases"
    verification:
      - kind: unit
        ref: "src/source-tree/source-tree.test.ts#real Source Tree readText and SourceTree contract readText cases"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 05: Source Tree additions Summary

**Source Tree now batches hashing of changed paths (two git starts, clean filters and eol rules applied), applies the LNG-05 source-set filters with stable diagnostic codes, lists every worktree from one porcelain run, and reads matched line text only through a realpath-confined, link-refusing reader, all behind one shared fake/real contract.**

## Performance

- **Duration:** about 55 min
- **Tasks:** 3 of 3 (each as a RED test commit then a GREEN feature commit)
- **Files:** 3 created, 7 modified (all under `src/source-tree/`)

## Accomplishments

- `hashPaths(worktree, paths)`: dedupes and sorts, vets each path (the same lstat classification `snapshot` uses, now one `vetPaths`), enumerates filter drivers on every call, then runs one `hash-object --stdin-paths` with the approved batch timeout (hashBatchTimeoutMs = 120000). Exactly two git starts for any N; none when nothing is hashable. A CRLF file under `*.ts text eol=lf` hashes to the LF blob id, equal to `git add` then `rev-parse :path`.
- `sourceSet(worktree, files, options)`: one `filterSourceSet` shared by the real tree and the fake. Extension filter first (aggregated `extension_not_claimed` count, not per file), then name safety, then one `check-attr -z --stdin linguist-generated linguist-vendored` run, then bounded opens in batches of 64 (size cap, NUL in the first 8 KB, LFS pointer line). The open uses O_NOFOLLOW where the platform has it, so a file swapped for a link after the lstat is not followed. Output is sorted by path, identical on repeat calls.
- `worktrees()`: `parseWorktreeList` handles NUL-delimited records, bare, locked with and without a reason, prunable, the all-zero unborn HEAD (becomes `head: null`), and unknown future fields. Paths are canonicalised with `realpathSync.native`; a vanished directory keeps git's path and is marked prunable. A git that rejects `-z` yields `git_failed` naming git 2.36.
- `readText(worktree, path, {maxBytes?})`: escape / missing / not_file / too_large / ok, never a throw for bad input or bad content; BOM and CRLF preserved; default cap 2 MiB.
- `SourceTreeIdentity.commonDir` returns the canonical common git directory `identity()` already computed.

## Task Commits

1. Task 1 (tracer): `2ed40ac` test, `496810b` feat - hashPaths over one batched git hash run
2. Task 2: `461ecf4` test, `7c54583` feat - sourceSet filters
3. Task 3: `89a4d6e` test, `b219e71` feat - worktrees and confined readText

Verification at the end: `node --test src/source-tree/source-tree.test.ts` 81/81, full `npm test` 1134/1134, `npm run typecheck`, `npm run lint` and `npm run build` exit 0. The tracer gate was satisfied by re-running the automated verify (CRLF case and the two-git-starts case both ran and passed) before Task 2 started.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `unhashableReason` moved into `src/source-tree/validate.ts`**
- **Found during:** Task 1
- **Issue:** The fake needs the same name rule the real tree applies (otherwise `unhashable_path` would diverge); it was a private function in `real.ts`.
- **Fix:** Moved it to `validate.ts` (one file beyond `files_modified`, as the dispatch allowed) and added `escapesWorktree` there for `readText`, shared by fake and real.
- **Files modified:** `src/source-tree/validate.ts`, `src/source-tree/real.ts`, `src/source-tree/fake.ts`
- **Commit:** 496810b, b219e71

**2. [Rule 3 - Blocking] Real-contract harness realises `SourceTreeWorld.attributes` itself**
- **Found during:** Task 2
- **Issue:** `createTempGitRepo` (test-kit) cannot express attributes.
- **Fix:** `writeAttributes` in `source-tree.test.ts` appends linguist lines to `.git/info/attributes` after the repo is built, so they are untracked and never appear in a snapshot. test-kit is untouched.
- **Commit:** 7c54583 (harness added in 461ecf4)

**3. [Rule 2 - Missing critical] git.timeoutMs = 60000 also applied to `snapshot`'s two `ls-files` runs**
- **Found during:** Task 1
- **Issue:** Plan truth 6 says every git spec built here carries the approved timeout; `snapshot`'s listing specs had none.
- **Fix:** Added the timeout to both; the snapshot hash batch now goes through the shared `hashBatch` with hashBatchTimeoutMs = 120000. No observable snapshot output changed.
- **Commit:** 496810b

### Scope notes (not defects)

- The contract asserts `commonDir` is non-empty and stable for both implementations; the equality with `realpathSync.native(.git)` is a real-only test, because the fake has no file system to compare against.
- `SourceTreeWorld.worktrees` is consumed by the fake only; the real harness does not create linked worktrees from data. Linked, detached, locked and prunable worktrees are exercised against git directly in real-only tests.
- The RED commit of Task 3 carries a stub `worktrees.ts` (returns an empty list) and the new type declarations so the tests fail on assertions rather than on a missing module.
- Both timeout constants (git.timeoutMs = 60000, hashBatchTimeoutMs = 120000) were set only after the human typed their confirmation; no other timeout-shaped value was introduced.

## Notes for downstream plans

- **Plan 02-15 (Indexer) must filter ignored watcher paths before calling `hashPaths`.** The T-02-14 mitigation as worded ("the source set can only be built from snapshot or hashPaths output, which come from ls-files with exclude-standard") holds for `snapshot` only. `hashPaths` starts git twice (the config read for the filter listing, then `hash-object`) and neither consults ignore rules, so `hashPaths(['.env'])` hashes an ignored file that exists. A third git start (`check-ignore`) was not added: it is outside the 02-03 allowlist and would break the two-starts contract. The type doc on `hashPaths` says so.
- `readText` narrows but cannot close a race where a parent directory is swapped for a link between the realpath and the open; the answer is text for one query, not a store.
- `O_NOFOLLOW` is absent on Windows; there the lstat before the open is the only link guard.

## Known Stubs

None.

## Threat Flags

None. `readText` (T-02-11), the filter-neutralised specs (T-02-12) and the 8 KB peek, batches of 64 and output caps (T-02-13) are the threat model's surfaces; T-02-14 is mitigated for `snapshot` and carried to 02-15 for `hashPaths` as described above.

## Self-Check: PASSED

- Files: `src/source-tree/source-set.ts`, `worktrees.ts`, `read-text.ts` present.
- Commits `2ed40ac`, `496810b`, `461ecf4`, `7c54583`, `89a4d6e`, `b219e71` are ancestors of HEAD.
