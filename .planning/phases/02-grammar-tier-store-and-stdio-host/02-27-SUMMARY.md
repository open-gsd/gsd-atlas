---
phase: 02-grammar-tier-store-and-stdio-host
plan: 27
subsystem: tenant
tags: [follower, overlay, fresh, read-your-writes, node-sqlite, query]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "plans 02-11 (resolveSpecifier, Reader records), 02-15 (module host, race handling), 02-19 and 02-20 (Query fresh port, Tenant follower branch), 02-28 (lease takeover)"
provides:
  - "createFollowerFresh: the fresh port of a process without the writer lease; parses fresh paths into a per-request in-memory overlay and never writes"
  - "createOverlayReader: a full Reader (find, symbol, fileFacts, refs, callers, importers) that merges a patch over the store's facts"
  - "candidatePaths(importerPath, specifier, extensions), exported with resolveSpecifier from the fact-store seam"
  - "Query picks exactly one Reader per request (FreshReport.reader, else store.at) and passes it to all four code tools"
affects: [02-29, phase-3-project-model, follower-semantics, mcp-host-tests]

plan_head_before: fbbcbd326f75c7b5916e0ba6ac490e84a974178f
plan_head_after: f218e436c53f1ce34e1b63e390f725abbe9b0973

actuals:
  tokens: 19470
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Per-request overlay Reader: merge a patch map (facts | null) over a base Reader, record shapes identical to the store's"
    - "Probe-the-store universe: generate candidate paths (candidatePaths), probe Reader.fileFacts, resolve with the pure rule over what exists"

key-files:
  created:
    - src/tenant/follower-overlay.ts
    - src/tenant/overlay.test.ts
  modified:
    - src/tenant/create.ts
    - src/tenant/index.ts
    - src/query/types.ts
    - src/query/query.ts
    - src/query/find.ts
    - src/query/refs.ts
    - src/query/context.ts
    - src/query/impact.ts
    - src/query/fresh.test.ts
    - src/fact-store/specifier.ts
    - src/fact-store/index.ts
    - src/fact-store/resolve.test.ts
    - src/fact-store/fact-store.test.ts
    - src/indexer/index.ts
    - src/host/host.test.ts

key-decisions:
  - "The overlay rides on the existing FreshReport (optional reader) instead of a new FreshOutcome type in types.ts, because query/find.ts already owns an internal FreshOutcome; FindContext gained a required reader chosen in one place (prepare in query.ts)"
  - "A path whose parse produces the same blob hash the store already holds gets no patch entry: the store is the authority, which makes the leader-already-indexed case identical by construction"
  - "A site in an unpatched file keeps the scoping the store computed against the store's version of a patched file; a patched file's sites never carry precise-tier edges (documented on createOverlayReader)"
  - "The depth clamp is a five-line local copy of the store's (MAX_WALK_DEPTH 5), proven equal by a chain test, rather than widening the frozen fact-store seam with two more exports"

patterns-established:
  - "Follower freshness: validate (isRepoRelative, realRoot, staysInside) -> hashPaths -> sourceSet -> readText with stat-before-and-after -> module host extract -> patch map -> overlay Reader; late finishers cannot touch a returned result (closed flag, frozen copy)"

requirements-completed: [STO-08, IDX-04]

duration: 27min
completed: 2026-10-17
status: complete
---

# Phase 2 Plan 27: Follower fresh overlay Summary

**A follower now answers `fresh` requests from a per-request in-memory overlay merged over the shared store (find, symbol, fileFacts, refs, callers, importers), with degraded `follower`, no store writes and nothing kept across requests.**

## Performance

- **Duration:** about 27 min
- **Tasks:** 2 of 2
- **Commits:** 2 task commits (plus this summary)
- **Files:** 2 created, 15 modified

## Accomplishments

- `createFollowerFresh` validates paths exactly like `Indexer.ensureFresh` (absolute, dot-dot, NUL, symlink escape land in `invalid` and are never read), hashes with `SourceTree.hashPaths`, filters with `sourceSet`, reads with the stat-before-and-after check (up to `maxRaceRetries` re-reads), extracts with the module host, and bounds the whole thing with the `waitMs` timer. A path that cannot be settled is reported in `stalePaths` with `complete: false`, and nothing it produced late can change the returned result.
- `createOverlayReader` implements the whole `Reader`: patched paths take the patch's facts (a deleted, binary or no-longer-source path hides the store's facts); `refs` drops the store's sites inside patched files and adds the patched files' in-scope sites using the store's own scoping rules (same file, export alias, import binding resolved to the target's file and exported name); `callers` and `importers` walk the merged refs and import statements breadth first with visited sets and the store's depth clamp. Every created record has the store's provenance shape (extractor string, blob hash, `first_seen`/`last_seen` from the Clock, `EXTRACTED` definitions and `INFERRED` references, debug handles in the store's `sym/`, `ref/`, `imp/` formats).
- `candidatePaths` generates the plausible targets of a relative specifier from the claimed extensions; resolving over the candidates that exist equals the rule over the full universe (property-style test).
- Query selects the Reader once per request and passes it to `code_find`, `code_refs`, `code_context` and `code_impact`; a spy test proves the store is never asked for a Reader on an overlay request.
- The Tenant chooses the fresh port per call: follower overlay while the lease is not held, the Indexer once it is (including after takeover). The follower module host is created lazily and disposed with the Tenant.
- Store untouched: the database, WAL and lease files keep identical sizes and modification times, and no sentinel appears, across a follower fresh request.

## Task Commits

1. **Task 1 (tracer): follower fresh overlay for find, symbol and fileFacts** - `53acb64`
2. **Task 2: merged refs, callers and importers in the follower overlay** - `f218e43`

## Verification

- `node --test "src/**/*.test.ts"`: 1891 tests, 0 failures.
- `npm run typecheck`, `npm run lint`, `npm run build`: exit 0 (the generated `dist/` was removed afterwards).
- Tracer gate (`type="tracer"`): the end-to-end follower scenario (leader builds, follower finds a definition added to an unindexed file, store untouched, nothing kept) was re-run green before Task 2 expanded.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in an existing test] Follower fresh expectation in the Host test**
- **Found during:** Task 1 verification
- **Issue:** `src/host/host.test.ts` asserted that a follower's fresh request degrades with `fresh_timeout` "until the overlay of plan 02-27". With the overlay that is no longer true.
- **Fix:** The test now asserts the follower completes fresh paths (no `fresh_timeout`, `follower` still present) and sees its own edit without the leader.
- **Files modified:** `src/host/host.test.ts` | **Commit:** `53acb64`

**2. [Rule 3 - Blocking] Seam export list test**
- **Found during:** Task 2 full-suite run
- **Issue:** `src/fact-store/fact-store.test.ts` pins the exact value exports of the fact-store index; exporting `candidatePaths` and `resolveSpecifier` (required by the plan) broke it.
- **Fix:** Updated the expected list and its title. | **Files modified:** `src/fact-store/fact-store.test.ts` | **Commit:** `f218e43`

**3. [Rule 3 - Blocking] Path rules exported from the Indexer seam**
- **Found during:** Task 1
- **Issue:** The boundary lint forbids importing `src/indexer/paths.ts` directly, and duplicating the security-sensitive validation would let the two copies drift.
- **Fix:** `src/indexer/index.ts` now also exports `isRepoRelative`, `realRoot` and `staysInside` (one line, not in the plan's `files_modified`). | **Commit:** `53acb64`

**4. [Naming] No new `FreshOutcome` type in `src/query/types.ts`**
- The plan names a `FreshOutcome` {complete, stalePaths, invalid, reader?} in types.ts. `query/find.ts` already exports an internal `FreshOutcome` (degraded, diagnostics, stalePaths), so the optional `reader` went onto the existing port type `FreshReport` and onto the internal `FreshOutcome`; `FindContext.reader` carries the chosen Reader. Behaviour and the key link (`query.ts` -> `reader`) are as planned.

**Process note:** tests and implementation were written in the same pass for both tasks rather than strictly red-first; the tests were run against the finished code and the tracer/merge cases were checked for being discriminating (for example the callers case asserts the store alone returns no caller).

## Known Limits (not stubs)

- Git ignore rules are not applied to a path named in `fresh` (the Indexer's `PathFilter` is not exported and the plan's `FollowerFreshDeps` has no filter). The named file is parsed into that request's overlay only; nothing is stored. Generated, vendored, binary and LFS files are still excluded through `sourceSet`.
- No Governor slot is taken by the follower port itself; the request is already inside the Host's interactive job, and the per-file byte cap and the `waitMs` bound apply (T-02-87).
- A definition that exists only in a patched file has no references from unpatched files (they cannot coherently exist); sites in unpatched files that reach a patched file keep the store's scoping.

## Threat Surface

No new surface beyond the plan's threat model. T-02-84 (path validation, tested for absolute, dot-dot, NUL and symlink escape), T-02-85 (no Writer, no database handle; `follower-overlay.ts` takes `Pick<FactStore, 'at'>`; store-untouched test), T-02-86 (overlay built per request and dropped; next-request test), T-02-87 (byte cap, wait bound) are all covered by tests.

## Self-Check: PASSED

- FOUND: src/tenant/follower-overlay.ts, src/tenant/overlay.test.ts
- FOUND commits 53acb64 and f218e43 on this branch
