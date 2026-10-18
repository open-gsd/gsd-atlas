---
created: 2026-10-18
title: Windows support after the initial alpha (postponed by Decision 2)
area: ci/platform
---

Decision (user, 2026-10-18, Decision 2): "Postpone Windows Support past initial Alpha. We have extensive testing problems on GSD-CORE and it's an established project, do not easily have a windows box to do local testing on."

Done with the decision (commits `ci:` and `docs:` on 2026-10-18):
- `.github/workflows/ci.yml` (test, grammar, gates) and `nightly.yml` (strict): the Windows legs still run, with a job-level `continue-on-error` for the Windows leg only. Ubuntu and macOS stay blocking. The `test` job is capped at 20 minutes on Windows (30 elsewhere). `scripts/ci-config.test.ts` pins all of it.
- `.planning/PROJECT.md`: dated decision note under Constraints (Platforms), Active and Key Decisions.

## To do after the alpha

Get Windows signal through CI only (no local Windows box): push a `ci/windows-*` branch, read `gh run view --log` per file, and fix one owner's failures per branch. A throwaway workflow that runs each test file alone with a per-file limit (the `diag-p3` pattern of plan 03-30) finds hangs without stalling a job. When the Windows test job is green on three consecutive runs: raise its cap back to 30 only if needed, delete the `continue-on-error` lines in ci.yml and nightly.yml (the decision comment says so), update `scripts/ci-config.test.ts`, and write the supersession into PROJECT.md.

### Windows test failures on hosted windows-latest (from 03-30-SUMMARY.md, 'Task 3 results'; 195 files run alone, 420 s limit)

| File | Symptom | Likely owner |
|------|---------|--------------|
| src/bin/compose.test.ts | HANG to the limit; 'one pool per host' first fails with `EPERM ... rmSync` of the temp folder (src/test-kit/tmpdir.ts:39) while a compiler worker still runs. This file stalled the whole suite to the 30 minute job limit in CI run 1 (the reason for the 20 minute cap) | 03-27 / 03-28 (pool, worker teardown), test-kit |
| src/precise-resolver/typescript/resolver.test.ts | 379 s; 7 failures: destructured require, project 6.x compiler env, 'a target path that leaves the repository', four 'relations' cases | 03-19 / 03-22 |
| src/precise-resolver/typescript/memory.test.ts | 'no orphan after a kill' (line 240, assertion at 254): a worker killed from outside answered `ResolverFailure ... (exit code 1)` where the test expects a clean replacement. The other 25 cases pass on Windows, so the sampler kill itself (`process.kill(process.pid, 'SIGKILL')`) works; research assumption A3 holds | 03-27 |
| src/tenant/precise-command.test.ts | 'output never leaves': `EBUSY: resource busy or locked, read` (line 272) | 03-29 |
| scripts/emit-e2e.test.ts, scripts/cli-e2e.test.ts | a spawned CLI exits `3221225477` (0xC0000005, access violation) | 03-23 and the CLI wave |
| scripts/explain-e2e.test.ts | `EPERM` removing the temp folder at cleanup (fuzz case) | test-kit |
| scripts/project-model-differential.test.ts | `fatal: unable to access '\\.\nul': Invalid argument` from `git` (a NUL-device config path) | 03-16 / 03-21 |
| scripts/eval/freeze-prereg.test.ts | the same `git` failure on `\\.\nul`. **Stage A is frozen**: this file and `docs/eval/preregistration.md` were not touched and must not be silently edited. Fixing it needs a deliberate re-freeze of Stage A (new hashes through the pre-registration process), so it is deferred to this work item; `node scripts/eval/verify-prereg.ts` stays green on Ubuntu | eval wave; needs the user's re-freeze decision |
| scripts/eval/free-alternatives.test.ts | `lsp.command.startsWith(ctx.installDir)` is false (Windows path form: backslashes and 8.3 short names; compare with `fs.realpathSync.native`) | eval wave |

(`scripts/ci-config.test.ts` and `scripts/diag-nobreak.test.ts` appeared only in the throwaway diagnostic runs; `scripts/precise-gate.test.ts` was fixed in a6a55f0. Neither is open.)

Cross-cutting causes to fix once: temp-folder cleanup while a worker or a connection still holds a handle (EPERM / EBUSY; close databases and end workers before `rmSync`, with a retrying remove in `src/test-kit/tmpdir.ts`); `git` reading a `\\.\nul` config path; path-form assertions (compare real paths, not raw strings); a CLI crash with 0xC0000005 (find which spawned command; likely a native module or the watcher).

### Strict-build ceiling (also open on Linux, which is blocking)

The strict precise gate (`scripts/precise-gate.ts --strict`, nightly) measured full build 42.2 s on hosted Linux and 54.9 s on hosted Windows against the 30 s ceiling (macOS 15.4 s passes); PR-tier repeats were 26 to 42 s on Linux and 47 to 59 s on Windows. The ceiling was not moved. The nightly Linux leg stays blocking, so this still needs the 03-30 decision (larger runners, judge the strict build on macOS, or optimise the build). The Windows leg is now non-blocking and no longer drives the decision. The no-break trace (gsd-pi) passed on all three systems.

### Windows items that were already known

Unix socket versus named pipe for the Host (DESIGN A27), file-watch event loss on `ReadDirectoryChangesW` overflow (Reconcile covers it), CRLF and A19 hashing, case-insensitive paths, locked SQLite files while a connection is open (close databases before deleting temp directories).

## User-facing wording (required of plans 03-34 and 03-36; their plans are owned by another planner and were not edited here)

Windows is not supported in the alpha. The docs plans must state that. Sentences to add:
- `docs/reference/alpha-limitations.md` (03-36), under platforms: "Windows is not supported in the alpha. gsd-atlas is built and tested on macOS and Linux. The Windows CI jobs run but are allowed to fail, and known Windows failures are listed in the project's planning notes. Windows support is planned after the alpha."
- `README.md` line 7 (03-36 owns the README, at most 70 lines): replace "on macOS, Linux and Windows" and "on all three systems" with "on macOS and Linux (Windows is not supported in the alpha)" and "CI runs Node 24.16.0 and 26 on Linux and macOS".
- `docs/reference/cli.md` line 3 (Requirements): "macOS, Linux or Windows" becomes "macOS or Linux (Windows is not supported in the alpha)".
- `docs/how-to/contribute-a-change.md` line 63: "on Linux, macOS and Windows run the build" becomes "on Linux and macOS run the build; the Windows jobs run too but do not block (Windows is postponed past the alpha)".
- 03-34 (the alpha guide): add Windows to the "what is not supported" list so it is not discovered by failure.

Not rewritten by this decision (the target stays as history; ADRs are untouched and nothing is ratified): `docs/PRD.md:31` and `:370` (criterion 19), `docs/DESIGN.md` A13 and A50, `docs/DESIGN-REVIEW.md` O-1, and `docs/adr/{2-product-boundary,4-command-runner,5-language-modules,8-sqlite-store,9-tenant-composition,draft-host-process-model}.md`. When Windows work starts, decide whether each needs a dated amendment.

## Planning documents that still state the three-OS requirement as binding (not edited here; the user or a roadmapper decides)

- `.planning/REQUIREMENTS.md`: FND-01 (line 14), FND-04 (17), FND-11 (24).
- `.planning/ROADMAP.md`: Phase 1 goal (31) and success criteria 1, 2, 3 (36 to 38); Phase 2 goal (81) and criterion 1 (86); plan entries 01-03, 01-15, 01-16, 01-20, 02-26, 03-30 (lines 51, 66, 72, 77, 157, 227); the closing notes (340, 354). Phase 3 criterion 2 itself does not name the OSes; the three-OS requirement there comes from 03-CONTEXT D-10.
- `.planning/phases/03-typescript-module-and-mvp-eval/03-CONTEXT.md` D-10 (line 32, "gated two-tier on all three OSes") and 03-30-PLAN.md; 03-27-PLAN.md T-03-274 (the Windows kill semantics, now verified in practice).
