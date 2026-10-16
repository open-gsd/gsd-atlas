---
phase: 01-foundations-and-walking-skeleton
plan: 13
subsystem: source-tree
tags: [git, command-runner, source-tree, hostile-repo, filter-drivers, fsmonitor, contract-suite, test-kit]

requires:
  - phase: 01-09
    provides: CommandRunner seam (decide, real runner, recording fake, scrubEnv)
  - phase: 01-04
    provides: Diagnostic kernel type and the test-kit makeTempDir helper
provides:
  - "gitSpec: the only builder of git CommandSpecs; prepends -C, core.fsmonitor=false, core.hooksPath=<null device>, core.quotepath=off and neutralises EVERY configured filter driver (no allowlist); pins GIT_OPTIONAL_LOCKS=0 and GIT_TERMINAL_PROMPT=0"
  - "neutraliseFilters, parseFilterNames, listFilterNames (name-only config read, exit 1 with empty output means none)"
  - "SourceTree seam: snapshot, hasObject, read, identity; real implementation through the CommandRunner only (four git starts, one batched hash-object --stdin-paths); fake derived from a data description; one shared contract suite"
  - "createTempGitRepo test-kit builder with isolated git config and an injected structural SetupRunner (test-kit imports only facts)"
  - "Hostile-repo test (ROADMAP SC4) with an unprotected positive control"
affects: [01-14, 01-15, phase-02 indexer, fact-store gitHas injection]

plan_head_before: cc2f19ab00c2bce845ecc08bfb34eece514dcce2
plan_head_after: 24f00ed1d495cf6d4e3acf64e9dfc69f7ddf5336

actuals:
  tokens: 18000   # chars/4 over the 10 hand-written files (about 1,450 lines)
  tasks: 3
  commits: 3      # MEASURED: git rev-list --count cc2f19a..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "Repo-controlled execution is switched off by command-line -c overrides built in one function; every driver is neutralised, none exempted"
    - "A fake and the real adapter are both built from one data description (SourceTreeWorld) and run through one contract suite"
    - "Test-kit takes its runner by a structural interface instead of importing the seam, so the leaf lint rule stays true"
    - "Mutation check on the safety property: with neutraliseFilters emptied, the hostile-repo test fails on the filter marker"

key-files:
  created:
    - src/command-runner/git-spec.ts
    - src/command-runner/git-spec.test.ts
    - src/command-runner/hostile-repo.test.ts
    - src/test-kit/git-repo.ts
    - src/source-tree/types.ts
    - src/source-tree/real.ts
    - src/source-tree/fake.ts
    - src/source-tree/validate.ts
    - src/source-tree/contract.ts
    - src/source-tree/index.ts
    - src/source-tree/source-tree.test.ts
  modified:
    - src/command-runner/index.ts
    - src/test-kit/index.ts

key-decisions:
  - "Only hash-object gets driver neutralisation. ls-files, cat-file (without --filters or --textconv), rev-list and rev-parse apply no filters, so the extra -c pairs are not repeated on them; the config read that finds the names is itself unneutralised because it executes nothing."
  - "The hash batch uses the working-tree content (not the index id) so an edited tracked file hashes as edited; git applies its own line-ending conversion, so a CRLF file under `* text=auto` hashes to the LF blob id."
  - "A path starting with a double quote is skipped as unhashable_path: --stdin-paths would C-unquote it. Newline and carriage-return names, absolute and `..` paths are skipped the same way."
  - "Directory entries from ls-files --others (nested repositories) and tracked entries whose path is now a directory are reported as gitlink_skipped; fifos and other non-regular files as unhashable_path, so a special file can never block the batch."
  - "hasObject answers false for a malformed id; read throws SourceTreeError invalid_argument for an option-like commit or a path with NUL or a line break. Neither starts git (asserted)."
  - "The world's ignored list is realised through .git/info/exclude (anchored `/path` lines), so ignoring never adds a tracked .gitignore file that the fake would also have to know about."
  - "identity().rootCommit is the first line of rev-list --max-parents=0 HEAD, as the plan states; with several roots this is the newest root, which is deterministic."

patterns-established:
  - "A failed git command inside Source Tree is a thrown SourceTreeError (git_failed), never a silent empty result; per-path problems are diagnostics"
  - "Path-shaped diagnostics carry the path as subject so callers can attribute them"

requirements-completed: [FND-05, FND-06]

coverage:
  - id: D1
    description: "Every git command is built by gitSpec with fsmonitor, hooksPath and quotepath overrides, every filter driver neutralised, and the two pinned environment variables; git status is denied"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/command-runner/git-spec.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Source Tree snapshot: four git starts, exactly one hash-object --stdin-paths, ids equal an independent sha1 oracle"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/source-tree/source-tree.test.ts#Source Tree tracer"
        status: pass
    human_judgment: false
  - id: D3
    description: "Source Tree interface with a fake and one shared contract suite run against the fake and the real implementation on real temp repos"
    requirement: FND-05
    verification:
      - kind: unit
        ref: "src/source-tree/source-tree.test.ts#SourceTree contract: fake / SourceTree contract: real"
        status: pass
    human_judgment: false
  - id: D4
    description: "Git quirks do not break a snapshot: text=auto, spaces and non-ASCII names, newline and quote names, symlink, gitlink, skip-worktree, hash batch mismatch"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/source-tree/source-tree.test.ts#real Source Tree git quirks"
        status: pass
    human_judgment: false
  - id: D5
    description: "A repository with a malicious filter driver, core.fsmonitor and core.hooksPath runs nothing through the default decide; the unprotected positive control fires all three on this platform"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/command-runner/hostile-repo.test.ts"
        status: pass
    human_judgment: true
    rationale: "Proven on macOS (git 2.54.0). Linux and Windows are only exercised by their first CI run; the positive control skips loudly if the poison does not fire there."
  - id: D6
    description: "No module outside src/command-runner can start a process"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/command-runner/hostile-repo.test.ts#lintFiles over src; src/lint/boundaries.test.ts"
        status: pass
    human_judgment: false

duration: 70min
completed: 2026-10-16
status: complete
---

# Phase 1 Plan 13: Hardened Git and the Source Tree Seam Summary

**One `gitSpec` builder that switches off every repo-controlled execution path in git (every filter driver, fsmonitor, hooks), a frozen Source Tree seam with a fake and a shared contract suite, a real snapshot that hashes a whole tree in one `hash-object --stdin-paths` call, and a hostile-repo test that proves a poisoned repository runs nothing.**

## Performance

- **Duration:** about 70 min
- **Tasks:** 3 (a tracer, two auto tasks)
- **Files created:** 11, modified: 2
- **Whole suite:** 680 tests pass; typecheck, lint and `npm run build` clean; the compiled package has no `contract.js` and no test-kit

## Accomplishments

- The research claim that git runs repo code was reproduced first in a scratch repo (filter clean ran in `hash-object --stdin-paths`, fsmonitor ran in `ls-files -o`), and the same scratch run showed the `-c` overrides stop both, including an empty `filter.<name>.clean` and `required=false`.
- A snapshot is four git starts however large the tree: filter enumeration, tracked listing, untracked listing, one batched hash. 150 files still give one `hash-object` start.
- Per-path problems (newline, leading quote, symlink, gitlink, missing on disk, special files) become diagnostics and never fail the batch; a batch that does not return one id per path throws `hash_output_mismatch`.
- The hostile-repo test has three markers outside the repo. Its unprotected control fired all three (filter, fsmonitor, a pre-commit hook), so the protected run's silence means something. As a mutation check, emptying `neutraliseFilters` made the protected test fail with "the filter driver ran"; it was restored before committing.

## Task Commits

1. **Task 1 (tracer): hardened git spec, temp repo builder, one-batch snapshot** - `bc6808c`
2. **Task 2: fake, shared contract suite, object reads and identity, quirk tests** - `8ebdcf5`
3. **Task 3: hostile-repo test** - `24f00ed`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `--stdin-paths` unquotes a path that starts with a double quote**
- **Found during:** Task 1 design (checked against git's `--stdin-paths` behaviour)
- **Issue:** A tracked file named `"x".txt` would have been read by git as a C-quoted path and hashed as a different or missing file, misattributing ids (T-01-34).
- **Fix:** Such names are skipped with `unhashable_path`, like newline names. A quirk test covers it on POSIX.
- **Files modified:** src/source-tree/real.ts, src/source-tree/source-tree.test.ts

**2. [Rule 2 - Missing critical] Non-regular files and directory entries could hang or break the batch**
- **Issue:** `ls-files --others` reports a nested repository as `dir/`; a fifo in the tree would block `hash-object` forever.
- **Fix:** directories become `gitlink_skipped`, other non-regular files `unhashable_path`, both before the batch is built.

### Other deviations

- **`NULL_DEVICE` is `NUL` on Windows, `os.devNull` elsewhere.** Node's Windows `os.devNull` is `\\.\nul`, which the plan 01-09 `decide` does not accept; `decide.ts` was left unchanged. `os.devNull` appears in git-spec.ts as the plan's acceptance criterion requires.
- **`listFilterNames` takes an optional fourth `env` argument** (the test config isolation) beyond the plan's `(runner, worktree, ctx?)`.
- **Tests and implementation were written in one pass per task.** The red state was not observed or committed separately (no `test(...)` RED commits for Tasks 1 and 2); the mutation check above stands in for it on the safety property.
- **No default git timeout.** As recorded in the 01-09 summary, the 60 s default is held back pending human confirmation. gitSpec passes `timeoutMs` through when a caller supplies one and defines no timeout constant. No guard fired during this plan.

## Human confirmation still open (carried from 01-09)

The runner still has no default wall-clock limit for any spec, including the git specs built here. A repo guard blocks introducing a timeout-shaped constant without a human-typed confirmation phrase; the phrase was not demanded in this plan because none was added. A human needs to choose the default (the plan 01-09 asked for 60 s) before Phase 2 relies on snapshots of very large trees.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-01-32 to T-01-35 are mitigated and tested: all filter drivers neutralised (hostile-repo mutation check), fsmonitor and hooksPath overridden, newline, carriage-return and leading-quote names skipped with one id verified per input line, `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` in every spec.

## Notes for later plans

- `SourceTree.hasObject` is the intended `gitHas` injection for the Fact Store (fact-store-interface ADR decision 7).
- Windows and Linux behaviour of the hostile-repo control and of the symlink, newline and quote cases is unproven until the first CI run; those tests skip with a stated reason on Windows.
- `.codegraph/` was created in the worktree by `codegraph init -y` (per the user's worktree instruction) and is deliberately not committed.

## Self-Check: PASSED

- Files: all 11 created files and 2 modified files exist.
- Commits: bc6808c, 8ebdcf5, 24f00ed are ancestors of HEAD.
- `npm test` (680 pass), `npm run typecheck`, `npm run lint`, `npm run build` clean.
