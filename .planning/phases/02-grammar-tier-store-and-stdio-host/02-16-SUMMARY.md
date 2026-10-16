---
phase: 02-grammar-tier-store-and-stdio-host
plan: 16
subsystem: query
tags: [query, mcp-contract, ranking, budget, cursor, untrusted-text, fencing, zod, code_find]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "Envelope, Citation, UntrustedText and degraded codes (02-02); Source Tree readText (02-05); Fact Store core and Reader.find (02-06, 02-11); Indexer ensureFresh shape (02-15); approved query constants (02-CONSTANTS.md)"
provides:
  - "src/query: createQuery(deps) returning Query {ask(request)}, serving code_find end to end over a real store and real files"
  - "TOOLS, TOOL_NAMES and buildRequest: six strict-zod read-only tool definitions that the CLI and the MCP server will share through HostClient (D-07)"
  - "The full QRY-01 envelope: schema id, citations with debug handles, watermark, degraded, truncated, more, hints and nonce-fenced untrusted_text"
  - "Deterministic tiered ranking (sortKeyOf, compareRanked), token budget with hard ceiling (estimateTokens, cutToBudget) and an opaque keyset cursor (encodeCursor, decodeCursor, queryHash)"
  - "Fence and normalization (newNonce, normalizeText, fenceText) and the fresh step (FreshPort) that 02-19 reuses for the other tools"
  - "createHarness(): a real temp repository, real store and real source tree for Query tests"
affects: [02-17, 02-19, 02-20, 02-22, 02-23, 02-25, 02-26]

actuals:
  tokens: 27150
  tasks: 3
  commits: 6
plan_head_before: 4d79b3b90416805362201aade5b2e253ff4febf9
plan_head_after: 4dbc164e9551797e4c79a6000c5dc7e97c09568b

tech-stack:
  added: []
  patterns:
    - "Pure comparator over a sort-key tuple whose last element is the debug handle, so the order is total and the cursor can carry the last key"
    - "Keyset paging with no server state: every call re-queries and resumes strictly after the cursor key; a moved watermark continues with degraded watermark_moved"
    - "Budget cut judged on the exact response that will be sent (measure(kept, truncated) includes the cursor), whole items only, first oversized item still returned under the ceiling"
    - "All repo text leaves through one nonce fence per response; every structured repo string is normalized and capped at 200 code units"

key-files:
  created:
    - src/query/types.ts
    - src/query/defaults.ts
    - src/query/tools.ts
    - src/query/envelope.ts
    - src/query/fence.ts
    - src/query/text.ts
    - src/query/find.ts
    - src/query/query.ts
    - src/query/ranking.ts
    - src/query/cursor.ts
    - src/query/budget.ts
    - src/query/index.ts
    - src/query/harness.test.ts
    - src/query/query.test.ts
    - src/query/ranking.test.ts
    - src/query/cursor.test.ts
    - src/query/budget.test.ts
    - src/query/fence.test.ts
    - src/query/fresh.test.ts
  modified: []

key-decisions:
  - "A symbol's name is the last segment of its qualified name; a symbol the exact read returned is the exact tier with the query as its name, any other symbol is tier 1 or worse (nameAndTier), so a CommonJS name such as module.exports cannot be mis-ranked as an exact match for 'exports'"
  - "A cursor that would exceed the approved 1024 characters (a path over roughly 330 characters) is not issued: the response is truncated with a static hint and no more cursor, instead of issuing a cursor Query would later refuse"
  - "The cursor's query hash covers the worktree as well as the tool, name, kind, mode, path and cwd, so a cursor cannot be replayed against another repository"
  - "When the Indexer could not finish a fresh path, its line text is dropped and the result degrades stale: the file on disk is newer than the facts, so the old span would point at the wrong line"
  - "auto and fuzzy modes behave identically (every tier; the substring tier needs three characters because the Reader's fuzzy read does); only exact and prefix narrow the result"

patterns-established:
  - "FindContext carries everything a tool needs for one response (deps, config, worktree, nonce, query hash, decoded cursor, fresh outcome); 02-19 adds tools as sibling files with the same context"
  - "Tests that plant different facts in files must give the files different bytes: the store keys facts by content hash, so identical bytes share one set of facts"

requirements-completed: [QRY-01, QRY-02, QRY-05]

coverage:
  - id: D1
    description: "Six read-only tool definitions with strict zod schemas and fixed descriptions, and buildRequest"
    requirement: QRY-01
    verification:
      - kind: unit
        ref: "src/query/query.test.ts#names exactly six tools in the stated order, each read-only with a fixed description"
        status: pass
      - kind: unit
        ref: "src/query/query.test.ts#parses each tool's documented arguments and rejects unknown keys"
        status: pass
      - kind: unit
        ref: "src/query/query.test.ts#builds a request with the protocol, kind, args, budget and fresh paths"
        status: pass
    human_judgment: false
  - id: D2
    description: "code_find returns the full envelope over a real store and real files: result, citation with debug handle, watermark, fenced line text, empty result as an ok envelope, not_indexed naming gsd-atlas build"
    requirement: QRY-01
    verification:
      - kind: integration
        ref: "src/query/query.test.ts#returns the full envelope for one exported function"
        status: pass
      - kind: integration
        ref: "src/query/query.test.ts#answers an unindexed repository with not_indexed and names the exact build command"
        status: pass
      - kind: integration
        ref: "src/query/query.test.ts#answers a name with no match as an ok envelope with an empty list and one static hint"
        status: pass
    human_judgment: false
  - id: D3
    description: "Tiered, total-order ranking: exact, case-insensitive exact, prefix, substring, then definition, confidence, exported, cwd distance, path, line, column, handle"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "src/query/ranking.test.ts#200 generated results always sort to the same sequence however they arrive"
        status: pass
      - kind: integration
        ref: "src/query/query.test.ts#orders exact, case-insensitive exact, prefix and substring matches"
        status: pass
      - kind: integration
        ref: "src/query/query.test.ts#gives byte-identical output for 100 identical requests once the nonce is replaced"
        status: pass
    human_judgment: false
  - id: D4
    description: "Token budget with whole-item cuts, hard ceiling, output_too_large, limit clamp and a safe opaque keyset cursor with watermark_moved"
    requirement: QRY-02
    verification:
      - kind: unit
        ref: "src/query/budget.test.ts"
        status: pass
      - kind: unit
        ref: "src/query/cursor.test.ts"
        status: pass
      - kind: integration
        ref: "src/query/query.test.ts#pages without repeating or skipping an item, and the pages join into the unpaged order"
        status: pass
      - kind: integration
        ref: "src/query/query.test.ts#continues past a moved watermark and says so with degraded watermark_moved"
        status: pass
    human_judgment: false
  - id: D5
    description: "Repo text is normalized and nonce-fenced: injection fixture, bidi, zero-width, tag characters, ANSI, lone surrogates, nonce omission, empty line, entry order"
    requirement: QRY-05
    verification:
      - kind: unit
        ref: "src/query/fence.test.ts"
        status: pass
      - kind: integration
        ref: "src/query/query.test.ts#injection fixture: an instruction in a source line and a fake fence marker come back only inside untrusted_text"
        status: pass
    human_judgment: false
  - id: D6
    description: "fresh paths: one ensureFresh call with the approved wait, read after the port answers, degraded fresh_timeout on every failure mode, invalid_fresh_path warning"
    requirement: QRY-01
    verification:
      - kind: integration
        ref: "src/query/fresh.test.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "Stale, deleted, short, CRLF, BOM and emoji-column text handling"
    requirement: QRY-05
    verification:
      - kind: integration
        ref: "src/query/query.test.ts#stale and unreadable text"
        status: pass
    human_judgment: false
  - id: D8
    description: "The fence reduces prompt injection but cannot remove it: whether a model obeys fenced text is outside what a test can assert"
    requirement: QRY-05
    verification: []
    human_judgment: true
    rationale: "QRY-05 prohibits treating repo text as anything but data, which is a property of the consuming model; tests prove the text is fenced and normalized, not that a model ignores it. Tool descriptions state the limit."

duration: 15 min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 16: Query Core and code_find Summary

**Query module with a stateless `ask(request)`: six shared strict-zod tool definitions, the full citation and watermark envelope, a total-order tiered ranker, budget plus hard ceiling plus keyset cursor, nonce-fenced normalized line text read through Source Tree, and `fresh` handling, with `code_find` working end to end over a real store.**

## Performance

- **Duration:** 15 min (14 min 42 s)
- **Started:** 2026-10-16T22:16:55Z
- **Completed:** 2026-10-16T22:31:37Z
- **Tasks:** 3 (tracer plus two auto), each as a RED test commit then a GREEN feature commit
- **Files created:** 19 (12 source, 7 test); no existing file changed

## Accomplishments

- `code_find` answers through the real stack: Reader exact, prefix and fuzzy reads are unioned by debug handle, ranked, cut to the budget and returned with 1-based citations; the matched line comes from `SourceTree.readText` and leaves only inside `untrusted_text`.
- The order is a total order over `[tier, kindRank, confidenceRank, exportedRank, dirDistance, path, line, col, handle]`: a seeded 200-result shuffle sorts identically ten times, and 100 identical requests are byte-identical once the nonce is replaced.
- Budget and ceiling work on the response that will really be sent: the estimate is `ceil(JSON.stringify(envelope).length / 4)`, items are cut whole, the first item that alone exceeds the budget is still returned under the 8000 ceiling, and an item that cannot fit under the ceiling gives a tiny `output_too_large` error (estimate under 100 tokens).
- The `more` cursor is base64url JSON `{k, q, w}` bound to the query hash and checked for size, canonical encoding and shape; paging reproduces the unpaged order exactly, and a moved watermark continues with `watermark_moved`.
- Repo text is stripped of ANSI sequences, zero-width, bidi, tag, line-separator and control characters, lone surrogates become U+FFFD, tabs become spaces, and lines are cut at 240 code units without splitting a pair; names and paths in structured fields get the same treatment at 200. A line containing the response nonce is replaced by `[line omitted]`.
- `fresh` runs before any read: one `ensureFresh(worktree, paths, 2000)` call; an unfinished, throwing or absent port degrades with `fresh_timeout` and still answers; refused paths give one `invalid_fresh_path` warning.

## Task Commits

1. **Task 1: Tracer, code_find with fenced line text** - RED `565dfb5` (test), GREEN `9908972` (feat)
2. **Task 2: Tiered ranking, modes, budget, ceiling, keyset cursor** - RED `2ea01f5` (test), GREEN `c4ca47c` (feat)
3. **Task 3: Fencing proofs, injection fixture, fresh handling, stale text, determinism** - RED `7027d3f` (test), GREEN `4dbc164` (feat)

**Plan metadata:** the docs commit that carries this file (docs: complete plan)

## TDD Gate Compliance

All three tasks have a `test(02-16)` commit before their `feat(02-16)` commit. RED evidence was machine-checked with `gsd-tools check tdd-red-evidence` (`RED_EVIDENCE_OK`) before each GREEN.

- **Task 1 RED:** target test "returns the full envelope for one exported function" in `src/query/query.test.ts`; expected an ok code-find envelope with one cited result, watermark and fenced entry; actual: the RED stub's `ask` threw "the query module is not implemented yet". Semantic assessment: the test built a real repository, store and source tree and failed at its first `ask()`; all 12 cases failed on a stub, none on syntax, import, fixture or zero-test faults.
- **Task 2 RED:** target "pages without repeating or skipping an item, and the pages join into the unpaged order"; expected the twelve `item01`..`item12` prefix matches in order and pages of 5, 5, 2; actual: the Task 1 exact-only `code_find` returned an empty list and the first `deepEqual` failed. The ranking, cursor and budget unit files failed on RED stubs. One new case (identical positions, different handles) already passed at RED because exact-only reads return it; it is kept as a regression guard.
- **Task 3 RED:** target "calls the port once with the request worktree, the paths and the approved wait" in `src/query/fresh.test.ts`; expected one recorded call with the worktree, both paths and wait 2000; actual: the call list was empty because Query did not yet run the fresh flow. Eight of nine fresh cases failed; the ninth (no call without paths) is the planned negative.
- **Task 3 note:** `normalizeText`, `fenceText` and the text handling for stale, missing and short files were completed in Task 1 (the fence cannot be built halfway), so the fence, injection, stale, CRLF, BOM, emoji-column and 100-run determinism cases were already green at Task 3 RED. They are characterization proofs, not RED targets. A mutation check (removing the ANSI strip) failed four of them, then was reverted, which shows they bite.
- No REFACTOR commit: nothing needed cleaning after GREEN.

## Files Created/Modified

- `src/query/types.ts` - `Query`, `QueryDeps` (store, text, fresh, clock, config, nonce test hook), `QueryConfig`, `FreshPort`
- `src/query/defaults.ts` - `DEFAULT_QUERY_CONFIG` from the approved constants; `resolveQueryConfig`
- `src/query/tools.ts` - `TOOLS`, `TOOL_NAMES`, strict zod schemas, `buildRequest`
- `src/query/envelope.ts` - schema ids, `errorEnvelope`, `withDegraded`
- `src/query/fence.ts` - `newNonce`, `normalizeText`, `fenceText`
- `src/query/text.ts` - per-request line reader over `readText`
- `src/query/ranking.ts`, `cursor.ts`, `budget.ts` - comparator and sort key, keyset cursor, estimate and cut
- `src/query/find.ts`, `query.ts`, `index.ts` - `code_find`, `ask` and the module seam
- `src/query/*.test.ts` - harness (no tests inside) plus query, ranking, cursor, budget, fence and fresh tests (113 tests)

## Decisions Made

See `key-decisions` in the frontmatter. In short: a symbol's name comes from its qualified name and only exact-read hits can be the exact tier; an over-long cursor degrades to a hint rather than being issued; the cursor hash includes the worktree; unfinished fresh paths lose their line text; `auto` and `fuzzy` are the same set of tiers. `QueryDeps.clock` is in the interface the plan fixed but Query has no timer of its own (the fresh wait lives in the Indexer), so nothing reads it yet.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `String.prototype.toWellFormed` is not in the project's TypeScript library**
- **Found during:** Task 1 (typecheck after GREEN)
- **Issue:** the plan and research name `toWellFormed()` for lone-surrogate replacement, but `tsconfig.json` targets ES2023, whose library does not declare it, so `npm run typecheck` failed with TS2550.
- **Fix:** an equivalent regex without the `u` flag (high surrogate not followed by a low one, or low not preceded by a high) replaces lone surrogates with U+FFFD; the same behaviour, no `lib` change.
- **Files modified:** `src/query/fence.ts`
- **Verification:** `fence.test.ts` "replaces a lone surrogate" cases; typecheck, lint and build pass.
- **Committed in:** `9908972`

**2. [Rule 2 - Missing Critical] Unfinished fresh paths still showed disk text**
- **Found during:** Task 3 design
- **Issue:** if `ensureFresh` did not finish a path, the facts are older than the file, so the span would point at the wrong line and text from it would be misleading.
- **Fix:** paths in the port's `stalePaths` are added to the stale set of the line reader; those results lose their text and degrade `stale` (covered by a test).
- **Files modified:** `src/query/find.ts`, `src/query/query.ts`
- **Committed in:** `4dbc164`

### Plan additions

- `src/query/budget.test.ts` is a seventh test file the plan did not list; the pure estimate and cut logic is easier to prove directly than only through `code_find`.
- Cursor overflow (see key-decisions) is a case the plan did not state: a cut with no cursor, reported by `truncated` and a hint, only for paths over about 330 characters.

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing critical), 2 additions
**Impact on plan:** no scope creep; the fixes are required for the typecheck gate and for the correctness of QRY-05 text.

## Issues Encountered

- The store keys facts by content hash, so two test files with identical bytes shared one set of facts and hid the difference the test planted (kind filter, exported ranking). The test helper now writes each file's path into its content.
- Two Bash source reads (`cat` on a source file, `tail` on a test file) were refused by the memtrace guard and two compound commands by the worktree-isolation guard. Each was redone through CodeGraph or as plain separate commands; no guard was bypassed.

## Known Stubs

None. The five tool names other than `code_find` are defined in `TOOLS` but `ask` answers them with `unknown_kind` until plan 02-19, as the plan states; this is the plan's own boundary, not a stub in a delivered path.

## Threat Flags

None. No new network endpoint, file access path or trust boundary beyond those in the plan's threat model (T-02-52 to T-02-55: fenced text, cursor validation, confined reads through Source Tree, result and output bounds).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-19 adds `code_refs`, `code_context`, `code_impact` and `atlas_status` on this foundation: route the new kinds in `createQuery`, reuse `FindContext`, `cutToBudget`, `createLineReader`, `fenceText` and the cursor; their zod schemas already exist in `tools.ts`. The plan 02-19 `query.resolveTimeoutMs` (1500) is not added to `QueryConfig` yet.
- The Indexer already satisfies `FreshPort` structurally (`ensureFresh(worktree, paths, waitMs)` and `FreshResult` have the same shape as `FreshReport`).
- Plan 02-20 should re-export `TOOLS` and `buildRequest` through `src/host-client`; `ERROR_SCHEMA` now exists in both `src/query/envelope.ts` and `src/host-client/in-process.ts` with the same value, and the host client should import the Query one.
- Linux and Windows are unverified until three-OS CI runs these tests (path-hint resolution and the zero-width-character file name are the platform-sensitive parts).

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*

## Self-Check: PASSED

- All 12 source files and 7 test files under `src/query/` exist.
- Commits `565dfb5`, `9908972`, `2ea01f5`, `c4ca47c`, `7027d3f` and `4dbc164` are ancestors of HEAD; `git rev-list --count` from the plan's starting head gives 6.
- `node --test "src/query/*.test.ts"` 113 of 113 pass; full `npm test` 1747 of 1747 pass; `npm run typecheck`, `npm run lint` and `npm run build` exit 0.
