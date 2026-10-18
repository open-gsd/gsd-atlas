---
phase: 03-typescript-module-and-mvp-eval
plan: 09
subsystem: testing
tags: [eval, questions, oracle, seeded-sampling, typescript-compiler, adr, gsd-core]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-04 oracle (computeAnswerKey, KeySpec kinds) and questions.ts; 03-07 prepare-corpus and the scorer; 03-06 scan questions (not to be repeated); 03-01 decisions (OQ7, OQ8); approved constants (eval.bootstrapSeed 20261017)"
provides:
  - "scripts/eval/draft-census.ts: buildCensus, orderCandidates, sample (seeded, with skip continuation), decide (the closed rejection rules), draftCandidates, scaffold, stamp, review and list commands"
  - "scripts/eval/questions/gsd-core.questions.json: 50 scored questions q-001..q-050 (callers 11, references 5, heritage 5, emit 7, adr 7, impact 4, definition 5, abstain 6)"
  - "scripts/eval/questions/pilot.questions.json: 5 pilot questions p-001..p-005 from 5 other subjects"
  - "gsd-core.answers.json and pilot.answers.json: oracle keys with the preparation record of the pinned checkout"
  - "scripts/eval/questions/candidates.json: every ordered candidate with its accept, reject (closed-list reason) or unused status"
  - "docs/eval/questions-review.md: the generated document the user reads at plan 03-16"
  - "scripts/eval/questions.test.ts: validity tests over the committed files"
  - "oracle.ts helper exports (program, comments, emit-aware resolution, line numbering, declaration lookup) for plans 03-24, 03-25, 03-31"
affects: [03-14 pilot, 03-16 pre-registration freeze, 03-24, 03-25, 03-31]

actuals:
  tokens: 346000
  tasks: 3
  commits: 6
plan_head_before: 455baaa40a3f4dc910e8ea67aea5602201c80bbc
plan_head_after: ed00e4baddceb74c1410350d46a233372435d1c9

tech-stack:
  added: []
  patterns:
    - "selection by construction: a seeded shuffle over a file-and-name sorted census, one pass, a closed list of rejection rules, every decision committed"
    - "question text is the only hand-written part; key specs come from candidates, keys from the oracle"
    - "generated review document with a regenerate-and-compare test"

key-files:
  created:
    - scripts/eval/draft-census.ts
    - scripts/eval/draft-census.test.ts
    - scripts/eval/questions.test.ts
    - scripts/eval/questions/candidates.json
    - scripts/eval/questions/gsd-core.questions.json
    - scripts/eval/questions/gsd-core.answers.json
    - scripts/eval/questions/pilot.questions.json
    - scripts/eval/questions/pilot.answers.json
    - docs/eval/questions-review.md
  modified:
    - scripts/eval/oracle.ts
    - scripts/eval/questions.ts

key-decisions:
  - "Acceptance is mechanical: scripts/eval/draft-census.ts draft walks the seeded order and applies decide(); the agent wrote only the question texts, so no candidate was chosen or dropped by judgment"
  - "Pilot categories are a seeded pick of 5 of the 8 (references, adr, impact, definition, abstain); the pilot question is the first acceptable candidate of the category's first group, so it can never starve a scarcer group's scored quota"
  - "Expected-answer size is counted after projection to the key's granularity (distinct files for file), so a function with 80 call sites in 3 files is 3 answers; the 30 limit applies to that"
  - "Granularity: file for callers, references, emit, adr and impact; file+symbol for heritage; file+line for definition; abstain uses file with no items"
  - "An adr-of key with a citation that has no ADR file is rejected as unexplained, and an abstain probe that matches something as ambiguous-name, so the closed list of six reasons stayed closed"
  - "The answers file records the preparation record without its machine-specific dir"
  - "The impact question text states the oracle's depth-two rule exactly (callers of any function exported by a .cts file that calls the subject), not the narrower call-chain reading of the scan question"

patterns-established:
  - "Eval question files: QuestionFile + answers file + candidates file, one script regenerates the review document"
  - "RED stub = exports with inert behaviour, so the target test fails on its assertion"

requirements-completed: [EVL-02]

coverage:
  - id: D1
    description: "Seeded compiler census and sampler: ordered, deterministic candidates per category with a skip continuation (OQ7)"
    requirement: EVL-02
    verification:
      - kind: unit
        ref: "scripts/eval/draft-census.test.ts#continuation: sample with skip returns the next candidates of the same ordered list"
        status: pass
    human_judgment: false
  - id: D2
    description: "50 scored and 5 pilot questions with oracle keys, enforced by the validity tests (mix, forbidden words, names the target, no unexplained, abstain keys, pilot disjoint, candidates accounted)"
    requirement: EVL-02
    verification:
      - kind: unit
        ref: "scripts/eval/questions.test.ts#category mix is callers 11, references 5, heritage 5, emit 7, adr 7, impact 4, definition 5, abstain 6"
        status: pass
      - kind: integration
        ref: "node scripts/eval/oracle.ts check --repo <prepared gsd-core> --tsconfig tsconfig.json --questions scripts/eval/questions/gsd-core.questions.json --answers scripts/eval/questions/gsd-core.answers.json"
        status: pass
    human_judgment: false
  - id: D3
    description: "Human review document generated from the committed files, byte-identical on every run"
    requirement: EVL-02
    verification:
      - kind: unit
        ref: "scripts/eval/draft-census.test.ts#stale review document: the committed file is exactly what the committed question files render to"
        status: pass
    human_judgment: false
  - id: D4
    description: "The user approves the question set (D-01); the set is reviewed and frozen at plan 03-16"
    verification: []
    human_judgment: true
    rationale: "D-01 requires the user to review and approve the drafted questions; no automated check can approve them"

duration: 24min
completed: 2026-10-18
status: complete
---

# Phase 03 Plan 09: Seeded question set for the pre-registered eval Summary

**50 scored and 5 pilot gsd-core questions chosen by a seeded one-pass sampler over a compiler-derived census, with oracle keys, every rejection on record and a generated review document; the agent wrote only the question texts.**

Drafted without running atlas: yes

(Attestation, also in `docs/eval/questions-review.md`: the candidates came from the oracle's TypeScript program, the texts were written by reading source and `git grep` on the prepared gsd-core checkout, and no `gsd-atlas` command, atlas MCP tool or code-intelligence server touched the gsd-core checkout while questions were chosen or written. CodeGraph was used only to read this repository's own `scripts/eval` sources, never the corpus.)

## Performance

- **Duration:** about 24 min
- **Started:** 2026-10-18T05:37Z
- **Completed:** 2026-10-18T06:01Z
- **Tasks:** 3 of 3 (task 1 was the tracer)
- **Files:** 9 created, 2 modified

## Accomplishments

- `buildCensus` lists, from the oracle's own program: 581 callers candidates, 1,255 references, 19 heritage (including library types `Error`, `Record`, `TypeError`), 518 emit (268 outputs, 250 consumers), 725 ADR (74 cited numbers with files, 651 declarations that cite ADRs), 581 impact, 1,294 definition and 246 abstain (241 near-miss names, 5 ADR numbers cited with no ADR file). The whole census and draft take about 10 s on gsd-core.
- `orderCandidates` sorts by file, name and group, then shuffles with a local `mulberry32` (seed 20261017 xor a per-category salt); `sample(..., {skip})` is the deterministic continuation OQ7 asks for.
- `draftCandidates` made 6 rejections in total, all on the closed list: `ambiguous-name` 5 (a name declared 2 or 3 times: `validateRequirement`, `stateFieldValue`, `CleanupManifestEntry`, `analyzeCoverage`, `withLedgerLock`) and `too-large` 1 (ADR 2143, 31 citing files). The other four reasons did not fire on this corpus. Rejected entries are listed in the review document by reason.
- The scored set meets the mix exactly and the pilot covers references, adr, impact, definition and abstain with subjects disjoint from the scored set and the scan questions.
- Answers files carry the preparation record: `npm ci --ignore-scripts` ran, TypeScript 6.0.3, package-lock sha256 `dccc7f1c...b357fb`, corpus sha `10ac3a7a947903ba50f538a907af036744d759d5`. `node scripts/eval/oracle.ts check` against the prepared checkout exits 0 for both sets.

## Task Commits

1. **Task 1 (tracer): census and seeded sampler** - RED `a5360e1` (test), GREEN `0969d4a` (feat)
2. **Task 2: scored and pilot sets, keys, validity tests** - RED `85eecda` (test), GREEN `22f61b2` (feat)
3. **Task 3: review document** - RED `9289924` (test), GREEN `ed00e4b` (docs)

**Plan metadata:** the docs commit that adds this file.

## TDD Gate Compliance

All three tasks have a `test(03-09)` commit before their `feat`/`docs` commit; every RED used an inert stub so the target test failed on an assertion.

- **RED 1** (`a5360e1`): `node --test --test-reporter=tap scripts/eval/draft-census.test.ts` exit 1, 9 of 11 failing. Classifier (`check tdd-red-evidence`, target `continuation: sample with skip returns the next candidates of the same ordered list`): `RED_EVIDENCE_OK`. Semantic assessment: the target ran and failed on `head.length === 2` because the stub `sample` returned an empty list; intended reason.
- **RED 2** (`85eecda`): exit 1, 28 of 45 failing. Target `category mix is callers 11, ...`: `RED_EVIDENCE_OK`. Semantic assessment: failed on the assertion that `scripts/eval/questions/gsd-core.questions.json` is committed (files absent); the `draft-census` cases failed on assertions against the inert `decide`, `projectedSize`, `pickPilotCategories` and `draftCandidates` stubs. A few `decide` cases (accepted, abstain accepted) passed against the stub, which is expected for an accept-everything stub and is covered by the rejection cases that failed.
- **RED 3** (`9289924`): exit 1, 6 of 38 failing. Target `stale review document: ...`: `RED_EVIDENCE_OK`. Semantic assessment: failed on the assertion that `docs/eval/questions-review.md` is committed; the other review cases failed on assertions against the stub `renderReview`.

No REFACTOR commits.

## Files Created/Modified

- `scripts/eval/draft-census.ts` - census, sampler, closed rules, drafting pass, scaffold/stamp/list/review commands
- `scripts/eval/draft-census.test.ts` - 38 tests (census on the oracle fixture, ordering, rules, drafting on the fixture, review document)
- `scripts/eval/questions.test.ts` - 15 validity tests over the committed files
- `scripts/eval/questions/*.json` - candidates, questions and answers
- `docs/eval/questions-review.md` - generated review document (575 lines)
- `scripts/eval/oracle.ts` - exports only, one cache, three small additions (see deviations)
- `scripts/eval/questions.ts` - `p-` ids and an optional `preparedRecord`

## Decisions Made

See `key-decisions`. In addition: the abstain set is 4 absent-symbol questions (near-miss names derived from real function names by one word swap: `lookupUiSpecInDir`, `lookupPristineInGit`, `makeHookBus`, `resolveProgressTable`) and 2 ADR numbers cited in code with no ADR file (123, 2481); the plan's "path that does not exist" case is `resolveProgressTable` asked of `src/progress-table.cts`, which does not exist (the abstain key has no path probe, so the symbol probe carries it).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `QuestionSchema.id` rejected the plan's pilot ids**
- **Found during:** Task 2 (pilot file `p-001`..`p-005` must be a `QuestionFile`)
- **Issue:** `questions.ts` required `^q-\d+$`.
- **Fix:** `^[qp]-\d+$`, message updated. No other test depended on the old text.
- **Files modified:** scripts/eval/questions.ts
- **Commit:** 0969d4a

**2. [Rule 3 - Blocking] `AnswerFileSchema` is strict and had no `preparedRecord`**
- **Found during:** Task 2 (the plan wants `{oracleVersion, repoSha, preparedRecord, answers}`)
- **Fix:** optional `preparedRecord` (corpusId, sha, npmCi, typescriptVersion, lockSha256) in `questions.ts`; `oracle.ts keys` is unchanged and `draft-census.ts stamp` adds the record afterwards. The record omits `dir` (a throwaway absolute path); `questions.test.ts` requires the record on the committed files.
- **Files modified:** scripts/eval/questions.ts, scripts/eval/draft-census.ts
- **Commit:** 0969d4a, 22f61b2

**3. [Rule 2 - Missing critical] `oracle.ts` helper exports and three additions**
- **Found during:** Task 1
- **Issue:** the plan says to export the reusable helpers. Beyond adding `export` to 30 existing functions and types, three things were added: `exportedTargets(state, unit, accept)` (with `exportedFunctions` now calling it, same result), `resolveHeritageSymbol` (the clause resolver lifted out of `heritageKey`), `isFunctionLikeDeclaration`, and a per-source-file cache in `requireCallsTo` (the scan is the same for every symbol of a file; without it the census would repeat it for every export).
- **Verification:** `oracle.test.ts` 34 of 34, `score.test.ts` and the full scripts suite (685 pass, 1 skipped) unchanged; `ORACLE_VERSION` is still `03-04.1` because no key changed. The 03-16 freeze will hash this edited file.
- **Files modified:** scripts/eval/oracle.ts
- **Commit:** 0969d4a

### Plan wording interpreted

- `sample` takes the census: `sample(census, category, n, {seed, skip})`, like `orderCandidates(census, category, seed)`.
- The plan's task 1 describes the command mode as a skeleton with all candidates `unused`; that is the plain command. Drafting is the `draft` subcommand, and `list`, `scaffold`, `stamp` and `review` were added around it.
- "Reserve five accepted candidates ... for the pilot before filling the scored quotas" is implemented inside the single pass (see key-decisions); `draftCandidates` also takes explicit `pilotCategories` so the 3-function fixture can be tested.
- `candidates.json` keeps every ordered candidate (1.16 MB) as the plan words it, one record per line. If that is too large for review, a compact form with a count for the unused tail is a small change.
- `references`, `heritage`, `emit`, `definition` and `impact` questions use whole-file granularity or `file+line`/`file+symbol` as listed in key-decisions; the plan did not fix granularity per category.

### Environment

- A worktree-local CodeGraph index was created (`codegraph init -y`) to be able to read the new `draft-census.ts` through the Memtrace guard, and removed before returning. A shell variable path and the word `eval` in a command were refused by the worktree guard; commands were split or moved into scratchpad scripts. No guard was bypassed.

**Total deviations:** 3 auto-fixed (2 Rule 3, 1 Rule 2) plus the interpretations above. **Impact:** none on the registered mix or the rules; the two schema edits and the oracle exports are the only changes to files that plan 03-16 will hash.

## Issues Encountered

None that blocked the work. Findings for the 03-16 review:

- **Many small answers.** 21 of the 44 non-abstain scored questions expect exactly one answer (all five definition questions, most heritage and emit-output questions, three of five references questions whose only use is in the defining file). That is what the unbiased order produced, and the only rejections allowed are the closed rules, so it is left as drawn. If the user wants harder questions, raise N: `sample(..., {skip})` continues the same order.
- **Impact depth two** follows the oracle's rule: files that call any function exported by a `.cts` file that calls the subject. The question text says so; this is wider than "calls a function that calls it". 03-14/03-16 should keep text and rule together.
- **Callers keyed at file granularity** avoid enclosing-function names, which are anonymous in many test files.
- **adr-of** questions ask for the cited ADR files only (unresolved citations were rejected as `unexplained`), so a model is never asked for a file that does not exist.

## Known Stubs

None. The scaffold placeholder text (`TODO write the question text ...`) exists only in the scaffold command; no committed question carries it, and `questions.test.ts` requires the closing sentence in every text.

## Threat Flags

None. The only new surface is `draft-census.ts` running `git` with argument arrays and reading the prepared checkout (read-only) and the committed question files; T-03-91, T-03-92 and T-03-93 are covered by the seeded closed-rule pass, the forbidden-word and hygiene tests, and texts written from facts rather than pasted from comments.

## User Setup Required

None.

## Next Phase Readiness

- 03-14 (pilot): `pilot.questions.json` and `pilot.answers.json` are ready; a larger N continues with `sample(census, category, n, {seed: 20261017, skip})`.
- 03-16 (freeze): the user reads `docs/eval/questions-review.md`; `draft-census.ts review` regenerates it, and `questions.test.ts` plus the stale-document test guard the committed files. `oracle.ts`, `questions.ts` and `draft-census.ts` carry the edits listed above.
- Re-preparing the corpus for a rerun: `node scripts/eval/prepare-corpus.ts --corpus gsd-core --dest <dir>`, then `node scripts/eval/draft-census.ts draft --repo <checkout> --tsconfig tsconfig.json --seed 20261017 --out <file>` reproduces `candidates.json` byte for byte.

## Self-Check: PASSED

- Files present: scripts/eval/draft-census.ts, draft-census.test.ts, questions.test.ts, scripts/eval/questions/{candidates,gsd-core.questions,gsd-core.answers,pilot.questions,pilot.answers}.json, docs/eval/questions-review.md
- Commits reachable from HEAD: a5360e1, 0969d4a, 85eecda, 22f61b2, 9289924, ed00e4b
- `node --test scripts/eval/questions.test.ts scripts/eval/draft-census.test.ts`: 53 pass, 0 fail; `node --test "scripts/**/*.test.ts"`: 685 pass, 0 fail, 1 skipped; `npm run typecheck` clean
- `oracle.ts check` against the prepared checkout: exit 0 for the scored and the pilot set
- Acceptance: 50 and 5 questions; test titles present; candidates.json has 6 rejected entries with reasons; review document has 50 `### q-` blocks, one attestation line, and two runs give the same sha256 (`b84e95d3...fee`)
