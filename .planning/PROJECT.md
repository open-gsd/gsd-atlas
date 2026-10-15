# gsd-atlas

## What This Is

gsd-atlas is a local, MIT-licensed map of a codebase and the platform SDKs it targets, built for coding agents. It serves cited, current code facts (definitions, references, imports, inheritance, ADR citations) and installed-SDK facts (APIs with the OS version each was introduced or deprecated) over MCP, a CLI and an Agent Skill. It is a sibling of gsd-graph, not part of it. Package `@opengsd/gsd-atlas`, CLI `gsd-atlas`, MCP shim `gsd-atlas-mcp`.

## Core Value

Agents get correct, cited, current answers about the code and the platform they are building against, instead of guessing from stale training data or sweeping the repo with grep.

## Business Context

- **Customer**: Developers and coding agents in the open-gsd ecosystem; anyone replacing paid code-memory/code-graph tools (Memtrace and others) with a free, local one.
- **Revenue model**: None. Open source (MIT).
- **Success metric**: Agents using atlas answer the 50-question-per-corpus eval correctly with a verifiable file:line citation at least 80% of the time and beat a grep-only baseline outside run-to-run interval.
- **Strategy notes**: `docs/PRD.md` §1.1 (why build it), `docs/adr/draft-product-boundary.md`.

## Requirements

### Validated

(None yet — ship to validate)

### Active

Scope is the full PRD 1.0 (milestones M0–M6, 21 acceptance criteria). Source of truth: `docs/PRD.md` §2–§11. Summary:

- [ ] Code support module system: manifest, resolution order, three tiers (grammar, precise, platform), runtime interface (M0)
- [ ] Fact Store (SQLite via `node:sqlite`, local facts by git blob id, overlays, lifecycle, self-maintenance), Source Tree, CommandRunner, Grammar Engine, Governor seams with test doubles (M0)
- [ ] Indexer (watcher, coalescing queue, Reconcile, `ensureFresh`), Query with full response envelope, read MCP tools, CLI parity, single-tenant stdio Host, Metrics module (M1)
- [ ] TypeScript module: TS 6.x and 7.x PreciseResolver adapters, tsconfig-driven emit mapping (`.cts` to `.cjs`), ADR citations, `explain`, skill, ratings, diagnostics, `gsd-atlas bug` (M2, the MVP)
- [ ] Host hardening: multi-tenant Host, versioned protocol, socket/HTTP transport, supervisor, full Governor, shared SDK stores, diagnostics intake workflow (M2.5)
- [ ] Swift module: grammar tier with own `refs.scm`, SwiftPM/Xcode project model, availability facts (M3)
- [ ] Platform SDK facts: Apple and Node providers, SDK packs, `platform_card`, `sdk_lookup`, `sdk_check`, `sdk_diff`, `syntax_check`; Policy module, skill, `atlas-scout`, hooks R0-R4, pre-commit check, value dashboard, `gsd-atlas eval` (M4)
- [ ] SCIP importer, Swift IndexStoreDB helper, Python example module (bring-your-own proof), authoring guide, `bridge export` to gsd-graph (M5)
- [ ] 1.0: docs, install/upgrade guide, performance pass, free-alternatives re-check, all criteria green (M6)
- [ ] Free-alternatives evaluation (LSP-wrapping MCP servers, agent repo-maps, paid tools) recorded before the M2 eval, so it supplies a baseline (PRD §1.1)
- [ ] ADR ratification in Phase 1: one GitHub issue per ADR, rename `draft-*` to `<issue#>-<slug>.md`, Proposed to Accepted
- [ ] CI on macOS, Linux and Windows from M0/M1, since no Windows hardware is available locally

### Out of Scope

- Data-flow, taint or type inference beyond compilers and indexers — different engine, not needed for the core value
- LSP bridge — candidate later tier
- Fetching documentation from the web — privacy stance, SDK facts come from disk
- Embedding/vector search — post-1.0, opt-in, local models only (A15)
- Network sharing — pending privacy review
- GUI — the dashboard's static HTML report is not a GUI
- Telemetry of any kind — the only outbound data is a user-approved diagnostics report
- Open Knowledge Format export — post-1.0, gated on spec license and maturity check
- Writing into gsd-graph's store — bridge export only; no install-time dependency either way

## Context

- **Design is decided in depth.** `docs/PRD.md` (v0.1.0), `docs/DESIGN.md` (decision table A1–A63), 14 `docs/adr/draft-*.md` (all Proposed), `docs/DESIGN-REVIEW.md` (adversarial review), `docs/DIAGNOSTICS.md`, `docs/SDK-PROVIDERS.md`, `docs/AGENT-INTEGRATION.md`, `docs/DASHBOARD-METRICS.md`, `GLOSSARY.md`. No source code exists yet; the repo is docs-only.
- **Interop:** sibling of gsd-graph; borrows its provenance shape, CLI contract (JSON stdout, reasons stderr, exits 0/1/2/3) and safety code by copy with attribution.
- **Validation corpora:** gsd-core (284 `.cts` in `src/`, 274 in tsconfig; compiled to gitignored `.cjs`; TS 6.0.3; Node >= 24), gsd-pi (pnpm monorepo, 12 packages, 14 tsconfigs, ~3,900 `.ts`), gsd-path (553 Python files, 230 distinct contents), gsd-graph, plus one open-source Swift app (to be picked during M3). Only gsd-core is cloned locally (on branch `next`, 14 commits behind origin); the others will be cloned into `~/projects`.
- **Machine:** macOS, Node v26.11.1, Xcode 27.0 (27A266a), iOS SDK 27.0, Swift 6.4, `gh` authenticated; origin is `open-gsd/gsd-atlas`.
- **Team:** solo builder plus agents; external PRs for features/enhancements may arrive but the MVP is built solo.
- **Pending ADR open questions** (~10 minor ones, e.g. `warm(worktree)`, watcher location, ledger eviction visibility) are resolved in each phase's discuss-phase, not up front.
- **Existing `package.json`** only installs `@opengsd/gsd-core` as GSD tooling; it must not become a runtime dependency (ADR product-boundary item 3).

## Constraints

- **Tech stack**: TypeScript, Node >= 24, SQLite via `node:sqlite` with `better-sqlite3` kept working as fallback — A13, A3
- **Repo layout**: Single npm package `@opengsd/gsd-atlas` with bins `gsd-atlas` and `gsd-atlas-mcp`; language modules under `modules/` and publishable later — chosen for MVP simplicity
- **Platforms**: macOS, Linux and Windows are 1.0 platforms, in every budget's CI run from M1 — GSD users run all three, and gsd-core's Windows CI is a known pain point
- **Privacy**: No network by default, no telemetry; permissions only from user-level config (`~/.config/gsd-atlas/`); repo text fenced as untrusted — trust-boundaries ADR
- **Host coupling**: No dependency on gsd-core, gsd-graph or `.planning/`; gsd-core is a validation corpus only — A14
- **Licensing**: MIT; vet licenses of pinned upstream grammars and any OKF spec before use
- **Determinism of measurement**: Pin each eval corpus to a commit SHA so accuracy and eval numbers are comparable across runs
- **Mac-only gates**: Criteria 6 and 15 need Xcode 27; GitHub macOS runners may lack it, so these are local/self-attested gates, with SDK packs (U7) covering Linux CI
- **Unstable dependencies**: TypeScript 7 `unstable/sync` API and `node:sqlite` are pinned and tested per minor release
- **Capacity**: Solo builder plus agents; phases kept fine-grained

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Standalone sibling of gsd-graph, MIT | Extending gsd-graph would override its frozen decisions (K1, K4, K13) | — Pending |
| Languages are data (manifest + WASM grammar + queries) | Bring-your-own language with no core change or release | — Pending |
| Two-layer fact model: local facts by blob id, resolved edges by overlay + context | Same file can resolve differently per branch; sharing resolved edges would cite wrong code | — Pending |
| One host per user and major version, repos as isolated tenants | Expensive runtime state once per machine; one bad repo doesn't take atlas down | — Pending |
| Roadmap covers full 1.0 (M0-M6) | User chose full PRD scope for v1 | — Pending |
| Single npm package for the MVP | Simplest; split into workspaces only if needed | — Pending |
| Free-alternatives evaluation before the M2 eval | Gives the eval a baseline without gating build start | — Pending |
| Ratify all 14 ADRs in Phase 1 | PRD M0 gate; issues opened, files renamed, Proposed to Accepted | — Pending |
| Swift reference app: pick an open-source app during M3 | PRD leaves it unnamed; defer the choice until needed | — Pending |
| ADR open questions resolved in phase discuss | None blocks planning | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-15 after initialization*
