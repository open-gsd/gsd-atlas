---
phase: 02-grammar-tier-store-and-stdio-host
plan: 26
subsystem: ci
tags: [ci, gates, corpus, freshness, windows, linux, macos, inotify, grammar-lock, github-actions]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: recall harness (02-13), size gate (02-18), composeHost and the bins (02-20..02-23), process helpers (02-25), follower overlay and startup reconcile (02-27, 02-28)
provides:
  - scripts/corpus-gates.ts, the pinned-corpus build gate (source set, accounting identity, per-module parse errors, second-build idempotence, database size)
  - scripts/freshness-gate.ts, save-to-find p50/p95/p99 by nearest rank through the real Host and watcher
  - a `gates` job in ci.yml (recall, corpus gates, 20,000-edit size gate, freshness) on ubuntu, macos and windows, and nightly.yml with the strict one second p99
  - win32-x64 entries in the typescript and javascript grammar.lock files, from a Windows CI run
  - the first fully green three-OS run of Phase 2 (13 of 13 jobs) on ci/phase-2
  - fixes for the defects and Windows/Linux/macOS expectations that run found
affects: [phase-2-verification, 03-*]

actuals:
  tokens: 26500
  tasks: 3
  commits: 10

plan_head_before: cdce5ed921eb590816b0eace575ddea69b187be7
plan_head_after: 0b3a460a52b4498a68e06c559ea4470eaf49b6bf

tech-stack:
  added: []
  patterns:
    - "gates are scripts that exit 1 and are also unit tested through an injected fetch, so the failing path runs offline"
    - "an independent audit (git ls-files, check-attr, lstat, first 8 KB) is compared with what the product indexed, instead of trusting the product's own counts"
    - "a platform hash is recorded only from a value the CI job for that platform printed"

key-files:
  created:
    - scripts/corpus-gates.ts
    - scripts/corpus-gates.test.ts
    - scripts/freshness-gate.ts
    - scripts/freshness-gate.test.ts
    - .github/workflows/nightly.yml
  modified:
    - .github/workflows/ci.yml
    - scripts/ci-config.test.ts
    - modules/typescript/grammar.lock
    - modules/javascript/grammar.lock
    - README.md
    - package.json
    - src/indexer/parcel-source.ts
    - src/indexer/parcel-source.test.ts
    - src/host/route.ts
    - src/source-tree/real.ts
    - src/source-tree/contract.ts
    - src/test-kit/git-repo.ts
    - scripts/corpus-fetch.ts
    - src/fact-store/auto-vacuum.test.ts
    - src/host/host.test.ts
    - src/host/history.test.ts
    - src/indexer/worktree.test.ts
    - src/query/status.test.ts
    - src/tenant/overlay.test.ts

key-decisions:
  - "The corpus gate audits the source set itself (git ls-files, check-attr, lstat, first 8 KB) and compares the result with the store, so the accounting identity does not rest on the product's own counters"
  - "The gate measures the store at its default size after two builds and does not compact first, so the 50 MB figure is what a user gets"
  - "Windows grammar hashes were recorded from a new CI step that prints every module's rebuild hash, because grammar:verify refuses a missing platform entry before it builds and so prints no hash"
  - "The Linux watcher defect is fixed in the owning module (parcel-source) with a second subscription on worktrees/, not by changing the test"
  - "The wall-clock assertion of the compact slice test was not loosened after one Windows outlier; it is reported below as an open item"

requirements-completed: [LNG-02, LNG-05, STO-05, STO-06, IDX-01]

coverage:
  - id: D1
    description: "Pinned-corpus build gate: gsd-core at its corpus SHA indexed through the composed Host, source set audited against git, accounting identity, per-module parse-error ratio at most 0.5 percent, second build parses zero files, database at most 50 MB"
    requirement: "LNG-02, LNG-05, STO-05"
    verification:
      - kind: unit
        ref: "scripts/corpus-gates.test.ts (16 cases)"
        status: pass
      - kind: integration
        ref: "node scripts/corpus-gates.ts, locally and in the gates job of run 39048213960 on ubuntu, macos and windows"
        status: pass
    human_judgment: false
  - id: D2
    description: "Freshness gate with nearest-rank percentiles, approved bounds 3000 ms on pull requests and 1000 ms nightly"
    requirement: "IDX-01"
    verification:
      - kind: unit
        ref: "scripts/freshness-gate.test.ts (9 cases)"
        status: pass
      - kind: integration
        ref: "node scripts/freshness-gate.ts --saves 30 --max-ms 3000 in the gates job on three operating systems"
        status: pass
    human_judgment: false
  - id: D3
    description: "ci.yml gates job and nightly.yml under the workflow rules (pinned SHAs, read-only, ignore-scripts); ROADMAP criterion 4 (20,000 edits, SIGKILL, lease, takeover) runs on all three operating systems"
    requirement: "STO-06"
    verification:
      - kind: unit
        ref: "scripts/ci-config.test.ts (29 cases)"
        status: pass
      - kind: integration
        ref: "ci.yml run 39048213960: Gates and Test jobs, all 13 jobs success"
        status: pass
    human_judgment: false
  - id: D4
    description: "win32-x64 grammar hashes recorded from the Windows job's printed value; the next run verifies them"
    verification:
      - kind: integration
        ref: "Grammar rebuild (windows-latest) in run 39048213960: verified win32-x64 rebuild sha256 for typescript and javascript"
        status: pass
    human_judgment: false
  - id: D5
    description: "The nightly workflow has not run remotely: workflow_dispatch needs the file on the default branch, and it is scheduled, not triggered by a push to ci/**"
    verification: []
    human_judgment: true
    rationale: "its first real run happens after the phase merges; the same commands were run in the gates job at the pull request bound and locally at the strict bound (30 saves p99 275 ms), but the 100 save strict run on hosted runners is unobserved"

duration: 122min
completed: 2026-10-17
status: complete
---

# Phase 2 Plan 26: Measured gates and the first three-OS run Summary

**The pinned gsd-core corpus builds to 1,689 indexed files and a 37.7 MB store with 0.43 percent parse-error files, a second build parses nothing, save-to-find p99 is 264, 293 and 837 ms on Linux, macOS and Windows, and all 13 jobs of CI run 39048213960 are green after the run found and fixed one real watcher defect, two path defects, one orphaned-process defect and a dozen platform assumptions in tests.**

## Performance

- **Duration:** about 122 min of work (the live CI runs took most of it)
- **Started:** 2026-10-17T14:50Z (approximate, from the worktree creation time)
- **Completed:** 2026-10-17T16:55Z
- **Tasks:** 3 (task 1 is the tracer)
- **Files modified:** 24 (5 created)

## Accomplishments

- `scripts/corpus-gates.ts` fetches the pinned corpus into a temp directory, builds it twice through `composeHost`, and checks it against an independent audit of git's file list. It runs offline in its unit test through an injected fetch, including the failing path (exit 1 with the check named).
- `scripts/freshness-gate.ts` measures save-to-find through the real Host and watcher and prints p50, p95 and p99 by nearest rank.
- `ci.yml` has a `gates` job on three operating systems; `nightly.yml` carries the strict bound. Both pass `scripts/ci-config.test.ts`, which now also pins the order of the four gate commands and both approved bounds.
- The first three-OS run exposed real problems. They are fixed and run 39048213960 is green on every job.

## Task Commits

1. **Task 1 (tracer): pinned-corpus build gate** - `79b45dd` (feat). Tracer verify re-run end to end (unit test, typecheck, lint, then the real corpus), then expansion.
2. **Task 2: freshness gate, gates job, nightly workflow, README quickstart** - `960d605` (ci)
3. **Task 3: iterate to green** (see the CI log below):
   - `97fcd5e` ci: print each grammar rebuild hash before grammar:verify judges it
   - `1674d08` fix: record win32-x64 grammar hashes from the Windows CI run
   - `3134522` test: temporary diagnostic of linked-worktree HEAD events (removed in `3c014a5`)
   - `3c014a5` fix: renew the git watch when a worktree appears (**wrong fix**, superseded)
   - `1e938da` fix: Windows CI findings in tests and path handling
   - `c1a5390` test: the real-watcher test primes the watcher and always releases it
   - `73119b6` fix: watch worktrees/ with its own subscription; keep git maintenance out of test repositories
   - `0b3a460` fix: the Host waits for both git runs before it answers a repository selection

**Plan metadata:** the commit that adds this file (docs: complete plan). The branch `ci/phase-2` ends at `0b3a460`; this summary commit is not pushed, so the last run on the branch is the green one.

## CI evidence

Branch `ci/phase-2` on open-gsd/gsd-atlas, pushed four times (never to any other ref, no force, no PR). Four runs:

| Run | Head | Result | What it showed |
|-----|------|--------|----------------|
| [39043411164](https://github.com/open-gsd/gsd-atlas/actions/runs/39043411164) | `97fcd5e` | cancelled by the next push | Gates green on all three OS on the first run. Static green. Grammar green on ubuntu and macos; Windows failed as expected (no win32-x64 entry) and its new report step printed both hashes. Tests: macOS green; ubuntu failed on both Node versions (one test); Windows partial log |
| [39044418612](https://github.com/open-gsd/gsd-atlas/actions/runs/39044418612) | `3134522` | failure | Windows grammar green with the recorded hashes. ubuntu: same one test, plus the diagnostic output. Windows Node 24: 18 failures. Windows Node 26: no output for 18 minutes after the real-watcher test failed, cancelled at the 30 minute job timeout |
| [39046850156](https://github.com/open-gsd/gsd-atlas/actions/runs/39046850156) | `c1a5390` | failure | Windows Node 26 green. Windows Node 24: 2 failures. macOS Node 24: 2 failures. ubuntu: the same test still failing (the first fix was wrong) |
| [**39048213960**](https://github.com/open-gsd/gsd-atlas/actions/runs/39048213960) | `0b3a460` | **success, 13 of 13 jobs** | see the table below |

### Run 39048213960, job results per OS

| Job | ubuntu-latest | macos-latest | windows-latest |
|-----|---------------|--------------|----------------|
| Static checks (ubuntu) | success | | |
| Test, Node 24.16.0 | success (4.3 min) | success (1.1 min) | success (16.1 min) |
| Test, Node 26 | success (4.5 min) | success (1.1 min) | success (13.8 min) |
| Grammar rebuild | success | success | success (verified win32-x64 for typescript `90981e0e...bac0`, javascript `45d6d221...c1e7`, toy `cba9dce1...8853`) |
| Gates | success (1.5 min) | success (0.9 min, after a 39 minute queue wait for a macOS runner) | success (11.6 min) |

No functional difference between Node 24.16.0 and Node 26 appeared in the final run. The Windows Node 26 job that was cancelled in run 39044418612 was a hang caused by a leaked watcher (see failure 9), not by Node 26.

### Gate figures per OS (run 39048213960, `gates` job)

| Figure | ubuntu | macos | windows |
|--------|--------|-------|---------|
| files git lists / indexed / unclaimed | 3976 / 1689 / 2287 | same | same |
| first build (1686 parsed, 3 linked) | 21,049 ms | 9,030 ms | 195,690 ms |
| second build (0 parsed, 1689 linked) | 735 ms | 1,092 ms | 2,107 ms |
| parse-error files, javascript (limit 0.50 percent) | 6 of 1403 = 0.43% | same | same |
| parse-error files, typescript | 0 of 283 = 0.00% | same | same |
| store bytes (limit 52,428,800) | 37,474,304 | 37,666,816 | 37,666,816 |
| size gate, 20,000 edits: fresh / edited bytes, ratio (limit 1.25), seconds | 651,264 / 651,264, 1.0000, 25.1 | same bytes, 1.0000, 8.0 | same bytes, 1.0000, 390.3 |
| freshness, 30 saves: p50 / p95 / p99 (bound 3000 ms) | 197 / 230 / 264 ms | 248 / 291 / 293 ms | 415 / 597 / 837 ms |
| recall step (90 percent per construct) | pass | pass | pass |

Locally (macOS arm64): corpus gates exit 0 (37.79 MB, 1689 files), recall corpus every applicable construct 100 percent (typescript sample 274 files, javascript sample 300 files), size gate ratio 1.0000, freshness strict bound 30 saves p50 231 ms p95 274 ms p99 275 ms against 1000 ms.

## Each CI failure: cause and fix

1. **Windows grammar job, no hash to record** (run 1). `grammar:verify` refuses a platform with no `wasm.platforms` entry before it builds, so the log carried no computed hash (the plan expected one). Fix (deviation, below): a "Report rebuild hashes" step in the grammar job prints every module's rebuild sha256 on each OS. The Windows values came from that step's output in run 1; `1674d08` records them; run 2 onward verified them (two builds equal each other and the entry).
2. **Linux, parcel-source test "delivers head for a checkout in the main and in a linked worktree" timed out, both Node versions, every run.** Genuine product defect. A temporary diagnostic test printed raw @parcel/watcher events: with a short gap after `git worktree add` the linked worktree's HEAD events arrived (3 of 3), with a 3 second gap they did not arrive at all (0 of 3, after the single `create worktrees`). Reading `InotifyBackend.cc` in the installed package: a newly created directory is watched without scanning what is already inside, and `git worktree add` creates `worktrees/` and `worktrees/NAME/` back to back, so `worktrees/NAME/` is never watched. My first fix (`3c014a5`, renew the subscription on the git directory) could not work: `Watcher.cc` shares one watcher per directory and ignore list, so a second subscribe returns the same stale watcher. The test still failed on both Node versions in run 3. Second fix (`73119b6`): a worktrees event drops and reopens a second subscription on `worktrees/` itself (dropping first, so the next subscribe scans afresh), with scripted-watcher tests for the order, a missing directory, coalescing, failure and stop. Run 4: both ubuntu jobs green. The diagnostic was removed in the first fix commit.
3. **Windows: temp directory removed before the open database in it was closed (EPERM)** in `auto-vacuum.test`, and twice in `host.test`. `t.after` hooks run in registration order; the removal was registered first. Tests changed to close first.
4. **Windows: overlay slow-parse test EPERM.** The likely cause (not observed directly): the test moved its fake clock before the parse was outstanding and ended while the abandoned parse's hashing `git` process was still running in the repository. It now waits for the parse to be outstanding, and for the abandoned parse to finish. It passed in the next two runs.
5. **Windows: `history.test` EBUSY** reading the SQLite wal-index (`-shm`), which Windows will not read while a database is open. The fingerprint lists it by name only.
6. **Windows: `worktree.test` EPERM** writing a worktree's `.git` file. Git marks `.git` hidden on Windows and a hidden file cannot be opened for writing. The tests remove it first.
7. **Windows: `status.test`** looked for the repository root in JSON text, where backslashes are doubled. It compares the escaped form.
8. **Windows: six `SourceTree contract` cases failed** because the fixture `late/nul.ts` is a reserved device name on Windows and git cannot add it. Renamed `late/nulbyte.ts`.
9. **Windows: real-watcher test "delivers a change for a created, modified, renamed-over and deleted file..." timed out in 2 of 3 runs, and because it never stopped its subscription the test process stayed alive: Node 26 produced no output for 18 minutes and hit the 30 minute job timeout.** The failing step is unknown (the run was cancelled before the failure details printed). The test now writes a probe file until the watcher reports one before it starts the sequence, and stops the subscription in `t.after` before removing the directory even when an assertion fails. It passed in the next two runs. This is a hypothesis (the first write after `subscribe` resolves can be missed on Windows), not a proven cause; the production path is protected by the start-up Reconcile that follows every subscription.
10. **Windows product defect: `Source Tree worktrees()` returned a prunable (deleted) worktree's path with the forward slashes git prints** while every other entry has native separators. `path.normalize` fixes it; the existing source-tree test is the regression test (it failed on Windows).
11. **Windows: `corpus-fetch` returned a checkout path under the 8.3 short name `RUNNER~1`** because it used `fs.realpathSync` instead of `.native`. Fixed in the script; its test is the regression test.
12. **Windows product defect: `resolveRepository` used `Promise.all` over `identity()` and `worktrees()`**, answered `not_a_repo` as soon as the first rejected, and left the other `git` process running in that directory. That is the likely reason the not_a_repo test could not remove its directory (EPERM, one occurrence in run 3; the cause was not observed directly). Leaving work running after the answer is wrong either way, so `Promise.allSettled` now lets both finish. The test passed in run 4.
13. **macOS: two tests compared a repository listing taken right after a commit with one taken later and saw `.git/objects/maintenance.lock` come and go.** A current git runs `maintenance run --auto` in the background after a commit. The test kit now sets `maintenance.auto=false` and `gc.auto=0` in every test repository.

## Files Created/Modified

See the frontmatter. Source changes outside scripts and workflows: `src/indexer/parcel-source.ts` (item 2), `src/host/route.ts` (12), `src/source-tree/real.ts` (10); test infrastructure: `src/test-kit/git-repo.ts` (13), `src/source-tree/contract.ts` (8).

## Decisions Made

See `key-decisions`. In addition: the gates job keeps `timeout-minutes: 60` and the test job keeps 30. Windows Node 24 used 16 minutes and Node 26 14 minutes in the green run, so the 30 minute test timeout has about a factor of two of room, but a Windows runner can be much slower than on another day (the same corpus build took 91 seconds in run 1 and 196 seconds in run 4).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The Windows grammar job could not produce a hash to record**
- **Found during:** Task 3
- **Issue:** the plan expects the first Windows `grammar:verify` run to fail with the computed hash; it fails before building and prints none.
- **Fix:** added a "Report rebuild hashes" step (`node scripts/grammar-build.ts --report`) before `grammar:verify` in the grammar job, with a `ci-config` test that it comes first. The hashes recorded are the values that step printed on windows-latest; `wasm.sha256` and the committed wasm are untouched.
- **Files:** `.github/workflows/ci.yml`, `scripts/ci-config.test.ts`, both `grammar.lock` files
- **Commits:** `97fcd5e`, `1674d08`

**2. [Rule 1 - Bug] Linked worktree HEAD events missed on Linux** (item 2 above) - `src/indexer/parcel-source.ts`, tests in `parcel-source.test.ts` - `73119b6`. A first fix (`3c014a5`) was wrong and is superseded; both are in the history.

**3. [Rule 1 - Bug] Three path and process defects on Windows** (items 10, 11, 12) - `src/source-tree/real.ts`, `scripts/corpus-fetch.ts`, `src/host/route.ts` - `1e938da`, `0b3a460`.

**4. [Rule 1 - Bug] Test assumptions that are false on Windows or macOS** (items 3 to 9, 13) - tests and the test kit only. None of these tests was skipped, loosened or made platform-conditional; the shm exclusion in the history test is the one narrowing, and is stated in the code.

**Total deviations:** 4 groups (1 blocking CI-setup issue, 3 groups of defects), 10 commits in all. **Impact:** the plan's third task is met by run 39048213960; the product gained three real fixes (the Linux watcher, the prunable path, the orphaned git process).

### Process notes

- The commit ledger file (`plan-head-before`) could not be written with the file tool inside the worktree; it was written with a shell redirect. `plan_head_before` is the base the orchestrator specified, `cdce5ed`.
- The pushes, in order: `97fcd5e` (first, new branch), `3134522`, `c1a5390`, `0b3a460`. The second push cancelled run 1 while its Windows test jobs were still running (the workflow's concurrency group cancels superseded runs), so the failure details of that Windows run were never printed; that is why item 9 has no failing step. Runs 2 and 3 had finished before the following push.

## Open items (honest, not hidden)

1. **A wall-clock assertion flaked once on Windows.** `src/fact-store/maintain.test.ts` "slice: free pages are returned in bounded slices..." (better-sqlite3) asserted each compaction slice under 1,000 ms (five times the approved 200 ms) and measured 7,202 ms in run 39046850156 (Windows, Node 24). It passed in runs 2 and 4 and on every other platform. I did not loosen it. The cause is unproven: the first slice of 64 pages also pays for an automatic WAL checkpoint, and a hosted Windows disk can stall. If it recurs, either the product should bound that first slice, or the test should assert on page counts instead of wall time. **A product-level answer is a decision for the owner of plan 02-18.**
2. **The nightly workflow is unobserved.** `workflow_dispatch` needs the file on the default branch, and the schedule has not fired. Its commands ran in the `gates` job (at 3000 ms) and locally at 1000 ms.
3. **Windows is an order of magnitude slower than macOS and Linux on the heaviest steps** in this CI (first corpus build 196 s versus 9 to 21 s; 20,000 edit size gate 390 s versus 8 to 25 s). Nothing failed because of it in the final run, but the 30 minute test timeout is not generous if the runner has a slow day.
4. **Real-watcher Windows test (item 9)** is protected, not explained.

## Authentication Gates

None. `gh` was already authenticated with the `workflow` scope and a plain `git push` to the new branch worked.

## Known Stubs

None.

## Threat Flags

None. The only new network use is the corpus fetch the plan's threat model (T-02-94 to T-02-97) already covers; the workflows keep read-only permissions, pinned action SHAs and `npm ci --ignore-scripts`, which `scripts/ci-config.test.ts` enforces on both files.

## Self-Check: PASSED

- Created files exist: `scripts/corpus-gates.ts`, `scripts/corpus-gates.test.ts`, `scripts/freshness-gate.ts`, `scripts/freshness-gate.test.ts`, `.github/workflows/nightly.yml`.
- All ten task commits are ancestors of HEAD (`git log cdce5ed..HEAD` lists them).
- Acceptance: `ci.yml` has the `gates` job with `scripts/recall.ts --corpus gsd-core`, `scripts/corpus-gates.ts`, `scripts/size-gate.ts`, `scripts/freshness-gate.ts`; `nightly.yml` has `schedule:` and `workflow_dispatch:`; neither workflow contains `npm install`; `scripts/package.test.ts` passes; the latest run on `ci/phase-2` (`gh run list --branch ci/phase-2 --limit 1`) is `completed` / `success` at `0b3a460`; both grammar locks hold the win32-x64 value printed by the Windows job; no threshold in `ci.yml` or `nightly.yml` is above the approved constants (3000 and 1000 ms).
- Local: `npm test` 2,240 of 2,240 pass, typecheck, lint and schema:check clean; corpus gates, recall corpus and size gate exit 0.
