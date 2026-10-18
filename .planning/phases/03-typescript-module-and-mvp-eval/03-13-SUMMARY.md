---
phase: 03-typescript-module-and-mvp-eval
plan: 13
subsystem: security
tags: [command-runner, permissions, sha256, trust-boundaries, hostile-repo]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-08 trust-boundaries and command-runner ADR amendments"
provides:
  - "src/command-runner/hash.ts: canonicalCommand and commandHash (exact-argv approval hash, D-15)"
  - "UserPermissions.allow[].sha256 enforced by decide.userAllows (narrowing only)"
  - "src/host/config.ts strict schema accepts sha256 (64 lower-case hex); malformed value ignores the whole file"
  - "src/host/hostile-config.test.ts: SEC-01 acceptance test over a hostile fixture repository"
affects: [03-15 precise tier, 03-29 first real precise.command run, 03-35 scored run]

requirements-completed: [SEC-01, SEC-02]

status: complete
actuals:
  tokens: 7000
  tasks: 2
  commits: 2

plan_head_before: 455baaa40a3f4dc910e8ea67aea5602201c80bbc
plan_head_after: fc3ad0ab6741774fcb55d1e957170b4ac7176e43

tech-stack:
  added: []
  patterns:
    - "Approval hash = sha256 of JSON text {executable, args, cwd}; cwd is POSIX-relative to the repo root, null (no hash) when outside it"
    - "Hostile-repository test wraps the real decide in a recording runner and asserts on attempts, not only starts"

key-files:
  created:
    - src/command-runner/hash.ts
    - src/command-runner/hash.test.ts
    - src/host/config.test.ts
    - src/host/hostile-config.test.ts
  modified:
    - src/command-runner/spec.ts
    - src/command-runner/decide.ts
    - src/command-runner/decide.test.ts
    - src/command-runner/index.ts
    - src/host/config.ts

key-decisions:
  - "canonicalCommand and commandHash take an optional third argument, the platform path module, so the Windows backslash form is tested on any host with path.win32"
  - "A repo that is not an absolute path has no hash, so the result never depends on the process working directory"
  - "A directory merely named with a leading '..' (for example ..cache) is inside the repository; only '..' and '..<sep>' escape"

patterns-established:
  - "decide.ts and hash.ts import no fs; a test reads both files and asserts it"

coverage:
  - id: D1
    description: "User allow entries can bind to one exact command by hash; the real runner starts only the exact approved command"
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "src/command-runner/hash.test.ts (12 cases), src/command-runner/decide.test.ts 'exact-argv approvals' (12 cases) and 'real runner: an approval binds to one exact command' (4 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "sha256 in user config: accepted when 64 lower-case hex, malformed value ignores the whole file with one warning, old entries unchanged"
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "src/host/config.test.ts (5 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A hostile repository (module precise.command, repo config naming permissions, install scripts, tsconfig plugin) causes no process start but built-in git and no marker file"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/host/hostile-config.test.ts (5 cases)"
        status: pass
    human_judgment: false
---

# Phase 3 Plan 13: Exact-argv approvals and the SEC-01 hostile-repository test Summary

**User-level allow entries can now carry a sha256 over the canonical command (executable, args, cwd relative to the repo), enforced by `decide` with no file read, and a hostile fixture repository is proven to start nothing but built-in git.**

## Performance

- **Tasks:** 2 of 2 (Task 1 tracer, Task 2 auto)
- **Commits:** 2 (`5ed1d1c`, `fc3ad0a`)
- **Duration:** about 25 minutes

## Accomplishments

- `canonicalCommand(spec, repo)` returns the JSON text of `{executable, args, cwd}` in that key order, cwd POSIX-relative to the repository (`.` for the root or an absent cwd) and `null` when the cwd is outside the repository or the repo path is not absolute. `commandHash` is the lower-case hex sha256 of that text. `['a b']` and `['a','b']` hash differently.
- `decide.userAllows` recomputes the hash for the spec being started under `ctx.repo` whenever an entry has `sha256`, and requires it to match in addition to the executable, repo and optional `argsPrefix`. An entry without `sha256` behaves exactly as before; the hash can only narrow a match.
- The real runner test shows the approved command runs and prints `ok`, while one changed argument, a sub-directory cwd and a different `RunContext.repo` each give `command_denied` with nothing started.
- The user-config schema accepts `sha256: /^[0-9a-f]{64}$/`; a malformed value (upper case, wrong length, empty, number, trailing newline, `XYZ`) ignores the whole file with the existing single `user_config_ignored` warning and an empty config.
- `src/host/hostile-config.test.ts` composes a Host over a hostile repository (module with `precise.command: ['node','evil.js']`, `.gsd-atlas/config.json` naming permissions, diagnostics and commands, `package.json` install scripts, a `tsconfig.json` plugin, `.ts` sources) with a recording runner wrapping the real `decide`. Through `build`, `maintain all`, `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status` and `lang_list`, every attempted spec is `git` with decision `builtin`, and no `PWNED` marker exists.

## Task Commits

1. **Task 1: exact-argv approvals by command hash** - `5ed1d1c` (feat)
2. **Task 2: SEC-01 hostile-repository acceptance test** - `fc3ad0a` (test)

## Verification

- `node --test src/command-runner/hash.test.ts src/command-runner/decide.test.ts src/command-runner/runner.test.ts src/host/config.test.ts`: 204 pass.
- `node --test src/host/hostile-config.test.ts src/command-runner/hostile-repo.test.ts`: 25 pass.
- `node --test "src/command-runner/*.test.ts" "src/host/*.test.ts" "src/bin/*.test.ts"`: 449 pass, 0 fail.
- `npm run typecheck` and `npm run lint`: clean.
- `decide.ts` and `hash.ts` import no `node:fs` (asserted by a test in `decide.test.ts`).

## Decisions Made

See `key-decisions` above. No Rule 4 decision was needed.

## Deviations from Plan

### Adjustments

**1. [Plan wording] lang_list reason is a code, not a sentence**
- **Found during:** Task 2
- **Issue:** The plan asks for a reason "mentioning that the command needs approval from user-level configuration". The registry's tier reason is the code `command_not_approved`; the sentence lives in the `precise_command_inactive` info diagnostic ("... until user-level config approves it").
- **Fix:** The test asserts both the tier (`active: false`, reason `command_not_approved`) and the diagnostic text. No production change.

**2. [Placement] Real-runner tests live in `decide.test.ts`**
- **Issue:** The plan's behavior section describes a real-runner test, but its `files` list does not include `runner.test.ts`. The tests were added to `decide.test.ts` (a new describe block), so `runner.test.ts` is unchanged.

**3. [Process] RED and GREEN in one commit**
- The cases were written first and run red (the loader refused `sha256`, the hash exports were missing), then implemented; the plan asks for a single `feat` commit, so there is no separate RED commit.

None of these changed behavior beyond the plan.

## Known Stubs

None.

## Threat Flags

None. The new surface (an optional hash field in user-level config) is the plan's own threat-model subject (T-03-132 to T-03-134); the SEC-01 prohibition (T-03-131) is covered by the new acceptance test.

## Issues Encountered

None. The hostile-repository test passed on first run, as the plan expected (it protects behavior that already holds).

## Next Phase Readiness

Plans 03-15 and 03-29 must keep `src/host/hostile-config.test.ts` green. Plan 03-35 (the scored run) depends on this plan and can rely on `commandHash` for user-level approvals.

## Self-Check: PASSED

- FOUND: src/command-runner/hash.ts, src/command-runner/hash.test.ts, src/host/config.test.ts, src/host/hostile-config.test.ts
- FOUND commits: 5ed1d1c, fc3ad0a (ancestors of HEAD)
