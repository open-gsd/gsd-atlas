# ADR: MCP tool contract and CLI parity

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-mcp-contract.md`)
- **DESIGN.md:** A11, A12, A26, A32, A44, A51
- **Review findings addressed:** M‑4, M‑5, S‑3, O‑2, F‑4

## Context
Agents choose the cheapest path. gsd‑atlas has to be cheaper than grep and file reading, return citations, say how current it is, and fit within host limits. Claude Code warns at 10,000 tokens of tool output and moves anything over 25,000 to a file. The response shape is a public contract: changing it later breaks skills, hooks and other tools. The design review added three requirements:
- ranking under a budget is the product and must be specified;
- transitive impact over name‑matched edges explodes;
- repo and package prose returned to agents is untrusted.

## Decision
1. **MVP tool set:**
   - read tools: `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status`, `lang_list`, `explain`;
   - privileged: `atlas_build` (`--allow-build`);
   - SDK and syntax tools join later under the same contract.
2. **Response envelope** on every tool: `schema` (semver), `data`, `citations` (file, line, fact id, `debug` handle), `watermark` (worktree, overlay snapshot, indexed‑through time, stale paths), `degraded` (e.g. "precise tier not active for this overlay"), `truncated`, `more` (cursor), `hints`.
3. **Token budget:** every tool takes `budget_tokens` (default 2,000) and returns ranked results cut to fit, with a `more` cursor.
4. **Ranking, per tool:**
   - **`code_find`:** exact name > prefix > trigram; then definitions in the agent's worktree > others; then `EXTRACTED` > `INFERRED`.
   - **`code_refs`:** `EXTRACTED` before `INFERRED`; same module first; recently changed files first.
   - **`code_context`:** definition, signature, `EXTRACTED` callers, callees, cited ADRs, `tested_by`, then `INFERRED` callers.

   Ranking quality is part of the answer‑quality eval.
5. **Impact expansion:** `code_impact` follows `EXTRACTED` edges transitively; `INFERRED` hops are listed but not expanded unless asked.
6. **Untrusted prose:** doc comments, ADR excerpts, package and SDK documentation are returned inside a fenced, length‑capped `untrusted_text` field, redacted, and never mixed into `hints`.
7. **Freshness:** any call may pass `fresh: [paths]` to have them indexed before answering (read your own writes).
8. **Worktree identity:** from MCP roots, else a `worktree` argument, else the connection's working directory.
9. **Read tools marked `readOnlyHint`.** Short server instructions carry the routing table (also repeated in the skill and session context, since not every host shows them).
10. **CLI parity:** every MCP tool has a CLI command returning the identical JSON, under gsd‑graph's machine contract (JSON on stdout, reasons on stderr, exit codes 0/1/2/3).
11. **Versioning:** breaking changes need a new `schema` major, an ADR amendment and a new host major (host ADR).

## Consequences
- Hooks, skills and other tools build on one stable shape.
- Budgets keep every answer far under host limits and cheaper than reading the files it replaces.
- `degraded` and `explain` make wrong or partial answers diagnosable instead of silent.
- Fencing costs a few tokens per answer and closes a prompt‑injection path.

## Alternatives considered
- **Many narrow tools:** harder for models to choose between; larger tool‑listing cost.
- **Unbounded results:** blow host output limits and cost more than grep.
- **No watermark or degraded flag:** agents can't tell a stale or partial answer from a current one.
- **Raw prose in results:** repo and dependency text could steer the agent.
