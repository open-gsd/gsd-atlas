---
phase: 03-typescript-module-and-mvp-eval
plan: 14
subsystem: testing
tags: [eval, pilot, oracle, questions, cost-projection, power, gsd-core]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-09 question set and draft-census; 03-10 harness and arms; 03-11 scorer; approved constants (03-CONSTANTS.md)"
provides:
  - "docs/eval/pilot.md: 10-session pilot (cost, wall time, tool use, disagreement), projection to N = 50/75/100, power table, ten findings, proposed constants, and the user's decisions"
  - "docs/eval/pilot/results.jsonl and sessions.meta.jsonl: compact rows, no transcripts"
  - "harness --stop-at-cost-usd; answer schema without a draft $schema key; init check that accepts StructuredOutput"
  - "oracle 03-14.1: follows computed require paths (path.join/resolve/normalize/dirname over __dirname, const bindings, templates)"
  - "draft-census scaledMix(N) and draft --total/--previous: continue a committed candidates file for a larger N"
  - "75 scored questions (q-001 to q-075) with oracle keys, 5 pilot questions, regenerated review document"
  - "03-CONSTANTS.md: eval.maxBudgetUsdPerSession 3, eval.sessionWallClockMs 900000, eval.scoredQuestions 75"
affects: [03-16 pre-registration freeze, 03-35 scored run]

requirements-completed: [EVL-02, EVL-03]

status: complete
actuals:
  tasks: 3
  commits: 9
plan_head_before: 97d96c705f2bb9926254fba986045c84537a1cf6
plan_head_after: see the docs commit that adds this file

key-files:
  created:
    - docs/eval/pilot.md
    - docs/eval/pilot/results.jsonl
    - docs/eval/pilot/sessions.meta.jsonl
  modified:
    - scripts/eval/oracle.ts
    - scripts/eval/oracle.test.ts
    - scripts/eval/draft-census.ts
    - scripts/eval/draft-census.test.ts
    - scripts/eval/questions.test.ts
    - scripts/eval/questions/gsd-core.questions.json
    - scripts/eval/questions/gsd-core.answers.json
    - scripts/eval/questions/pilot.answers.json
    - scripts/eval/questions/candidates.json
    - docs/eval/questions-review.md
    - scripts/eval/harness.ts
    - scripts/eval/arms.ts
    - scripts/eval/answer-schema.json
    - .planning/phases/03-typescript-module-and-mvp-eval/03-CONSTANTS.md

key-decisions:
  - "User reply to the blocking checkpoint, verbatim: `n75 keep-scan fix-oracle` (recorded in docs/eval/pilot.md Decisions and in 03-CONSTANTS.md Approvals)"
  - "N = 75; bounds keep the scan values (3 USD, 900000 ms), not the pilot rule's 1 USD and 60000 ms"
  - "The extension is a continuation of the committed candidates order, not a fresh draw, because the census depends on the oracle and a fresh draft with the fixed oracle reshuffles every category"
  - "Rejections on record stay rejected under the fixed oracle; earlier accepted candidates are decided again and all 50 still pass"
  - "The pilot rows are not rewritten after the key change; pilot.md says which key they were scored against"

coverage:
  - id: D1
    description: "Pilot of 5 questions x 2 arms x 1 run measured cost, wall time, tool use and disagreement; projection and power table produced by the harness project command"
    requirement: EVL-03
    verification:
      - kind: integration
        ref: "docs/eval/pilot/results.jsonl (10 rows, all status ok) and docs/eval/pilot.md Projection"
        status: pass
    human_judgment: false
  - id: D2
    description: "Oracle follows computed require paths; the pilot's blind spot (Findings 7) is closed"
    requirement: EVL-02
    verification:
      - kind: unit
        ref: "scripts/eval/oracle.test.ts#computed require paths: path.join and path.resolve over __dirname, constants and templates are followed"
        status: pass
    human_judgment: false
  - id: D3
    description: "Scored set extended to 75 with the declared mix, oracle keys and the validity tests parameterised by N"
    requirement: EVL-02
    verification:
      - kind: unit
        ref: "scripts/eval/questions.test.ts#category mix is the declared mix for N: at least 50 questions, with the 50 mix as a floor in every category"
        status: pass
      - kind: unit
        ref: "scripts/eval/draft-census.test.ts#scaledMix"
        status: pass
      - kind: integration
        ref: "node scripts/eval/oracle.ts check --repo <prepared gsd-core> --tsconfig tsconfig.json --questions scripts/eval/questions/gsd-core.questions.json --answers scripts/eval/questions/gsd-core.answers.json (exit 0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "N, the per-session bounds and the oracle fix are the user's decision"
    verification: []
    human_judgment: true
    rationale: "The reply `n75 keep-scan fix-oracle` is recorded verbatim; no automated check can make the choice. The user still approves the frozen question files and constants at plan 03-16."

completed: 2026-10-18
---

# Phase 03 Plan 14: Pilot, N and run bounds Summary

**A 10-session pilot costing 0.46 USD in all, a projection of 8 to 17 USD for the full run at N = 50 to 100, the user's choice of N = 75 with the scan bounds (3 USD, 900000 ms), and a fix of the oracle blind spot the pilot exposed, with all 75 keys recomputed.**

Drafted without running atlas: yes (the 25 added questions come from the committed seeded order and the closed rules; the texts follow the existing templates from the key specs; no atlas command or tool was run, and no pilot outcome was used to choose or word any of them)

## Performance

- **Tasks:** 3 of 3 (Task 1 pilot harness and run, Task 2 blocking checkpoint, Task 3 decision)
- **Live spend:** 0.4555 USD in Tasks 1 and 2 (11 model-reaching pilot sessions plus one account check); none in Task 3

## Accomplishments

- Task 1 and 2 (earlier executor): three harness defects fixed (draft `$schema` key refused by `claude --json-schema`, init check rejecting the `StructuredOutput` tool, no running-cost stop), then the pilot ran. Atlas calls happened in 2 of 5 atlas sessions, both empty from the grammar tier, so atlas-arm tokens were higher on every pair (mean +31 percent) and the arms agreed on 5 of 5 questions. Full numbers are in `docs/eval/pilot.md`.
- The user's reply (`n75 keep-scan fix-oracle`) is recorded verbatim in `docs/eval/pilot.md` Decisions and `03-CONSTANTS.md` Approvals. The two deferred eval rows now hold 3 and 900000, and a new row `eval.scoredQuestions` holds 75. The Status line stays `Approved`; the Approvals entry says these values are approved by the later reply and that 03-16 still records them in the pre-registration.
- Oracle fix (`foldPath` in `scripts/eval/oracle.ts`, version `03-14.1`): a computed `require(...)` counts when its argument folds statically. Test first (red on the missing consumers), then green. Not followed, by design: `process.cwd()`, function parameters, `os.homedir()`, non-`const` bindings.
- Recomputing the 50 earlier keys with the fixed oracle against the same prepared checkout: 9 grew, none shrank or changed otherwise (`q-001`, `q-006`, `q-008`, `q-009` now with `bin/install.js`, `q-011`, `q-014`, `q-022`, `q-036`, `q-037`); `p-001` gained `tests/git-base-branch.test.cjs`. All 50 still pass the acceptance rules, so no earlier question was replaced and ids and subjects are unchanged.
- `scaledMix(N)` and `draft --total N --previous candidates.json` produce the 75 mix (callers 17, references 8, heritage 8, emit 10, adr 10, impact 6, definition 7, abstain 9) by continuing the committed order. The 25 new subjects (`q-051` to `q-075`) are the next acceptable candidates; the new rejections were 2 (`clampPercent` unexplained, `escapeRegex` too-large at 60 files) plus 1 `ambiguous-name` (`FieldSource`), all on the closed list.
- `questions.test.ts` takes its expected counts from the file length through a declared mix table (50 and 75), not a hard-coded 50; the review document test uses the file length.

## Task Commits

1. **Task 1 (earlier executor):** `dc912be`, `e6143a0`, `1e0c47d`, `9a56080`; merged by `46b87c0`
2. **Task 2:** blocking checkpoint, answered by the user
3. **Task 3:** `aeae4ac` (fix, oracle), `ae12cdb` (feat, draft-census continuation), `9e98f4c` (feat, question set to 75), `08530e1` (docs, N and bounds)

## TDD Gate Compliance

The oracle fix and the continuation both had their tests written and failing first (`computed require paths` failed on the missing `tools/dyn.cjs` consumers; `draft-census.test.ts` failed on the missing `scaledMix` export). They were committed together with their implementation, not as separate `test` commits, so there is no standalone RED commit for this task.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] The plan's `sample(category, n, {seed, skip})` continuation could not be used as written**
- **Found during:** Task 3, extending to N = 75
- **Issue:** the candidate list depends on the oracle (the census counts calls through it). After the oracle fix a fresh census gives a different list and a different shuffle, so `sample` with `skip` would have replaced the first 50 questions.
- **Fix:** `draftCandidates` takes `previous`, a committed candidates file: its order is kept, decisions on record stay, accepted candidates are decided again and keep their ids, new ones continue the numbering. `candidates.json` is now the 75-question file (oracle `03-14.1`).
- **Verification:** `draft-census.test.ts` (continuation cases) and a diff of the new file against the old one showing only the 9 grown keys, `p-001`, and the added decisions.

### Environment

- In this worktree `npm test` shows 4 failures in the build and pack tests because there is no `node_modules/typescript` inside the worktree; with a temporary `node_modules` symlink to the main checkout the whole suite passes (3,157 tests, 3,156 pass, 0 fail, 1 skipped). The symlink was removed afterwards. `npm run typecheck`, `lint` and `build` pass.
- The prepared checkout used for the keys is the one the pilot used (`npm ci --ignore-scripts`, TypeScript 6.0.3, lock sha256 `dccc7f1c...b357fb`, corpus sha `10ac3a7a947903ba50f538a907af036744d759d5`).

## Issues Encountered

- Keys are still bounded by static folding: a use built from a runtime value is not in any key. This is the same honest limit as before, now smaller; the `unexplained` cross-check is unchanged and every committed key has none.
- The pilot rows were scored against the old `p-001` key and were not rewritten. Both arms' answer for `p-001` matches the new key, so under it those two cells would be correct.

## Known Stubs

None.

## Threat Flags

None. The new code reads files and folds expressions; it executes nothing and adds no network or command surface.

## User Setup Required

None.

## Next Phase Readiness

- Plan 03-16 (freeze) can register N = 75 (`eval.scoredQuestions`), the two bounds, the oracle `03-14.1` and the regenerated question and answer files. `STAGE_A_FILES` was not touched here. The user still reviews `docs/eval/questions-review.md` (now 75 scored plus 5 pilot questions) before the freeze.
- Follow-ups for 03-16 and later: the harness and the registration still need to carry the two bound values; the atlas arm's tool-use rate in the pilot was low (2 of 5 sessions) and the skill body could not be loaded (no `Skill` tool), which the scored run should re-check once the precise tier is in; concurrency 2 is untested.

## Self-Check: PASSED

- 75 scored questions and 5 pilot questions have keys; `oracle.ts check` exits 0; `typecheck`, `lint`, `build` pass; the full test suite has 0 failures.
