---
phase: 02-grammar-tier-store-and-stdio-host
plan: 06
subsystem: fact-store
tags: [sqlite, node-sqlite, better-sqlite3, overlays, provenance, wal, contract-suite, node-test]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-02 FileFacts extensions, validateFileFacts and Clock; 02-03 kit pragma allowlist (incremental_vacuum, page_count, page_size) and the fact-store lint boundary; 02-04 approved sqlite.busyTimeoutMs in 02-CONSTANTS.md"
provides:
  - "openFactStore(dir, deps, options): a real FactStore over the src/sqlite kit only, assignable to OpenStore, creating auto_vacuum INCREMENTAL stores and refusing newer ones with SchemaTooNew"
  - "Schema v1: meta, names, files, symbols, refs, imports, import_bindings, exports, overlays, overlay_files, keyed by integer file id, no column holds file bytes"
  - "Writer: commitFile (idempotent, validates, hash_mismatch, facts_too_large, null facts), link, setOverlay, dropOverlay, markStale, single in-process writer slot"
  - "Reader: find (exact, prefix, fuzzy), symbol, fileFacts, refs, callers (one hop), importers (direct) with full provenance and a per-call watermark"
  - "store.reconcile and store.status are real; collect, compact, check, maintain are idle placeholders until plan 02-18"
  - "defineFactStoreContract(label, driver): one 38-case conformance suite executed unchanged on node:sqlite and better-sqlite3"
affects: [02-11 resolution depth, 02-12 store lifecycle and lease, 02-15 indexer, 02-16 query, 02-18 maintenance, 02-19 impact]

actuals:
  tokens: 29300
  tasks: 3
  commits: 6
plan_head_before: db7daf512a3e741eb99d72902c73bc38582cecfa
plan_head_after: c9d9c430e924aa7995ccf038981acfef6b001e16

tech-stack:
  added: []
  patterns:
    - "One contract suite registered once per driver; every case drives the public FactStore interface and inspects rows only through a second read-only kit connection"
    - "Every read is one read transaction on the read-only connection, so the watermark and the data come from the same committed state"
    - "SQL statements are constant templates composed only of constant fragments; query text, names and paths are bound parameters"
    - "Files keyed by content hash: identical bytes at two paths or in two worktrees are one files row; the path in provenance comes from the overlay"

key-files:
  created:
    - src/fact-store/schema.ts
    - src/fact-store/open.ts
    - src/fact-store/store.ts
    - src/fact-store/writer.ts
    - src/fact-store/reader.ts
    - src/fact-store/parts.ts
    - src/fact-store/contract.ts
    - src/fact-store/store.test.ts
  modified:
    - src/fact-store/types.ts
    - src/fact-store/index.ts
    - src/fact-store/fact-store.test.ts

key-decisions:
  - "StoreOptions in types.ts carries every engine-independent option; the driver choice is on OpenFactStoreOptions in open.ts, because the Phase 1 guard (and the rewritten fact-store.test.ts) keep types.ts, errors.ts and index.ts free of engine vocabulary"
  - "overlays has a dropped flag instead of deleting the row, so a worktree's seq stays monotonic across drop and re-creation; reads and status treat a dropped overlay as unknown"
  - "A commit that resolves pending paths in other worktrees advances those worktrees' seq once, and markStale advances the seq of every worktree that gained a stale path, because their stalePaths changed"
  - "reconcile also lists paths whose hash matches but whose facts are still pending or stale, otherwise nothing would ever re-extract them"
  - "SymbolRecord.version is the file's content hash: with no source text stored there is no symbol-level hash"
  - "A read reports degraded: ['stale'] whenever its watermark has stalePaths (pending or stale files)"
  - "refs and callers match on the bare name of the symbol the identity names (Box.put matches sites named put), falling back to the identity's qualified name when the overlay lacks the symbol"
  - "Grammar-tier edges (refs, callers, importers) are INFERRED; definitions are EXTRACTED"
  - "prefix and fuzzy find default to 50 rows, exact is unbounded; every mode returns nothing for an empty query, fuzzy for under three characters"

patterns-established:
  - "RED commit carries a placeholder constructor and the new type declarations so the contract fails on assertions, not on a missing module"
  - "Debug handles are opaque strings per fact family: sym/, ref/ and imp/ followed by the percent-encoded path, content hash and ordinal"

requirements-completed: [STO-01, STO-02, STO-03, LNG-04]

coverage:
  - id: D1
    description: "openFactStore returns a real FactStore on both SQLite drivers through the kit only, with auto_vacuum INCREMENTAL, idempotent reopen and SchemaTooNew refusal"
    requirement: STO-01
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#fact store contract (node:sqlite) and (better-sqlite3): open, auto_vacuum, SchemaTooNew, idempotent reopen, WriterBusy, reader isolation"
        status: pass
    human_judgment: false
  - id: D2
    description: "commitFile is idempotent, rejects invalid, hash-mismatched and oversized facts with nothing written, and the watermark seq is monotonic and moves only on change"
    requirement: STO-02
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#unchanged, rejected, hash_mismatch, facts_too_large, seq is monotonic"
        status: pass
    human_judgment: false
  - id: D3
    description: "Overlays share facts by content hash across paths and worktrees, retire a file only when no overlay references it, track pending and stale paths, and survive drop and re-creation"
    requirement: STO-03
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#retire, identical content, link, setOverlay, dropOverlay, markStale, reconcile, status"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every record carries source_path, span, extractor, content_hash, first_seen, last_seen, confidence and an opaque debug handle; definitions EXTRACTED, grammar-tier edges INFERRED"
    requirement: LNG-04
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#commitFile stores one file and find returns the definition with full provenance, refs, callers, importers"
        status: pass
    human_judgment: false
  - id: D5
    description: "refs, callers (one hop), importers (direct) and prefix and fuzzy find as the simplest correct grammar-tier joins; query text is only ever a bound parameter"
    requirement: STO-03
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#refs, callers, importers, find in prefix mode, find in fuzzy mode, find bounds prefix and fuzzy results"
        status: pass
    human_judgment: false

duration: 22min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 06: Fact Store core Summary

**A real Fact Store over SQLite: integer-file-id schema, content-hash-shared overlays with safe retirement and a monotonic watermark, full-provenance reads (find in three modes, refs, callers, importers), and one conformance suite that runs unchanged on node:sqlite and better-sqlite3.**

## Performance

- **Duration:** about 22 min (first RED commit 15:02, last GREEN commit 15:13, local time, after about 10 min of reading)
- **Tasks:** 3 of 3, each as a RED test commit then a GREEN feature commit
- **Files:** 8 created, 3 modified (all under `src/fact-store/`); one more than `files_modified` (`parts.ts`)

## Accomplishments

- **Open and schema.** `openFactStore` makes the directory, opens a writable and a read-only kit connection on `<dir>/facts.db` (busy timeout `sqlite.busyTimeoutMs` = 5000, approved in 02-CONSTANTS.md, overridable with `busyTimeoutMs`), and on a new file sets `auto_vacuum` INCREMENTAL then runs one `VACUUM` once the file is in WAL, before the first table exists (a read of the pragma through the kit returns 2). An existing store is reused unchanged; a store whose `meta.schema_version` is higher throws `SchemaTooNew` carrying `meta.created_by`. Tables: `meta`, `names`, `files`, `symbols`, `refs`, `imports`, `import_bindings`, `exports`, `overlays`, `overlay_files`; fact tables are `WITHOUT ROWID` with composite keys, indexes on `symbols.name_id`, `refs.name_id`, `overlay_files.file_id` and `overlay_files.hash`. A test enumerates every column through `pragma_table_info` and fails on any column that could hold file contents.
- **Writer.** `commitFile` validates with `validateFileFacts`, rejects a `contentHash` that differs from the supplied hash (`hash_mismatch`) and more than 200,000 fact rows (`facts_too_large`) before touching the database, then in one transaction reuses, revives or inserts the `files` row, resolves every pending overlay path with that hash in all worktrees, remaps the path, retires the previous hash if nothing references it, and bumps seq once. `unchanged` and `rejected` never move seq. `link` attaches an existing hash to a path (`hash_unknown` for a hash with no facts). `setOverlay` diffs against the stored overlay in one transaction, records unknown hashes as pending, and bumps seq only if something changed. `dropOverlay`, `markStale` (also refreshes a stale file when the same hash is re-committed by a newer grammar) and a single writer slot (`WriterBusy`, safe double `release`).
- **Reader.** Every call runs in one read transaction on the read-only connection and returns `{data, watermark: {seq, stalePaths}, degraded?}`; `UnknownWorktree` and `StoreClosed` are the only throws. `find` orders by path, start line, start column, definition order; identities carry a discriminator only when overloads share a qualified name and kind; two symbols with identical spans are both returned. `fileFacts` rebuilds the stored facts exactly, including every optional field. `refs`/`callers` join `refs`, `overlay_files`, `files` and `names`; `importers` resolves relative specifiers in JavaScript.
- **Contract.** `defineFactStoreContract` registers 38 cases per driver (76 runs, plus 8 Phase 1 interface and error tests); `npm test` is 1210/1210.

## Task Commits

1. Task 1 (tracer): `d74edc5` test, `3378af3` feat - commit and find through both drivers
2. Task 2: `76d0532` test, `e182943` feat - overlays, link, retirement and watermark
3. Task 3: `7c7ea8a` test, `c9d9c43` feat - refs, callers, importers, prefix and fuzzy find

The tracer gate was satisfied by running the automated verify (both drivers, typecheck, lint) green before Task 2 started. RED evidence records for each task (`.planning/red-evidence-02-06-t{1,2,3}.json`, left untracked as instructed) were classified `RED_EVIDENCE_OK` by `gsd-tools check tdd-red-evidence`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `StoreOptions` split between `types.ts` and `open.ts`**
- **Found during:** Task 1
- **Issue:** The plan puts `StoreOptions.driver?: DriverName` in `types.ts`, but `DriverName` lives in the SQLite kit and the plan's own rewritten `fact-store.test.ts` requires that `open.ts` is the only file naming a driver option and that `types.ts` imports nothing from the kit.
- **Fix:** `StoreOptions` (repo, busyTimeoutMs, version, canCache, resolutionContext) is in `types.ts`; `OpenFactStoreOptions extends StoreOptions { driver? }` is in `open.ts`; `openFactStore`'s third parameter has the extended type and index.ts exports both.
- **Commit:** d74edc5, 3378af3

**2. [Rule 2 - Missing critical] Pending and stale paths are returned by `reconcile`**
- **Found during:** Task 2
- **Issue:** `reconcile` as specified compares hashes only. A path whose overlay hash equals the truth but whose facts are pending (`setOverlay` before extraction) or stale would never be reported, so nothing would extract it.
- **Fix:** Such paths are added to `reindex`; an overlay with no pending or stale paths and equal hashes still returns an empty list. Covered by a contract case.
- **Commit:** e182943

**3. [Rule 2 - Missing critical] `overlays.dropped` flag**
- **Found during:** Task 2
- **Issue:** Deleting the overlay row on `dropOverlay` would reset a worktree's seq on re-creation, breaking "seq is monotonic per worktree".
- **Fix:** `dropOverlay` sets `dropped = 1` and removes the overlay's files; reads, status and reconcile treat it as unknown; a later commit or `setOverlay` revives it with the old seq. One extra column beyond the artifact list.
- **Commit:** e182943

**4. [Rule 2 - Missing critical] seq advances for other worktrees affected by a commit or `markStale`**
- **Found during:** Task 2
- **Issue:** Resolving pending paths in other worktrees, or marking files stale, changes what those worktrees' answers report (stalePaths) without changing their seq.
- **Fix:** Each affected worktree's seq is bumped once. Covered by the pending and markStale cases.
- **Commit:** e182943

**5. [Rule 3 - Blocking] `parts.ts` added**
- **Found during:** Task 1
- **Issue:** Writer, reader and store share the connections, state and the read-transaction helper; putting them in `store.ts` would make a type cycle.
- **Fix:** Internal `src/fact-store/parts.ts` (`StoreParts`, `assertOpen`, `readTransaction`, `extractorOf`), not exported from `index.ts`.
- **Commit:** 3378af3, e182943

### Scope notes (not defects)

- The RED commit of Task 1 carries a placeholder `openFactStore` and the `SCHEMA_VERSION` and `STORE_FILE_NAME` constants so the suite compiles; tests that need the store file fail on a missing file there, the commit and reconcile cases on assertions. Task 2 and Task 3 RED evidence use a reconcile case and a prefix-find case, both of which fail on assertions.
- `RefRecord.kind` and `enclosing` are optional; `enclosing` is `null` for a top-level site and set for a contained one. `ImporterRecord` has no `tier` field (the interface in the plan lists none).
- `fileFacts` always returns an `exports` array (empty when none) and drops an empty `bindings` array; the other optional fields are present exactly when they were stored.
- `callers` ignores `options.hops` above 1 and `refs`/`callers` ignore `timeoutMs`: there is no resolver latency in a name join (plan 02-11).
- `canCache` and `resolutionContext` are accepted and stored on the store parts but read by nothing until plans 02-12 and 02-11.
- The only timeout-shaped value written is `sqlite.busyTimeoutMs` = 5000 (and its option key `busyTimeoutMs`), approved in 02-CONSTANTS.md; no guard fired.

## Notes for downstream plans

- **Facts are keyed by blob hash alone.** If the same bytes are indexed under two modules (for example a `.ts` and a `.tsx` path), the first committed facts win and the second path links to them. Plan 02-14/02-15 should not rely on per-path module differences for identical content.
- **Plan 02-18** replaces the idle `collect`, `compact`, `check` and `maintain`. Collected files keep their `files` row with `state = 'collected'` and no fact rows; `commitFile` already rewrites such a row and `link` already refuses it.
- **Plan 02-11** adds `resolution_contexts`, `resolved_edges` and `names_fts` to schema version 1 and deepens `refs`, `callers` and `importers` (scoping, ambiguity, multi-hop, index-file resolution) without signature changes. Fuzzy find here is `instr(lower(name), lower(?))` over the interned names joined to symbols; `lower()` is ASCII-only.
- **Plan 02-12** wires `degradedNow` (follower, rebuilding) and `canCache`. `openFactStore` does not take the first-time-init advisory lock or retry the WAL conversion (PITFALLS B4); that belongs to the lifecycle plan.
- `meta.created_by` defaults to `unknown` when no `version` option is passed; the host should pass its version.

## Known Stubs

- `collect`, `compact`, `check`, `maintain` in `src/fact-store/store.ts` return an empty successful result by design; plan 02-18 replaces them. Documented in the JSDoc of `createStore`. Recorded in the broken-windows ledger.

## Threat Flags

None. T-02-15 (prepared statements only; constant SQL; the pragma allowlist is the only pragma path; a contract case feeds SQL metacharacters to every find mode), T-02-16 (`hash_mismatch`), T-02-17 (`facts_too_large` at 200,000 rows) and T-02-18 (no text column, enforced by a schema-introspection case) are all mitigated and tested.

## Self-Check: PASSED

- Files present: `src/fact-store/schema.ts`, `open.ts`, `store.ts`, `writer.ts`, `reader.ts`, `parts.ts`, `contract.ts`, `store.test.ts`.
- Commits `d74edc5`, `3378af3`, `76d0532`, `e182943`, `7c7ea8a`, `c9d9c43` are ancestors of HEAD.
- `node --test src/fact-store/store.test.ts src/fact-store/fact-store.test.ts` 84/84, `npm test` 1210/1210, `npm run typecheck`, `npm run lint` and `npm run build` exit 0.
