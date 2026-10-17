---
phase: 02-grammar-tier-store-and-stdio-host
plan: 33
subsystem: command-runner
tags: [git, permission-gate, allowlist, environment, security, gap-closure]
requires: []
provides:
  - "per-subcommand exact-option allowlist (GIT_ALLOWED_OPTIONS) in the CommandRunner git gate"
  - "cat-file --batch-check accepted by the gate (needed by plan 02-38, WR-08)"
  - "wider inherited-environment denylist in scrubEnv"
affects: [02-38, 02-42]
tech-stack:
  added: []
  patterns: ["allowlist of exact option tokens per subcommand, written by value in the gate (gate does not import the builder)"]
key-files:
  created:
    - src/command-runner/git-allowlist.test.ts
  modified:
    - src/command-runner/decide.ts
    - src/command-runner/decide.test.ts
    - src/command-runner/env.ts
    - src/command-runner/env.test.ts
decisions:
  - "Option sets are exact tokens; a token starting with '-' that is not in the subcommand's set is denied. '--' is in no set."
  - "check-attr -a stays allowed because the existing builder tests send it; it is read-only."
  - "IN-05 allowlist switch deferred (reason recorded in env.ts header and the plan ledger; home ROADMAP Phase 4 criterion 8)."
metrics:
  tasks: 2
  files: 5
status: complete
commits: 2
plan_head_before: 27ae4745b8b40d2ef56534198753f39e59ef3085
plan_head_after: 802e36fe4c975170147e608d1796503d87dd9516
actuals:
  tokens: 2600
  tasks: 2
  commits: 2
requirements-completed: [STO-09, LNG-05]
---

# Phase 2 Plan 33: Git gate option allowlist and wider environment scrub Summary

The CommandRunner's git gate now allows only exact, known option spellings per subcommand, so no spelling of a write option (`-wt`, `-tw`, a late `-w`) or an abbreviated driver option (`--textc`) passes; the inherited child environment also loses the cloud, ssh-agent and database credentials the earlier pattern missed.

## What was built

### Task 1 (tracer): option allowlist (WR-11), commit 92e7bc7

- `decide.ts`: `GIT_DENIED_OPTIONS` and `GIT_READ_SUBCOMMANDS` are replaced by `GIT_ALLOWED_OPTIONS`, a `ReadonlyMap` of subcommand to `ReadonlySet` of exact tokens. After the subcommand is known every `rest` token that starts with `-` must be in that subcommand's set; positional tokens pass; a subcommand with no entry is denied. `config` and `worktree` keep their fixed-shape checks. The sets are written by value (the gate still imports nothing from `git-spec.ts`).
- Red first: the new matrix failed (and the real-repository case showed that `hash-object -wt blob --stdin` actually passed the old gate), then went green.
- Real-repository proof (`git-allowlist.test.ts`): four denied `hash-object` write spellings are run through the real production runner; each returns `command_denied` with `exitCode === null` (nothing started) and the loose-object count under `.git/objects` is identical before and after (case `no object written`). The allowed `cat-file --batch-check` spec runs and reports `<sha> commit <size>` for HEAD.

Option sets and the call site or test that needs each option:

| Subcommand | Options | Needed by |
|---|---|---|
| ls-files | `-z`, `-s`, `--others`, `--exclude-standard` | `source-tree/real.ts` (tracked listing, untracked listing) |
| ls-tree | `-r`, `-z`, `--full-tree`, `--name-only` | `source-tree/real.ts` (`-r -z --full-tree`); `git-read.test.ts` (`-r -z --name-only`) |
| hash-object | `--stdin-paths` | `source-tree/real.ts` (blob ids with clean filters applied) |
| cat-file | `-e`, `--batch`, `--batch-check` | `source-tree/real.ts` (`-e`, `--batch`); `--batch-check` added for plan 02-38 (WR-08) |
| rev-parse | `--verify`, `--quiet`, `--git-common-dir` | `source-tree/real.ts` |
| rev-list | `--max-parents=0` (the whole text) | `source-tree/real.ts` (root commit) |
| check-attr | `-z`, `--stdin`, `-a` | `source-tree/real.ts` (`-z --stdin`); `-a` from the builder tests in `git-spec.test.ts` |

Tests that changed or were checked:
- `decide.test.ts` "allows ls-tree with its ordinary read arguments": the positive case `--full-name -z HEAD -- src` used an option outside every set and a `--`; it was replaced by `-r -z --full-tree HEAD` and `-r -z --name-only HEAD` (the shapes the product and `git-read.test.ts` send). No `src/source-tree` or `git-read` spec was newly denied; the full run of source-tree, indexer, tenant, host, command-runner, `src/bin/compose.test.ts`, `scripts/cli-e2e.test.ts` and `scripts/parity.test.ts` passed.
- `git-spec.test.ts` and `hostile-repo.test.ts` needed no change (the status spec there is already denied as a subcommand).

### Task 2: environment scrub (IN-05, partial), commit 802e36f

- `env.ts`: the secret pattern gains `PASSWD`, `ACCESS_KEY`, `PRIVATE_KEY` and a trailing `_AUTH`; `SSH_AUTH_SOCK` and `DATABASE_URL` are removed by exact (case-insensitive) name. `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME` and names that merely contain `AUTH` (`AUTHORITY_NAME`) are kept. The overlay still wins.
- `env.test.ts` gains cases `removed names`, `kept names` and `overlay wins`; the first and last failed before the change.
- The switch to an inherited-environment allowlist is recorded as deferred in the `env.ts` header (reason and home: ROADMAP Phase 4, success criterion 8).

## Deviations from Plan

None - plan executed exactly as written. (One existing positive ls-tree test case was replaced because it used an option and `--` that the plan's rules deny, as the plan's read_first anticipated.)

## Verification

- `node --test` on decide, git-allowlist, git-spec, git-read, hostile-repo, source-tree: 330 tests, 0 failures.
- `node --test` on env, real, runner: 53 tests, 0 failures.
- Wider run (command-runner, source-tree, indexer, tenant, host): 599 tests, 0 failures; compose, cli-e2e, parity: 26 tests, 0 failures.
- `npm run typecheck` and `npm run lint`: exit 0.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or trust-boundary file access was introduced; T-02-110 and T-02-111 are mitigated as planned.

## Notes for later plans

- Plan 02-42 should record the option sets above in the command-runner ADR amendment (the comment above `GIT_ALLOWED_OPTIONS` points at it).
- Plan 02-38 can send `cat-file --batch-check` through the production gate.

## Self-Check: PASSED

- FOUND: src/command-runner/git-allowlist.test.ts
- FOUND commits 92e7bc7 and 802e36f (ancestors of HEAD)
