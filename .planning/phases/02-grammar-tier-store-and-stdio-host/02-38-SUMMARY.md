---
phase: 02-grammar-tier-store-and-stdio-host
plan: 38
subsystem: source-tree
tags: [git, timeouts, cat-file, batch-check, store-identity, command-runner, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-29 constants addendum (runner.defaultTimeoutMs), 02-33 git option allowlist (cat-file --batch-check), 02-34 shared isInside"
provides:
  - "Every Source Tree git spec carries a finite timeout; CommandRunner.run() applies a 60 s default to specs without one"
  - "readMany asks for sizes first (--batch-check) and buffers only the blobs it keeps; read(commit, path, {maxBytes}) is capped"
  - "pickRootCommit: order-independent store identity (smallest root commit id)"
affects: [source-tree, command-runner, host-history, store-location]
tech-stack:
  added: []
  patterns:
    - "structural every-method test over a recording runner (adding a method without a timeout fails it)"
    - "size check before byte read, output cap derived from the sizes"
key-files:
  created:
    - src/source-tree/identity.ts
    - src/source-tree/identity.test.ts
    - src/source-tree/timeouts.test.ts
    - src/source-tree/capped-reads.test.ts
  modified:
    - src/source-tree/real.ts
    - src/source-tree/types.ts
    - src/source-tree/fake.ts
    - src/source-tree/contract.ts
    - src/source-tree/read-text.ts
    - src/source-tree/source-tree.test.ts
    - src/command-runner/git-spec.ts
    - src/command-runner/git-spec.test.ts
    - src/command-runner/real.ts
    - src/command-runner/real.test.ts
    - src/host/history.test.ts
    - scripts/package.test.ts
key-decisions:
  - "The byte batch reads from the peeled commit id the size check reported, not the caller's spelling of it, so a moving ref cannot make the second answer differ from the sizes its output cap was computed from."
  - "A spec.timeoutMs that is not a positive finite number counts as no timeout, so run() gives it the default too (an explicit valid timeoutMs still always wins)."
  - "createRealRunner throws RangeError for a defaultTimeoutMs that is not positive and finite, instead of silently disabling the default."
patterns-established:
  - "Constants are copied with a comment naming 02-CONSTANTS.md and its approval date; no new constant was invented."
requirements-completed: [LNG-05, STO-09, STO-07, HST-03]
status: complete
duration: one session
completed: 2026-10-17
plan_head_before: 7a3fbead7eaa8ecc28b579597aef5edf9fd3dae2
plan_head_after: 853a38493315e4afe047aa565d9da8c466c4c8ae
commits: 3
actuals:
  tokens: 15000
  tasks: 3
  commits: 3
---

# Phase 02 Plan 38: Bounded Source Tree git calls, size-first batch reads, order-independent store identity Summary

**Every Source Tree git call now has a timeout (plus a 60 s runner default), `readMany` and `read` stop buffering blobs they will discard, and the store id comes from the smallest root commit instead of whichever root git prints first.**

## Performance

- **Duration:** one session
- **Completed:** 2026-10-17
- **Tasks:** 3 (1 tracer, 2 auto/TDD)
- **Files modified:** 16 (4 created)

## Accomplishments

- WR-07: `hasObject`, `read`, both `identity` specs and the `listFilterNames` enumeration (started by `snapshot` and `hashPaths`) carry `git.timeoutMs` (60000). `listFilterNames` takes an optional fifth `timeoutMs` argument. `CommandRunner.run()` applies `DEFAULT_RUN_TIMEOUT_MS` (60000, addendum key `runner.defaultTimeoutMs`, Approved 2026-10-17) to a spec without a usable timeout; `stream()` never does. The probe error now says "timed out" instead of "timed out or output exceeded its cap" when it was a timeout.
- WR-08: `readMany` runs `cat-file --batch-check` (output cap derived per input line: max(94, byte length of the spec + 12)), keeps blobs of type blob at or under the cap, and runs `cat-file --batch` for those only, with `maxStdoutBytes = commitSize + sum(selected sizes) + 128 * records`. No git for an empty list, one run when nothing is selected. `read(commit, path, { maxBytes })` defaults to 2 MiB, sets `maxStdoutBytes` to cap + 1 and throws `source_too_large` for an oversize blob; fake and contract suite agree.
- WR-06 / IN-03: `pickRootCommit(output)` returns the smallest valid object id; `identity()` uses it (the `storeId` formula is unchanged, so single-root repositories keep their id). `read-text.ts` imports the shared `isInside` from the facts module.

## Task Commits

1. **Task 1: every Source Tree git spec has a timeout (WR-07)** - `41c0cb1`
2. **Task 2: size-checked batch reads and a capped read (WR-08)** - `b2fec9d`
3. **Task 3: store identity independent of root print order (WR-06), shared isInside (IN-03)** - `853a384`

Each task had its tests written first and run red (task 1: missing `DEFAULT_RUN_TIMEOUT_MS` export, specs without timeout, hung `hasObject`; task 2: six failing cases for the missing size run, cap and read option; task 3: `identity.ts` did not exist, so the new tests could not load).

## Evidence

- Mutation check (task 1): removing the timeout from the `rev-list` spec in `identity()` makes `every method has a timeout` fail; restoring it makes it pass.
- Verification: `npm run typecheck` and `npm run lint` exit 0. `npm test` (all of `src/**` and `scripts/**`): 2420 tests, 2420 pass, 0 fail, 0 skipped. The plan's own commands (timeouts, source-tree, git-spec, git-read, real, runner, capped-reads, history, indexer harness, identity, location, two-tenant) all pass. The known `parcel-source.test.ts` SIGTRAP flake did not occur in this run.
- Test titles required by the acceptance criteria exist: `every method has a timeout`, `hung git rejects`, `default timeout applies to run`, `explicit timeout wins`, `stream has no default`; `at the cap`, `two runs`, `all oversize`, `empty list`, `unknown commit`, `read over the cap`; `permutations`, `single root unchanged`, `two roots`, `unborn`.

## Callers of `runner.run` that set no `timeoutMs` (now under the 60 s default)

Production: none. `src/source-tree/real.ts` sets a timeout on every spec (proved by the structural test); `listFilterNames` receives one from the Source Tree. Callers that use `listFilterNames` without a timeout are tests only.

Tests and scripts, each fine under the default:
- `src/command-runner/runner.test.ts` (`node -e` one-liners that finish at once) and `real.test.ts` (specs that need to stay alive set their own `timeoutMs`).
- `src/command-runner/hostile-repo.test.ts` setup git commands (`cat-file`, `ls-files`, `hash-object`, `commit` on tiny repositories).
- `src/test-kit/git-repo.ts` (init, add, commit on temporary repositories) and `scripts/test-helpers/fixture-repo.ts` (git setup, and CLI runs of the built bin that return in seconds).
- `src/lang/lang-test.e2e.test.ts` (CLI bin, whole file runs in about 5 s), `scripts/cli-bin.test.ts`, `scripts/mcp-stdio.test.ts` (noise child that exits at once).
- `scripts/package.test.ts` `runChild` runs `npm pack` and a registry install, which can exceed 60 s on a slow network; it now passes an explicit `timeoutMs: 300_000` (see deviations).
- `stream()` callers (`fact-store/lease.test.ts`, `durability.test.ts`, `scripts/test-helpers/mcp-process.ts`) are unaffected: `stream()` never gets the default.

## Callers of `SourceTree.read`

No production caller exists. Callers are tests: `src/command-runner/hostile-repo.test.ts` (one small blob), the contract suite and `source-tree.test.ts`, and the pass-through wrappers in `src/indexer/harness.test.ts` and `src/indexer/indexer.test.ts` (`read: (commit, path) => tree.read(commit, path)`). None relied on an unbounded read, and none needed an explicit cap.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking/regression guard] `scripts/package.test.ts` gets an explicit timeout**
- **Found during:** Task 1 (listing callers without a timeout)
- **Issue:** `runChild` runs `npm pack` and a registry install through `runner.run` with no `timeoutMs`; under the new 60 s runner default a slow network would turn it into a flaky failure.
- **Fix:** `timeoutMs: 300_000` with a comment naming WR-07. The file is outside the plan's `files_modified`; the change is one line.
- **Commit:** `41c0cb1`

**2. [Rule 1 - Expected test fallout] Existing tests that encoded the one-run shape of `readMany`**
- **Found during:** Task 2
- **Issue:** `source-tree.test.ts` (exactly one `cat-file` start, three starts for resolve+list+read, scripted single-stream responses) and `src/host/history.test.ts` ("ONE cat-file batch") asserted the old process shape.
- **Fix:** updated to the two-run shape (size check, then bytes); scripted responses now answer by subcommand; added a case where the size check returns too few lines and no byte batch starts.
- **Commit:** `b2fec9d`

**3. [Design choices inside the plan's freedom]**
- The byte batch uses the peeled commit id from the size check's first line (race-free against a moving ref); the size-check stdin still uses `commit^{commit}` as the plan says.
- A non-positive or non-finite `spec.timeoutMs` is treated as absent and gets the default; `createRealRunner` throws `RangeError` for such a `defaultTimeoutMs`.
- `read` validates `maxBytes` (non-negative safe integer) and throws `invalid_argument` otherwise.

The plan said the recording fake "honours `timeoutMs`"; it does not (it only returns scripted results). The `hung git rejects` case therefore uses a small purpose-built runner in the test that never answers unless the spec carries a timeout. The recording fake was left unchanged.

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None. No new network, auth or file-access surface; T-02-119, T-02-120 and T-02-121 are mitigated as planned.

## Deferred (carried from the plan, unchanged)

- The identity probe still runs before the Governor admits the request (the tenant key is unknown until it returns); it is bounded by the 60 s timeout, but a burst of requests naming many different hung repositories can start many git processes at once. Home: Phase 4 Governor (HRD-05).
- `storeId` still changes when the set of roots reachable from HEAD changes (an unrelated history merged in, a branch with other roots, the first commit of an unborn branch); `--all` was rejected. A persisted pointer is a Phase 4 identity question (ROADMAP Phase 4, success criterion 7). Single-root repositories (gsd-core) keep their id.

## Notes

- A `.codegraph/` directory was created in the worktree root by `codegraph init -y` (per the user's worktree instructions) and is left untracked; it was never staged.

## Self-Check: PASSED

- Created files exist: `src/source-tree/identity.ts`, `identity.test.ts`, `timeouts.test.ts`, `capped-reads.test.ts`.
- Commits `41c0cb1`, `b2fec9d`, `853a384` are ancestors of HEAD.
