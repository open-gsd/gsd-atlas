# ADR: Fact Store module and its interface

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-fact-store-interface.md`)
- **DESIGN.md:** A2, A3, A5, A17, A20, A21, A26, A45, A46
- **Edits in place (drafts):** [draft-sqlite-store](draft-sqlite-store.md) decision 1 and DESIGN.md A3 now point here instead of describing a SQL‑level "driver interface".
- **Refines:** [draft-worktree-lifecycle](draft-worktree-lifecycle.md), [draft-fact-model](draft-fact-model.md)

## Context
The store's behaviour is described across A2, A3, A5, A17, A20, A21, A26 and A45, and by the table list in DESIGN.md. No decision names the module, so each caller (indexer, MCP tools, hooks, daemon maintenance, `history`, CLI) would learn the schema and the lifecycle rules itself. A3's "driver interface" is a SQL-level seam: it would let callers write SQL, which makes the "swap the engine without touching modules, tools or the CLI" escape hatch false.

Four interfaces were designed independently (minimal, flexible, optimised for the most common caller, ports and adapters). They agreed on the seam: **fact-level, not SQL**. This ADR records the hybrid chosen.

## Decision
1. **One module, the Fact Store.** It owns local facts, resolved edges, overlays, symbol identity (A45), the live → retired → collected lifecycle, maintenance, staleness, schema-version refusal and watermarks. No other module reads or writes SQLite.
2. **The external seam is fact-level.** The SQL driver (`node:sqlite`, `better-sqlite3`) is an **internal seam**: two adapters, one conformance suite run against both in CI (A13). It is injectable for tests but is not part of the interface callers learn.
3. **Reads: `store.at(worktree) → Reader`.**
   - Cheap, lock-free, read-only connection.
   - Methods: `find(name, {mode, limit})`, `refs(id, opts)`, `callers(id, {hops})`, `symbol(id)`, `fileFacts(path)`.
   - Every method returns `Answer<T> = { data, watermark, degraded? }`, which is the MCP envelope's core (see draft-mcp-contract).
   - Reads report `stalePaths` in the watermark and never wait. Read‑your‑writes (A26) is `Indexer.ensureFresh`, called by Query before it reads ([draft-tenant-composition](draft-tenant-composition.md)).
   - Reads never throw for missing data; they return empty `data` with `degraded`. They throw only `UnknownWorktree` and `StoreClosed`.
4. **Resolution is hidden.**
   - `refs` and `callers` call the injected resolver lazily and cache by (overlay snapshot, resolution context hash).
   - Overlays with identical inputs share the cache (A5).
   - The answer says which tier produced each edge (precise, base-commit, or grammar), so A25's degradation surfaces as `degraded` without callers knowing about compiler pools.
   - A resolver failure yields `INFERRED` name-only edges and `degraded: ['resolver_failed']`, never an error.
   - The resolver reads symbols back through a read-only `SymbolLookup` view the store passes in, not through the store.
5. **Writes: one writer lease.** `store.writer()` throws `WriterBusy` if held.
   - `commitFile({worktree, path, hash, facts | null})`: one transaction that upserts facts by hash, remaps the overlay, retires the previous hash if unreferenced, assigns symbol identity (with `renamed_from`), invalidates only the affected resolved-edge slice and advances the watermark. `null` means the path was deleted. Idempotent on (worktree, path, hash). A fact without a `span` is rejected.
   - `setOverlay(worktree, ref, pathToHash)`, `dropOverlay(worktree)` and `markStale({module, grammarVersion})`.
   - A reader sees all or none of a file's facts. The watermark is monotonic per worktree and advances only after commit.
6. **Maintenance: typed methods, not a union.** `reconcile(truth)`, `collect({budgetMs})`, `compact({budgetMs})`, `check()`, each time-boxed, resumable and idempotent. `maintain(budgetMs)` is a thin wrapper for the daemon's idle loop and takes the writer lease itself. Every task stays a CLI command (A21). `status()` is its own method, not a read variant.
7. **Injected dependencies (`openStore(dir, deps)`):** `resolver`, `clock`, and `gitHas(hash) → Promise<boolean>` for A20's collection rule. Git gets no port: the rest of git (`ls-files`, blob ids) arrives as data from the Source Tree module. Each injected dependency has a production and a test adapter.
8. **No fake FactStore.** It would be a second adapter of the wrong seam and would drift from real semantics. Tests run real SQLite in a temp dir with a fake clock and fake `gitHas`, through the interface only.
9. **Closed fact vocabulary for now.** No predicate registry, generic `Match` or `Custom` queries. Hand-tuned indexes keep the A50 budgets guaranteed. Revisit when a second fact kind (for example SDK facts) needs the store, via an ADR amendment.
10. **Errors:** `SchemaTooNew` (names the host version needed, A46), `WriterBusy`, `UnknownWorktree`, `StoreClosed`. Corruption never escapes: a failed `quick_check` moves the file aside, rebuilds, serves stale-marked facts meanwhile and reports it in `status` (A17).

## Open questions
- Does `warm(worktree)` exist to pre-compute resolved edges? The first `refs` per snapshot pays resolver latency; the interface must document it either way.
- Is the first-call latency bound by `timeoutMs` with `degraded: ['resolver_timeout']`, or unbounded?
- Resolved: `reconcile(truth)` returns paths to re‑index; the Indexer consumes them, and Source Tree supplies the truth.

## Consequences
- Callers learn one small module. The schema, WAL rules, lifecycle, identity and cache keys have one place to change.
- The engine can change behind the seam, which makes the A3 escape hatch true.
- Tests are written at the interface and survive internal refactors. Old table-level tests become waste and are deleted.
- `Answer<T>` makes degradation and staleness part of every result, which supports the explainability goals (A51).
- Cost: `switchOverlay`-style methods are thin, and first-call resolver latency is visible to callers.

## Alternatives considered
- **SQL-level driver as the external seam (A3 as written):** every caller knows the schema and the one-transaction-per-file rule; nothing is hidden.
- **Two entry points, `read(q)` / `write(op)` over tagged unions:** maximal leverage per entry point, but becomes stringly typed; `maintain` bundles unrelated tasks and `status` blurs queries and health.
- **Predicate registry with generic queries:** extensible, but about twice the interface, loosely typed rows, and the 0.7 ms / 5 ms budgets hold only for built-in predicates. Conflicts with draft-fact-model's rule that new predicates need an ADR.
- **In-memory fake FactStore:** a second adapter of little value that drifts from real behaviour.
