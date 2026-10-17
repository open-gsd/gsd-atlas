---
phase: 02-grammar-tier-store-and-stdio-host
plan: 45
subsystem: cli-init
tags: [init, config_in_use, rename, windows, wr-12, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-35 init lost-update guard (ConfigChangedError), 02-44 init environment and test rig"
provides:
  - "ConfigInUseError (code config_in_use, errno) from writeUserFile when the rename gets EPERM, EBUSY or EACCES"
  - "An init refusal 'config_in_use: ...' that says nothing was changed and to run init again (exit 2, envelope diagnostic config_refused)"
  - "A TEST ONLY renameFile seam on WriteOptions and InitEnvironment, so the Windows errors are tested on every OS"
  - "A concurrency test whose acceptance set is exactly config_changed_during_init and config_in_use, with file invariants in both the some-succeeded and all-refused branches"
affects: [init]
tech-stack:
  added: []
  patterns: ["classify an OS refusal into a typed error in the existing cleanup catch; no waiting", "scripted fs failure through a test-only seam"]
key-files:
  created:
    - src/cli/init-files.test.ts
  modified:
    - src/cli/init-files.ts
    - src/cli/init.ts
    - src/cli/init.test.ts
key-decisions:
  - "A refused rename is reported, never waited out: no retry, delay, timeout or other timeout-shaped constant was added (such a value needs a human-approved entry in 02-CONSTANTS.md)."
  - "The refusal text names both causes (another process holds the file, or the folder is not writable) because EACCES can be either."
  - "The scripted two-run EPERM case starts the second init inside the first run's renameFile, so the order does not depend on timing."
requirements-completed: [HST-04]
status: complete
commits: 2
plan_head_before: 499c82a8fb1233c54e28988f0f9255e0a9237cff
plan_head_after: 7d301356240938a3ecde3428fcde77b29edbe31c
actuals:
  tokens: 5300
  tasks: 2
  commits: 2
---

# Phase 02 Plan 45: init reports a refused rename as config_in_use Summary

A rename that the operating system refuses (EPERM, EBUSY, EACCES) is now a `config_in_use` refusal that says nothing was changed and to close the other program and run init again. The Windows errors are scripted on every OS, and the concurrency test accepts exactly the legitimate outcomes.

## What changed

- `src/cli/init-files.ts`: new `ConfigInUseError` (`code` `config_in_use`, `errno`), the TEST ONLY `renameFile` option on `WriteOptions` (production gets `fs.promises.rename`), and a classification around the rename: `EPERM`, `EBUSY` and `EACCES` become `ConfigInUseError`; every other error is rethrown unchanged. The existing cleanup catch removes the temp file; the config and any backup are not touched. Header comment extended.
- `src/cli/init.ts`: TEST ONLY `renameFile` on `InitEnvironment`, passed through to `writeUserFile`; the catch in `registerWith` maps `ConfigInUseError` to `config_in_use: the config file could not be replaced because another process holds it open, or its folder is not writable (<errno>); nothing was changed; close the program that uses it and run init again`. The generic `could not write the file: ...` branch is kept for everything else.
- `src/cli/init-files.test.ts` (new): writer-level cases `EPERM rename`, `EBUSY rename`, `EACCES rename` (byte-compare of the config and the backup, directory listing), `existing backup untouched`, `new file rename refused` (three codes), `other rename errors keep the generic error` (ENOSPC), plus a changed-file case and the real-rename case.
- `src/cli/init.test.ts`: `renameFile` in the rig; init-level `rename refused is config_in_use` (EPERM, EBUSY, EACCES), `config_in_use for a new file` (Cursor) and `rename ENOSPC stays generic`; the concurrency case rewritten with `REFUSAL` and an `assertRaceInvariants` helper, plus scripted one-refused and both-refused variants.

## Task commits

| Task | Commit | Message |
| ---- | ------ | ------- |
| 1 (tracer) | 49b52d0 | fix(02-45): init reports a refused rename as config_in_use (HST-04) |
| 2 | 7d30135 | test(02-45): the concurrent-inits case accepts exactly the legitimate outcomes |

## Red evidence (Task 1)

Before any product code: `node --test src/cli/init-files.test.ts` failed at load with `SyntaxError: The requested module './init-files.ts' does not provide an export named 'ConfigInUseError'`, and `node --test src/cli/init.test.ts` gave 109 tests, 104 pass, 5 fail (EPERM, EBUSY, EACCES, new file and ENOSPC at init level, each exit 0 instead of 2 because the unknown `renameFile` seam was ignored). After the change: 138 of 138 across `init-files`, `init` and `init-toml` tests.

## Mutation check

With the classification disabled (`if (false && hasCode(error, ...IN_USE_CODES))`), the run gave 11 failures: EPERM, EBUSY and EACCES at writer level, `existing backup untouched`, the three `new file rename refused` cases, the three init-level `rename refused is config_in_use` cases and `config_in_use for a new file`. The source was restored afterwards.

## No timeout-shaped constants

Check run: `git diff -U0` of `src/cli/init-files.ts` and `src/cli/init.ts`, added lines grepped (case-insensitive) for `setTimeout|sleep|retry|retries|attempt|<n> ms|delay|timeout`. The only hit is the word "retries" in a header comment that says nothing waits or retries. No timer, loop, counter or millisecond value was added.

## Task 2 evidence

- `node --test --test-name-pattern="concurrent inits" src/cli/init.test.ts` run 30 times in a row: 30 of 30 runs passed all 3 matching cases (3 pass, 0 fail each).
- Injected EPERM: the one-refused case starts the second init inside the first run's scripted rename and then throws EPERM, so the first run is refused with `config_in_use`, the second is `updated`, the file holds exactly the registered entry, and the directory holds only the config and its backup. The both-refused case (EPERM and EBUSY) ends with a byte-identical config and two `config_in_use` refusals.
- The existing deterministic `two inits racing` case is unchanged.

## Verification

- `node --test src/cli/init.test.ts src/cli/init-files.test.ts src/cli/init-toml.test.ts`: all pass.
- `npm run typecheck` and `npm run lint`: exit 0.
- Full `npm test`: 2607 tests, 2607 pass, 0 fail, 0 skipped.
- Local figures only. The evidence for the original failure is the next hosted Windows Node 24 run of `src/cli/init.test.ts`, which this plan does not produce.

## Deviations from Plan

None - plan executed as written. One addition inside the plan's intent: an extra both-refused concurrency variant, so the all-refused branch of the invariants (byte-identical file) is exercised on every OS.

## Known Stubs

None.

## Threat Flags

None. T-02-132 is mitigated: the refusal path removes only init's own temp file, never touches the config or a backup, and the scripted cases byte-compare the config and the backup and list the directory.

## Remaining (from the plan's deferred ledger)

A config file held open longer than the moment of a race still makes init refuse and need a second run; waiting or retrying was left out on purpose.

## Self-Check: PASSED

- src/cli/init-files.test.ts exists; src/cli/init-files.ts, src/cli/init.ts and src/cli/init.test.ts modified.
- Commits 49b52d0 and 7d30135 are ancestors of HEAD.
