# Clean-room replication of the registered eval run

## Status

The registered verdict is `OVERALL: MVP not met` in `docs/eval/analysis.md`, and it stands. A replication cannot make the MVP met, cannot make it not met, and cannot unblock Phase 4; only a new registered run that meets the gate does (D-04). This document is supplementary evidence about whether the measured quantities depend on the maintainer's machine and configuration. It is never pooled with the original run, and it does not edit, replace or re-argue the registered result.

- Date of the replication: 2026-10-21 (plan 03-39).
- Classification, from the rules fixed before any replication data existed (`scripts/cleanroom/compare.ts`, rules commit `2c7831f`, unchanged since): **agreement-with-drift**.
- Validity: valid. All 450 sessions ended `ok`, with no infrastructure failure, no hook event, no init-signature difference, no paid-usage use and no credential access.
- What the class triggers: the three registered criteria agree and one statistic moved (accuracy). The review is informational; the registered verdict stays the default.

Registered result for reference, from `docs/eval/analysis.md`: ACCURACY non-inferior, TOKENS not fewer, CITATIONS below threshold, OVERALL MVP not met. The replication, run through the registered analysis unmodified (`docs/eval/results-cleanroom/analysis-cleanroom.md`), prints the same four lines.

## What was replicated and how

The registered command was run unchanged, from a prepared checkout of the registered corpus commit (`10ac3a7a`, `npm ci` true, TypeScript 6.0.3, lockfile hash equal to the registered record):

`node scripts/eval/harness.ts run --scored --questions scripts/eval/questions/gsd-core.questions.json --answers scripts/eval/questions/gsd-core.answers.json --corpus-dir <prepared corpus> --out-dir <results> --arms atlas,grep --runs 3 --concurrency 2 --seed 20261017 --model claude-sonnet-5-5 --prereg docs/eval/preregistration.md --stop-at-cost-usd <line>`

- Seed 20261017, concurrency 2, model `claude-sonnet-5-5`, 75 questions, 2 arms, 3 runs, 450 cells. The scored gate was `ok` before every chunk.
- Three chunks, one launch each, cost lines of 5, 10 and 20 USD notional (rows 0 to 141, 141 to 303, 303 to 450). The first two stopped at their line (exit 1, expected); the third finished all cells (exit 0). No chunk was discarded and nothing was rerun.
- Notional cost of the whole run: 15.5075 USD, run on a Claude Max subscription login with extra usage off. The between-chunk check printed `check: ok` after every chunk; the final check passed with 450 rows, 450 attempts and 450 streams.
- Code under test: the registered base commit `a21ef8bf` plus one local tooling commit (`8efcac65`) that differs from the base only under `scripts/cleanroom` and `docker/cleanroom`. The integration head's build differs from the measured build by the post-eval fixes of `03-POST-EVAL-FIXES.md`; the replication, like the original, does not include them.

## Environment differences

These are declared conditions, fixed before any data existed. They are the conditions under test, neither corrected for nor isolated.

| condition | original run | clean room | status |
| --- | --- | --- | --- |
| Node.js version | 26.11.1 | 24.22.0 | original: not recorded by the run, read from the maintainer machine (still 26.11.1 at analysis time); clean room: recorded |
| Operating system and architecture | macOS arm64 | Debian bookworm x86_64 container, Linux 7.0.0-38-generic | recorded |
| ripgrep | not recorded (maintainer machine now has 15.2.0) | 13.0.0 | clean room recorded; original unknown |
| git | not recorded (maintainer machine now has 2.54.0) | 2.39.5 | clean room recorded; original unknown |
| npm | not recorded | 11.19.1 | clean room recorded; original unknown |
| Claude Code | 2.1.302 | 2.1.302 | recorded (the scored gate refuses any other) |
| CPU and memory limits | none set, 18 CPUs on the maintainer machine now | 4 CPUs, 12 GiB (swap equal), 2048 pids | clean room recorded; original not recorded |
| User-level configuration | the maintainer's account state | one neutral notes file | clean room recorded; original unknown |
| Hooks, MCP servers, skills, plugins, user memory file | not recorded | none (zero hook events in every session) | clean room recorded; original unknown |
| Network location | the maintainer network | the Docker host network | declared |
| Time of day and date | the date of the original run (plan 03-35) | 2026-10-21 | declared |
| Account state | the maintainer's account | a Max login inside the container, headroom at most 0.10 | clean room recorded; original unknown |

## Validity

- Init signatures: identical across all sessions and between the two arms' registered signatures; no difference was reported by any probe or by the chunk checks.
- Infrastructure: 0 of 450 attempts flagged as infrastructure failures; 0 failed sessions in either arm.
- Counts: 450 rows, 450 attempts, 450 streams, 455 sidecar records; no duplicate cell.
- Headroom after the final chunk: five-hour 0.06, seven-day 0.10, overage off throughout.
- Controls: the isolation probes showed the harness flags keep the user-level notes file out of sessions (the default-flags control quoted the notes; the harness-flags control did not).
- Atlas sessions that loaded the skill: 0 of 225, as in the original (0 of 225).

## Side by side

All numbers are copied from `docs/eval/analysis.md` (original), `docs/eval/results-cleanroom/analysis-cleanroom.md` and `docs/eval/results-cleanroom/comparison.md` (replication), and, for the Node versions, `docs/eval/results-cleanroom/environment.json`.

| quantity | original | replication |
| --- | --- | --- |
| Node.js version | 26.11.1 | 24.22.0 |
| accuracy, atlas | 0.8000 | 0.7689 |
| accuracy, grep | 0.7511 | 0.7644 |
| paired accuracy difference (atlas minus grep) | +0.0489, 5th percentile +0.0133 | +0.0044, 5th percentile -0.0267 |
| mean billable tokens, atlas | 47375.1 | 42906.1 |
| mean billable tokens, grep | 29393.1 | 23951.7 |
| token ratio, atlas over grep | 1.612 | 1.791 |
| paired billable-token difference | +17982.0, 95th percentile +20709.4 | +18954.4, 95th percentile +23070.2 |
| atlas citation rate (verifiable sessions) | 144 of 198 (72.7%) | 139 of 198 (70.2%) |
| grep citation rate | 146 of 198 (73.7%) | 147 of 198 (74.2%) |
| atlas sessions that called an atlas tool | 86 of 225 (38.2%) | 76 of 225 (33.8%) |
| atlas sessions that loaded the skill | 0 of 225 | 0 of 225 |
| notional cost, USD | 16.1142 | 15.5075 |
| mean wall time, atlas / grep, ms | 7910 / 7627 | 11899 / 10555 |
| failed sessions, atlas / grep | 0 / 0 | 0 / 0 |
| cells whose correctness differs between the runs | n/a | atlas 15, grep 15 |
| cells whose citation outcome differs between the runs | n/a | atlas 17, grep 17 |

Per category (original / replication):

| category | accuracy atlas | accuracy grep | token ratio |
| --- | --- | --- | --- |
| abstain | 1.000 / 1.000 | 1.000 / 1.000 | 1.363 / 1.546 |
| adr | 0.900 / 0.867 | 0.833 / 0.833 | 1.679 / 1.658 |
| callers | 0.725 / 0.706 | 0.686 / 0.725 | 1.403 / 1.559 |
| definition | 1.000 / 1.000 | 1.000 / 1.000 | 1.413 / 1.760 |
| emit | 0.500 / 0.433 | 0.300 / 0.300 | 1.822 / 1.813 |
| heritage | 1.000 / 1.000 | 1.000 / 1.000 | 1.816 / 1.810 |
| impact | 0.611 / 0.389 | 0.556 / 0.556 | 1.805 / 2.667 |
| references | 0.750 / 0.792 | 0.750 / 0.792 | 1.861 / 1.811 |

## Agreement analysis

A1 compares the met or not-met outcome of each registered criterion with the original.

| criterion | original | replication | agree |
| --- | --- | --- | --- |
| H1 accuracy | met | met | yes |
| H2 tokens | not met | not met | yes |
| H3 citations | not met | not met | yes |

A2 compares each registered statistic between the two runs with a question-clustered bootstrap of the per-question between-run difference (10,000 resamples, seed 20261017, 2.5th to 97.5th percentile); a statistic is compatible when zero lies inside the interval.

| statistic | original | replication | difference | lower | upper | compatible |
| --- | --- | --- | --- | --- | --- | --- |
| S1 accuracy difference (atlas minus grep) | +0.0489 | +0.0044 | -0.0444 | -0.0933 | 0.0000 | NO |
| S2 billable-token difference (atlas minus grep) | +17982.0 | +18954.4 | +972.4 | -2767.7 | +5591.1 | yes |
| S3 atlas citation rate | +0.7273 | +0.7020 | -0.0253 | -0.0657 | +0.0101 | yes |

All three A1 outcomes agree, and S1 is incompatible, so the class is **agreement-with-drift** exactly as the rules define it. The interval's upper bound is 0.0000, so S1 sits on the boundary of the rule; the class is reported as the rule computed it, not as a judgement call.

## What this does and does not show

- It shows that, under the declared conditions, each registered criterion came out the same way: accuracy non-inferior, tokens not fewer, citations below the 80% threshold. The token cost of the atlas arm over the grep arm was of similar size in both runs (S2 compatible), and the atlas citation rate was similar (S3 compatible).
- The accuracy gap between the arms was smaller in the replication (+0.0044 against +0.0489). The replication's atlas accuracy is lower and its grep accuracy slightly higher; the per-category rows put most of the movement in the `impact` category (atlas 0.611 to 0.389). This document reports that movement and does not explain it.
- The Node version is a declared condition of the replication (24.22.0 against the original's 26.11.1), not a confound that was removed from the result. No difference above is attributed to it, or to any other single difference in the table.
- One replication of 450 sessions is one more sample of a stochastic process. It does not establish variance, it does not test any condition in isolation, and it makes no efficacy claim beyond the numbers above.
- Sessions in the clean room were slower (mean wall time 11899 ms and 10555 ms against 7910 ms and 7627 ms). The slowest session took 63.3 s, far under the 900 s limit, and none failed.
- Decision records remain unratified drafts; nothing here ratifies one.

## What a disagreement triggers

This replication is not a disagreement, so no follow-up is triggered. For reference, a disagreement (any A1 outcome differing) would require a human review before the plan ends and would lead at most to a new registered run through the Deviations policy, with its own approvals. It would never replace the registered verdict, and nothing would be rerun or re-scored to resolve it.

## How to repeat it

See `docker/cleanroom/README.md`.
