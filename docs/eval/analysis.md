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
| atlas | 0.8000 | 0 |
| grep | 0.7511 | 0 |

Observed difference (atlas minus grep): 0.0489
Bootstrap 5th percentile (lower bound): 0.0133
Bootstrap 95th percentile: 0.0889
Rule: the 5th percentile of the paired cluster bootstrap of (atlas accuracy minus grep accuracy) is above -0.0500.

## Tokens

| arm | sessions | total billable | mean per session | input | output | cache creation | cache read |
| --- | --- | --- | --- | --- | --- | --- | --- |
| atlas | 225 | 10659389 | 47375.1 | 1552 | 148740 | 1589865 | 8919232 |
| grep | 225 | 6613442 | 29393.1 | 1560 | 146847 | 1347241 | 5117794 |

Paired difference in mean billable tokens per question (atlas minus grep): 17982.0
Bootstrap 5th percentile: 15435.1
Bootstrap 95th percentile: 20709.4
Registered rule (upper-bound): the 95th percentile is below zero.
Cache read tokens are their own column; they are part of the total billable tokens (D-06).

## Tool calls, wall time and cost

| arm | tool calls total | tool calls mean | atlas tool share | wall ms total | wall ms mean | cost USD total | cost USD mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| atlas | 844 | 3.75 | 11.0% | 1779751 | 7910.0 | 8.7419 | 0.0389 |
| grep | 787 | 3.50 | 0.0% | 1716065 | 7627.0 | 7.3723 | 0.0328 |

## Citations

Sessions on non-abstain questions whose answer carries at least one file:line citation and whose every cited file:line verified. Wilson z 1.96.

| arm | sessions | verifiable | rate | Wilson lower | Wilson upper |
| --- | --- | --- | --- | --- | --- |
| atlas | 198 | 144 | 72.7% | 66.1% | 78.5% |
| grep | 198 | 146 | 73.7% | 67.2% | 79.4% |

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
