---
phase: 03-typescript-module-and-mvp-eval
plan: 07
subsystem: testing
tags: [eval, scorer, zod, json-schema, ajv, citations, corpus-preparation, npm-ci, copy-on-write]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-04 oracle (computeAnswerKey, verifyCitation, AnswerKey with needles) and questions.ts; 03-03 claude-session.ts (billableTokens, Usage, SessionStatus); 03-01 decisions (OQ8 confirmed)"
provides:
  - "scripts/eval/answer-schema.json: the one structured final answer (answer found|not_found, items {file, line?, symbol?}, summary <= 400), additionalProperties false throughout"
  - "scripts/eval/score.ts: AnswerSchema (zod twin), extractAnswer, scoreAnswer, toResultRow, LINE_SLACK = 2, MAX_CITATIONS = 200, normalisePath, projectItems, matchSets, matchLines, matchSymbols"
  - "scripts/eval/prepare-corpus.ts: prepareCorpus, readPreparedRecord, cloneCheckout, resolveNpm, runCli and the prepare-corpus command line"
affects: [03-09 question drafting, 03-10 harness, 03-05 rows.ts compatibility, 03-16 pre-registration freeze (STAGE_A_FILES)]

actuals:
  tokens: 21651
  tasks: 3
  commits: 6
plan_head_before: 3d4b0fa753b7565e137a35329e0a4d2ef6accd71
plan_head_after: 20a2a4623b276b84be7d44e3c49c1421fe16b619

tech-stack:
  added: []
  patterns:
    - "scorer imports the oracle and the question shapes only; every cited file:line is verified on disk by the oracle's verifyCitation"
    - "zod twin of a JSON Schema proven equivalent by a table test against Ajv 2020 (code-point length for maxLength)"
    - "scoring in small pure functions (normalisePath, projectItems, matchLines, matchSymbols, matchSets); one-to-one matching, cheapest pair first"
    - "child processes with argument arrays only; stub fetch and npm executables written by the test, no network"

key-files:
  created:
    - scripts/eval/answer-schema.json
    - scripts/eval/score.ts
    - scripts/eval/score.test.ts
    - scripts/eval/prepare-corpus.ts
    - scripts/eval/prepare-corpus.test.ts
  modified: []

key-decisions:
  - "correct depends on the answered set only (and on no invalid path); citation verification is reported separately as citation.hasVerifiable, so EVL-03 is measured independently of accuracy"
  - "verifyCitation checks the spelling of a path, not the target of a link, so score.ts resolves the real path of every cited file and fails a link that leaves the checkout as 'outside checkout' (T-03-71) rather than editing the hashed oracle.ts"
  - "Class.method matches a bare method name (either side) on the last segment; two qualified names must be equal as a whole"
  - "unresolved ADR key items (no file) cannot be named by the answer schema and are left out of the comparison"
  - "preparation record lives inside the checkout directory (.eval-prepared.json) and is added to that checkout's .git/info/exclude so git status stays clean"
  - "cloneCheckout keeps only relative symlinks whose real target is inside the tree; absolute links, links leaving the tree and unresolvable links are skipped"

patterns-established:
  - "RED stub = exports with inert behaviour, so the target test fails on its assertion and not on a load error"

requirements-completed: [EVL-02, EVL-03]

duration: 11min
completed: 2026-10-18
status: complete
---

# Phase 03 Plan 07: Scorer and Corpus Preparation Summary

**A scorer that marks one fixed JSON answer against an oracle key (exact-set and superset-ok, abstain, line slack 2, Class.method symbols) with every cited file:line verified on disk and kept inside the checkout, plus a corpus preparation that checks out the pinned gsd-core, runs `npm ci --ignore-scripts` (project TypeScript 6.0.3 live-verified) and makes copy-on-write per-session clones.**

## Performance

- **Duration:** about 11 min
- **Started:** 2026-10-18T04:29:18Z
- **Completed:** 2026-10-18T04:40:09Z
- **Tasks:** 3 of 3
- **Files modified:** 5 created, 0 modified

## Accomplishments

- `answer-schema.json` and its zod twin `AnswerSchema` accept and reject the same samples (ten-sample table plus an edge table, checked against Ajv 2020; `summary` length counts code points on both sides).
- `scoreAnswer` implements D-02 granularity and equality, abstain handling (`abstain correct`, `abstain with items`, `fabricated answer`, `gave up`), line slack 2 with each key line matched once, and verifies every cited line through the oracle's `verifyCitation`; `hasVerifiable` needs at least one cited line and all of them verifying.
- Path safety (T-03-71): `..`, drive letters, UNC, NUL and absolute paths outside the checkout are rejected; absolute paths inside it and backslash forms are normalised; a symlink inside the checkout that resolves outside is reported as `outside checkout`, never read through.
- Runaway answers are bounded: at most 200 cited items are verified, the rest fail as `too many citations` (T-03-74).
- `prepareCorpus` runs `scripts/corpus-fetch.ts` as a child process, checks the commit against the manifest, runs `npm ci --ignore-scripts` (argument array and environment) and writes `.eval-prepared.json` with compiler version and CRLF-normalised lock hash. Live check against the pinned gsd-core: TypeScript 6.0.3, lock sha256 `dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb` (OQ8 behaves as decided).
- `cloneCheckout` uses `COPYFILE_FICLONE`; cloning the installed gsd-core checkout took 2.5 s on this machine.

## Task Commits

1. **Task 1 (tracer): answer schema and scoring against oracle keys**
   - RED `0abb820` (test) - `e2fc26d` (feat)
2. **Task 2: abstain, line slack, granularities and path safety**
   - RED `eb4f70e` (test) - `7207bd3` (feat)
3. **Task 3: corpus preparation and copy-on-write clones**
   - RED `1b60658` (test) - `20a2a46` (feat)

**Plan metadata:** the docs commit that adds this file.

## TDD Gate Compliance

Every task has a `test(03-07)` commit before its `feat(03-07)` commit. All three RED stubs were exports-only with inert behaviour.

- **RED 1:** `node --test --test-reporter=tap scripts/eval/score.test.ts` exit 1, 9 of 11 failing. Classifier (`check tdd-red-evidence`, target `perfect answer`): `RED_EVIDENCE_OK`. Semantic assessment: the target executed and failed on `scored.correct === true` because the stub returned `correct: false, reason: 'not implemented'`; intended reason.
- **RED 2:** exit 1, 9 of 33 failing (abstain x4, line slack, Class.method, symlink, citation cap, nearer-answer). Classifier target `symlink out of tree`: `RED_EVIDENCE_OK`. Semantic assessment: failed on `4 !== 2` verified citations, i.e. the link was read through, the planned gap. Tests for path traversal, BOM/CRLF and result row were already green on first run because Task 1's GREEN covered them (see deviations).
- **RED 3:** exit 1, 15 of 17 failing, 1 skipped (live). Classifier target `ignore-scripts flag...`: `RED_EVIDENCE_OK`. Semantic assessment: the target ran the full setup and failed at its first evidence read (ENOENT on the stub npm's argv log) because the stub never ran npm; `sha mismatch`, `clone leaves source untouched` and the command-line cases failed on assertions about the absent behaviour.

## Files Created/Modified

- `scripts/eval/answer-schema.json` - JSON Schema (draft 2020-12) of the final answer
- `scripts/eval/score.ts` - schema twin, extraction, path safety, matching, scoring, result-row mapping
- `scripts/eval/score.test.ts` - 33 tests on the oracle fixture, handmade keys and temporary checkouts
- `scripts/eval/prepare-corpus.ts` - preparation, record, clones, command line
- `scripts/eval/prepare-corpus.test.ts` - 17 tests with stub fetch and npm executables (1 live test skipped unless `GSD_EVAL_LIVE=1`)

## Decisions Made

See `key-decisions` above. One structural note for later plans: `answer-schema.json`, `score.ts` and `prepare-corpus.ts` are in `STAGE_A_FILES` (03-16), so any edit after the freeze needs a new registered run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `rows.ts` does not exist yet (plan 03-05 runs in the same wave)**
- **Found during:** Task 1 (`toResultRow`)
- **Issue:** the plan has `toResultRow` build a `ResultRow` that passes `ResultRowSchema` from `scripts/eval/rows.ts`, but that file is a sibling plan's output and was absent, so importing it would have broken typecheck.
- **Fix:** `score.ts` declares `ResultRowFields` (the field list from the 03-05 plan) and `RowPartial` itself; `score.test.ts` validates rows against a local strict mirror schema and, when `./rows.ts` is present, also against the real `ResultRowSchema` (loaded by a variable specifier). `billableTokens` comes from `claude-session.ts` as required.
- **Follow-up:** after 03-05 and 03-07 are merged, run `node --test scripts/eval/score.test.ts` once; the two `result row` tests then exercise the real schema, and `tsc` will show any drift between `ResultRowFields` and `ResultRow`.
- **Files modified:** scripts/eval/score.ts, scripts/eval/score.test.ts
- **Commit:** e2fc26d, eb4f70e

**2. [Rule 2 - Missing critical] `verifyCitation` reads through symlinks**
- **Found during:** Task 2 (symlink test)
- **Issue:** the oracle's `verifyCitation` only checks the lexical path, so a link inside the tree pointing outside would be read (T-03-71 requires it not to be).
- **Fix:** `score.ts` resolves the real path of each cited file against the real checkout root before calling `verifyCitation` and records `outside checkout`. `oracle.ts` (plan 03-04, hashed) was not edited.
- **Files modified:** scripts/eval/score.ts
- **Commit:** 7207bd3

**3. [Rule 3 - Blocking] no `node_modules` in the worktree**
- **Fix:** an untracked symlink `node_modules` to the main checkout's installed dependencies; nothing installed, nothing committed.

**4. [Plan wording] `toResultRow` implemented in Task 1, tested in Task 2**
- Task 1's acceptance lists `toResultRow` among the exports, so it was implemented there; its `result row` tests were written in Task 2 and passed on first run. A small TDD gap, recorded rather than hidden.

**5. [Interpretation] file+symbol with unresolved ADR key items**
- Key items without a file (unresolved ADR citations) cannot be expressed in the answer schema, so they are excluded from set comparison. Plan 03-09 should avoid `adr-citers` questions whose correct answer depends on them.

**Total deviations:** 5 (2 Rule 3, 1 Rule 2, 2 recorded interpretations). **Impact:** none on scope; the rows.ts follow-up is the only open item.

## Issues Encountered

- A RED-run artifact `.eval-prepared.json` appeared in the worktree root (the stub returned an empty `dir`); it was removed and never committed. The final tests leave nothing behind in the repository (`git status --short` shows only the untracked `node_modules` link).

## Known Stubs

None.

## Threat Flags

None. The fetch and install use the network through the existing dev-time `corpus-fetch.ts` and `npm ci --ignore-scripts`, as the plan's threat model already covers (T-03-72, T-03-SC).

## Next Phase Readiness

- Ready for 03-09 (question drafting) and 03-10 (harness): `scoreAnswer(question, key, resultText, ctx)` and `toResultRow(partial, scored)` are the interfaces; `prepareCorpus` / `cloneCheckout` / `readPreparedRecord` provide the pinned checkout and the record the pre-registration copies (compiler 6.0.3, lock hash above for gsd-core at 10ac3a7).
- Not done by design: Windows live use of the npm shim (documented in `prepare-corpus.ts`).

## Self-Check: PASSED

- Files exist: scripts/eval/answer-schema.json, score.ts, score.test.ts, prepare-corpus.ts, prepare-corpus.test.ts
- Commits reachable from HEAD: 0abb820, e2fc26d, eb4f70e, 7207bd3, 1b60658, 20a2a46
- `node --test scripts/eval/prepare-corpus.test.ts scripts/eval/score.test.ts`: 49 pass, 0 fail, 1 skipped (live); `GSD_EVAL_LIVE=1`: 17 of 17 pass in prepare-corpus; `npm run typecheck` clean; `node --test "scripts/**/*.test.ts"`: 481 pass, 0 fail, 1 skipped
- Acceptance criteria re-run: `--ignore-scripts` and `COPYFILE_FICLONE` present in prepare-corpus.ts; `LINE_SLACK` appears on 3 lines in score.ts and equals 2; `additionalProperties: false` at the top level and inside `items`; required test titles present
