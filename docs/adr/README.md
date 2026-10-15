# gsd‑atlas Architecture Decision Records

Each ADR records one decision: what was decided, why, and what follows. ADRs are append‑only; later changes are dated amendment sections, never rewrites. Conventions follow open‑gsd/gsd‑core `docs/adr/README.md`.

## Naming
New ADRs are named `<issue#>-<kebab-slug>.md`, with the number of the GitHub issue that proposes them. The repo has no issues yet, so the founding set below is named `draft-<slug>.md`. When the repo is created, open one issue per ADR and rename each file to `<issue#>-<slug>.md` in the same PR that lands it.

## Status vocabulary
`Proposed` (decided in principle, not ratified) · `Accepted` · `Superseded` (must link its successor) · `Retired`.

## Pre‑MVP set
These decisions shape the MVP's code and data, and are expensive to reverse once data exists. **MVP = working with gsd‑core development:** TypeScript (`.cts` → `.cjs`) on gsd‑core, local and resolved facts, the store, a single‑tenant host, the MCP read tools and the skill (PRD milestones M0–M2). All ADRs were revised after the adversarial design review (`../DESIGN-REVIEW.md`).

| ADR | Decision | DESIGN.md | Status |
|-----|----------|-----------|--------|
| [draft-product-boundary](draft-product-boundary.md) | Standalone sibling of gsd‑graph; MIT; three OSes; MVP = gsd‑core development; justified against free tools | A1, A13, A14, A16 | Proposed |
| [draft-fact-model](draft-fact-model.md) | Local facts by blob id, resolved edges by overlay and context; stable symbol identity; provenance, spans, confidence | A2, A8, A19, A45 | Proposed |
| [draft-sqlite-store](draft-sqlite-store.md) | SQLite via `node:sqlite` behind a tested driver interface; synced‑folder fallback; lazy rebuilds; real‑corpus budgets | A3, A4, A13, A17, A18, A50 | Proposed |
| [draft-host-process-model](draft-host-process-model.md) | One host per user and major version; repos as isolated tenants; versioned protocol; secure local transport; fair scheduling; no caps | A22–A28, A39–A43, A46, A49 | Proposed |
| [draft-language-modules](draft-language-modules.md) | Languages are data; three tiers; grammars built from pinned upstream with a parse‑error budget; what counts as source | A6, A7, A9, A25, A47, A48 | Proposed |
| [draft-worktree-lifecycle](draft-worktree-lifecycle.md) | Overlays; collect when in git or past grace; history from git; submodules; watch fallback | A5, A20, A21, A43 | Proposed |
| [draft-mcp-contract](draft-mcp-contract.md) | MCP tool set, response envelope, ranking, token budgets, freshness and degraded flags, untrusted‑text fencing, CLI parity | A11, A12, A26, A32, A44, A51 | Proposed |
| [draft-user-controlled-diagnostics](draft-user-controlled-diagnostics.md) | No telemetry; diagnostics off by default, approved per data type, submitted as GitHub issues; ↑ ↔ ↓ ratings; `gsd-atlas bug` defect forensics; automatic intake in the repo | A16, A52, A53 | Proposed |
| [draft-trust-boundaries](draft-trust-boundaries.md) | Permissions only from user config; built‑in providers on by default; endpoint security; untrusted text fenced | A9, A16, A27, A44 | Proposed |

## Before M4 (not needed for the MVP)
- **SDK facts and providers** (A10, A29–A31): local‑only SDK facts, provider order, language levels, TypeScript 6/7 adapters.
- **Agent enforcement** (A33–A38): skill routing, hooks, policy modes, pre‑commit backstop.
- **Embeddings** (A15): opt‑in vectors post‑1.0.
