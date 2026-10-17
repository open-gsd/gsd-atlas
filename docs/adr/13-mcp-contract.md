# ADR: MCP tool contract and CLI parity

- **Status:** Accepted
- **Issue:** [#13](https://github.com/open-gsd/gsd-atlas/issues/13)
- **Ratified:** 2026-10-16
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
7. **Freshness:** any call may pass `fresh: [paths]` to have them indexed before answering (read your own writes). Implemented by Query calling `Indexer.ensureFresh`.
8. **Worktree identity:** from MCP roots, else a `worktree` argument, else the connection's working directory.
9. **Read tools marked `readOnlyHint`.** Short server instructions carry the routing table (also repeated in the skill and session context, since not every host shows them).
10. **CLI parity:** every MCP tool has a CLI command returning the identical JSON, under gsd‑graph's machine contract (JSON on stdout, reasons on stderr, exit codes 0/1/2/3).
11. **Versioning:** breaking changes need a new `schema` major, an ADR amendment and a new host major (host ADR).
12. **Query module:** every tool is a request kind of the one Query module, and MCP, CLI and hooks are adapters over it ([12-query-and-policy](12-query-and-policy.md)).

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

## Amendment 2026-10-16: Phase 2 contract changes

Sources: 02-CONTEXT.md D-07 to D-10 and D-19; 02-RESEARCH.md Pattern 9; MCP specification 2026-07-28 (Roots deprecated, protocol sessions removed).

Phase 2 ships the grammar-tier tools. Where it differs from the decisions above, this amendment governs. The original text stands unedited.

1. **Default profile (decision 1).** The default profile registers exactly six tools: `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status` and `lang_list`. `explain` arrives in Phase 3 and is not registered. `atlas_build` is not registered either: build stays a CLI command, so the six tools are all read-only.
2. **Worktree identity (decision 8).** MCP roots are deprecated in spec 2026-07-28 and the SDK v2 server is stateless, so identity no longer comes from roots or a connection. It comes from an explicit `repo` or `cwd` tool argument, then a `worktree` argument, then the process working directory.
3. **Token budget (decision 3).** `budget_tokens` is estimated as serialized characters divided by four. Items are cut whole, never mid-item, and a server-side hard output ceiling applies regardless of the requested budget.
4. **The `more` cursor.** `more` is an opaque keyset cursor that carries the last sort key, a hash of the query and the store watermark. If the watermark has moved when the cursor is used, the call continues and adds `degraded: ['watermark_moved']`.
5. **Degraded codes and errors.** Three degraded codes are added: `reconciling`, `rebuilding` and `watermark_moved`. `not_indexed` is an error diagnostic, not a degraded code, and it names the exact build command to run.
6. **CLI exit codes (decision 10).** The codes are 0 ok, 1 usage, 2 failure, and 3 for a writer lease held by another process or a busy host (exit code 3).
7. **Ranking (decision 4).** Ranking is the D-08 tiered comparator: exact name, then case-insensitive name, prefix, substring; then definitions over references; `EXTRACTED` over `INFERRED`; exported over local; the directory nearer to the cwd hint; and finally path and line as a stable tiebreak. Query-and-policy's `code_impact` semantics for Phase 2 are recorded in [12-query-and-policy](12-query-and-policy.md).

## Amendment 2026-10-17: Unbuilt repositories

Sources: FND-12; 02-REVIEW WR-01 and WR-02; 02-VERIFICATION; plans 02-40 and 02-41; QRY-04, QRY-06.

The first Phase 2 build let any read tool create a store directory, take the writer lease and open a tenant for a repository nobody had built, which also blocked a later `gsd-atlas build` while the agent's MCP server ran. This amendment records the rule the shipped Host follows. The decisions above and the amendment of 2026-10-16 stand unedited.

1. **Only `build` creates a store.** For a repository whose store is missing, holds no live overlay, has an older schema or is not a database, every other repo-scoped request answers `not_indexed` and names the command to run (`gsd-atlas build`). That covers `code_find`, `code_refs`, `code_context`, `code_impact`, and also `atlas_status` and the CLI-only `maintain` and `status`. The answer is produced before any tenant, lease, file or watcher exists. The classification is one read-only probe of `facts.db` (two fixed queries through the defensive read-only open). A probe that cannot settle (a busy database) counts as indexed, so a store is never withheld on a guess.
2. **A newer schema still reaches a tenant,** so the ratified `schema_too_new` message naming the host version is given. An older schema is not opened by a read request: the open path would delete and recreate it, and only a build may do that.
3. **`atlas_status` changes for an unbuilt repository.** It no longer returns an empty snapshot; it answers `not_indexed` like the other tools. The alternative (an ok `atlas_status` with empty data) was rejected: it needs a nullable `store` in the published snapshot, an agent cannot tell "indexed and empty" from "never built", and the error already carries the exact command. The cost is that an agent cannot read the language tiers or the policy before the first build.
4. **Unchanged answers.** `lang_list` and `history` do not need a store and answer as before; `history` still creates nothing in the repository.
5. **What a read tool still writes, by design.** In a repository the user has built, a read tool opens the store as leader or follower, so it still writes inside that store's directory: the writer lease (`lease.db` and `lease.json`), the WAL files (`facts.db-wal` and `facts.db-shm`; the read-only probe can leave `facts.db-shm` and an empty `facts.db-wal` beside a WAL database) and the metrics database (`metrics.db`). What it never does is create a store, or write anything outside a store directory that holds an index.
6. **Lease messages are one envelope.** The `not_indexed` and `lease_held` texts are produced once and the CLI and the MCP tool render the same bytes (QRY-04). They name the holder's process id and version and no path. While an agent's MCP server leads an existing index, `gsd-atlas build` and `maintain` answer `lease_held` (exit code 3); handing the build to the leader is the Phase 4 socket Host, and until then the only way is to end that process, which the message says.
7. **Tenant lifetime.** A tenant whose store closed itself answers `store_unavailable` and is dropped, so the next request builds a fresh one. An idle tenant is closed after the interval recorded in [9-tenant-composition](9-tenant-composition.md), Amendment 2026-10-17, which releases its lease.
