---
phase: 01-foundations-and-walking-skeleton
plan: 19
subsystem: command-runner
tags: [git, command-runner, decide, filter-driver, env-config, hostile-repo, gap-closure, CR-02]
status: complete
gap_closure: true

requires:
  - phase: 01-18
    provides: gitSpec env pins and the decide requirement for overrides and pinned env
provides:
  - "neutraliseFilters returns the GIT_CONFIG_COUNT/KEY_n/VALUE_n env overlay; gitSpec emits no per-driver -c pair"
  - "parseFilterNames takes everything between 'filter.' and the last '.', never cutting at '='"
  - "gitSpec rejects caller GIT_CONFIG_* env and drops case variants of pinned keys"
  - "decide validates the env config channel strictly on every git built-in"
  - "listFilterNames fails closed with a per-call random probe; typed GitConfigError (git_env_config_unsupported, filter_enumeration_failed)"
affects: [phase-02 indexer, any later git call site]

plan_head_before: 82afdcd
requirements-completed: [FND-05, FND-06]

key-files:
  modified:
    - src/command-runner/git-spec.ts
    - src/command-runner/git-spec.test.ts
    - src/command-runner/decide.ts
    - src/command-runner/decide.test.ts
    - src/command-runner/hostile-repo.test.ts
    - src/command-runner/index.ts
    - src/source-tree/source-tree.test.ts

key-decisions:
  - "Env channel instead of -c: git splits -c at the first '=', so a name with '=' can never be a -c key; the env channel carries key and value separately."
  - "Exit 1 from the config read no longer means 'no drivers': a conforming git always lists the probe, so any non-zero exit is filter_enumeration_failed."
  - "real.ts needed no change: snapshot awaits listFilterNames with no catch, so GitConfigError (which carries code) propagates unwrapped and no hash-object is built before enumeration succeeds."
  - "A repository cannot pre-define the probe driver (64 random bits per call), so a hostile driver with that name is not a supported attack."

completed: 2026-10-16
---

# Phase 1 Plan 19: Filter driver names with '=' (CR-02) Summary

**A filter driver named a=b, a=b=c, my.driver or the empty name now runs nothing during SourceTree.snapshot: every enumerated driver is neutralised through GIT_CONFIG_COUNT/KEY_n/VALUE_n, names are parsed without splitting on '=', decide validates that channel, and an enumeration that cannot be trusted aborts the snapshot before any hash-object.**

## Commits

| Task | Commit | Subject |
|------|--------|---------|
| 1 RED | 0bf9f9d | test(01-19): filter drivers named a=b, a=b=c, my.driver and empty must run nothing (red) |
| 1 GREEN | 2e217e4 | fix(01-19): neutralise filter drivers through the GIT_CONFIG env channel and parse names without splitting on '=' |
| 2 RED | 041b61d | test(01-19): decide must validate the GIT_CONFIG env channel strictly (red) |
| 2 GREEN | 559c0ce | feat(01-19): decide validates the GIT_CONFIG env channel on every git built-in |
| 3 RED | df375f0 | test(01-19): filter enumeration must fail closed behind a random probe (red) |
| 3 GREEN | 804b2e5 | feat(01-19): filter enumeration fails closed with a random probe and typed errors |

## RED evidence (observed)

- Task 1, command `node --test src/command-runner/hostile-repo.test.ts src/command-runner/git-spec.test.ts`. The positive control fired for all four names (markers M5 to M8 written). Target `a snapshot through the default decide runs none of them and hashes the plain content` failed with `AssertionError: the filter driver "a=b" ran` (actual true, expected false). Unit targets failed on assertions: `keeps "=" inside a name` (expected `['a=b']`), `gives unique names sorted ... "="` (expected `['a=b','a=b=c']`), `gives the empty name for filter..clean` (expected `['']`), the env-overlay test (expected GIT_CONFIG_COUNT '8', no -c pairs), the reserved-env test (`Missing expected exception: GIT_CONFIG_COUNT`), and the case-variant pin test. Semantic assessment: each failure is on the planned assertion, not on load or fixture errors.
- Task 2, `node --test src/command-runner/decide.test.ts src/command-runner/git-spec.test.ts`: 30 failures, each a `Missing expected denial` style assertion on one channel denial case (count shapes, stray indexes, core.sshCommand/alias/fsmonitor/hooksPath via env, non-empty value, required=true, newline/CR/NUL names, GIT_CONFIG_PARAMETERS, lower-case variants, huge count). The allow cases were already green because decide ignored extra env keys. Semantic assessment: valid, the denial assertions are the planned behavior.
- Task 3, `node --test src/command-runner/git-spec.test.ts src/source-tree/source-tree.test.ts`: 10 failures on the planned assertions (probe expected in GIT_CONFIG_KEY_0, `Missing expected rejection` for missing probe and exit 1, `The error is expected to be an instance of "GitConfigError". Received "Error"`, two Source Tree fail-closed cases). A minimal `GitConfigError` class and its index export were included in the RED commit so the target tests load and fail on assertions rather than on a missing export. The real-git listing test was already green (expected: the old code also listed names).

## Mutation check (not committed)

Restored the old cut-at-first-'=' parsing in parseFilterNames: `keeps "=" inside a name`, the two-name `=` test, `gives the empty name` and the protected hostile test (`the filter driver "a=b" ran`) all went red. Fix restored, all green.

## Findings

- An empty-named driver IS referenceable: `.gitattributes` `empty.txt filter=` plus `git config filter..clean <cmd>` fired its marker unprotected on git 2.54.0 (macOS). It is the fourth name of the hostile group (M8), protected run clean.
- `parseFilterNames` guard is `lastDot >= 'filter.'.length` so the empty name is kept; the old `<=` check dropped it.
- decide needed no change for Task 1 (it ignored extra env keys); strict validation was added in Task 2.

## Existing tests whose fixtures changed

- git-spec.test.ts: `prepends -C, the three hardening overrides and one neutralisation per filter driver` (args now exclude filter pairs, env asserted instead); `neutralises dotted driver names` (returns env record); `turns key=value and name-only lines into unique sorted driver names` (replaced by one test per parse case; key=value tolerance removed); the listFilterNames tests (`reads names...`, `treats exit status 1 ... as no drivers` now asserts rejection, `throws on any other failure`) now answer through `respond` echoing the probe.
- source-tree.test.ts: `throws hash_output_mismatch ...` returned `{exitCode: 1}` for config; it now echoes the probe from GIT_CONFIG_KEY_0. Assertions unchanged.
- No case deleted; no assertion weakened.

## Gates (local, macOS arm64, git 2.54.0, Node 26.x)

`npm test` 885 pass, 0 fail, 0 skipped; `npm run typecheck`, `npm run lint`, `npm run build` exit 0.

## Pending

- Three-OS CI run is NOT done. Unconfirmed: Windows handling of an empty GIT_CONFIG_VALUE_n (a miss would be a loud fail-closed throw, never a silent bypass) and Linux behavior of the new hostile group.

## Deviations

- One edit of src/command-runner/git-spec.ts (header, neutraliseFilters, parseFilterNames) was applied with a Python script inside the worktree rather than the Edit tool; content was verified afterwards through CodeGraph. No write touched the main checkout.
