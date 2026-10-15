# Architecture Research

**Domain:** Local code-intelligence and platform-SDK-facts server for coding agents (MCP, CLI, Agent Skill), single npm package, TypeScript, Node >= 24
**Researched:** 2026-10-15
**Confidence:** MEDIUM-HIGH. The module graph and data flows are derived directly from DESIGN.md (A1-A63) and the 14 draft ADRs, so they are HIGH. The recommended resolutions of open questions, the gaps called out in "Gaps in the frozen design", and the tooling remarks (git batch hashing was verified locally; fs.watch, TypeScript 7 IPC and tree-sitter WASM build details were not verified) are MEDIUM.

**Scope note.** The design is frozen. This document does not redesign it. It turns the designed modules into a build-time dependency graph, a milestone-aligned build order, a single-package layout, and a list of places where the ADR open questions (plus a few the ADRs do not name) force a decision earlier than the PRD milestone suggests.

---

## Standard Architecture

### System Overview (runtime, end state)

```
 ADAPTERS (no logic: translate transport to a Request, return the Envelope unchanged)
 ┌──────────┐ ┌──────────────┐ ┌───────────────┐ ┌──────────────────┐ ┌──────────────┐
 │   CLI    │ │ MCP (stdio / │ │ Hook adapter  │ │ gsd-atlas-mcp    │ │ git pre-     │
 │          │ │ HTTP / sock) │ │ (HTTP hooks)  │ │ thin stdio shim  │ │ commit check │
 └────┬─────┘ └──────┬───────┘ └───────┬───────┘ └────────┬─────────┘ └──────┬───────┘
      └──────────────┴────────┬────────┴──────────────────┴──────────────────┘
                              ▼   HostClient.handle(request)   (in-process M1, remote M2.5)
 HOST (composition root: transport, auth, tenant routing, supervisor)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │  TENANT (one per repo; everything with per-repo state lives here)                    │
 │  ┌─────────┐   ask()   ┌───────────┐ ensureFresh ┌──────────┐ commitFile ┌─────────┐ │
 │  │ Policy  │◀─decide───│   Query   │────────────▶│ Indexer  │───────────▶│  Fact   │ │
 │  │ (pure + │  (adapter │ (ranking, │             │ (queue,  │            │  Store  │ │
 │  │ ledger) │  calls    │ budget,   │──Reader────▶│ watcher, │◀─truth─────│ (writer │ │
 │  └─────────┘  both)    │ fencing,  │             │ reconcile│            │ + reader│ │
 │                        │ envelope) │             └────┬─────┘            │  + life-│ │
 │  ┌─────────┐           └───────────┘                  │ snapshot/hash    │  cycle) │ │
 │  │ Metrics │◀── record(event) from Query/Policy/Indexer/Store/Governor/Host          │ │
 │  │(own db) │                                      ┌───▼──────┐           └─────────┘ │
 │  └─────────┘                                      │ Source   │                       │
 │                                                   │ Tree     │                       │
 │                                                   └──────────┘                       │
 └──────────────────────────────────────────────────────────────────────────────────────┘
 SHARED (one per machine/host): Governor (queues, budgets, parser + compiler pools)
   · Grammar Engine · CommandRunner · SDK providers + shared sdk.db/pkg.db · module registry
   Injected into the Fact Store: resolver = Grammar Engine name-match, then PreciseResolver adapters
```

### Component Responsibilities

| Component | Owns | Depends on (build-time) | Seam / test double |
|-----------|------|-------------------------|--------------------|
| **Foundation** (copied from gsd-graph) | Provenance and confidence types, ids, path confinement, build lock, redaction, fingerprint, reason/exit codes | nothing | none needed (pure) |
| **Shared kernel `facts/`** (new, tiny) | `FileFacts`, fact vocabulary enum, `Answer<T>`, `Watermark`, `Envelope`, `Request`, `degraded` code union, protocol version | Foundation | builders in test helpers |
| **CommandRunner** | The only code that starts a process or loads repo-influenced code in a worker; permission decision; built-in allowlist | Foundation | real adapter + recording fake |
| **Source Tree** | Snapshots (path to blob id, clean-filter correct), source set rules, `hasObject`, `read(commit, path)`, repo identity, git-event detection | CommandRunner | real temp git repos (no port) |
| **Fact Store** | All fact tables, overlays, identity, lifecycle, maintenance, watermark, resolver cache, schema-version refusal, corruption recovery | shared kernel, internal `sqlite/` kit; injected `resolver`, `clock`, `gitHas` | real SQLite in temp dir + fake clock + fake `gitHas`; **no fake store** |
| **Grammar Engine** | Load WASM grammar, run queries, normalize captures to `FileFacts`, name-matched (`INFERRED`) resolution, ADR-citation scan, parse-error accounting | shared kernel, module registry | fixture module (data) |
| **Module registry** | Manifest schema, resolution order (repo, user, npm, built-in), collision rules, `lang list/test` | Foundation | fixture module folders |
| **PreciseResolver adapters** | `EXTRACTED` edges: TS 6.x, TS 7.x, SCIP import, IndexStoreDB helper | shared kernel, CommandRunner, Governor (pool lease), Project model | scripted stub + one shared conformance suite |
| **Project model** (see Gap 1) | Per-ecosystem config reading: config-file set for the resolution context, file sets, emit mapping, targets, language level | Foundation, Source Tree data | fixture repos |
| **Governor** | `run(job{tenant,class,cost}) -> result or Busy`, per-tenant WRR queues, priority classes, time limits, memory budget, parser and compiler pools | clock | fake clock + fake pool |
| **Indexer** | (worktree, path) coalescing queue, event sources, parse then `commitFile`, `ensureFresh`, Reconcile consumption | Source Tree, Grammar Engine, Fact Store (writer), Governor | `ManualEventSource`, fake clock |
| **Query** | `ask(request) -> Envelope`: ranking, token budget, cursor, citations, fencing, redaction, watermark and `degraded`, `explain`, `fresh` | Fact Store (Reader), Indexer (`ensureFresh` only), shared kernel | real store populated through `commitFile` with `FileFacts` builders |
| **Policy** | Pure `decide(event, ledgerEntry, answer)`, bounded in-memory session ledger | shared kernel only | none needed (pure) |
| **Metrics** | `record/report/reset`, own `metrics.db`, daily rollups, labeled report builder | shared kernel, `sqlite/` kit | no-op + SQLite adapter |
| **SDK providers + SdkStore** (M4) | detect/extract per SDK id, shared `sdk.db`, packs, availability table | CommandRunner, `sqlite/` kit | recording fake runner, SDK pack fixtures |
| **Tenant / Host** | `createTenant(deps)`, tenant registry, `host.handle`, transport, auth, supervisor, watchdogs | everything above | in-process `HostClient` |
| **Adapters** (CLI, MCP, hooks, shim) | Transport translation only | `HostClient` and nothing else | golden parity test |
| **Diagnostics / flight recorder / `bug`** (M2) | Local ring buffer, ratings, report building and consent | shared kernel, CommandRunner (`gh`) | recording fake runner |
| **Bridge export** (M5) | Code-to-ADR link export for gsd-graph | Fact Store Reader | golden file |

---

## Dependency Graph and Build Waves

Arrows point from a module to what it needs. Modules in the same wave have no dependency on each other and can be built in parallel.

```
 Wave 0  Foundation ── facts/ kernel ── sqlite/ kit ── CommandRunner(+fake) ── Module registry/manifest schema
         Governor INTERFACE+fake clock ── Observer/record port ── Request/Envelope/protocol types ── HostClient interface
         test kit: temp-git-repo builder, FakeClock, FileFacts builder, fake gitHas, conformance harnesses
              │                 │                      │                         │
 Wave 1  Source Tree      Fact Store (schema v1,   Grammar Engine +       grammar build pipeline
         (needs Runner)    both drivers,            fixture module(s)      (scripts/, CI)
                           conformance suite)
              └─────────────────┴──────────┬───────────┘
 Wave 2                               Indexer ◀── Governor (priority classes, busy; real impl)
                                           │
 Wave 3                    Query ◀── Reader + ensureFresh        Metrics (SQLite adapter, status panels)
                                           │
 Wave 4        Tenant/Host (in-process) ── CLI adapter ── MCP stdio adapter ── parity + 2-tenant + follower tests
 ───────────────────────────────── M1 ends ─────────────────────────────────
 M2      Project model (TS) ─▶ Fact Store resolved layer + resolver port ─▶ TS 6.x adapter ─▶ TS 7.x adapter
         ADR citations (Grammar Engine + Source Tree)    explain (Query)    skill    diagnostics/ratings/bug
 M2.5    Host daemon: lock election, transport, auth, supervisor, watchdogs; remote HostClient; thin shim
         Governor full (WRR across tenants, memory budget, pools); shared sdk.db/pkg.db infrastructure
 M3      Swift module (data) + Swift Project model
 M4      SDK providers + SdkStore + packs; Policy + hook adapter; SDK/syntax Query kinds; dashboard gate panels; eval
 M5      SCIP importer; IndexStoreDB helper; Python module (full); bridge export
 M6      docs, perf pass
```

**Critical path to the MVP (M0 to M2):**
`FileFacts contract -> (Fact Store schema || Grammar Engine normalizer) -> Indexer -> Query -> in-process Host + MCP stdio -> Project model -> resolved layer + resolver port -> TS 6.x adapter -> explain -> eval`.

**Off the critical path (parallel lanes, schedule as filler or to unblock reviewers):**
CI matrix and lint boundaries; grammar build pipeline; Governor real implementation; Metrics; CLI adapter; ADR citations; skill text; diagnostics/ratings/flight recorder/`bug`; free-alternatives evaluation; Policy `decide` and its table-driven tests (unblocked from the end of Wave 0 because it depends only on the kernel types; hook rules R0-R2 need only code tools, so only R3 genuinely waits for M4's SDK and syntax tools).

---

## Recommended Project Structure

Single package `@opengsd/gsd-atlas`, bins `gsd-atlas` and `gsd-atlas-mcp`. Module directories under `src/` mirror the designed modules so that extraction into workspaces later is mechanical. Language modules stay top-level `modules/` (data only).

```
src/
├── foundation/        # copied from gsd-graph with attribution: types(provenance), ids, paths, lock, redact, fingerprint, errors(exit codes)
├── facts/             # shared kernel: FileFacts, vocabulary, Answer<T>, Watermark, Request, Envelope, degraded codes, protocol version
├── sqlite/            # INTERNAL driver kit: node:sqlite + better-sqlite3 adapters, pragma policy, quick_check, backup, schema-version
├── command-runner/    # index.ts (interface), real.ts, fake.ts, builtins.ts (the allowlist table), worker.ts
├── source-tree/       # index.ts, snapshot.ts (batched hashing), source-set.ts, git-events.ts
├── fact-store/        # index.ts (interface only), schema/, reader/, writer/, lifecycle/, maintenance/, resolver-port.ts
├── lang/              # module registry: manifest schema, resolution order, `lang list|test`
├── grammar-engine/    # loader, parse (worker entry), normalize, name-resolve, adr-cites
├── precise/           # PreciseResolver types + conformance suite; adapters/{typescript6,typescript7,scip,indexstore}/
├── project-model/     # ProjectModel seam; typescript/ (M2), swift/ (M3)         (see Gap 1)
├── governor/          # index.ts, scheduler, pools, budget
├── indexer/           # queue, event-source port (fs-watch + manual), reconcile consumer, ensure-fresh
├── query/             # index.ts (ask), kinds/{find,refs,context,impact,status,lang-list,explain,...}, rank, budget, fence, envelope
├── policy/            # decide, ledger, rules R0-R4, modes           (M4; pure)
├── metrics/           # record, report, rollups, adapters/{sqlite,noop}
├── sdk/               # providers/{apple,node}, sdk-store, packs     (M4)
├── diagnostics/       # flight recorder, ratings, report, bug        (M2)
├── tenant/            # createTenant(deps)
├── host/              # handle(), tenant registry, transport/, auth, supervisor/   (transport + supervisor M2.5)
├── adapters/          # cli/, mcp/ (server + shim), hooks/           (hooks M4)
├── bridge/            # export to gsd-graph                          (M5)
└── bin/               # gsd-atlas.ts, gsd-atlas-mcp.ts
modules/               # typescript/, swift/, python/ : atlas-lang.json, grammar.wasm, queries/, features.json, fixtures/  (data only)
scripts/               # build-grammars, bench
test/                  # contract suites, e2e, corpus harness; test/kit/ = doubles and builders (never shipped)
```

### Structure Rationale

- **`facts/` is a separate leaf, not part of `fact-store/`.** `FileFacts` is the contract between Grammar Engine (producer), Indexer (carrier) and Fact Store (consumer). If it lives inside either end, the other imports the other end's internals. Fixing it in Wave 0 lets Fact Store and Grammar Engine be built in parallel.
- **`sqlite/` is an internal kit, not a module callers use.** Three components own SQLite files: Fact Store, Metrics (`metrics.db`) and later SdkStore (`sdk.db`). Factoring pragmas, `quick_check`, backup-API copy and the two drivers into one kit stops the "driver" decision being re-made three times, and keeps the conformance suite in one place. Only those three modules may import it (see Gap 5 on the ADR wording).
- **Precise adapters live in `src/precise/adapters/`, never under `modules/`.** `modules/` stays pure data so third-party modules can ship without code. A manifest's `precise.adapter` names a built-in adapter registered by id; a repo or npm module can name one but never supply one (A44, A55). This is what keeps "publishable later" true.
- **Enforce boundaries mechanically, from day one.** Add a dependency-cruiser (or ESLint `no-restricted-imports`) config: (1) only `command-runner/` may import `node:child_process` or construct a `Worker` that loads repo-influenced code (the ADR requires a lint rule; first-party parser-pool workers are exempt and live behind Governor); (2) only `fact-store/`, `metrics/`, `sdk/` import `sqlite/`; (3) cross-module imports only via `<module>/index.ts`; (4) `policy/` imports only `facts/`; (5) `adapters/` import only `HostClient`. These five rules are the whole reason a single package stays safe.
- **TypeScript build.** Compile with `tsc` to `dist/`; Node 24 can run `.ts` directly via type stripping for dev and tests, but published packages cannot rely on that under `node_modules`, so ship JS. Prefer `erasableSyntaxOnly` so dev and build agree. (MEDIUM: confirm in the STACK research.)

---

## Seams and Test Doubles That Must Exist First (Wave 0 deliverables)

These are the interfaces whose later change would ripple through three or more modules. Freeze them, with their doubles and contract tests, before any Wave 1 module is implemented.

| # | Seam | Why it must be first | Double / harness |
|---|------|----------------------|------------------|
| 1 | **`FileFacts` + vocabulary + `Answer<T>`/`degraded` codes** (`facts/`) | Producer, carrier and consumer are built in parallel; spans are mandatory so the type must reject a missing span | `fileFacts()` builder; JSON-schema validation in tests |
| 2 | **CommandRunner**, including **streaming and batch** (`spawn` with stdin, long-lived `git cat-file --batch`) and a worker variant | Source Tree runs git through it. A run-to-completion-only API forces one process spawn per file. I verified locally that `git hash-object --stdin-paths` applies the same clean filters as `--path` (CRLF case produced the LF blob id), so one batched process can hash a whole snapshot. | Recording fake that can script stdout/stdin sequences; also the "hostile repo runs nothing" assertion |
| 3 | **Fact Store interface** (async everywhere) + conformance suite over both drivers | Largest module, most callers. Reads are async (`Promise<Answer<T>>`) even though `node:sqlite` is synchronous, so read-pool threads (A-concurrency design) can be added without changing callers | Real SQLite temp dir, `FakeClock`, fake `gitHas` |
| 4 | **Resolver port + `SymbolLookup`** | The store calls an injected resolver that reads symbols back through a read-only view; M1 plugs in Grammar Engine name-match, M2 adds precise | Stub resolver returning scripted edges |
| 5 | **Governor `run(job{tenant,class,cost}, fn)` and pool lease with eviction callback** | Indexer and Query call it from M1; the compiler pool needs lease + `onEvict` in M2 (see Q3). Changing the signature after M1 touches every caller | Fake clock; fake pool |
| 6 | **`record(event)` port** | Four to six modules call it; the flight recorder (M2) and dashboard (M4) subscribe. Calls are one-liners, so cheap now, widespread later | no-op adapter; assertion adapter |
| 7 | **`Request` / `Envelope` / protocol version / `HostClient.handle`** | Every adapter, the parity test (criterion 10), hooks and the M2.5 wire protocol depend on it | In-process `HostClient` |
| 8 | **PreciseResolver contract suite** | TS 6.x and 7.x are built a month apart; SCIP (whole-index import) and IndexStoreDB (helper process) differ in shape. One shared suite keeps `resolve(overlay, context, sites) -> AsyncIterable<ResolvedEdge>` honest | Scripted stub passes the suite first |
| 9 | **Test kit**: temp git repo builder (commits, worktrees, CRLF, LFS pointer, untracked, ignored), `FakeClock`, `ManualEventSource` | Source Tree has "no port"; its tests are real repos on all three OSes | n/a (these are the doubles) |

---

## Data Flow

### Write path (event to stored facts)

```
 fs event / git event / CLI build / Reconcile list
        │
        ▼
  Indexer.submit({worktree, path})          coalesce: map[(worktree,path)] = latest request
        │  Governor.run({tenant, class: indexing | fresh, cost})
        ▼
  Source Tree.hash(paths)  ── batched `git hash-object --stdin-paths` via CommandRunner
        │  unchanged vs overlay? stop.   (file_versions has hash+module+grammar_version? remap overlay only, skip parse)
        ▼
  read bytes ─▶ Grammar Engine.parse(module, bytes) in parser pool ─▶ FileFacts (spans, local symbols, ref sites, imports, relations, cites_adr, parse_errors)
        │  stat-before == stat-after ? else re-queue   (hash and parsed bytes must be the same snapshot)
        ▼
  FactStore.writer.commitFile({worktree, path, hash, facts | null})
        one transaction: upsert by hash, remap overlay, retire previous hash, assign identity (+renamed_from),
        invalidate affected resolved slice, advance watermark.   Group-committed.
        ▼
  Indexer resolves ensureFresh waiters whose paths are now <= indexedThrough;  record(freshness lag)
```

### Read path (adapter to envelope)

```
 adapter ─▶ HostClient.handle(request{protocol, tenant hint, worktree, kind, args, budget_tokens, fresh?})
   ─▶ Host: auth/route ─▶ Tenant
   ─▶ Query.ask
        ├─ if fresh: Indexer.ensureFresh(worktree, paths, waitMs)   timeout ⇒ degraded['fresh_timeout'], old watermark
        ├─ Reader = store.at(worktree)                              lock-free, read-only
        │     find/refs/callers/symbol/fileFacts ─▶ Answer<T>{data, watermark, degraded?}
        │     refs/callers: cache lookup (overlay snapshot, resolution context) ─▶ miss: resolver (grammar name-match, then precise) ─▶ fill
        ├─ rank, cut to budget_tokens, build citations + debug handles, fence untrusted_text, redact
        └─ record(answer metrics)
   ─▶ Envelope {schema, data, citations, watermark, degraded, truncated, more, hints}
```

### Maintenance path
Host idle loop (or `gsd-atlas maintain <task>`) -> Governor class `maintenance` -> `reconcile(truth)` where `truth = SourceTree.snapshot()` returns paths -> Indexer re-indexes them; `collect/compact/check` run time-boxed (200 ms slices) under the writer lease. `status()` surfaces results.

### Hook path (M4)
Hook adapter makes two calls per event: `Query.ask(one cheap request, fresh=[touched files], short timeout)`, then `Policy.decide(event, ledgerEntry, answer)`. Policy never calls Query. Gates open if the answer is `degraded` or stale. Everything fails open.

### Key data flows to protect

1. **FileFacts is the only thing crossing Grammar Engine to Fact Store.** No module reads the other's internals.
2. **Source Tree is the only source of git-derived data.** `gitHas` is the single narrow injected exception, and it is implemented by Source Tree's `hasObject`.
3. **Metrics is one-way.** Modules call `record`; nothing reads Metrics except `status`/`dashboard` and `bug`. Value statistics never enter Query, Policy or hook output.
4. **Resolved edges flow resolver to store cache, never directly to callers**, so `degraded` tiers are reported uniformly.

---

## Build Order by Milestone, With Rationale

### M0: Repo and seams (gate: `lang test` runs a fixture module end to end on 3 OSes; Fact Store and CommandRunner interface tests green)

| Step | Work | Parallel? | Rationale |
|------|------|-----------|-----------|
| 0.1 | Repo skeleton, copy Foundation with attribution, CI matrix (macOS/Linux/Windows), lint boundaries, ADR ratification (issue per ADR, rename, Accepted) | serial first | CI on 3 OSes is the constraint that cannot be retrofitted; no Windows hardware locally |
| 0.2 | `facts/` kernel + test kit (temp git builder, FakeClock, builders) | lane A | Unblocks everything in Wave 1 |
| 0.3 | CommandRunner (real + recording fake, streaming/batch, worker variant, built-in table, denial diagnostics) | lane B | Needed by Source Tree; security rule lives here |
| 0.4 | `sqlite/` kit + Fact Store interface + conformance suite skeleton over `node:sqlite` and `better-sqlite3` (open, pragmas, quick_check, schema-version refusal) | lane C | A3/A13 require both drivers green on all OSes early |
| 0.5 | Manifest JSON Schema, module registry and resolution order, **grammar build pipeline** | lane D | Longest-lead external work: pinned upstream tree-sitter to WASM on three OSes, parse-error budget harness |
| 0.6 | Governor and `record` interfaces + fake clock; Request/Envelope/HostClient types | lane A | Seam freeze |
| 0.7 | Grammar Engine minimal: load fixture grammar, run queries, normalize to `FileFacts`; `lang test` | after 0.2, 0.5 | The M0 gate |

### M1: Grammar tier, store, host (gate: gsd-core local facts on 3 OSes; criteria 2, 10, 12)

| Step | Work | Parallel? | Rationale |
|------|------|-----------|-----------|
| 1.0 | **Walking skeleton**: temp repo with 3 files, `build` then `find` through real Indexer, store, Query, CLI, in CI on 3 OSes | serial first | Joins all seams within the first weeks; mismatches surface while changes are cheap (Gall's Law) |
| 1.1 | Source Tree (batched snapshot hashing, source set, linguist attrs, LFS skip, `read(commit,path)`, identity, git events) | lane A | Real-repo tests on Windows (CRLF, path separators) are the risk |
| 1.2 | Fact Store real: local layer, overlays, identity, watermark, lifecycle, maintenance (reconcile/collect/compact/check), corruption move-aside, lazy schema rebuild, **resolved layer tables created now** | lane B | Biggest module; SIGKILL and 20,000-edit tests |
| 1.3 | Grammar Engine for TypeScript/`.cts` with self-built grammar; **plus a second, non-TS fixture language (Python) in its tests** | lane C | Prevents TS shape leaking into the engine; proves "no core change" before M5 |
| 1.4 | Governor real: priority classes, per-query limits, `Busy{retry_after}`, parser pool (fixed size) | lane D | Indexer and Query call it; WRR across tenants and memory budget deferred to M2.5 but signature is final |
| 1.5 | Indexer: queue, `EventSource` port (fs-watch adapter + manual), Reconcile consumer, `ensureFresh` | after 1.1-1.4 | Only writer client; read-your-writes hangs here |
| 1.6 | Query: envelope, `code_find/refs/context/impact`, `atlas_status`, `lang_list`; ranking, budget, cursor, fencing | after 1.2 (can start against builder-populated real stores) | Largest interface; golden envelope fixtures |
| 1.7 | Metrics SQLite adapter, event schema allow-list, real migrations, `status` panels | lane E, parallel with 1.6 | Non-derivable state needs forward migrations from day one (Gap 4) |
| 1.8 | Tenant (`createTenant(deps)`) + in-process Host + CLI adapter + MCP stdio adapter (embedded mode, leader/follower, see Q7) + **parity test** (same request through `handle`, CLI binary, MCP stdio returns identical JSON) + **two-tenant smoke test** | last | Criteria 2, 10, 12 |

### M2: TypeScript module = MVP (gate: gsd-core build < 30 s; criteria 1, 4, 7, 17; 50-question eval beats grep-only)

1. **Project model for TypeScript** (tsconfig chain via a small JSONC reader, `extends`, `include`, emit mapping, resolution-context inputs, source-set exclusion of `outDir`). Compiler-free so it works for the grammar tier and on Windows. First because the resolution context key, `emitted_as`, and the precise adapter all need it (Gap 1).
2. **Fact Store resolved layer and cache-fill path** (Q6), `resolver` injection wiring, `supersede-at-same-span` rule, `degraded` tiers.
3. **TS 6.x adapter** (classic LanguageService in a CommandRunner-managed worker, no network, ignore tsconfig `plugins`, `node_modules` only), incremental on save, pool lease from Governor (Q3).
4. **TS 7.x adapter** second, behind the same contract suite. It is a different mechanism (native service over IPC, unstable API), so it validates that the lease and eviction API work for both an in-process worker and an external process.
5. In parallel lanes: ADR citations (`cites_adr`, ambiguous ids point at all candidates as `INFERRED`), `explain` (needs `debug` handle format fixed in M1), skill, diagnostics (flight recorder, ratings, manual report, `bug`), free-alternatives evaluation, eval harness and the 50 questions.

### M2.5: Host hardening (gate: criteria 14, 16, 18, 20)
Build order: (a) lock election and supervisor, (b) versioned protocol + remote `HostClient` + thin `gsd-atlas-mcp` shim (embedded mode remains as fallback), (c) Unix socket/named pipe/loopback + token + Host/Origin checks (per-OS code), (d) Governor WRR across tenants, memory budget, compiler pool eviction, (e) per-tenant watchdog unload, (f) shared `sdk.db`/`pkg.db` infrastructure with ref-counting (content arrives M4), (g) diagnostics auto-submit and the repo intake workflow (independent GitHub Action lane). Because M1 already built Tenant/Host/HostClient, (b)-(e) are additions, not rewrites.

### M3: Swift module
Data module (grammar, own `refs.scm`, queries, `features.json`) plus Swift Project model (SwiftPM `Package.swift`, `project.pbxproj` build settings). Availability facts are `FileFacts` additions: confirm they fit local-fact tables (ADR "closed vocabulary") or trigger the ADR amendment before M3 starts.

### M4: Platform SDK facts and agent integration
Two independent lanes. **Lane SDK**: SdkStore on the `sqlite/` kit, Apple and Node providers (recording-fake runner tests; SDK pack fixtures cover Linux CI), packs export/import via backup API, Query kinds `platform_card/sdk_lookup/sdk_check/sdk_diff/syntax_check`. **Lane Policy**: `decide` + ledger (already built if scheduled as filler), hook adapter over HTTP hooks and thin forwarder, R0-R4, pre-commit check, `atlas-scout`. They join at R3 (needs `sdk_check` and `syntax_check`), dashboard gate panels, and `eval`.

### M5 and M6
M5: SCIP importer (whole-index import keyed by snapshot + context, streamed as edges for requested sites) and the IndexStoreDB helper (macOS binary run through CommandRunner; needs a distribution decision) are the third and fourth real adapters; Python module graduates from fixture to gsd-path validation; `bridge export` reads via the Reader. M6: performance pass and docs.

---

## Day-One Invariants (what keeps M2.5 and later additive)

1. **Async at every seam**: `Reader` methods, `parse`, `resolve`, `ensureFresh`, `handle`. Underneath may be synchronous. This is what lets read threads and parser pools appear later with no caller change.
2. **No module-level singletons.** All state is created in `createTenant(deps)` or the Host. Run a **two-tenant test in one process from M1**; it catches leaked caches and globals for pennies, and is the only guard on A22 until M2.5.
3. **Requests carry `protocol`, a tenant hint (cwd or MCP roots) and a worktree** from the first release; the in-process `HostClient` ignores most of it. The wire shape never changes at M2.5.
4. **Governor signature is final in M1** with `tenant` and `class` populated; M1 only has one tenant.
5. **Resolved-layer tables and `resolution_contexts` exist in schema v1.** Because schema change means lazy per-repo rebuild (A17), later table additions are cheap; do **not** write a migration framework for the Fact Store. (Metrics is the exception, see Gap 4.)
6. **Central `degraded` code union**; new codes are additive. Candidates now: `resolver_failed`, `resolver_timeout`, `fresh_timeout`, `precise_base_commit`, `precise_unavailable`, `stale`, `follower`, `cache_unavailable`.
7. **Every external process goes through CommandRunner, including git.** Source Tree has no private `execFile`.
8. **Repo-relative POSIX paths everywhere internally**; convert only at the OS boundary. Windows is in CI from M1.
9. **`debug` handle and provenance columns (`extractor`, `grammar_version`, `context_id`) exist in M1**, so `explain` in M2 is a Query kind and not a schema change.
10. **Grammar Engine has zero language special-casing**; the TypeScript behaviour comes from module data plus the Project model and precise adapter.

---

## Open Questions: Where They Bite First

| # | ADR open question | Bites first at | Recommended resolution | Decide by |
|---|-------------------|----------------|------------------------|-----------|
| Q1 | `warm(worktree)` / first-call resolver latency (fact-store-interface) | Interface in M0; real cost M2 (TS 6.0.3 cold is 5.4 s for gsd-core, against a < 2 s query goal) | **No public `warm`.** Reader's `refs/callers` take `timeoutMs` (Query passes about 1.5 s) and on expiry return grammar-tier `INFERRED` edges with `degraded['resolver_timeout']` while the computation continues and fills the cache. Cache warming is an internal maintenance-class task the lease holder runs after the Indexer settles. | M0 interface freeze (option and code); implement M2 |
| Q2 | Where the watcher lives (tenant-composition) | M1 step 1.5 | **Inside the Indexer** behind an `EventSource` port (fs-watch adapter, `ManualEventSource` for tests). Source Tree supplies *git* events (HEAD, refs, `worktrees/`, index) as a subscription, because only it knows git layout. Watch tracked directories only; fall back to Reconcile polling on watch exhaustion and say so in `status`. Leader process only (Q7). | M1 discuss-phase |
| Q3 | Governor LRU key (tenant, overlay) vs file set | **M2**, not M2.5: the TS adapter is the first pool user | Key = `(tenant, worktree, projectId)` where `projectId` is the tsconfig project, not the overlay: gsd-pi has 14 tsconfigs, and a program is per file set. Lease API: `acquire(key, estimatedBytes, onEvict)`. Eviction differs by adapter: TS 6.x worker is bounded with `Worker` `resourceLimits` and terminated on evict; TS 7.x native process is RSS-sampled and killed. Sharing between overlays is already handled by the resolved-edge cache (same snapshot + context). | M2 discuss-phase; lease signature in M0 |
| Q4 | Ledger eviction visibility (query-and-policy) | M4 only | Put an explicit `status: 'new' \| 'live' \| 'evicted'` on the ledger entry that `decide` receives. `decide` stays pure; an evicted entry counts as "gate open" (A34) and increments a Metrics counter. | Type reserved M0; decide M4 |
| Q5 | Per-call fresh slots (tenant-composition) | M1 (Query), matters at M2.5/M4 | **Waiting consumes no Governor slot.** `ensureFresh` promotes the named paths to class `fresh` in the Indexer queue; the resulting index jobs run under Governor class `fresh`, coalesced across callers; one deadline per request. | M1 discuss-phase |
| Q6 | *Not in the ADRs*: resolved-edge cache fill is a write triggered by a read, but the lease holder is the only writer | M2 (M1 if any cache is written) | Cache fill goes through a store-internal queue executed by the lease holder's writer connection. A reader in a process without the lease computes and returns uncached with `degraded['cache_unavailable']`. M1 avoids the issue by resolving name-matched edges with a read-time SQL join and no cache write. Needs an ADR clarification. | M1 end / M2 start |
| Q7 | *Not in the ADRs*: M1 ships **stdio-per-agent** MCP servers before the M2.5 daemon, but the store allows one writer and a repo's worktrees all share one store (common git dir) | **M1**, and it is the first thing a gsd-core developer with two sessions will hit | Leader/follower: the first process acquires the lease and runs watcher plus Indexer **for all worktrees of the repo** (`git worktree list`), not only its cwd. Others open read-only, serve with `degraded['follower']`, cannot honour `fresh` beyond what the leader has indexed, and retry the lease periodically for takeover when the leader exits. `build` and `maintain` CLI commands do the same. Cheaper than pulling a daemon forward; the same lease code is reused by M2.5 election. | M1 discuss-phase |
| Q8 | Dashboard: pre-commit hook records "open at commit" but git hooks run outside the Host | M4 | The hook appends one line to a tiny spool file; Metrics ingests it at next start. No SQLite opened from a git hook process. | M4 |
| Q9 | Dashboard: real token counts per tool result unavailable | M1 (first `record` of tokens) | Use `bytes/4`, labeled `estimated`; add the per-language error to the A50 corpus measurements. | M1 |

---

## Gaps in the Frozen Design (for ADR ratification in Phase 1, not redesign)

1. **Project model is code but "language modules are data".** A55 says module code exists only for the precise tier. Yet the TypeScript tsconfig chain, `rootDir/outDir` emit mapping and `include` file sets (PRD §5), the Swift SwiftPM/Xcode model (PRD §6), and the config-file set that defines the resolution context (A2) are all *code* that must run even when no compiler is available (grammar tier, Linux CI, Windows). Name this seam (`ProjectModel`, built-in, registered by id, referenced from the manifest like `precise.adapter`) in an amendment to draft-language-modules. Without it the logic will leak into either the Grammar Engine (violating data-only) or the precise adapter (breaking the fallback tier). **Confidence: MEDIUM-HIGH.**
2. **`warm`, cache-fill and the single-writer lease interact** (Q6). Clarify in draft-fact-store-interface that cache fills are performed by the lease holder.
3. **Pre-M2.5 multi-process behaviour** (Q7) is unspecified; add to the M1 scope statement.
4. **Metrics (and ratings) are the only non-derivable local state.** The Fact Store rule "schema change = lazy rebuild" does not apply; `metrics.db` needs ordinary forward migrations from its first release. SdkStore is derivable from the installed SDK but not from an imported pack, which is hash-pinned and re-imported, so treat packs as immutable inputs.
5. **"No other module reads or writes SQLite"** (fact-store-interface) conflicts literally with Metrics' own db and the shared `sdk.db`/`pkg.db`. Clarify: the rule is about fact tables; the `sqlite/` driver kit is internal infrastructure shared by exactly three store-owning modules.
6. **Files hashed vs files parsed can diverge** (the user saves between hash and read). Specify that `commitFile` is idempotent on (worktree, path, hash) and that the Indexer re-checks stat after parsing; a stale commit just becomes a retired version.
7. **Branch overlays without a checkout have no files on disk**, so only worktree overlays can run a compiler. State that precise resolution is worktree-only and branch overlays always use `precise_base_commit` edges mapped by symbol identity.

---

## Architectural Patterns

### Pattern 1: Composition root with a per-tenant factory
**What:** `createTenant(deps)` is the only place per-repo modules are wired; shared modules arrive as `deps`. Host holds a `Map<repoId, Tenant>`.
**When:** From M1, even with one tenant.
**Trade-offs:** A little ceremony in M1; M2.5 tenancy becomes registry + unload.
```typescript
interface SharedDeps { governor: Governor; grammar: GrammarEngine; runner: CommandRunner; sdk?: SdkProviders; clock: Clock }
function createTenant(repo: RepoRef, shared: SharedDeps): Tenant {
  const tree = createSourceTree(repo, shared.runner);
  const store = openStore(repo.storeDir, { resolver: composeResolver(shared.grammar, precise), clock: shared.clock, gitHas: tree.hasObject });
  const indexer = createIndexer({ tree, store, grammar: shared.grammar, governor: shared.governor });
  const query = createQuery({ store, indexer });
  return { tree, store, indexer, query, policy: createPolicy(), metrics: openMetrics(repo.storeDir) };
}
```

### Pattern 2: Contract suite per seam, run against every adapter
**What:** One test suite per seam (Fact Store x2 drivers, CommandRunner real/fake, PreciseResolver x4 adapters, Metrics sqlite/no-op), parameterized by adapter factory.
**When:** Wave 0 creates the suite with the first adapter; each later adapter must pass before merge.
**Trade-offs:** Up-front harness; prevents the "second adapter reveals the interface was wrong" rework.

### Pattern 3: Test through the interface with real infrastructure, doubles only for time, git-existence and processes
**What:** Real SQLite, real temp git repos, fake clock, fake `gitHas`, recording runner. The ADR rejects a fake Fact Store.
**Trade-offs:** Tests are slower than in-memory fakes (still milliseconds per case), but they survive refactors and exercise Windows file semantics.

### Pattern 4: Walking skeleton before depth
**What:** A thin end-to-end path (3-file repo, build, find) exists on all three OSes before lifecycle, maintenance, ranking or precise tiers get depth.
**Why:** Fourteen interlocking ADRs make seam mismatch the primary risk; a skeleton finds it in week one.

### Pattern 5: Read-time resolution first, cache when measured
**What:** Grammar-tier (`INFERRED`) resolution is a join over `ref_sites`, `local_symbols` and `overlay_files` at query time. Only precise edges (expensive) are cached by (snapshot, context).
**Trade-offs:** Defers the cache-fill and lease question (Q6) to the milestone that actually needs it.

---

## Anti-Patterns

### Anti-Pattern 1: "An MCP server with a database" in M1, Host retrofitted later
**What people do:** Tool handlers call the store directly because M1 is single-tenant.
**Why it's wrong:** CLI parity, hooks, the shim and tenancy all re-implement or rewire. The parity criterion becomes convention.
**Do this instead:** Every adapter calls `HostClient.handle` from the first commit; Query owns ranking, fencing and envelope.

### Anti-Pattern 2: Per-file process spawn for hashing or `git show`
**What people do:** `git hash-object --path <file>` for each of ~1,640 gsd-core files.
**Why it's wrong:** Process spawn dominates the sub-3 s and 30 s budgets, worst on Windows.
**Do this instead:** `git ls-files -s` for unmodified tracked files, `--stdin-paths` batch hashing for dirty and untracked, long-lived `cat-file --batch` for reads at commit; all behind CommandRunner's streaming API.

### Anti-Pattern 3: A fake FactStore or table-level tests
**Why it's wrong:** Drifts from real semantics (ADR rejects it) and pins the schema.
**Do this instead:** Real store at the interface with builders.

### Anti-Pattern 4: Migration framework for the Fact Store
**Why it's wrong:** The store is derived; A17 already specifies lazy rebuild while serving stale-marked facts.
**Do this instead:** Schema version number, refusal rules, rebuild. Spend migration effort only on `metrics.db`.

### Anti-Pattern 5: Letting TypeScript shape the core
**Why it's wrong:** TS is the only M1/M2 language, so `.cts`/tsconfig assumptions creep into Grammar Engine, vocabulary or Indexer, and M3/M5 (Swift, Python) pay for it.
**Do this instead:** Python fixture in Grammar Engine tests from M1; TS specifics only in module data, Project model and the adapter.

### Anti-Pattern 6: Eager precise resolution per overlay
**Why it's wrong:** 357 MB per gsd-core program; hundreds of worktrees. Violates A25.
**Do this instead:** Lazy, pool-bounded, `precise_base_commit` degradation reported in `degraded`.

### Anti-Pattern 7: Value statistics or Metrics inside the fact store or agent context
**Why it's wrong:** A store rebuild wipes them; the measured agent can game visible numbers.
**Do this instead:** Separate `metrics.db`; `record` is best-effort and never throws; no value figure in `atlas_status` or hook briefs.

### Anti-Pattern 8: Windows later
**Why it's wrong:** No local Windows hardware; path separators, CRLF clean filters, file locking, named pipes and `fs.watch` behaviour differ and cannot be debugged late.
**Do this instead:** Three-OS CI matrix in step 0.1, POSIX-normalized internal paths, a CRLF fixture in the temp-repo builder.

### Anti-Pattern 9: Early workspace split
**Why it's wrong:** Constraint says single package for MVP simplicity.
**Do this instead:** Keep module `index.ts` boundaries lint-enforced so a later split is a move, not a refactor.

---

## Scaling Considerations

| Scale | Architecture adjustments |
|-------|--------------------------|
| M1: one developer, 1-3 stdio sessions, one repo | Embedded host per MCP process; leader/follower on one lease; reads in-process; parser pool fixed size |
| M2.5: tens to hundreds of agents, several repos | One host per user and major version; read pool threads (reads already async); WRR across tenants; compiler pool LRU under 25% of RAM; shared sdk/pkg stores |
| Swarm of 1,000 short-lived agents, 500 worktrees | Same design: per-agent cost is a connection and a ledger entry; `Busy{retry_after}` instead of queueing; new worktrees overlay from `git ls-tree` blob ids |

### Scaling priorities

1. **First bottleneck: parsing, not storage** (304 TS files/s single thread; storage build 9.4 s for 1M LOC). Parser pool and content-hash dedupe; this is why Governor parser pool must exist in M1.
2. **Second: compiler memory** (357 MB per gsd-core program, 14 tsconfigs in gsd-pi). Lease-based pool with explicit eviction (Q3).
3. **Third: writer contention** under many worktrees dirtying files: coalescing queue plus group commit; reads unaffected (WAL).

---

## Integration Points

### External Services and Tools

| Service | Integration pattern | Notes |
|---------|---------------------|-------|
| git | CLI via CommandRunner only (batch/streaming) | Clean-filter parity with `--stdin-paths` verified; CRLF, LFS pointers, `linguist-*` attributes via `check-attr` batch |
| tree-sitter WASM | `web-tree-sitter` in parser-pool workers; grammars built from pinned upstream by `scripts/build-grammars` | Build once on Linux and commit hash-pinned artifacts if cross-OS toolchain is painful (MEDIUM; research in M0) |
| SQLite | `node:sqlite` primary, `better-sqlite3` fallback, behind `sqlite/` kit | Node 24+ without experimental warning; conformance on every supported Node minor |
| `typescript` package of the repo | In-process worker (6.x) or native service (7.x), via CommandRunner, never from bundled copy by default | `plugins` ignored; `node_modules` only |
| MCP SDK | Reuse gsd-graph's scaffold (copied); tool registration routes to `HostClient.handle` | Short instructions carry the routing table |
| `xcrun`, `swift symbolgraph-extract` (M4) | Built-in specs in the runner table | macOS only; SDK packs cover Linux CI |
| `gh` (M2) | CommandRunner built-in for `bug` and diagnostics submit | Off unless user opts in |
| gsd-graph | File format only (`bridge export`); no install-time dependency either way | A14 |
| Agent hosts (M4) | HTTP hooks to the daemon; thin command forwarder elsewhere | Fail open |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Adapter to Host | `HostClient.handle(request)` | In-process M1; socket/pipe/HTTP M2.5. Nothing else may be imported by adapters |
| Query to Indexer | `ensureFresh` only | Query never reads queue state |
| Indexer to Fact Store | Writer lease via `commitFile`, `setOverlay`, `dropOverlay`, `markStale` | Only writer client |
| Fact Store to resolver | Injected `resolver` reading via `SymbolLookup` | Resolver never gets the store |
| Policy to Query | None | Hook adapter orchestrates both |
| Any module to Metrics | `record(event)` | Best-effort; allow-listed schema (no paths, names, text) |
| Source Tree to Fact Store | Data only: `snapshot` map and `hasObject` as `gitHas` | No shared types except hashes |
| Precise adapter to Governor | Pool lease with `onEvict` | Adapter owns its program, Governor owns slot and budget |

---

## Research Flags for Phases

| Phase | Needs deeper research | Why |
|-------|----------------------|-----|
| M0 grammar build | Yes | Reproducible tree-sitter to WASM on three OSes (toolchain: emscripten, docker or wasi-sdk), license vetting of pinned upstream grammars |
| M1 Indexer | Yes | `fs.watch` recursive reliability on Linux and Windows, ignore handling, watch exhaustion; `node:sqlite` read-only connections across worker threads and `busy_timeout` behaviour |
| M1 Source Tree | Light | Batch hashing verified here; `check-attr` for `linguist-*`, worktree list and git-event detection on Windows |
| M2 TS adapters | Yes | LanguageService incremental update in a worker; TS 7.x `unstable/sync|async` API surface and IPC process model; resource accounting for both |
| M2 Project model | Yes | tsconfig `extends` chains, `references`, `include/exclude`, `.cts` emit mapping edge cases on gsd-core and gsd-pi |
| M2.5 | Yes | Cross-platform lock election, supervisor, named pipes on Windows, stdio shim reconnect semantics |
| M3 | Yes | tree-sitter-swift `refs.scm` quality (85% precision target), `project.pbxproj` parsing |
| M4 SDK | Standard (SDK-PROVIDERS.md exists) | `swift symbolgraph-extract` output volume and per-axis availability mapping; hook event differences per host |
| M4 Policy | Standard | Pure function; table-driven |
| M5 | Yes | SCIP protobuf import shape vs `resolve(sites)`; IndexStoreDB helper build and distribution |

---

## Sources

- `/Users/trekkie/projects/gsd-atlas/docs/DESIGN.md` (A1-A63, performance, lifecycle, concurrency, multi-repo): HIGH
- `/Users/trekkie/projects/gsd-atlas/docs/PRD.md` §4-§8, §11, §14 (module interfaces, milestones, criteria): HIGH
- `/Users/trekkie/projects/gsd-atlas/docs/adr/` draft-fact-store-interface, draft-tenant-composition, draft-host-process-model, draft-query-and-policy, draft-command-runner, draft-language-modules, draft-worktree-lifecycle, draft-mcp-contract, draft-value-dashboard, draft-fact-model: HIGH (primary design sources; all still "Proposed")
- `/Users/trekkie/projects/gsd-atlas/.planning/PROJECT.md`: constraints (single package, three OSes, solo builder): HIGH
- Local experiment (2026-10-15, git on this machine): `git hash-object --stdin-paths` applies the same clean filters as `--path` (CRLF input with `core.autocrlf=true` yields the LF blob id; `--no-filters` yields a different id): HIGH for this git version
- Not independently verified in this pass: TypeScript 7 `unstable/sync` process model, `fs.watch` recursive behaviour per OS, tree-sitter WASM build toolchain: MEDIUM, flagged for phase research

---
*Architecture research for: local code-intelligence server for coding agents (gsd-atlas)*
*Researched: 2026-10-15*
