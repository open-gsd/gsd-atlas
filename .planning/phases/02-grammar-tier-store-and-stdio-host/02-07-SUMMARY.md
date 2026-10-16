---
phase: 02-grammar-tier-store-and-stdio-host
plan: 07
subsystem: grammar-engine
tags: [web-tree-sitter, tree-sitter, extraction, file-facts, capture-vocabulary, match-limit, parse-deadline]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-02 FileFacts extension (exported, RefSite.kind/enclosing, ImportSite.style/bindings, exports) and validateFileFacts"
provides:
  - "Capture.match: captures grouped by query match instead of span nesting"
  - "Capture text bounded at GRAMMAR_LIMITS.captureTextChars (256 UTF-16 code units)"
  - "extractFileFacts(ExtractInput): ExtractResult and the documented capture-name vocabulary (definition.<kind>, name, export, import.*, export.*, reference.<kind>)"
  - "GrammarEngineOptions {matchLimit, parseTimeoutMs} with GrammarRunError codes match_limit_exceeded and parse_timeout"
  - "Toy module imports.scm captures the whole use statement as import.es; goldens regenerated"
affects: [02-13 typescript/javascript module queries, 02-14 worker pool, 02-15 indexer, 02-26 store-size gate]

actuals:
  tokens: 30000
  tasks: 3
  commits: 6
plan_head_before: 35232e2f9af7f16412de287e0673ad588587dd64
plan_head_after: 7ec25d7bfe0b5774a848fec75972dbe3f7a78593

tech-stack:
  added: []
  patterns:
    - "Module-agnostic extractor: the capture-name vocabulary is the contract; containment (parent, qualifiedName, enclosing) is derived from spans, never from capture data"
    - "Scope-filtered reference sites at extraction (top-level, imported, exported names and member calls only)"
    - "Optional engine run limits validated at creation (RangeError), failures raised as coded GrammarRunError values"

key-files:
  created:
    - src/grammar-engine/extract.ts
    - src/grammar-engine/extract.test.ts
    - src/lang/extract-toy.test.ts
  modified:
    - src/grammar-engine/types.ts
    - src/grammar-engine/limits.ts
    - src/grammar-engine/normalize.ts
    - src/grammar-engine/query.ts
    - src/grammar-engine/engine.ts
    - src/grammar-engine/with-tree.ts
    - src/grammar-engine/errors.ts
    - src/grammar-engine/fake.ts
    - src/grammar-engine/contract.ts
    - src/grammar-engine/index.ts
    - src/grammar-engine/grammar-engine.test.ts
    - src/lang/golden.test.ts
    - src/lang/lang-test.e2e.test.ts
    - scripts/grammar.test.ts
    - test/fixtures/modules/toy/queries/imports.scm
    - test/fixtures/modules/toy/fixtures/basic.toy.golden.json
    - test/fixtures/modules/toy/fixtures/crlf.toy.golden.json
    - test/fixtures/modules/toy/fixtures/emoji.toy.golden.json

key-decisions:
  - "The 0.27.1 progress callback CAN cancel a parse: returning true makes Parser.parse return null (documented in the ParseOptions and Parser.parse JSDoc although the typings declare the callback as void; verified at run time, ~1 ms cancel on a 1.7 MB source). The engine therefore enforces parseTimeoutMs itself; the pool (02-14) still terminates a stuck worker as the hard backstop."
  - "A cancelled parse keeps its state and resumes on the next parse, even for a different source (verified: the next parse returned a tree of the old document). withTree calls parser.reset() before raising parse_timeout."
  - "matchLimit bounds new capture-list allocation only: web-tree-sitter reuses lists it allocated earlier in the process, so a limit below an earlier high-water mark is not retroactive. Documented on GrammarEngineOptions: give every engine of one process the same limit."
  - "Equal spans are siblings, never nested: containment for parent/enclosing is strict, so two definitions with identical spans are both emitted without one becoming the other's parent."
  - "An export site marks a symbol exported only when the symbol is top level and the site is not a re-export (no from); the effective local name is local, else name."
  - "importPath is set only for non-member sites whose name is an import binding; a member-call property that happens to equal a binding name is not that binding."
  - "A match with a long (over 256 code unit) name has empty capture text and is skipped as match_missing_name instead of producing an empty-named symbol."

patterns-established:
  - "Capture vocabulary documented once in the extract.ts header; module authors (02-13) write queries to it"
  - "Match-limit and parse-deadline failures are coded GrammarRunError values; the engine has no default deadline, callers pass indexer.parseTimeoutMs"

requirements-completed: [LNG-03, LNG-04, LNG-08]

coverage:
  - id: D1
    description: "Engine groups captures by query match (Capture.match) and bounds capture text at 256 UTF-16 code units"
    requirement: LNG-04
    verification:
      - kind: unit
        ref: "src/grammar-engine/grammar-engine.test.ts#real engine: match grouping; toCapture: bounded capture text; Grammar Engine contract (real and fake)"
        status: pass
    human_judgment: false
  - id: D2
    description: "extractFileFacts turns captures into validated FileFacts: definitions with parent/qualifiedName, imports with bindings, exports, exported flags, scope-filtered reference sites with kind, enclosing and importPath"
    requirement: LNG-03
    verification:
      - kind: unit
        ref: "src/grammar-engine/extract.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "The toy language runs through the same extractor (emoji UTF-16 columns, BOM, CRLF twin, empty file) with regenerated goldens"
    requirement: LNG-08
    verification:
      - kind: unit
        ref: "src/lang/extract-toy.test.ts"
        status: pass
      - kind: e2e
        ref: "src/lang/lang-test.e2e.test.ts (gsd-atlas lang test over the toy module)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Runs are bounded: matchLimit raises match_limit_exceeded, parseTimeoutMs raises parse_timeout in bounded time, and the loaded grammar keeps working after either failure"
    requirement: LNG-04
    verification:
      - kind: unit
        ref: "src/grammar-engine/grammar-engine.test.ts#real engine: run limits (T-02-19); withTree: parse deadline"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 07: Grammar Engine Extraction Summary

**Module-agnostic extractor turning web-tree-sitter match-grouped captures into validated FileFacts (definitions with containment, imports, exports, scope-filtered references), with a documented capture vocabulary, bounded capture text, a match limit and a cancellable parse deadline, proven on the toy language.**

## Performance

- **Duration:** about 20 min
- **Started:** 2026-10-16T19:16Z (approximate; the start time was not captured)
- **Completed:** 2026-10-16T19:36Z
- **Tasks:** 3 (TDD: 6 commits)
- **Files modified:** 21 (3 created)

## Accomplishments

- `Capture.match` from `Query.matches` replaces span nesting for pairing a `name` with its definition; capture text over 256 UTF-16 code units is an empty string (span stays exact).
- `extractFileFacts` implements the whole vocabulary: ordered symbols with strict-containment parents and dotted qualifiedNames, import sites merged per statement span (bindings, one pair of quotes removed, style), export sites and exported flags, scope-filtered reference sites with kind, enclosing symbol and importPath; malformed matches are skipped and counted in info diagnostics.
- Runs are bounded: `matchLimit` (RangeError on a bad value at creation, `match_limit_exceeded` at run) and `parseTimeoutMs` (`parse_timeout`, parser reset so the next parse starts clean). The engine has no default deadline.
- **Can the 0.27.1 progress callback cancel a parse? Yes.** Returning `true` from `ParseOptions.progressCallback` makes `Parser.parse` return null (documented in the JSDoc of `ParseOptions` and `Parser.parse`; the typings declare the callback `=> void`, and a function returning boolean is assignable). Verified: a 1.68 MB source that parses in about 150 ms is cancelled in about 1 ms with a 1 ms deadline. So the deadline is enforced in the engine; plan 02-14 keeps worker termination as the hard backstop.

## Task Commits

1. **Task 1: Tracer, definitions from captures to validated FileFacts** - RED `2f3c825` (test), GREEN `829ddd1` (feat)
2. **Task 2: Imports, exports, scoped references, toy fixtures** - RED `1f444e8` (test), GREEN `3165cf7` (feat)
3. **Task 3: Run limits and vocabulary check** - RED `4f72d50` (test), GREEN `7ec25d7` (feat)

**Plan metadata:** committed separately after this summary (docs).

## TDD Gate Compliance

RED evidence (classifier verdict `RED_EVIDENCE_OK` for each, records kept untracked under `.planning/red-evidence-02-07-t{1,2,3}.json`):

- **Task 1:** target `gives every capture a zero-based match index and lets the captures of one definition share it` (grammar-engine.test.ts). Failed on the match-index assertion (`Capture.match` undefined); the toCapture, fake-match and contract match/256-text cases failed on assertions too. The new extract tests could not run until `extract.ts` existed (import failure), so they are not part of the evidence.
- **Task 2:** target `merges the matches that share a statement span into one site with ordered bindings and an unquoted path` (extract.test.ts, run with `--test-name-pattern` because the classifier rejected the whole-file TAP report as malformed for this file). Failed on `deepEqual(facts.imports, ...)` with an empty array; 9 of 20 extract cases and 3 toy cases failed on their planned assertions.
- **Task 3:** target `rejects with match_limit_exceeded when more matches are in flight than matchLimit, instead of truncating silently` (grammar-engine.test.ts, name-pattern run). Failed on `assert.rejects` because the engine took no options; the parse_timeout, option-validation and withTree deadline cases failed the same way.

RED commits precede GREEN commits for every task; no REFACTOR commits were needed.

## Files Created/Modified

- `src/grammar-engine/extract.ts` - `extractFileFacts` and the vocabulary header (documented once)
- `src/grammar-engine/{types,limits,normalize,query,engine,with-tree,errors,fake,contract,index}.ts` - match grouping, bounded text, run limits, options, fake scripted matches
- `src/grammar-engine/extract.test.ts`, `src/lang/extract-toy.test.ts` - vocabulary tests on scripted captures and the toy language
- `test/fixtures/modules/toy/queries/imports.scm` and three goldens - `import.es` statement capture; only `import.es` rows were added
- `src/lang/golden.test.ts`, `src/lang/lang-test.e2e.test.ts`, `scripts/grammar.test.ts`, `src/grammar-engine/grammar-engine.test.ts` - existing expectations updated for `match` and the new `import.es` capture

## Decisions Made

See `key-decisions` above. The notable ones: equal spans are siblings (strict containment), exports mark only top-level non-re-exported symbols, `importPath` skips member sites, and a limit below the process's capture-list high-water mark is not retroactive.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Goldens regenerated in the Task 2 commit instead of Task 3**
- **Found during:** Task 2
- **Issue:** The plan said not to regenerate goldens until Task 3, but the `imports.scm` change in Task 2 would leave `src/lang` golden, e2e, grammar-engine and `scripts/grammar.test.ts` tests red between the two commits, breaking bisect.
- **Fix:** Regenerated the goldens (`node scripts/toy-goldens.ts --write`; the plan's command omitted the required `--write` flag) in the Task 2 GREEN commit and updated the hand-typed expectations in the Task 2 RED commit. Diff over the plan range: only `import.es` rows added to three goldens (`bom.toy` has no `use` statement, so its golden is unchanged, not four).
- **Files modified:** three goldens, `src/lang/lang-test.e2e.test.ts`, `src/grammar-engine/grammar-engine.test.ts`, `scripts/grammar.test.ts`
- **Commits:** `1f444e8`, `3165cf7`

**2. [Rule 3 - Blocking] `Capture` construction sites outside the plan's file list**
- **Found during:** Task 1 (typecheck)
- **Issue:** `match` is required on `Capture`; `src/lang/golden.test.ts` builds Captures by hand. The plan anticipated this ("fix the construction site and say so in the summary").
- **Fix:** Added `match: 0` to the helper in `src/lang/golden.test.ts`. `src/lang/golden.ts` and `test-runner.ts` needed no change.
- **Commit:** `829ddd1`

**3. [Rule 1 - Bug] Cancelled parse resumes on the next call**
- **Found during:** Task 3 (experiment before coding)
- **Issue:** After a progress-callback cancellation the parser keeps its state; the next `parse` of a different source returned a tree of the old document.
- **Fix:** `withTree` calls `parser.reset()` when the parse returns null; a test parses the next source after a timeout and compares it to a clean run.
- **Commit:** `7ec25d7`

**4. [Rule 1 - Bug] Reference sites and positions use match-independent ordering**
- **Found during:** Task 2
- **Issue:** Grouping by first appearance made output depend on capture arrival order for ties.
- **Fix:** Every output list uses explicit comparators (start, end, kind, name; code-unit string order); a test feeds reversed capture order and expects deep-equal facts.
- **Commit:** `3165cf7`

**Total deviations:** 4 auto-fixed (2 blocking, 2 bug). **Impact:** none on scope; the tree is green at every commit.

## Issues Encountered

- The classifier returned `invalid_record` ("Non-TAP data in report") for the whole-file TAP report of `extract.test.ts` (nested multi-line assertion diffs); a `--test-name-pattern` rerun of the target produced a valid report. Noted for the gsd-core reporter adapter, not fixed here.
- The match-limit test depends on test order inside one process (capture-list high-water mark); the rejection case runs first in its describe and the comment explains why.

## Known Stubs

None.

## Threat Flags

None. T-02-19 (matchLimit, parse deadline, 256-character capture text), T-02-20 (parents and enclosing derived from spans, malformed matches skipped and counted, validateFileFacts on every test output) and T-02-21 (text over 256 units dropped) are mitigated as planned.

## Next Phase Readiness

Ready for 02-13 (TypeScript and JavaScript module queries) to write against the vocabulary in the `extract.ts` header, and for 02-14 (pool) and 02-15 (Indexer) to pass `indexer.parseTimeoutMs` (5000 in 02-CONSTANTS.md) as `parseTimeoutMs` and a shared `matchLimit`.

## Self-Check: PASSED

Files verified on disk (`extract.ts`, `extract.test.ts`, `extract-toy.test.ts`, the regenerated goldens) and commits `2f3c825`, `829ddd1`, `1f444e8`, `3165cf7`, `4f72d50`, `7ec25d7` are ancestors of HEAD. `npm test` 1258/1258, `npm run typecheck` and `npm run lint` exit 0, `node scripts/grammar-budget.ts test/fixtures/modules/toy` reports OK.
