---
phase: 03-typescript-module-and-mvp-eval
plan: 19
subsystem: command-runner
tags: [command-runner, builtin-shape, compiler-worker, stdin-queue, security, long-lived-child]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-13 and 03-16 (Stage A frozen, D-08 satisfied); 03-08 ADR 4 amendment (typescript-resolver built-in); 03-01 Gate OQ2 Approved"
provides:
  - "src/command-runner/builtins.ts: matchShape and compilerWorkerShape (id typescript-resolver, heap flag of 1 to 6 digits, worker path literal, env key GSD_ATLAS_WORKER matching ^1$)"
  - "src/command-runner/async-queue.ts: createAsyncQueue for feeding stream() stdin"
  - "decide(spec, ctx, user, shapes) and createRealRunner/createRecordingRunner option builtinShapes; a runner built without shapes behaves as before"
  - "minimalEnv: a shape-matched built-in gets a minimal inherited environment (T-03-192)"
  - "echo-worker.mjs fixture and proof of a long-lived duplex child: stdin stream, uncapped stdout per spec, exit on stdin end, kill, no orphan after SIGKILL of the parent"
affects: [03-23 worker protocol, 03-27 in-worker memory sampler, 03-30]

requirements-completed: [TSM-05]

status: complete
actuals:
  tokens: 13200
  tasks: 2
  commits: 2
plan_head_before: a4a757a43f20c882ad3c398b4fac2b1c0df242df
plan_head_after: d2f2ed5dcd7ce5c6a8dd467c11f9dc1bba28b44d

key-files:
  created:
    - src/command-runner/builtins.ts
    - src/command-runner/builtins.test.ts
    - src/command-runner/async-queue.ts
    - src/command-runner/async-queue.test.ts
    - src/command-runner/__fixtures__/echo-worker.mjs
  modified:
    - src/command-runner/spec.ts
    - src/command-runner/decide.ts
    - src/command-runner/decide.test.ts
    - src/command-runner/real.ts
    - src/command-runner/real.test.ts
    - src/command-runner/fake.ts
    - src/command-runner/index.ts
    - src/command-runner/env.ts
    - src/command-runner/env.test.ts

key-decisions:
  - "decide's fourth parameter is a defaulted parameter (shapes = NO_SHAPES), so decide.length stays 3 and the existing test that pins 'no parameter through which repo data can grant permission' passes unchanged"
  - "The shape's env keys are an upper bound, not a requirement: a spec with no env is allowed; any key outside the shape, or a value that does not match its anchored pattern, is denied"
  - "A shape claiming the id git is ignored by decide: the git built-in cannot be widened through the table"
  - "The environment of a shape-matched built-in is built by minimalEnv (HOME, USERPROFILE, TMPDIR, TMP, TEMP, LANG, LC_ALL, LC_CTYPE, TZ, SYSTEMROOT, WINDIR plus the spec's own keys); PATH is deliberately not inherited because the executable is an absolute path"
---

# Phase 3 Plan 19: Exact-shape built-in for the compiler worker Summary

**The CommandRunner now starts exactly one more kind of process, the TypeScript worker, only through an injected table of exact shapes, and a long-lived duplex child is proven to work through it with no orphans and no surprise kills.**

## What was done

- Gate check: `Gate OQ2 (D-21 deviation): Approved` is in 03-DECISIONS.md and `docs/eval/preregistration.md` reads `Status: Frozen (Stage A`; both preconditions met.
- Task 1 (tracer): `BuiltinShape` in `spec.ts`; `matchShape` (claimed id, exact executable string, same argument count, literal or anchored pattern per argument, only listed env keys with matching values) and `compilerWorkerShape`; `createAsyncQueue`; `decide` consults the injected table after git, only for a spec that claims a shape id; `builtinShapes` on the real and recording runners; exports from `index.ts`. 30 `denies` / allow cases in `builtins.test.ts` (each deviation in the plan has its own test, plus sign/space/newline in the heap size, other worker file, relative path, extra leading flag, DYLD/PATH/`__proto__` env keys, shapes not passed, empty table, other id, `git` claimed). Real-runner round trip: lines `one`, `two` come back as `ONE\nTWO\n`, `queue.end()` makes the worker exit 0 with signal null, `kill()` ends it with a signal.
- Task 2: 20 MiB talker killed at the default cap (`truncated`, `output_cap_exceeded`, exactly 16 MiB kept); raised `maxStdoutBytes` receives all 20 MiB and still echoes; fifty round trips with the unread-byte counter (`bufferedStdoutBytes`) at 0 and no diagnostics; exit within the 2000 ms kill grace after stdin ends; `kill()` leaves no process (ESRCH); stderr capped at 1 MiB without killing; parent killed with SIGKILL leaves no worker (the parent script uses the real runner and a never-ending stdin).
- The environment case exposed a real gap: the inherited-then-denylist environment passes `NODE_OPTIONS`, `LD_PRELOAD` and `DYLD_INSERT_LIBRARIES` through (the dyld loader even refused to start the worker). Fixed in `real.ts` with `minimalEnv` for shape-matched built-ins; git keeps the scrubbed environment.

## Verification

typecheck, lint and build clean. `npm test`: 3444 tests, 3443 pass, 0 fail, 1 skipped (pre-existing skip). `node scripts/eval/verify-prereg.ts`: ok (no Stage A file touched). `real.test.ts` run three times in a row, 38/38 each time. The boundary test `MODULES.length` is 22 and was not changed (no module added). `decide.ts` imports no `node:fs`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Minimal environment for the worker**
- **Found during:** Task 2 (`environment is minimal` case)
- **Issue:** `scrubEnv` is a denylist; `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `DYLD_*` are not on it, so a parent environment carrying them reached the worker (T-03-192 requires the caller to supply a minimal environment and a test to prove it).
- **Fix:** `minimalEnv` in `env.ts` (allowlist of inherited names) used by `real.ts` when the decision is a built-in whose id is in `builtinShapes`; executable resolution still uses the scrubbed environment.
- **Files modified:** src/command-runner/env.ts, src/command-runner/env.test.ts, src/command-runner/real.ts
- **Commit:** d2f2ed5

### Plan-list differences (no behavior change)

- Added `src/command-runner/async-queue.test.ts` (queue behavior cases) and tests in `env.test.ts`, neither in the plan's `files_modified`; `env.ts` and `real.ts` (exported `bufferedStdoutBytes`, the "buffered-byte counter exposed for the test") carry the Task 2 fix.
- The two plan commits are the only code commits; tests were written and seen red before each implementation, but per the plan's commit messages each task is one commit.
- Test shapes extend the production shape's env keys (`ECHO_*`) so the echo worker can be asked for behavior; the production `compilerWorkerShape` lists only `GSD_ATLAS_WORKER`.

## Known Stubs

None.

## Threat Flags

None. T-03-191 (exact-shape matching, at least twelve deviation tests), T-03-192 (shape env upper bound plus `minimalEnv`, environment-printing test), T-03-193 (exit on stdin end, kill, parent-death test) and T-03-194 (per-spec cap, default cap pinned) are covered by tests.

## Self-Check: PASSED

All listed files exist; commits 900419e and d2f2ed5 are ancestors of HEAD.
