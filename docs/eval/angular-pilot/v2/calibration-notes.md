# Angular pilot, rule v2: calibration batch results (unscored, unregistered)

**Nothing here is registered or scored.** The registered verdict `OVERALL: MVP not met` stands. The v2 keys are first-reader audited only (second reader pending). Pre-declared plan: `calibration-plan.md` (committed before any session). The 96-session pilot and the closed-book stage were NOT run. n is 4 per condition; everything is descriptive.

Data (no answer prose): `calibration/calibration-sessions.jsonl` (one row per session), `calibration/summary.json` (per condition, per category, rate readings).

## Method and commands

- Claude Code 2.1.305, model `claude-sonnet-5-5`, subscription login only. Auth filter before launch: loggedIn true, authMethod claude.ai, apiProvider firstParty, subscriptionType max. All 12 init events: `apiKeySource` none. The driver strips ANTHROPIC*/CLAUDE* variables from the child.
- Prepared checkout: `node scripts/angular-pilot/prepare-checkout.ts --repo <angular clone, HEAD verified 3cc1edf3210a9debb0be57a4e99e53a54505db32> --sha 3cc1edf3210a9debb0be57a4e99e53a54505db32 --dest <empty scratch dir> --scratch <dir> --record <json>`: 11,629 of 11,699 files kept, 70 agent-config files stripped, manifest sha256 `66bafd82209f11ca3d00bd3bca21f8781f1a11781bd964a3ebfa7d5694e30257` (identical to the v1 run). The clone was only read by `git archive`.
- Atlas build: `npm ci --ignore-scripts && npm run build` in this worktree (main 41d68ce plus the two driver commits). Each atlas session builds its own index in a clone of the prepared tree (driver behaviour, as in v1); no separate index was built.
- Launch: `node scripts/angular-pilot/driver.ts --launch --stage calibration --corpus <prepared> --out <dir> --scratch <dir> --ledger <file> --repo <worktree> --docs docs/eval/angular-pilot/v2 --only p-304,p-307,p-312,p-310 --cap-usd 4`, under `nice -n 10`, one driver process, concurrency 1, per-session budget 1.5 USD.
- Questions: p-304 callers `stringify`, p-307 references `Component`, p-312 impact `translate`, p-310 heritage `NgModuleRef`, each in G, A-ts, A-reg once.
- Summary and per-session rows were computed from the raw streams with `scripts/probes/stream.ts` `recordOf` (usage split, first request, tool counts, init tools).

## Results per condition (4 sessions each, all status ok)

| | G | A-ts | A-reg |
| --- | ---: | ---: | ---: |
| billable mean (median) | 92,259 (83,762) | 130,203 (109,582) | 143,611 (148,434) |
| input / cache creation / cache read / output (mean) | 13 / 13,988 / 76,004 / 2,254 | 16 / 18,910 / 108,499 / 2,779 | 12.5 / 22,459 / 118,703 / 2,436 |
| first request (mean) | 6,646 | 7,704 | 11,430 |
| tool calls excl. final answer (mean) | 5.8 | 7.2 | 6.2 |
| sessions with an atlas call | n/a | 0 of 4 | 2 of 4 (7 calls: `code_impact` 2 in p-312, `code_refs` 5 in p-307) |
| ToolSearch calls | n/a | 0 | n/a |
| skill body loaded | 0 | 0 | 0 |
| wall seconds mean (median) | 21.7 (19.3) | 26.4 (24.7) | 29.9 (31.4) |
| cost USD mean / sum | 0.081 / 0.325 | 0.118 / 0.473 | 0.127 / 0.508 |
| answer set equals key | 3 of 4 | 4 of 4 | 2 of 4 |
| matched / missing / extra (sum) | 77 / 0 / 1 | 77 / 0 / 0 | 75 / 2 / 3 |

Billable per question (G / A-ts / A-reg): p-304 callers 43,974 / 141,130 / 72,141; p-307 references 180,351 / 267,896 / 232,521; p-312 impact 123,549 / 78,034 / 224,727; p-310 heritage 21,160 / 33,750 / 45,056. Per category (n=1 per cell) the same numbers, with matched/missing/extra: G p-304 29/0/1 (one extra file, not exact); A-reg p-312 5/0/3 (three extra); A-reg p-307 38/2/0 (two missing). Ratios of means: A-ts/G 1.41, A-reg/G 1.56 (descriptive, n=4).

Deferral check: A-ts first request 7,704 vs A-reg 11,430 vs G 6,646 (same pattern as the v1 batch). A-ts made no ToolSearch call and no atlas call in any session; the two A-reg sessions that used atlas were the two most expensive of that arm and both were not exact.

## Premise verdict (against the pre-declared reading)

G mean billable **92,259 >= 68,000: PASS.** Per the plan, proceed to the full 96-session run, which measures the real mix. The stop line (4 x 45,242 = 180,968) was not exceeded as a mean; the single session p-307 G (180,351) sits just under it.

Reading with care, because the plan fixed the threshold on the mean:
- The mean is carried by two questions: p-307 (180k) and p-312 (124k). The other two are 44k and 21k, below the 55k failure line on their own. Median G is 83,762. With n=4 and a range of 21k to 180k the mean is not stable.
- These are the hardest per category on the grep proxy by design, so a PASS here is a necessary check, not evidence the 16-question mix reaches 68k. In the v1 batch the proxy-light questions came in at 22k to 60k.
- The premise concerns grep cost. This batch also shows, descriptively, atlas arms costing more than grep (1.41x and 1.56x), with no atlas adoption under A-ts and 2 of 4 under A-reg. That does not enter the pre-declared reading and is reported, not judged.

## Rate limits, cost, projection

Readings from the stream rate-limit events. Overage off in every reading (`isUsingOverage` false, `overageStatus` rejected).

| point | five-hour | seven-day |
| --- | ---: | ---: |
| first session | 0.06 | 0.18 |
| last session | 0.07 | 0.18 |
| maximum | 0.07 | 0.18 |

Neither window approached 0.60. Total notional cost **1.306 USD** (cap 4). Allowance moved +0.01 (five-hour) and 0.00 (seven-day) at 0.01 resolution, on an account shared with other sessions.

Projection for 96 sessions (arithmetic, not measured): 1.306 / 12 x 96 = about 10.4 USD notional if the 16-question mix costs what these four hardest questions did; the real mix is expected to be lower (v1 calibration: 0.048 USD per session, which gives 4.6 USD). So roughly 4.6 to 10.4 USD, inside the plan estimate of 12 to 24. Wall time: about 26 s per model session plus the per-session index build and resolve (about 70 s in v1) for 64 atlas sessions, about 75 to 80 minutes of builds if the store is not reused. Window use would be roughly +0.05 to +0.10 five-hour if run in one window (projection from +0.01 per 1.3 USD, 0.01 resolution).

## Deviations and unverified

- Driver change (additive, test-first RED 31c0bad, GREEN 1f9c835): `--docs <dir>` (default the v1 directory; also honoured by `--dry-run`) and `--only <ids>` (calibration stage only; rejects unknown ids; schedule from new `calibrationJobsFor`). The brief suggested `--questions` for the id list, but `--questions` is already a file-path option, so the id option is `--only`. The default calibration batch (`calibrationBatch`) is unchanged; v1 tests pass.
- The first-session rate reading is the session's own; there is no model-free reading. No version or environment mismatch, no non-ok session, no permission prompt, no API key in an init event.
- Unverified: whether A-ts/A-reg answer errors (G p-304 extra file; A-reg p-312 extras, p-307 missing) reflect key defects or model error (keys are first-reader only; I did not re-audit them); the p-312 A-reg extras are consistent with the audit's note that hop-two for impact keys is delicate, but I did not check. Stability of the grep mean beyond n=4. Shell here rejects compound commands, so launches and analysis ran via small scratch scripts (not committed).
