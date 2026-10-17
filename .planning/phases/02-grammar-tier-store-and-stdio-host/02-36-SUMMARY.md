---
phase: 02-grammar-tier-store-and-stdio-host
plan: 36
subsystem: bins
tags: [shutdown, signals, sigterm, sigint, lazy-composition, cli, mcp-bin, gap-closure]
status: complete
gap_closure: true

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "composeHost and Composed.dispose (02-22/02-23), runCli (02-24), runMcpShim and the stdio bin (02-23), writer lease and dirty sentinel (02-12)"
provides:
  - "installShutdownHandlers({process, dispose, exit, signals}): first SIGTERM/SIGINT disposes then exits 143/130, a second signal exits at once, a rejecting dispose still exits"
  - "gsd-atlas-mcp handles SIGTERM and SIGINT (IN-07)"
  - "runCliMain: the CLI body with compose, runCli, streams and the shutdown installer injected; the Host is composed on the first request, inside try/catch/finally (IN-09)"
  - "scripts/bin-lifecycle.test.ts: real-process SIGTERM/SIGINT against both bins and the lazy-composition cases"
affects: [phase 4 daemon host (signal handling moves with the Host owner)]

actuals:
  tokens: 40000
  tasks: 2
  commits: 2
plan_head_before: 27ae4745b8b40d2ef56534198753f39e59ef3085
plan_head_after: 23bfb5261ff050ac5af6d22426794e1fab05a4f3

tech-stack:
  added: []
  patterns:
    - "Process, dispose and exit injected into a small module so a signal sequence is a deterministic unit test; the bins only wire it"
    - "Bin bodies live in a testable function (runCliMain); the bin file is wiring only"

key-files:
  created:
    - src/bin/shutdown.ts
    - src/bin/shutdown.test.ts
    - src/bin/cli-main.ts
    - src/bin/cli-main.test.ts
    - scripts/bin-lifecycle.test.ts
  modified:
    - src/bin/gsd-atlas-mcp.ts
    - src/bin/gsd-atlas.ts

key-decisions:
  - "Signal exit codes (143, 130) are documented in shutdown.ts and cli-main.ts headers and are not added to the CLI's 0/1/2/3 table"
  - "Handlers are registered for SIGINT and SIGTERM on every platform; a platform that refuses a signal is skipped without failing the others"
  - "The CLI real-signal case signals a running `build` (600 files) once lease.json appears, instead of `maintain`: build is the slow, lease-holding command, so the signal reliably lands mid-command"

patterns-established:
  - "installShutdownHandlers({process, dispose, exit}) for any bin that owns a Host"

requirements-completed: [HST-01, STO-06, QRY-04]

coverage:
  - id: D1
    description: "A SIGTERM or SIGINT to a running gsd-atlas-mcp disposes the Host and exits 143/130, leaving lease.json removed, no dirty sentinel and a store that passes quick_check"
    status: tested
    evidence: "scripts/bin-lifecycle.test.ts: 'SIGTERM releases the lease', 'SIGINT also exits cleanly with 130'; the control (stdin end) still exits 0"
  - id: D2
    description: "Second signal during shutdown exits at once; a rejecting dispose still exits; handlers register once and uninstall"
    status: tested
    evidence: "src/bin/shutdown.test.ts: 'second signal forces exit', 'dispose rejects', 'registers each signal once'"
  - id: D3
    description: "gsd-atlas never composes the Host for --help, --version, usage errors or init; a compose failure is the CLI's own `error internal_error` line with exit 2"
    status: tested
    evidence: "scripts/bin-lifecycle.test.ts 'help does not compose'; src/bin/cli-main.test.ts 'compose failure is internal_error', 'composed once'"
  - id: D4
    description: "SIGTERM to a running CLI command exits 143 after disposing, with no dirty sentinel and the lease released"
    status: tested
    evidence: "scripts/bin-lifecycle.test.ts 'SIGTERM to the CLI'"
  - id: D5
    description: "The CLI's 0/1/2/3 exit-code contract is unchanged"
    status: tested
    evidence: "scripts/cli-bin.test.ts, scripts/cli-e2e.test.ts and src/cli tests pass unchanged"
---

# Phase 2 Plan 36: Bin shutdown and lazy CLI composition Summary

Both bins now end cleanly on SIGTERM and SIGINT (graceful dispose, then 143 or 130; a second signal exits at once), and `gsd-atlas` composes the Host on its first request inside its try block instead of at import.

## Tasks

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Tracer: SIGTERM to a running MCP server releases the lease and leaves a clean store | f36b83f | src/bin/shutdown.ts, src/bin/shutdown.test.ts, src/bin/gsd-atlas-mcp.ts, scripts/bin-lifecycle.test.ts |
| 2 | The CLI composes the Host lazily, inside its try block, and shuts down on signals | 23bfb52 | src/bin/cli-main.ts, src/bin/cli-main.test.ts, src/bin/gsd-atlas.ts, scripts/bin-lifecycle.test.ts |

## Tracer gate

The real-process case ran end to end (build with the real CLI, start the real MCP bin, `initialize`, one `code_find`, wait for `lease.json`, signal, check exit code, lease, sentinel and `quick_check`). Verified green; the stdin-end control still exits 0.

## Mutation / red-first checks

- Task 1: the real-process cases were run before the bin was wired. Without the handler `SIGTERM releases the lease` failed (`'SIGTERM' !== null`: the process died by the signal) and `SIGINT also exits cleanly` failed (`null !== 130`); with `lease.json` present when the signal was sent. Wiring `installShutdownHandlers` turned both green.
- Task 2: with the original `gsd-atlas.ts` restored, `help does not compose` and `SIGTERM to the CLI` failed while `a repository command composes the Host` passed; with `runCliMain` wired all pass. The SIGTERM case was run 5 times in a row without a failure.

## Deviations from Plan

- The plan says a SIGTERM to a running `gsd-atlas maintain`; the real-process case uses `build` on a 600-file repository, signalled once `lease.json` exists. `maintain` on a small repository finishes before a signal can be delivered deterministically; `build` holds the lease for long enough and goes through the same `runCliMain` and shutdown path.
- Per-plan commit ledger file could not be written inside the shared git directory from the isolated worktree; `plan_head_before` is the known base commit (27ae474) and `commits: 2` was measured with `git rev-list --count 27ae474..HEAD`.
- Source-reading tooling in this environment required CodeGraph CLI routes for some files; no code impact.

## Known Stubs

None.

## Threat Flags

None. T-02-117 (a signalled server skipping teardown) is mitigated and proven by the real-process cases.

## Verification

- `node --test src/bin/cli-main.test.ts src/bin/shutdown.test.ts scripts/bin-lifecycle.test.ts scripts/cli-bin.test.ts scripts/cli-e2e.test.ts src/bin/compose.test.ts scripts/mcp-stdio.test.ts`: 57 tests, 57 pass, 0 skipped.
- `npm run typecheck` and `npm run lint`: exit 0.

## Self-Check: PASSED

Files present: src/bin/shutdown.ts, src/bin/shutdown.test.ts, src/bin/cli-main.ts, src/bin/cli-main.test.ts, scripts/bin-lifecycle.test.ts. Commits f36b83f and 23bfb52 are on the branch.
