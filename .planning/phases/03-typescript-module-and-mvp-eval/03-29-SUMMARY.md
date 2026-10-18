---
phase: 03-typescript-module-and-mvp-eval
plan: 29
subsystem: precise-tier-latency
tags: [eager-resolution, resolve-cursor, incremental-update, old-program-reuse, warm-start, precise-command-gate, build-envelope-notes, tdd]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-15 needsApprovalFrom, permissionsFor, addAllowEntry (origin-aware approvals); 03-25 relations over the same worker; 03-27 memory budget, pool, 70 percent program rule and the memory-stop latch (clearMemoryStop existed, not wired); 03-23 worker, client, tier; 03-16 frozen Stage A (D-08 precondition); OQ5 Confirmed in 03-DECISIONS.md"
provides:
  - "FactStore.resolve(worktree, {budgetMs, batchSize}): time-boxed, resumable, idempotent pass over every reference site of an overlay (cursor in meta keyed by snapshot and context, plus the asked markers); ResolveResult adds asked, answered, degraded and stopped"
  - "Tenant: build runs the pass in the indexing Governor class under precise.requestTimeoutMs (resolver_timeout note when it runs out); maintain resolve runs it in slices and reports TaskReport.precise {asked, answered, complete, command?}"
  - "Build envelope diagnostics: BUILD_NOTE_CODES (emit_output_not_indexed, citation_comment_too_long) without a subject, then resolver_timeout; gsd-atlas.build/1 data keys unchanged; a clean build keeps diagnostics []"
  - "Protocol update message and done.reads; client per-worker hash map, update before resolve and relations; worker caching host with oldProgram reuse, dirty marks applied at next use, drop-before-build past 70 percent of the limit"
  - "PreciseTier.warm and TypeScriptResolver.warm: background worker start after the start-up Reconcile; silent on failure"
  - "src/tenant/precise-command.ts runApprovedPreciseCommand, declaredPreciseCommands, mergeCommandReports; CommandGate on TenantDeps built by the Host; CommandReport {ran, ok, exitCode, signal, timedOut, ms, needsApproval}"
  - "scripts/precise-gate.ts --update (save one file to precise answer, on a copy) and --lazy (build without the eager pass)"
affects: [03-28, 03-30, 03-31, 03-34]
tech-stack:
  added: []
  patterns:
    - "The eager pass is the lazy read path run ahead of time: readResolving, resolveSites, validate and store are reused, so a cached answer and a fresh one cannot differ"
    - "The asked markers are the truth of progress; the cursor in meta is only a shortcut over them, so a lost cursor costs a walk, never a wrong answer"
    - "An update only marks; the rebuild happens when a request uses the program, from the old program, so a burst of edits costs one rebuild and a program nobody asks about costs none"
    - "An unapproved command is refused before the runner is offered it (SEC-01: not even attempted); the runner still decides when it is asked"
key-files:
  created:
    - src/tenant/precise-command.ts
    - src/tenant/precise-command.test.ts
    - src/precise-resolver/typescript/update.test.ts
  modified:
    - src/fact-store/types.ts
    - src/fact-store/store.ts
    - src/fact-store/resolve.ts
    - src/fact-store/index.ts
    - src/fact-store/contract.ts
    - src/fact-store/resolve.test.ts
    - src/tenant/create.ts
    - src/tenant/types.ts
    - src/tenant/messages.ts
    - src/tenant/defaults.ts
    - src/tenant/project.ts
    - src/tenant/index.ts
    - src/tenant/tenant.test.ts
    - src/host/host.ts
    - src/bin/compose.ts
    - src/precise-resolver/typescript/protocol.ts
    - src/precise-resolver/typescript/protocol.test.ts
    - src/precise-resolver/typescript/worker.ts
    - src/precise-resolver/typescript/client.ts
    - src/precise-resolver/typescript/tier.ts
    - src/precise-resolver/typescript/index.ts
    - src/precise-resolver/typescript/resolver.test.ts
    - scripts/precise-gate.ts
    - scripts/precise-gate.test.ts
    - scripts/explain-e2e.test.ts
    - scripts/precise-e2e.test.ts
    - docs/reference/cli.md
    - docs/reference/mcp.md
key-decisions:
  - "The eager pass asks only sites of files a compiler config owns. gsd-core holds 550,594 reference sites in 1,689 files, 35,727 of them in a config; asking all of them took the build to 31.6 s, asking the owned ones takes it to 11 s. The read path is unchanged: a read that meets an unowned site still asks, and the adapter answers at once without a worker."
  - "A module command is refused BEFORE it is offered to the runner. The SEC-01 hostile-repository test (03-13) asserts that no process but built-in git is even attempted, and the recording runner counts a denied run as an attempt, so the Host hands the Tenant a CommandGate whose approved() asks decide() with this Host's permission list. The runner's own rule and needsApprovalFrom stay as the second check."
  - "An update marks the held programs and the rebuild happens at their next use, from the old program (a host that returns the old program's own SourceFile for every file not named dirty). Unaffected programs cost nothing, a program the memory rule dropped needs no mark, and a larger change is several small messages."
  - "The warm start starts the worker and builds no program. It has no overlay to set the update baseline from, and a program built from a guessed baseline could be stale; the measured saving is the worker start (about 215 ms on gsd-core)."
  - "build and an explicit maintain resolve call tier.clearMemoryStop() (the 03-27 carry-over). Other tasks do not. The latch key (context id, config hashes, compiler directory) is untouched."
  - "resolveBoundMs of zero or less turns the pass after a build off. It is the hook for precise-gate --lazy, which keeps the 03-27 per-read memory measurements meaningful."
requirements-completed: [TSM-06, SEC-02, SEC-01]
status: complete
commits: 6
plan_head_before: 10edca445ff051696b2b25a160618acbd09d2ba2
plan_head_after: 76881a258c5abda80031e577b8d16b55c3ff31da
actuals:
  tokens: 52100
  tasks: 3
  commits: 6
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 29: Eager resolution, incremental update, warm start and the gated module command Summary

**A build now fills the resolved-edge cache before it returns (gsd-core: 11 s for the index plus the compiler pass), one saved file reaches a precise answer in about 250 ms through an update message and an old-program rebuild, a Tenant over an indexed worktree starts its worker in the background, and a module's `precise.command` runs only for the exact command a person approved, reporting exit status and nothing it printed.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | After build, the first code_refs is precise from the cache without asking the resolver | b621a2b | 415429f |
| 2 | Incremental update with a caching host and oldProgram, and the background warm start | 6ca32a9 | 22a007a |
| 3 | The approved precise.command gate | 1a0f098 | 76881a2 |

The tracer gate (task type `tracer`, no `gate` attribute, auto mode off, `HUMAN_VERIFY_MODE` end-of-phase, automated-only `<verify>`): the verify command was re-run after the commit (340 tests, typecheck, lint) and passed, so execution continued. Each RED commit holds tests only. Task 1's RED was run on the tree before the change (30 of 339 failed); Tasks 2 and 3 were run against an archive of the previous commit (10 of 11 failed; the Task 3 file could not even load because `precise-command.ts` did not exist).

## What was built

- **`FactStore.resolve`** (`src/fact-store/resolve.ts`, `store.ts`, `types.ts`). It walks the overlay's files in path order, asks the resolver for up to `batchSize` sites per call through the same phase 1 (`readResolving`), phase 2 (`resolveSites`, validate, store) and phase 3 path a read uses, and keeps a cursor (`resolve_cursor:<snapshot>:<context id>` in `meta`, `{path, ord}` or `{done}`). The time box is checked between batches and one batch always runs, so a call makes progress at any budget. A resolver failure never throws: the pass stops, `degraded` names the code (`resolver_failed`, `memory_budget`, `cache_unavailable`) and `stopped` is `failure`; running out of budget is `stopped: 'budget'`. A follower gets `WriterBusy` like the other maintenance tasks. Cursors of superseded snapshots are dropped when a new one is written.
- **Tenant** (`create.ts`). `build` runs the pass after the Indexer's build and attach, in slices of one `store.resolve` call each, every slice a Governor job in the `indexing` class, bounded by `precise.requestTimeoutMs` (25,000 ms) in all. A pass that runs out leaves the build successful with a `resolver_timeout` info note. `maintain resolve` runs the same slices without a bound, returns `precise {asked, answered, complete}` and a fixed note when the compiler failed. With no resolver it keeps `no precise tier is active` and still needs neither lease nor overlay.
- **Build envelope** (`messages.ts`). `buildNotes(skipped, resolverTimedOut)` copies the notes of `BuildResult.skipped` whose code is on `BUILD_NOTE_CODES` and that have no `subject`, in the order the build reported them, then the Tenant's own `resolver_timeout`. It reads `BuildResult.skipped` alone, so plan 03-28 Task 4 changes nothing here. `buildData` and the `data` keys are untouched.
- **Incremental update.** The client keeps, per worker, the content hash of every compiler path it has told the worker about (set from the overlay of the worker's first read, so a fresh worker needs no update), and before each resolve or relations request sends `update {changed, removed}` for the difference (new paths included; the config files too when the context's config hashes changed; at most 2,000 per list per message). The worker marks the held programs the paths belong to; a path in no program is only a hint that a source file may have appeared. At the next use of a marked program the worker rebuilds it with `oldProgram` and a host that returns the old program's own `SourceFile` for every file not named dirty, so a rebuild after one edit reads one file; it parses the config again only when a file may have been added or removed, and past 70 percent of the RSS limit it drops the old program first and builds from disk. `done` carries `reads`, the source files read since the last report.
- **Warm start.** After the start-up Reconcile of a worktree the store already indexes, the Tenant calls `tier.warm(worktree, facts, context)`; the resolver starts its worker through the pool (so the memory latch, the budget and the idle timer all apply) and says nothing on failure.
- **Gated module command** (`precise-command.ts`, `CommandGate`). For each module that declares `precise.command`, `maintain resolve` asks the Host's `approved(command)`; only an approved command is given to the runner (executable and arguments from the manifest, `cwd` and context repository the repository root, `timeoutMs` the approved bound). The report holds `ran`, `ok`, `exitCode`, `signal`, `timedOut`, `ms`, `needsApproval`; the result's output is never read (a test asserts the helper's source names neither stream). A refusal, early or late, adds `needs_approval` to `degraded` and the fixed diagnostic of plan 03-15 to the envelope.
- **Gate script.** `--update` copies the checkout (`node_modules` linked), builds the copy, asks for the references of the traced function, appends a comment and a function that calls it to the traced file, and prints the milliseconds until `code_refs` returns a precise reference inside the new function; exit 0 within 60 s. `--lazy` (and `ComposeOptions.tuning`) builds without the eager pass.

## Measurements (pinned gsd-core 10ac3a7, prepared with `npm ci --ignore-scripts`, copied without node_modules; macOS arm64, Node 26.11.1)

| Measure | Result |
|---------|--------|
| Index build alone (`--lazy`) | 6.5 to 6.9 s (1,689 files) |
| Build with the eager pass (TSM-06 "full build") | 10.6, 10.8, 11.4 and 11.7 s in four runs; no diagnostics; the pass asked 35,727 sites and kept an edge for 15,600 |
| First pass design that asked every site | 31.6 s, 550,594 sites, bound hit with `resolver_timeout` (see Deviations 2) |
| One-file update, save to precise answer (`--update`) | 245, 246 and 263 ms (the first runs, before the pass skipped unowned sites, took 647 to 705 ms); 1 update message, 1 path |
| Worker resident memory, before and after the update | 476.7 to 479.0 MB before, 481.8 to 484.0 MB after (peak 484.0), `ps` 514 to 518 MB; 1 program |
| First `code_refs` after a start over an indexed worktree with one file edited, 3 s after the first request | without the warm start 730, 852, 889 ms (worker started at the query); with it 607, 621, 592 ms (worker started 0.57 s after the first request) |

The worker start is the part the warm start removes (about 215 ms); the program build and the resolve (about 600 ms) are still paid by the first query that meets a cold cache. The strict gate figures (30 s, 5 s, 2 s) and their ceilings belong to plan 03-30; these runs would pass the strict build and update figures. The compiler source in the gate copy is the bundled 6.0.3 (the linked `node_modules` is outside the copy, so the project compiler is not used; the project's is the same 6.0.3).

## Verification

`npm run typecheck`, `npm run lint`, `npm run build` and `npm run schema:check` clean. `npm test`: 4,172 tests, 4,170 pass, 0 fail, 2 skipped (both pre-existing). `node scripts/eval/verify-prereg.ts`: ok (no Stage A file touched). The SEC-01 hostile-repository test (`src/host/hostile-config.test.ts`), `allow.test.ts` and `compose.test.ts` pass unchanged. `update.test.ts`, `precise-command.test.ts`, `tenant.test.ts` and `precise-gate.test.ts` were run three times in a row with no failure. New cases: `resolve.test.ts` 10 per driver plus 1 contract case per driver, `tenant.test.ts` 12, `update.test.ts` 11, `precise-command.test.ts` 14, `protocol.test.ts` 1, `resolver.test.ts` 2, `precise-gate.test.ts` 3.

## Deviations from Plan

**1. [Rule 1 - Bug] Four existing tests assumed a cold cache after a build**
- **Found during:** Task 1 (full run after the pass existed)
- **Issue:** `resolver.test.ts` (stale file; killed worker), `explain-e2e.test.ts` (no worker started by explain), `precise-e2e.test.ts` (worker dies with its host) and `precise-gate.test.ts` (per-package memory calibration) each relied on the first read after a build being the first use of the compiler. The pass moves that use into the build, which is the point of the plan.
- **Fix:** each test now sets up the cold read it is about: a runner whose first worker fails (stale file), a new file plus a reconcile (killed worker; parent killed), removal of the marker the build's worker wrote (explain), and `--lazy` for the calibration plus a new test for the eager pass under the same limit. No assertion about behavior was loosened.
- **Commits:** 415429f

**2. [Rule 2 - Missing critical] The pass asks only sites of files a compiler config owns**
- **Found during:** Task 2 measurement on the pinned gsd-core
- **Issue:** the plan's text says the store asks for all sites and the adapter ignores the ones without an owner, and the research counted 28,466 sites. gsd-core's overlay holds 550,594 reference sites, 515,000 of them in `.cjs` files outside every config; asking each cost a lookup and a marker, the pass hit its 25 s bound and the build took 31.6 s (over the 30 s the phase promises).
- **Fix:** `readPassStep` lists the overlay's files, keeps those with a config owner (`PreciseFacts.ownerOf` and `configs`), and reads their sites file by file. A project with no config asks nothing. The read path is unchanged (its tests pin that a read still asks about every site in its answer), so a read that meets an unowned site calls the resolver, which answers at once without a worker.
- **Files modified:** src/fact-store/resolve.ts, resolve.test.ts. **Commit:** 22a007a

**3. [Interpretation] `precise.complete: false` on a bounded build**
- The behavior list says a build whose pass hits its bound returns `precise.complete: false`, while the amendment of 2026-10-18 freezes the `data` keys of `gsd-atlas.build/1`. The amendment wins: the visible signal is the `resolver_timeout` note, and `maintain resolve` reports `precise.complete` (a test shows it finishing the pass).

**4. [Interpretation] An unapproved command is refused before the runner is asked**
- Task 3 says the helper builds the spec, calls `runner.run` and maps a `command_denied` result. The SEC-01 test of plan 03-13, which the plan says must pass unchanged, counts a denied run as an attempt ("a spec for node was attempted, not merely denied"), so the Tenant would have failed it. `CommandGate.approved` (the Host asks `decide()` with its own permission list) is checked first; the denied-result mapping stays as the late check. Because `tenant` cannot import `host` (the Host imports the Tenant), `needsApprovalFrom` reaches the helper through `TenantDeps.commands` and the file still names it.

**5. [Rule 3] Files outside `files_modified`**
- `src/host/host.ts` (the CommandGate), `src/bin/compose.ts` (`tuning` test hook for `--lazy`), `src/tenant/{index,defaults,project}.ts` (exports, the two new tuning keys and `warmStart`, `ProjectProvider.resolution`), `src/precise-resolver/typescript/{index,protocol.test}.ts`, `scripts/explain-e2e.test.ts` and `scripts/precise-e2e.test.ts` (Deviation 1).

**6. [Detail] The reads counter is always reported, not env-gated**
- The plan asks for an environment-controlled debug counter, off by default. The compiler worker's runner shape allows exactly one environment key, so a test could not set another. `done.reads` is an optional integer, cheap, and reports a count only.

**7. [Detail] Updates are applied lazily, and the warm start builds no program**
- The plan describes the worker rebuilding on `update`. Marking and rebuilding at next use gives the same answers, lets a large change travel as several messages, and costs nothing for a program nobody asks about; the counter therefore appears in the `done` of the request that used the program. The warm start starts the worker only (see key decisions).

**8. [Detail] The build runs the pass in slices, not as one job**
- Each slice is one Governor job of at most `maintenance.sliceMs`, so an interactive read can take a turn on a one-slot Governor during a 25 s pass. `TenantTuning` gained `resolveBoundMs`, `resolveBatchSites` and `warmStart`, copied from the precise values of 03-CONSTANTS.md (no new constant).

**9. [Process] Test-first order**
- Three RED commits, each tests only. The adaptations of the existing tests (Deviation 1) went into the Task 1 GREEN commit, because they repair tests the change broke rather than describe new behavior.

## Open items

- **Windows and Linux:** the update measure links `node_modules` with a junction on Windows (not run here), the pressure and kill tests are macOS-measured; CI will say.
- **A memory stop during the pass loses its batch.** The adapter answers a batch as a unit, so a program that overflows the budget loses the batch's small-package answers too, and the 03-27 latch then degrades the project's reads. On gsd-pi-like repositories with one huge package the build still succeeds and the answers degrade with `memory_budget`; `precise-gate --nobreak --lazy` shows the per-read behavior of 03-27, and the default shows this one (a test pins both).
- **Warm start builds no program** (no baseline for the update map without an overlay accessor on the Reader); a later plan could pass the overlay hashes and warm the busiest config as well.
- **A read that meets an unowned site still calls the resolver** (cheap, no worker); marking those sites settled at read time would change the read contract and was left alone.
- The relations of 03-25 are not part of the pass.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-03-291 (no start without an exact approval; changed argument; MCP origin) and T-03-292 (output never read; a marker is searched in the envelope, the spec records, the flight recorder and every file of the store directory) are mitigated and tested; T-03-293 (the pass is bounded and resumable, the command has the approved limit) and T-03-294 (the update message; tests edit, remove, add and re-ask) as planned; T-03-295 (allow-list plus no subject; a test feeds a note with a path subject and a marker message and one with an unlisted code). The only new process surface is the module command, which the plan names.

## Self-Check: PASSED

- Files present: src/tenant/precise-command.ts, src/tenant/precise-command.test.ts, src/precise-resolver/typescript/update.test.ts and every modified file listed above.
- Commits b621a2b, 415429f, 6ca32a9, 22a007a, 1a0f098 and 76881a2 are ancestors of HEAD; `git rev-list --count 10edca4..HEAD` was 6 before this file was added.
