---
phase: 02-grammar-tier-store-and-stdio-host
plan: 25
subsystem: product-e2e
status: complete
tags: [e2e, real-processes, cli-mcp-parity, injection, leader-follower, watcher-freshness, worktrees, command-runner]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "the gsd-atlas bin and exit codes (02-22), the stdio MCP server and McpProcess (02-23), the typescript module (02-13), the real watcher in the leader (02-17), follower overlay (02-27), startup Reconcile (02-28), gate.freshnessPrCeilingMs in 02-CONSTANTS.md (Approved)"
provides:
  - "scripts/test-helpers/mcp-client.ts: startMcp(options) returning McpClient (initialize, listTools, callTool, kill, close, stderrText, killAndStderr); every stdout line is checked to be a JSON-RPC 2.0 object as it arrives"
  - "scripts/test-helpers/fixture-repo.ts: makeFixtureRepo(kind) for ts-three-files, injection, worktrees and two-repos with an isolated environment, fixture.cli(), fixture.mcp(), withFixture() (prints both processes' stderr on failure), maskNonce()"
  - "scripts/parity.test.ts: 12 cases proving the CLI stdout line equals the MCP result text for find, refs, context, impact, health and lang_list, the documented exit codes, budget and cursor paging, and fenced injection text"
  - "scripts/product-e2e.test.ts: 6 cases for the follower role, exit 3, SIGKILL takeover, save-to-find through the real watcher, the fresh argument, linked worktrees and two repositories in one server"
affects: [02-26 gates (reuses fixtures and the freshness ceiling), 02-VERIFICATION human walk-through, phase 3 and later e2e tests]

actuals:
  tokens: 12000
  tasks: 3
  commits: 3
plan_head_before: fbbcbd326f75c7b5916e0ba6ac490e84a974178f
plan_head_after: cee436d50e26c9392cbd73d0c7b51249e6d9fb8c

tech-stack:
  added: []
  patterns:
    - "Run every CLI request first (each process exits and releases the lease), then start the MCP server, so both surfaces answer as the leader and compare byte for byte"
    - "withFixture(kind, body): always cleans up, kills servers, and appends the stderr of every process to a failing assertion"
    - "Polling waits are 25 ms loops bounded by an approved or hung-child ceiling, never a fixed sleep"

key-files:
  created:
    - scripts/test-helpers/mcp-client.ts
    - scripts/test-helpers/fixture-repo.ts
    - scripts/parity.test.ts
    - scripts/product-e2e.test.ts
  modified:
    - scripts/mcp-stdio.test.ts

key-decisions:
  - "McpClient is a subclass of the existing McpProcess instead of a second JSON-RPC client: the framing, id matching and stdin queue of plan 02-23 stay the single implementation, and every existing stdio test works on the subclass unchanged"
  - "Parity is asserted on strings with assert.equal after maskNonce; the only other mask is the clock field data.indexer.lastReconcileAt of atlas_status, masked by name and asserted to be a number on both surfaces"
  - "CLI requests run before the server starts in every parity case, because a CLI run while a server leads is a follower and its degraded field legitimately differs; the follower difference is asserted by name in product-e2e.test.ts"
  - "The freshness bound is the approved gate.freshnessPrCeilingMs (3000), copied into the test with a comment naming 02-CONSTANTS.md; every other polling wait reuses EXIT_CEILING_MS of mcp-process.ts, a hung-child bound and not a latency expectation"

requirements-completed: [QRY-04, QRY-05, HST-01, HST-02, IDX-01, STO-08]

coverage:
  - id: D1
    description: "QRY-04: for find, refs, context, impact and health the CLI stdout line equals the MCP result text after the nonce is masked; exit codes 0, 1, 2 follow the contract and isError is true exactly when the envelope is not ok"
    requirement: QRY-04
    verification:
      - kind: e2e
        ref: "scripts/parity.test.ts#CLI and MCP parity on the TypeScript import chain"
        status: pass
      - kind: e2e
        ref: "scripts/parity.test.ts#CLI and MCP agree on failures and exit codes"
        status: pass
      - kind: e2e
        ref: "scripts/parity.test.ts#CLI and MCP agree on budgets and cursors"
        status: pass
  - id: D2
    description: "QRY-05: an instruction and a forged fence marker in a comment come back only inside untrusted_text through both surfaces; invisible characters in names are removed"
    requirement: QRY-05
    verification:
      - kind: e2e
        ref: "scripts/parity.test.ts#injection"
        status: pass
  - id: D3
    description: "STO-08 and HST-01: while a server leads, a CLI find is a follower with otherwise equal data, build and maintain exit 3, a killed leader frees the lease for build and a new server"
    requirement: STO-08
    verification:
      - kind: e2e
        ref: "scripts/product-e2e.test.ts#two sessions on one repository (STO-08, HST-01)"
        status: pass
  - id: D4
    description: "IDX-01: a save reaches code_find through the leader's real watcher within gate.freshnessPrCeilingMs (measured 338 to 352 ms locally); fresh returns it on the first call; an identical save does not move the watermark"
    requirement: IDX-01
    verification:
      - kind: e2e
        ref: "scripts/product-e2e.test.ts#freshness through the server (IDX-01)"
        status: pass
  - id: D5
    description: "HST-02: linked worktrees on different branches answer with their own definitions from one shared parse, the watcher follows a checkout, and one server keeps two unrelated repositories apart"
    requirement: HST-02
    verification:
      - kind: e2e
        ref: "scripts/product-e2e.test.ts#worktrees and repositories (HST-02)"
        status: pass
---

# Phase 2 Plan 25: Product-level end-to-end tests Summary

**CLI and MCP parity, fenced injection text, the leader and follower roles, watcher freshness, worktree correctness and multi-repository isolation, all proven with the real bins started through the CommandRunner.**

## Performance

- **Tasks:** 3 of 3 (one tracer, two auto)
- **Files:** 4 created, 1 modified (test code and helpers only; nothing under `src` changed)
- **Verification:** `node --test scripts/parity.test.ts scripts/product-e2e.test.ts scripts/mcp-stdio.test.ts` 38 of 38 pass; the full `npm test` passed 2124 of 2124 with these files running in parallel with the rest; `npm run typecheck` and `npm run lint` exit 0

## Accomplishments

- Tracer: `gsd-atlas find parse` and the MCP `code_find` return the same bytes once the per-response nonce is replaced by a fixed token, through two real processes in an isolated environment (HOME, user directory, git configuration).
- All six tools compared the same way; `impact parse --depth 2` returns the four ADR-shaped items (b.load and b.ts at hop 1, c.main and c.ts at hop 2) with INFERRED for calls and EXTRACTED for imports, and `lang_list` agrees with `lang list`.
- Exit codes through the real bin: not_indexed and not_a_repo exit 2 with an MCP `isError` result carrying the same JSON, usage errors exit 1 with empty stdout, build and maintain exit 0 on a leaderless repository, a budget of 40 tokens truncates with the same cursor on both surfaces, the second page is equal, and a cursor changed by one character is `bad_cursor` on both.
- Injection: the instruction and a forged `END-UNTRUSTED-...` marker sit in a doc comment and a trailing comment; they appear only inside `untrusted_text` entries that open and close with the real nonce, the envelope with that field removed contains neither, and a zero-width joiner inside a symbol name is removed from the name.
- Two sessions: with the server leading, a CLI find answers `degraded: [follower]` and the envelope is otherwise byte for byte the leader's; `build`, `maintain` and `maintain collect` exit 3 with `lease_held`; after the server exits, or is SIGKILLed, `build` succeeds and a new server leads.
- Freshness: a function saved into a tracked file is returned by `code_find` (no `fresh`) in about 340 ms locally against the approved CI ceiling of 3000 ms (printed); `fresh: ['a.ts']` returns an edit on the first call; saving identical content leaves the watermark sequence unchanged (after asserting that a real edit does move it).
- Worktrees: building the feature worktree after main parses 0 files and links 2 (every blob was already parsed), `find run --cwd` returns `src/b.ts` for main and `src/b/index.ts` for the feature worktree, `refs run` returns the same `src/main.ts:3:10` call site with the same reference handle on both, and after `git checkout --detach main` in the feature worktree the leader's watcher turns the answer into main's. One server keeps two repositories apart, each with its own `.git/gsd-atlas` store.

## Task Commits

1. **Task 1: Tracer, CLI and MCP find parity** - `53a5456` (test)
2. **Task 2: Parity for all tools, exit codes, injection** - `ca691f8` (test)
3. **Task 3: Two sessions, freshness, worktrees, repositories** - `cee436d` (test)

The tracer gate was the automated re-run of its `<verify>` (it passed before Task 2 started); no `blocking-human` gate was declared.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The test client is a subclass of McpProcess, not a new client**
- **Found during:** Task 1
- **Issue:** the plan asks `mcp-client.ts` to provide a JSON-RPC client and `mcp-stdio.test.ts` to define none of its own, but `scripts/test-helpers/mcp-process.ts` (plan 02-23) already is that client and is used by `package.test.ts` and `mcp.test.ts`.
- **Fix:** `McpClient extends McpProcess` adds `initialize`, `close`, `stderrText`, `killAndStderr` and the per-call stdout framing check; `startMcp` returns it; `mcp-stdio.test.ts` now starts servers through `startMcp`. `stderrText()` returns the text once the process has exited, `killAndStderr()` is what a failing test uses.
- **Files modified:** scripts/test-helpers/mcp-client.ts, scripts/mcp-stdio.test.ts
- **Commit:** 53a5456

**2. [Rule 1 - Bug in plan assumption] CLI before server in every parity case**
- **Found during:** Task 2 design
- **Issue:** a CLI run while a server holds the lease is a follower and its `degraded` field differs by design, which would contradict byte equality.
- **Fix:** each case runs its CLI requests first (each process exits and releases the lease) and then starts the server. The two-process difference is asserted by name in `product-e2e.test.ts`.
- **Commit:** ca691f8

**3. [Rule 1] `ts-three-files` gains `parseLine` in `c.ts`; the injection text sits in the matched line**
- **Found during:** Task 2
- **Issue:** with only three distinct names no query returns two definitions, so `find --budget 40` could not truncate; and the tools return only the matched source line, so a doc comment on earlier lines never reaches `untrusted_text`.
- **Fix:** `c.ts` defines one extra function whose name shares the prefix `parse` (the budget case uses `--mode prefix`); the injection fixture carries the instruction and the forged fence both in a leading doc comment and in a trailing comment on the definition line.
- **Commit:** ca691f8

**4. [Rule 1] `atlas_status` parity masks one named clock field**
- **Found during:** Task 2
- **Issue:** `data.indexer.lastReconcileAt` is a wall-clock reading taken per process, so two processes cannot be byte equal on it.
- **Fix:** only that field is masked, by name, and the case asserts it was found exactly once in each of the two answers and is a number; nothing else in the health JSON is masked (the prohibition on weakening parity holds).
- **Commit:** ca691f8

**5. [Scope note] "Parsing only changed files" is evidenced indirectly**
- The Host exposes no parse counter. The evidence is: building the second worktree parses 0 files and links 2, both worktrees return the identical reference handle for the shared `src/main.ts`, and the watcher turns the feature worktree's answer into main's after a checkout. A direct per-checkout parse count would need an Indexer counter in `atlas_status`; that is left to a later plan if wanted.

**Total deviations:** 4 auto-fixed, 1 scope note; no architectural change; nothing under `src` was modified.

## Issues Encountered

- The harness guard that routes reads of indexed source through CodeGraph blocked direct reads of the existing test files; the files were read with `codegraph node` instead, and a temporary `.codegraph/` index and a `node_modules` symlink were removed before returning.
- Only macOS was available. The cases use `process.execPath`, `git`, `fs.realpathSync.native` paths and no shell, but the Linux and Windows runs happen in CI.

## Known Stubs

None.

## Threat Flags

None. The tests add no network endpoint or trust boundary; T-02-92 and T-02-93 are mitigated (servers are killed in `cleanup()`, every process gets an isolated HOME, user directory and git configuration).

## Next Phase Readiness

The fixtures and helpers are reusable by plan 02-26 (gates) and by later phases' end-to-end tests. Nothing here blocks them.

## Self-Check: PASSED

- scripts/test-helpers/mcp-client.ts, scripts/test-helpers/fixture-repo.ts, scripts/parity.test.ts, scripts/product-e2e.test.ts exist
- commits 53a5456, ca691f8, cee436d are ancestors of HEAD
