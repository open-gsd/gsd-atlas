---
phase: 01-foundations-and-walking-skeleton
plan: 20
subsystem: command-runner
tags: [git, command-runner, decide, filter-driver, utf-8, env-config, hostile-repo, gap-closure, CR-01, WR-01]
status: complete
gap_closure: true

requires:
  - phase: 01-19
    provides: the GIT_CONFIG_COUNT/KEY_n/VALUE_n neutralisation channel, listFilterNames with a random probe, decide channel grammar
provides:
  - "filter-name.ts: one leaf rule (filterNameProblem, isNeutralisableFilterName, MAX_FILTER_NAME_LENGTH 1024) for which filter driver names the environment channel carries byte for byte"
  - "listFilterNames decodes git stdout with a fatal UTF-8 decoder and checks every listed name; an unrepresentable name rejects with GitConfigError filter_enumeration_failed before any hash-object"
  - "neutraliseFilters / gitSpec refuse the names the gate refuses; decide validates channel keys with the same predicate (no import of git-spec.ts)"
  - "git-spec.ts header and doc comments state the true rule (no 'whatever it is called' claim)"
affects: [phase-02 indexer, any later git call site]

plan_head_before: 1e9d0775f0005d5bc0899695c4dd4e386864d8c1
plan_head_after: 5a1caa0
commits: 4
requirements-completed: []
requirements-pending: [FND-05, FND-06]

key-files:
  created:
    - src/command-runner/filter-name.ts
  modified:
    - src/command-runner/git-spec.ts
    - src/command-runner/git-spec.test.ts
    - src/command-runner/decide.ts
    - src/command-runner/decide.test.ts
    - src/command-runner/hostile-repo.test.ts
    - src/source-tree/source-tree.test.ts

key-decisions:
  - "Fail closed: a driver name the environment channel cannot carry (not valid UTF-8, U+FFFD, unpaired surrogate, NUL, LF, CR, over 1024 UTF-16 code units) makes the snapshot fail with a typed error; it is never modelled as bytes (Node cannot put arbitrary bytes in a child environment)."
  - "CR stays refused by the gate; the builder now refuses it too, with an explicit typed error instead of a misleading denial at the hash step (WR-01). The gate is not loosened."
  - "decide imports the leaf rule but never git-spec.ts, so the gate still does not trust the builder; a corpus test proves rule, builder and gate agree."
  - "Error messages show a repo-controlled name only through JSON.stringify clipped to 80 characters, never split mid surrogate pair (T-01-53)."

completed: 2026-10-16
---

# Phase 1 Plan 20: Filter driver names the environment channel cannot carry (CR-01, WR-01) Summary

**A repository whose filter driver name is not valid UTF-8 (or holds U+FFFD, an unpaired surrogate, NUL, LF, CR, or more than 1024 UTF-16 code units) can no longer run its clean command during SourceTree.snapshot(): enumeration fails closed with a GitConfigError before any hash-object, while valid but unusual names (non-ASCII, emoji, tab, leading or trailing space, exactly 1024 units) still snapshot normally, and the builder and the permission gate now share one name rule.**

CI evidence: push run 38896073556 and pull-request run 38896083789, both green on all ten jobs at head 5a1caa0 (see Task 3).

## Commits

| Task | Commit | Subject |
|------|--------|---------|
| 1 RED | cf0bfae | test(01-20): filter driver names the environment channel cannot carry must fail the snapshot (red) |
| 1 GREEN | d7b7354 | fix(01-20): refuse filter driver names the environment channel cannot carry (CR-01) |
| 2 RED | 87ab37a | test(01-20): decide must refuse the channel keys the builder refuses (red) |
| 2 GREEN | b28e273 | fix(01-20): decide validates filter channel keys with the shared name rule (WR-01) |

CODE_SHA (last commit that changed `src/`): `b28e273`. This SUMMARY is committed separately afterwards; the CI run must be on a head whose `src scripts .github package.json package-lock.json` equal `b28e273`.

## RED evidence (observed)

- Task 1, `node --test src/command-runner/hostile-repo.test.ts src/command-runner/git-spec.test.ts src/source-tree/source-tree.test.ts` against an always-accepting `filter-name.ts` stub (78 tests in the two non-hostile files, 16 failing; hostile-repo 20 tests, 6 failing, 0 skipped).
  - hostile-repo: both positive controls fired (no skip). The five byte or length cases (lone 0xFF, 0xC3 0x28, 0xED 0xA0 0x80, genuine U+FFFD, 1025 `x`) failed with `AssertionError: Missing expected rejection` (the snapshot resolves today). The CR case failed with `AssertionError: SourceTreeError: git hash-object --stdin-paths failed: git -C <repo> was not started: it is not a first-party built-in; ...` (a denial at the hash step, not the typed error). Group B (no over-refusal) passed already, as designed: it guards the fix against refusing too much.
  - git-spec and source-tree: the predicate table (`refuses U+FFFD, unpaired surrogates, CR, LF, NUL and over-long names ...`), the five invalid-byte `listFilterNames` cases, the undecodable-and-no-probe case, the five valid-UTF-8 refused-name cases, the builder throw cases (`Missing expected exception (GitConfigError): "a<U+FFFD>b"`), the real-git lone-0xFF case and the scripted Source Tree fail-closed case failed on assertions (`Missing expected rejection`). Semantic assessment: every failure is on a planned assertion, not on load or fixture errors; the stub exports let the files load.
- Task 2, `node --test src/command-runner/decide.test.ts src/command-runner/git-spec.test.ts` (150 tests, 2 failing): `denies names the shared rule refuses (U+FFFD, an unpaired surrogate, 1025 code units) ...` failed with `AssertionError: expected a denial`, and `for every name in one corpus, the shared predicate, the builder and the gate give the same answer` failed with `gate on a hand-built channel: "a<U+FFFD>b" hash-object`. The allow cases and the builder half of the agreement tests were already green after Task 1, as predicted.

## Mutation checks (not committed, each restored)

- Task 1 (i): lenient decoder (`fatal: false`) plus `filterNameProblem` accepting U+FFFD: 16 tests red, including the four group A byte cases (lone 0xFF, 0xC3 0x28, 0xED 0xA0 0x80, genuine U+FFFD), the five invalid-byte listing cases, the undecodable-no-probe case, the real-git lone-0xFF case and the Source Tree fail-closed case.
- Task 1 (ii): strict decoder kept, `filterNameProblem` accepting U+FFFD: 5 failing tests/groups, including `a snapshot is refused ... for a genuine U+FFFD`, `rejects the valid UTF-8 name "<U+FFFD>"` and `"a<U+FFFD>b"`, the predicate refusal table and the builder throw table.
- Task 1 (iii): `filterNameProblem` ignoring length: `a snapshot is refused ... for a 1025 code unit name`, `rejects the valid UTF-8 name "xxxx..."`, the predicate table and the builder throw table went red.
- Task 2: a channel key check that only refuses NUL, CR and LF (the old behaviour): `denies names the shared rule refuses (U+FFFD, an unpaired surrogate, 1025 code units) ...` and the corpus agreement test went red.

## Gates (local, macOS arm64, git 2.54.0, Node 26.11.1)

`npm test`: 918 tests, 918 pass, 0 fail, 0 skipped (hostile-repo.test.ts alone: 20 tests, 0 skipped, so every positive control fired locally). `npm run typecheck`, `npm run lint`, `npm run build` exit 0; `dist/command-runner/filter-name.js` exists.

## Planner findings, as verified on this platform

1. The invalid forms `61 ff 62`, `61 c3 28 62`, `61 ed a0 80 62`, genuine `61 ef bf bd 62` and a 1025-unit name each fire their clean command when git hashes a file unprotected: confirmed by the group A positive control (markers M9 to M13 written, test not skipped). Valid UTF-8 names (cafe with an accent, an emoji, 1024 units) also fire unprotected (group B control, M14 to M16) and are carried correctly by the channel: group B protected test passes with ids equal to the independent sha1 oracle and exactly one hash-object start.
2. Names with CR, tab or space cannot be referenced from `.gitattributes`: NOT independently re-verified by the executor (a direct experiment was refused by the worktree git guard). Consistent with the plan, those names have no positive control, and git accepted a `[filter "a<CR>b"]` section (the CR case reached the typed error). Tab, leading-space and trailing-space names were configured as config-only drivers in group B and snapshot normally, which confirms the channel carries them.
3. CR stays refused by both sides: decide still denies CR, LF and NUL (existing cases unchanged); the builder now throws `filter_enumeration_failed` naming `carriage return`.
4. `String.prototype.isWellFormed` was not used (tsconfig target es2023); unpaired surrogates are detected with a code-unit regular expression.
5. Messages never show a name raw: asserted for CR, LF and NUL absence in every refusal message, and the 1025-unit message is below 400 characters.

## Existing tests whose fixtures changed

None. No assertion in hostile-repo.test.ts, git-spec.test.ts, decide.test.ts or source-tree.test.ts was removed or relaxed. hostile-repo.test.ts had 11 tests at plan base 6039ad1 and now has 20; the only edits to existing lines are widening the `./index.ts` import list (adds `GitConfigError`) and one sentence added to the file header.

## Behaviour change for users

A repository whose `.git/config` holds a filter driver with an unrepresentable name now fails its snapshot with `GitConfigError` code `filter_enumeration_failed` and a message that names the problem, shows the key through `JSON.stringify` (clipped to 80 characters) and tells the user to rename or remove that `[filter]` section. Before, such a snapshot silently ran the driver's clean command (non-UTF-8 names) or died with a misleading "not a first-party built-in" denial at the hash step (CR names). Names that are merely unusual (non-ASCII, emoji, tab, leading or trailing space, up to 1024 UTF-16 code units) still snapshot.

## Deferred (scheduled, not dropped): schedule before Phase 2 builds on decide

Pointers are from 01-REVIEW.md; line numbers in `decide.ts` have shifted by roughly 15 lines since that review.

- WR-02: `decide.ts` option denylist (`GIT_DENIED_OPTIONS`, whole-argument match in `matchGit`) is bypassable by abbreviation and bundling (`cat-file --textc`, `hash-object -wt`, `rev-list --output`, `--alternate-refs`, `ls-files --recurse-submodules`, `cat-file --batch`). Fix: per-subcommand exact option allowlist. Schedule before Phase 2 builds on decide.
- WR-03: `gitEnvPinned` checks the pinned env by presence only and does not bound the rest of the env (case-variant duplicates of pins, `GIT_EXEC_PATH`, `GIT_SSH*`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_ASKPASS`, `GIT_PAGER`). Schedule before Phase 2 builds on decide.
- IN-02: `src/command-runner/env.ts` strips an inherited `GIT_CONFIG_COUNT` but not `KEY_n` / `VALUE_n`, and drops a user's own channel (for example `safe.directory`) silently.
- IN-03: redundant `(kv as string)` casts in `decide.ts` `matchGit`, and the spacing typo `const notOnWindows =(why` in `source-tree.test.ts`.
- IN-01 (second half): the protection tests in hostile-repo.test.ts do not assert that their positive control fired (the new groups follow the same shape).

Human items 1, 2, 3 and 5 of 01-VERIFICATION.md remain human decisions and are not tasks of this plan.

## Deviations from Plan

- [Process] One two-line edit of `src/command-runner/hostile-repo.test.ts` (import widening and header sentence) was applied with a Python snippet instead of the Edit tool; content verified through the diff and passing tests. All other edits used Edit or Write.
- [Process] A stray `rm -f /dev/null` was accidentally appended to one verification command; it failed harmlessly (permission) and `/dev/null` was checked intact.
- [Environment] `codegraph init -y` created an untracked `.codegraph/` in the worktree so source reads reflected this checkout; it is not committed.
- No Rule 1 to 3 deviations in the code. Task 3 is a human-action checkpoint and is not done.

## Task 3: CI evidence

Task 3 was done by the orchestrator under the user's standing authorization to push (the user stated there is no restriction on pushing or opening the PR).

- Push to `ci/phase-1`: `2e59fc7..5a1caa0`. Push-event run **38896073556**, `headSha` 5a1caa09160e0e9dfadd93092579f3251d1c8d66, conclusion success.
- Pull-request-event run **38896083789** (draft PR #10, `ci/phase-1` into `main`), same `headSha`, conclusion success. Not waived.
- All ten jobs in both runs concluded success: Static checks; Test on ubuntu-latest, macos-latest and windows-latest at Node 24.16.0 and 26 (six); Grammar rebuild on the three OSes (three).
- `git diff --quiet b28e273 5a1caa0 -- src scripts .github package.json package-lock.json` exits 0: the runs tested this plan's source (CODE_SHA b28e273).
- Push-run logs, all six Test jobs (ubuntu, macos, windows at Node 24.16.0 and 26): both new hostile groups ('filter driver names the environment channel cannot carry' and 'unusual but representable filter driver names') ran, and the line `poison did not fire unprotected on this platform` appears zero times. No positive control was skipped on any of ubuntu, macos or windows.
- Known risk from the plan (tab, space and 1024-unit names on the Windows environment channel) did not materialise: the Windows jobs pass.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or file access pattern; the new module is a pure leaf.
