# gsd‑atlas Architecture Decision Records

Each ADR records one decision: what was decided, why, and what follows. ADRs are append‑only; later changes are dated amendment sections, never rewrites. Conventions follow open‑gsd/gsd‑core `docs/adr/README.md`.

## Naming
New ADRs are named `<issue#>-<kebab-slug>.md`, with the number of the GitHub issue that proposes them. The repo has no issues yet, so the founding set below is named `draft-<slug>.md`. When the repo is created, open one issue per ADR and rename each file to `<issue#>-<slug>.md` in the same PR that lands it. The eight Phase 1 ADRs were ratified on 2026-10-15 (issue opened, file renamed, Status Accepted); the Ratification log below lists the issues. The other six ADRs stay `draft-<slug>.md` and Proposed until the phase named in the Ratification schedule.

## Status vocabulary
`Proposed` (decided in principle, not ratified) · `Accepted` · `Superseded` (must link its successor) · `Retired`.

## Pre‑MVP set
These decisions shape the MVP's code and data, and are expensive to reverse once data exists. **MVP = working with gsd‑core development:** TypeScript (`.cts` → `.cjs`) on gsd‑core, local and resolved facts, the store, a single‑tenant host, the MCP read tools and the skill (PRD milestones M0–M2). All ADRs were revised after the adversarial design review (`../DESIGN-REVIEW.md`).

| ADR | Decision | DESIGN.md | Status |
|-----|----------|-----------|--------|
| [2-product-boundary](2-product-boundary.md) | Standalone sibling of gsd‑graph; MIT; three OSes; MVP = gsd‑core development; justified against free tools | A1, A13, A14, A16 | Accepted |
| [6-fact-model](6-fact-model.md) | Local facts by blob id, resolved edges by overlay and context; stable symbol identity; provenance, spans, confidence | A2, A8, A19, A45 | Accepted |
| [8-sqlite-store](8-sqlite-store.md) | SQLite via `node:sqlite` behind the Fact Store, driver internal and conformance‑tested; synced‑folder fallback; lazy rebuilds; real‑corpus budgets | A3, A4, A13, A17, A18, A50 | Accepted |
| [7-fact-store-interface](7-fact-store-interface.md) | One Fact Store module with a fact‑level seam; `at(worktree)` reader with `Answer<T>`; single writer lease; typed maintenance; SQL driver internal; no fake store | A2, A3, A5, A17, A20, A21, A26, A45, A46 | Accepted |
| [draft-host-process-model](draft-host-process-model.md) | One host per user and major version; repos as isolated tenants; versioned protocol; secure local transport; fair scheduling; no caps | A22–A28, A39–A43, A46, A49 | Proposed |
| [5-language-modules](5-language-modules.md) | Languages are data; shared Grammar Engine; PreciseResolver seam; three tiers; grammars built from pinned upstream with a parse‑error budget; what counts as source | A6, A7, A9, A25, A47, A48 | Accepted |
| [draft-worktree-lifecycle](draft-worktree-lifecycle.md) | Overlays; collect when in git or past grace; history from git; submodules; watch fallback | A5, A20, A21, A43 | Proposed |
| [draft-mcp-contract](draft-mcp-contract.md) | MCP tool set, response envelope, ranking, token budgets, freshness and degraded flags, untrusted‑text fencing, CLI parity | A11, A12, A26, A32, A44, A51 | Proposed |
| [draft-user-controlled-diagnostics](draft-user-controlled-diagnostics.md) | No telemetry; diagnostics off by default, approved per data type, submitted as GitHub issues; ↑ ↔ ↓ ratings; `gsd-atlas bug` defect forensics; automatic intake in the repo | A16, A52, A53 | Proposed |
| [draft-query-and-policy](draft-query-and-policy.md) | One Query module behind MCP, CLI and hooks; a separate pure Policy module with the session ledger | A11, A12, A26, A32–A37, A44, A51, A58 | Proposed |
| [9-tenant-composition](9-tenant-composition.md) | Host composes per‑repo Tenants; Source Tree, Indexer and Governor modules; read‑your‑writes via the Indexer | A4, A19, A22, A24–A28, A40, A47, A49, A59–A62 | Accepted |
| [4-command-runner](4-command-runner.md) | One CommandRunner for every child process; providers declare a CommandSpec, the runner alone decides; sandboxed TypeScript adapter | A9, A44, A54 | Accepted |
| [draft-value-dashboard](draft-value-dashboard.md) | Local dashboard: separate Metrics module and database; every figure labeled measured/estimated/A/B; no single score; no telemetry | A16, A18, A32, A36, A50, A52, A63 | Proposed |
| [3-trust-boundaries](3-trust-boundaries.md) | Permissions only from user config; built‑in providers on by default; endpoint security; untrusted text fenced | A9, A16, A27, A44 | Accepted |

## Ratification log
Phase 1 ratification (FND-09): one issue per ADR in open-gsd/gsd-atlas, each draft renamed to `<issue#>-<slug>.md` and moved from Proposed to Accepted. Issues stay open; closing them is a later, separate step.

| Slug | Issue | File | Ratified |
|------|-------|------|----------|
| product-boundary | [#2](https://github.com/open-gsd/gsd-atlas/issues/2) | [2-product-boundary.md](2-product-boundary.md) | 2026-10-15 |
| trust-boundaries | [#3](https://github.com/open-gsd/gsd-atlas/issues/3) | [3-trust-boundaries.md](3-trust-boundaries.md) | 2026-10-15 |
| command-runner | [#4](https://github.com/open-gsd/gsd-atlas/issues/4) | [4-command-runner.md](4-command-runner.md) | 2026-10-15 |
| language-modules | [#5](https://github.com/open-gsd/gsd-atlas/issues/5) | [5-language-modules.md](5-language-modules.md) | 2026-10-15 |
| fact-model | [#6](https://github.com/open-gsd/gsd-atlas/issues/6) | [6-fact-model.md](6-fact-model.md) | 2026-10-15 |
| fact-store-interface | [#7](https://github.com/open-gsd/gsd-atlas/issues/7) | [7-fact-store-interface.md](7-fact-store-interface.md) | 2026-10-15 |
| sqlite-store | [#8](https://github.com/open-gsd/gsd-atlas/issues/8) | [8-sqlite-store.md](8-sqlite-store.md) | 2026-10-15 |
| tenant-composition | [#9](https://github.com/open-gsd/gsd-atlas/issues/9) | [9-tenant-composition.md](9-tenant-composition.md) | 2026-10-15 |

**Editorial repairs made at ratification (not amendments).** A lost-text token (a backslash and the digit one) had replaced passages in four files. Each was repaired from the project's own sources, `PRD.md` section 4.6 and `DESIGN.md` A9, and is pending human review:
- `3-trust-boundaries.md` decision 2: restored the heading `Commands.` and its three rules.
- `5-language-modules.md` decision 5: restored the bullet on commands that are neither grammars, queries nor built-in providers.
- `6-fact-model.md` decision 2 and `../PRD.md` section 4.7 intro: removed the token; the following sentence stands on its own.
- `../SDK-PROVIDERS.md` (normalized result paragraph) has the same token ending mid-sentence. Its lost clause cannot be recovered from any source, so the file is left unchanged and flagged for the user.

### Amendment log
Dated amendment sections appended to Accepted ADRs, one line per amendment. The original text is never edited.

- Amendment 2026-10-15: language-modules - ProjectModel seam (FND-10, D-16)

## Ratification schedule
The six ADRs that remain Proposed, and the phase whose first plan ratifies each (from the ROADMAP schedule). Ratifying means: open the issue, rename `draft-<slug>.md` to `<issue#>-<slug>.md`, move Proposed to Accepted, and apply the listed amendments as dated sections.

| ADR | Ratify before | Amendments applied at that ratification |
|-----|---------------|------------------------------------------|
| worktree-lifecycle | Phase 2 | Writer contention and leader/follower |
| query-and-policy | Phase 2 | None |
| mcp-contract | Phase 2 | None |
| value-dashboard | Phase 2 | Metrics migrations |
| user-controlled-diagnostics | Phase 3 | None |
| host-process-model | Phase 4 | None |

## Before M4 (not needed for the MVP)
- **SDK facts and providers** (A10, A29–A31): local‑only SDK facts, provider order, language levels, TypeScript 6/7 adapters.
- **Agent enforcement** (A33–A38): skill routing, hooks, policy modes, pre‑commit backstop.
- **Embeddings** (A15): opt‑in vectors post‑1.0.
