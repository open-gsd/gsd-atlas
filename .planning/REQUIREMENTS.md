# Requirements: gsd-atlas

**Defined:** 2026-10-15
**Core Value:** Agents get correct, cited, current answers about the code and the platform they are building against, instead of guessing from stale training data or sweeping the repo with grep.

Source of truth for behaviour: `docs/PRD.md`, `docs/DESIGN.md`, `docs/adr/`. Research adjustments are in `.planning/research/SUMMARY.md`. "Beats grep" means fewer tokens consumed at non-inferior accuracy, not speed.

## v1 Requirements

Scope is the full PRD 1.0 (M0-M6), with M4 split into SDK facts, agent integration and dashboard/eval.

### Foundations (FND)

- [x] **FND-01**: CI builds and tests every PR on macOS, Linux and Windows
- [x] **FND-02**: Repo is one npm package `@opengsd/gsd-atlas` (Node >= 24.16, tsc emit) exposing bins `gsd-atlas` and `gsd-atlas-mcp`
- [x] **FND-03**: A language-module manifest is validated against a JSON Schema generated from Zod; an invalid module is skipped with a diagnostic
- [x] **FND-04**: Grammar WASM is built reproducibly from pinned upstream releases with a pinned tree-sitter CLI, on all three OSes
- [x] **FND-05**: Each module seam (Fact Store, Source Tree, CommandRunner, Grammar Engine, PreciseResolver, Governor) has a fixed interface and a test double or conformance suite
- [x] **FND-06**: Every child process starts through the CommandRunner, enforced by lint, with streaming and batch support (e.g. one batched `git hash-object --stdin-paths`)
- [x] **FND-07**: Module-boundary lint rules are enforced from day one (child_process only in the runner; `sqlite/` only for the Fact Store, Metrics and SDK stores; imports via `index.ts`; Policy imports only `facts/`; adapters import only `HostClient`)
- [x] **FND-08**: Each eval corpus is pinned to a commit SHA in a corpus manifest
- [x] **FND-09**: Each ADR is ratified (issue opened, file renamed to `<issue#>-<slug>.md`, Proposed to Accepted) before the first phase that depends on it
- [x] **FND-10**: Three of the five ADR gaps found in research (ProjectModel seam, read-triggered cache write, SQLite-access wording) are amended in the language-modules, fact-store-interface and sqlite-store ADRs as they are ratified in Phase 1; the other two are FND-12
- [x] **FND-11**: `gsd-atlas lang test` runs a fixture module end to end on all three OSes (walking skeleton)
- [x] **FND-12**: The other two ADR gaps found in research (writer contention and leader/follower, metrics migrations) are amended in the worktree-lifecycle and value-dashboard ADRs as they are ratified at the start of Phase 2

### Fact Store and Lifecycle (STO)

- [x] **STO-01**: Facts are stored in SQLite via `node:sqlite` with `better-sqlite3` working as fallback, behind one Fact Store interface and one conformance suite run over both drivers
- [ ] **STO-02**: Local facts are keyed by git blob id computed with git's clean filters, and spans line up on CRLF and BOM files
- [ ] **STO-03**: Each worktree or branch is an overlay; two worktrees of one repo share local facts and a branch switch re-parses only changed files
- [ ] **STO-04**: Resolved edges are keyed by overlay snapshot plus resolution context, so one file resolving to different targets on two branches gives each branch its correct target
- [x] **STO-05**: Retired file versions are collected when in git or past the grace period; after 20,000 edits the store is <= 1.25x a fresh build
- [ ] **STO-06**: A store corrupted or interrupted by SIGKILL during writes is detected and rebuilt automatically
- [x] **STO-07**: The store lives in the git common dir, falling back to the cache dir for non-git, read-only or synced paths, with `store.dir` override
- [x] **STO-08**: Two sessions on one repo do not collide on the writer lease; followers read and report `degraded: ['follower']`
- [ ] **STO-09**: `history --at <commit>` answers from git without writing to the store
- [ ] **STO-10**: Maintenance tasks (reconcile, resolve, refresh, collect, compact, check) run in idle time and as `maintain` CLI commands

### Language Modules and Grammar Engine (LNG)

- [x] **LNG-01**: A language module is a folder (manifest, grammar.wasm, queries, fixtures) resolved repo > user > npm > built-in, and `lang list` shows source and active tiers
- [ ] **LNG-02**: The Grammar Engine extracts definitions, containment and imports with per-construct recall >= 90% against ground truth
- [x] **LNG-03**: Name-matched references are recorded as `INFERRED`; definitions and imports as `EXTRACTED`
- [x] **LNG-04**: Every fact carries `source_path`, `span`, `extractor`, `content_hash`, `first_seen`, `last_seen` and `confidence`
- [ ] **LNG-05**: Only `git ls-files` plus untracked non-ignored files are indexed; `linguist-generated` and `linguist-vendored` are honoured; binaries and LFS pointers are skipped
- [x] **LNG-06**: Grammar parse quality is measured as bytes inside ERROR nodes per module, with a CI budget
- [x] **LNG-07**: Parser objects are released deterministically and workers are recycled so WASM memory does not grow unbounded
- [x] **LNG-08**: A second non-TypeScript fixture language runs through the Grammar Engine tests from M1

### Indexing and Freshness (IDX)

- [ ] **IDX-01**: A file save updates grammar-tier facts in < 1 s
- [x] **IDX-02**: Repeated change events coalesce into one index job per (worktree, path)
- [ ] **IDX-03**: Reconcile repairs missed file events, and any watcher overflow triggers a Reconcile
- [ ] **IDX-04**: A request with `fresh` paths indexes them first and answers with the updated facts

### Query, CLI and MCP (QRY)

- [ ] **QRY-01**: Every response carries `schema`, citations with debug handles, a watermark, a `degraded` flag and `untrusted_text`
- [ ] **QRY-02**: `code_find`, `code_refs`, `code_context` and `code_impact` return ranked, cited results with inline matched line text, `budget_tokens` (default 2,000), a `more` cursor and a server-side output ceiling
- [ ] **QRY-03**: `atlas_status` and `lang_list` report freshness, health, policy mode and active tiers
- [ ] **QRY-04**: The CLI and MCP tools return identical JSON for the same request; the CLI uses JSON on stdout, reasons on stderr and exit codes 0/1/2/3
- [ ] **QRY-05**: Repo- and package-derived text is fenced with a random nonce and every derived field is normalized; injection text in a doc comment returns fenced
- [ ] **QRY-06**: The default MCP tool profile is about 6 tools; the rest are opt-in or deferred
- [ ] **QRY-07**: `explain` reports why atlas said something (extractor, tier, grammar version, resolution context, overlay)

### Host and Transport (HST)

- [x] **HST-01**: `gsd-atlas-mcp` serves MCP over stdio, stateless, and survives a host restart between two tool calls
- [ ] **HST-02**: The Host composes a Tenant per repo from M1, with a two-tenant smoke test
- [x] **HST-03**: The Governor schedules by priority class (interactive > fresh > indexing > maintenance) and answers `busy` with `retry_after` under saturation
- [ ] **HST-04**: `gsd-atlas init` registers MCP and hooks at user scope for detected agent hosts, never in repo config

### Metrics (MET)

- [x] **MET-01**: A separate Metrics module with its own database file and real migrations records answers, tokens, freshness and index health locally, with no source text, paths, symbols or prompts
- [ ] **MET-02**: `gsd-atlas status` shows basic panels; a metrics write failure never blocks an answer

### TypeScript Module (TSM)

- [ ] **TSM-01**: The TypeScript 6.x adapter produces resolved edges (`calls`, `references`, `extends`, `implements`, `overrides`) over the project's tsconfig(s), with a bundled `typescript@6.0.3` fallback marked `degraded`
- [ ] **TSM-02**: The 7.x subpaths are feature-detected at runtime and the adapter degrades to 6.x when they are absent or change
- [ ] **TSM-03**: `rootDir`/`outDir`/extension rules produce `emitted_as` edges (`.cts` to `.cjs`), no gsd-core fact points under `outDir`, and `require`s of emitted paths resolve to `.cts` sources
- [ ] **TSM-04**: ADR ids in comments become `cites_adr` facts, resolved against the repo's ADR directory
- [ ] **TSM-05**: Precise resolution runs in a bounded, killable worker started through the CommandRunner; programs beyond the memory budget fall back to grammar facts flagged `degraded`
- [ ] **TSM-06**: A full gsd-core build completes in < 30 s and a one-file precise update in < 5 s; queries on a warm index take < 2 s
- [ ] **TSM-07**: A compiler-free ProjectModel seam supplies tsconfig chains, file sets and resolution-context inputs

### Evaluation (EVL)

- [ ] **EVL-01**: A free-alternatives evaluation (LSP-wrapping MCP servers, agent repo-maps, colbymchenry/codegraph, Claude Code LSP, Memtrace) records the gap each leaves, done before the M2 eval
- [ ] **EVL-02**: The eval design is pre-registered: >= 50 questions per corpus including abstain cases, >= 3 runs per configuration, an independent oracle, paired analysis pooled across corpora, accuracy non-inferiority margin, and tool-call rate logged
- [ ] **EVL-03**: On gsd-core, agents using atlas consume fewer tokens than the grep-only baseline at non-inferior accuracy, with verifiable file:line citations >= 80% of the time
- [ ] **EVL-04**: The pooled eval beats the grep-only baseline on tokens at non-inferior accuracy across gsd-core, gsd-pi, gsd-path and the Swift reference app (PRD M5 gate)

### Skill, Ratings and Diagnostics (SKL)

- [ ] **SKL-01**: The `gsd-atlas` Agent Skill routes agents to atlas tools; `gsd-atlas-module-author` guides writing language modules
- [ ] **SKL-02**: Users can rate a session, feature or last answer as up, meh or down
- [ ] **SKL-03**: Diagnostics are off by default, approved per data type, previewed before manual submission, and never include code, paths, names, prompts or environment
- [ ] **SKL-04**: `gsd-atlas bug` captures a flight recorder, versions, config, store health and the failing answer with hashed names/paths by default

### Host Hardening (HRD)

- [ ] **HRD-01**: One host per user and major version serves many repos as isolated tenants; a stuck tenant is unloaded without affecting others
- [ ] **HRD-02**: The protocol is versioned; two repos pinned to different majors run side by side and an older host refuses a newer store with a clear message
- [ ] **HRD-03**: The host listens on a Unix socket or named pipe where supported; every route needs a `0600`-file token, browser-style requests are rejected, and there is no fixed-port fallback that can leak the token
- [ ] **HRD-04**: A supervisor restarts the host on crash and per-tenant watchdogs report in `status`
- [ ] **HRD-05**: The full Governor applies weighted round-robin across tenants, a memory budget and parser/compiler pools; 1,000 concurrent short-lived agents run with zero errors and read p99 <= 100 ms
- [ ] **HRD-06**: Ten active repos fit in <= 200 MB before compilers, and a repo outside a declared workspace returns no facts to another repo's agents
- [ ] **HRD-07**: Public SDK and package facts are stored once per machine and shared across tenants
- [ ] **HRD-08**: Diagnostics auto-submit is a separate opt-in that never includes notes, and the repo intake workflow validates, redacts, deduplicates and routes reports

### Swift Module (SWF)

- [ ] **SWF-01**: A Swift module (pinned, patched grammar plus its own `refs.scm`) yields definitions, imports and name-matched references on Linux with no Xcode
- [ ] **SWF-02**: SwiftPM `Package.swift` and Xcode `project.pbxproj` build settings give targets and deployment targets on any OS
- [ ] **SWF-03**: `@available` and `#available` in user code become availability facts checked against the deployment target
- [ ] **SWF-04**: Grammar-tier resolved references are >= 85% precise on a chosen open-source Swift reference app, measured before Swift launches
- [ ] **SWF-05**: The Swift reference app is chosen and pinned to a commit

### Platform SDK Facts (SDK)

- [ ] **SDK-01**: The Apple provider detects installed SDKs and extracts symbols with availability per SDK id, keeping earlier versions side by side
- [ ] **SDK-02**: The Node provider reads versions and APIs from `engines`, `.nvmrc`, `@types/node` and the TypeScript `lib`
- [ ] **SDK-03**: `sdk export` and `sdk import` move an SDK pack from a Mac to Linux or CI with nothing downloaded
- [ ] **SDK-04**: `platform_card` and `sdk_lookup` name the installed SDK version, declaration, availability and project deployment target
- [ ] **SDK-05**: `sdk_check` flags 100% of symbols missing from the installed SDK and of uses above the deployment target without a guard on a 50-use fixture
- [ ] **SDK-06**: `sdk_diff` compares two SDK versions, defaulting to frameworks the project imports and summarising by framework
- [ ] **SDK-07**: `syntax_check` flags syntax newer than the project's language level
- [ ] **SDK-08**: With Xcode 27, `platform_card` reports iOS SDK 27.0 and the project's deployment target; CI uses the `xcode-27` runner where available, otherwise the gate is local

### Agent Integration (AGT)

- [ ] **AGT-01**: A pure Policy module decides hook behaviour from the session ledger, with block counters persisted and absent state treated as allow
- [ ] **AGT-02**: The `atlas-scout` read-only subagent explores via atlas tools for swarms
- [ ] **AGT-03**: Hooks R0-R4 run in advise and enforce modes, fail open, demand at most one cheap atlas call, cap Stop blocks at 3 and set explicit timeouts
- [ ] **AGT-04**: `gsd-atlas check --staged` works as a git pre-commit hook and CI step
- [ ] **AGT-05**: In enforce mode on the eval tasks, broken-caller edits, stale/invented API uses and syntax violations reaching a commit drop versus hooks off, with total tokens no higher; hook p99 <= 20 ms at 1,000 agents; no gate blocks when the host is down

### Value Dashboard (DSH)

- [ ] **DSH-01**: `gsd-atlas dashboard [--since 7d] [--html]` labels every figure `measured`, `estimated` or `A/B` with method, denominator and interval, and never adds values of different classes
- [ ] **DSH-02**: The HTML report is static and self-contained, contains no secret, path, symbol name or prompt, and no value statistic appears in MCP output, `atlas_status` or hook briefs
- [ ] **DSH-03**: `gsd-atlas eval` runs hooks off / advise / enforce and feeds the A/B panel

### Precise Imports, Bring-Your-Own and Bridge (INT)

- [ ] **INT-01**: Any SCIP index imports as a PreciseResolver adapter
- [ ] **INT-02**: A first-party Swift helper over IndexStoreDB provides compiler-precise references on macOS after a build
- [ ] **INT-03**: The Python example module passes its fixtures and indexes gsd-path with no change to atlas source (553 files stored as 230 distinct contents)
- [ ] **INT-04**: An authoring guide documents how to write a language module
- [ ] **INT-05**: `bridge export` writes code-to-decision links that gsd-graph ingests and answers "which code implements ADR-457?" with citations

### Security (SEC)

- [ ] **SEC-01**: A fixture repo with committed config enabling commands and a module with `precise.command` runs no command; permissions come only from user-level config
- [ ] **SEC-02**: Built-in first-party providers run by default and can be turned off; any other command needs per-repo, per-command user approval and never runs via MCP without `--allow-build`

### Release (REL)

- [ ] **REL-01**: Docs, an install and upgrade guide, and `gsd-atlas uninstall` exist
- [ ] **REL-02**: The benchmark suite meets every DESIGN.md performance budget at 1M LOC and on gsd-core, with count/relative checks as PR gates and wall-clock p99 nightly
- [ ] **REL-03**: The free-alternatives evaluation is re-checked before 1.0
- [ ] **REL-04**: Acceptance criteria 1-21 are green, with Mac-hardware criteria on `xcode-27` CI or documented local gates

## v2 Requirements

Deferred; tracked but not in the current roadmap.

### Post-1.0

- **OKF-01**: `gsd-atlas export --format okf` writes a module-level markdown bundle (gated on spec license and maturity check)
- **EMB-01**: Opt-in local embedding search with `sqlite-vec`
- **LNG2-01**: SDK/language-level providers for Python, Go, Java, Rust, C#, C/C++, then installed package facts
- **NET-01**: Network sharing after privacy review

## Out of Scope

| Feature | Reason |
|---------|--------|
| Data-flow, taint, type inference beyond compilers/indexers | Different engine, not needed for core value |
| LSP bridge | Candidate later tier |
| Fetching documentation from the web | Privacy; SDK facts come from disk |
| GUI | Static HTML dashboard is not a GUI |
| Telemetry | Only user-approved diagnostics leave the machine |
| Edit/rename tools, `execute_cypher`, graph analytics, agent memory stores | Anti-features per research; outside the product's one job |
| Writing into gsd-graph's store | Bridge export only |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete |
| FND-02 | Phase 1 | Complete |
| FND-03 | Phase 1 | Complete |
| FND-04 | Phase 1 | Complete |
| FND-05 | Phase 1 | Complete |
| FND-06 | Phase 1 | Complete |
| FND-07 | Phase 1 | Complete |
| FND-08 | Phase 1 | Complete |
| FND-09 | Phase 1 | Complete |
| FND-10 | Phase 1 | Complete |
| FND-11 | Phase 1 | Complete |
| FND-12 | Phase 2 | Complete |
| STO-01 | Phase 2 | Complete |
| STO-02 | Phase 2 | Pending |
| STO-03 | Phase 2 | Pending |
| STO-04 | Phase 2 | Pending |
| STO-05 | Phase 2 | Complete |
| STO-06 | Phase 2 | Pending |
| STO-07 | Phase 2 | Complete |
| STO-08 | Phase 2 | Complete |
| STO-09 | Phase 2 | Pending |
| STO-10 | Phase 2 | Pending |
| LNG-01 | Phase 1 | Complete |
| LNG-02 | Phase 2 | Pending |
| LNG-03 | Phase 2 | Complete |
| LNG-04 | Phase 2 | Complete |
| LNG-05 | Phase 2 | Pending |
| LNG-06 | Phase 1 | Complete |
| LNG-07 | Phase 2 | Complete |
| LNG-08 | Phase 2 | Complete |
| IDX-01 | Phase 2 | Pending |
| IDX-02 | Phase 2 | Complete |
| IDX-03 | Phase 2 | Pending |
| IDX-04 | Phase 2 | Pending |
| QRY-01 | Phase 2 | Pending |
| QRY-02 | Phase 2 | Pending |
| QRY-03 | Phase 2 | Pending |
| QRY-04 | Phase 2 | Pending |
| QRY-05 | Phase 2 | Pending |
| QRY-06 | Phase 2 | Pending |
| QRY-07 | Phase 3 | Pending |
| HST-01 | Phase 2 | Complete |
| HST-02 | Phase 2 | Pending |
| HST-03 | Phase 2 | Complete |
| HST-04 | Phase 2 | Pending |
| MET-01 | Phase 2 | Complete |
| MET-02 | Phase 2 | Pending |
| TSM-01 | Phase 3 | Pending |
| TSM-02 | Phase 3 | Pending |
| TSM-03 | Phase 3 | Pending |
| TSM-04 | Phase 3 | Pending |
| TSM-05 | Phase 3 | Pending |
| TSM-06 | Phase 3 | Pending |
| TSM-07 | Phase 3 | Pending |
| EVL-01 | Phase 3 | Pending |
| EVL-02 | Phase 3 | Pending |
| EVL-03 | Phase 3 | Pending |
| SKL-01 | Phase 3 | Pending |
| SKL-02 | Phase 3 | Pending |
| SKL-03 | Phase 3 | Pending |
| SKL-04 | Phase 3 | Pending |
| HRD-01 | Phase 4 | Pending |
| HRD-02 | Phase 4 | Pending |
| HRD-03 | Phase 4 | Pending |
| HRD-04 | Phase 4 | Pending |
| HRD-05 | Phase 4 | Pending |
| HRD-06 | Phase 4 | Pending |
| HRD-07 | Phase 4 | Pending |
| HRD-08 | Phase 4 | Pending |
| SWF-01 | Phase 5 | Pending |
| SWF-02 | Phase 5 | Pending |
| SWF-03 | Phase 5 | Pending |
| SWF-04 | Phase 5 | Pending |
| SWF-05 | Phase 5 | Pending |
| SDK-01 | Phase 6 | Pending |
| SDK-02 | Phase 6 | Pending |
| SDK-03 | Phase 6 | Pending |
| SDK-04 | Phase 6 | Pending |
| SDK-05 | Phase 6 | Pending |
| SDK-06 | Phase 6 | Pending |
| SDK-07 | Phase 6 | Pending |
| SDK-08 | Phase 6 | Pending |
| AGT-01 | Phase 7 | Pending |
| AGT-02 | Phase 7 | Pending |
| AGT-03 | Phase 7 | Pending |
| AGT-04 | Phase 7 | Pending |
| AGT-05 | Phase 8 | Pending |
| DSH-01 | Phase 8 | Pending |
| DSH-02 | Phase 8 | Pending |
| DSH-03 | Phase 8 | Pending |
| INT-01 | Phase 9 | Pending |
| INT-02 | Phase 9 | Pending |
| INT-03 | Phase 9 | Pending |
| INT-04 | Phase 9 | Pending |
| INT-05 | Phase 9 | Pending |
| SEC-01 | Phase 3 | Pending |
| SEC-02 | Phase 3 | Pending |
| REL-01 | Phase 9 | Pending |
| REL-02 | Phase 9 | Pending |
| REL-03 | Phase 9 | Pending |
| EVL-04 | Phase 9 | Pending |
| REL-04 | Phase 9 | Pending |

**Coverage:**
- v1 requirements: 102 total
- Mapped to phases: 102
- Unmapped: 0

---
*Requirements defined: 2026-10-15*
*Last updated: 2026-10-15 after phase 1 plan revision (FND-10 split: three amendments stay in Phase 1, two move to FND-12 in Phase 2)*
