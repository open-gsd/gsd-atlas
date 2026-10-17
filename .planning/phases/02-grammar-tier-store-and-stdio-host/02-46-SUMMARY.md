---
phase: 02-grammar-tier-store-and-stdio-host
plan: 46
subsystem: indexer, source-tree, command-runner, ci-diagnostics
tags: [freshness, windows, git-spawns, ignore-oracle, check-attr, trace, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "plans 02-33, 02-38, 02-42 (git option allowlist, git deadlines, freshness gates)"
provides:
  - "SourceTree.unignoredPaths: one pathspec-free ls-files listing filtered in process by exact name"
  - "SourceTree.pathAttributes and SourceSetOptions.attributes: check-attr overlaps the clean-filter enumeration"
  - "opt-in spawn trace preload, its summary tool, and Windows-only non-failing CI steps"
affects: [indexer, source-tree, command-runner, ci, adr-4, adr-9]
tech-stack:
  added: []
  patterns:
    - "sequential spawn stages counted without a clock by a result-withholding run gate (src/test-kit/run-gate.ts)"
    - "ignore verdict from one fixed git listing filtered by exact string equality (no watcher byte reaches git)"
key-files:
  created:
    - src/indexer/ignore.test.ts
    - src/indexer/spawn-count.test.ts
    - src/indexer/spawn-stages.test.ts
    - src/source-tree/unignored.test.ts
    - src/source-tree/spawn-stages.test.ts
    - src/test-kit/run-gate.ts
    - scripts/diagnostics/trace-spawns.mjs
    - scripts/diagnostics/trace-summary.ts
    - scripts/diagnostics/trace-summary.test.ts
    - scripts/diagnostics/trace-spawns.test.ts
    - scripts/diagnostics/fixtures/trace-sample.log
  modified:
    - src/command-runner/decide.ts
    - src/command-runner/decide.test.ts
    - src/command-runner/git-allowlist.test.ts
    - src/source-tree/types.ts
    - src/source-tree/real.ts
    - src/source-tree/fake.ts
    - src/source-tree/contract.ts
    - src/source-tree/source-set.ts
    - src/source-tree/validate.ts
    - src/indexer/ignore.ts
    - src/indexer/process.ts
    - src/indexer/harness.test.ts
    - src/indexer/indexer.test.ts
    - src/test-kit/index.ts
    - .github/workflows/ci.yml
    - scripts/ci-config.test.ts
    - docs/adr/4-command-runner.md
    - docs/adr/9-tenant-composition.md
    - docs/adr/README.md
    - scripts/adr.test.ts
key-decisions:
  - "The ignore check is ONE pathspec-free `ls-files -z --cached --others --exclude-standard`, filtered in process by exact name; the gate gains only the token --cached (git ls-files has no --pathspec-from-file, verified)"
  - "check-attr starts before hashPaths is awaited; config and check-attr run together, then hash-object; the filter list is still enumerated on every hash"
  - "No bound, debounce, timeout or size constant was added or changed"
requirements-completed: [IDX-01, IDX-04, IDX-02, STO-09, LNG-05]
status: complete
duration: one session
completed: 2026-10-17
commits: 4
plan_head_before: d83699d183f52fac3389ad335c5fbc330387e04b
plan_head_after: e24526a599d66f86a28d7cb5387d9a6f11af0cfe
actuals:
  tokens: 29951
  tasks: 5
  commits: 4
---

# Phase 2 Plan 46: Windows freshness - fewer sequential git spawns per save Summary

**One pathspec-free `ls-files` listing replaces the whole-tree snapshot as the ignore oracle, `check-attr` runs beside the clean-filter enumeration, and an opt-in spawn trace with Windows-only, never-failing CI steps will measure the rest on the next hosted run.**

## What changed

| Save kind | Spawns before | Sequential stages before | Spawns after | Sequential stages after |
|-----------|--------------:|-------------------------:|-------------:|------------------------:|
| edit of a known file | 3 (`config`, `hash-object`, `check-attr`) | 3 | 3 | 2 (`config` with `check-attr`, then `hash-object`) |
| new file | 7 (`config`, `ls-files`, `ls-files`, `hash-object`, `config`, `hash-object`, `check-attr`) | 7 | 4 (`ls-files`, then `config` with `check-attr`, then `hash-object`) | 3 |
| deleted file | 0 | 0 | 0 | 0 |

The "before" rows are the red results recorded before the change: the counting-runner case for a new file failed with `7 !== 4`
and the sequence `config,ls-files,ls-files,hash-object,config,hash-object,check-attr`; the edit case passed at 3 with
`config,hash-object,check-attr`; the stage case for an edit reported `[[config],[hash-object],[check-attr]]` (3 stages) against the expected 2.
After Task 1 alone a new file was 4 spawns in 4 stages; Task 2 made it 4 in 3.

## Expectations and evidence

Local timings, one macOS machine (18 cores, git 2.54.0, spawn cost about 7 ms), `node scripts/freshness-gate.ts --saves 100 --max-ms 1000`, saves alternating edit and add. Before = the base commit `d83699d` in a scratch worktree; after = this branch.

| Run | Before p50 / p95 / p99 (ms) | After p50 / p95 / p99 (ms) |
|-----|-----------------------------|----------------------------|
| 1 | 228 / 268 / 271 | 229 / 238 / 266 |
| 2 | 228 / 268 / 275 | 228 / 232 / 234 |
| 3 | 227 / 266 / 269 | 228 / 231 / 232 |

The median does not move (it is the 100 ms debounce plus the 25 ms poll plus the pipeline, dominated by something that is not a spawn on macOS); the tail tightens from about 268 / 272 to about 232 / 234. Raw gate lines:

```
before: freshness-gate: saves 100 files 200 watch native p50 228 ms p95 268 ms p99 271 ms max 1000 ms (nearest rank) OK
before: freshness-gate: saves 100 files 200 watch native p50 228 ms p95 268 ms p99 275 ms max 1000 ms (nearest rank) OK
before: freshness-gate: saves 100 files 200 watch native p50 227 ms p95 266 ms p99 269 ms max 1000 ms (nearest rank) OK
after:  freshness-gate: saves 100 files 200 watch native p50 229 ms p95 238 ms p99 266 ms max 1000 ms (nearest rank) OK
after:  freshness-gate: saves 100 files 200 watch native p50 228 ms p95 232 ms p99 234 ms max 1000 ms (nearest rank) OK
after:  freshness-gate: saves 100 files 200 watch native p50 228 ms p95 231 ms p99 232 ms max 1000 ms (nearest rank) OK
size-gate: files 300 symbols 8 edits 20000 maintain-every 200 freshBytes 655360 idleBytes 655360 idleRatio 1.0000 max 1.25 settledBytes 655360 settledRatio 1.0000 vacuums 100 longestMaintainMs 13.8 dbstat present maintainRuns 101 seconds 5.8 OK
```

The investigation's model predicts a new file at roughly `100 + 3 x s + 60` ms and an edit at `100 + 2 x s + 60` (s = spawn cost), so hosted Windows, with s = 35 to 160 ms, is expected to land below the 1000 ms nightly bound in the regimes observed. That is a prediction. **Hosted Windows milliseconds come only from the next hosted CI run of the unchanged `gates` job and its new diagnostic step; this plan claims nothing about them.**

Local trace of the gate with the preload (`GSD_ATLAS_TRACE_FILE=<scratch>/trace.log node --import ./scripts/diagnostics/trace-spawns.mjs scripts/freshness-gate.ts --saves 30 --max-ms 3000`, then `node scripts/diagnostics/trace-summary.ts <trace>`):

```
freshness-gate: saves 30 files 200 watch native p50 229 ms p95 232 ms p99 235 ms max 3000 ms (nearest rank) OK
spawns by git subcommand: count median p95 max (ms, nearest rank)
check-attr 33 7.6 8.8 8.8
config 33 7.0 7.9 8.0
hash-object 33 6.7 8.3 8.3
ls-files 19 7.8 8.4 8.4
rev-list 180 8.0 8.6 9.7
rev-parse 180 6.6 7.1 8.3
worktree 182 7.3 7.9 8.5
saves by kind: saves median-spawns median-write-to-event-ms median-write-to-commit-ms
add 15 22 71.1 98.8
edit 15 21 69.2 98.4
commit statements: 1003 median 0.00 ms max 0.65 ms
```

Reading it: the indexer's own spawns per save are the `config`, `check-attr`, `hash-object` and (for a new file) `ls-files` rows; most of the median 21 to 22 spawns per save are the gate's poll (`rev-list`, `rev-parse`, `worktree`, 6 per `code_find` identity check), the deferred investigation options 3 and 5. On this machine a spawn costs 6.5 to 8 ms. The hosted Windows run will show whether that cost, the event delay or the commit dominates there.

## Accomplishments

- **Task 1 (tracer, `b5fb115`):** `SourceTree.unignoredPaths` (real, fake, contract), the `--cached` token in `decide.ts`, `PathFilter.keep` rewritten on it (a symbolic link, a directory or a gitlink directory is dropped with no git run; a failed listing leaves the memory untouched). Installed-git probes in `git-allowlist.test.ts` run the exact listing spec and every `ls-files` shape Source Tree sends through the production runner. `git --version` printed by the probe: `git version 2.54.0 (Apple Git-157)`. `plan_head_before` is `d83699d183f52fac3389ad335c5fbc330387e04b`; `src/command-runner/git-spec.ts` is byte-identical to it.
- **Task 2 (`a8904e9`):** `SourceTree.pathAttributes`, `SourceSetOptions.attributes`, and `prepare` starting the attribute query before awaiting `hashPaths`, with the error semantics of the old flow (config failure reported first and the abandoned query's rejection handled; check-attr failure reported when something was hashed; ignored when nothing was).
- **Task 3 (`a3eb994`):** `trace-spawns.mjs` (opt-in `--import` preload), `trace-summary.ts`, the Windows-only `continue-on-error` steps in `ci.yml` with `actions/upload-artifact` pinned to `cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2` (SHA re-read from `gh api repos/actions/upload-artifact/git/ref/tags/v7.0.2`, type `commit`), and the `[3000, 3000]` freshness-bound assertion.
- **Task 4 (`e24526a`):** two dated, additive amendments (command-runner and tenant-composition), README log lines, `adr.test.ts` entries. The diff of `docs/adr` is insertions only.
- **Task 5:** gates re-run, before and after numbers above.

## Mutation checks (acceptance criteria)

| Mutation | Result |
|----------|--------|
| remove `--others` from the listing in `real.ts` | `categories`, `parity with the snapshot`, `exact names, no patterns` fail |
| remove `--cached` from the listing | `categories`, `parity with the snapshot`, `gitlink and nested repository parity`, `exact names, no patterns` and both case-folding cases fail |
| append the first requested name to the listing spec (no `--`, which the gate would deny first; a positional name passes the gate) | the 500-path case (`its spec is the one a single path gets`), `exact names, no patterns`, `categories`, `parity with the snapshot`, the `.gitignore` case and the `keep` category case fail |
| start `pathAttributes` after `hashPaths` is awaited in `process.ts` | `edit is two stages` and `new file is three stages` fail (they report three and four stages) |
| `trace-spawns.mjs` puts all arguments in the label | `records only command and subcommand` fails |
| `trace-spawns.mjs` skips its writable probe | `unwritable file is harmless` and the empty-file case fail |
| `trace-summary.ts` uses floor instead of ceil for the rank | `pins the summary of the fixture trace` and `malformed lines are skipped` fail |
| `ci.yml`: drop `continue-on-error` from the traced step; make the normal freshness gate load the preload; drop the Windows-only `if` from the upload | `diagnostic steps are continue-on-error` / `no normal gate loads the preload` / `diagnostic steps are windows-only` fail respectively |

`grep -v '^[[:space:]]*\(//\|/\*\|\*\)' src/indexer/ignore.ts | grep -c 'snapshot('` equivalent (comment lines excluded): **0**.

## Deviations from Plan

### Auto-fixed / structural

**1. [Rule 3 - Blocking] Stage and failure-injection tests live in `src/indexer/spawn-stages.test.ts`, not only in `src/source-tree/spawn-stages.test.ts`**
- **Found during:** Task 2
- **Issue:** the boundary lint (`deepImport`) forbids a `source-tree` test from importing the Indexer harness, and the failure-injection cases need `processBatch` (`prepare`) to prove the error semantics and to make the `process.ts` mutation visible.
- **Fix:** the Indexer-driven cases (`edit is two stages`, `new file is three stages`, `config failure is reported first`, `check-attr failure is reported`, `both fail`, `check-attr failure with nothing hashed is ignored`, `filter list is never cached`) are in `src/indexer/spawn-stages.test.ts`; `src/source-tree/spawn-stages.test.ts` holds the tree-level versions (prepare-equivalent calls) of the stage cases, the `attributes` cases and a no-cache case.
- **Commit:** `a8904e9`

**2. [Rule 3 - Blocking] `keep`-level case-folding cases live in `src/indexer/ignore.test.ts`**
- **Issue:** `createPathFilter` is not exported through `indexer/index.ts`, so `unignored.test.ts` (source-tree) cannot call `keep`.
- **Fix:** `unignored.test.ts` holds the tree-level cases (`case folding on a case-folding file system`, `case folding with a different index spelling`); `ignore.test.ts` holds the same two titles at the `keep` level. The real-file-system case ran (not skipped) on this macOS machine; it reports a skip with the plan's reason where the file system does not fold case.
- **Commit:** `b5fb115`

**3. [Rule 2 - Missing critical functionality] `keep` never lets a non-repo-relative name reject the whole batch**
- **Issue:** `unignoredPaths` throws `invalid_argument` for such a name, which would have failed every path of a batch where the old snapshot oracle simply did not list it.
- **Fix:** `ignore.ts` classifies a name that fails `isRepoRelative` as "never hashed" (dropped, remembered, no git), which is what the old oracle did.
- **Commit:** `b5fb115`

**4. [Rule 1 - existing test encoded the old oracle]** `indexer.test.ts` asserted `log.snapshots === snapshotsAfterBuild + 1` ("one snapshot decided that the unknown path is ignored"). It now asserts that no snapshot is taken and that exactly one `unignoredPaths` call was made, and that the second batch is answered from the memory. The `TreeLog` of `harness.test.ts` and `indexer.test.ts` gained `unignored`; both `recordingTree` wrappers gained `unignoredPaths` and `pathAttributes`; `makeWorld` gained `wrapRunner`.

**5. [Rule 3] Helpers not in the plan's file list:** `src/test-kit/run-gate.ts` (a generic, structurally typed gate that withholds results to count sequential stages without a clock; test-kit may import only `facts`, so it names no CommandRunner type), `assertRepoRelative` in `src/source-tree/validate.ts`, and `PathAttributes` moved to `types.ts` (re-exported from `source-set.ts`).

**6. Task 3 order, stated rather than hidden:** the preload and the summary tool were written before their tests (the summary's expected figures in the test are hand-computed from the fixture, and every test was then shown to fail under a targeted mutation, listed above). Two refinements came from running the real trace: saves are counted only after the first spawn (the gate writes its 200-file repository before the product starts anything, which had counted as 200 saves), and a save's commit time is the first `COMMIT` after the first watcher event of that save (an unrelated commit landed between the write and the event). The CI step prints the summary of the gate run only.

### Not done / limits

- The ledger item "Limit the listing to the requested paths" remains deferred as the plan says; hosted Windows cost of the O(tree) listing is unmeasured until the trace runs there.
- `plan_head_after` above is the head after the four task commits; the SUMMARY commit follows it.

## Authentication gates

None.

## Known Stubs

None.

## Threat Flags

None. The tracer is opt-in, writes one file the variable names, records a closed vocabulary (executable base name, git subcommand word, event types and counts, SQL verbs, durations) and is scanned for in `src` and `package.json` (it is referenced by neither).

## Constants

No timeout-, size- or threshold-shaped constant was added or changed. `git diff d83699d..HEAD -- src/indexer/defaults.ts src/tenant/defaults.ts src/command-runner/git-spec.ts scripts/freshness-gate.ts .github/workflows/nightly.yml` is empty. The normal freshness step of `ci.yml` keeps `--saves 30 --max-ms 3000`. The only numeric literals in the new code are the ones the plan names: the trace's 0.3 ms SQL logging floor, and `30` / `3000` in the diagnostic step (the existing gate values); the run gate's event-loop patience (25 passes) is a count of loop turns in a test helper, not a duration.

## Verification

All on the final tree (head `e24526a`), macOS arm64, Node 26, git 2.54.0:

| Command | Result |
|---------|--------|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` | exit 0: 2678 tests, 439 suites, 2678 pass, 0 fail, 0 skipped (includes `scripts/ci-config.test.ts`, `scripts/adr.test.ts`, the new `scripts/diagnostics` tests and the real-file-system case-folding cases, which ran) |
| `npm run schema:check` | exit 0 (`schemas/atlas-lang.schema.json is current.`) |
| `npm run grammar:verify` | exit 0 (javascript, typescript, atlas_toy: rebuild sha256 equals the committed one) |
| `node --test scripts/ci-config.test.ts` | pass (43 tests with `freshness-gate.test.ts`) |
| `node scripts/freshness-gate.ts --saves 100 --max-ms 1000` (x3) | OK, p99 266 / 234 / 232 ms |
| `node scripts/size-gate.ts` | OK |

The task verify commands (decide, git-allowlist, unignored, source-tree, ignore, spawn-count, indexer, reconcile, freshness: 333 tests; spawn-stages, hostile-repo, git-read: 208 tests; trace-summary, trace-spawns, ci-config, freshness-gate: 57 tests; adr: 39 tests) all passed, each followed by `npm run typecheck && npm run lint`. The hosted-CI-only parts (the Windows steps, the artifact upload on a real runner, the Windows file system cases) cannot run here and are first exercised by the next hosted run.

## Self-Check: PASSED

All created files exist; commits `b5fb115`, `a8904e9`, `a3eb994`, `e24526a` are ancestors of HEAD.
