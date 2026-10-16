---
phase: 01-foundations-and-walking-skeleton
plan: 09
subsystem: command-runner
tags: [child-process, command-runner, permissions, git-allowlist, windows-shims, recording-fake, contract-suite]

requires:
  - phase: 01-03
    provides: boundary lint (child_process only in src/command-runner, production purity, contract.ts test-context blocks)
  - phase: 01-04
    provides: Diagnostic kernel type and the test-kit makeTempDir helper
provides:
  - "CommandRunner seam: CommandSpec (argv array, never a shell), CommandResult, CommandStream, Decision, UserPermissions"
  - "decide(spec, ctx, user): exact first-party git built-in table plus injected user permissions; no input through which repo data can grant anything"
  - "createRealRunner: decide, resolve, spawn with shell false; timeout and SIGKILL, stdout and stderr caps, batched stdin (string, bytes, async iterable), streaming stdout, spawn errors as results"
  - "createRecordingRunner: starts, denials, reset, script, respond, decide, delegate; stdin recorded as value or byte length"
  - "resolveExecutable with win32 rules injectable on any OS (.exe/.com only, shim_rejected for .cmd, .bat, npm, npx); scrubEnv inherit-then-denylist-then-overlay"
  - "Shared contract suite (SCENARIOS, defineCommandRunnerContract) run against both the fake and the real runner; test code, not exported from the index"
affects: [01-10, 01-13, phase-03]

plan_head_before: 8c9202eb4ca2e5b89d617f9ce2aa2a79b3d5b625
plan_head_after: 6b50f398e2c2a6fb9c73b271804e3e77e9b97959

actuals:
  tokens: 23000   # chars/4 over the 13 hand-written text files (about 1,900 lines)
  tasks: 2
  commits: 4      # MEASURED: git rev-list --count 8c9202e..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "One module owns child_process; permission is a pure function of (spec, ctx, injected user list), so the rule has one reviewable place"
    - "Contract suite parameterised by adapter factory (defineCommandRunnerContract), imported by the module's own tests as ./contract.ts and never exported"
    - "Platform-specific resolution logic takes platform, env and an existence function as parameters so Linux and macOS CI exercise the win32 rules"
    - "Portable test children: process.execPath with -e scripts and a -- separator; no test spawns npm, npx, a .cmd or a shell"

key-files:
  created:
    - src/command-runner/index.ts
    - src/command-runner/spec.ts
    - src/command-runner/decide.ts
    - src/command-runner/exec-resolve.ts
    - src/command-runner/env.ts
    - src/command-runner/real.ts
    - src/command-runner/fake.ts
    - src/command-runner/contract.ts
    - src/command-runner/runner.test.ts
    - src/command-runner/decide.test.ts
    - src/command-runner/exec-resolve.test.ts
    - src/command-runner/env.test.ts
    - src/command-runner/real.test.ts
  modified: []

key-decisions:
  - "Git -c overrides are allowlisted by key AND value, and every allowed value only switches repo-controlled execution off (core.fsmonitor=false, core.hooksPath empty or null device, filter.<name>.clean/smudge/process empty, filter.<name>.required empty or false, core.quotepath on/off). A bare key allowlist would let a script path as the fsmonitor value run code."
  - "The git built-in is the bare executable name git; an absolute path to git is not a built-in and needs a user permission."
  - "cat-file --textconv/--filters, hash-object -w and any --help are denied: the first two run repo-configured drivers, -w writes to the object database, --help execs a pager."
  - "resolveExecutable returns { ok, path } or { ok: false, diagnostic } rather than a bare string or Diagnostic, so callers cannot confuse the two."
  - "Result carries both denied/spawnError (the headline diagnostic) and a diagnostics array (everything incl. timeout and caps); stderr overflow is a warning and does not fail the run, stdout overflow is an error, kills the child and sets ok false."
  - "In stream() mode stdout bytes are delivered through the iterable only; result.stdout is empty, so a long stream is never held twice in memory."
  - "The plan's 60 s default per-spec timeout is NOT set; see Deviations. timeoutMs per spec works and is tested."

patterns-established:
  - "Deny by returning a result, not by throwing: denied, spawn_failed and shim_rejected all come back as a CommandResult carrying a Diagnostic"
  - "Fake mirrors the real runner's observable shape (denial result, empty stdout on stream) so the same contract holds"

requirements-completed: [FND-05, FND-06]

coverage:
  - id: D1
    description: "CommandRunner seam with a recording fake and one shared contract suite run against both adapters"
    requirement: FND-05
    verification:
      - kind: unit
        ref: "src/command-runner/runner.test.ts#CommandRunner contract: fake / CommandRunner contract: real"
        status: pass
    human_judgment: false
  - id: D2
    description: "Only a spec that exactly matches a first-party built-in, or a user-permitted command for that repo, runs; a denial starts nothing and names permissions.commands"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/command-runner/decide.test.ts"
        status: pass
      - kind: unit
        ref: "src/command-runner/contract.ts#a denied spec starts nothing (marker file absent on the real runner)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Full runner surface: timeout and kill, stdout cap kill, stderr cap, batched stdin in three shapes, streaming, spawn errors as results"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/command-runner/real.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Windows executable resolution rejects .cmd, .bat and npm shims (exercised on every OS by platform injection); no shell, no string-command API, process module imported only here"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/command-runner/exec-resolve.test.ts; src/command-runner/real.test.ts#no shell and no shim; src/lint/boundaries.test.ts"
        status: pass
    human_judgment: true
    rationale: "The win32 rules are proven by injection on posix; the first real Windows CI run is the only evidence that actual Windows PATH and .exe behaviour matches."
  - id: D5
    description: "Environment policy: inherit minus git redirection variables and secret-looking names, then overlay"
    requirement: FND-06
    verification:
      - kind: unit
        ref: "src/command-runner/env.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Default per-spec wall-clock timeout (plan asked for 60 s)"
    requirement: FND-06
    verification: []
    human_judgment: true
    rationale: "A repo guard blocks setting a new timeout constant without a human typing a confirmation phrase; the default is deliberately not set. See Deviations."

duration: 56min
completed: 2026-10-16
status: complete
---

# Phase 1 Plan 09: CommandRunner Seam Summary

**A single child-process module whose permission rule is a pure function (exact git allowlist with key-and-value-checked `-c` overrides, or an injected user list), a real adapter with the whole D-11 surface, a recording fake, and one contract suite proven against both.**

## Performance

- **Duration:** 56 min
- **Started:** 2026-10-16T01:12:00Z (approximate)
- **Completed:** 2026-10-16T02:09:00Z
- **Tasks:** 2 (a tracer and an auto task)
- **Files created:** 13 (all under `src/command-runner/`)

## Accomplishments

- `decide` is the only place permission is decided. Denial messages read `<exe> <first two args> was not started: it is not a first-party built-in; to allow it for this repo add it under permissions.commands in ~/.config/gsd-atlas/config.json`.
- The real runner never uses a shell: `spawn(resolved, args, { shell: false, windowsHide: true, ... })`. A source-level test asserts there is no `shell: true`, no `exec*` call, and `spawn` is the only import from the process module; a tree walk confirms no other file imports it.
- Windows resolution considers only `.exe`/`.com`, refuses `.cmd`, `.bat`, `npm`, `npx` (even `npm.exe`), finds `Path`/`PATH` case-insensitively, and is tested on every OS through an injected platform and an injected existence function.
- The contract suite (hostile arguments, exit code 3, stdin, denial-starts-nothing via a marker file) passes on the recording fake and on the real runner. 450 tests pass repo-wide; typecheck, lint and `npm run build` are clean and the compiled package contains no `contract.js`.

## Task Commits

1. **Task 1: Tracer (git --version through decide and the real runner, denial, shared contract)**
   - `1ed6c9d` test: RED (decide tests, recording-fake tests, contract suite)
   - `b59f8b2` feat: GREEN (spec, decide, env, real runner, fake, index)
2. **Task 2: Streaming, batched stdin, caps, timeout and kill, spawn errors, Windows resolution**
   - `f80ef6c` test: RED (real-runner behaviour tests, win32 resolution tests, env tests)
   - `6b50f39` feat: GREEN (win32 branch of `resolveExecutable`)

**Plan metadata:** the SUMMARY commit that follows this file.

## Files Created/Modified

- `src/command-runner/spec.ts` - types, default caps, diagnostic codes, result constructors
- `src/command-runner/decide.ts` - built-in table, git parsing, user permission check, `allowAll` (test-only)
- `src/command-runner/exec-resolve.ts` - posix and win32 executable resolution
- `src/command-runner/env.ts` - `scrubEnv`
- `src/command-runner/real.ts` - the real adapter; the only file that imports `node:child_process`
- `src/command-runner/fake.ts` - the recording fake
- `src/command-runner/contract.ts` - shared contract suite (test code, not exported)
- `src/command-runner/index.ts` - production surface only
- `src/command-runner/{runner,decide,exec-resolve,env,real}.test.ts` - tests

## Decisions Made

See `key-decisions` in the frontmatter. The two with the most downstream weight: the `-c` value allowlist (plan 01-13's hardened git specs must stay inside it, or amend `decide.ts` deliberately), and `resolveExecutable`'s `{ ok }` return shape.

## Deviations from Plan

### Held back: the 60 s default timeout

**1. [Blocked by guard - needs human confirmation] No default per-spec timeout**
- **Found during:** Task 1 (writing `spec.ts`)
- **Issue:** The plan asks for a `timeoutMs` default of 60 seconds. A repo pre-write guard blocks any new timeout-shaped constant (the default itself, and later a runner-level default option set to a number in a test) unless a human types an exact confirmation phrase in the conversation. I did not rename or restructure the value to get around it.
- **Fix:** Shipped without a default. `timeoutMs` per spec works (SIGKILL, `timedOut`, `timeout` diagnostic, child verified gone) and is tested. A spec with no `timeoutMs` has no wall-clock limit; the stdout and stderr caps still bound memory.
- **To finish:** a human confirms the 60 s value (the guard's message names the exact phrase to type for the constant `DEFAULT_TIMEOUT_MS`), then a follow-up adds the constant to `spec.ts`, makes `real.ts` use `spec.timeoutMs ?? <that constant>`, and adds one test that a spec without `timeoutMs` is stopped. T-01-21 is fully mitigated only after that; until then it relies on callers passing `timeoutMs`.
- **Files:** `src/command-runner/spec.ts`, `src/command-runner/real.ts`

### Auto-fixed / in-scope adjustments

**2. [Rule 1 - Bug] Object-literal lookup would have allowed `-c constructor=...`**
- **Found during:** Task 1 (own review of `decide.ts`)
- **Issue:** The `-c` key table was first an object literal; indexing it with `constructor` resolves to an inherited function and would have returned a truthy "validator".
- **Fix:** Replaced with a `Map`. **Commit:** `b59f8b2`.

**3. [Process] Extra test file and TDD shape**
- The plan lists `runner.test.ts` for the real-adapter behaviour tests; they live in a new `real.test.ts` to keep each file focused. Because the tracer's `real.ts` already carried the shared machinery (timeouts, caps, streaming), Task 2's real-runner tests passed immediately; only the Windows resolution tests were genuinely RED before the GREEN commit.
- Hooks were not bypassed anywhere.

**Total deviations:** 1 held back for human confirmation, 1 auto-fixed, 1 process note. **Impact:** FND-05 and FND-06 behaviour is complete except the numeric default timeout.

## Issues Encountered

- A repo guard blocked reads and bash access to indexed source files until a CodeGraph index existed in the worktree; ran `codegraph init -y` per the global instructions. `.codegraph/` is untracked and was not committed.

## Known Stubs

None.

## Threat Flags

None. The surface added is exactly the plan's threat model (T-01-20 to T-01-23); mitigations: argv arrays with shell false and the exact built-in table (T-01-20), caps and per-spec timeout (T-01-21, default pending), shim rejection (T-01-22), `scrubEnv` (T-01-23).

## Next Phase Readiness

Plan 01-13 (Source Tree, hostile-repo test, `git-spec.ts`) can build specs against `decide`. It must keep `-c` values to the allowed set, and git invocations must use the bare executable `git`. The recording fake exposes `starts` and `denials` for the zero-starts assertion.

## Self-Check: PASSED

- Created files exist: all 13 under `src/command-runner/`.
- Commits `1ed6c9d`, `b59f8b2`, `f80ef6c`, `6b50f39` are ancestors of HEAD.
- `npm test` (450 pass), `npm run lint`, `npm run typecheck`, `npm run build` all clean.
