---
phase: 02-grammar-tier-store-and-stdio-host
plan: 13
subsystem: language-modules
tags: [tree-sitter, queries, typescript, javascript, commonjs, recall, compiler-oracle]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-07 extractor and capture vocabulary; 02-08 module skeletons, module-goldens.ts, corpus-fetch.ts"
provides:
  - "Complete tags, imports and refs queries for the typescript and javascript modules (ES and CommonJS)"
  - "scripts/recall.ts: per-construct recall gate on curated fixture truth and, with --corpus, on a pinned gsd-core sample"
  - "scripts/recall-oracle.ts: TypeScript-compiler oracle (createSourceFile only)"
  - "Hand-curated truth files beside the fixtures of both modules"
affects: [02-14, 02-15, 02-16, 02-19, 02-26, phase-03]

actuals:
  tokens: 70600
  tasks: 3
  commits: 6
plan_head_before: 36a6cd478dce37607f27c6edb79f76af7d43b51c
plan_head_after: 5ba5ea62069f234eff5ed1082414585c669016a5

tech-stack:
  added: []
  patterns:
    - "One match per declaration: disjoint query patterns per parent context (program, block, ambient, export)"
    - "Truth written by hand from the fixture before the extractor runs; an independent compiler oracle for the real-code sample"
    - "A construct a language lacks is n/a (null recall), never zero; no pooled number"

key-files:
  created:
    - modules/typescript/queries/imports.scm
    - modules/typescript/queries/refs.scm
    - modules/javascript/queries/imports.scm
    - modules/javascript/queries/refs.scm
    - modules/typescript/fixtures/constructs.ts
    - modules/typescript/fixtures/modules.ts
    - modules/javascript/fixtures/constructs.cjs
    - modules/javascript/fixtures/modules.mjs
    - scripts/recall.ts
    - scripts/recall-oracle.ts
    - scripts/recall.test.ts
  modified:
    - modules/typescript/queries/tags.scm
    - modules/javascript/queries/tags.scm
    - modules/typescript/atlas-lang.json
    - modules/javascript/atlas-lang.json
    - src/grammar-engine/extract.ts
    - src/lang/test-runner.ts
    - package.json

key-decisions:
  - "Declarations are matched by parent context with disjoint patterns, so one declaration is one match; a test asserts no symbol is defined twice"
  - "export default <declaration> is defined without @export and exported as `default` by imports.scm; ambient declarations match only under the program"
  - "A const/let/var bound to require() (also behind `as T`) is an import, not a const definition; destructuring is never a definition; constructors are not methods"
  - "module.exports = { a, b: c } yields one export site per property; any other right side yields the name `module.exports`; exports.x and module.exports.x yield x"
  - "The typescript module also reads CommonJS forms (require, module.exports), because .cts files use them"
  - "The recall engine uses matchLimit = GRAMMAR_LIMITS.matchLimitMax and parseTimeoutMs = 5000 (indexer.parseTimeoutMs of 02-CONSTANTS.md)"
  - "The oracle counts lines by line feed only (the engine's rule); the compiler's own line map breaks at U+2028 and lone CR"

patterns-established:
  - "Recall rows are keyed (name, line) per construct, plus parent for containment, and the file when aggregated"
  - "A deleted-pattern test (queryTransform) proves a weak construct shows as its own failing row"

requirements-completed: [LNG-02]

coverage:
  - id: D1
    description: "TypeScript definition queries (function, class, interface, type alias, enum, const/var, method, property, namespace) with containment, measured per construct against hand-curated truth"
    requirement: LNG-02
    verification:
      - kind: unit
        ref: "scripts/recall.test.ts#typescript fixture recall (LNG-02)"
        status: pass
      - kind: other
        ref: "node scripts/recall.ts --module typescript"
        status: pass
    human_judgment: false
  - id: D2
    description: "TypeScript and JavaScript imports, exports and references queries, ES and CommonJS, with bindings, re-exports and RefSite kinds"
    requirement: LNG-02
    verification:
      - kind: unit
        ref: "scripts/recall.test.ts#modules.ts: import styles, bindings and unquoted paths of every ES and CommonJS form"
        status: pass
      - kind: unit
        ref: "scripts/recall.test.ts#reference extraction (D-06)"
        status: pass
    human_judgment: false
  - id: D3
    description: "JavaScript module end to end (tags, imports, refs; constructs the language lacks are n/a)"
    requirement: LNG-02
    verification:
      - kind: unit
        ref: "scripts/recall.test.ts#javascript fixture recall (LNG-02)"
        status: pass
      - kind: other
        ref: "node scripts/recall.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Compiler-oracle recall of at least 90 percent per construct on a deterministic pinned sample of gsd-core"
    requirement: LNG-02
    verification:
      - kind: unit
        ref: "scripts/recall.test.ts#corpus mode (compiler oracle on a pinned sample)"
        status: pass
      - kind: other
        ref: "node scripts/recall.ts --corpus gsd-core"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 13: TypeScript and JavaScript queries with per-construct recall Summary

**Complete tags, imports and refs queries for the typescript and javascript modules (ES and CommonJS), with every applicable construct at 100 percent on curated fixture truth and on a compiler-oracle run over 574 pinned gsd-core files**

## Performance

- **Duration:** about 35 min
- **Started:** 2026-10-16T20:50:00Z (approximate; the start was not recorded at launch)
- **Completed:** 2026-10-16T21:25:00Z
- **Tasks:** 3 (each RED then GREEN)
- **Files modified:** 30 (including 6 goldens)

## Accomplishments

- `tags.scm` for both modules covers function (declarations, generators, overload and ambient signatures, const/let/var bound arrows and function expressions), class, interface, type alias, enum, namespace, const/var at module top level, method (accessors, overloads, abstract and interface signatures; no constructors) and property (class fields and interface members), with `@export` where an export statement wraps the declaration.
- `imports.scm` for both modules covers ES imports (default, namespace, named with alias, type-only, side-effect, mixed), `import x = require()`, every CommonJS `require` form (namespace, destructured, aliased, member, bare, `as T`), ES re-exports, `export { a as b }`, `export default`, `module.exports = ...` (one site per property), `exports.x` and `module.exports.x`. `refs.scm` covers call, new, member, heritage, type (TypeScript only) and read.
- `scripts/recall.ts` prints one row per construct (never a pooled number), `n/a` where a language lacks the construct, and exits 1 when any applicable construct is under 90 percent. `scripts/recall-oracle.ts` classifies a file with `ts.createSourceFile` only.
- A deleted pattern makes exactly its own construct fail (tested for enums); a pattern the oracle disagrees with shows as a failing row in corpus mode (tested for functions).

## Recall baseline

Fixtures (`node scripts/recall.ts`), matched/truth, every applicable row 100 percent:

| construct | typescript | javascript |
|-----------|-----------|-----------|
| function | 20/20 | 11/11 |
| class | 9/9 | 3/3 |
| interface | 2/2 | n/a |
| type alias | 3/3 | n/a |
| enum | 4/4 | n/a |
| const/var | 11/11 | 8/8 |
| method | 17/17 | 6/6 |
| property | 10/10 | 3/3 |
| containment | 30/30 | 11/11 |
| ES import | 8/8 | 5/5 |
| ES export | 21/21 | 10/10 |
| CJS require | 6/6 | 5/5 |
| CJS module.exports | 5/5 | 6/6 |

Compiler oracle (`node scripts/recall.ts --corpus gsd-core`, gsd-core at `10ac3a7a947903ba50f538a907af036744d759d5`, 274 `.cts` files under `src/` and the first 300 `.cjs` files by sha256 of the path), matched/truth:

| construct | typescript | javascript |
|-----------|-----------|-----------|
| function | 3435/3435 | 1668/1668 |
| class | 34/34 | 2/2 |
| interface | 1044/1044 | n/a |
| type alias | 437/437 | n/a |
| enum | n/a | n/a |
| const/var | 1142/1142 | 958/958 |
| method | 306/306 | n/a |
| property | 4328/4328 | n/a |
| containment | 4954/4954 | 108/108 |
| ES import | 804/804 | n/a |
| ES export | 1332/1332 | n/a |
| CJS require | 672/672 | 2395/2395 |
| CJS module.exports | 5/5 | 499/499 |

No sampled file failed to run. How to read these numbers honestly: the oracle's scope was aligned to the queries' declared scope (statement lists only, no constructors, `require()` bindings are imports, properties only in classes and interfaces), and three oracle gaps were fixed after the first corpus run showed them (see Deviations), so 100 percent means two independent implementations agree on 574 real files under one stated scope, not that no other reading of "definition" exists.

## Task Commits

1. **Task 1: TypeScript definition queries and fixture recall harness**
   - RED `564bfcd` (test): recall test fails, only function and class found (RED evidence verdict RED_EVIDENCE_OK)
   - GREEN `bafbfbc` (feat)
2. **Task 2: imports, exports, references; the JavaScript module**
   - RED `3c0c2a2` (test): JS recall 0/8 on const/var, method, property, imports, exports
   - GREEN `5ee1571` (feat)
3. **Task 3: compiler-oracle recall on the pinned sample**
   - RED `6353efa` (test): oracle returns an empty list against 16 expected items
   - GREEN `5ba5ea6` (feat)

**Plan metadata:** recorded in the docs commit that follows this summary.

## Files Created/Modified

- `modules/typescript/queries/{tags,imports,refs}.scm`, `modules/javascript/queries/{tags,imports,refs}.scm` - the queries
- `modules/*/atlas-lang.json` - list all three query files, version unchanged
- `modules/typescript/fixtures/{constructs,modules}.ts`, `modules/javascript/fixtures/{constructs.cjs,modules.mjs}` with `.golden.json` and `.truth.json` each
- `scripts/recall.ts`, `scripts/recall-oracle.ts`, `scripts/recall.test.ts` - harness, oracle, 42 tests
- `src/grammar-engine/extract.ts` - an `import.local` written before its `import.named` aliases it
- `src/lang/test-runner.ts` - `lang test` skips `<fixture>.truth.json`
- `package.json` - `recall` and `recall:corpus` scripts

## Decisions Made

See `key-decisions`. In short: disjoint patterns per context, default exports under `default`, require bindings are imports, CommonJS support in both modules, and an LF-only line rule shared by the oracle and the engine.

## RED/GREEN evidence

Each task has a `test(02-13)` commit before its `feat(02-13)` commit. RED evidence records (`.planning/red-evidence-02-13-t1.json`, `-t2.json`, `-t3.json`, not committed) all returned `RED_EVIDENCE_OK`: the target test ran and failed on its planned strict-equality assertion (the failing-row list for Tasks 1 and 2, the empty oracle result for Task 3), with the harness, fixtures and placeholders loading cleanly. The `test(02-13)` commits also hold the harness and fixtures; the query files were absent or tracer-only at that point.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `lang test` treated `<fixture>.truth.json` as a fixture**
- **Found during:** Task 1
- **Issue:** the plan places curated truth next to the fixtures and requires `lang test` to pass, but the runner lists every non-golden file in `fixtures/` and demanded a golden for the truth file
- **Fix:** `listFixtures` skips names ending `.truth.json`; new test in `src/lang/test-runner.test.ts`
- **Files modified:** src/lang/test-runner.ts, src/lang/test-runner.test.ts
- **Committed in:** bafbfbc

**2. [Rule 2 - Missing critical] `const f = require(p).member` could not bind `f`**
- **Found during:** Task 2
- **Issue:** `import.local` was honoured only after its `import.named`; in this form the local name is written first, so the binding came out as `member` aliasing `member`
- **Fix:** `bindingsOf` lets a leading `import.local` alias the next `import.named` of the same match; the header vocabulary says so; unit test added
- **Files modified:** src/grammar-engine/extract.ts, src/grammar-engine/extract.test.ts
- **Committed in:** 3c0c2a2 (test), 5ee1571 (fix)

**3. [Rule 1 - Bug] `export declare function/class/enum` was defined twice**
- **Found during:** Task 3 (the first corpus run showed one extra function in `src/package-identity.d.cts`)
- **Issue:** the plain ambient pattern matched an `ambient_declaration` under an export statement as well as the exported-ambient pattern; recall cannot see duplicates because extra found items do not lower it
- **Fix:** ambient patterns match only under the program; fixture lines for `export declare` added to `constructs.ts` and truth; a new test asserts no symbol is defined twice in any fixture
- **Files modified:** modules/typescript/queries/tags.scm, constructs.ts, constructs.truth.json, scripts/recall.test.ts
- **Committed in:** 5ba5ea6

**4. [Rule 2 - Missing critical] `const m = require(p) as T` (and `satisfies`) bound nothing**
- **Found during:** Task 3 (20 `.cts` consts were flagged by the oracle; the cause was the type assertion)
- **Issue:** the require call was imported but its binding `m` was lost, which weakens reference scoping for the most common `.cts` form
- **Fix:** namespace and destructured binding patterns for `as_expression` and `satisfies_expression` values; fixture lines 36 and 37 of `modules.ts`, truth and a bindings assertion added first
- **Files modified:** modules/typescript/queries/imports.scm, modules.ts, modules.truth.json, scripts/recall.test.ts
- **Committed in:** 5ba5ea6

**5. [Rule 1 - Bug] Oracle gaps found by the first corpus run (fixed in the oracle, with tests)**
- **Issue:** (a) the compiler's line map breaks at U+2028, U+2029 and a lone CR (tests/frontmatter.test.cjs holds a U+2028 and every later line shifted by 2); the oracle now counts line feeds only, the engine's rule; (b) `require(...) as T` was counted as a const; (c) a function declared inside a top-level const's initializer had no parent
- **Files modified:** scripts/recall-oracle.ts, scripts/recall.test.ts
- **Committed in:** 5ba5ea6

**6. [Plan adjustment] The `default` ES export moved from Task 1 to Task 2**
- `export default function defaultNamed` is exported by `imports.scm`, which Task 2 creates. The `default` item was removed from `constructs.truth.json` in Task 1 and put back (line 17) in Task 2. No other truth item was changed to fit the extractor; the later additions to `constructs.ts`, `modules.ts` and their truth (export declare, `as T` requires) were written before the corresponding query change.

---

**Total deviations:** 5 auto-fixed (1 blocking, 2 missing critical, 2 bugs) and 1 plan adjustment
**Impact on plan:** all necessary for the plan's own gates (`lang test`, correct bindings, a trustworthy recall number); no scope creep.

## Known gaps (not defects against the plan's constructs)

- `export = x` (TypeScript) produces no export site; decorated exported classes and decorated members can differ by a line between tree-sitter spans and the compiler when a decorator sits on its own line (none occurred in the sample); declarations directly inside a switch case are not defined by either side; `export const {a} = o` (destructured export) yields no site.
- `const f = require(p).member` binds `f` to `member`; `const m = require(p)` binds `m` as a namespace (`*`), the best the vocabulary says for a CommonJS module object.
- Constructors are deliberately not definitions, so `find constructor` finds nothing.
- `reference.read` covers the common expression positions (arguments, array and object values, operands, returns, member objects); a position outside that list is simply not recorded. Reference precision is a Phase 3 measurement.

## Issues Encountered

None beyond the deviations above. The corpus run needs network (one shallow fetch of the pinned SHA); the unit tests inject a local tree and need none.

## Known Stubs

None.

## Threat Flags

None. The corpus fetch reuses `fetchCorpus` (refuses destinations inside the repo); the recall run creates its own temp directory under the system temp directory, refuses a temp root inside the repository, and removes the directory in `finally`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-14 (worker pool) and 02-15 (Indexer) can rely on complete facts for both modules; `scripts/recall.ts --corpus gsd-core` is the gate plan 02-26 wires into CI (needs network and git).
- `npm test` runs the fixture-mode recall (offline); `npm run recall:corpus` runs the pinned sample.

## Self-Check: PASSED

All 15 created files exist on disk and all six task commits (564bfcd, bafbfbc, 3c0c2a2, 5ee1571, 6353efa, 5ba5ea6) are ancestors of HEAD. Final `npm test` 1557 of 1557, `npm run typecheck`, `npm run lint`, `lang test` for both modules, `grammar-budget` ratio 0 for both, `node scripts/recall.ts` and `node scripts/recall.ts --corpus gsd-core` all exit 0.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
