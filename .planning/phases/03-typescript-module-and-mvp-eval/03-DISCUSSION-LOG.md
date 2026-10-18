# Phase 3: TypeScript Module and MVP Eval - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-10-17
**Phase:** 3-TypeScript Module and MVP Eval
**Areas discussed:** Eval design and cost, Build order and first slice, TS 7.x adapter scope, Approvals and diagnostics UX, ADR citations, Memory budget and degrade, Skill contents

---

## Eval design and cost

| Question | Options | Selected |
|----------|---------|----------|
| Who writes the 50+ questions | Agent drafts, you review / You write them / Mixed by category | Agent drafts, you review |
| Oracle | Compiler-derived key plus script / Human-labelled key / Compiler key with human spot-check | Compiler-derived key plus script |
| Agent that runs sessions | Claude Code headless / Own loop on the Anthropic API / Both, headless first | Claude Code headless |
| Margin and miss policy | 5 points hard gate / 5 points report-only / 10 points hard gate | 5 points, hard gate |
| Free-alternatives depth | Desk plus one live run each / Desk only / Add as third eval arm | Desk plus one live run each |
| Token definition | Total billable per session / Uncached input plus output / Context tokens at answer time | Total billable per session |

**User's choice:** the recommended option in every case.
**Notes:** The user chose to continue past the first check and asked for more questions in this area.

---

## Build order and first slice

| Question | Options | Selected |
|----------|---------|----------|
| First tracer | Precise code_refs on one gsd-core tsconfig / Eval harness on grammar tier / Both in parallel | Precise code_refs on one gsd-core tsconfig |
| Freeze timing | Freeze first then build / Freeze in parallel / Freeze after | Freeze first, then build |
| Skill in the atlas arm | Skill plus MCP tools / MCP tools alone / Both as arms | Skill plus MCP tools |
| Budget gating | Same two-tier as freshness / Strict on Linux and macOS, report-only on Windows / Strict everywhere | Same two-tier as freshness |
| Trust work position | Parallel, before scored run / After eval / SEC with precise, rest after | Parallel with the precise tier, before the scored run |

**User's choice:** the recommended option in every case.

---

## TS 7.x adapter scope

| Question | Options | Selected |
|----------|---------|----------|
| 7.x scope | Detection and fallback only / Working adapter on 7.0.2 / Working adapter behind a flag | Detection and fallback only |
| Which 6.x compiler | Project's own if present, else bundled / Always bundled / Bundled by default, project's on opt-in | Project's own 6.x if present, else bundled |
| 7.x test approach | Real 7.0.2 alias plus fixture layouts / Fixture layouts only / Real 7.0.2 only | Real 7.0.2 alias plus fixture layouts |

**User's choice:** the recommended option in every case.
**Notes:** Loading the project's own compiler means the worker runs JavaScript from the repo's node_modules; recorded as a trust-boundary decision in D-13.

---

## Approvals and diagnostics UX

| Question | Options | Selected |
|----------|---------|----------|
| Approving a precise.command | Explicit CLI command writing user config / Hand-edit user config / Interactive prompt on first use | Explicit CLI command writing user-level config |
| Ratings | CLI command, local only / Also an MCP tool / CLI plus hook prompt | CLI command, stored locally only |
| gsd-atlas bug | Local bundle, preview, you submit / Also a prefilled issue URL / Optional send to an endpoint | Local bundle, preview, you submit |
| explain | CLI and MCP tool by id / CLI only by location / Flag on existing commands | CLI and MCP tool, takes a fact or answer id |

**User's choice:** the recommended option in every case.

---

## ADR citations

| Question | Options | Selected |
|----------|---------|----------|
| Syntax and location | ADR-<n>, ADR <n>, ADR #<n> in comments / Strict ADR-<n> only / Comments and markdown | ADR-<n>, ADR <n>, ADR #<n> in comments |
| ADR directory and unresolved ids | Manifest convention list, keep flagged / Fixed docs/adr only / Drop unresolved | Convention list in the manifest; keep unresolved as flagged facts |

**User's choice:** the recommended option in every case.
**Notes:** gsd-core's ADRs were inspected to ground the options (about 99 files, `<number>-<slug>.md`, cited as `ADR-3473`).

---

## Memory budget and degrade

| Question | Options | Selected |
|----------|---------|----------|
| Enforcement | Worker limit plus RSS watch / Parent RSS watch only / Pre-estimate by file count | Worker resource limit plus RSS watch |
| Repo scope | gsd-core required, gsd-pi must not break / gsd-core only / gsd-pi resolved edges too | gsd-core required, gsd-pi must not break |

**User's choice:** the recommended option in every case.
**Notes:** The budget value itself was already decided by DESIGN A25 (25% of RAM, LRU pool) and was carried forward, not re-asked.

---

## Skill contents

| Question | Options | Selected |
|----------|---------|----------|
| gsd-atlas skill | Short routing skill, frozen by hash / Detailed with worked examples / Iterate during eval | Short routing skill, frozen by hash |
| gsd-atlas-module-author skill | Grammar tier plus how the TS module is built / Grammar tier only / Full authoring guide now | Grammar tier plus how the TypeScript module is built |

**User's choice:** the recommended option in every case.

---

## Claude's Discretion

- File and module names, config key names, the worker message protocol, the bug bundle format, and question categories beyond the required ones.
- How the harness reads usage from `claude -p`, and the cluster-bootstrap implementation, provided the pre-registered margin holds.

## Deferred Ideas

- Working TypeScript 7.x resolver (when 7.1 is stable)
- Third eval arm (skill ablation or strongest free alternative)
- ADR citations from markdown docs
- MCP rating tool and post-answer rating prompt (Phase 7)
- Prefilled GitHub issue URL and diagnostics upload (Phase 4)
- Resolved cross-package edges on gsd-pi (Phase 9, EVL-04)
