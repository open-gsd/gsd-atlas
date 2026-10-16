---
phase: 02-grammar-tier-store-and-stdio-host
plan: 19
subsystem: query
tags: [code_refs, code_context, code_impact, atlas_status, keyset-paging, confidence-chain, zod, node-test]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-16 Query core (code_find, ranking, budget, cursor, fence); 02-11 Reader (refs with resolver bound, importers, symbol, fileFacts); 02-04 approved constants"
provides:
  - "src/query/page.ts pageItems: the one budget cut, ceiling, limit and keyset cursor shared by every code tool (code_find now uses it)"
  - "code_refs, code_context, code_impact and atlas_status served by Query.ask with schema ids gsd-atlas.code-refs/1, code-context/1, code-impact/1, atlas-status/1"
  - "StatusPort, IndexerStatusLike, TierActive, PolicyMode, StatusSnapshot, HEALTH_REASONS and POLICY_OFF exported from src/query/index.ts for the Host (plan 02-20)"
  - "QueryConfig keys resolveTimeoutMs 1500, impactDefaultDepth 2, impactMaxDepth 5, impactRowCapPerHop 200 from 02-CONSTANTS.md"
affects: [02-20 Host wiring of StatusPort and the in-process client, 02-22 CLI rendering, 02-23 MCP server, 02-24 history, Phase 3 explain and callees]

actuals:
  tokens: 34085
  tasks: 3
  commits: 6
plan_head_before: d554b204ae86d9d93c474748d31886ac97961acc
plan_head_after: 5f19c11bff1f5fedcf5db0d03da602c6de294e3a

tech-stack:
  added: []
  patterns:
    - "Every code tool builds an ordered, totally keyed item list and hands it to pageItems with a render callback that measures the real envelope"
    - "Sort keys reuse the nine-slot SortKey tuple (refs, impact and context key builders in ranking.ts), so one cursor shape serves all tools"
    - "Citations and fenced line text are built once in cite.ts (createCitations, memoLineText, cleanField)"

key-files:
  created:
    - src/query/page.ts
    - src/query/cite.ts
    - src/query/refs.ts
    - src/query/context.ts
    - src/query/impact.ts
    - src/query/status.ts
    - src/query/fixtures.test.ts
    - src/query/refs.test.ts
    - src/query/context.test.ts
    - src/query/impact.test.ts
    - src/query/status.test.ts
  modified:
    - src/query/find.ts
    - src/query/query.ts
    - src/query/ranking.ts
    - src/query/tools.ts
    - src/query/types.ts
    - src/query/defaults.ts
    - src/query/index.ts
    - src/query/harness.test.ts

key-decisions:
  - "Inside a hop code_impact lists symbols before files, then orders by edge confidence, chain confidence and via; the plan's prose order (confidence first) contradicts its own golden example, so the golden is the contract"
  - "Chain confidence is computed per path (EXTRACTED only while every edge is), file edges walk importers one hop at a time from each impacted file, and each symbol or file is kept once per seed at its smallest hop"
  - "A hop larger than impact.rowCapPerHop is sorted and cut to the cap; candidates are pre-cut to four times the cap by a cheap order before symbol lookups; both set truncated and a per-hop hint"
  - "code_context handles for a file's own imports and exports are composed in Query in the store's imp/ path/hash/ordinal shape (exp/ for exports) because the Reader returns no handle for them; parent and child handles come from Reader.symbol"
  - "atlas_status reports counts and flags only: stale and failed paths are counted, the corrupt-file path becomes a flag, a throwing port answers unavailable without echoing its text"
  - "Targets (code_refs, code_impact seeds) are capped at five, code_context follows six (best plus five alternatives); a capped set sets truncated and a hint"

patterns-established:
  - "Keyset ties between items that share a position are broken by a handle that joins the item and its target or seed, so the order stays total"
  - "A cursor binds to the tool and to every ranking-relevant argument (the impact depth is part of its mode string)"

requirements-completed: [QRY-02, QRY-03]

coverage:
  - id: D1
    description: "code_refs returns ranked, cited references per target with inline fenced line text, precise before grammar, INFERRED never shown as EXTRACTED, ambiguous sites listed under every candidate, and the approved 1500 ms resolve bound passed to Reader.refs"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "src/query/refs.test.ts#tracer: returns the imported call site of parse as an INFERRED grammar reference and leaves out the unimported same-name call"
        status: pass
      - kind: unit
        ref: "src/query/refs.test.ts#ambiguous: one site that could match two definitions appears under both, each with ambiguous true and candidates 2"
        status: pass
      - kind: unit
        ref: "src/query/refs.test.ts#resolver_timeout: a resolver slower than the approved 1500 ms degrades the answer and still lists the grammar references"
        status: pass
    human_judgment: false
  - id: D2
    description: "One shared paging mechanism (budget cut, ceiling, limit, keyset cursor, watermark_moved) for code_find, code_refs, code_context and code_impact; code_find behaviour unchanged"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "src/query/query.test.ts (code_find budget, ceiling, limit and pages) and src/query/refs.test.ts#code_refs paging through the shared mechanism"
        status: pass
    human_judgment: false
  - id: D3
    description: "code_context returns the definition, container, members, imports, exports and up to ten references as one ordered, cited, pageable list, with up to five alternatives and no callees, cites_adr or tested_by"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "src/query/context.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "code_impact walks references and importers breadth-first to the clamped depth with per-hop confidence, chain_confidence, per-hop row cap and truncated reporting; the ADR worked example is a golden test"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "src/query/impact.test.ts#ADR worked example: parse at depth 2 reaches b.load and b.ts at hop 1 and c.main and c.ts at hop 2, with per-hop and chain confidence"
        status: pass
      - kind: unit
        ref: "src/query/impact.test.ts#a hop larger than the per-hop row cap is cut to the cap, marked truncated, and the hint names the hop"
        status: pass
    human_judgment: false
  - id: D5
    description: "atlas_status reports watermark seq and stale count, store health, Indexer state, Governor load, tiers and policy off from injected ports, with a health rollup in a fixed reason order and no value statistics, source text or paths beyond the root"
    requirement: QRY-03
    verification:
      - kind: unit
        ref: "src/query/status.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "All four code tools give byte-identical answers for 100 identical requests once the nonce is masked, and carry schema, watermark and fenced untrusted_text"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "src/query/refs.test.ts#cross-tool determinism: the four code tools share one envelope discipline"
        status: pass
    human_judgment: false

duration: 16min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 19: Query answer surface Summary

**code_refs, code_context, code_impact (with per-hop and chain confidence, ADR golden example) and atlas_status served by Query on one shared keyset paging mechanism**

## Performance

- **Duration:** 16 min
- **Started:** 2026-10-16T23:28:04Z
- **Completed:** 2026-10-16T23:44:20Z
- **Tasks:** 3 (each RED then GREEN)
- **Files modified:** 19 (11 created, 8 modified), 3,031 insertions and 133 deletions

## Accomplishments

- `src/query/page.ts` `pageItems` now carries the keyset resume, limit, budget cut under the hard ceiling, cursor issue and `watermark_moved` for every code tool. `code_find` was moved onto it with its existing suite (paging, budget, ceiling, cursor, determinism) unchanged and green.
- `code_refs` follows up to five definitions (narrowed by `path` and `kind`), passes the approved `query.resolveTimeoutMs` 1500 to `Reader.refs`, ranks precise before grammar, EXTRACTED before INFERRED, then call, new, type, heritage, read, member, directory distance, path, line, column, and lists a site two targets could own under both with `ambiguous: true` and the candidate count.
- `code_context` returns one ordered item list tagged by `section` (definition, parent, child, import, export, reference), at most five alternatives and at most ten references, cut and continued by the same cursor; callees, `cites_adr` and `tested_by` are absent.
- `code_impact` walks references and importers to the clamped depth (default 2, maximum 5, 200 items per hop), reports `via`, `confidence` and `chain_confidence` per item, and the query-and-policy ADR worked example (parse, load, main) is a golden test returning exactly the four specified items in order.
- `atlas_status` builds its snapshot from a `StatusPort` only, rolls health up in the fixed order follower, rebuilding, reconciling, stale_files, watch_fallback, indexer_failures, mirrors the matching degraded codes, and a scan test proves it carries no source text, no stale or failed paths and none of the value-statistics words.
- Verification: `node --test "src/query/*.test.ts"` 163 pass; full `npm test` 1,901 pass, 0 fail; `npm run typecheck`, `npm run lint` and `npm run build` exit 0.

## TDD Gate Compliance

All three tasks ran RED then GREEN. RED evidence for each task is a TAP run of the target test, classified `RED_EVIDENCE_OK` by `gsd-tools check tdd-red-evidence` (records kept untracked at `.planning/red-evidence-02-19-t1.json`, `-t2.json`, `-t3.json`).

| Task | RED commit | RED target test | GREEN commit |
|------|------------|-----------------|--------------|
| 1 code_refs | `1158912` | refs.test.ts tracer: returns the imported call site of parse ... | `233e6d1` |
| 2 code_context, code_impact | `f822275` | impact.test.ts ADR worked example | `d230290` |
| 3 atlas_status | `9f380d1` | status.test.ts reports the watermark, store, indexer, governor, tiers and the policy mode, with health ok | `5f19c11` |

Semantic assessment of RED (all three): the target test built a real temporary git repository, a real Fact Store and a real Source Tree, and failed at its first assertion (`envelope.ok` expected true, actual false) with the `unknown_kind` diagnostic, because Query routed only the earlier kinds. No RED failed on syntax, import, fixture or zero-test faults. Task 3 also added the cross-tool determinism cases to `refs.test.ts` in its RED commit; they pass at once because they characterise the tools finished in Tasks 1 and 2 (a regression gate, not new behaviour). No REFACTOR commit was needed.

## Task Commits

1. **Task 1: Tracer, code_refs through the shared paging mechanism**: `1158912` (test), `233e6d1` (feat)
2. **Task 2: code_context and code_impact with the ADR golden test**: `f822275` (test), `d230290` (feat)
3. **Task 3: atlas_status from ports, health rollup, cross-tool determinism**: `9f380d1` (test), `5f19c11` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

## Files Created/Modified

- `src/query/page.ts` - `pageItems`: keyset resume, limit, budget and ceiling cut, cursor, `watermark_moved`
- `src/query/cite.ts` - `createCitations`, `memoLineText`, `cleanField`: citations and fenced line text built one way
- `src/query/refs.ts` - `code_refs`; `findTargets`, `gatherRefs`, `describeRef`, `describeDefinition` shared with the other tools
- `src/query/context.ts` - `code_context`
- `src/query/impact.ts` - `code_impact` (breadth-first walk, edge choice, per-hop cap, chain confidence)
- `src/query/status.ts` - `atlas_status`, `HEALTH_REASONS`, `POLICY_OFF`, `StatusSnapshot`
- `src/query/find.ts` - now renders through `pageItems` and `cite.ts` (behaviour unchanged)
- `src/query/query.ts` - shared `prepare` step (schema, worktree, cursor binding, fresh) and routing of the five served kinds
- `src/query/ranking.ts` - `refKeyOf`, `impactKeyOf`, `contextKeyOf`, `CONTEXT_SECTIONS`
- `src/query/tools.ts` - `kind` on `code_refs`, `depth` may be 0, exported input types
- `src/query/types.ts`, `defaults.ts`, `index.ts` - config keys, `StatusPort` and friends, exports
- `src/query/harness.test.ts`, `fixtures.test.ts`, `refs.test.ts`, `context.test.ts`, `impact.test.ts`, `status.test.ts` - test support and 49 new cases

## Decisions Made

- Within a hop, `code_impact` orders symbols before files and then by edge confidence, chain confidence and via (import, call, reference). The plan's step 3 said "hop, then confidence (EXTRACTED first)", which would list the EXTRACTED `b.ts` import before the INFERRED `load` call and contradict the golden example the same plan makes the contract. The golden order wins.
- Chain confidence is exact per path: the file walk asks `Reader.importers(file, {depth: 1})` for each impacted file so a hop-2 importer inherits its own predecessor's chain, rather than a conservative minimum over the whole hop.
- Per-hop caps sort first and cut second, so the kept items are the best by the total order, never an arbitrary subset. Candidates are pre-cut to four times the cap by a cheap order before symbol lookups (the same factor `code_find` uses for its reads); either cut sets `truncated` and a hint naming the hop.
- Import and export citations in `code_context` use handles composed in Query (`imp/<path>/<hash>/<ordinal>`, the shape the store gives its own importer records, and `exp/...` for exports), because the Reader returns no handle for a file's own import and export sites. This is the only place Query composes a handle; it is an open item for the `explain` work.
- The impact depth is part of the cursor's query hash, so a cursor from depth 2 is refused at depth 3.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan's impact ordering rule contradicts its own golden example**
- **Found during:** Task 2 (writing impact.test.ts)
- **Issue:** Step 3 orders by hop then confidence (EXTRACTED first); must_haves and the behavior list require `load` (INFERRED) before `b.ts` (EXTRACTED) at hop 1 and `main` before `c.ts` at hop 2.
- **Fix:** key slot 1 puts symbols before files inside a hop; slot 2 packs confidence, chain confidence and via, most significant first.
- **Files modified:** src/query/ranking.ts (`impactKeyOf`), src/query/impact.ts
- **Verification:** `impact.test.ts` ADR worked example passes with the four items in the specified order.
- **Committed in:** `233e6d1` (ranking.ts), `d230290` (impact.ts)

**2. [Rule 3 - Blocking] `code_refs` had no `kind` argument and `code_impact` refused depth 0**
- **Found during:** Tasks 1 and 2
- **Issue:** The behavior lists require `kind` to filter `code_refs` targets and depth 0 to return nothing with a hint; the 02-16 schemas had neither (`depth` was positive-only).
- **Fix:** added optional `kind` to `codeRefsSchema`; `depth` is `nonnegative`; exported the three input types.
- **Files modified:** src/query/tools.ts
- **Verification:** `refs.test.ts` path and kind case; `impact.test.ts` depth 0 case; the existing tools-schema case in `query.test.ts` still passes.
- **Committed in:** `233e6d1`, `d230290`

**3. [Rule 3 - Blocking] Two shared helper files not in the plan's file list**
- **Found during:** Tasks 1 and 2
- **Issue:** three tools render citations and fenced text identically, and three test files need the same fixture builders; duplicating either would have copied about 150 lines.
- **Fix:** added `src/query/cite.ts` (production) and `src/query/fixtures.test.ts` (test support).
- **Verification:** typecheck, lint and the full suite pass.
- **Committed in:** `233e6d1`, `f822275`

---

**Total deviations:** 3 auto-fixed (1 bug in the plan text, 2 blocking)
**Impact on plan:** none on scope or on any requirement; deviation 1 follows the plan's own golden test.

## Issues Encountered

- The memtrace guard refused whole-file `Read` of indexed sources until a `codegraph node -f` call covered the span; every source read went through `codegraph node -f ... --offset 1 --limit N` first, as the brief required. No guard refused a timeout-shaped constant: the four config keys were written without any denial.

## Known Concerns (not stubs)

- `code_impact` calls `Reader.refs` once per frontier symbol, each with the 1500 ms resolver bound. With the Phase 2 store (no precise resolver) this costs nothing; once a real resolver exists (Phase 3) a deep walk could add up to cap x depth x seeds bounded waits. The 02-11 note that unresolved sites are re-sent every call (no negative marker) makes this worth a Phase 3 look.
- Bounds that are not in 02-CONSTANTS.md and come from the plan text itself: five targets or seeds, five alternatives, ten context references, and a candidate pre-cut of four times the row cap (the factor `code_find` already uses).
- Linux and Windows behaviour of the new tests rests on three-OS CI; they use only the real store, real files and the fake clock, nothing platform specific.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-20 can wire `StatusPort` (store status, Indexer status, Governor status, module registry tiers, policy `off`) and unify `ERROR_SCHEMA`; `lang_list` still answers `unknown_kind` from Query by design (the Host serves it).
- `Query.ask` now serves code_find, code_refs, code_context, code_impact and atlas_status.

## Self-Check: PASSED

- All 11 created files exist on disk.
- All 6 task commits (`1158912`, `233e6d1`, `f822275`, `d230290`, `9f380d1`, `5f19c11`) are listed by `git log` from the recorded plan base `d554b20` to HEAD, and `rev-list --count` over that range is 6.
- Plan verification re-run after the last task: `node --test "src/query/*.test.ts"` 163 pass, 0 fail; `npm run typecheck`, `npm run lint`, `npm run build` exit 0; full `npm test` 1,901 pass, 0 fail.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
