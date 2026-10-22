# Angular pilot: closed-book control and calibration batch (unscored, unregistered)

**Nothing here is registered or scored.** The registered verdict `OVERALL: MVP not met` stands. No registered file, key, result or skill was touched. These are the first model sessions of the angular pilot (plan sections 4 to 6, owner decisions in section 10): the closed-book control (16 sessions) and the calibration batch (12 sessions). The 96-session pilot stage was NOT run. n is tiny; every comparison is descriptive.

Data (compact, no answer prose): `calibration/closed-book-sessions.jsonl`, `calibration/calibration-sessions.jsonl` (one row per session: usage split, first-request tokens, tool counts by tool, atlas and ToolSearch calls, skill flag, wall time, cost, rate-limit reading, answer-vs-key counts), `calibration/summary.json` (aggregates and per-question rows), `calibration/index-build.json` (atlas index of the prepared tree). Raw streams stayed in the session scratch directory.

## Method and commands

- Claude Code 2.1.305, model `claude-sonnet-5-5`, subscription login only. Auth four-field filter before the run: loggedIn true, authMethod claude.ai, apiProvider firstParty, subscriptionType max. Every init event: `apiKeySource` none. The driver strips all ANTHROPIC*/CLAUDE* variables from the child.
- Prepared checkout: `node scripts/angular-pilot/prepare-checkout.ts --repo <angular clone, HEAD verified 3cc1edf3210a9debb0be57a4e99e53a54505db32> --sha 3cc1edf3210a9debb0be57a4e99e53a54505db32 --dest <empty scratch dir> --scratch <dir> --record <json>`: 11,699 files exported, 70 agent-config files stripped, 11,629 kept, manifest sha256 `66bafd82209f11ca3d00bd3bca21f8781f1a11781bd964a3ebfa7d5694e30257`. The clone was only read by `git archive`; no code from it was run.
- Atlas build: `npm ci --ignore-scripts && npm run build` in this worktree (main at bac2f2a, which includes the indexer ignore rules 28f3952).
- Closed-book: `node scripts/angular-pilot/driver.ts --launch --stage closed-book --corpus <prepared> --out <dir> --scratch <dir> --ledger <file> --repo <worktree>` (default cap 4 USD).
- Calibration: same with `--stage calibration --cap-usd 8`. Sequential (concurrency 1), `nice -n 10`, one driver at a time (checked with `ps`). Per-session `--max-budget-usd` 1.5 (closed-book 0.5). Each atlas session builds and resolves its own index in a copy-on-write clone of the prepared tree (registered probe practice).
- Calibration questions (driver `calibrationBatch`): p-201 and p-203 (callers), p-208 (references), p-210 (heritage), each once in G, A-ts, A-reg.

## Closed-book control (16 sessions, no repository access)

All 16 sessions status ok, init tool list was only `StructuredOutput`, no MCP server. The sessions made 38 tool attempts in all (1 to 4 per session, Bash/Grep/Glob) and every one failed as an unavailable tool (checked in the streams), so the sessions are closed-book in fact. Cost 0.320 USD notional; billable mean 15,575 tokens per session.

| category | n | exact-set equal | matched | missing | extra | answered `found` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| callers | 5 | 0 | 0 | 16 | 0 | 0 |
| references | 3 | 0 | 0 | 29 | 0 | 0 |
| heritage | 3 | 0 | 0 | 28 | 0 | 0 |
| impact | 2 | 0 | 0 | 6 | 0 | 0 |
| definition | 2 | 0 | 0 | 2 | 1 | 1 |
| abstain | 1 | 1 | 0 | 0 | 0 | 0 |
| total | 16 | 1 | 0 | 81 | 1 | 1 |

Reading: contamination, as measured by what the model volunteers without tools, is nil for these keys. The only exact match is the abstain question (correct `not_found`, a free hit for a model that answers `not_found` to everything). 15 of 16 sessions answered `not_found`; the one `found` answer (a definition question) matched nothing (0 matched, 1 extra, 1 missing). The model declined rather than guessing, so this control shows no memorisation of the keys, but it does not bound what a model with grep could infer from names.

## Calibration batch (12 sessions, all status ok)

Per condition, mean over the 4 questions (medians in brackets where useful). Tokens are per session; "first request" is input + cache creation + cache read of the first request.

| | G | A-ts | A-reg |
| --- | ---: | ---: | ---: |
| billable mean (median) | 35,933 (31,031) | 37,628 (30,249) | 43,727 (42,675) |
| input / cache creation / cache read / output (mean) | 8 / 8,729 / 26,072 / 1,124 | 8 / 7,395 / 29,117 / 1,109 | 6.5 / 9,648 / 33,137 / 936 |
| first request (mean) | 6,555 | 7,613 | 11,339 |
| tool calls excl. final answer (mean) | 3.0 | 3.25 | 2.5 |
| assistant turns (mean) | 5.0 | 5.25 | 4.5 |
| sessions with an atlas call | n/a | 0 of 4 (0%) | 1 of 4 (25%), 2 calls (p-208, `code_refs`) |
| ToolSearch calls | n/a | 0 | n/a |
| skill body loaded | 0 | 0 (no skill) | 0 of 4 |
| wall seconds mean (median) | 12.6 (9.2) | 12.5 (9.7) | 12.2 (10.4) |
| cost USD mean / sum | 0.0488 / 0.195 | 0.0436 / 0.174 | 0.0513 / 0.205 |
| answer set equals key | 4 of 4 | 4 of 4 | 4 of 4 |
| matched / missing / extra (sum over 4) | 26 / 0 / 0 | 26 / 0 / 0 | 26 / 0 / 0 |
| init tools / of which MCP | 3 / 0 | 11 / 7 | 11 / 7 |
| ToolSearch in init tool list | no | yes | no |

Billable per question (G / A-ts / A-reg): p-201 callers 33,387 / 26,036 / 37,245; p-203 callers 21,584 / 24,790 / 35,837; p-208 references 28,674 / 34,462 / 48,105; p-210 heritage 60,086 / 65,225 / 53,720. Ratios of means (descriptive, n=4): A-ts/G 1.05, A-reg/G 1.22.

A-ts deferral check: the init event for A-ts lists ToolSearch plus all 7 atlas tools by name (11 tools), first request 7,613 tokens against 11,339 for A-reg (3,726 fewer) and 6,555 for G (+1,058), which reproduces the probe figures (7,104 vs 10,814 vs 6,034 differences: about 3,700 and about 1,070). The deferral works. Adoption: A-ts made no ToolSearch call and no atlas call in any of 4 sessions (as in the gsd-core probe, 0 of 4); A-reg made 2 atlas calls in 1 of 4 sessions (25%; the gsd-core probes saw 22%). Every session answered with Bash only, apart from that one.

### Premise check (plan section 6)

Grep (G) mean billable tokens: **35,933**. The premise floor is 68,000 (1.5x the gsd-core P3 grep mean 45,242), the failure line is 55,000. **Verdict: premise failed.** Grep on these 4 questions costs 0.79x the gsd-core P3 grep mean, not 1.5x or more. The stop line (4x P3 = 180,968) was not approached. Reading per the owner's rule: report as the finding, do not register on this corpus, and go back to the question rule (a harder window) before spending more. Caveats: n=4 (the range is 21,584 to 60,086; only the heritage question p-210 is above 55k), the batch has 2 callers, 1 reference and 1 heritage question and none of the harder kinds (impact), and grep sessions took 2 to 5 Bash calls to a correct exact-set answer on all four. Grep cost is driven by how many wrong-symbol files a name search returns, which the selected window apparently keeps low (as plan section 2 anticipated: "inside the answerable window the advantage over gsd-core is smaller than the headline").

Other plan checks on this batch: no non-ok sessions; no version or environment mismatch; no API key in any init event; no permission prompt or classifier denial; no overage.

## Atlas index of the prepared tree (new ignore rules)

Separate timed build in a fresh store (`gsd-atlas build`, then `maintain resolve`, as the harness does):

| | wall | max RSS |
| --- | ---: | ---: |
| `build` | 37.1 s | 5.99 GB |
| `maintain resolve` | 36.3 s | 4.60 GB |

Build result: 6,924 files in the build report (6,925 in status), 6,367 parsed, 557 linked, 2 skipped, 1 failed (`source_too_large`), diagnostics `emit_output_not_indexed` (385 files) and `resolver_timeout` (resolved afterwards: 285,497 processed, 204,793 answered precisely, complete). Store 193 MB. The prepared tree has 11,629 files (6,191 `.ts`, 180 `.mts`, 908 `.js`, 1,458 `.md`, 728 `.bazel`, 566 `.json`, 453 `.html`, ...), so about 4,700 files are not indexed. The status and build outputs do not split that remainder into "excluded by defaults" and "excluded by .atlasignore" (only the 385 emit-output files are named); that split is unverified and I did not infer it. Against the plan's estimate of about 85 s and 5 GB per index, the build plus resolve is about 73 s with up to 6 GB. Each atlas session in the stages did its own build and resolve.

## Rate limits and cost

Readings come from the stream's rate-limit events (fractions of the window); `isUsingOverage` false and `overageStatus` rejected in every reading. The account is shared with other live sessions, so the movement is an upper bound for these stages.

| point | five-hour | seven-day |
| --- | ---: | ---: |
| first closed-book session (the earliest reading obtainable without a session) | 0.24 | 0.16 |
| last closed-book session | 0.25 | 0.16 |
| first calibration session | 0.25 | 0.16 |
| last calibration session | 0.27 | 0.17 |

Notional cost: closed-book 0.320 USD, calibration 0.575 USD, **total 0.894 USD** (cap 8 USD; ledger is the sum of the two record files). Neither window approached 0.60.

Allowance used: five-hour window +0.03 and seven-day +0.01 over 0.89 USD (the readings have a 0.01 resolution, so the seven-day figure is ±0.01 and the driver's 0.0174 per USD is rough).

Projection for the 96-session pilot (arithmetic, not measured): at the calibration mean of 0.048 USD per session the pilot costs about 4.6 USD notional (plan estimate was 12 to 24 USD, which this batch does not support), about +0.15 on the five-hour window if run inside one window and about +0.08 on the seven-day window (range roughly +0.03 to +0.12 given the reading resolution). Wall time: about 12 s per model session plus about 73 s of index build and resolve for each of the 64 atlas sessions, about 80 minutes of builds if the store is not reused, which is the dominant time. These projections assume the pilot's 16 questions behave like these 4; the heavier kinds (impact, large references) cost more per session (in gsd-core P3 impact was 1.5x the mean).

## Deviations, driver fixes, unverified

- No driver change was needed; the real-run path (closed-book and calibration) worked as committed. No registered harness file was changed.
- The "before" reading is the first session's own reading; there is no model-free way to read the windows.
- The shell here rejects some compound commands, so stage launches and the analysis ran through small wrapper scripts kept in the scratch directory (not committed); the commands they run are the ones listed above.
- Closed-book sessions attempted unavailable tools (Bash, Grep, Glob) 1 to 4 times each; all failed. The prompt is the registered grep-arm prompt (the model evidently expects repository tools); the failed attempts add some tokens per session.
- Unverified: the split of unindexed files between default exclusions and `.atlasignore`; whether a built index can be reused across session clones; adoption under A-ts beyond 0 of 4; whether the premise failure holds for the harder question kinds (impact, wide references) not in the batch.
- Answer-vs-key figures use the driver's exact-set comparison against the audited pilot keys; all 12 calibration answers equalled their keys.
