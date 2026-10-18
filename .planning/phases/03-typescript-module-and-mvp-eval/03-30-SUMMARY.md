---
phase: 03-typescript-module-and-mvp-eval
plan: 30
subsystem: precise-tier-gates
tags: [gate, ci, nightly, two-tier, percentile, tsm-06, tdd]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-27 memory budget, latch and the --nobreak trace; 03-29 eager pass, incremental update, --update and --lazy; 03-16 frozen Stage A (D-08 precondition); 03-CONSTANTS.md Status Approved with the gate.* rows; Gate OQ2 Approved in 03-DECISIONS.md"
provides:
  - "scripts/precise-gate.ts --pr and --strict: build, one-file update and warm query measured through the composed Host and judged by the pure evaluate() against the approved gate.* ceilings"
  - "Exported constants BUILD_PR_CEILING_MS, UPDATE_PR_CEILING_MS, WARM_QUERY_PR_CEILING_MS, BUILD_STRICT_MS, UPDATE_STRICT_MS, WARM_QUERY_STRICT_MS, GATE_SAMPLES, evaluate, runGate, fixtureFiles, fetchCheckout"
  - "--nobreak fetches the pinned corpus when no --dir is given (the nightly gsd-pi step)"
  - "ci.yml gates job step 'Precise tier gate (pull request ceilings)' on ubuntu, macos, windows; nightly.yml strict job steps 'Precise tier gate (strict)' and 'gsd-pi no-break trace', plus the Windows runner-temp step"
  - "package.json script gates:precise; how-to section 'The precise tier gate'"
affects: [03-31, 03-34, 03-37]
tech-stack:
  added: []
  patterns:
    - "A gate's ceilings are constants named after approved rows, compared with the approval file by a test, with no flag that moves them"
    - "A gate that cannot take a sample throws and exits 1 with the reason; evaluate() throws on an empty or non-finite sample list"
    - "Workflow text is pinned by line-oriented tests: only three exact precise-gate commands may appear in any workflow"
key-files:
  created: []
  modified:
    - scripts/precise-gate.ts
    - scripts/precise-gate.test.ts
    - scripts/ci-config.test.ts
    - .github/workflows/ci.yml
    - .github/workflows/nightly.yml
    - docs/how-to/run-the-measured-gates-locally.md
    - package.json
key-decisions:
  - "The update sample appends a callee and a caller function to a different owned file each time and polls code_refs for the callee until a precise record whose enclosing function is the new caller appears. It is self-contained (no import into the traced file), so it works in any module system."
  - "Warm symbols are found after the build by one untimed look at candidate exported names (printed as firstLookMs, not a sample); the timed queries then cycle through ten that have a precise reference. The first look stays visible in the JSON line so a cold cost cannot hide."
  - "Without --dir the gate fetches the pinned corpus with scripts/corpus-fetch.ts and installs nothing, so the compiler is the bundled 6.0.3. --prepared runs npm ci --ignore-scripts (fetched) or links node_modules (--dir copy)."
  - "--nobreak without --dir now fetches the pinned corpus (the nightly step has no checkout of its own). The old usage error for a missing --dir is gone; a missing --corpus and a --dir that is not a git checkout still exit 2."
  - "Task 3 (push of ci/phase3-precise and the three-OS CI evidence) was not run by this executor; see Deferred."
requirements-completed: [TSM-06]
status: partial
commits: 4
plan_head_before: 6ef95cb5ea7199102e1672d4990d0a19f3c2f0bd
plan_head_after: 3a1eee17889afc0030b8c896d5696a6fec823033
actuals:
  tokens: 46000
  tasks: 2
  commits: 4
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 30: The precise tier gates in CI and nightly Summary

**`scripts/precise-gate.ts --pr|--strict` times a full gsd-core build, a one-file update and a warm query through the composed Host and judges them against the approved ceilings (median of 5 and p95 of 10 on a pull request; p95 of 20 and of 50 nightly); on this Mac the strict figures are 10.8 s, 307.5 ms and 83.7 ms, and both workflows now run it on all three operating systems. The first hosted three-OS run (Task 3) is not yet done.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | The gate measures a fixture repository's build, update and warm queries and judges them against a tier | 587581d | 0f268ff |
| 2 | Run on the pinned gsd-core, wire CI and nightly, update the how-to, test the workflow text | 975b6bb | 3a1eee1 |
| 3 | First three-OS CI run and the recorded timings | not run | not run |

Tracer gate (task type `tracer`, no `gate` attribute, auto mode not asked of this executor, automated-only `<verify>`): the verify command was re-run after the commit (the 18 tests of `precise-gate.test.ts`, the fixture run, typecheck) and passed, so execution continued to Task 2. Each RED commit holds tests only; RED was run before the change (`precise-gate.test.ts` could not load because `evaluate` and the constants did not exist; three of the new `ci-config.test.ts` cases failed). One test added with Task 1's GREEN commit (the `--nobreak` fetch path, below) describes behavior introduced there.

## What was built

- **`evaluate(measurements, tier)`** (pure). Per budget a verdict `{budget, key, statistic, samples, valueMs, ceilingMs, ok}`; the key is the 03-CONSTANTS.md row name. Build is one value; update is the median (pr) or p95 (strict); warm is the p95. Percentiles are the freshness gate's nearest-rank `percentile`. An empty sample list or a non-finite value throws.
- **Constants** equal to the approved rows (90000, 15000, 6000, 30000, 5000, 2000); `precise-gate.test.ts` reads 03-CONSTANTS.md and compares. There is no ceiling flag: an unknown flag, `--pr` with `--strict`, an unknown corpus or a zero sample count are usage errors (exit 2).
- **`runGate`.** Opens a workspace (the generated `fixture` repository, a copy of `--dir`, or the pinned corpus fetched by `scripts/corpus-fetch.ts` with nothing installed), keeps the source files a compiler config owns (the compiler-free ProjectModel, one `describe` for all), builds through `composeHost` (clock around the build request, eager pass included), looks once at candidate functions until ten have a precise record, times the warm `code_refs` cycle, then edits a different owned file per update sample and polls every 25 ms. A minute without the answer fails the gate. The JSON line carries the samples, `compiler` `{source, version}`, `warmSymbols`, `firstLookMs`, `workerPeakRssMb` and the verdicts; a breached verdict also prints `precise-gate: <key> breached: ...` on stderr.
- **Workflows.** `ci.yml` gates job: `Precise tier gate (pull request ceilings)` running `node scripts/precise-gate.ts --pr --corpus gsd-core` after the normal freshness gate and before the Windows diagnostic, plain (no `if`, no `continue-on-error`). `nightly.yml` strict job: `Precise tier gate (strict)` and `gsd-pi no-break trace` after the corpus gates, and the Windows runner-temp step before `npm ci`. Every `npm ci` keeps `--ignore-scripts`; the pull request workflow names neither `gsd-pi` nor a strict or no-break command.
- **`ci-config.test.ts`** gained cases titled `precise gate step in the gates job`, `all three operating systems run the precise gate` (also: only three exact `precise-gate.ts` commands may appear in any workflow), `strict and no-break steps in nightly` and the nightly Windows temp-folder step.
- **How-to** section 'The precise tier gate' (three commands, what each measures, how to read the JSON line, where the ceilings come from) and a `gates:precise` item under 'If a gate fails'.

## Local figures (pinned gsd-core 10ac3a7, macOS arm64, Node 26.11.1, bundled compiler 6.0.3)

| Tier | Build | Update | Warm query | Worker peak RSS | Verdict |
|------|-------|--------|------------|-----------------|---------|
| strict (20 updates, 50 warm) | 10,771.1 ms (ceiling 30,000) | p95 307.5 ms (ceiling 5,000) | p95 83.7 ms (ceiling 2,000) | 444.7 MB | pass |
| pr (5 updates, 10 warm) | 10,017.3 ms (ceiling 90,000) | median 277.3 ms (ceiling 15,000) | p95 78.3 ms (ceiling 6,000) | 440.3 MB | pass |

Compiler source `bundled`, version 6.0.3 (printed in the line). Warm symbols: ten; the untimed first looks took 68 to 95 ms. The gsd-pi no-break trace without `--dir` (fetch, 12 symbols, 29.1 s): exit 0, 0 crashed, 0 unexplained, worker peak 1,360.7 MB against a 32,768 MB limit on this machine, answers resolved or degraded with a code.

## Deviations from Plan

**1. [Rule 3 - Blocking] `--nobreak` fetches the pinned corpus when no `--dir` is given**
- **Found during:** Task 2 (the nightly step is `--nobreak --corpus gsd-pi` and a hosted runner has no checkout).
- **Fix:** `main` calls `fetchCheckout` (corpus-fetch, no install) and removes the folder afterwards. The existing test that expected exit 2 for `--nobreak --corpus gsd-pi` without `--dir` was changed to the cases that are still usage errors (no corpus; a `--dir` that is not a checkout), and a new test pins the fetch path through an injected `fetchCheckout` and `runNoBreak` (and that a failed fetch exits 1 with the reason).
- **Files:** scripts/precise-gate.ts, scripts/precise-gate.test.ts. **Commit:** 0f268ff.

**2. [Rule 2 - Missing critical] Windows runner-temp step in the nightly strict job**
- The plan says the gate uses the runner temp folder "as the other gates do"; `ci.yml` applies it to the test, grammar and gates jobs but the nightly strict job had none, so the strict freshness and precise gates would have measured the C: virtual disk (3 to 6 ms per synced file operation, `.planning/debug/windows-ci-diag.md`). The same three-line step was added before `npm ci` and a test pins it. This also changes where the nightly freshness gate's temporary files go on Windows (to the faster disk, as in the pull request job).
- **Commit:** 3a1eee1.

**3. [Interpretation] Update sample shape**
- The plan says "appending a function and a call". Each sample appends a callee and a caller to a different owned file (no import, so any module system works) and polls for the callee's precise record whose enclosing function is the caller; this is the "new definition's callers" of the measurement rule.

**4. [Interpretation] Warm samples start after an untimed first look**
- A warm query needs a function that has a precise reference. The gate picks them by asking once (untimed, printed as `firstLookMs`) rather than trusting a text match. The first looks cost 68 to 95 ms on gsd-core, so nothing is hidden.

**5. [Detail] `lint` covers `src` only**
- `npm run lint` is `eslint src`; the scripts are covered by `typecheck`. Both pass.

## Deferred: Task 3 (three-OS CI run and recorded timings)

Not run by this executor, for two reasons that are outside what the executor was handed: (a) it requires pushing a `ci/phase3-precise` branch to the shared `origin` (open-gsd/gsd-atlas) and `origin/main..HEAD` holds 16 unpublished commits, so the push would publish them (the plan's precondition says the human's request for plan execution authorises it, but that request was not part of this executor's brief); (b) plans 03-28 and 03-31 run in parallel and the evidence is more meaningful on the merged wave. Nothing else of Task 3 can be done locally.

To run it: push the merged branch as `ci/phase3-precise`; `gh run watch`; read each OS's `Precise tier gate (pull request ceilings)` JSON line from the `Gates` job log; `gh workflow run nightly.yml --ref ci/phase3-precise` and read the `Precise tier gate (strict)` and `gsd-pi no-break trace` lines of the three `Strict gates` jobs; fill a table (OS, build ms, update ms, warm ms, compiler source, pass or fail) for both workflows; record the Windows and Linux result of plan 03-27's sampler-kill test (research assumption A3); on a breach fix the cause in code with a test, never a ceiling, a sample count or a timeout; delete the branch afterwards. Risks to look for first: the 7 GB macOS runner derives a worker limit near 1.75 GB x 0.8, which the gsd-pi trace (1.36 GB resident here) may reach, giving a legitimate `memory_budget` degrade rather than a failure; the update clock on Windows depends on native watcher delivery (the pull request ceiling is 15 s, the strict one 5 s).

## Verification

`npm run typecheck`, `npm run lint`, `npm run build`, `npm run schema:check` clean. `npm test`: 4,186 tests, 4,184 pass, 0 fail, 2 skipped (both pre-existing); 18 in `precise-gate.test.ts` (10 new) and 40 in `ci-config.test.ts` (4 new cases pass after the workflow change). `node scripts/eval/verify-prereg.ts`: ok (no Stage A file touched). `node scripts/precise-gate.ts --pr --corpus fixture`: exit 0. No flaky test seen.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-03-301 (constants named after approved keys, compared with 03-CONSTANTS.md, no override flag, workflow text pinned to three exact commands), T-03-302 and T-03-SC (no dependency added; no install in the gate; `npm ci --ignore-scripts` asserted), T-03-303 (median and p95 on a pull request, strict only nightly), T-03-304 (the line prints counts, milliseconds, the compiler version and symbol names of public corpora) are as planned.

## Self-Check: PASSED

- Files present: scripts/precise-gate.ts, scripts/precise-gate.test.ts, scripts/ci-config.test.ts, .github/workflows/ci.yml, .github/workflows/nightly.yml, docs/how-to/run-the-measured-gates-locally.md, package.json.
- Commits 587581d, 0f268ff, 975b6bb and 3a1eee1 are ancestors of HEAD; `git rev-list --count 6ef95cb..HEAD` was 4 before this file was added.
