# ADR: Fact Store module and its interface

- **Status:** Accepted
- **Issue:** [#7](https://github.com/open-gsd/gsd-atlas/issues/7)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A2, A3, A5, A17, A20, A21, A26, A45, A46
- **Edits in place (drafts):** [8-sqlite-store](8-sqlite-store.md) decision 1 and DESIGN.md A3 now point here instead of describing a SQL‑level "driver interface".
- **Refines:** [11-worktree-lifecycle](11-worktree-lifecycle.md), [6-fact-model](6-fact-model.md)

> Ratification note: ratified together on 2026-10-18 with every other record in this folder (see docs/adr/README.md).

## Context
The store's behaviour is described across A2, A3, A5, A17, A20, A21, A26 and A45, and by the table list in DESIGN.md. No decision names the module, so each caller (indexer, MCP tools, hooks, daemon maintenance, `history`, CLI) would learn the schema and the lifecycle rules itself. A3's "driver interface" is a SQL-level seam: it would let callers write SQL, which makes the "swap the engine without touching modules, tools or the CLI" escape hatch false.

Four interfaces were designed independently (minimal, flexible, optimised for the most common caller, ports and adapters). They agreed on the seam: **fact-level, not SQL**. This ADR records the hybrid chosen.

## Decision
1. **One module, the Fact Store.** It owns local facts, resolved edges, overlays, symbol identity (A45), the live → retired → collected lifecycle, maintenance, staleness, schema-version refusal and watermarks. No other module reads or writes SQLite.
2. **The external seam is fact-level.** The SQL driver (`node:sqlite`, `better-sqlite3`) is an **internal seam**: two adapters, one conformance suite run against both in CI (A13). It is injectable for tests but is not part of the interface callers learn.
3. **Reads: `store.at(worktree) → Reader`.**
   - Cheap, lock-free, read-only connection.
   - Methods: `find(name, {mode, limit})`, `refs(id, opts)`, `callers(id, {hops})`, `symbol(id)`, `fileFacts(path)`.
   - Every method returns `Answer<T> = { data, watermark, degraded? }`, which is the MCP envelope's core (see 13-mcp-contract).
   - Reads report `stalePaths` in the watermark and never wait. Read‑your‑writes (A26) is `Indexer.ensureFresh`, called by Query before it reads ([9-tenant-composition](9-tenant-composition.md)).
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
- **Predicate registry with generic queries:** extensible, but about twice the interface, loosely typed rows, and the 0.7 ms / 5 ms budgets hold only for built-in predicates. Conflicts with 6-fact-model's rule that new predicates need an ADR.
- **In-memory fake FactStore:** a second adapter of little value that drifts from real behaviour.

## Amendment 2026-10-15: Read-triggered cache write and SQLite-access wording

Sources: ARCHITECTURE.md Gaps 2 and 5 (FND-10); D-16 of the Phase 1 context.

Two statements in the decision above are tightened. Neither changes the fact-level seam.

1. **Read-triggered cache fills (decision 4 against decisions 3 and 5).** Decision 3 makes a Reader read-only, yet decision 4 has `refs` and `callers` fill the resolved-edge cache lazily, which is a write. The fill is performed by the writer-lease holder through a store-internal queue on its writer connection, so a Reader never writes. A Reader in a process that does not hold the lease computes the edges, returns them uncached and adds `degraded: ['cache_unavailable']` to the answer. The queue is internal: callers see neither it nor the lease. Phase 2's grammar-tier name resolution is a read-time join over local facts and needs no cache write.
2. **SQLite access (decision 1).** The sentence "No other module reads or writes SQLite" is about fact tables. The `sqlite/` driver kit (both drivers behind one small interface, and the conformance suite) is internal infrastructure shared by exactly three store-owning modules: the Fact Store, Metrics with its own `metrics.db`, and the SDK store with `sdk.db` and `pkg.db`. No other module imports it, and the boundary lint enforces that (D-12).

## Amendment 2026-10-15: Open questions resolved

Sources: D-17 of the Phase 1 context; ARCHITECTURE.md Open Questions Q1 and Q2.

The two open questions above are answered here. The original bullets stand unedited as the record of what was asked.

- *Does `warm(worktree)` exist to pre-compute resolved edges?* No. The interface has no warm(worktree). Cache warming is an internal maintenance-class task of the writer-lease holder, run after the Indexer settles, and callers never request it.
- *Is the first-call latency bound by `timeoutMs` with `degraded: ['resolver_timeout']`, or unbounded?* Bounded. `refs` and `callers` accept a `timeoutMs` option. On overrun they return the grammar-tier `INFERRED` edges with `degraded: ['resolver_timeout']`, while the computation continues and later fills the cache. The interface documents this cost: the first `refs` or `callers` per snapshot can pay resolver latency up to `timeoutMs`.

## Amendment 2026-10-17: Maintenance options and lease holder

Sources: FND-12; 02-VERIFICATION criterion 4 (STO-05); 02-REVIEW WR-02, WR-03 and WR-05; plans 02-30 and 02-31.

Gap closure added an option to the maintenance wrapper and one diagnostic field to the status. Neither changes the fact-level seam. The decisions above stand unedited.

1. **`maintain(budgetMs, options?)` (refines decision 6).** The wrapper takes an optional `StoreMaintainOptions { full?: boolean }`. The package exports a frozen `IDLE_MAINTENANCE` (`{ full: true }`), the one idle policy shared by the Tenant's idle loop and the size gate. With `full: true` the compact step may run a full VACUUM, but only after a collect that completed and only past the thresholds recorded in [11-worktree-lifecycle](11-worktree-lifecycle.md), Amendment 2026-10-17. Without options the call behaves as before. An invalid `budgetMs` is a `RangeError`. The typed methods `reconcile`, `collect`, `compact` and `check` keep their signatures; `compact({ full: true })` follows the free-page rule only.
2. **`StoreStatus.leaseHolder` (additive, refines decision 6, `status()`).** `{ pid, startedAt, version }` of the process that holds the writer lease: the store's own when it leads, the one read from `lease.json` when it follows, and absent when the leader has released the lease or the store was opened with no lease. It is a diagnostic for messages only. Ownership is still decided solely by the lock on `lease.db` (amendment 2026-10-16 of the worktree-lifecycle ADR).
3. **Errors (refines decision 10).** The list of structural errors does not change. A store whose database connections could not be replaced during a takeover recovery or a `check` rebuild is closed, releases its lease and raises the existing `StoreClosed` afterwards, so it never serves on connections it cannot use. No new error class exists.

## Amendment 2026-10-18: Phase 3 interface additions

Sources: 03-RESEARCH.md Seam Gaps G1 to G8 and Pitfalls 2, 6, 7 and 11; 03-DECISIONS.md OQ1 (confirmed); [6-fact-model](6-fact-model.md), [13-mcp-contract](13-mcp-contract.md) and [5-language-modules](5-language-modules.md), amendments of the same date.

The compiler-precise tier needs the injected resolver to know more than a Phase 2 resolver was given, and the new fact kinds need reads. Every change below is additive: a Phase 2 resolver, a Phase 2 caller and a test double that ignore the additions keep working. The fact-level seam, the single writer lease and the decisions above stand unedited.

1. **Resolver port scope (decision 7, G1).** The injected resolver receives, after the sites, the resolution context and the symbol view, a fourth optional argument, the scope: the worktree, the overlay (its snapshot id and its path-to-hash map) and the project context of point 6. The store already holds all of it when it asks. One adapter turns a `PreciseResolver` into the port, so adapters implement the module-level interface and the store depends only on the port.
2. **`PreciseResolver.resolve` takes an optional fourth argument `symbols: SymbolLookup`.** A precise resolver speaks in compiler declarations; the store accepts an edge only when its target equals a grammar symbol's identity (decision 6 of the fact model). The view lets the resolver map a declaration to the grammar symbol that contains it, and a resolver that omits the argument works as before.
3. **`SymbolLookup.findIn(path, name)` (G2).** It returns every grammar symbol of that name defined in that overlay path, as identity plus span. It answers from the overlay being resolved, returns an empty list for a path the overlay does not hold or a name the file does not define, and never throws for missing data. `find(name)` is unchanged.
4. **Optional `PreciseResolver.relations` and new reads (G3, G7).** Symbol-to-symbol relations travel through an optional `relations` method (OQ1) and are read through `Reader.relations(id, options)`, filtered by direction, bounded by a limit and by `timeoutMs`, with the degraded codes that `refs` already uses. Three more reads are added, each returning `Answer<T>`: `Reader.provenance(handle)`, which explains one fact from a citation's `debug` handle for `code_explain` and is the only reader of handles; `Reader.emittedAs(path)`, the emit outputs of a source path; and `Reader.citations(query)`, the ADR citations of a number or attached to a symbol, ordered by path, line and column with provenance. They never throw for missing data. Handles are opaque outside the store, and one that is malformed or names a file version the overlay no longer holds yields an empty answer, not an error.
5. **`FactStore.resolve(worktree, options)` (research Pattern 10).** A fifth typed maintenance method beside `reconcile`, `collect`, `compact` and `check` (decision 6): time-boxed, resumable and idempotent, taking `budgetMs` like the others and the writer lease like them. It asks the resolver for every reference site of the overlay's files, in path order and in batches, and fills the resolved-edge cache and the negative markers eagerly. It keeps a persisted cursor so a call that ran out of budget resumes where it stopped, and a second call over a settled overlay asks nothing. It is the work behind the existing `resolve` task name of `maintain`. This does not reintroduce `warm(worktree)`: callers still cannot request a warm cache from a read, and the answer of amendment 2026-10-15 stands.
6. **Per-overlay resolution context (G4, Pitfall 7).** The resolution context is no longer one global function. A `ProjectContext` port, supplied to the store as an asynchronous provider, returns the context for one overlay: the context id and config hashes (including the compiler identity), the emit lookup used by the specifier rule and by `emittedAs`, and the precise-tier facts a resolver needs (which owner configuration covers each file, the compiler choice and the config list). The provider is computed before the read transaction for the overlay snapshot the read will use, memoised per worktree and snapshot, and recomputed once if the snapshot moved. A cached edge is valid only under the context it was computed in. The default provider returns the Phase 2 context (id `grammar`, no config hashes), so a store given no provider behaves as before.
7. **Resolver notices and typed failures.** The iterable a resolver returns may yield, besides edges, a notice that carries a degraded code, which adds the code to the answer without failing the read (for example `compiler_fallback`, once per answer). A resolver may also fail with an error that carries a `degradedCode` (for example `memory_budget`); the store answers from grammar facts with that code in place of `resolver_failed`. A code the store does not know falls back to `resolver_failed`. Decision 4's rule that a resolver failure never becomes an error is unchanged.
8. **Negative markers and relation markers.** The store records "asked, no edge" per site and "asked" per file for relations, as derived data under the fact-model amendment of the same date. Both are discarded with the snapshot or when the context changes.
9. **`SourceTree.listDirectory` (G6 and ADR citations).** Source Tree gains a confined directory listing used to find the ADR directory's files: regular files only, no links followed, a bounded number of names, unsafe names skipped. File contents are never read through it. It is a Source Tree method, not a store method.
10. **Schema version bump (G8, Pitfall 11).** Stored local facts change shape (citations) and derived tables are added, so the store's schema version moves from 1 to 2 in this phase. A store written by the Phase 2 build is derived data: this build does not open it for reading. Every repo-scoped request other than `build` answers `not_indexed` and names `gsd-atlas build`, which recreates the store ([13-mcp-contract](13-mcp-contract.md), amendment 2026-10-17). A Phase 2 development store therefore needs one rebuild; nothing is migrated and no data is lost that source and git cannot restore. `SchemaTooNew` for a newer store is unchanged.
