# ADR: Query and Policy modules

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-query-and-policy.md`)
- **DESIGN.md:** A11, A12, A26, A32, A33, A34, A35, A36, A37, A44, A51, A58
- **Refines:** [draft-mcp-contract](draft-mcp-contract.md), `AGENT-INTEGRATION.md`
- **Review findings addressed:** design-it-twice review, finding 1

## Context
Ranking, the token budget, citations, fencing, the watermark and `degraded` flag, `fresh` handling and `explain` are described in A26, A32, A44, A51 and the MCP-contract ADR, but no module owns them. MCP tools, the CLI and hooks are meant to return identical JSON (A12), so they are three adapters over one thing. Hook gating (A33–A37) is a second concern that was entangled with answering: it needs a memory of what each agent did, and a decision per event.

## Decision
### Query
1. **One module, Query,** with interface `ask(request) → Envelope`. A request names a tool kind (`code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status`, `lang_list`, `explain`, and the SDK tools later), a worktree, arguments, `budget_tokens` and optional `fresh` paths.
2. **It owns:** per-tool ranking, the token budget and `more` cursor, citations with `debug` handles, `untrusted_text` fencing and redaction (trust-boundaries ADR), the watermark and `degraded` flags (taken from the Fact Store's `Answer<T>`), and `explain`.
3. **MCP, CLI and hooks are adapters:** each translates its transport to a request and returns the envelope unchanged. CLI parity (A12) is structural, not a convention.
4. **`fresh` (A26):** Query calls `Indexer.ensureFresh(worktree, paths, waitMs)` before reading, then reads. A timeout is reported as `degraded: ['fresh_timeout']` with the old watermark.
5. **Query depends on** the Fact Store reader, the Indexer (`ensureFresh` only) and Source Tree for nothing; it never touches git or SQLite directly.

### Policy
6. **One module, Policy,** whose core is a pure function `decide(event, ledgerEntry, answer) → allow | deny | attach(text)`. It encodes the modes (`off`/`advise`/`enforce`/`strict`, per rule, A35) and the rules R1–R4 (AGENT-INTEGRATION).
7. **Policy owns the session ledger** (A37): per (session, agent) consulted symbols, edited files, findings and gate counters; in memory, bounded, expiring, never required for correctness.
8. **Policy never calls Query.** The hook adapter asks Query for the one cheap answer a rule needs and passes it to `decide`. Gates stay open whenever the answer is `degraded` or stale (A34), and every hook declares fail-open (A36).
9. **Overrides come only from the user** (A35, A44): the policy table is read from user-level config.

## Consequences
- A ranking or envelope fix lands once and shows up in MCP, CLI and hooks.
- Tests for answers and tests for enforcement are separate, and Policy tests need no host, store or git.
- The hook adapter has two calls per event (Query, then Policy). That is a small cost for keeping enforcement out of the answering path.
- Query gets the largest interface of the per-tenant modules (the whole tool set). The tool set is a request-kind union, so adding a tool adds a variant, not a method.

## Alternatives considered
- **Per-tool logic in each adapter:** three copies of ranking and fencing, and parity by convention.
- **Gate inside Query:** simple wiring, but enforcement and answering become entangled and Query tests need ledgers.
- **Policy calls Query itself:** one call for the adapter, but Policy becomes impure and hard to test without a store.

## Open questions
- Resolved in `AGENT-INTEGRATION.md`: the SessionStart brief (R0) is a Query request kind (`platform_card` + status + routing); Policy only decides whether to inject it.
- Should the ledger's eviction be an interface concern (a visible `evicted` flag) or hidden?
