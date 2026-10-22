---
phase: quick-261021-re7-indexer-ignore-rules
plan: 01
subsystem: source-tree, indexer, command-runner
tags: [index-exclusions, atlasignore, git-allowlist, trust-boundaries]
status: complete
requirements: [QUICK-261021-re7]
commits: 5
plan_head_before: ffeafb8a23cb1ec3265cb15346ec77912291517c
plan_head_after: 60071ea
key-files:
  created:
    - src/source-tree/default-excludes.ts
    - src/source-tree/atlasignore.ts
    - src/source-tree/fake-rules.ts
    - docs/reference/index-exclusions.md
    - docs/how-to/exclude-files-from-the-index.md
    - .planning/quick/261021-re7-indexer-ignore-rules-built-in-tooling-an/261021-re7-MEASUREMENTS.md
    - .planning/quick/261021-re7-indexer-ignore-rules-built-in-tooling-an/measure-defaults.mjs
  modified:
    - src/source-tree/real.ts
    - src/source-tree/fake.ts
    - src/source-tree/types.ts
    - src/command-runner/decide.ts
    - src/indexer/ignore.ts
    - src/indexer/reconcile.ts
    - src/tenant/follower-overlay.ts
    - src/tenant/messages.ts
    - src/query/status.ts
    - docs/adr/3-trust-boundaries.md
    - docs/adr/4-command-runner.md
    - docs/adr/5-language-modules.md
---

# Quick 261021-re7: Indexer ignore rules Summary

Built-in tooling and build-output exclusions (37 entries, one constant) plus a repo-level `.atlasignore` in git syntax, evaluated by git on every path the indexer uses, with pathless counts in notes and `atlas_status`.

## Commits

| Commit | What |
| --- | --- |
| 99b0a8d | Task 1: measurement script and record (`261021-re7-MEASUREMENTS.md`) |
| 73459a8 | Task 2 RED: tests only |
| 26da71c | Task 2 GREEN-1: Source Tree, fake, git gate |
| 8b7748d | Task 2 GREEN-2: PathFilter, Reconcile, follower, build notes, atlas_status |
| 60071ea | Task 3: three ADR amendments, two pages, cli/mcp/README edits, docs test case |

## What was built

- `INDEX_DEFAULT_EXCLUDES` (`src/source-tree/default-excludes.ts`), the only place the list is written; 21 entries apply to tracked files, 16 to untracked files only, from the measurement.
- `.atlasignore`: vetted before git may read it (`src/source-tree/atlasignore.ts`: regular file via the confined reader, 64 KiB in total, valid UTF-8, no NUL, no link, link or submodule mode, or directory of that name). Unusable for the whole worktree on any failure, one fixed warning, listing still succeeds. A failing or timing-out second stage falls back to the first stage with the same warning.
- Source Tree (`real.ts`): snapshot lists four times at once (tracked, untracked with defaults, tracked paths the tracked defaults remove, untracked without defaults for the count) plus two more for a usable `.atlasignore`; `unignoredPaths` gives the same verdicts with two (four) listings. Only constants reach git.
- Gate (`decide.ts`): `ls-files` gains `--exclude`, `--ignored` and `--exclude-per-directory=.atlasignore`, plus a value rule for `--exclude`.
- Fake Source Tree and `fake-rules.ts`: the same behaviour over world data with a small rule set; unsupported syntax throws `invalid_argument` at construction.
- Indexer: PathFilter resets on `.atlasignore` events; Reconcile report and `lastReconcile` carry the counts; the follower runs requested paths through the same filter (this also closes the same gap for `.gitignore`); `BUILD_NOTE_CODES` gains the three notes; `atlas_status` carries `indexer.excluded`.
- ADR 3, 4, 5: dated 2026-10-21 amendment sections, appended only (`git diff` of `docs/adr`: 38 insertions, 0 deletions).
- Docs: reference page, how-to (replayed on scratch repositories with the built CLI), cli.md codes, mcp.md `indexer.excluded` and its example, README links, one docs test case.

## Task 1 measured decisions

15 corpora (gsd-core at its pin and 14 shallow clones, all at their pins), git's own matcher. Every gsd-core drop is 0 (3,976 tracked paths). The gsd-core clone's status (2 lines) and `.git/index` checksum are identical before and after.

| Entry group | Decision | Evidence |
| --- | --- | --- |
| 16 javascript entries (bower_components, jspm_packages, .pnpm-store, .yarn/cache, .npm, out, .next, .nuxt, .svelte-kit, .turbo, .parcel-cache, .cache, coverage, .nyc_output, .angular, .vite) | TRACKED-OK | 0 tracked source-extension drops everywhere (coverage/: 2 JSON files in vscode) |
| 5 bundle-output entries (*.min.js, *.min.css, *.bundle.js, *.js.map, *.css.map) | TRACKED-OK | only tracked drops: 2 vendored minified libraries (gsd-pi) and 153 map files, no source |
| node_modules/ | UNTRACKED-ONLY | 28 tracked source files (backstage fixtures) |
| dist/ | UNTRACKED-ONLY | 30 tracked source files |
| build/ | UNTRACKED-ONLY | 520 tracked source files (vscode, grafana, angular, TypeScript) |
| 6 python, 3 jvm-rust, 4 apple entries | UNTRACKED-ONLY | ecosystem not measured (`target/` and `Pods/` already show false drops in TS corpora) |

Angular (3cc1edf) loses 0 tracked paths. Git probes Q1 to Q8 and the cost table are in the measurement file. Cost finding: the tracked-defaults listing costs about 290 ms on a 68,000-path tree (19 ms on 4,000 paths), so `unignoredPaths` stage 1 is about 510 ms there against 69 ms before; reported, not tuned.

## Tests changed on purpose

Named in the RED commit body and marked in the code: Source Tree tracer (six git starts), `unignored.test.ts` (two listings, constant exclude pairs, scripted answers by `--others`), both `spawn-stages` tests, `spawn-count` (5 spawns for a new file), `indexer/ignore.test.ts` (listing counts), `decide.test.ts` (`--ignored` no longer a denial example), `git-allowlist.test.ts` (new shapes), `hostile-repo.test.ts` (four listings), `query/status.test.ts` (`excluded: null`), and in GREEN-2 `tenant/tenant.test.ts` (five build-note codes). No other existing test needed a change: no fixture sat under a default in a way that broke.

## Results

`npm test`: 5007 tests, 5004 pass, 0 fail, 3 skipped. `npm run lint`: clean. `npm run schema:check`: current. `npm run typecheck`: one error, in `scripts/angular-pilot/sample-keys.ts` (another agent's file, not touched, same on the base commit). The preregistration verifier prints ok and no registered file differs from the base.

## Deviations from plan

- [Rule 3] The RED cases could not honestly be run "on unchanged production code to learn which existing tests the defaults change": with no defaults there is no change. The full suite after GREEN-1 was the check; nothing besides the GREEN-2 cases failed.
- [Rule 3] `REPO_CONFIG_MAX_BYTES` is exported from `src/tenant/index.ts` so the test that keeps the cap equal can import it without a deep import (a lint boundary).
- RED: the contract loads the defaults module with a dynamic import so its new cases fail alone; tests that import the new modules statically failed at the import.

## Follow-ups (owner)

(a) ADRs: none open; 3, 4 and 5 were amended with the owner's approval of 2026-10-21. (b) Follow-ups: apply the defaults to history reads (`ls-tree` cannot); watcher ignore globs from the defaults (event volume); a user-level override in `~/.config/gsd-atlas`; cache the `.atlasignore` verdict and the tracked-defaults listing per index state to avoid the second stage and the half-second on very large trees; diagnostics-bundle fields (not changed: a bundle field is a consent-schema change); Reconcile on `.atlasignore` change (the filter resets at once, files already indexed leave at the next Reconcile or build, as for `.gitignore`).

## Not verified

Windows and Linux git timing and behaviour (all probes and costs are macOS arm64, git 2.54.0; the CI matrix runs the allowlist cases elsewhere); the Windows paths of the symlink and trailing-space tests (they skip there); the cause of the tracked-defaults cost (no trace taken); the field behaviour with a very large un-ignored `node_modules` on disk; `scripts/parity.test.ts` "context" failed once in a full run under load and passed alone and in two more full runs (a timing flake, not reproduced).

## Self-Check: PASSED

Files and commits above exist (`git log` lists the five commits; the files are in the tree).
