# Eval pilot (plan 03-14)

This is a cost and variance pilot, not a result. It ran five pilot questions through both arms once (10 scored sessions) against the Phase 2 grammar-tier atlas and the v0 skill, so it estimates what the scored run will cost and how much the arms disagree, and says nothing about whether atlas meets the accuracy or token claim. Every number below is an estimate from ten short sessions on five questions. The projection assumes the precise tier changes the atlas arm's tokens but not the grep arm's. The pilot questions (`p-001` to `p-005`) are disjoint from the scored set, and nothing here was used to choose, drop, reword or add a scored question.

## Setup

| Item | Value |
| --- | --- |
| Claude Code | 2.1.302 |
| Model id | `claude-sonnet-5-5` (the Claude Code default; no `--model` flag; read from every session's init event) |
| Corpus | gsd-core at `10ac3a7a947903ba50f538a907af036744d759d5` |
| Prepared record | `npmCi: true`, `node_modules/typescript` 6.0.3, `package-lock.json` sha256 `dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb`, prepared by `prepare-corpus.ts` with `npm ci --ignore-scripts` in a throwaway directory |
| Atlas | `dist/` built from commit `97d96c705f2bb9926254fba986045c84537a1cf6` (Phase 2 grammar tier, no precise tier); six tools registered (`code_explain` does not exist yet) |
| Skill | `skills/gsd-atlas/SKILL.md`, sha256 `daa8232ba6f0ed03e01ead05a5c266c26511bb630ea21018e856cf4bfc374884` |
| Answer schema | `scripts/eval/answer-schema.json` sha256 `6da389ecb51825629b7770a562b88db67e245d775f7ec903475df97f6c03b72a` (after the fix in Findings 1) |
| Arms file | `scripts/eval/arms.ts` sha256 `e33cc7066d5a3384580baef78d54db1433d98c1ca7b03022a92681a795fd4c31` (after the fix in Findings 2) |
| Flags | `claude -p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --mcp-config <per-session> [--plugin-dir <skill plugin>] --tools Bash,Read --allowedTools <read-only shell patterns, Read, atlas tools> --max-budget-usd 3 --json-schema <answer schema> --no-session-persistence` |
| Bounds | `--max-budget-usd 3`, wall clock 900000 ms (the approved `scan.*` values); concurrency 1; seed 20261017; harness-side cost stop at 32 USD (80 percent of the 40 USD pilot ceiling), never approached |
| Isolation | one throwaway clone of the prepared checkout per session, one atlas store and one empty user directory per session; the atlas index is built before the clock (about 5.9 s per atlas session, 3,977 files) and is not in the token count |

## Purpose and limits

See the first paragraph. Two further limits. The five questions were easy: no session ran longer than 14.1 s or 7 tool calls, so the cost and wall-time maxima below are lower than the scored run's maxima will be (emit-mapping and impact questions at N = 50 or more will be harder). And the atlas arm made atlas calls in only 2 of 5 sessions, both returning empty results from the grammar tier, so the atlas-arm token figures here mostly measure the fixed cost of carrying the skill and the tool definitions, not the cost of using them.

## Results

One row per question and arm. Tokens by kind are the session's reported usage (input, output, cache creation, cache read); billable is their sum (D-06). Tool calls include the final `StructuredOutput` call that `--json-schema` adds to every session. "Init" is the registered-environment check of the session's init event.

| Question | Arm | Correct | Input | Output | Cache creation | Cache read | Billable | Tool calls | Atlas calls | Wall (s) | Cost (USD) | Init |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| p-001 references | atlas | no | 4 | 608 | 5,198 | 15,606 | 21,416 | 3 | 1 | 5.9 | 0.0284 | ok |
| p-001 references | grep | no | 4 | 478 | 4,544 | 9,560 | 14,586 | 2 | 0 | 5.7 | 0.0239 | ok |
| p-002 adr | atlas | no | 6 | 556 | 4,266 | 25,119 | 29,947 | 3 | 0 | 6.0 | 0.0251 | ok |
| p-002 adr | grep | no | 6 | 581 | 3,979 | 15,910 | 20,476 | 3 | 0 | 5.9 | 0.0233 | ok |
| p-003 impact | atlas | no | 12 | 1,088 | 5,937 | 56,770 | 63,807 | 6 | 0 | 10.6 | 0.0403 | ok |
| p-003 impact | grep | no | 12 | 1,561 | 9,009 | 46,783 | 57,365 | 7 | 0 | 14.1 | 0.0563 | ok |
| p-004 definition | atlas | yes | 6 | 330 | 3,452 | 25,017 | 28,805 | 3 | 0 | 6.2 | 0.0196 | ok |
| p-004 definition | grep | yes | 6 | 323 | 3,156 | 15,810 | 19,295 | 3 | 0 | 8.2 | 0.0174 | ok |
| p-005 abstain | atlas | yes | 4 | 291 | 9,714 | 9,305 | 19,314 | 3 | 1 | 4.5 | 0.0427 | ok |
| p-005 abstain | grep | yes | 4 | 228 | 157 | 12,284 | 12,673 | 2 | 0 | 3.9 | 0.0041 | ok |

Per arm (five sessions each): atlas mean billable 32,658 tokens, mean cost 0.0312 USD, mean wall 6.6 s, mean tool calls 3.6; grep mean billable 24,879 tokens, mean cost 0.0250 USD, mean wall 7.6 s, mean tool calls 3.4. All ten sessions finished with status `ok`; none timed out, hit the budget or was killed. Cost depends on how warm the prompt cache was when the session started (compare the cache-creation column for `p-005`), so single-session costs are noisy; the totals are not.

Spend by this plan, in USD: the ten scored sessions 0.2814 (atlas 0.1562, grep 0.1252); one session discarded by a harness defect (Findings 2) 0.0281; the single trivial call that checked the account works 0.1460. Total 0.4555, against the 40 USD ceiling and the 32 USD stop line. Sessions that reached the model: 11 (ten scored, one discarded). One more start failed in argument validation before any model call (Findings 1).

Compact rows and session meta are committed in `docs/eval/pilot/results.jsonl` and `docs/eval/pilot/sessions.meta.jsonl`. No transcript is committed; scratch paths in the meta file are replaced by `<scratch>`. The meta file keeps the two `contaminated` records of the failed starts, which are the evidence for Findings 1 and 2.

## Findings

1. **Harness defect, fixed: the answer schema was refused by `claude --json-schema`.** The first start failed before any model call with `--json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. Fix: the `$schema` key is removed from `scripts/eval/answer-schema.json`, with a test (`score.test.ts`) that keeps it out. The keywords left are valid in every draft. Cost: none.
2. **Harness defect, fixed: the init check rejected the `StructuredOutput` tool.** Passing `--json-schema` makes Claude Code add its own `StructuredOutput` tool to the session, in both arms. `checkInit` called it an extra tool, so the second start's grep session (which had answered correctly) was discarded as `contaminated` and stopped the run. Fix: `scripts/eval/arms.ts` accepts `StructuredOutput` if present, in both arms; any other extra tool is still named; test added in `harness.test.ts`. The affected cell (`p-005|grep|1`) was run again; its discarded session cost 0.0281 USD and is not in the rows. This is the one reason there are 11 model-reaching sessions for 10 scored cells.
3. **Harness addition: running-cost stop.** The harness had no cost stop, so `runAll` now takes `stopAtCostUsd` (flag `--stop-at-cost-usd`): scheduling stops when the rows in the results directory have cost that much; rows already on disk count, and a session with no reported cost counts at its budget cap. The pilot passed 32; the total never exceeded 0.29.
4. **Isolation checks (raw streams inspected for all ten sessions).** No session read an answer key, a question file, the preregistration or any path outside its clone: every `Read`/`Bash` argument was scanned for `answers`, `questions`, `scripts/eval`, `.planning`, `oracle` and the repository path, with no hit. No session ran a write-like command (the one scan hit on `p-003.grep` was `2>/dev/null` in a read-only `grep`), none was refused a permission, and no file in any kept clone is newer than its session start. The init event of every session matches the arm's registered environment (apart from the two fixed defects above).
5. **The atlas skill reached the session, its body could not be loaded.** In 5 of 5 atlas sessions the init event lists the skill as `gsd-atlas-eval:gsd-atlas`; in 0 of 5 grep sessions. The built-in tool list is `Bash`, `Read`, `StructuredOutput` plus six atlas tools: there is no `Skill` tool, so a skill body cannot be loaded and there were 0 skill invocations (the skill's description is all the model can see). The atlas tools were called in 2 of 5 atlas sessions (`code_find` on `p-005`, `code_refs` on `p-001`, one call each); both returned empty results from the grammar tier and the session then used grep. Both arms also list 19 skills bundled with Claude Code (`deep-research`, `design`, `verify` and others); they are the same in both arms and cannot invoke anything either (no `Skill` tool).
6. **Token and cost direction in the pilot is against atlas.** Atlas billable tokens were higher on every pair (mean +31 percent) and cost +25 percent, with the same accuracy. This is what the pilot expects while atlas carries the skill description and six tool definitions but its tools return nothing useful. It says nothing about the precise tier. The token criterion is the claim most at risk and the scored run will test it.
7. **Answer-key defect found by reading the sessions (oracle, not fixed here).** Both arms answered `p-001` with `gsd-core/bin/gsd-tools.cjs` and `tests/git-base-branch.test.cjs`; the key lists only the first. The test file calls `gitBaseBranch.cmdGitBaseBranch(...)` at lines 448, 462, 482 and more, so by the question's own wording it is a use. The oracle misses it because the test loads the module with a computed path, `require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'git-base-branch.cjs'))` (line 348), and the git-grep cross-check did not report it as unexplained (`unexplained` is empty). The same class affects the scored keys: `q-009` (`setJsoncValue`) omits `bin/install.js`, which loads `jsonc-edit.cjs` with `require(path.join(_gsdLibDir, 'jsonc-edit.cjs'))` (line 793) and calls `setJsoncValue` at line 9565. A rough screen found 13 of the 20 scored references, callers and impact keys with a whole-word mention of the symbol in a code file outside the key; many of those are legitimately excluded (comments, strings, a different symbol with the same name), so 13 is an upper bound on candidates, not a count of errors. This file does not own the oracle and the keys are scored data, so nothing was changed. See the Decisions section.
8. **Other incorrect answers.** `p-002`: both arms added `tests/planner-estimate-emission.test.cjs`, whose only mention is `'ADR-2629 Decision 5: ...'` inside a string, not a comment; the question asks for citations in code comments and the key excludes it (`excludedNonComment: 1`), so the key is right and both arms erred. `p-003` (impact, depth two): grep added `src/capability-lifecycle.cts`; atlas missed four files the key lists. Whether the key's depth-two set is right was not checked.
9. **Disagreement is 0 of 5.** The arms gave the same verdict on every question (two correct, three incorrect in both). With three of five questions incorrect in both arms for the reasons above, the pilot's accuracy figures carry no information about the arms.
10. **Wall time and index.** Mean session 7.1 s (longest 14.1 s). Building the atlas index took 5.8 to 6.0 s per atlas session and `maintain resolve` about 0.14 s; both are outside the token count and the session clock.

## Projection

Produced by `node scripts/eval/harness.ts project --out-dir docs/eval/pilot --questions <N> --runs 3` (an estimate from 10 pilot sessions, not a quote). Cost uses the per-session mean cost of each arm in the pilot.

| N (questions) | Sessions (N x 3 runs x 2 arms) | Atlas arm (USD) | Grep arm (USD) | Total (USD) | Sequential wall time of the sessions only |
| ---: | ---: | ---: | ---: | ---: | --- |
| 50 | 300 | 4.69 | 3.76 | 8.44 | about 36 minutes, plus about 15 minutes of index builds |
| 75 | 450 | 7.03 | 5.63 | 12.66 | about 53 minutes, plus about 22 minutes of index builds |
| 100 | 600 | 9.37 | 7.51 | 16.89 | about 71 minutes, plus about 30 minutes of index builds |

Wall time is 7.1 s per session times the session count, and 5.9 s of build per atlas session; the approved concurrency of 2 roughly halves both. Treat the cost as a floor: the pilot questions were short, the precise tier will return real results (more tool output, more turns), and harder questions run longer. Even at five times the projected cost, N = 100 stays under 85 USD. The pilot ran at concurrency 1; whether concurrency 2 raises rate-limit retries is untested.

## Power

Paired by question, the lower bound of the accuracy difference sits `1.645 * sd / sqrt(N)` below the observed difference (`project` prints this). The true accuracy advantage atlas needs for the lower bound to clear the 5-point margin is that offset minus 5 points (zero if the offset is under 5).

Observed in the pilot: the paired-difference standard deviation is 0.0000 over 5 questions and the disagreement rate is 0 of 5, so the offset is 0.00 points at every N. That is an artefact of five questions on which the arms agreed, three of them wrong for reasons outside the arms (Findings 7 and 8); it is not an estimate of the scored run's variance and is not used below.

What the scored run needs, for assumed disagreement rates (a question counts as disagreeing when the arms' run-mean correctness differ). With differences of plus or minus one, `sd = sqrt(p)`; with three runs per cell the differences are finer, so this is an upper bound. These rows are assumptions, not pilot measurements:

| Assumed disagreement p | sd (upper bound) | N = 50: offset / needed advantage | N = 75: offset / needed advantage | N = 100: offset / needed advantage |
| ---: | ---: | --- | --- | --- |
| 5 percent | 0.224 | 5.2 / 0.2 points | 4.2 / 0 | 3.7 / 0 |
| 10 percent | 0.316 | 7.4 / 2.4 points | 6.0 / 1.0 points | 5.2 / 0.2 points |
| 20 percent | 0.447 | 10.4 / 5.4 points | 8.5 / 3.5 points | 7.4 / 2.4 points |
| 30 percent | 0.548 | 12.7 / 7.7 points | 10.4 / 5.4 points | 9.0 / 4.0 points |

The research's illustrative sd values give the same shape: sd 0.30 needs 2.0, 0.7 and 0 points at N = 50, 75 and 100; sd 0.45 needs 5.5, 3.5 and 2.4 points. Raising N from 50 to 100 lowers the needed advantage by roughly 2 to 3 points at 10 to 20 percent disagreement and doubles the cost; at this cost scale (under 17 USD for N = 100) the cost is not the constraint, drafting and reviewing 25 or 50 more questions is. No N rescues a bad key set: the oracle defect in Findings 7 adds the same error to both arms or favours whichever arm finds the omitted files.

## Proposed constants

By the rule in the plan: twice the highest observed session cost, rounded up to a whole dollar; twice the highest observed wall time, rounded up to a whole minute.

| Key | Highest observed | Rule | Proposed |
| --- | --- | --- | --- |
| `eval.maxBudgetUsdPerSession` | 0.0563 USD (`p-003` grep) | 2 x 0.0563 = 0.113, rounded up | **1 USD** |
| `eval.sessionWallClockMs` | 14.1 s (`p-003` grep) | 2 x 14.1 = 28.2 s, rounded up to a whole minute | **60000 ms** (1 minute) |

These are the rule's values. A caution for the decision: a session that hits either bound is scored incorrect and keeps its tokens, so a bound set from five easy questions can turn a slow-but-correct session into a failure and could do so unevenly between the arms. The bounds already used for live runs (`scan.maxBudgetUsdPerSession` 3 USD, `scan.sessionWallClockMs` 900000 ms) are far looser than the rule's values and still keep a runaway session to a few dollars; at the projected cost a looser bound costs nothing unless a session actually runs long. The reply may take either, or other numbers; these two become approved only by that reply.

## Decisions

The user answered the Task 2 checkpoint on 2026-10-18. The reply, verbatim:

> n75 keep-scan fix-oracle

What it decides, and what was done about it:

1. **N = 75 scored questions.** The projection above puts the full run at about 12.66 USD at the pilot's per-session cost (a floor), so the cost was accepted. The scored set grew from 50 to 75 questions (the pilot set of 5 is separate and unchanged in subjects). The mix is the 50 mix times 1.5 with the half-questions going to the earlier groups and abstain at 12 percent rounded half up: callers 17, references 8, heritage 8, emit 10, adr 10, impact 6, definition 7, abstain 9. The 25 new questions (`q-051` to `q-075`) are the next acceptable candidates of the same seeded order (seed 20261017) under the same closed rejection rules; nothing was dropped, reworded or chosen by hand, and no atlas tool was run to pick or write them. The pilot outcomes were not used to choose any of them. `eval.minQuestions` stays 50 (locked); the choice is recorded as `eval.scoredQuestions` in 03-CONSTANTS.md.
2. **Per-session bounds keep the scan values.** `eval.maxBudgetUsdPerSession` is 3 (USD) and `eval.sessionWallClockMs` is 900000. The rule's values (1 USD, 60000 ms) were not taken, for the reason given under "Proposed constants". Both are recorded in 03-CONSTANTS.md; plan 03-16 writes them into the pre-registration.
3. **The oracle blind spot (Findings 7) is fixed, and the keys regenerated before the freeze.** `scripts/eval/oracle.ts` now follows a computed `require` specifier when it folds statically: `path.join`, `path.resolve`, `path.normalize` and `path.dirname` over string literals, templates, `+`, `__dirname`, `__filename` and `const` bindings in the same file. Nothing is executed, and a runtime value (`process.cwd()`, a function parameter, `os.homedir()`) is still not followed, so a key can still miss a use that is built at run time; the unexplained cross-check is unchanged. Oracle version `03-04.1` became `03-14.1`.

Effect on the keys, found by recomputing all 50 earlier keys with the fixed oracle against the same prepared checkout (gsd-core at `10ac3a7a947903ba50f538a907af036744d759d5`, `npm ci --ignore-scripts`, TypeScript 6.0.3): 9 of the 50 scored keys grew and none shrank or changed otherwise: `q-001`, `q-006`, `q-008`, `q-009` (now includes `bin/install.js`), `q-011`, `q-014`, `q-022`, `q-036` and `q-037`; all 50 still pass the acceptance rules, so no earlier question was replaced. The pilot key `p-001` also changed (the expected files for `cmdGitBaseBranch` went from 1 to 2, adding `tests/git-base-branch.test.cjs`). The rows in `docs/eval/pilot/results.jsonl` were scored against the old keys and are left as they were: this document's figures stand for what ran, and `p-001` would now be scored against a key the sessions' answer (`bin/gsd-tools.cjs` and that test file) matches.

Why a continuation and not a fresh draw: the census that orders the candidates depends on the oracle, so a fresh draft with the fixed oracle reshuffles every category and would have replaced the first 50 questions. `draft-census.ts draft --total 75 --previous candidates.json` keeps the recorded order, keeps every decision on record (a candidate rejected under the old oracle stays rejected, which can only exclude, never add, a subject), decides the 50 earlier accepted candidates again, and continues down the same lists for the new slots.
