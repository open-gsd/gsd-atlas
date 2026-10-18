---
phase: 03-typescript-module-and-mvp-eval
plan: 04
subsystem: testing
tags: [eval, oracle, typescript-compiler, git, commonjs, adr, zod]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "D-02 (independent oracle) and D-19 (ADR citation rule) decisions, research Eval Section C"
provides:
  - "scripts/eval/questions.ts: zod schemas and loadQuestions for Question, KeySpec (10 kinds), AnswerKey, QuestionFile"
  - "scripts/eval/oracle.ts: computeAnswerKey, verifyCitation, ORACLE_VERSION 03-04.1 and the keys / check commands"
  - "miniature gsd-core-shaped fixture repo under scripts/eval/__fixtures__/oracle-repo"
affects: [03-09 question set, 03-16 pre-registration freeze, scorer and harness plans]

actuals:
  tokens: 24900
  tasks: 3
  commits: 3
plan_head_before: 7516bdee7aab1302d2d1ccd5a3df778d72f1e999
plan_head_after: 45f666b0b36c2a64a840da1bafe47b05e6440a20

tech-stack:
  added: []
  patterns:
    - "answer keys from the compiler and git only; independence enforced by a test over import specifiers"
    - "second, resolution-free JS program so tracked .cjs files get scope-correct symbols"
    - "unexplained list: git grep -nw mentions the compiler result neither includes nor classifies"

key-files:
  created:
    - scripts/eval/questions.ts
    - scripts/eval/oracle.ts
    - scripts/eval/oracle.test.ts
    - scripts/eval/__fixtures__/oracle-repo/tsconfig.json
    - scripts/eval/__fixtures__/oracle-repo/tsconfig.decl.json
    - scripts/eval/__fixtures__/oracle-repo/src/lib.cts
    - scripts/eval/__fixtures__/oracle-repo/src/user.cts
    - scripts/eval/__fixtures__/oracle-repo/src/shapes.cts
    - scripts/eval/__fixtures__/oracle-repo/consumer.cjs
    - scripts/eval/__fixtures__/oracle-repo/docs/adr/0001-first.md
    - scripts/eval/__fixtures__/oracle-repo/docs/adr/2-second.md
  modified:
    - tsconfig.json

key-decisions:
  - "ADR and comment detection walks the syntax tree and takes the compiler's leading and trailing comment ranges at each token (SingleLineCommentTrivia and MultiLineCommentTrivia only), rather than running a raw ts.createScanner pass, so // inside a string, regex or template is never read as a comment"
  - "Both the tsconfig program and the second JS program force moduleDetection so top-level names of different files never merge into one global scope"
  - "Line numbering breaks on \\n only (CRLF is one break, BOM stripped); U+2028, U+2029 and a lone \\r are not breaks, matching git grep -n"
  - "computeAnswerKey accepts a Question or a bare KeySpec; AnswerKey gains a notes record (excludedNonComment, externalSupertypes, depth) and items gain optional adr, resolved and detail; file is optional only for an unresolved ADR citation"
  - "abstain probe is {symbol} or {adrNoFile: n}; a probe word that appears in code, or in any non-code tracked file, makes computeAnswerKey throw ABSTAIN_PROBE_MATCHES"

patterns-established:
  - "Key spec carries its own granularity and equality; the question category must match the key kind (schema-enforced)"
  - "Temp-repo tests: copy the fixture to os.tmpdir(), git init, commit, mutate, always remove in finally"

requirements-completed: [EVL-02]

duration: 60min
completed: 2026-10-17
status: complete
---

# Phase 03 Plan 04: Independent Eval Oracle Summary

**Compiler-and-git-only answer-key oracle with ten key kinds, a CommonJS rule that resolves `require` of emitted outputs back to `.cts` sources, ADR citation handling per D-19, and an `unexplained` cross-check, tested on a miniature gsd-core-shaped fixture (34 tests).**

## Performance

- **Tasks:** 3 of 3
- **Commits:** 3 task commits, plus this summary
- **Tests:** `node --test scripts/eval/oracle.test.ts` 34 pass, 0 fail; `npm run typecheck` and `npm run build` exit 0

## Accomplishments

- `questions.ts`: strict zod schemas, a discriminated union over ten key kinds, category/kind agreement, unique `q-<digits>` ids, repository-relative POSIX paths only, `loadQuestions` surfacing the zod message.
- `oracle.ts` callers rule: typed calls through the checker (aliases and exports canonicalised), plus a separate CommonJS rule over every program file and every tracked `.cjs`/`.js`/`.mjs`: destructured, namespace and inline `require(...).name` forms, resolved through the inverse of `ts.getOutputFileNames` and `.cjs` to `.cts` extension substitution. On the fixture it returns exactly three sites in two files and omits the same-named local function.
- The other kinds: references, definition (all overloads), heritage subtypes and supertypes (including library `Error`), emit (including declaration output), emit-consumers, adr-citers, adr-of (unresolved citations, duplicate ADR numbers), impact to a stated depth, abstain with probe verification.
- `verifyCitation` reads from disk only and reports `file missing`, `line out of range` or `needle absent`.
- Safety: refuses a tsconfig `extends`, `include` or `files` that resolves outside the repository root, and a directory that is not a git work tree; all key paths are repository-relative (asserted).
- `keys` and `check` commands; `keys` output is byte-identical across runs and carries no timestamp or absolute path; `check` with no arguments exits 2 with usage; a changed fixture line makes `check` exit 1 naming the question ids.
- Independence test: only `node:*`, `typescript`, `zod` and `./questions.ts` may be imported, and the text may not name the atlas store, database or MCP bin.

## Task Commits

1. Task 1 (tracer): `5c4e86c` feat(03-04): oracle callers key with CommonJS consumers on a fixture repo
2. Task 2: `e03fece` feat(03-04): oracle key kinds for references, heritage, emit, ADR citations and abstain
3. Task 3: `45f666b` test(03-04): oracle independence guard, encoding cases and check mode

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tsconfig.json excludes the fixture directory**
- **Found during:** Task 1
- **Issue:** the repo `tsconfig.json` includes `scripts`, and the fixture `.cts` files use ES `import` syntax, which `verbatimModuleSyntax` rejects in CommonJS files; `npm run typecheck` would fail on intentionally corpus-shaped code.
- **Fix:** added `"exclude": ["scripts/eval/__fixtures__"]` to `tsconfig.json`. `tsconfig.build.json` sets its own `exclude`, so the build is unaffected.
- **Files modified:** `tsconfig.json`
- **Commit:** `5c4e86c`
- This is the only file changed outside `scripts/eval`, so the Task 1 acceptance line "git status lists only files under scripts/eval" holds for everything except that one-line config change.

### Plan wording interpreted

- Comment finding uses the compiler's comment ranges at token boundaries instead of a raw `ts.createScanner` pass (see key-decisions); the result is the same trivia kinds with fewer false positives.
- The plan lists `computeAnswerKey(key, ctx)` in one place and `(question, ctx)` in another; both are accepted.
- Added `tsconfig.decl.json` to the fixture so the declaration-output case of `emit` has a real configuration to run against.
- Added optional key fields the plan did not name: `container` (disambiguate a member name), `definedIn` optional on `definition`, `depth` on `impact`.

### TDD ordering

The tests and the implementation were written in the same pass per task and all passed on the first run, so there is no separate failing-test commit (RED) in the history. The tests were checked to discriminate (exact item sets, a deliberately unclassifiable mention producing `unexplained`, mutated fixtures changing `check` output), but the strict RED-then-GREEN sequence was not followed.

## Known Limitations (for the question author, plans 03-09 and 03-16)

- `impact` at depth 2 and beyond follows exported functions of TypeScript program files only; exports of `.cjs` files (`module.exports = ...`) are not analysed.
- `heritage` is direct only (no transitive closure); library supertypes are counted in `notes.externalSupertypes`, not listed.
- In a JavaScript file outside the program, a same-named mention is treated as a different symbol when it is a property name or an own declaration or require binding; a relative `require` that the oracle cannot resolve to the defining source is therefore not flagged as `unexplained`.
- `keys` warns on stderr (it does not fail) when the question file's `corpusSha` differs from the checkout HEAD; `check` does treat a changed `repoSha` as a difference.
- A shared compiler quirk is shared with the system under test (stated in the file header).
- Not run: the full `npm test` suite; only the plan's verify commands.

## Known Stubs

None.

## Threat Flags

None. The oracle adds no network, auth or file-access surface beyond reading the corpus checkout and running `git` with argument arrays.

## Self-Check: PASSED

- Created files present in the worktree and committed (`oracle.ts`, `questions.ts`, `oracle.test.ts`, fixture files).
- Commits `5c4e86c`, `e03fece`, `45f666b` are ancestors of HEAD.
