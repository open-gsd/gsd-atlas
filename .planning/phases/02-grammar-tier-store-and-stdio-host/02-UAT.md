---
status: testing
phase: 02-grammar-tier-store-and-stdio-host
source: [02-VERIFICATION.md]
started: 2026-10-17T17:03:28Z
updated: 2026-10-17T19:42:00Z
---

## Current Test

number: 2
name: Cursor and Codex init config shapes
expected: |
  Each real host lists and starts the gsd-atlas MCP server from the entry init wrote; init changes nothing else
awaiting: user response (human-only: needs real Cursor and Codex installs)

## Tests

### 1. STO-05 idle-only size policy
expected: idleRatio <= 1.25 without an explicit full compaction, or a written override
result: pass
evidence: |
  Plan 02-43 (2026-10-17), node 26.11.1, macOS arm64, base 374a62b. The gate asserts the idle-only size, measured before any explicit full compaction (scripts/size-gate.ts, 02-37), with the idle policy that the Tenant loop runs (IDLE_MAINTENANCE, 02-30, 02-40):
  - `node scripts/size-gate.ts`: size-gate: files 300 symbols 8 edits 20000 maintain-every 200 freshBytes 655360 idleBytes 655360 idleRatio 1.0000 max 1.25 settledBytes 655360 settledRatio 1.0000 vacuums 100 longestMaintainMs 13.9 dbstat present maintainRuns 101 seconds 5.8 OK
  - `node scripts/size-gate.ts --driver better-sqlite3`: ... idleRatio 1.0000 max 1.25 ... vacuums 100 longestMaintainMs 207.5 dbstat present maintainRuns 101 seconds 14.8 OK
  - Edge runs: `--edits 0` exits 0 (idleRatio 1.0000, OK); `--maintain-every 0` exits 1 (idleRatio 38.2687, OVER), so the gate can still fail.
  - Tenant level: src/tenant/idle-compaction.test.ts (a leader's idle round vacuums a fragmented store once, a healthy store is left alone, `compact` vacuums only when `full` is asked for) passes with src/fact-store/maintain.test.ts and scripts/size-gate.test.ts (75 of 75).
  Reading adopted: the idle loop alone meets the 1.25x bound (the user's decision); no override is recorded. Previous figure for the old policy: 1.3938 at this scale. These are one-machine figures; the Linux and Windows figures come from the next hosted CI `gates` run of the unchanged `node scripts/size-gate.ts` step and are not claimed here. Plans: 02-30, 02-37, 02-40, 02-43.

### 2. Cursor and Codex init config shapes
expected: Each real host lists and starts the gsd-atlas MCP server from the entry init wrote; init changes nothing else
result: pass
evidence: Tested 2026-10-17 on macOS arm64 against the real CLIs in a scratch HOME, no login and no model prompt (.planning/research/MCP-HOST-LIVE-CHECK.md). Codex CLI 0.163.0: `codex mcp list` and `codex mcp get gsd-atlas` show the server enabled with the right command and args; existing tables and comments survived byte for byte. Cursor cursor-agent 2026.10.16: `agent mcp list` reports gsd-atlas ready (Cursor launched it) and `list-tools` returns the six tools. Codex has no model-free way to start the server, so its start was checked by running the same command and args by hand. Not tested: Windows, Linux, the Cursor and Codex desktop or IDE apps.

### 3. nightly.yml first remote run
expected: freshness-gate (100 saves, 1000 ms) and corpus-gates pass on ubuntu, macOS and Windows after the file reaches the default branch
result: [pending]

### 4. ADR editorial repairs and amendments from 02-01
expected: Reconstructed passages and the dated amendments accepted; lost clause in docs/SDK-PROVIDERS.md supplied or left by choice
result: pass
evidence: Accepted by the user on 2026-10-17 after reading summaries of the restored passages (ADR 3 decision 2, ADR 5 decision 5, ADR 6, PRD 4.7) and the six 2026-10-17 amendments (ADRs 4, 5, 7, 9, 11, 13). The lost clause in docs/SDK-PROVIDERS.md stays as it is, by choice.

### 5. Flaky wall-clock assertion in src/fact-store/maintain.test.ts
expected: Bound the first compaction slice in the product, or assert page counts instead of wall time
result: pass
evidence: |
  Plan 02-30 (IN-01) replaced the wall-clock comparison with structural assertions over the exported `COMPACT_SLICE_LIMITS` ({ firstPages: 64, maxPages: 16384, maxGrowth: 4 }); no elapsed-milliseconds assertion remains in src/fact-store/*.test.ts. Plan 02-43 re-ran src/fact-store/maintain.test.ts on a clean tree: case "slice limits: free pages are returned in bounded, growing slices, the WAL is truncated and the file shrinks" and case "slice: a budget of zero performs one slice, reports incomplete while pages remain, and later calls finish" pass on both drivers (54 of 54 in the file; the whole suite is 2590 of 2590 with 0 failed and 0 skipped). Mutation check recorded by 02-30: a checkpoint without the zero busy timeout makes the checkpoint-mode case fail, and the structural cases fail when the option or the second evaluation is removed.

## Summary

total: 5
passed: 4
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
