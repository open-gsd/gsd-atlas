# Angular pilot, rule v2: results of the 96 sessions (unscored, unregistered)

**Nothing here is registered or scored.** The registered verdict `OVERALL: MVP not met` stands. Rules applied: `pilot-run-plan.md` (committed as dd17121, before the first session), computed by `scripts/angular-pilot/pilot-analysis.ts`. Data (counts, tokens, statuses; no answer prose): `pilot/pilot-sessions.jsonl` (one row per session), `pilot/summary.json`, `pilot/tables.md`. The 12 calibration sessions are not pooled.

## Outcome class (applied mechanically)

**Premise: passed** (G mean 72,662 billable, floor 68,000). **Class: stop and reconsider the token gate.** Both clauses hold: (a) both A conditions have R >= 1.10 with the premise passed (A-ts 1.216, A-reg 2.250); (b) the 17 A sessions that made an atlas call averaged 238,350 billable against 103,540 for G on the same questions (per called session). Class 1 ("worth a registered run") fails for both conditions (R > 0.85). Flag also holding: adoption below 20% (A-ts 2 of 32 sessions). The key-change trigger does not hold (1 of 16 keys changed, p-313). The class is not softened here; what the owner makes of it is a decision for the owner.

## Method

- Claude Code 2.1.305, model `claude-sonnet-5-5`, subscription login (four-field filter before launch: loggedIn true, authMethod claude.ai, apiProvider firstParty, subscriptionType max; no other auth output read). All 96 init events: `apiKeySource` none, version 2.1.305. The driver strips ANTHROPIC*/CLAUDE* variables from the child.
- Questions and keys: `pilot-questions.json` / `pilot-answers.json` of this directory after the p-313 wording change (`wording-log.md`; test commits 5cc3813 RED, a5399de GREEN; keys byte-identical).
- Prepared checkout: `node scripts/angular-pilot/prepare-checkout.ts --repo <angular clone, HEAD verified 3cc1edf3210a9debb0be57a4e99e53a54505db32, read only> --sha 3cc1edf3210a9debb0be57a4e99e53a54505db32 --dest <empty scratch dir> --scratch <dir> --record <json>`: 11,629 of 11,699 files kept, 70 stripped, manifest sha256 `66bafd82...e30257` (identical to the calibration and v1 runs). Atlas build: `npm ci --ignore-scripts && npm run build` in this worktree. Each atlas session builds its own index in its session clone (driver behaviour).
- Launch (one driver process, sequential, `nice -n 10`, per-session budget 1.5 USD): `node scripts/angular-pilot/driver.ts --launch --stage pilot --corpus <prepared> --out <dir> --scratch <dir> --ledger <file> --repo <worktree> --docs docs/eval/angular-pilot/v2 --cap-usd 14`. Schedule: seed 20261021, 7 chunks (six of 15 sessions, one of 6). Analysis: `node scripts/angular-pilot/pilot-analysis.ts --out <driver out> --docs docs/eval/angular-pilot/v2 --dest docs/eval/angular-pilot/v2/pilot`.
- Wall: launch 2026-10-21 22:55 to completion 2026-10-22 00:56 local, about 2 h 01 min including 64 index builds; summed model-session time 37.1 min.

## Per-chunk check log (the driver's check after every chunk)

The driver ran all seven chunk checks itself (non-ok status, rate reading at 0.60, overage, API key, version, atlas tools in G or none in A, cap) and never stopped: no STOP line, "done: 96 sessions, 8.27 USD notional". Per chunk, from the records:

| chunk | sessions | non-ok | overage | five-hour first / last | seven-day first / last | notional USD | model minutes |
| ---: | ---: | ---: | --- | --- | --- | ---: | ---: |
| 1 | 15 | 0 | off, rejected | 0.08 / 0.09 | 0.19 / 0.19 | 0.851 | 4.1 |
| 2 | 15 | 0 | off, rejected | 0.09 / 0.11 | 0.19 / 0.20 | 1.023 | 5.1 |
| 3 | 15 | 0 | off, rejected | 0.12 / 0.14 | 0.20 / 0.20 | 0.884 | 3.9 |
| 4 | 15 | 0 | off, rejected | 0.14 / 0.20 | 0.20 / 0.22 | 2.041 | 8.9 |
| 5 | 15 | 0 | off, rejected | 0.20 / 0.21 | 0.22 / 0.22 | 1.199 | 5.5 |
| 6 | 15 | 0 | off, rejected | 0.21 / 0.22 | 0.22 / 0.22 | 1.857 | 8.0 |
| 7 | 6 | 0 | off, rejected | 0.22 / 0.23 | 0.22 / 0.22 | 0.412 | 1.5 |

Readings are those carried by the first and last session of each chunk (there is no model-free reading). Maxima: five-hour 0.23, seven-day 0.22; both far below 0.60. Total notional cost 8.267 USD (cap 14; projection in the calibration notes was 4.6 to 10.4).

## Headline numbers

| | G | A-ts | A-reg |
| --- | ---: | ---: | ---: |
| billable mean (median) | 72,662 (43,640) | 88,343 (56,404) | 163,493 (103,272) |
| billable mean, exact-set sessions only | 48,166 | 61,813 | 127,839 |
| input / cache creation / cache read / output (mean) | 12 / 11,616 / 59,126 / 1,908 | 13 / 12,872 / 73,448 / 2,009 | 15 / 17,289 / 143,756 / 2,434 |
| first request (mean) | 6,610 | 7,668 | 11,394 |
| tool calls excl. final answer (mean) | 5.1 | 5.8 | 6.5 |
| correctness (exact set), sessions | 71.9% (23/32) | 71.9% (23/32) | 84.4% (27/32) |
| matched / missing / extra (sum) | 393 / 99 / 81 | 459 / 33 / 17 | 485 / 7 / 1 |
| adoption (sessions with an atlas call) | n/a | 6.3% (2/32) | 46.9% (15/32) |
| atlas calls / ToolSearch calls / skill loaded | n/a | 4 / 2 / 0 | 39 / 0 / 0 |
| wall seconds (mean) | 19.9 | 21.3 | 28.3 |
| cost USD (sum) | 2.287 | 2.526 | 3.453 |

| R (A mean over G mean, over 16 questions) | point | 90% interval (10,000 draws, seed 20261021) |
| --- | ---: | --- |
| A-ts / G | 1.216 | 1.068 to 1.373 |
| A-reg / G | 2.250 | 1.730 to 2.914 |

Premise: G mean 72,662 >= 68,000, passed. The G median (43,640) is much lower than the mean: the mean is carried by the references questions (p-305, p-307, p-308) and p-313.

## Per category (descriptive; 1 to 4 questions per cell, no intervals)

| category | questions | G mean | A-ts mean (ratio to G) | A-reg mean (ratio to G) | correctness G / A-ts / A-reg | adoption A-ts / A-reg |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| callers | 4 | 48,224 | 68,359 (1.42) | 160,117 (3.32) | 75.0% / 100.0% / 87.5% | 0.0% / 12.5% |
| references | 4 | 126,408 | 142,320 (1.13) | 263,631 (2.09) | 50.0% / 25.0% / 75.0% | 12.5% / 50.0% |
| heritage | 2 | 25,229 | 33,308 (1.32) | 35,456 (1.41) | 100% / 100% / 100% | 0% / 0% |
| impact | 4 | 91,374 | 111,518 (1.22) | 195,115 (2.14) | 62.5% / 62.5% / 75.0% | 12.5% / 100% |
| definition | 1 | 20,147 | 31,428 (1.56) | 34,709 (1.72) | 100% / 100% / 100% | 0% / 0% |
| abstain | 1 | 27,962 | 26,654 (0.95) | 34,821 (1.25) | 100% / 100% / 100% | 0% / 100% |

## A sessions with and without an atlas call (descriptive)

| group | sessions | billable mean | correctness |
| --- | ---: | ---: | ---: |
| A-ts with a call | 2 | 259,859 | 0% |
| A-ts without | 30 | 76,908 | 76.7% |
| A-reg with a call | 15 | 235,483 | 73.3% |
| A-reg without | 17 | 99,973 | 94.1% |
| both A, with a call | 17 | 238,350 | 64.7% |
| both A, without | 47 | 85,251 | 83.0% |

Same-question comparison (questions with both kinds among their A sessions; called mean / not-called mean billable): p-304 647,896 / 96,120; p-305 178,346 / 123,389; p-307 448,545 / 155,142; p-308 261,811 / 288,966; p-311 90,372 / 84,263; p-312 187,299 / 92,595; p-313 336,539 / 187,095; p-314 126,935 / 46,716; p-316 34,821 / 26,654. The called sessions cost more on eight of nine questions. Against matched G (per called session) the 17 called sessions averaged 238,350 versus 103,540.

## Sessions whose answer is not an exact match (23 of 96; for the later audit against the keys, no key defect decided here)

Counts are matched / missing / extra; file names are in `pilot/summary.json` (`notExact`).

| session | matched / missing / extra | note |
| --- | --- | --- |
| A-ts p-314 r1 | 9 / 1 / 0 | missing `packages/common/locales/closure-locale.ts` |
| A-ts p-314 r2 | 10 / 0 / 1 | extra `packages/common/locales/generate-locales-tool/closure-locale-file.ts` |
| A-reg p-306 r1 | 7 / 1 / 0 | missing `.../platform-browser/animations/async/src/async_animation_renderer.ts` |
| G p-313 r1 | 17 / 2 / 1 | missing `forms/signals/src/field/state.ts`, `forms/signals/test/node/logic_node.spec.ts`; extra `forms/signals/test/node/deep_signal.spec.ts` |
| G p-313 r2 | 17 / 2 / 0 | the same two missing |
| A-ts p-313 r1 | 17 / 2 / 0 | the same two missing |
| A-reg p-313 r1 | 19 / 0 / 1 | extra `forms/signals/src/field/field_adapter.ts` |
| A-reg p-313 r2 | 18 / 1 / 0 | missing `forms/signals/test/node/logic_node.spec.ts` |
| A-reg p-305 r2 | 10 / 4 / 0 | missing compiler-cli preprocessor and language-service completions.ts, semantic_tokens.ts, template_target.ts |
| A-ts p-305 r1 | 11 / 3 / 0 | missing t2_binder.ts, content_projection.ts, scope.ts |
| G p-305 r1 | 0 / 14 / 11 | paths lack the leading `packages/` (see below) |
| A-ts p-305 r2 | 0 / 14 / 14 | paths lack the leading `packages/` |
| G p-307 r1 | 0 / 40 / 26 | paths lack the leading `packages/` |
| G p-307 r2 | 0 / 40 / 40 | paths lack the leading `packages/` |
| A-ts p-307 r1 | 36 / 4 / 0 | missing checker.ts (2), binding_spec.ts, view/util.ts |
| A-ts p-307 r2 | 31 / 9 / 0 | nine missing |
| A-reg p-304 r2 | 28 / 1 / 0 | missing `core/test/util/stringify_spec.ts` |
| G p-304 r2 | 29 / 0 / 1 | extra `core/src/util/stringify.ts` |
| G p-301 r2 | 38 / 1 / 0 | missing `router/src/directives/router_link_active.ts` |
| G p-308 r1, A-ts p-308 r1, A-ts p-308 r2 | 46 / 0 / 1 each | extra `router/test/integration/integration.spec.ts` in all three |
| G p-311 r2 | 4 / 0 / 1 | extra `router/src/router.ts` |

Observation for the audit, not a correction: in four sessions (G p-305 r1, A-ts p-305 r2, G p-307 r1 and r2) the answered paths are the key's paths without the leading `packages/` (for example `compiler/src/render3/r3_ast.ts`), so the registered matching rules count zero matches. Three of those four are G sessions and they make up most of the G missing (99) and extra (81) sums; exact-set equality counts them as wrong, as the pre-declared rule says. Repeating non-exact answers on the same question across conditions (p-308 extra spec file in three sessions; p-313 missing `state.ts` and `logic_node.spec.ts` in three) point at possible key questions for the audit.

## Deviations and unverified items

- The driver cannot stop between chunks on request; it runs all chunks in one process and performs its own check after each. I monitored the log and did not intervene; the per-chunk table above is reconstructed from the records afterwards.
- A fresh prepared checkout was made for this run (the calibration checkout was not reused); manifest hash identical.
- The p-313 text changed after calibration (wording-log.md); none of the 12 calibration sessions saw it.
- Matching uses the registered rules with the path as answered; no path normalisation beyond the driver's removal of the session checkout root and a leading `./`.
- Not verified: whether the extra files in non-exact sessions are genuine hits the keys miss (the audit against the keys is a later step); whether the path-prefix mismatch (four sessions) is a prompt-wording issue; why A-ts adoption is 2 of 32 (the two ToolSearch calls and four atlas calls are in `pilot/summary.json`); the rate readings come from the sessions' own events, on an account shared with other sessions.
- Dry numbers for the next decision are in the tables above; no further classification beyond the pre-declared one is offered.
