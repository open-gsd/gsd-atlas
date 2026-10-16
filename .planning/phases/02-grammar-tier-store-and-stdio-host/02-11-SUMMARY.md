---
phase: 02-grammar-tier-store-and-stdio-host
plan: 11
subsystem: fact-store
tags: [sqlite, fts5, trigram, import-resolution, scoped-references, resolved-edge-cache, resolver, node-test]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-06 Fact Store core (overlays, Reader, Writer, contract suite, StoreOptions.canCache and resolutionContext); 02-04 approved constants (query.resolveTimeoutMs is the timeout the Query passes); 02-02 FileFacts extensions and the Resolver and SymbolLookup types"
provides:
  - "resolveSpecifier(importerPath, specifier, overlayPaths): the one language-neutral import rule (exact path, extension-stripped path, extension-stripped specifier, directory index file), pure, relative specifiers only"
  - "Reader.refs scoped by file, import binding and export alias; ambiguity returned as RefRecord.candidates on every alternative; all grammar edges INFERRED"
  - "Reader.callers walks transitively (hops clamped to 5, visited sets, ordered by hop, path, span); Reader.importers walks to depth 5 with EXTRACTED for a one-file specifier and INFERRED for several"
  - "Trigram fuzzy find: contentless FTS5 names_fts (detail full), filled once per interned name, quoted-phrase MATCH bound as a parameter, LIKE fallback, meta.fuzzy_path"
  - "Resolved-edge cache: resolution_contexts and resolved_edges keyed by overlay snapshot id (sha256 of sorted path and hash pairs) and resolution context; precise edges supersede grammar candidates; resolver_timeout, resolver_failed and cache_unavailable degradations"
affects: [02-12 lease wiring of canCache, 02-16 query, 02-18 maintenance, 02-19 impact, 02-28 host idle loop, phase 3 project model]

actuals:
  tokens: 37100
  tasks: 3
  commits: 6
plan_head_before: a1b5ca6e88b69795702c50e47789703d3c655747
plan_head_after: 3c981eb1b7f8a39b7523f1c99d7d7d635232928a

tech-stack:
  added: []
  patterns:
    - "Three-phase resolver reads: a synchronous grammar read inside one read transaction, an asynchronous resolver call outside any transaction bounded by the injected clock, then a pure merge of precise edges over the grammar result"
    - "Cache keys instead of invalidation: a content change or another resolution context is a different key and misses; superseded snapshots are pruned when a new one is written"
    - "Every ambiguity is returned, never resolved: a site that can reach several definitions is given to each, with the alternative count"

key-files:
  created:
    - src/fact-store/specifier.ts
    - src/fact-store/snapshot.ts
    - src/fact-store/resolve.ts
    - src/fact-store/cache.ts
    - src/fact-store/resolve.test.ts
  modified:
    - src/fact-store/reader.ts
    - src/fact-store/schema.ts
    - src/fact-store/writer.ts
    - src/fact-store/open.ts
    - src/fact-store/parts.ts
    - src/fact-store/types.ts
    - src/fact-store/contract.ts

key-decisions:
  - "A site's targets are the union of three scope rules; candidates is the size of that union and is set on RefRecord only when it exceeds one, so absent means unambiguous"
  - "Named and default bindings match non-member sites of their local name; a namespace or require binding matches member sites of the exported name; re-exports are not followed before Phase 3"
  - "A precise edge supersedes the grammar candidate at its site (tier precise, EXTRACTED, extractor precise:<resolver>); a precise edge to another symbol removes the site from this target; an unmentioned site keeps its grammar result"
  - "callers collects a grammar superset breadth-first, asks the resolver once for every call site, then walks only the edges precise results leave standing, so a caller reached only through a removed edge disappears with its own callers"
  - "A timed-out resolver is not abandoned: the run continues and fills the cache if canCache() is true, so the next call is a hit"
  - "names_fts is kept in step per session and meta.fuzzy_path records the last session that wrote; a session that uses the table after one that did not rebuilds it from names, so the index can never miss a name"
  - "Fuzzy find under three characters returns no rows (frozen interface doc and existing contract), not exact-and-prefix as one truth line reads"

patterns-established:
  - "Internal read primitives live in snapshot.ts (Snapshot, loaders, find); resolve.ts holds the pure grammar and resolver logic; reader.ts is glue; none of them is exported from index.ts"
  - "RED commits carry a placeholder module so the suite loads and the target test fails on an assertion; a placeholder must not make assert.notEqual fail, because its backtick message is rejected as malformed TAP"

requirements-completed: [STO-03, STO-04, LNG-03]

coverage:
  - id: D1
    description: "resolveSpecifier resolves only relative specifiers, by exact path, extension-stripped path, extension-stripped specifier and directory index, returns every match sorted, and nothing for packages, aliases or specifiers that escape the root"
    requirement: STO-03
    verification:
      - kind: unit
        ref: "src/fact-store/resolve.test.ts#resolveSpecifier"
        status: pass
    human_judgment: false
  - id: D2
    description: "Reader.refs returns only in-scope grammar sites (same file, import binding, export alias), INFERRED, with candidates on every alternative when a site is ambiguous"
    requirement: LNG-03
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#refs same file, refs import scope, refs export scope, refs ambiguity"
        status: pass
    human_judgment: false
  - id: D3
    description: "One file with one content hash resolves ./b to src/b.ts in one overlay and src/b/index.ts in the other, each branch seeing its own target, with no cache involved"
    requirement: STO-03
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#refs two branches"
        status: pass
    human_judgment: false
  - id: D4
    description: "callers walks transitively to the requested hops (clamped to 5) and importers walks to depth, with visited sets, ordering, limit and per-edge confidence"
    requirement: STO-03
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#callers hops, callers cycle, callers hops are ordered, importers depth (two cases)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Fuzzy find uses a contentless trigram FTS5 table filled once per interned name, treats FTS5 operators as data, falls back to the LIKE scan with the same rows, and repairs the table when the capability comes back"
    requirement: STO-03
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#find fuzzy uses the trigram table, find fuzzy treats FTS5 operators as data, find fuzzy capability"
        status: pass
    human_judgment: false
  - id: D6
    description: "Resolved edges are cached by overlay snapshot id and resolution context, supersede grammar candidates, share a slot across identical overlays, and degrade honestly on timeout, failure and a process that may not write the cache"
    requirement: STO-04
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#refs resolver, refs snapshot, refs context, refs resolver_timeout, refs resolver_failed, refs cache_unavailable, concurrency, callers resolver"
        status: pass
      - kind: unit
        ref: "src/fact-store/resolve.test.ts#overlaySnapshotId, contextKey"
        status: pass
    human_judgment: false
  - id: D7
    description: "No name-matched reference is ever EXTRACTED and no ambiguous site is silently assigned to one target (LNG-03 prohibition)"
    requirement: LNG-03
    verification:
      - kind: unit
        ref: "src/fact-store/store.test.ts#refs ambiguity, refs resolver"
        status: pass
    human_judgment: true
    rationale: "The plan marks this prohibition verification: judgment. Tests assert the visible half (INFERRED, candidates on every alternative, EXTRACTED only from the injected Resolver); that no other path ever picks a target quietly is a reading of the code that a reviewer should confirm"

duration: 18 min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 11: Resolution depth Summary

**Grammar-tier references scoped by file, import binding and export alias with ambiguity returned as candidates, transitive callers and importers, a trigram fuzzy-name index, and a resolved-edge cache keyed by overlay snapshot and resolution context that an injected Resolver can supersede, with timeout, failure and cache-unavailable degradations.**

## Performance

- **Duration:** 18 min (1,067 s from 2026-10-16T20:06:50Z to 20:24:37Z for the code; this file follows)
- **Tasks:** 3 of 3, each as a RED test commit then a GREEN feature commit
- **Files:** 5 created, 7 modified (all under `src/fact-store/`); three beyond `files_modified` (`snapshot.ts`, `parts.ts`, `open.ts`)
- **Tests:** `npm test` 1437/1437 (was 1392 before the plan); the fact-store contract now runs 63 cases per driver; `npm run typecheck`, `npm run lint` and `npm run build` exit 0

## Accomplishments

- **One specifier rule.** `resolveSpecifier` is a pure function over the overlay path set. It resolves relative specifiers with POSIX normalisation and matches four ways (exact path, extension-stripped overlay path, extension-stripped specifier when the tail looks like a 1 to 4 character extension, directory index file) and returns every match sorted. `./foo.cjs` names both `foo.cts` and `foo.cjs`; `./util/`, `.` and `..` name a directory index only; a specifier that climbs above the root names nothing (T-02-33). Lookup tables are built once per path set.
- **Scoped, honest references (D-06, LNG-03).** `refs` returns a site only when it is in the target's file, when its name is an import binding that resolves to the target's file and exported name, or when it uses an export alias of the target's own file. A site that can reach several definitions is given to each of them, and `candidates` carries the alternative count. Every grammar edge is INFERRED. The two-branch case passes: one `main.ts` hash in two overlays resolves `./b` to `src/b.ts` in one and `src/b/index.ts` in the other.
- **Transitive walks.** `callers` expands breadth-first to the requested hops (default 1, clamped to 5) with a visited set, each record carrying its own hop; a self call is a hop-1 caller and a cycle terminates. `importers` walks import statements to the requested depth through the specifier rule, EXTRACTED when the specifier matched one overlay path and INFERRED when it matched several (the importer then appears under each candidate). Both order by hop, path, position, and `limit` truncates after ordering.
- **Trigram fuzzy find.** A contentless `names_fts` table (`detail=full`, `tokenize='trigram'`, `contentless_delete=1` when the probe allows) is filled in the same transaction that interns a new name, so a name is indexed once. The query is one quoted FTS5 phrase with embedded quotes doubled and bound as a parameter (T-02-32; ten operator-shaped strings return nothing). With the capability off the bounded LIKE scan returns the same rows; `meta.fuzzy_path` records which path kept the table in step and a switch back rebuilds it.
- **Resolved-edge cache and the injected Resolver (STO-04).** `refs` and `callers` run in three phases. Within `timeoutMs` the precise edges supersede grammar candidates (tier precise, EXTRACTED, extractor `precise:<id>`); an edge to another symbol removes the site from this target; unmentioned sites keep their grammar result. Edges are cached under the overlay snapshot id and the resolution context, so two identical overlays share rows, another context gets its own, and a content change misses. Past the timeout the answer is grammar-only with `resolver_timeout` while the run finishes and fills the cache; a throwing resolver gives `resolver_failed`; a process that may not write the cache returns the edges with `cache_unavailable` and writes nothing. Edges for sites that were not asked about or targets the overlay does not hold are dropped (T-02-35).

## Task Commits

1. Task 1 (tracer): `983b8db` test, `d0e56de` feat - specifier rule and scoped references with candidates
2. Task 2: `c5e0c51` test, `921e1ff` feat - transitive callers and importers, trigram fuzzy find
3. Task 3: `752d4e9` test, `3c981eb` feat - resolved-edge cache and resolver degradations

**Plan metadata:** the SUMMARY commit and the state, roadmap and requirements commit follow this file.

The tracer gate: `HUMAN_VERIFY_MODE` is `end-of-phase`, the tracer's verify is automated only, and auto mode is off, so the verify (both drivers, typecheck, lint) was re-run green before Task 2 started: tracer verified end to end, expanding. RED evidence records (`.planning/red-evidence-02-11-t{1,2,3}.json`, left untracked as instructed) were each classified `RED_EVIDENCE_OK` by `gsd-tools check tdd-red-evidence`.

## Files Created/Modified

- `src/fact-store/specifier.ts` - `resolveSpecifier`, `isRelativeSpecifier`, `stem`
- `src/fact-store/snapshot.ts` - per-read Snapshot, row loaders (overlay view, import rows, exports), `readSnapshot`/`toAnswer`, `findRecords` with the trigram path
- `src/fact-store/resolve.ts` - `scopedRefs`, call and import walks, and the three-phase resolver integration (`prepareResolution`, `resolveSites`, `mergeRefs`, `mergeCaller`)
- `src/fact-store/cache.ts` - `overlaySnapshotId`, `contextKey`, `siteId`, `readEdges`, `writeEdges`, `liveSnapshotIds`, `pruneEdges`
- `src/fact-store/resolve.test.ts` - unit cases for the specifier rule, the snapshot id layout and the context key
- `src/fact-store/reader.ts` - glue: `refs`, `callers`, `importers` delegate to `resolve.ts`; `find`, `symbol`, `fileFacts` unchanged in behaviour
- `src/fact-store/schema.ts` - `names_fts`, `resolution_contexts`, `resolved_edges`, `meta.fuzzy_path`
- `src/fact-store/writer.ts` - a new interned name is inserted into `names_fts` in the same transaction
- `src/fact-store/open.ts`, `parts.ts` - the open-time capability probe feeds `FuzzyIndex`; `StoreParts` gains `fuzzyTrigram` and the per-seq snapshot id memo
- `src/fact-store/types.ts` - `RefRecord.candidates?`, `StoreOptions.trigram?` (test-only), updated `depth`, `hops` and `importers` documentation
- `src/fact-store/contract.ts` - 25 new cases per driver; the 02-06 name-join refs, callers and importers cases adapted to scoped semantics

## Decisions Made

See `key-decisions`. In short: `candidates` is set only above one; named bindings skip member sites and namespace bindings match only member sites; re-exports are not followed; precise results prune the caller walk; a timed-out resolver keeps running and fills the cache; the trigram table is rebuilt whenever a session that uses it follows one that did not.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `snapshot.ts` added**
- **Found during:** Task 1
- **Issue:** `reader.ts` delegates to `resolve.ts`, which needs the Snapshot, row loaders and `findSymbol` that lived in `reader.ts`; a direct import would be a cycle.
- **Fix:** Moved the shared per-read primitives (and `find`) to an internal `snapshot.ts`; `reader.ts` keeps `fileFacts` and the glue. Not exported from `index.ts`.
- **Files modified:** `src/fact-store/snapshot.ts`, `reader.ts`, `resolve.ts`
- **Commit:** d0e56de

**2. [Rule 2 - Missing critical] Fuzzy find keeps returning no rows under three characters**
- **Found during:** Task 2
- **Issue:** One truth line says a query of fewer than three characters is "answered by exact and prefix lookup only", while the frozen `FindOptions` documentation, the existing contract cases (`ab` and `ge` return nothing), the Task 2 behavior list (`find('on', fuzzy)` returns nothing) and plan 02-16 ("fuzzy only for names of three or more characters") all say no rows.
- **Fix:** Kept the frozen behaviour; the `auto` mode of plan 02-16 queries exact and prefix itself.
- **Commit:** 921e1ff

**3. [Rule 2 - Missing critical] `meta.fuzzy_path` and rebuild on a path switch**
- **Found during:** Task 2
- **Issue:** A store written by a session with the trigram capability off, then opened with it on (or the reverse), would leave `names_fts` missing names, so fuzzy find would silently miss rows.
- **Fix:** `meta.fuzzy_path` records the last session that kept the table in step; a session that uses the table after one that did not empties it (`delete-all`) and refills it from `names`. Covered by the capability case, which also tampers with the table to prove the trigram path drives the answer.
- **Commit:** 921e1ff

**4. [Rule 2 - Missing critical] Superseded snapshots are pruned on write**
- **Found during:** Task 3
- **Issue:** Every edit gives a new snapshot id, so rows of old snapshots would accumulate for the life of the store (plan 02-18's garbage collection does not name `resolved_edges`).
- **Fix:** A cache write skips an overlay state that is no longer live and deletes the rows of every snapshot no live overlay has; two overlays with identical contents keep one shared snapshot.
- **Commit:** 3c981eb

**5. [Rule 2 - Missing critical] Edges are validated on read as well as on write**
- **Found during:** Task 3
- **Issue:** T-02-35 names only returned edges; a cached row whose target the overlay does not hold would remove a real site from a target's refs.
- **Fix:** Cached edges are filtered to targets the overlay holds when read; a resolver edge is also dropped unless its site was one of the sites asked about.
- **Commit:** 3c981eb

**6. [Rule 1 - Behaviour change, documented] Old name-join expectations replaced**
- **Found during:** Tasks 1 and 2
- **Issue:** The 02-06 contract cases assumed every name-matching site belongs to every same-named definition, that `importers` ignores whether the target is in the overlay, and that all importer edges are INFERRED.
- **Fix:** Adapted to the new semantics: `loadB` now imports `load` from `./a` (and has no `load` of its own); importer confidence is EXTRACTED for one-file specifiers. An identity the overlay does not hold now has no refs (it used to fall back to name matching), and `importers('x.js')` no longer matches a lone `x.ts` unless the overlay holds that exact path or the extension-less form.
- **Commit:** 983b8db, c5e0c51

### Scope notes (not defects)

- **The resolver is asked again about a site that has no cached edge.** The plan says a resolver that yields nothing writes no cache rows, so there is no negative marker: a site the resolver cannot bind is re-asked on every call. With the scripted resolver and the no-op default this is free; a real precise resolver (Phase 3) will want an in-process or stored "asked" marker. Tests that count invocations bind every candidate site.
- **The resolver is only asked about grammar candidates.** A site the grammar tier scopes out (a path alias, a package, a barrel re-export) is never offered to the resolver, so a precise edge cannot add a site, only confirm or remove one. Phase 3's ProjectModel and a wider site request are the place to change this.
- **Re-exports (`export ... from`) are not followed** by the grammar tier; a binding that imports through a barrel file resolves to nothing, as the plan limits the rule to the target's own file.
- **`StoreOptions.trigram` can only switch the table off**; it can not force it on where the open-time probe found no FTS5 trigram support.
- **Wall-clock note:** `query.resolveTimeoutMs` (1500, approved) is the timeout Query passes as `ResolveOptions.timeoutMs`; the store has no default of its own, and the tests pass 50 on a fake clock. No constant was invented and no guard fired.

**Total deviations:** 6 auto-fixed (1 blocking, 4 missing critical, 1 documented behaviour change). **Impact on plan:** all necessary for correctness or to keep derived data bounded; no signature changed except additive optional fields.

## TDD Gate Compliance

All three tasks have a `test(02-11)` RED commit before their `feat(02-11)` GREEN commit (983b8db before d0e56de, c5e0c51 before 921e1ff, 752d4e9 before 3c981eb); there are no refactor commits. RED evidence, semantic assessment included:

- **Task 1:** target `fact store contract (node:sqlite) > refs same file ...` failed on a deep-equal that showed the unimported `src/c.cjs` record the name-only join returned; the `resolveSpecifier` placeholder returned `[]` so the unit cases failed on assertions. `RED_EVIDENCE_OK`.
- **Task 2:** target `... > callers hops ...` failed on the missing `[main, load, 2, 2]` hop-2 record. `RED_EVIDENCE_OK`.
- **Task 3:** target `... > refs resolver: a precise edge supersedes ...` failed because both sites stayed grammar INFERRED with candidates 2 (the resolver was never consulted). The first attempt was `INVALID_RED` (malformed TAP): the empty-string placeholder made a `notEqual` unit case print a backtick-quoted error the parser rejects. The placeholder was changed to a non-constant value, the run repeated, and the second record was `RED_EVIDENCE_OK` before the RED commit and before any production code.

## Issues Encountered

- The Memtrace-first read guard requires a `codegraph explore` naming a file in its own Bash call (piping to `/dev/null` or naming many files at once did not count) before a Read of an indexed source file; the CodeGraph index lags the worktree, so `codegraph node -f` reported some files as unindexed. Nothing was bypassed.
- No fix attempt limit was reached; every task's GREEN passed on its first full run.

## Known Stubs

None. The only placeholders (`specifier.ts` in the Task 1 RED commit, `cache.ts` in the Task 3 RED commit) were replaced by the matching GREEN commits.

## Threat Flags

None. T-02-32 (FTS5 injection: quoted, doubled and bound, ten operator strings tested), T-02-33 (the specifier rule never touches the file system; `..` past the root resolves to nothing), T-02-34 (visited sets, depth and hop clamp of 5) and T-02-35 (edges filtered to asked sites and overlay targets, on write and on read) are mitigated and tested.

## Next Phase Readiness

- **02-12:** wire `StoreOptions.canCache` to the writer lease; a follower then gets `cache_unavailable` with correct precise edges. `resolutionContext` is read per call, so a config change takes effect without a reopen.
- **02-16 / 02-19:** pass `ResolveOptions.timeoutMs` = `query.resolveTimeoutMs` (1500). `RefRecord.candidates` is present only when above one; `CallerRecord` and `RefRecord` carry `tier` and `confidence` for `chain_confidence`. `callers` and `importers` clamp hops and depth to 5.
- **02-18:** `names_fts` rows of collected names can be deleted when `StoreParts.fuzzyTrigram` is true and the store was created with `contentless_delete=1` (`Capabilities.contentlessDelete`); `FUZZY_PATH_META` is the consistency marker. `resolved_edges` rows of dropped overlays disappear on the next cache write.
- **Phase 3:** replace `resolveSpecifier` for aliases and packages, follow re-exports, add an asked-sites marker so unresolvable sites are not re-sent to a compiler, and consider offering the resolver sites the grammar tier scoped out.

## Self-Check: PASSED

- Files present: `src/fact-store/specifier.ts`, `snapshot.ts`, `resolve.ts`, `cache.ts`, `resolve.test.ts`, `reader.ts`, `schema.ts`, `writer.ts`, `open.ts`, `parts.ts`, `types.ts`, `contract.ts`.
- Commits `983b8db`, `d0e56de`, `c5e0c51`, `921e1ff`, `752d4e9`, `3c981eb` are on this branch (`git log a1b5ca6..HEAD`); measured commit count 6.
- `node --test src/fact-store/resolve.test.ts src/fact-store/store.test.ts` 146/146 with the interface test, `npm test` 1437/1437, `npm run typecheck`, `npm run lint` and `npm run build` exit 0.
