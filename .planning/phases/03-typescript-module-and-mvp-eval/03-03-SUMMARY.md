---
phase: 03-typescript-module-and-mvp-eval
plan: 03
subsystem: eval-harness
tags: [eval, claude-code, headless, stream-json, usage-accounting, node-test]
requires: []
provides:
  - "scripts/eval/claude-session.ts: the single runner for `claude -p` (buildClaudeArgs, runClaudeSession, parseStreamText, extractInit, extractResult, countToolCalls, sumToolCalls, billableTokens, cacheReadTokens, assertToolSet, statusOf)"
  - "scripts/eval/__fixtures__/fake-claude.mjs: fake executable driven by FAKE_CLAUDE_MODE"
  - "sanitised stream-json recordings (claude-stream-ok.jsonl, claude-stream-tools.jsonl)"
affects: [03-06, 03-14, 03-35]
tech-stack:
  added: []
  patterns:
    - "argument-array spawn with prompt on stdin, shell:false"
    - "pure parse/accounting functions, no module state"
    - "single table-driven statusOf mapping"
key-files:
  created:
    - scripts/eval/claude-session.ts
    - scripts/eval/claude-session.test.ts
    - scripts/eval/__fixtures__/fake-claude.mjs
    - scripts/eval/__fixtures__/claude-stream-ok.jsonl
    - scripts/eval/__fixtures__/claude-stream-tools.jsonl
  modified: []
key-decisions:
  - "A result event decides the session status; wall-clock and cap flags only matter when no result arrived."
  - "countToolCalls returns Record<string,number> and dedupes on tool_use block id (message ids repeat across stream events); sumToolCalls gives the total."
  - "Unknown event types and non-JSON lines are not returned and are counted in ignoredLines."
  - "Absent usage fields read as 0; present-but-invalid values pass through so billableTokens throws RangeError."
requirements-completed: [EVL-02, EVL-03]
status: complete
commits: 3
plan_head_before: 7516bdee7aab1302d2d1ccd5a3df778d72f1e999
plan_head_after: 0253315d93c6bdd25946e0fef3d76ae7b11640e1
actuals:
  tokens: 13000
  tasks: 2
  commits: 3
metrics:
  completed: 2026-10-17
---

# Phase 3 Plan 03: Headless session runner Summary

One runner for `claude -p` that builds an isolated argument array, feeds the prompt on stdin, bounds wall time and stdout, captures the init event and usage, and returns a SessionOutcome for every outcome instead of throwing.

## What was built

- `buildClaudeArgs(spec)`: `-p`, `--output-format stream-json`, `--verbose`, `--setting-sources ""`, `--strict-mcp-config`, `--mcp-config`, one `--plugin-dir` per entry, `--tools` (kept even when empty), `--allowedTools` when non-empty, `--max-budget-usd`, optional `--json-schema` and `--model`, `--no-session-persistence`. The prompt is never in argv.
- `runClaudeSession(spec)`: `spawn(executable ?? 'claude', [...prefixArgs, ...args], {shell:false})`, stdin end, bounded stdout buffer (default 32 MiB, truncated exactly at the cap), 2,000-character stderr ring, SIGKILL on timeout or cap, awaits child close (with a 1 s drain grace after `exit` so a grandchild holding the pipes cannot hang the call), spawn errors (ENOENT) returned as `error`, optional raw transcript written to `rawStreamPath`.
- Accounting: `billableTokens` (input + output + cache creation + cache read), `cacheReadTokens`, both RangeError on negative or non-integer fields; `countToolCalls` per tool name (MCP names kept in full); `assertToolSet` returning one string per difference (`missing tool:`, `extra tool:`, `mcp server absent:`, `unexpected mcp server:`, `skill absent:`, `init event absent`).
- `statusOf(exit, result, flags)`: single mapping, table-tested (12 rows).

## Verification

- `node --test scripts/eval/claude-session.test.ts`: 51 tests pass, run 4 times with no flake. `npm run typecheck`: clean.
- Includes the T-03-33 test (fixtures carry no home directory, `/Users/` path or account-name path part) and the D-02 test (no `scripts/eval` file imports a path containing `src/`).
- Claude Code version checked: `2.1.302`. Every flag the plan names appears in `claude --help` of that version, so no spelling adjustments were needed (`--allowedTools` is accepted alongside `--allowed-tools`).

## Tracer note

The live recordings were produced in a previous attempt (blocked by the worktree guard, so the fixtures were copied read-only from the main checkout's untracked files into this worktree, as instructed). No live session was re-run. The fixtures are sanitised (placeholder session ids, `/work/workN` cwd, `/home/user` memory path). The runner has therefore been exercised end to end against the fake executable that replays those recordings, and the recordings themselves are parsed by the pure functions; no live `claude` call was made from the runner in this attempt. The tracer gate (re-run of `<verify>`) passed before Task 2 started.

## Deviations from Plan

### Auto-fixed Issues

None for Rules 1-3.

### Process deviations

**1. [Process] Task 1 RED commit included the tools fixture and sanitisation test**
- The T-03-33 fixture test reads both recordings, so `claude-stream-tools.jsonl` was committed with Task 1's test commit instead of Task 2's. Content is unchanged; only the commit it landed in differs.

**2. [Process] Task 2 has no separate RED commit**
- Tests and implementation for Task 2 were committed together (`0253315`). Task 1 followed test-then-feat (`afa6ec7`, `2819613`). Task 2's tests were written first and the implementation added after, but only one commit was made.

**3. [Scope] Added `sumToolCalls` and `ExitInfo`/`KillFlags`/`ExpectedToolSet` exports**
- The plan names `countToolCalls` returning `{Bash: 2, Read: 1}` "and a total of 3"; a separate `sumToolCalls` keeps both readings true. The types are needed by the `statusOf` signature.

## Known Stubs

None.

## Threat Flags

None. The runner adds no network surface; it only spawns the configured executable with an argument array.

## Notes for downstream plans

- Windows live use is unsupported (npm `.cmd` shims need a shell); tests use `process.execPath` plus a script.
- `assertToolSet` requires `mcpServers` explicitly, so a baseline arm passes `[]` and any stray MCP server shows up as a difference.
- `rawStreamPath` holds at most `maxStdoutBytes` of output; a capped session is `killed` and counts against its arm.

## Self-Check: PASSED

- FOUND: scripts/eval/claude-session.ts, scripts/eval/claude-session.test.ts, scripts/eval/__fixtures__/fake-claude.mjs, claude-stream-ok.jsonl, claude-stream-tools.jsonl
- FOUND commits: afa6ec7, 2819613, 0253315
