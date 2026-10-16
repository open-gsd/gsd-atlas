# ADR: SQLite store, durability and size discipline

- **Status:** Accepted
- **Issue:** [#8](https://github.com/open-gsd/gsd-atlas/issues/8)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A3, A4, A13, A17, A18, A50
- **Review findings addressed:** ST‑1, ST‑2, ST‑3, ST‑4, E‑1

## Context
The store must answer in milliseconds, update per file save, survive crashes, stay small and never corrupt, on macOS, Linux and Windows. Other local tools have shown multi‑GB stores and frequent corruption (MemPalace keeps verbatim text in ChromaDB by default; Chroma's own maintenance guide describes index growth and fragmentation). The design review found that the benchmarks didn't cover fuzzy search or real reference distributions, and that refusing synced folders would strand common setups.

## Decision
1. **Engine:** SQLite through `node:sqlite`, WAL mode, `synchronous=NORMAL`, behind the Fact Store module ([7-fact-store-interface](7-fact-store-interface.md)), whose interface is fact‑level. The SQL driver is internal to it. `better-sqlite3` is kept working, not just listed, and one conformance suite runs against both drivers on every supported Node minor in CI.
2. **Runtime and platforms:** TypeScript, Node ≥ 24; macOS, Linux and Windows.
3. **Location:** per‑repo store in `$(git rev-parse --git-common-dir)/gsd-atlas/`. It moves automatically (one notice, never a refusal) to `${XDG_CACHE_HOME:-~/.cache}/gsd-atlas/<repo-id>` for non‑git roots, a read‑only `.git`, or a repo inside iCloud Drive, Dropbox, OneDrive, Google Drive or a network mount. `store.dir` overrides. Never committed.
4. **Derived, rebuildable:** source is the truth. A failed `quick_check` moves the file aside and rebuilds. A schema change rebuilds each repo lazily at low priority on first use, serving still‑valid facts marked stale meanwhile.
5. **Durability rules:** one writer per store; read‑only query connections; copies only via `VACUUM INTO` / backup API; one transaction per file's facts.
6. **Size rules:** no source text, no history, local facts deduped by content hash; resolved edges cached per overlay snapshot and dropped with it; `auto_vacuum=INCREMENTAL`; embeddings (post‑1.0) quantized, one per symbol.
7. **Fuzzy names** use FTS5 with the trigram tokenizer.
8. **Budgets are release gates** on real corpora (gsd‑core, gsd‑pi, gsd‑path) with real reference distributions, fuzzy search and the MCP SDK, on all three OSes (DESIGN.md *Performance & durability*).

## Evidence (2026‑10‑15, prototype)
- 1M‑LOC synthetic store (10,000 files, 300K symbols, 1.5M random references): 116 MB; full build 9.4 s; re‑index one file 11.8 ms; references lookup 0.7 ms; two‑hop callers 5 ms.
- Writer killed with SIGKILL mid‑write: `integrity_check` ok.
- `node:sqlite` supports FTS5 with the trigram tokenizer.
- sqlite‑vec 0.1.9 loads via `node:sqlite` on Node 22.13 and 24.22; Node 22.12 has no unflagged `node:sqlite`.

## Consequences
- Zero‑ops embedded store, no server to run.
- Writes serialize through one writer per store (host ADR handles throughput).
- Deep multi‑hop traversal over millions of edges would be slow; atlas queries are one or two hops. The Fact Store's fact‑level interface allows an engine swap if a budget is missed on a real corpus.
- Repos in synced folders work, with their store in the cache location.

## Alternatives considered
- **JSON file (gsd‑graph K4):** can't meet sub‑second incremental updates.
- **Graph database (LadybugDB/Kuzu fork):** a second native engine; recursive CTEs cover the needed queries.
- **better‑sqlite3 as primary:** native dependency; kept as tested fallback.
- **Refuse synced folders (earlier draft):** strands common setups.

## Amendment 2026-10-15: SQLite-access wording

Sources: ARCHITECTURE.md Gap 5 (FND-10); D-16 of the Phase 1 context.

Decision 1 says the SQL driver is internal to the Fact Store. It is internal to the `sqlite/` kit instead, which three store-owning modules share: the Fact Store, Metrics (its own `metrics.db`) and the SDK store (`sdk.db` and `pkg.db`). The kit holds both drivers, `node:sqlite` and `better-sqlite3`, behind one small interface and supplies the helpers `node:sqlite` lacks. One conformance suite runs against both drivers on every supported Node minor in CI. No other module imports `sqlite/`, and the boundary lint enforces that. The Fact Store's fact-level interface is unchanged, so the engine-swap escape hatch in the Consequences still holds.

## Amendment 2026-10-15: Node floor and open-time self-test

Sources: user decision of 2026-10-15; 01-RESEARCH.md Pitfall 2 and Open Question 1.

Decision 2 says Node 24 or later. The supported floor is Node 24.16.0, not 24.15.0. On 24.15.0 `node:sqlite` truncates TEXT at an embedded NUL (verified: all five bytes of a stored value are written, but a value with a NUL after its second character reads back as two characters), so source-derived text would be cut silently. Node 24.16.0 and Node 26 return the full value. Driver open therefore runs a NUL round-trip self-test and refuses a driver that fails it, reporting a diagnostic, whatever the Node version. CI lanes are Node 24.16.0 (the floor) and Node 26 latest on all three operating systems, and `engines.node` is `>=24.16.0`.

## Amendment 2026-10-16: Phase 2 store policy

Sources: FND-12; 02-CONTEXT.md D-13 to D-16; 02-RESEARCH.md Patterns 4 and 6.

Phase 2 builds the Fact Store, and these points follow from the code. The decisions above stand unedited.

1. **Pragma allowlist.** The driver kit's pragma allowlist gains `incremental_vacuum`, `wal_checkpoint`, `journal_size_limit`, `page_count` and `freelist_count`, with conformance cases on both drivers.
2. **Open-time self-test.** It also records `contentless_delete` support, next to the existing FTS5 trigram check, so maintenance knows which delete form the index supports.
3. **Auto-vacuum.** `auto_vacuum` is set to INCREMENTAL before the first table exists, as decision 6 requires; it cannot be set afterwards without a rebuild.
4. **Dirty sentinel.** A dirty marker is a sentinel file beside the database, set before a batch and cleared after its commit. It works when the database itself is unreadable, which is when it is needed (D-14).
5. **No fact-store migrations.** The fact-store schema version is checked at open. An older code with a newer store refuses with a clear message. A newer code with an older store drops and rebuilds it (D-15), as decision 4 allows. Forward-only migrations exist only for the Metrics database.
6. **Retired file versions** are collected once git holds the blob, or after a configurable 24 h grace (D-16).
