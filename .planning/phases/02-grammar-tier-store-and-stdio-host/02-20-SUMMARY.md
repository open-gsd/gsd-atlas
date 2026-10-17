---
phase: 02-grammar-tier-store-and-stdio-host
plan: 20
subsystem: host
tags: [host, tenant, governor, lease, follower, indexer, query, zod, user-config, composition-root]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: Governor (02-09), Metrics (02-10), Fact Store with lease and upkeep (02-06/11/12/18), pooled engine (02-14), Indexer (02-15/17), Query (02-16/19)
provides:
  - "createTenant: one repository's Source Tree, Fact Store with the writer lease, Metrics, Indexer, Query and status ports"
  - "createHost: function-scoped tenant registry keyed by store id, lazy tenant creation, repo/cwd to worktree routing, Governor classes with busy and retry_after"
  - "Host request kinds code_find, code_refs, code_context, code_impact, atlas_status, build, maintain, status, plus the moved lang_test and lang_list"
  - "Indexer.refresh and a force flag in batch processing (forced re-extract of stale files)"
  - "loadUserConfig (user directory and environment only) and composeHost (the shared composition root of the bins)"
  - "the in-process HostClient delegating every kind to the Host; TOOLS, TOOL_NAMES, buildRequest and ERROR_SCHEMA re-exported from Query"
affects: [02-22 cli commands, 02-23 mcp server, 02-24 history, 02-25 hooks, 02-26 gates, 02-27 follower overlay, 02-28 idle maintenance and takeover]

actuals:
  tokens: 30262
  tasks: 3
  commits: 7
plan_head_before: c77f18dad97e03f691da661d9da46dfd02de43ba
plan_head_after: 1f8039a93e48f4aea3891243eee83103c7358b03

tech-stack:
  added: []
  patterns:
    - "the Host is the only module-level-state-free composition root: the tenant registry is a function-scoped Map, so two Hosts in one process are independent"
    - "a request that hands its work to the Indexer (build, maintain) only waits for a Governor turn in its class; it does not hold the slot while the Indexer schedules its own pieces in that class"
    - "user configuration is read by a function whose only parameters are the user directory and the environment"
    - "a maintenance task reports { complete, spentMs, processed } and store tasks loop in maintenance.sliceMs slices until complete"

key-files:
  created:
    - src/tenant/types.ts
    - src/tenant/defaults.ts
    - src/tenant/create.ts
    - src/tenant/status-port.ts
    - src/tenant/index.ts
    - src/tenant/tenant.test.ts
    - src/host/types.ts
    - src/host/host.ts
    - src/host/route.ts
    - src/host/lang.ts
    - src/host/config.ts
    - src/host/index.ts
    - src/host/harness.test.ts
    - src/host/host.test.ts
    - src/host/two-tenant.test.ts
    - src/bin/compose.ts
    - src/bin/compose.test.ts
    - src/fact-store/auto-vacuum.test.ts
  modified:
    - src/host-client/in-process.ts
    - src/host-client/index.ts
    - src/indexer/index.ts
    - src/indexer/indexer.ts
    - src/indexer/process.ts
    - src/indexer/types.ts
    - src/indexer/indexer.test.ts
    - src/query/index.ts
    - src/bin/gsd-atlas.ts

key-decisions:
  - "Plan 02-20: build and maintain take only an admission turn in their Governor class and run outside the slot; code requests hold an interactive slot for the read - Four concurrent builds holding all four slots would starve the indexing-class pieces the Indexer schedules for them"
  - "Plan 02-20: collect, compact and check are called on the store directly (write authority, not the in-process writer slot), so maintenance runs while the Indexer holds the writer and store.maintain is not used by the Host - open item 4 of the dispatch"
  - "Plan 02-20: Indexer.refresh is the forced re-extract path; batch processing takes force, and in a forced pass only the first path of a content hash is extracted, the rest link to its refreshed facts - Reconcile still attaches a stale hash through Writer.link and does not clear it"
  - "Plan 02-20: a follower tenant creates no Indexer and no watcher, answers fresh paths as not completed (degraded fresh_timeout), and answers build and maintain with lease_held; an unindexed worktree is never indexed because a request named fresh paths (D-11)"
  - "Plan 02-20: loadUserConfig ignores a wrong file whole with one user_config_ignored warning; permissions are { allow: [...] } as UserPermissions defines them, not the permissions.commands the plan prose wrote"
  - "Plan 02-20: tenant creation hands the first request to resolveRepository, which returns the main worktree as the tenant directory and the longest listed worktree containing the request as the overlay"

patterns-established:
  - "Tenant.build indexes then attaches: build, then Indexer.attach(worktree) subscribes the watcher and reconciles once more"
  - "Error envelopes for a repository whose tenant cannot open (store_unavailable, schema_too_new) are per repository; the failed creation is forgotten so the next request retries"

requirements-completed: [HST-02, HST-03, STO-08, IDX-04, STO-10]

coverage:
  - id: D1
    description: "A real repository is built and queried through the Host: not_indexed before a build, build then code_find with a citation and fenced line text, a second build parses nothing, code_refs and atlas_status served, a fresh edit found without the watcher"
    requirement: "IDX-04"
    verification:
      - kind: integration
        ref: "src/host/host.test.ts#Host: build, then find"
        status: pass
      - kind: integration
        ref: "src/tenant/tenant.test.ts#createTenant"
        status: pass
    human_judgment: false
  - id: D2
    description: "Per-repository tenants in one Host with separate stores, watermarks and results; closing one leaves the other serving; one repository's unusable store gives an error for that repository only"
    requirement: "HST-02"
    verification:
      - kind: integration
        ref: "src/host/two-tenant.test.ts#two tenants in one Host"
        status: pass
      - kind: integration
        ref: "src/host/host.test.ts#Host: tenant isolation (T-02-68)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Governor classes per request kind and busy with a positive integer retry_after under fifty simultaneous requests, never an exception, never more running than the concurrency"
    requirement: "HST-03"
    verification:
      - kind: integration
        ref: "src/host/host.test.ts#Host: busy and Governor classes (HST-03)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Follower basics: reads with degraded follower, no Indexer and no watcher, fresh answered as not completed, build and maintain answered with lease_held"
    requirement: "STO-08"
    verification:
      - kind: integration
        ref: "src/host/host.test.ts#Host: follower and lease_held (STO-08)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Maintain tasks reconcile, resolve, refresh, collect, compact, check and all as requests, with Indexer.refresh re-extracting stale files"
    requirement: "STO-10"
    verification:
      - kind: integration
        ref: "src/host/host.test.ts#Host: maintain tasks (STO-10)"
        status: pass
      - kind: integration
        ref: "src/indexer/indexer.test.ts#Indexer.refresh: a forced re-extract of stale files (STO-10)"
        status: pass
      - kind: integration
        ref: "src/tenant/tenant.test.ts#Tenant.maintain"
        status: pass
    human_judgment: false
  - id: D6
    description: "User-level configuration from the user directory and the environment only, the shared composition root, and the CLI bin on the new Host with Phase 1 behaviour unchanged"
    requirement: "HST-02"
    verification:
      - kind: unit
        ref: "src/host/host.test.ts#loadUserConfig: user-level configuration only (T-02-67)"
        status: pass
      - kind: integration
        ref: "src/host/host.test.ts#Host: configuration reaches the tenant (T-02-67)"
        status: pass
      - kind: integration
        ref: "src/bin/compose.test.ts#composeHost"
        status: pass
      - kind: integration
        ref: "node --test src/cli/cli.test.ts src/lang/lang-test.e2e.test.ts scripts/package.test.ts"
        status: pass
    human_judgment: false

duration: 18 min
completed: 2026-10-17
status: complete
---

# Phase 2 Plan 20: Tenant, Host and the composition root Summary

**A per-repository Tenant and a lazily populated Host behind the unchanged HostClient: explicit build then cited find, Governor classes with busy and retry_after, a follower that reads and refuses to write, maintenance tasks as requests with a forced stale-file refresh, user-only configuration, and one composition root for the bins.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-10-16T23:52:20Z
- **Completed:** 2026-10-17T00:10:13Z
- **Tasks:** 3 (each as a RED commit and a GREEN commit), plus one regression test commit for an open item
- **Files modified:** 27 (18 created, 9 modified); 2,617 lines added, 182 removed

## Accomplishments

- `createTenant` composes Source Tree, store location, Fact Store with the cross-process lease, Metrics (`metrics.db` beside the store), the Indexer (created on first need) and Query, with the Indexer's `ensureFresh` and a real `StatusPort`. `atlas_status` now answers from injected ports (open item 3).
- `createHost` keeps the registry in a function-scoped `Map` keyed by store id, creates tenants on the first code request, resolves `repo`, `cwd` or the Host's working directory to an existing real directory inside a git repository and the longest listed worktree containing it, and answers `not_a_repo`, `invalid_args`, `not_indexed`, `busy`, `lease_held`, `store_unavailable` and `host_closed` as envelopes.
- D-11 holds end to end: nothing is indexed until `build`; `build` indexes and then attaches the worktree to the Indexer; a tenant over an already indexed store starts the Indexer for exactly those worktrees, in the background; `fresh` paths on a worktree nobody built index nothing.
- HST-03: code requests hold an interactive Governor slot; `build` and `maintain` wait their turn in the indexing and maintenance classes; a busy answer is an error envelope with `retry_after` and the request never runs. With concurrency 1 and an interactive queue of 2, fifty simultaneous `code_find` requests gave exactly three ok answers and 47 `busy` answers.
- STO-08: a second Host on the same repository is a follower: `code_find` answers with degraded `follower`, no Indexer is created, no watcher is subscribed, `fresh` degrades with `fresh_timeout`, `build` and `maintain` answer `lease_held`.
- STO-10: `maintain` runs `reconcile`, `resolve` (a no-op with a note), `refresh`, `collect`, `compact`, `check` and `all`; store tasks loop in `maintenance.sliceMs` (200 ms) slices until complete; `Indexer.refresh` re-extracts stale files with a `force` flag that skips the link shortcut (open item 1).
- Configuration: `loadUserConfig(userDir, env)` with a strict zod schema, a 64 KiB bounded read, whole-file rejection with one warning and `GSD_ATLAS_STORE_DIR`; a hostile `config.json` and `.gsd-atlas/config.json` in a repository change nothing (tested).
- `composeHost` builds the real runner with the user permissions, the pooled engine, the Governor, the system clock, the roots, the cache root and the parcel event source; `gsd-atlas` uses it and closes the Host and the engine when the command ends.
- Open item 2: one `ERROR_SCHEMA`, the Query one, re-exported by the host-client seam together with `TOOLS`, `TOOL_NAMES` and `buildRequest`.

## Task Commits

1. **Task 1: Tracer - build then code_find through the real Host, Tenant, store, Indexer and engine** - RED `f1aa44b` (test), GREEN `7f50075` (feat)
2. **Task 2: Governor classes and busy, follower basics, maintain tasks, tenant isolation and the two-tenant smoke** - RED `801e633` (test), GREEN `7863b08` (feat)
3. **Task 3: User-level config, the composition root, and the CLI bin on the new Host** - RED `f7c6a37` (test), GREEN `527a21d` (feat)
4. **Open item 7 regression test** - `1f8039a` (test)

**Plan metadata:** the docs commit that carries this summary.

## TDD Gate Compliance

Every task has a `test(02-20)` commit before its `feat(02-20)` commit. RED evidence was classified `RED_EVIDENCE_OK` for each task:

- **RED, Task 1:** target `the build request is what makes find succeed; a second build parses nothing` in `src/host/host.test.ts`. The stand-in Host answered every kind with `unknown_kind`; the first assertion failed (`gsd-atlas.error/1` against `gsd-atlas.build/1`) on a real repository with the real runner and engine. Not a syntax, import, fixture or zero-test fault.
- **RED, Task 2:** target `re-extracts the files a grammar upgrade marked stale and clears them from the watermark` in `src/indexer/indexer.test.ts`. The real Writer marked three files stale, then the stand-in `refresh` answered `{ processed: 0 }` against `{ processed: 3 }`. Ten cases failed together on planned assertions (maintain tasks, follower, class mapping, tenant refresh, three refresh cases).
- **RED, Task 3:** target `GSD_ATLAS_STORE_DIR overrides store.dir when it is absolute and is ignored with a warning when it is not` in `src/host/host.test.ts`. The stand-in `loadUserConfig` returned `{ config: {}, diagnostics: [] }` for a real file and an absolute override. Seven cases failed together (four `loadUserConfig` cases and the three `composeHost` cases).
- **GREEN and REFACTOR:** each GREEN commit passes its verify command. No REFACTOR commit was needed.
- Task 2 note: the Governor wiring (classes, busy) was written in the Task 1 GREEN commit because the Host's dispatch could not exist without it, so the busy case and the tenant isolation, two-tenant and status cases already passed at the Task 2 RED commit. The target test of that RED is a case that did fail.

## Files Created/Modified

- `src/tenant/create.ts` - the Tenant composition, leader and follower behaviour, build, maintain and status.
- `src/tenant/types.ts`, `src/tenant/defaults.ts`, `src/tenant/status-port.ts`, `src/tenant/index.ts` - types and schemas, `maintenance.sliceMs` from 02-CONSTANTS.md, the `StatusPort` wiring.
- `src/host/host.ts`, `src/host/route.ts`, `src/host/lang.ts`, `src/host/config.ts`, `src/host/types.ts`, `src/host/index.ts` - the registry, routing and argument reading, the moved lang handlers, user configuration, types.
- `src/host-client/in-process.ts`, `src/host-client/index.ts` - the client delegates to the Host; the seam re-exports Query's tool definitions.
- `src/indexer/indexer.ts`, `src/indexer/process.ts`, `src/indexer/types.ts`, `src/indexer/index.ts` - `refresh`, the `force` flag, `createModuleHost`, `ModuleHost`, `createParcelEventSource` exports.
- `src/query/index.ts` - exports `ERROR_SCHEMA` and `errorEnvelope`.
- `src/bin/compose.ts`, `src/bin/gsd-atlas.ts` - the composition root and the bin on it.
- Tests: `src/host/host.test.ts`, `src/host/two-tenant.test.ts`, `src/host/harness.test.ts`, `src/tenant/tenant.test.ts`, `src/bin/compose.test.ts`, `src/indexer/indexer.test.ts`, `src/fact-store/auto-vacuum.test.ts`.

## Decisions Made

- `build` and `maintain` take an admission turn in their Governor class and then run outside the slot. The Indexer schedules its own pieces in the same class, so a request that held a slot for the whole run would let four concurrent builds starve their own pieces (concurrency 4). Code requests hold an interactive slot for the read.
- `collect`, `compact` and `check` are called on the store directly. `store.maintain` takes the in-process writer slot and throws `WriterBusy` while the Indexer's writer is out (open item 4), so the Host does not use it; the Host never needs to release the Indexer's writer.
- `Indexer.refresh` is the forced path (open item 1). In a forced pass only the first path of a content hash is extracted again; its commit refreshes the facts the others share, so the rest link.
- The Tenant is handed the Source Tree and identity by the Host (it needed the identity to find the tenant); the tenant directory is the repository's main worktree, so a removed linked worktree cannot leave a tenant with a dead directory.
- `loadUserConfig` rejects a wrong file whole. `permissions` is `{ allow: [{ repo, executable, argsPrefix? }] }`, the `UserPermissions` the runner takes.
- The tenant's Indexer is started in the background for worktrees the store already indexes; requests are served from the store meanwhile. The start-up Reconcile deadline and the `reconciling` degraded code are plan 02-28.
- `build` and `maintain` data carry counts, not paths: a build reports `{ worktree, files, parsed, linked, removed, skipped, failed, failedCodes }`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The compose test cannot live in `src/host/host.test.ts`**
- **Found during:** Task 3
- **Issue:** The plan puts "a small compose case" in `host.test.ts`, but `composeHost` is in `src/bin/compose.ts` and the boundary lint forbids a deep import of `bin/` from `host/`.
- **Fix:** The compose cases are in `src/bin/compose.test.ts` (three cases: working client with `GSD_ATLAS_USER_DIR`, rejected config on stderr, home config folder).
- **Files modified:** `src/bin/compose.test.ts`
- **Committed in:** `f7c6a37`, `527a21d`

**2. [Rule 1 - Plan inconsistency] `permissions.commands` against `permissions?: UserPermissions`**
- **Found during:** Task 3
- **Issue:** The behaviour text says `permissions.commands`; the artifacts section types `permissions` as `UserPermissions`, which is `{ allow: [...] }`.
- **Fix:** The schema and type follow `UserPermissions` (`permissions.allow`), so the config feeds `createRealRunner({ user })` unchanged.
- **Files modified:** `src/host/config.ts`
- **Committed in:** `527a21d`

**3. [Rule 2 - Missing critical] Admission-only Governor turns for build and maintain**
- **Found during:** Task 2
- **Issue:** "Wrap dispatch in `governor.run`" for build and maintain would hold one of four slots for a whole build while the Indexer's inner jobs (same class) wait for slots: a deadlock at concurrency 1 and starvation when four builds run.
- **Fix:** `admitted()` in `src/host/host.ts` waits for a turn in the class (busy still ends the request) and runs the work outside the slot.
- **Files modified:** `src/host/host.ts`
- **Committed in:** `7f50075`

**4. [Rule 2 - Missing critical] D-11 for `fresh` paths**
- **Found during:** Task 1
- **Issue:** Query calls `ensureFresh` before it reads, so a request with `fresh` paths on a worktree nobody built would have made the Indexer index paths of an unbuilt worktree.
- **Fix:** The tenant's fresh port answers complete without touching the Indexer when the store has no overlay for the worktree; a test case pins it.
- **Files modified:** `src/tenant/create.ts`, `src/host/host.test.ts`
- **Committed in:** `7f50075`

**5. [Plan prose] `atlas_status` does not report the store location**
- **Found during:** Task 3
- **Issue:** The plan says `atlas_status` reports a `config.store.dir` placement; Query's `atlas_status` carries no paths by design (QRY-03).
- **Fix:** The placement is asserted on the `status` panel (`tenant.location.kind` is `override`, `dir` is the override plus the store id) and on `facts.db` existing there.
- **Committed in:** `527a21d`

**6. [Open item 7] Already satisfied; regression test added**
- **Issue:** `openFactStore` already sets `auto_vacuum=INCREMENTAL` and runs `VACUUM` for a new file in WAL mode (plan 02-12). Measured: `auto_vacuum` 2 and `journal_mode` wal.
- **Fix:** `src/fact-store/auto-vacuum.test.ts` pins it on both drivers.
- **Committed in:** `1f8039a`

---

**Total deviations:** 6 (1 blocking, 1 plan inconsistency, 2 missing critical, 2 notes on plan prose and an already satisfied item)
**Impact on plan:** None changes a requirement or an interface other plans consume.

## Issues Encountered

- The first `route.ts` write carried a regex literal with raw U+2028 characters that broke the parse; control characters are now stripped with a code-point loop.
- Internal bounds not in 02-CONSTANTS.md (none is a timeout, a queue bound or a gate threshold): `REFRESH_CHUNK` 256 paths per refresh batch (`src/indexer/indexer.ts`), `MAX_SLICES` 10,000 slices per store task (`src/tenant/create.ts`), the 64 KiB config cap and the `status` window grammar (one to four digits and `m`, `h` or `d`) from the plan and route.

## Known Stubs

None.

## Open Items for Later Plans

- **02-22 (CLI and exit codes):** map `busy` and `lease_held` to exit code 3 and the new kinds (`build`, `maintain`, `status`) to commands; render the Metrics report honestly (the overflow bucket reports a lower bound); supply `io.init` in `src/bin/gsd-atlas.ts` as the dispatch said. The seam already exports `TOOLS`, `TOOL_NAMES`, `buildRequest`.
- **02-23 (MCP server):** `lang_list` takes `repo` through the Host; `atlas_status` strips `repo` and `cwd` before Query's strict schema.
- **02-27 (follower overlay):** a follower answers `fresh` paths as not completed with degraded `fresh_timeout`.
- **02-28 (idle maintenance, takeover, Metrics, start-up deadline):**
  - Nothing records answers, freshness or index-health events yet: the tenant opens `metrics.db` and the `status` panel reads it, but `record` is never called, and `rollup()` is never scheduled.
  - A follower tenant never creates an Indexer, even after it takes over the lease (`onLeaseChange` is not wired).
  - The tenant starts its Indexer in the background and does not wait for the start-up Reconcile, so there is no `reconciling` degraded code and no deadline yet.
  - Schedule an occasional full compaction: the `maintain` request takes `full`, but an idle `maintain` never vacuums.
  - Nobody calls `markStale` yet, so a grammar upgrade must be followed by a `refresh` (the Host provides it); Reconcile itself still only links a stale hash.
- **Governor and `fresh` (HRD-05):** a code request holds an interactive slot while Query waits for `ensureFresh`, whose jobs need a `fresh` slot. With four simultaneous requests that all carry `fresh` paths and concurrency 4, each waits out `ensureFreshWaitMs` (2,000 ms) and degrades with `fresh_timeout`, though the work finishes moments later. Not a deadlock; fairness is Phase 4.
- **Per-request cost:** every repo-scoped request spawns `git rev-parse` and `git worktree list` to resolve its repository. Cache by real directory if the latency gate (02-26) needs it.
- **Open item 5 (`imp/` and `exp/` handles composed in `src/query/context.ts`):** not in this plan's scope; left for the explain work in Phase 3.
- **Open item 6 (the SQLite kit's `IntegerOutOfRangeError` after an FTS5 delete):** not in scope; the workaround in `src/fact-store/lifecycle.ts` stays. A kit-level fix (read `lastInsertRowid` only for inserts) is still open for the kit owner.
- **Linux and Windows:** the lease, the follower path, the parcel watcher under the Host and the pooled engine from the bin are verified on macOS only until the three-OS CI runs them.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The Host serves the full Phase 2 request set in process; plan 02-22 can add the CLI commands and plan 02-23 the stdio MCP server against `HostClient` alone.
- No blockers.

## Self-Check: PASSED

- All 18 created files and 9 modified files exist on disk; the seven task commits (`f1aa44b`, `7f50075`, `801e633`, `7863b08`, `f7c6a37`, `527a21d`, `1f8039a`) are ancestors of HEAD.
- `npm test` passes 1,945 tests (0 failed); `npm run typecheck`, `npm run lint` and `npm run build` exit 0; `node src/bin/gsd-atlas.ts --version` and `lang list`, and the built `dist/bin/gsd-atlas.js --version`, behave as in Phase 1.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-17*
