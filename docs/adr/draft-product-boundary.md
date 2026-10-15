# ADR: gsd‑atlas product boundary

- **Status:** Proposed
- **Issue:** to be opened (rename this file to `<issue#>-product-boundary.md`)
- **DESIGN.md:** A1, A13, A14, A16
- **Review findings addressed:** P‑1, P‑2, P‑3, O‑1

## Context
Live code indexing and platform SDK facts were first drafted as a gsd‑graph feature (gsd‑graph PRD 0.2.0). Absorbing them would have overridden about half a dozen of gsd‑graph's frozen decisions: K1 (product), K4 (JSON store), K13 (no DB), the v1 non‑goal "full code AST/symbol graph", and others. gsd‑graph is the knowledge graph for docs, planning and decisions; code intelligence has a different engine (live index, compilers, grammars, SDK extraction), install footprint and contributor base.

## Decision
1. **gsd‑atlas is its own product**: a local map of a codebase and the platform SDKs it targets, for coding agents. Package `@opengsd/gsd-atlas`, CLI `gsd-atlas`, MCP `gsd-atlas-mcp`.
2. **Sibling of gsd‑graph, not part of it.** gsd‑atlas never writes gsd‑graph's store. It exports code‑to‑decision links through a bridge (gsd‑graph *Atlas bridge* PRD). Neither depends on the other at install time.
3. **No host coupling.** No dependency on gsd‑core, gsd‑graph or `.planning/`. gsd‑core is a validation corpus only.
4. **Borrow, don't depend.** Copy needed gsd‑graph code (provenance types, ids, path safety, lock, redaction, hashing, errors, MCP scaffold) with attribution headers.
5. **License:** MIT, matching gsd‑graph.
6. **Privacy:** no network by default, no telemetry. Feedback comes only through user‑controlled diagnostics: disabled by default, approved per data type, submitted by the user as GitHub issues (user‑controlled‑diagnostics ADR).
7. **Platforms:** macOS, Linux and Windows are 1.0 platforms, tested in CI from the MVP.
8. **MVP = gsd‑core development.** The first usable release indexes gsd‑core (TypeScript, `.cts` → `.cjs`, its ADRs) and serves its agents. Swift, SDK facts, multi‑repo hardening and enforcement hooks follow in later milestones, built on the same ADRs.
9. **Justify against free tools.** The PRD keeps an *Alternatives* section naming the free and open‑source tools evaluated (e.g. MCP servers that wrap language servers, repo‑map tools) and the gap each leaves; it's re‑checked before 1.0.

## Consequences
- The motivation is replacing paid tools (Memtrace and code‑graph tools); the alternatives section keeps that honest against free ones.
- gsd‑graph keeps its frozen K‑table; the code work no longer forces changes there.
- Two packages and two MCP servers to install; agents can use either or both.
- Borrowed code can drift from gsd‑graph; shared fixes are ported by hand.

## Alternatives considered
- **Extend gsd‑graph:** rejected; too many frozen decisions overridden, and docs‑graph users would carry the code engine's footprint.
- **Shared library package for both:** deferred; copy first, extract a shared package only if drift becomes costly.
