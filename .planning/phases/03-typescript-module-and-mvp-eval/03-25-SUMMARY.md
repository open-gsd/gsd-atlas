---
phase: 03-typescript-module-and-mvp-eval
plan: 25
subsystem: precise-relations
tags: [extends, implements, overrides, relations, resolved-relations, reader-relations, code-refs, code-impact, code-context, oracle-cross-check, tdd]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-23 TypeScript worker, client, identity mapping and the notice/typed-failure channel; 03-20 resolver seam (scope, findIn, per-overlay context, markers); 03-24 schema version 2 and scripts/adr-citations-check.ts (the script shape); 03-16 frozen Stage A (D-08 precondition, verify-prereg ok); 03-08 ADR 6, 7 and 13 amendments for relations and `edge`"
provides:
  - "kernel: RelationKind, RELATION_KINDS, isRelationKind, ResolvedRelation, RelationsPort, and an optional `relations` property on NoticingResolverPort"
  - "PreciseResolver.relations? (optional), asStoreResolver attaches `relations` to the port only when the resolver has it, the scripted resolver can script relations"
  - "store: resolved_relations and relations_asked derived tables (IF NOT EXISTS, schema version stays 2), Reader.relations(id, {direction, timeoutMs, limit}) with RelationRecord"
  - "worker: `relations` request and `relation` response, collectRelations over the checker (src/precise-resolver/typescript/relations.ts), client.relationsScoped and relationStats"
  - "query: Edge type and an `edge` field on precise code_refs and code_context reference items; ImpactVia gains extends, implements, overrides; code_context data.supertypes and data.subtypes"
  - "scripts/relations-check.ts: stored extends and implements versus the oracle's heritage key on a prepared checkout"
affects: [03-26, 03-27, 03-28, 03-29, 03-31]
tech-stack:
  added: []
  patterns:
    - "A relation is a symbol-to-symbol fact with no site: it travels through an optional method on the resolver, is cached under the same (snapshot, context) key as an edge and is settled per declaring file"
    - "The compiler decides, the grammar tier only chooses which files to ask: candidate files over-approximate, a wrong candidate costs one file and never a relation"
    - "A label comes only from a compiler relation: a heritage site that no relation names keeps the grammar tier and carries no `edge`"
key-files:
  created:
    - src/precise-resolver/typescript/relations.ts
    - scripts/relations-check.ts
    - scripts/relations-check.test.ts
  modified:
    - src/facts/resolution.ts
    - src/facts/index.ts
    - src/precise-resolver/index.ts
    - src/precise-resolver/store-adapter.ts
    - src/precise-resolver/stub.ts
    - src/precise-resolver/typescript/protocol.ts
    - src/precise-resolver/typescript/worker.ts
    - src/precise-resolver/typescript/client.ts
    - src/precise-resolver/typescript/tier.ts
    - src/precise-resolver/typescript/index.ts
    - src/fact-store/schema.ts
    - src/fact-store/cache.ts
    - src/fact-store/resolve.ts
    - src/fact-store/reader.ts
    - src/fact-store/types.ts
    - src/fact-store/index.ts
    - src/query/types.ts
    - src/query/index.ts
    - src/query/refs.ts
    - src/query/ranking.ts
    - src/query/impact.ts
    - src/query/context.ts
    - src/tenant/follower-overlay.ts
    - docs/reference/mcp.md
    - src/fact-store/resolve.test.ts
    - src/fact-store/fact-store.test.ts
    - src/precise-resolver/precise-resolver.test.ts
    - src/precise-resolver/typescript/resolver.test.ts
    - src/query/fixtures.test.ts
    - src/query/fresh.test.ts
    - src/query/refs.test.ts
    - src/query/impact.test.ts
    - src/query/context.test.ts
    - scripts/emit-e2e.test.ts
key-decisions:
  - "A class-or-interface target's subtypes are looked for in the files with a heritage reference to it, in any reference that sits directly in a class or interface (extends Mixin(Base)), and in the files that import its file and declare a class or interface (extends ns.Base). The grammar tier tags only plain identifiers in heritage clauses, so the first rule alone missed a namespace-qualified base on gsd-core (found by relations-check). A member's overriders are looked for through its container's subtypes, followed down MAX_WALK_DEPTH levels."
  - "Reader.relations direction: `in` is the relations that end at the symbol; `out` is the ones that start at it plus, for a class or an interface, the `overrides` that start at one of its members (so Sub out lists `extends Base` and its two overrides, as the plan's behaviour says); `both` is the two together. The default is both."
  - "Relation records are cited at the subtype: source_path and span are the definition of `from`, confidence EXTRACTED, extractor precise:<resolver>, debug handle rel/<relation>/<from path>/<from hash>/<from ord>/<to path>/<to ord> (plan 03-26 parses it; the shape extends its planned {kind, path, hash, ord, relation} with the target's path and ord so two relations of one class stay distinct)."
  - "code_refs labels: a precise reference is `calls` when its kind is call and `references` otherwise; a heritage site that a relation names becomes a precise EXTRACTED item with that relation (whatever tier the site came from); an unmatched extends or implements relation and every overrides relation are added as items cited at the subtype or overriding member. A grammar-tier item has no `edge` key."
  - "ImpactVia order keeps Phase 2's import, call, reference and appends extends, implements, overrides. The plan's sentence lists import last; moving it would change Phase 2's order of import and reference file items, which the plan also forbids ('Phase 2 golden unchanged')."
  - "code_context relations are paged entries of two new sections (supertype, subtype, placed after child) but are rendered under data.supertypes and data.subtypes, only when non-empty, so budget, limit and cursor apply to them exactly like to every other entry."
  - "No new numeric constant: files per relations message reuse precise.sitesPerRequest, a response budget per relations request reuses precise.maxLineBytes (total bytes of relation lines), declarations per heritage type reuse the worker's MAX_TARGETS (64), the impact read limit is impactRowCapPerHop times the existing candidate factor 4, the context limit is query maxLimit."
requirements-completed: [TSM-01]
status: complete
commits: 8
plan_head_before: 12da05d8bdbfa80489b8f967b1442c2006669676
plan_head_after: 89828580076cdf56495e6202280fa086c6911ff4
actuals:
  tokens: 55400
  tasks: 3
  commits: 8
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 25: extends, implements and overrides from the compiler Summary

**The compiler's `extends`, `implements` and `overrides` relations now flow from the real TypeScript worker through an optional resolver method, two derived tables and `Reader.relations` into `code_refs` (heritage sites labelled, overriding members listed), `code_impact` (new hops) and `code_context` (supertypes and subtypes); on the pinned gsd-core the stored subtypes agree with the independent oracle on all 22 pairs, with no store-only and no oracle-only difference.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 | Tracer: a subclass is an extends item of its base class and an overriding method an overrides item, through the real worker and Host | a6f66a0 | 4664ee2 |
| 2 | code_impact and code_context follow and show relations, with ranking, generics and chains | 25d2108 | c989431 |
| 3 | Relations checked against the oracle on the pinned gsd-core | 85a544c | 7f05351 |
| - | Untrusted-worker hardening cases for relations; emit-e2e comparisons asked again when the compiler was late | - | 78e4209, 8982858 |

The tracer feedback gate (no `gate="blocking-human"` on the task, `<verify>` automated only): the verify command was re-run end to end after Task 1 and passed (197 tests, typecheck, lint), so the plan expanded.

## What was built

- **Kernel and seam.** `PreciseResolver.relations?(overlay, context, files, symbols?)` yields the relations whose `from` symbol is declared in one of `files`. `asStoreResolver` returns a port that carries `relations` only when the resolver defines it, so every Phase 2 resolver, test double and the scripted resolver without the option is unchanged (a store given one answers `Reader.relations` with empty data and no degraded code). The TypeScript tier's port always carries it, so tier-state codes (`precise_unavailable` while the provider is off, `compiler_fallback`) are derived for relations as for edges.
- **Store.** `resolved_relations` (snapshot, context, both endpoints, relation, resolver) and `relations_asked` (snapshot, context, file) are `IF NOT EXISTS`, pruned with the other derived tables when a snapshot is no longer live; `SCHEMA_VERSION` stays 2. `Reader.relations` runs the three phases of `refs`: plan and cache read in one transaction (`readResolving` now hands the project context to its read callback), the resolver outside any transaction within `timeoutMs` (the run carries on in the background past a timeout and fills the cache), and the records built from validated rows in a last short read. Validation drops a relation that is not shaped like one, whose `from` is not in a file that was asked, whose endpoints the overlay does not hold, that relates a symbol to itself or that repeats. A completed call writes the rows and the per-file markers; a timeout or a failure settles nothing.
- **Worker.** `relations` request (config, files) and `relation` response (both endpoints as the declaration's name token plus its kind). `collectRelations` asks the checker for the type each heritage clause names (so aliases, `Base<T>`, `implements I<string>` and a mixin that returns a class resolve to the declared types, and an `any` base gives nothing), and for every named, non-static instance member of a class finds the nearest base-class declaration with `getPropertyOfType` (so `C extends B extends A` with `m` only in `A` and `C` gives `C.m overrides A.m`, abstract members included, an interface member never). Ends in a library, under `node_modules` or outside the worktree are dropped in the worker. `relations.ts` takes the loaded compiler API from `worker.ts` and derives its types from it, so only the worker file loads the compiler.
- **Client.** Files are grouped by owner config, chunked by `precise.sitesPerRequest`, and the response is bounded: more bytes of relation lines than `precise.maxLineBytes` in one request, or an item of the other kind, stops the worker (`resolver_failed`). Both ends of a relation map to exactly one grammar symbol through `mapTarget` or the relation is dropped and counted (`relationStats()`: files asked and answered, kept, dropped).
- **Query.** `code_refs` and `code_context` references carry `edge` on precise items (`calls`, `references`, `extends`, `implements`, `overrides`) and none on grammar items; `code_impact` follows relations as hops ranked after `reference`; `code_context` gains `supertypes` and `subtypes`. The follower overlay Reader passes the store's relations through minus the ones that touch a patched file.
- **Docs.** `docs/reference/mcp.md` describes `edge`, the three new `via` values and the two lists. ADR 6, 7 and 13 already carried the amendments of plan 03-08; no ADR was edited.

## Verification

`npm run typecheck`, `npm run lint`, `npm run build`, `npm run schema:check` clean. `npm test`: 3,998 tests, 3,996 pass, 0 fail, 2 skipped (both pre-existing), against 3,929 test cases on the base commit (69 new ones, counting a store case once per SQLite driver). `node scripts/eval/verify-prereg.ts`: ok, and no Stage A file, ADR, ROADMAP, STATE or REQUIREMENTS file was touched. The built worker (`dist/precise-resolver/typescript/relations.js`) exists next to `worker.js`.

### Relations against the oracle on the pinned gsd-core (`10ac3a7`, prepared per OQ8, macOS arm64, Node 26.11.1)

`node scripts/relations-check.ts --dir <prepared copy> --tsconfig tsconfig.json`, exit 0:

| | count |
|---|---|
| census: classes and interfaces of the repository with at least one subtype (the oracle's) | 16 |
| agree (subtype file and name pairs) | 22 |
| store_only | 0 |
| oracle_only | 0 |
| library bases (not stored, listed apart): `Error` 16, `TypeError` 3, `Record` 1 | 20 subtypes |

The first run had `agree 21`, `store_only 0`, `oracle_only 1`: `interface ManifestSection extends sectionManifest.SelectableSection` in `src/init.cts`. The grammar tier tags only plain identifiers in heritage clauses, so no reference told the store to ask `init.cts`. The candidate-file rule now also asks the files that import the base's file and declare a class or an interface, with a store case (`extends ns.Base`) and a worker case as regression tests; the second run is the table above. The research census counted 31 interface extensions and 17 classes; those include extensions of library and external types, which is why the repository-internal pairs are 22 and the library ones 20 here.

`implements` and `overrides` are proved on fixtures, as the research census (no `implements`, no `override` in gsd-core) requires: the shapes fixture (interface, abstract class, subclass, interface extension, generic abstract class, library subclass) and the generics fixture (generic bases, a mixin, an `any` base, a three-level override chain, an interface method implemented by a class).

## Deviations from Plan

**1. [Rule 1 - Bug] Subtype candidate files were too narrow**
- **Found during:** Task 2 (a mixin case) and Task 3 (relations-check on gsd-core)
- **Issue:** Choosing the files to ask from heritage-kind reference sites missed `extends Mixin(Base)` (no heritage site at all) and `extends ns.Base` (the grammar tier tags only identifiers).
- **Fix:** also ask the files with a reference that sits directly in a class or interface, and the files that import the base's file and declare a class or interface; regression cases in the store suite (both drivers) and with the real worker.
- **Files:** src/fact-store/resolve.ts, src/fact-store/resolve.test.ts, src/precise-resolver/typescript/resolver.test.ts. **Commits:** c989431, 7f05351

**2. [Plan inconsistency] ImpactVia order**
- The plan says relations are ranked "with the existing rule" and lists the order "calls, references, extends, implements, overrides, import". The existing rule ranks import before call and reference (ranking.ts, the ADR amendment). Putting import last would change how file items reached by import and by a module-level reference order, so the Phase 2 order is kept and the three new values come after `reference`. The only observable difference from the plan's list is the order of an import file item against a reference file item.

**3. [Rule 3 - Blocking] Two timing-sensitive tests of plan 03-22 failed in full runs**
- **Found during:** the full `npm test` (two of four runs, never in isolation, never on the base commit's one run).
- **Issue:** `scripts/emit-e2e.test.ts` compares a cold CLI answer with an MCP answer; under the load of the whole suite the cold compiler worker needs more than the approved 1.5 s, so the CLI answered grammar-tier with `resolver_timeout` while MCP answered precise. The cold path is unchanged by this plan (a function target never reaches the resolver for relations), and the two tests take the same time in isolation as on the base commit.
- **Fix:** the two comparisons are asked again, up to six times, when either answer carries `resolver_timeout`; they are never compared loosely. **Commit:** 8982858. The full run after the fix had 0 failures.

**4. [Scope] Files outside the plan's list**
- Changed because the contract changed: `src/fact-store/fact-store.test.ts` and `src/query/fresh.test.ts` (their `Reader` doubles need `relations`), `src/tenant/follower-overlay.ts` (the follower `Reader`), `src/query/fixtures.test.ts` (the shapes world and a relation-scripting resolver shared by the refs, impact and context tests), `src/query/index.ts`, `src/precise-resolver/typescript/{tier,index,worker}.ts`, `src/facts/index.ts`, `docs/reference/mcp.md`. `src/fact-store/contract.ts` was not changed: the store cases run against both SQLite drivers in `resolve.test.ts`.

**5. [Detail] Behaviours worth knowing**
- Instance members only: a static member that overrides a base static is not reported.
- Only `call` sites are `calls` edges (a `new` site is `references`), matching `code_impact`, which treats only `call` as a call hop.
- The worker keeps the `ts.Program` it built at first use; refreshing it after an edit is the incremental update of plan 03-29. This plan guarantees that a relation is never served for a snapshot it was not computed for (a test edits a file and sees the worker asked again, and the store suite sees the resolver asked again for a new snapshot); until 03-29 the content of the new answer comes from the old program, exactly as for edges.
- `RelationsOptions.limit` truncates after ordering by relation kind, subtype path and position; `code_impact` marks a hop cut when a symbol's relations reach the read limit, `code_context` adds a hint.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-03-251: worker lines are zod-validated, both ends must map to exactly one grammar symbol or the relation is dropped and counted, the store re-validates shape, asked file and overlay endpoints, and the response budget and wrong-kind rules stop a flooding or confused worker (store and worker tests with a scripted fake worker). T-03-252: grammar items carry no `edge`, tested in `code_refs` and `code_impact`. T-03-253: the per-hop cap, the read limits and `query.resolveTimeoutMs` bound the fan-out. T-03-254: the cache is keyed by snapshot and context with per-file markers, and an edit asks again.

## Self-Check: PASSED

- Created files present: relations.ts, relations-check.ts, relations-check.test.ts and this summary.
- Commits a6f66a0, 4664ee2, 25d2108, c989431, 85a544c, 7f05351, 78e4209 and 8982858 are ancestors of HEAD.
