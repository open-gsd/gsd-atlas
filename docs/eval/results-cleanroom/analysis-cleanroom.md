# Eval analysis

## Parameters

Read from the registered pre-registration; nothing here is a default.

| parameter | value |
| --- | --- |
| citationJudgedOn | point_estimate |
| citationRate | 0.8 |
| intervalLevel | 0.95 |
| marginPoints | 5 |
| resamples | 10000 |
| seed | 20261017 |
| tokenCriterion | upper-bound |
| zForWilson | 1.96 |

## Run

75 questions, 450 sessions (atlas 225, grep 225).

## Accuracy

| arm | accuracy | failed sessions |
| --- | --- | --- |
| atlas | 0.7689 | 0 |
| grep | 0.7644 | 0 |

Observed difference (atlas minus grep): 0.0044
Bootstrap 5th percentile (lower bound): -0.0267
Bootstrap 95th percentile: 0.0356
Rule: the 5th percentile of the paired cluster bootstrap of (atlas accuracy minus grep accuracy) is above -0.0500.

## Tokens

| arm | sessions | total billable | mean per session | input | output | cache creation | cache read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| atlas | 225 | 9653873 | 42906.1 | 1370 | 143570 | 1629827 | 7879106 |
| grep | 225 | 5389130 | 23951.7 | 1324 | 131341 | 1261562 | 3994903 |

Paired difference in mean billable tokens per question (atlas minus grep): 18954.4
Bootstrap 5th percentile: 15419.4
Bootstrap 95th percentile: 23070.2
Registered rule (upper-bound): the 95th percentile is below zero.
Cache read tokens are their own column; they are part of the total billable tokens (D-06).

## Tool calls, wall time and cost

| arm | tool calls total | tool calls mean | atlas tool share | wall ms total | wall ms mean | cost USD total | cost USD mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| atlas | 745 | 3.31 | 12.1% | 2677313 | 11899.2 | 8.7457 | 0.0389 |
| grep | 667 | 2.96 | 0.0% | 2374861 | 10554.9 | 6.7618 | 0.0301 |

## Citations

Sessions on non-abstain questions whose answer carries at least one file:line citation and whose every cited file:line verified. Wilson z 1.96.

| arm | sessions | verifiable | rate | Wilson lower | Wilson upper |
| --- | --- | --- | --- | --- | --- |
| atlas | 198 | 139 | 70.2% | 63.5% | 76.1% |
| grep | 198 | 147 | 74.2% | 67.7% | 79.8% |

Threshold 80.0%, judged on the atlas arm.
Point estimate at or above the threshold: no
Wilson lower bound at or above the threshold: no
Registered rule: point_estimate

## Failed sessions

None.

## Verdict

ACCURACY: non-inferior
TOKENS: not fewer
CITATIONS: below threshold
OVERALL: MVP not met
