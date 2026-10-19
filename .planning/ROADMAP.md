# Roadmap: gsd-atlas

## Overview

gsd-atlas goes from a docs-only repo to a 1.0 local code-and-SDK fact server in nine phases that follow PRD milestones M0-M6, with M4 split into SDK facts, agent integration and dashboard/eval, and M5 plus M6 folded into one closing phase. It starts with a walking skeleton on all three OSes (Phase 1), delivers a usable grammar-tier index behind a stateless stdio MCP server (Phase 2), reaches the MVP when TypeScript precision and the token-cost eval beat grep on gsd-core (Phase 3), hardens the Host (Phase 4), adds Swift (Phase 5), platform SDK facts (Phase 6), agent integration (Phase 7) and the value dashboard with the enforcement eval (Phase 8), and closes with precise imports, the bring-your-own-language proof, the gsd-graph bridge and the 1.0 release gate (Phase 9). "Beats grep" means fewer tokens consumed at non-inferior accuracy, not speed.

**Granularity note (standard, 5-8 guide):** nine phases. The full PRD 1.0 scope is 102 requirements across M0-M6, and the user fixed the M4 split. M6 alone would be a thin release phase (four requirements, internal-quality goals), so it is folded into M5 rather than standing alone. No other merge keeps phases user-verifiable without hiding the largest risk (Phase 2, 33 requirements, is already the heaviest).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundations and Walking Skeleton** - Seams frozen with test doubles, 3-OS CI, and `lang test` running a fixture module end to end (M0) (completed 2026-10-16)
- [x] **Phase 2: Grammar Tier, Store and stdio Host** - Cited, fresh, worktree-correct answers on gsd-core through the CLI and a stateless stdio MCP server (M1) (completed 2026-10-17)
- [ ] **Phase 3: TypeScript Module and MVP Eval** - Compiler-precise gsd-core answers, `explain`, skill and diagnostics, and a token-cost win over grep (M2, the MVP)
- [ ] **Phase 4: Host Hardening** - Multi-tenant, versioned, authenticated Host with supervisor, full Governor and diagnostics intake (M2.5)
- [ ] **Phase 5: Swift Module** - Swift definitions, references, deployment targets and availability on Linux with no Xcode (M3)
- [ ] **Phase 6: Platform SDK Facts** - Installed-SDK truth for Apple and Node: lookup, check, diff, syntax check, portable packs (M4a)
- [ ] **Phase 7: Agent Integration** - Policy module, hooks R0-R4, `atlas-scout` and the pre-commit check (M4b)
- [ ] **Phase 8: Value Dashboard and Enforcement Eval** - Honestly labelled value report and the hooks off/advise/enforce comparison (M4c)
- [ ] **Phase 9: Precise Imports, Bring-Your-Own Proof and 1.0** - SCIP and IndexStoreDB, Python module, gsd-graph bridge, docs, benchmarks, all criteria green (M5 + M6)

## Phase Details

### Phase 1: Foundations and Walking Skeleton

**Goal:** A developer can build and test the repo on macOS, Linux and Windows and run `gsd-atlas lang test` on a fixture language module end to end, with every module seam frozen behind an interface and a test double.
**Mode:** mvp
**Depends on:** Nothing (first phase)
**Requirements:** FND-01, FND-02, FND-03, FND-04, FND-05, FND-06, FND-07, FND-08, FND-09, FND-10, FND-11, LNG-01, LNG-06
**Success Criteria** (what must be TRUE):
  1. Every PR builds and tests on macOS, Linux and Windows in CI and produces the `@opengsd/gsd-atlas` package with the `gsd-atlas` and `gsd-atlas-mcp` bins; a deliberate boundary violation (child_process outside the CommandRunner, `sqlite/` imported by a non-store module, a deep import bypassing `index.ts`, Policy importing outside `facts/`, an adapter importing beyond `HostClient`) fails lint.
  2. `gsd-atlas lang test` runs a fixture module end to end on all three OSes (manifest validated, grammar loaded, queries run, spans produced), `gsd-atlas lang list` shows each module's source (repo, user, npm or built-in) and active tiers, and a module with an invalid manifest is skipped with a diagnostic instead of crashing.
  3. Grammar WASM is built from pinned upstream releases with a pinned tree-sitter CLI on all three OSes, a rebuild reproduces the pinned artifact hash, and per-module parse quality is reported as bytes inside ERROR nodes with a CI budget that fails when exceeded.
  4. Each seam (Fact Store, Source Tree, CommandRunner, Grammar Engine, PreciseResolver, Governor) has a fixed interface plus a test double or conformance suite that passes in CI, and a hostile-repo test shows no child process starts except through the CommandRunner, including one batched `git hash-object --stdin-paths` over a whole snapshot.
  5. The corpus manifest pins each eval corpus to a commit SHA, and every ADR this phase depends on is Accepted (issue opened, file renamed to `<issue#>-<slug>.md`) with its research-gap amendments applied, alongside a schedule naming the phase that must ratify each remaining ADR.

**Plans:** 20/20 plans complete

Plans:
**Wave 1**
- [x] 01-01-PLAN.md — Pre-flight gates (stray files, package legitimacy) and package scaffold with Node 24.16.0 floor (FND-02)
- [x] 01-02-PLAN.md — Ratify the eight Phase 1 ADRs: issues, renames, Accepted, link repair, schedule (FND-09)
- [x] 01-04-PLAN.md — Shared kernel (facts), HostClient interface and test kit (FND-05)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 01-03-PLAN.md — Boundary lint with one fixture test per rule, and the three-OS CI workflow (FND-01, FND-07)
- [x] 01-05-PLAN.md — Corpus manifest pinned to commit SHAs (FND-08)
- [x] 01-06-PLAN.md — Strict manifest schema, committed JSON Schema, Ajv parity (FND-03)
- [x] 01-07-PLAN.md — Reproducible grammar pipeline, grammar.lock, toy language module (FND-04)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 01-08-PLAN.md — ADR amendments (D-16, D-17) and Node floor record in planning artifacts (FND-10)
- [x] 01-09-PLAN.md — CommandRunner seam: spec, decide, real and recording adapters, contract (FND-05, FND-06)
- [x] 01-10-PLAN.md — SQLite driver layer with conformance on both drivers, frozen Fact Store interface (FND-05)
- [x] 01-11-PLAN.md — Governor and PreciseResolver seams with doubles and contracts (FND-05)
- [x] 01-12-PLAN.md — Grammar Engine seam, ERROR-byte measurement and parse-budget script (FND-05, LNG-06)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 01-13-PLAN.md — Git hardening, Source Tree seam and the hostile-repo test (FND-05, FND-06)
- [x] 01-14-PLAN.md — lang test through the CLI, HostClient and goldens with UTF-16, CRLF and BOM cases (FND-11, FND-03)
- [x] 01-15-PLAN.md — First three-OS CI run and WASM hash-parity gate (FND-01, FND-04)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 01-17-PLAN.md — Module registry with four-location precedence, lang list, invalid-module skipping, inert precise commands (LNG-01, FND-03)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 01-16-PLAN.md — Package tarball smoke, README quickstart, final three-OS CI evidence (FND-01, FND-02, FND-04, FND-11)

**Gap closure** *(from 01-VERIFICATION.md; run with `--gaps-only`)*
- [x] 01-18-PLAN.md — Gap closure CR-01: pin lazy-fetch and transport off in every git spec, decide requires the safety overrides and env, promisor hostile-repo case (FND-05, FND-06)
- [x] 01-19-PLAN.md — Gap closure CR-02: neutralise every filter driver name through the GIT_CONFIG_* env channel, strict decide validation, fail-closed enumeration probe (FND-05, FND-06)
- [x] 01-20-PLAN.md — Gap closure CR-01 (new) and WR-01: a non-UTF-8 filter driver name fails the snapshot closed, one shared name rule for builder and gate, Buffer-based hostile fixtures, three-OS CI run (FND-05, FND-06)

### Phase 2: Grammar Tier, Store and stdio Host

**Goal:** A developer can build a local fact index of gsd-core on macOS, Linux or Windows and ask cited, fresh, worktree-correct questions (find, refs, context, impact) through the CLI or a stateless stdio MCP server.
**Mode:** mvp
**Depends on:** Phase 1
**Requirements:** FND-12, STO-01, STO-02, STO-03, STO-04, STO-05, STO-06, STO-07, STO-08, STO-09, STO-10, LNG-02, LNG-03, LNG-04, LNG-05, LNG-07, LNG-08, IDX-01, IDX-02, IDX-03, IDX-04, QRY-01, QRY-02, QRY-03, QRY-04, QRY-05, QRY-06, HST-01, HST-02, HST-03, HST-04, MET-01, MET-02
**Success Criteria** (what must be TRUE):
  1. On gsd-core pinned at its corpus SHA, `gsd-atlas build` on all three OSes indexes only tracked plus untracked non-ignored source (generated, vendored, binary and LFS-pointer files skipped); every fact carries file, span, extractor, content hash, first/last seen and confidence (definitions and imports EXTRACTED, name-matched references INFERRED); per-construct recall is at least 90% against ground truth; spans line up on CRLF and BOM files; the Fact Store conformance suite passes on both `node:sqlite` and `better-sqlite3`; and a second, non-TypeScript fixture language passes the same Grammar Engine tests with parser memory staying bounded over a long run.
  2. After a file save, `find` returns the updated facts in under 1 s; bursts of change events coalesce into one job per (worktree, path); a deliberately missed file event, and any watcher overflow, is repaired by Reconcile; and a request with `fresh` paths indexes them first and answers with the updated facts.
  3. Two worktrees of one repo share local facts, a branch switch re-parses only the changed files, a fixture file that resolves to different targets on two branches gives each branch its own correct target, and `history --at <commit>` answers from git without writing to the store.
  4. The store survives abuse and tends itself: a SIGKILL during writes is detected and the store rebuilt automatically; after 20,000 edits it is at most 1.25x a fresh build; reconcile, resolve, refresh, collect, compact and check run in idle time and as `maintain` commands; the store lives in the git common dir with a cache-dir fallback and `store.dir` override; and a second session on the same repo does not collide on the writer lease, reading as `degraded: ['follower']`.
  5. Agents and developers get one answer surface: `code_find`, `code_refs`, `code_context` and `code_impact` return ranked, cited results (inline matched line text, `budget_tokens`, `more` cursor, server-side output ceiling) in the full envelope; the CLI and MCP return identical JSON for the same request; injection text in a doc comment returns fenced in `untrusted_text`; `atlas_status` and `lang_list` report freshness, health, policy mode and tiers; the default MCP profile is about 6 tools; the stateless stdio server survives a restart between two tool calls; a two-tenant smoke test passes; `busy` with `retry_after` appears under saturation; `gsd-atlas init` registers MCP at user scope only; and `gsd-atlas status` shows metrics panels with no source text, paths, symbols or prompts, a metrics write failure never blocking an answer.
  6. The four ADRs scheduled for this phase (worktree-lifecycle, query-and-policy, mcp-contract, value-dashboard) are ratified, and the two Phase 1 research-gap amendments D-16 assigned here are applied as dated sections: writer contention and leader/follower in worktree-lifecycle, and metrics migrations in value-dashboard (FND-12).

**Plans:** 46/46 plans complete

Plans:
- [x] 02-46-PLAN.md
- [x] 02-45-PLAN.md
- [x] 02-44-PLAN.md
- [x] 02-29-PLAN.md
- [x] 02-30-PLAN.md
- [x] 02-31-PLAN.md
- [x] 02-32-PLAN.md
- [x] 02-33-PLAN.md
- [x] 02-34-PLAN.md
- [x] 02-35-PLAN.md
- [x] 02-36-PLAN.md
- [x] 02-37-PLAN.md
- [x] 02-38-PLAN.md
- [x] 02-39-PLAN.md
- [x] 02-40-PLAN.md
- [x] 02-41-PLAN.md
- [x] 02-42-PLAN.md
- [x] 02-43-PLAN.md

**Wave 1**
- [x] 02-01-PLAN.md — Ratify the four ADRs and apply every Phase 2 dated amendment (FND-12)
- [x] 02-02-PLAN.md — Additive shared-kernel extensions: exports, reference kinds, new degraded codes, full envelope, cancellable clock timer (LNG-04, QRY-01)
- [x] 02-03-PLAN.md — Guarded doors: two git read shapes, three SQLite pragmas with probe, lint boundaries for the four new modules (STO-01, STO-03, STO-09, HST-01)
- [x] 02-04-PLAN.md — Human gates: approve the proposed constants and the too-new MCP SDK package (IDX-01, IDX-02, HST-01, HST-03, STO-05, STO-08)
- [x] 02-08-PLAN.md — Grammar pipeline for shipped parsers and the TypeScript and JavaScript modules as pinned data (LNG-02)
- [x] 02-21-PLAN.md — `gsd-atlas init`: user-scope MCP registration for detected agent hosts (HST-04)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 02-05-PLAN.md — Source Tree: batched hashing, source-set filters, worktree discovery, confined reads (LNG-05, STO-02, STO-03)
- [x] 02-06-PLAN.md — Fact Store core: schema, writer, reader and contract suite on both SQLite drivers (STO-01, STO-02, STO-03, LNG-04)
- [x] 02-07-PLAN.md — Extractor: captures to FileFacts, match grouping, capture-name vocabulary, toy goldens (LNG-03, LNG-04, LNG-08)
- [x] 02-09-PLAN.md — Real Governor: priority classes, bounded queues, busy with retry_after, file-set leases (HST-03)
- [x] 02-10-PLAN.md — Metrics module: own database, forward-only migrations, allow-listed events, rollups, report (MET-01, MET-02)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 02-11-PLAN.md — Fact Store resolution: scoped references, callers and importers, fuzzy search, resolved-edge cache (STO-03, STO-04, LNG-03)
- [x] 02-12-PLAN.md — Store lifecycle: location, writer lease and followers, crash recovery, schema-version refusal (STO-06, STO-07, STO-08)
- [x] 02-13-PLAN.md — Real TypeScript and JavaScript queries with the 90 percent per-construct recall harness (LNG-02)
- [x] 02-14-PLAN.md — Bounded, recycled parser worker pool behind the GrammarEngine interface (LNG-07)
- [x] 02-15-PLAN.md — Indexer core: batching, extraction, commits, builds, coalescing queue, ensureFresh (IDX-02, IDX-04, STO-02, LNG-05)
- [x] 02-16-PLAN.md — Query core and `code_find`: tools, envelope, ranking, budget, cursor, nonce-fenced text (QRY-01, QRY-02, QRY-05)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 02-17-PLAN.md — Reconcile, native watcher, git-directory watch, branch-switch behaviour (IDX-01, IDX-03, STO-03, STO-04)
- [x] 02-18-PLAN.md — Collect, compact, check and maintain, refresh, and the 20,000-edit size gate (STO-05, STO-10)
- [x] 02-19-PLAN.md — `code_refs`, `code_context`, `code_impact` (INFERRED-expanding) and `atlas_status` (QRY-02, QRY-03)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 02-20-PLAN.md — Tenant, Host and HostClient wrapper: routing, Governor classes and busy, follower basics, maintain tasks, user config, composition root (HST-02, HST-03, STO-08, IDX-04, STO-10)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 02-22-PLAN.md — CLI adapter: tool commands, build, maintain, status, health, exit codes (QRY-04, MET-02, STO-10, HST-04)
- [x] 02-23-PLAN.md — Stateless stdio MCP server with the six shared tools and clean stdout (QRY-06, HST-01, QRY-04)
- [x] 02-28-PLAN.md — Host runtime behaviours: answer recording, start-up Reconcile deadline, follower takeover, idle maintenance (MET-02, STO-08, STO-10)

**Wave 7** *(blocked on Wave 6 completion)*
- [x] 02-24-PLAN.md — `history --at <commit>` from git objects with a throwaway store (STO-09)
- [x] 02-25-PLAN.md — Product end-to-end: CLI and MCP parity, injection fencing, leader and follower sessions, freshness, worktrees (QRY-04, QRY-05, HST-01, HST-02, IDX-01, STO-08)
- [x] 02-27-PLAN.md — Follower per-request in-memory overlay of `fresh` paths (STO-08, IDX-04)

**Wave 8** *(blocked on Wave 7 completion)*
- [x] 02-26-PLAN.md — Measured corpus gates, freshness gate and a green three-OS CI run (LNG-02, LNG-05, STO-05, STO-06, IDX-01)

### Phase 3: TypeScript Module and MVP Eval

**Goal:** A developer working on gsd-core gets compiler-precise, cited answers (callers, implementers, `.cts` to `.cjs` emit mapping, ADR citations) with `explain`, and agents using atlas consume fewer tokens than a grep-only baseline at non-inferior accuracy.
**Mode:** mvp
**Depends on:** Phase 2
**Requirements:** TSM-01, TSM-02, TSM-03, TSM-04, TSM-05, TSM-06, TSM-07, QRY-07, EVL-01, EVL-02, EVL-03, SKL-01, SKL-02, SKL-03, SKL-04, SEC-01, SEC-02
**Success Criteria** (what must be TRUE):
  1. On gsd-core, `code_refs` and `code_impact` return resolved `calls`, `references`, `extends`, `implements` and `overrides` edges across its tsconfig(s) through a compiler-free ProjectModel; no fact points under `outDir`, `require`s of emitted paths resolve to `.cts` sources, and ADR ids in comments appear as `cites_adr` facts resolved against the repo's ADR directory.
  2. Precise resolution is bounded, fast and honest: a full gsd-core build completes in under 30 s on a laptop and under 60 s at the strict CI ceiling (raised from 30 s on 2026-10-18 after hosted-Linux measurements; see 03-30-SUMMARY.md), a one-file precise update in under 5 s and warm queries in under 2 s; a program beyond the memory budget, a missing or changed 7.x subpath, or a missing project compiler falls back to grammar facts or the bundled `typescript@6.0.3`, always flagged `degraded`; and the resolver runs in a killable worker started through the CommandRunner.
  3. `explain` reports why atlas said something (extractor, tier, grammar version, resolution context, overlay); a fixture repo with committed config enabling commands and a module with `precise.command` runs no command; built-in first-party providers run by default and can be turned off, and any other command needs per-repo, per-command approval from user-level config and never runs via MCP without `--allow-build`.
  4. The `gsd-atlas` skill routes agents to atlas tools and `gsd-atlas-module-author` guides module writing; a user can rate a session, feature or last answer up, meh or down; diagnostics are off by default, approved per data type and previewed before manual submission; and `gsd-atlas bug` captures a flight recorder, versions, config, store health and the failing answer with hashed names and paths by default.
  5. The free-alternatives evaluation (LSP-wrapping MCP servers, agent repo-maps, colbymchenry/codegraph, Claude Code LSP, Memtrace) is recorded before the eval, the eval design is pre-registered (at least 50 questions per corpus including abstain cases, at least 3 runs per configuration, independent oracle, paired pooled analysis, accuracy non-inferiority margin, tool-call rate logged), and on gsd-core agents using atlas consume fewer tokens than the grep-only baseline at non-inferior accuracy with verifiable file:line citations at least 80% of the time.

**Plans:** 37/38 plans executed

Plans:
**Wave 1**
- [x] 03-01-PLAN.md — Decision register (nine assumptions, stop-gates for the D-21 sampler deviation and the EVL-03 citation criterion), research Open Questions marked RESOLVED, and ratification of the diagnostics ADR (SKL-03)
- [x] 03-02-PLAN.md — Approve Phase 3 constants and the three package installs (TSM-05, TSM-06, TSM-07, EVL-02)
- [x] 03-03-PLAN.md — Headless `claude -p` session runner with isolation, bounds and usage accounting (EVL-02, EVL-03)
- [x] 03-04-PLAN.md — Independent compiler-derived oracle and question schema (EVL-02)

**Wave 2** *(blocked on Wave 1 completion)*
- [x] 03-05-PLAN.md — Paired cluster bootstrap, analysis and the pre-registration verifier; starts only once the EVL-03 citation criterion is confirmed (EVL-02, EVL-03)
- [x] 03-06-PLAN.md — Free-alternatives evaluation with live runs (EVL-01)
- [x] 03-07-PLAN.md — Answer schema, scorer with citation verification, corpus preparation (EVL-02, EVL-03)
- [x] 03-08-PLAN.md — Dated ADR amendments for the Phase 3 seams (TSM-01, TSM-03, TSM-04, TSM-05, TSM-07, QRY-07, SKL-02, SEC-02)
- [x] 03-11-PLAN.md — v0 routing skill and packaging (SKL-01)

**Wave 3** *(blocked on Wave 2 completion)*
- [x] 03-09-PLAN.md — Seeded question census, 50 scored and 5 pilot questions with oracle keys (EVL-02)
- [x] 03-10-PLAN.md — Eval harness: arms, isolation, balanced schedule, failure rules (EVL-02, EVL-03)
- [x] 03-12-PLAN.md — Kernel additions (degraded codes, answer id) and diagnostics module boundary (SEC-02, SKL-02)
- [x] 03-13-PLAN.md — Exact-argv approvals by command hash and the SEC-01 hostile-repository test (SEC-01, SEC-02)

**Wave 4** *(blocked on Wave 3 completion)*
- [x] 03-14-PLAN.md — Ten-session pilot, cost and power projection, choice of N (EVL-02, EVL-03)
- [x] 03-15-PLAN.md — `gsd-atlas allow`, MCP origin without permissions, `--allow-build`, providers switch (SEC-02, SEC-01)

**Wave 5** *(blocked on Wave 4 completion)*
- [x] 03-16-PLAN.md — Question approval and pre-registration freeze, Stage A; refuses to freeze without the user's explicit EVL-03 citation-criterion confirmation (EVL-02)
- [x] 03-17-PLAN.md — Answer ids, flight recorder and `gsd-atlas rate` (SKL-02)

**Wave 6** *(blocked on Wave 5 completion)*
- [x] 03-18-PLAN.md — Compiler-free ProjectModel, owners, context and TypeScript 7.x detection (TSM-07, TSM-02)
- [x] 03-19-PLAN.md — CommandRunner exact-shape built-in for the compiler worker; runs only if the D-21 sampler deviation was approved (TSM-05)
- [x] 03-20-PLAN.md — Resolver seam: scope, symbol lookup with spans, per-overlay context, negative marker (TSM-01)
- [x] 03-21-PLAN.md — Diagnostics: catalog, per-type consent, preview, local save (SKL-03)

**Wave 7** *(blocked on Wave 6 completion)*
- [x] 03-22-PLAN.md — Emit mapping end to end: `.cjs` requirers linked to `.cts`, outputs get no facts (TSM-03)

**Wave 8** *(blocked on Wave 7 completion)*
- [x] 03-23-PLAN.md — Tracer: precise `code_refs` on gsd-core through the compiler worker and the real MCP server (TSM-01, TSM-02, TSM-05, SEC-02)
- [x] 03-24-PLAN.md — ADR citations extracted from comments and stored (TSM-04)

**Wave 9** *(blocked on Wave 8 completion)*
- [x] 03-25-PLAN.md — `extends`, `implements` and `overrides` relations through `code_refs`, `code_impact`, `code_context` (TSM-01)

**Wave 10** *(blocked on Wave 9 completion)*
- [x] 03-26-PLAN.md — `explain` and the seventh tool `code_explain` (QRY-07)
- [x] 03-27-PLAN.md — Memory budget, RSS sampler, LRU worker pool, gsd-pi no-break; runs only if the D-21 sampler deviation was approved (TSM-05)

**Wave 11** *(blocked on Wave 10 completion)*
- [x] 03-29-PLAN.md — Eager resolve in build, incremental update, warm start, gated `precise.command` (TSM-06, SEC-02, SEC-01)

**Wave 12** *(blocked on Wave 11 completion)*
- [x] 03-28-PLAN.md — ADR directory resolution, manifest version 2, `kind: adr` surfaces (TSM-04)
- [x] 03-30-PLAN.md — Two-tier TSM-06 gates on three operating systems (TSM-06)
- [x] 03-31-PLAN.md — Seeded edge-precision sample at least 98 percent on gsd-core (TSM-01, TSM-04)

**Wave 13** *(blocked on Wave 12 completion)*
- [x] 03-32-PLAN.md — `gsd-atlas bug` local bundle, hashed by default (SKL-04)
- [x] 03-33-PLAN.md — Final skills and the Stage B freezer; the smoke run and the Stage B freeze moved to 03-38 after the user reopened Stage A (SKL-01)

**Wave 14** *(blocked on Wave 13 completion)*
- [x] 03-38-PLAN.md — Reopen Stage A so the scored atlas arm carries the Skill tool (the skill becomes visible to the model): live visibility probes and an unscored smoke run, the atlas-commit check in the scored gate, Revision 1 of the pre-registration with the user's re-approval, the Stage A re-freeze and the Stage B freeze (EVL-02, EVL-03, SKL-01)

**Wave 15** *(blocked on Wave 14 completion)*
- [x] 03-34-PLAN.md — User documentation for the shipped surface written with the Diataxis skill: references, explain and ADR guides, approval and skills guides, tutorial, and a documentation consistency test (QRY-07, SKL-01, SKL-02, SKL-03, SKL-04, SEC-02, TSM-01, TSM-03, TSM-04)
- [x] 03-35-PLAN.md — Scored eval run (atlas tools plus the visible skill against the grep-only baseline) and the registered analysis, the MVP gate (EVL-03, EVL-02)

**Wave 16** *(blocked on Wave 15 completion)*
- [x] 03-36-PLAN.md — Alpha-readiness documentation pass with the Diataxis skill: README front door, alpha limitations with the evaluation status from the registered analysis, feedback and privacy pages, final audit (SKL-02, SKL-03, SKL-04, EVL-03, TSM-02)

**Wave 17** *(blocked on Wave 16 completion)*
- [ ] 03-37-PLAN.md — Number and ratify every remaining draft ADR at the MVP gate: one issue per draft, rename through one pull request, merge, close the issues, then the documents and tests state the final truth (SKL-03)

### Phase 4: Host Hardening

**Goal:** One long-lived Host per user serves many repos as isolated, authenticated tenants that survive crashes, version skew and a 1,000-agent swarm, and diagnostics reports flow into a validating intake workflow.
**Mode:** mvp
**Depends on:** Phase 3
**Requirements:** HRD-01, HRD-02, HRD-03, HRD-04, HRD-05, HRD-06, HRD-07, HRD-08
**Success Criteria** (what must be TRUE):
  1. One host per user and major version serves many repos as isolated tenants: a stuck tenant is unloaded without affecting the others, ten active repos fit in 200 MB or less before compilers, a repo outside a declared workspace returns no facts to another repo's agents, and a public SDK or package fact pack loaded once is stored once and visible to two tenants.
  2. The protocol is versioned: two repos pinned to different majors run side by side, and an older host refuses a newer store with a clear message.
  3. The host listens on a Unix socket or named pipe where supported, every route needs a `0600`-file token, a browser-style request is rejected, and no fixed-port fallback exists that could leak the token.
  4. A supervisor restarts the host after a crash and per-tenant watchdogs report in `status`; with weighted round-robin across tenants, a memory budget and parser/compiler pools, 1,000 concurrent short-lived agents run with zero errors and read p99 of 100 ms or less.
  5. Diagnostics auto-submit is a separate opt-in that never includes notes, and the repo intake workflow validates, redacts, deduplicates and routes incoming reports.
  6. The CLI hands `build` and `maintain` to the process that holds a repository's writer instead of answering `lease_held`: with an agent's MCP server running, `gsd-atlas build` in an unbuilt worktree of an indexed repository, or a rebuild of a built one, succeeds (carried over from Phase 2 review WR-02, where the message only names the holder).
  7. A store keeps one identity when its repository's root commits change: the store id is persisted with the store and no longer recomputed from the roots reachable from HEAD (carried over from Phase 2 review WR-06; Phase 2 derives it from the smallest root, which still changes when the set of roots changes).
  8. A child process started for a user-allowed executable receives an allowlisted environment (the variables the platform and the provider declare), not the inherited environment minus a denylist (carried over from Phase 2 review IN-05; Phase 2 only widens the denylist).

**Plans:** TBD

### Phase 5: Swift Module

**Goal:** A Swift app repo yields definitions, references, deployment targets and availability facts on Linux with no Xcode and no build.
**Mode:** mvp
**Depends on:** Phase 3
**Requirements:** SWF-01, SWF-02, SWF-03, SWF-04, SWF-05
**Success Criteria** (what must be TRUE):
  1. An open-source Swift reference app is chosen and pinned to a commit, and on Linux with no Xcode the Swift module (pinned, patched grammar plus its own `refs.scm`) yields its definitions, imports and name-matched references, with the grammar inside its measured parse-error budget.
  2. SwiftPM `Package.swift` and Xcode `project.pbxproj` build settings give targets and deployment targets on any OS.
  3. `@available` and `#available` in user code become availability facts checked against the deployment target.
  4. Grammar-tier resolved references are at least 85% precise on the reference app, measured before Swift launches.

**Plans:** TBD

### Phase 6: Platform SDK Facts

**Goal:** An agent building for an Apple or Node target is told the installed SDK version, the real declaration and availability of an API, and which uses are missing or too new for the deployment target, even on a Linux CI machine with no SDK installed.
**Mode:** mvp
**Depends on:** Phase 4, Phase 5
**Requirements:** SDK-01, SDK-02, SDK-03, SDK-04, SDK-05, SDK-06, SDK-07, SDK-08
**Success Criteria** (what must be TRUE):
  1. The Apple provider detects installed SDKs and extracts symbols with availability per SDK id, keeping earlier versions side by side, and the Node provider reads versions and APIs from `engines`, `.nvmrc`, `@types/node` and the TypeScript `lib`.
  2. `sdk export` on a Mac and `sdk import` on Linux or CI move an SDK pack with nothing downloaded, and lookups against the imported pack answer with networking disabled.
  3. `platform_card` and `sdk_lookup` name the installed SDK version, declaration, availability and project deployment target; with Xcode 27 `platform_card` reports iOS SDK 27.0 and the project's deployment target (on the `xcode-27` CI runner where available, otherwise as a documented local gate).
  4. `sdk_check` flags 100% of symbols missing from the installed SDK and of uses above the deployment target without a guard on the 50-use fixture, and `syntax_check` flags syntax newer than the project's language level.
  5. `sdk_diff` compares two SDK versions, defaulting to frameworks the project imports and summarising by framework, and stays under the server-side output ceiling.

**Plans:** TBD

### Phase 7: Agent Integration

**Goal:** Agents are routed to atlas and gently enforced: hooks advise or block with loop-proof limits and never wedge a session, a read-only scout subagent explores for swarms, and a pre-commit check catches stale APIs and broken callers before they reach a commit.
**Mode:** mvp
**Depends on:** Phase 6
**Requirements:** AGT-01, AGT-02, AGT-03, AGT-04
**Success Criteria** (what must be TRUE):
  1. A pure Policy module decides hook behaviour from the session ledger with table-driven tests; block counters are persisted so a Host restart cannot reset them, and absent or evicted state is treated as allow.
  2. Hooks R0-R4 run in advise and enforce modes, demand at most one cheap atlas call, cap Stop blocks at 3, set explicit timeouts, and fail open when the Host is down, degraded or stale; `gsd-atlas init` also registers the hooks at user scope.
  3. The read-only `atlas-scout` subagent explores a repo using atlas tools only, so a swarm can fan out on it.
  4. `gsd-atlas check --staged` works as a git pre-commit hook and as a CI step, flagging a staged broken-caller edit, a stale or invented API use and a syntax-level violation.

**Plans:** TBD

### Phase 8: Value Dashboard and Enforcement Eval

**Goal:** A user can see, with honest labels, what atlas saved or caught, and can reproduce the hooks off/advise/enforce comparison showing that enforcement reduces bad commits without raising token cost.
**Mode:** mvp
**Depends on:** Phase 7
**Requirements:** DSH-01, DSH-02, DSH-03, AGT-05
**Success Criteria** (what must be TRUE):
  1. `gsd-atlas dashboard [--since 7d] [--html]` labels every figure `measured`, `estimated` or `A/B` with method, denominator and interval, never adds values of different classes, shows a range for every estimate, and a fixture agent making needless calls does not raise the context-kept-out headline.
  2. The HTML report is static and self-contained and contains no secret, path, symbol name or prompt; no value statistic appears in MCP output, `atlas_status` or hook briefs; a metrics write failure never blocks an answer or a gate; deleting a Tenant deletes its metrics.
  3. `gsd-atlas eval` runs the eval tasks with hooks off, advise and enforce and feeds the A/B panel.
  4. In enforce mode on the eval tasks, broken-caller edits, stale or invented API uses and syntax violations reaching a commit drop versus hooks off with total tokens no higher; hook p99 is 20 ms or less at 1,000 agents; and no gate blocks when the Host is down.

**Plans:** TBD
**UI hint**: yes

### Phase 9: Precise Imports, Bring-Your-Own Proof and 1.0

**Goal:** Atlas accepts precise indexes and new languages without core changes, hands code-to-decision links to gsd-graph, and ships as a documented, benchmarked 1.0 with every acceptance criterion green.
**Mode:** mvp
**Depends on:** Phase 8
**Requirements:** INT-01, INT-02, INT-03, INT-04, INT-05, EVL-04, REL-01, REL-02, REL-03, REL-04
**Success Criteria** (what must be TRUE):
  1. Any SCIP index imports as a PreciseResolver adapter, and on macOS after a build the first-party Swift IndexStoreDB helper provides compiler-precise references.
  2. The Python example module passes its fixtures and indexes gsd-path (553 files stored as 230 distinct contents) with no change to atlas source, and the authoring guide lets a reader write a language module.
  3. `bridge export` writes code-to-decision links that gsd-graph ingests and answers "which code implements ADR-457?" with citations.
  4. Docs, an install and upgrade guide and `gsd-atlas uninstall` exist, and the free-alternatives evaluation has been re-checked and recorded before 1.0.
  5. The benchmark suite meets every DESIGN.md performance budget at 1M LOC and on gsd-core (count and relative checks as PR gates, wall-clock p99 nightly), acceptance criteria 1-21 are green (Mac-hardware criteria on `xcode-27` CI or as documented local gates), and the pooled eval re-run on gsd-core, gsd-pi, gsd-path and the Swift app still shows fewer tokens at non-inferior accuracy (PRD M5 gate; see Coverage Notes).
  6. The pooled eval across gsd-core, gsd-pi, gsd-path and the Swift reference app shows atlas consuming fewer tokens than grep-only at non-inferior accuracy.

**Plans:** TBD

## Planning Notes

**Execution order and parallelism.** Numeric order is the default. Phases 4 and 5 are technically independent (Phase 4 needs the Tenant/HostClient from Phase 2 and the compiler pool and diagnostics from Phase 3; Phase 5 needs the Grammar Engine and the ProjectModel seam), so they can run in parallel. Phase 6 needs both. Phase 7 needs Phase 6 because hook rule R3 uses `sdk_check` and `syntax_check`; rules R0-R2 and the Policy `decide` function only need code tools.

**Phase 2 is the heaviest (33 requirements).** Open it with the walking-skeleton extension (build then find over a 3-file temp repo through the real Indexer, store, Query and CLI, on all three OSes), then fan out in the ARCHITECTURE.md waves (Source Tree, Fact Store, Grammar Engine and Governor in parallel; then Indexer; then Query and Metrics; then Tenant, Host, CLI and MCP). If plan-phase finds it too large, splitting it is the first lever (it would make ten phases).

**ADR ratification schedule (FND-09, FND-10, FND-12).** Proposed from the ARCHITECTURE.md dependency graph; confirm each ADR's scope in that phase's discuss-phase. Each phase's first plan ratifies its ADRs (issue opened, `draft-*` renamed to `<issue#>-<slug>.md`, Proposed to Accepted) and applies the listed amendments.

| Phase | ADRs to ratify before it starts | Research-gap amendments applied |
|-------|---------------------------------|---------------------------------|
| 1 | product-boundary, trust-boundaries, command-runner, language-modules, fact-model, fact-store-interface, sqlite-store, tenant-composition | ProjectModel seam (language-modules); read-triggered cache write and SQLite-access wording (fact-store-interface, sqlite-store); tracked as FND-10 |
| 2 | worktree-lifecycle, query-and-policy, mcp-contract, value-dashboard | writer contention and leader/follower (worktree-lifecycle); metrics migrations (value-dashboard); both tracked as FND-12 |
| 3 | user-controlled-diagnostics | none |
| 4 | host-process-model | none |
| 5-9 | none new | none |

**Amended 2026-10-18 on the user's instruction ("any ADR at the end of phase 3 must be assigned a number"; "for the end of phase 3 we want to ratify the adrs").** Nothing is ratified or renamed before the end of Phase 3. Plan 03-37, the last plan of Phase 3, numbers and ratifies every ADR that is still a draft at that point in one logged pass (today the diagnostics and host-process-model records, so the Phase 3 and Phase 4 rows above are read accordingly): one GitHub issue per draft, the rename to `<issue#>-<slug>.md` through one pull request, the issues closed after the merge. The twelve already-numbered records keep their numbers; from then on records change only by dated amendment or supersession. Draft files are never renamed at any other time.

**Research flags.** Phase 1: reproducible tree-sitter to WASM on three OSes, upstream grammar licences. Phase 2: `fs.watch` per OS, `node:sqlite` across worker threads, Windows WAL first-open. Phase 3: TypeScript compiler process model, tsconfig and project-model edge cases on gsd-core and gsd-pi. Phase 4: cross-platform lock election, named pipes, stdio shim reconnect. Phase 5: tree-sitter-swift `refs.scm` quality (85% target) and the grammar patch, `project.pbxproj` parsing. Phase 9: SCIP import shape, IndexStoreDB helper build and distribution. Phases 6, 7 and 8 use standard patterns.

**Mac-only gates.** SDK-08 and PRD criteria 6 and 15 need Xcode 27. Use the `xcode-27` runner if it proves available; otherwise they are local, self-attested gates, with SDK packs covering Linux CI.

**Granularity-driven choices already made.** TS 6.x is the MVP adapter with 7.x feature-detected; Host is stateless with stdio shim as the default client path; the free-alternatives scan runs before the Phase 3 eval; ADRs are ratified just before the first phase that needs them.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 (4 and 5 may run in parallel)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundations and Walking Skeleton | 20/20 | Complete    | 2026-10-16 |
| 2. Grammar Tier, Store and stdio Host | 46/46 | Complete    | 2026-10-17 |
| 3. TypeScript Module and MVP Eval | 37/38 | In Progress | - |
| 4. Host Hardening | 0/TBD | Not started | - |
| 5. Swift Module | 0/TBD | Not started | - |
| 6. Platform SDK Facts | 0/TBD | Not started | - |
| 7. Agent Integration | 0/TBD | Not started | - |
| 8. Value Dashboard and Enforcement Eval | 0/TBD | Not started | - |
| 9. Precise Imports, Bring-Your-Own Proof and 1.0 | 0/TBD | Not started | - |
