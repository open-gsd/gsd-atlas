---
phase: 02-grammar-tier-store-and-stdio-host
plan: 22
subsystem: cli
tags: [cli, exit-codes, mcp-parity, metrics-status, bin-wiring, walking-skeleton]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "Host request kinds and diagnostics (02-20), runInit and CliIo.init (02-21), TOOLS and buildRequest (02-16), metrics report (02-10)"
provides:
  - "CLI commands find, refs, context, impact, health, build, maintain, status next to init, lang list and lang test, driven by one command table"
  - "Exit codes 0, 1, 2 and 3 as a pure function of the envelope's diagnostics (exitCodeFor)"
  - "gsd-atlas bin supplying io.cwd and io.init, so gsd-atlas init works from the installed package"
  - "CLI-layer walking skeleton (build then find, refs, context, impact, health, status, maintain) over the real composed Host"
affects: [02-23 MCP shim parity, 02-28 metrics recording, 02-27 follower overlay, phase 4 transport, README and skills command documentation]

actuals:
  tokens: 18000
  tasks: 3
  commits: 6
plan_head_before: e194276a7e490fedea8499bafff2127fce95908d
plan_head_after: d634bc13f9a884ff4574a11a97806f1b4ae3955c

tech-stack:
  added: []
  patterns:
    - "Table-driven CLI: one flag table and one command table; allowed flags per command are data, so every command rejects a flag it does not use"
    - "Tool commands validate against the MCP tool's own zod schema and send buildRequest's output, so CLI and MCP requests are identical by construction"
    - "stdout is the Host's envelope unchanged, one JSON line; stderr reasons are one sanitized line per error or warning diagnostic"

key-files:
  created:
    - src/cli/exit.ts
    - src/cli/tool-commands.ts
    - src/cli/exit.test.ts
    - src/cli/tools.test.ts
    - scripts/cli-e2e.test.ts
    - scripts/cli-bin.test.ts
  modified:
    - src/cli/index.ts
    - src/cli/cli.test.ts
    - src/bin/gsd-atlas.ts

key-decisions:
  - "exitCodeFor precedence is usage (invalid_args, module_not_found), then lease_held or busy, then any other failure, then ok; a busy or lease_held diagnostic wins over other errors in the same envelope"
  - "maintain takes its task only as a positional (default all); there is no --task flag; --full is accepted only for compact and all"
  - "health with --cwd validates the schema without cwd (atlas_status is repo-only) but sends cwd, which the Host accepts and strips"
  - "The CLI never re-renders the status envelope: overflow flags and the estimate label reach scripts exactly as the Metrics report carries them"

patterns-established:
  - "Adapter tests that need the real stack live under scripts/ because the adapter lint allows src/cli tests to import only host-client"
  - "A spawned-bin test passes HOME, USERPROFILE and GSD_ATLAS_USER_DIR through the CommandRunner env overlay and compares full repository listings before and after"

requirements-completed: [QRY-04, MET-02, STO-10, HST-04]

coverage:
  - id: D1
    description: "Every MCP tool has a CLI twin (find, refs, context, impact, health) that sends the request buildRequest builds and prints the Host's envelope as one JSON line"
    requirement: QRY-04
    verification:
      - kind: unit
        ref: "src/cli/tools.test.ts#refs, context and impact: request equality with buildRequest"
        status: pass
      - kind: unit
        ref: "src/cli/cli.test.ts#runCli find"
        status: pass
      - kind: e2e
        ref: "scripts/cli-e2e.test.ts#CLI walking skeleton: refs, context, impact, health, status and maintain"
        status: pass
    human_judgment: false
  - id: D2
    description: "Exit codes 0, 1, 2 and 3 are a pure function of the envelope's diagnostics, with a table test over every code the Host and Query emit"
    requirement: QRY-04
    verification:
      - kind: unit
        ref: "src/cli/exit.test.ts#exitCodeFor: one assertion per diagnostic code the Host and Query emit"
        status: pass
      - kind: unit
        ref: "src/cli/cli.test.ts#runCli busy and lease_held"
        status: pass
    human_judgment: false
  - id: D3
    description: "build creates the index (the only way one is created) and maintain runs reconcile, resolve, refresh, collect, compact, check or all, exiting 3 on a follower"
    requirement: STO-10
    verification:
      - kind: e2e
        ref: "scripts/cli-e2e.test.ts#CLI with two processes on one repository (QRY-04 concurrency edge)"
        status: pass
      - kind: e2e
        ref: "scripts/cli-e2e.test.ts#maintain runs every task by default and each task by name"
        status: pass
    human_judgment: false
  - id: D4
    description: "status prints the metrics panels with token figures labelled estimate and exits 0 even when recording is off"
    requirement: MET-02
    verification:
      - kind: unit
        ref: "src/cli/tools.test.ts#status --since"
        status: pass
      - kind: e2e
        ref: "scripts/cli-e2e.test.ts#status prints the metrics panels with the token figures labelled estimate, and exits 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "The bin passes the real home, working directory, platform, environment and MCP launch command, so gsd-atlas init works from the bin and Phase 1 commands are unchanged"
    requirement: HST-04
    verification:
      - kind: integration
        ref: "scripts/cli-bin.test.ts#gsd-atlas bin: init and the working directory"
        status: pass
      - kind: e2e
        ref: "src/lang/lang-test.e2e.test.ts (Phase 1 lang commands as real processes)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The three-OS behaviour of the CLI walking skeleton and the spawned bin"
    verification: []
    human_judgment: true
    rationale: "Only macOS ran locally; Linux and Windows results (path resolution, spawned bin, HOME and USERPROFILE) rest on the three-OS CI run."

duration: 11min
completed: 2026-10-17
status: complete
---

# Phase 2 Plan 22: CLI Tool Commands, Exit Codes and Bin Wiring Summary

**Table-driven CLI with find, refs, context, impact, health, build, maintain and status, requests built by the MCP adapter's own `buildRequest`, exit codes 0 to 3 from the envelope's diagnostics, and a bin that supplies `io.init` and `io.cwd`.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-10-17T00:13:24Z
- **Completed:** 2026-10-17T00:24:41Z
- **Tasks:** 3 (each a RED test commit and a GREEN feat commit)
- **Files modified:** 9 (6 created, 3 modified)

## Accomplishments

- **MCP parity is structural.** Tool commands validate their input with the zod schema from `TOOLS` and send `buildRequest(tool, input)`; the tests assert request equality with `buildRequest` for find, refs, context, impact and health, including `budget` to `budget_tokens`, repeatable `--fresh`, and `cwd` unset when only `--repo` is given.
- **Exit codes 0, 1, 2, 3.** `exitCodeFor` is a pure function (usage, then lease/busy, then failure, then ok) with one assertion per diagnostic code the Host, Tenant, Query and language provider emit. The busy reason line repeats `retry_after`.
- **Index commands.** `build` (the only way an index is created), `maintain [task] [--full]` (all six tasks and `all`; exit 3 on a follower) and `status [--since]` (default 7d, `30m`/`24h`/`7d`/`30d` accepted) are in the same table; `health` and `status` are distinct on purpose (health is the `atlas_status` envelope, status is the CLI-only metrics panels).
- **Walking skeleton at the CLI layer.** `scripts/cli-e2e.test.ts` builds a three-file repository through `runCli` over the real composed Host (real runner, pooled engine, Governor, Tenant, store, Query), then runs find, refs, context, impact (import chain a, b, c, hops 1 and 2), health, status and maintain, parsing each stdout as exactly one JSON line; a second Host over the same repository proves the follower path (find answers with `degraded: follower`, build and maintain exit 3 with `lease_held`).
- **Bin wiring.** `src/bin/gsd-atlas.ts` passes `io.cwd` and `io.init` (`os.homedir()`, cwd, platform, env, `process.execPath` plus the absolute `gsd-atlas-mcp` file beside the running bin, `.ts` or `.js` to match). A spawned-bin test proves `init --dry-run --agent claude` reports `updated`, exits 0, leaves `.claude.json` and the repository listing untouched.

## Task Commits

1. **Task 1: Tracer - build then find through runCli over the real composed Host**
   - RED `8a72d30` (test), GREEN `ba00600` (feat)
   - Tracer gate: auto mode off, `human_verify_mode` end-of-phase, automated-only verify: re-ran `node --test scripts/cli-e2e.test.ts src/cli/cli.test.ts src/lang/lang-test.e2e.test.ts`, typecheck and lint end to end; passed, expansion followed.
2. **Task 2: refs, context, impact, health, maintain and status** - RED `79abb52`, GREEN `f81dd6b`
3. **Task 3: Exit code 3, the diagnostic-to-exit table and the bin wiring** - RED `f36fa94`, GREEN `d634bc1`

**Plan metadata:** the docs commit that adds this summary.

## TDD Gate Compliance

All three tasks have a `test(02-22)` commit before the `feat(02-22)` commit. RED evidence was classified with `gsd_run check tdd-red-evidence` (`RED_EVIDENCE_OK`, `target_test_failed`); records are kept untracked as `.planning/red-evidence-02-22-t1.json`, `-t2.json`, `-t3.json` and `-t4.json`.

- **RED t1:** `runCli find > sends exactly the request the MCP adapter builds ...` in `src/cli/cli.test.ts` failed at the exit-code assertion (find was an unknown command, exit 1 instead of 0). Semantic assessment: the file loaded, the recording client ran, the planned assertion failed; not a load or fixture fault.
- **RED t2:** `refs request equals buildRequest(code_refs) ...` in `src/cli/tools.test.ts` failed the same way (refs not in the table). The e2e cases for refs, context, impact, health, status and maintain also failed before the table rows existed.
- **RED t3:** `a busy reply is printed unchanged, its stderr line carries busy and retry_after ...` passed the exit-code and stdout assertions and failed on the planned `/250/` stderr assertion.
- **RED t4:** `init --dry-run --agent claude ...` in `scripts/cli-bin.test.ts` ran the spawned bin and failed on the exit-code assertion because `io.init` was not wired (`init is not available in this build`).

## Files Created/Modified

- `src/cli/exit.ts` - `EXIT_OK`, `EXIT_USAGE`, `EXIT_FAILURE`, `EXIT_LEASE_HELD`, `exitCodeFor`
- `src/cli/tool-commands.ts` - flag table, `COMMANDS`, `resolveCommand`, `unusedFlag`, `inputFromFlags`, `requestFor`, `MAINTAIN_TASKS`
- `src/cli/index.ts` - table-driven dispatch, one `send` for stdout/stderr rules, usage text built from the table, one-line sanitized reasons, `busy` retry hint
- `src/bin/gsd-atlas.ts` - builds `io.cwd` and `io.init`
- `src/cli/exit.test.ts`, `src/cli/tools.test.ts`, `src/cli/cli.test.ts` - unit tests with a recording HostClient
- `scripts/cli-e2e.test.ts` - walking skeleton over the real composed Host, including the follower cases
- `scripts/cli-bin.test.ts` - the spawned bin: init dry run, real init write, version, help, exit codes across the process boundary

## Decisions Made

- `exitCodeFor` precedence: usage codes (1), then `lease_held` or `busy` (3, even with other errors), then failure (2), then ok (0). A not-ok envelope without a diagnostic list is a failure.
- `maintain` takes the task as a positional only (default `all`). The plan's flag list read `--task (positional for maintain)`, so no separate `--task` flag exists. `--full` with any task other than `compact` or `all` is a usage error; `maintain --full` alone means `all`.
- `health --cwd`: `atlas_status`'s schema lists only `repo`, so the CLI validates without `cwd` for that tool but still sends it (the Host reads `repo` and `cwd` for every repo kind and strips both before Query).
- The CLI prints the Host's envelope untouched. The Metrics report already carries `overflow: true` with the largest finite edge and `tokens.label: "estimate"`, so scripts see the honest values; a unit test pins that an overflow histogram reaches stdout unchanged.
- `CliIo.cwd` is optional and defaults to `path.resolve('.')`; relative `--repo` and `--cwd` resolve against it. The Phase 1 root flags keep resolving against the process working directory, byte-compatible.
- Diagnostic reasons on stderr and usage-error reasons have control characters replaced by spaces, so one diagnostic is always one line (T-02-77).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] RED commits carry the exit module and the index re-exports**
- **Found during:** Task 1 (RED)
- **Issue:** `cli.test.ts` imports `EXIT_LEASE_HELD` from `./index.ts`; with the export missing the whole file failed to load, which is an invalid RED (a load fault, not a failed assertion).
- **Fix:** the Task 1 RED commit includes `src/cli/exit.ts` and the `index.ts` re-export/import of the exit constants, so the target test loads and fails on its planned assertion.
- **Files modified:** `src/cli/exit.ts`, `src/cli/index.ts`
- **Verification:** `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK`.
- **Committed in:** `8a72d30`

**2. [Rule 2 - Missing Critical] One-line stderr reasons**
- **Found during:** Task 3
- **Issue:** the plan promises one stderr line per diagnostic; a message containing a line break (or a usage error quoting user input) would break the line-oriented contract and let a hostile string forge reason lines.
- **Fix:** `oneLine` replaces control characters, C1 controls and U+2028/2029 with spaces in diagnostic and usage-error text; covered by a test.
- **Files modified:** `src/cli/index.ts`, `src/cli/cli.test.ts`
- **Committed in:** `ba00600`, `f81dd6b`

### Structure notes (not deviations)

- Each task has a RED `test(02-22)` and a GREEN `feat(02-22)` commit (six commits) instead of the single commit per task the plan text names, as the TDD gate requires.
- The plan's `files_modified` lists `src/cli/exit.test.ts`, `cli.test.ts`, `tools.test.ts` and `scripts/cli-e2e.test.ts` and `scripts/cli-bin.test.ts`; all were produced. Test-only helpers (`makeWorld`, `runWith`) are exported from `scripts/cli-e2e.test.ts` for reuse by later CLI-layer tests.

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical)
**Impact on plan:** no scope change; both keep the RED evidence valid and the stderr contract true.

## Issues Encountered

- **Status panels read zeros until plan 02-28.** `Metrics.record` has no production caller yet (02-28 wires `answerEvent` in the Tenant and the Indexer notice). After build and find, `gsd-atlas status` shows `answers.total` 0, `recording: true`, `tokens.label: "estimate"`. The command, schema and labelling are complete; the figures arrive with 02-28. The e2e test asserts shape and labels, not counts, for that reason.
- **Known hazard, recorded not fixed:** four simultaneous fresh-bearing requests at concurrency 4 degrade with `fresh_timeout` (fairness is HRD-05). Not exercised by this plan.
- **Platform evidence:** all runs were on macOS arm64 (Node 26). The spawned-bin test sets `HOME` and `USERPROFILE`; Linux and Windows results depend on the three-OS CI.
- The earlier note in `deferred-items.md` about `tsc` missing in this worktree no longer applies: `npm test` passed all 2,024 tests, including `scripts/package.test.ts`, with `npm run build` succeeding.

## Known Stubs

None. No placeholder values flow to output.

## Threat Flags

None. The only new surface is command-line arguments becoming Host requests, covered by T-02-76 to T-02-78 (strict parseArgs, shared zod schemas, no shell, Host re-validation; envelope unchanged on stdout and one sanitized line per reason on stderr; the bin disposes the Host in `finally`).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The MCP shim (02-23) can reuse `TOOLS` and `buildRequest` with the same request equality the CLI tests pin.
- 02-28 should record answers and freshness events so `gsd-atlas status` shows counts; `maintain` already runs reconcile, resolve, refresh, collect, compact and check through the CLI, so its idle-loop scheduling needs no CLI change.
- README and skills documentation of the command and exit-code contract is still to be written (the contract is the user-facing surface named "costly" in Task 1).

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-17*

## Self-Check: PASSED

- Created files exist: `src/cli/exit.ts`, `src/cli/tool-commands.ts`, `src/cli/exit.test.ts`, `src/cli/tools.test.ts`, `scripts/cli-e2e.test.ts`, `scripts/cli-bin.test.ts` (all found on disk).
- Commits reachable from HEAD: `8a72d30`, `ba00600`, `79abb52`, `f81dd6b`, `f36fa94`, `d634bc1`.
- Verification: `node --test "src/**/*.test.ts" "scripts/**/*.test.ts"` 2,024 pass, 0 fail; `npm run typecheck`, `npm run lint` and `npm run build` exit 0.
- Acceptance criteria: `EXIT_LEASE_HELD` is 3; `tool-commands.ts` imports only `../host-client/index.ts` (plus `node:path`); the e2e test parses stdout with `JSON.parse` and asserts a single line and `estimate`; `cli-bin.test.ts` starts the bin through `createRealRunner` and compares the repository listing before and after; `src/bin/gsd-atlas.ts` sets `init` and `cwd`.
