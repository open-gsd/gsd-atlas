---
phase: 02-grammar-tier-store-and-stdio-host
plan: 23
subsystem: mcp-shim
tags: [mcp, stdio, stateless, modelcontextprotocol-server-2.3.1, stdout-guard, restart, installed-package]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "TOOLS, buildRequest and the HostClient seam (02-16, 02-19), composeHost and the lazy Tenant/Host (02-20), exit codes and bin wiring on the CLI side (02-22), the approved package decision (02-04, 02-CONSTANTS.md)"
provides:
  - "gsd-atlas-mcp: a stateless stdio MCP server on @modelcontextprotocol/server 2.3.1 with exactly the six shared read-only tools"
  - "buildMcpServer(client, options): registers TOOLS by loop, answers with JSON.stringify of the Host envelope as the one text item, isError exactly when not ok, a fixed message when the Host cannot be composed or called"
  - "stdout guard: the real stdout write is private to the protocol stream, every other write (and console output) goes to stderr"
  - "runMcpShim: serves until end of input, finishes Host calls still in flight, returns 0"
  - "Real-process tests: framing, lazy start, EOF, restart after SIGKILL, edit while stopped, kill during call, EOF in the same chunk, installed-package MCP session"
affects: [02-28 startup Reconcile and reconciling degraded code, 02-27 follower overlay, phase 4 transport (stdio shim becomes a thin relay), phase 7 hooks and skills that read the tool contract]

actuals:
  tokens: 15000
  tasks: 3
  commits: 8
plan_head_before: eae4d1ff7bc0f2e67c40d34be2cb0431fc2cce99
plan_head_after: 420e9e62e6f4448cca892ef45435ee384a6e5638

tech-stack:
  added: ["@modelcontextprotocol/server 2.3.1 (exact, scripts disabled; transitive @modelcontextprotocol/core 2.3.1)"]
  patterns:
    - "Adapter parity by construction: the MCP server and the CLI loop over the same TOOLS table and call the same buildRequest"
    - "Guard-first bin: the bin's first import is the shim index, whose first import is the stdout guard"
    - "Compose the Host on the first tool call, not at start; the shim waits for calls in flight before the bin disposes the Host"
    - "Real-process tests drive the bin through the CommandRunner with an async-iterable stdin and a line reader"

key-files:
  created:
    - src/mcp-shim/server.ts
    - src/mcp-shim/stdout-guard.ts
    - src/mcp-shim/mcp.test.ts
    - scripts/mcp-stdio.test.ts
    - scripts/test-helpers/mcp-process.ts
    - scripts/test-helpers/stdout-noise-child.ts
  modified:
    - package.json
    - package-lock.json
    - src/mcp-shim/index.ts
    - src/bin/gsd-atlas-mcp.ts
    - scripts/package.test.ts
    - src/indexer/indexer.ts
    - src/indexer/indexer.test.ts

key-decisions:
  - "The bin imports ../mcp-shim/index.ts first, and that module imports ./stdout-guard.ts first, instead of the bin importing the guard file directly: the lint rule D-12 forbids a deep import across modules, and ES module evaluation order makes the guard still the first code that runs"
  - "runMcpShim waits for every Host call it started before returning, with no timeout: a call whose client has gone is finished and its answer dropped; the Host bounds each call, and a new wall-clock number would need approval in 02-CONSTANTS.md"
  - "The Host is composed on the first tool call (a lazy HostClient in the bin), so initialize and tools/list touch no store, watcher, grammar or user directory"
  - "Importing the guard patches the importing process, so unit tests never import it; the guard is tested in a child process"
  - "Closing a subscription that finishes opening after Indexer.stop() is the Indexer's job (cover, watchGitDir, attach), not the Host's"

patterns-established:
  - "scripts/test-helpers/mcp-process.ts: McpProcess (stdin queue, line pump, id-matched requests, shutdown with diagnostics on a hang) shared by the stdio and package tests"
  - "A test that must see a hung child kills it and reports its stderr"

requirements-completed: [QRY-06, HST-01, QRY-04]

coverage:
  - id: D1
    description: "The default MCP profile is exactly six read-only tools registered from the shared TOOLS table, with strict schemas, and no build or write tool"
    requirement: QRY-06
    verification:
      - kind: unit
        ref: "src/mcp-shim/mcp.test.ts#buildMcpServer: the default profile (D-07, QRY-06)"
        status: pass
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#tools/list over a real stdio session returns exactly the six tools, each read-only"
        status: pass
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#a call to an unknown tool is refused, not served"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every tool call builds its Request with the CLI's buildRequest and returns the Host envelope unchanged as the one text item, isError exactly when not ok, a fixed error result when the Host cannot answer"
    requirement: QRY-04
    verification:
      - kind: unit
        ref: "src/mcp-shim/mcp.test.ts#buildMcpServer: tool calls"
        status: pass
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#tools/call code_find answers the definition from the built index, as one envelope in one text item"
        status: pass
    human_judgment: false
  - id: D3
    description: "The server is stateless and survives a restart between two tool calls: after SIGKILL, after a clean shutdown, with an edit made while stopped, and with a call racing a kill"
    requirement: HST-01
    verification:
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#restart between calls (HST-01): the store and the start-up Reconcile persist the truth"
        status: pass
    human_judgment: false
  - id: D4
    description: "Nothing but protocol frames reaches stdout: a child that writes noise and console output leaves stdout to the protocol stream, the real server's every line is JSON-RPC, also under --trace-warnings"
    requirement: HST-01
    verification:
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#stdout hygiene (T-02-79, research Pitfall 8)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Startup does no heavy work: initialize and tools/list are answered in a directory that is not a repository with an unwritable user directory and home, and create nothing"
    requirement: HST-01
    verification:
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#lazy start: initialize and tools/list are answered with an unwritable user directory and home"
        status: pass
    human_judgment: false
  - id: D6
    description: "The server exits 0 when stdin reaches end of file, with the Host disposed, including a stdin closed before any byte and a request in the same chunk as the end of input"
    requirement: HST-01
    verification:
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#EOF"
        status: pass
      - kind: e2e
        ref: "scripts/mcp-stdio.test.ts#EOF in the same chunk as a request"
        status: pass
    human_judgment: false
  - id: D7
    description: "The Phase 1 stub expectations are replaced: the source run exits 0 and the installed package (tarball install with scripts disabled) serves a six-tool MCP session and loads @parcel/watcher and @modelcontextprotocol/server"
    requirement: HST-01
    verification:
      - kind: integration
        ref: "scripts/package.test.ts#installed tarball runs the bins"
        status: pass
      - kind: integration
        ref: "scripts/package.test.ts#gsd-atlas-mcp run from source with stdin closed exits 0 and prints nothing on stdout"
        status: pass
    human_judgment: false
  - id: D8
    description: "Linux and Windows behaviour of the stdio server (pipe semantics, SIGKILL on Windows, native watcher shutdown) and a fresh-client interoperability check with a real MCP host"
    verification: []
    human_judgment: true
    rationale: "Only macOS ran locally and no MCP client package is installed; three-OS CI and a real host (Claude Code reading the registered server) are the only checks."

duration: 33 min
completed: 2026-10-17
status: complete
---

# Phase 2 Plan 23: Stateless stdio MCP server Summary

**A stateless stdio MCP server on @modelcontextprotocol/server 2.3.1 serves exactly six read-only tools from the shared TOOLS table, keeps stdout to protocol frames behind a first-import guard, answers before any tenant exists, and survives restarts, kills and a request in the same chunk as end of input.**

## Performance

- **Duration:** 33 min
- **Started:** 2026-10-17T00:27:30Z
- **Completed:** 2026-10-17T01:03:00Z
- **Tasks:** 3 (one tracer, two auto), plus two deviation fixes
- **Files modified:** 13 (6 created, 7 modified; package.json and package-lock.json included)

## Accomplishments

- `gsd-atlas-mcp` is a real server. `tools/list` over a spawned process returns exactly `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status` and `lang_list`, each read-only with a strict argument schema; `build`, `maintain` and `lang_test` are refused as unknown tools.
- A tool call is `buildRequest(name, args)` then `client.handle(request)`, and the answer is `JSON.stringify(envelope)` as the one text item (the CLI prints the same string plus a newline), `isError` set exactly when the envelope is not ok. A thrown client becomes the fixed `FAILURE_TEXT`; the cause goes to stderr only.
- Stdout is protocol-only: the real stdout write is captured at import and handed to `protocolStdout`; `process.stdout.write` and console output go to stderr. Proven by a child process (once, installed twice, loaded as a second copy) and by parsing every line of a real session, also under `NODE_OPTIONS=--trace-warnings`.
- Startup is lazy: `initialize` and `tools/list` succeed with the user directory and home both unusable and the working directory not a repository, and create nothing. The Host is composed on the first tool call.
- Restart is a non-event: SIGKILL, clean shutdown, an edit made while stopped (read-your-own-writes with `fresh`, and the start-up Reconcile without it), and a call racing a kill all end with a new process answering correctly.
- The installed package works: the packed tarball installed with scripts disabled serves a six-tool session, exits 0 at end of input, and loads `@parcel/watcher` and `@modelcontextprotocol/server`.

## Task Commits

0. **Dependency** - `2522ca5` (chore): `@modelcontextprotocol/server` 2.3.1 exact, `--ignore-scripts`; resolved integrity strings equal 02-CONSTANTS.md for the server and its core; `npm ls @modelcontextprotocol/node hono` empty
1. **Task 1: Tracer, install the SDK and serve code_find over a real stdio session** - RED `5df0ce4` (test), GREEN `e1d10c2` (feat)
2. **Task 2: Stdout guard, lazy startup, EOF exit, not-a-repository path** - RED `d239ece` (test), GREEN `eb1a39f` (feat); the Indexer fix it exposed `02521a9` (fix)
3. **Task 3: Restart between calls, installed-package smoke test, stub tests replaced** - tests `1858014` (test), the fix its EOF-in-the-same-chunk case exposed `420e9e6` (feat)

**Plan metadata:** the docs commit that carries this file (docs: complete plan)

## TDD Gate Compliance

RED evidence (all `RED_EVIDENCE_OK` from `gsd_run check tdd-red-evidence`, files `.planning/red-evidence-02-23-t1.json`, `-t1b.json`, `-t2.json`, `-t3.json`, uncommitted by instruction):

- **T1 RED:** `mcp.test.ts` "registers exactly the six shared tools" failed on the planned `deepStrictEqual` (the skeleton server listed no tools); `mcp-stdio.test.ts` "tools/list over a real stdio session" failed because the Phase 1 stub exited 1 before answering `initialize`. Semantic assessment: the targets ran and failed on the planned assertions, not on load or fixture faults. GREEN `e1d10c2`.
- **T2 RED:** the child-process framing test failed with the no-op `installStdoutGuard` skeleton (noise reached stdout). GREEN `eb1a39f`.
- **T3 RED:** "EOF in the same chunk as a request" failed (the server stayed alive after end of input). GREEN `420e9e6`. The other Task 3 tests (restart, edit while stopped, kill during call, installed package) exercise behaviour the earlier commits and the Indexer fix already provided, so they passed on first run; that is expected for a tests-only task, and the old stub assertions in `package.test.ts` were failing red against the new behaviour before the edit.

## Files Created/Modified

- `src/mcp-shim/server.ts` - `buildMcpServer`, `SERVER_INSTRUCTIONS`, `FAILURE_TEXT`
- `src/mcp-shim/index.ts` - `runMcpShim` (serveStdio over an observed transport, waits for calls in flight), re-exports the guard and the server
- `src/mcp-shim/stdout-guard.ts` - captures the real write, `protocolStdout`, `installStdoutGuard`
- `src/bin/gsd-atlas-mcp.ts` - shim first, lazy `composeHost`, dispose in `finally`
- `src/mcp-shim/mcp.test.ts` - unit tests over an in-memory transport with a recording fake client
- `scripts/mcp-stdio.test.ts`, `scripts/test-helpers/mcp-process.ts`, `scripts/test-helpers/stdout-noise-child.ts` - real-process tests and their client
- `scripts/package.test.ts` - stub assertions replaced; installed-package MCP session
- `src/indexer/indexer.ts`, `src/indexer/indexer.test.ts` - late-subscription fix and its tests
- `package.json`, `package-lock.json` - the one new runtime dependency

## Decisions Made

See `key-decisions` above. Short form: guard-first through the shim index (lint D-12), wait for in-flight calls with no timeout, compose the Host on first use, never import the guard in a test process.

## SDK API surface (differences from the research example)

Read from the installed typings, as the plan asked:

- `serveStdio(factory, options)` takes an optional `transport` (a `StdioServerTransport` over any streams), `legacy` (`'serve'` default), `onerror` and `maxSubscriptions`; the factory receives a request context. Only `StdioServerHandle.close()` is returned, so the end of input is observed by subclassing `StdioServerTransport` and overriding `close()`.
- `StdioServerTransport(stdin, stdout, { maxBufferSize })` closes itself on stdin `end`/`close` and, per its own documentation, aborts requests still in flight without answering them. That is why `runMcpShim` waits for its Host calls before returning.
- `registerTool(name, { title, description, inputSchema, annotations }, handler)` accepts a Zod 4 schema directly (Standard Schema with JSON); `strictObject` publishes `additionalProperties: false`. An invalid call is answered by the SDK itself and never reaches the handler.
- `InMemoryTransport.createLinkedPair()` is exported, which let the unit tests speak JSON-RPC without installing `@modelcontextprotocol/client`.
- `@modelcontextprotocol/node`, `hono` and any peer were not needed or installed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A watch subscription that finished opening after `Indexer.stop()` was never closed**
- **Found during:** Task 2 (the "every line the real server prints" test hung for 60 s after end of input)
- **Issue:** `start()` awaits `subscribeGit` and `subscribe`; `stop()` ran while they were pending, found nothing to unsubscribe, and the native `@parcel/watcher` handles opened afterwards kept the process alive. `start()` also kept opening file watches after `stop()`.
- **Fix:** `cover`, `watchGitDir` and `attach` return at once when stopped and close a late subscription themselves (`closeLate`). Two regression tests gate the file watch and the git watch open across `stop()` (RED then GREEN, both failing on "no file watch is left open" before the fix).
- **Files modified:** src/indexer/indexer.ts, src/indexer/indexer.test.ts
- **Verification:** `node --test src/indexer/*.test.ts` (80 pass), the stdio suite three times in a row, `npm test` (2056 pass)
- **Committed in:** `02521a9`

**2. [Rule 1 - Bug] A Host call in flight at end of input built a tenant after the Host was disposed**
- **Found during:** Task 3 (the "EOF in the same chunk as a request" case hung)
- **Issue:** The transport closes at end of input and returns; the bin then disposed the Host while the first tool call was still creating its tenant, which opened watchers nobody would close.
- **Fix:** `runMcpShim` tracks the calls it hands to the Host and waits for them (no timeout) before returning.
- **Files modified:** src/mcp-shim/index.ts
- **Verification:** the case passes; the suite was run three times
- **Committed in:** `420e9e6`

**3. [Rule 3 - Blocking] The bin cannot import `../mcp-shim/stdout-guard.ts` directly**
- **Found during:** Task 1 design
- **Issue:** the plan's acceptance criterion says the bin's first import is the guard file, but the boundary lint (D-12) forbids a deep import across modules.
- **Fix:** the bin's first import is `../mcp-shim/index.ts`, whose own first import is `./stdout-guard.ts`; module evaluation order makes the guard the first code that runs. A source-layout test asserts both facts, and that the guard contains no `console` token.
- **Files modified:** src/bin/gsd-atlas-mcp.ts, src/mcp-shim/index.ts
- **Committed in:** `e1d10c2`

**4. [Rule 3 - Blocking] A shared test client had to live in a helper**
- **Found during:** Task 3
- **Issue:** `package.test.ts` needed the stdio client, and importing a `*.test.ts` file would run its tests.
- **Fix:** `McpProcess` and `StdinQueue` moved to `scripts/test-helpers/mcp-process.ts` (not in the plan's file list).
- **Committed in:** `1858014`

---

**Total deviations:** 4 auto-fixed (2 bugs in Phase 2 code paths, 2 blocking)
**Impact on plan:** The two bugs were real shutdown defects that the plan's EOF and restart requirements exposed; fixing them was needed for those requirements. No scope creep beyond the three-hunk Indexer change.

## Issues Encountered

- A first-time hang in a hand-run reproduction script left a stale server process behind; it was the same Indexer race, and the process was killed. No test process remains.
- The Task 1 "unit tests must not import the guard" rule follows from the guard patching the importing process: node:test reports over the child's stdout.
- Known hazard (recorded, not fixed): four simultaneous fresh-bearing requests at concurrency 4 degrade with `fresh_timeout` (HRD-05). The MCP server has no admission of its own, so an agent that fans out four `fresh` calls at once will see it.

## Known Stubs

None.

## Threat Flags

None. The new surface (a stdio server) is the planned one; no network listener, no new file access beyond the Host's own.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-24 onward can call the MCP tools from skills and hooks; the contract (names, schemas, one text item, `isError`) is fixed and tested.
- Plan 02-28 will add the start-up Reconcile deadline and the `reconciling` degraded code; the restart tests already accept a degraded first answer and poll the unnamed case.
- Startup still pays the import cost of the Host module graph, because `host-client` re-exports the Host. The A27 goal of a shim that loads no SQLite or grammar code needs a thinner client (Phase 4 relay), not a change here.
- Linux and Windows are untested (D8): pipe semantics, SIGKILL on Windows and native watcher shutdown rest on three-OS CI.

## Self-Check: PASSED

- Files: src/mcp-shim/server.ts, index.ts, stdout-guard.ts, mcp.test.ts; src/bin/gsd-atlas-mcp.ts; scripts/mcp-stdio.test.ts, scripts/test-helpers/mcp-process.ts, scripts/test-helpers/stdout-noise-child.ts exist.
- Commits 2522ca5, 5df0ce4, e1d10c2, 02521a9, d239ece, eb1a39f, 1858014, 420e9e6 are ancestors of HEAD.
- `npm run typecheck`, `npm run lint`, `npm run build` exit 0; `node --test src/mcp-shim/mcp.test.ts scripts/mcp-stdio.test.ts scripts/package.test.ts` 39 pass; `npm test` 2056 pass, 0 fail; `dist/bin/gsd-atlas-mcp.js` starts with a shebang and exits 0 on closed stdin.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-17*
