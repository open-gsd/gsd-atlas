# ADR: MCP tool contract and CLI parity

- **Status:** Accepted
- **Issue:** [#13](https://github.com/open-gsd/gsd-atlas/issues/13)
- **Ratified:** 2026-10-16
- **DESIGN.md:** A11, A12, A26, A32, A44, A51
- **Review findings addressed:** M‑4, M‑5, S‑3, O‑2, F‑4

> Pre-release note: this record is not yet ratified; ratification is planned for the end of Phase 3, and every ADR will have a number by the MVP release; its Accepted status and issue number do not mean it is ratified (see docs/adr/README.md).

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

## Amendment 2026-10-18: Phase 3 contract changes

Sources: 03-CONTEXT.md D-16, D-18, D-20 and D-21; 03-RESEARCH.md Pattern 7 and Seam Gaps G9 and G11; 03-DECISIONS.md (OQ2); [12-query-and-policy](12-query-and-policy.md) and [6-fact-model](6-fact-model.md), amendments of the same date.

Phase 3 adds the compiler-precise tier, ADR citations and `explain`. Each change below is additive to the published envelope, so the `schema` minor version moves and the major does not. A Phase 2 shaped envelope without the new fields stays valid. The decisions above and the two earlier amendments stand unedited; where they differ from this section, this section governs.

1. **Seventh tool, `code_explain` (decision 1; supersedes point 1 of the amendment of 2026-10-16).** The sentence "the default profile registers exactly six tools" is replaced: the default profile registers seven tools, the six already named plus `code_explain` as the seventh. The sentence "`explain` arrives in Phase 3 and is not registered" is fulfilled: the read tool that decision 1 calls `explain` is registered under the name `code_explain`, and the CLI command `gsd-atlas explain <handle>` returns the identical JSON (decision 10). It is read-only, marked `readOnlyHint`, takes the usual `budget_tokens`, and is a request kind of the one Query module. `atlas_build` is still not registered, so all seven tools are read-only.
2. **`code_explain` input.** `handle` is required: a fact id, which is the `debug` string of any citation in any tool's answer. Callers pass it through unchanged and never build or parse one; only the store parses handles, and a handle is valid for `sym/`, `ref/`, `imp/`, `exp/` and `cit/` facts and for relation facts. `repo` and `cwd` are optional and identify the worktree exactly as on the other tools (point 2 of the amendment of 2026-10-16). Any further input, for example explaining a recorded answer by its `answer_id`, is additive and needs its own dated amendment before it ships.
3. **`code_explain` output.** The `data` object reports, for the fact named by the handle: the extractor (for example a grammar extractor with its module name and version, or a precise extractor with the compiler version); the tier (`grammar`, `precise` or `base_commit`); the grammar version; the resolution context (its id and the number of config hashes it holds); the overlay snapshot id and the watermark; the cache state of the site under the current snapshot and context (a cached edge exists, asked and no edge, not asked, or not applicable); the tier states of the module, including `needs_approval`; and the compiler used, as name, version and source (`project` or `bundled`), with the reason for any fallback. A fact extracted at an older grammar version than the module now has is explained with both versions and marked stale, not hidden. Explain never runs a resolver, never starts the compiler worker and never writes the store. A malformed, oversized, unknown or no-longer-current handle gets a fixed-text error diagnostic (`invalid_handle` or `stale_handle`) that does not echo the handle, and never an exception. Repository text appears only inside `untrusted_text` (decision 6); every other string in the explanation is a fixed sentence or fact data.
4. **Envelope extra `answer_id`.** Every tool answer may carry `answer_id`: a random identifier that holds no content, stamped by the Host after the answer exists and not by Query. It lets a user rate or report an answer later without the server storing the answer's content ([14-value-dashboard](14-value-dashboard.md), amendment of the same date). It is optional in the schema, so a client that ignores it keeps working, and the CLI and the MCP tool return the same JSON for one request apart from this field.
5. **Three degraded codes.** The set of `degraded` codes grows by three, from eleven to fourteen. `memory_budget`: the compiler worker was ended or refused because the machine-wide memory budget (DESIGN A25) was reached, and the answer falls back to grammar facts. `compiler_fallback`: the bundled compiler stood in for the project's own, because the project has none, has a 7.x layout, or has a copy the worker may not load; the reason is named in the answer. `needs_approval`: a precise tier needs a command that the user has not approved for this repository, and the MCP server, which never prompts, answers from the grammar tier unless it was started with `--allow-build` ([3-trust-boundaries](3-trust-boundaries.md), amendment of the same date). A consumer that meets a code it does not know treats it as "degraded, reason unknown".
6. **`kind: adr` on `code_find` and `code_refs` (decision 4).** A `kind` of `adr` with a name that reads as an ADR number (`ADR-3473`, `adr 3473`, `#3473` or `3473`, compared by value) changes the meaning of the lookup. `code_find` returns the ADR file or files for that number, with `INFERRED` confidence and an ambiguous status when several files share it, or an `unresolved` status that includes how many citations of the number exist. `code_refs` lists the citation sites with path, line, column, the short section detail and the symbol each is attached to. No new tool is added for this.
7. **`code_context` gains two sections.** `citations` lists the ADR citations attached to the symbol (number, detail, status, files, and the citation site); `emittedAs` lists the emit output paths of the file that holds the definition, for example the `.cjs` file produced from a `.cts` source. Both are absent when empty. Decision 4's ordering for `code_context` is unchanged and the new sections follow `tested_by`.
8. **`code_impact` hop kinds (decision 5).** The `via` value of an impact hop, `ImpactVia`, grows from `import`, `call` and `reference` by three values: `extends`, `implements` and `overrides`. They are followed transitively only when the edge is `EXTRACTED`, like the existing hops, and are ranked by the same rule.
9. **Precise-edge labelling.** An item produced by the precise tier names its relation (`calls`, `references`, `extends`, `implements` or `overrides`) in an `edge` field; an item from the grammar tier has none. The `code_refs` ranking of decision 4 is unchanged.

## Amendment 2026-10-18: `code_explain` by answer id, and the relation handle

Sources: plan 03-26 (QRY-07, D-18); the amendment of the same date above, points 1 to 3; [14-value-dashboard](14-value-dashboard.md), amendment of the same date (the `answer_id`). The amendments above stand unedited; where this section is more specific, it governs.

Point 2 of the amendment above says that explaining a recorded answer by its `answer_id` "is additive and needs its own dated amendment before it ships". This is that amendment.

1. **`code_explain` takes `handle` or `answer_id`, exactly one.** `handle` is no longer required by the schema: the schema accepts either, and Query refuses both together or neither with `invalid_args` and one fixed sentence. `budget_tokens` is accepted, as point 1 says. An `answer_id` is the one the Host stamped on an earlier answer of the same repository; the Tenant's flight recorder resolves it. An id the recorder no longer holds, or one from another repository, answers `answer_not_found`.
2. **What an answer explanation reports.** `data.answer` holds the recorded tool, the outcome (`ok` or the first diagnostic code), the latency bucket label, the degraded codes and the number of results, each read from a closed vocabulary (a recorded string outside it reads `unknown`); `data.facts[]` summarises up to five of the answer's handles, each with its status and, for a handle that is current, its kind, tier and confidence. No recorded request argument, name or text is returned.
3. **The handle length is Query's rule, not the schema's.** A handle longer than 2,048 characters is an `invalid_handle` answer like any other malformed handle, from every adapter, rather than a schema refusal that differs between the CLI and the MCP server. The schema still describes the limit.
4. **Relation handles.** A compiler relation (`extends`, `implements` or `overrides`) has the handle `rel/<relation>/<from path>/<from hash>/<from ordinal>/<to path>/<to ordinal>`, paths percent-encoded as in the other handles. It explains as a `relation` fact, tier `precise`, `EXTRACTED`, with the resolver that stored it and the other end as `resolution.target`. No `cit/` handle exists yet; point 2 of the amendment above lists it for the ADR citations of plan 03-24, which are cited without one in this release.
5. **A handle's file version is current or stale.** A handle is valid for the file version it names. Once the overlay holds another version of that path, the answer is `stale_handle`; an unknown path, a path outside the overlay and an ordinal that is no fact of the file are `invalid_handle`. Neither message echoes the handle.
6. **Tier states.** `data.tiers.precise` is `active`, `degraded` (with the degraded code of the compiler worker's last failure), `inactive`, `needs_approval` or `disabled`, each with a fixed reason. The answer carries `needs_approval` as a degraded code in the one state it names, and `compiler_fallback` when a precise fact was resolved with the bundled compiler.
