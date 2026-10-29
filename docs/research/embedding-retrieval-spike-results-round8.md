# Embedding retrieval spike, round 8: the dotted-query exception to R5 and a working-machine latency check

Date: 2026-10-29. Status: research evidence only. No product code, dependency, ROADMAP or ADR change. Plan section 17 was frozen before any target was drawn (`.planning/spikes/round8/plan-section-17.frozen.md`); hashes of the I8 set and harness are in `.planning/spikes/round8/FREEZE.md`; results in `.planning/spikes/round8/results/r8-score.json`. Mac (Metal) only; all queries mechanical.

## Short answer

R6 (the single-token trigram fallback with an exception for queries that contain a dot) is confirmed by the registered rule: T1 to T5 are all met on 240 fresh identifier queries (I8). It beats the exact-name-plus-dense route (R3) by 5.8 points overall (p5 +3.3) and by 35.0 points on identifier fragments (0.575 to 0.925, p5 +22.5), with no loss on misspellings or on any other identifier stratum, and no change on the mixed-intent sets. One caution: on I8, R6 and R5 return identical lists for every query (no query was routed differently), so I8 cannot show the dot exception to be necessary. It shows the harm seen in round 6 did not recur on fresh data, and the exception fixes the one known case at no cost anywhere (T7). The latency condition (L1) is not evaluable: none of the six passes started inside the stated working-machine limits.

## Results (recall@10, EmbeddingGemma 2)

| Set (n) | F | D | R3 | R5 | R6 | R6-nolex |
|---|---|---|---|---|---|---|
| **I8 (240, fresh)** | 0.825 | 0.879 | 0.904 | 0.963 | **0.963** | 0.958 |
| I6 (240, seen) | 0.829 | 0.917 | 0.921 | 0.954 | 0.958 | 0.967 |
| I5 test (88, seen) | 0.852 | 0.864 | 0.864 | 0.943 | 0.943 | 0.955 |
| I3 (61, seen) | 0.803 | 0.836 | 0.902 | 0.967 | 0.967 | n/a |
| M5 test (125) | 0.832 | 0.920 | 0.920 | 0.920 | 0.920 | 0.920 |
| M4 test (63) | 0.889 | 0.921 | 0.921 | 0.921 | 0.921 | 0.873 |
| V3 test (206) | 0.005 | 0.214 | 0.214 | 0.214 | 0.214 | 0.209 |

I8 by rule (n 40 each): exact, qualified, lowercase-joined 1.0 for R3, R5 and R6; module member 0.975 for all three; fragment R3 0.575, R5 and R6 0.925 (F 0.975, D 0.600); misspelled 0.875 for all three (F 0.0).

## Conditions

| # | Condition | Result |
|---|---|---|
| T1 | I8: R6 − R3 ≥ +3 pts, p5 > 0 | **Met**: +5.8 (p5 +3.3) |
| T2 | I8 fragment: R6 − R3 ≥ +20 pts, p5 > 0 | **Met**: +35.0 (p5 +22.5) |
| T3 | I8 misspelled: R6 − R3 ≥ −5 pts | **Met**: 0.0 |
| T4 | I8 exact, qualified, lowercase-joined, module member: R6 within 1 pt of R3 | **Met**: 0.0 on all four (the round 6 S4 test) |
| T5 | Replay: M5, M4, V3 within 0.5 pt; no replay set loses more than 1 pt | **Met**: 0.0 on M5, M4, V3; gains on the seen sets I5 (+8.0), I3 (+6.6), I6 (+3.8) |
| T6 | R6-nolex within 1.5 pts of R6 on I8, I6, M5, V3 | **Met**: −0.4 (I8), +0.8 (I6), 0.0 (M5), −0.5 (V3) |
| T7 | I6: R6 returns the gold of `USDKit.arrayCount` in the top 10 | **Met**: R3 hit, R5 miss, R6 hit |
| L1 | Non-trigger p95 ≤ 50 ms in three working-machine passes | **Not evaluable**: 0 of 6 passes inside the limits |

Decision rule: T1 to T5 all met, so R6 is recorded as confirmed.

## Dotted queries and the exception

I8 has 40 dotted queries (all in the qualified rule); the R5 trigger fires on 80 of 240 queries, the R6 trigger on 80. Dotted queries are exact names that the exact-name route already answers, so the exception rarely changes anything: R6 routes 0 queries differently from R5 on I8, 1 on I3, 1 on I5 and 1 on I6 (the `USDKit.arrayCount` case, which moves from miss to hit, so I6 goes from 0.954 to 0.958). A rule that skips the fallback for dotted queries is therefore safe and very cheap, and R5 would also have passed T4 on I8; the round 6 failure was a single-query event.

## Latency (L1: not evaluable; informational figures)

Protocol (plan 17.5): a pass counts only if its start load average is at most 6.0 and CPU idle at least 60%. Two runs of three passes were taken; none qualified. CPU idle was 61 to 71% at the start of every pass, but the 1-minute load was 6.8 to 9.1, above the limit, so all six passes are excluded and L1 is not met. After the runs the load climbed to 49 from unrelated work, so the protocol could not be satisfied with a further run at that moment.

| Pass | Load at start | CPU idle at start | Non-trigger p95 (ms) | Trigger path p95 (ms) | Overall p95 (ms) |
|---|---|---|---|---|---|
| 1 | 9.1 | 69.8% | 41.8 | 39.1 | 41.6 |
| 2 | 8.2 | 64.7% | 40.0 | 37.5 | 39.6 |
| 3 | 7.4 | 68.9% | 38.9 | 40.3 | 38.9 |
| 4 | 6.8 | 71.4% | 39.6 | 38.9 | 39.5 |
| 5 | 7.1 | 61.3% | 40.5 | 39.5 | 40.3 |
| 6 | 7.4 | 69.2% | 46.8 | 44.0 | 46.6 |

Embed p95 was 16.4 to 19.7 ms, int8 scan p95 22.6 to 28.8 ms and trigram search p95 2.4 to 3.0 ms; the trigger rate is 14.5% of the 722-query mix. All six non-trigger p95 values are below 50 ms, including pass 6, during which the load rose to 16.9. Together with round 6's 36.9 to 39.3 ms at load 4.4 to 4.5, the path sits at about 37 to 47 ms across load 4 to 17. That supports the budget being met in ordinary use, but no pass satisfied a registered protocol, so it is not a certified result.

## Caveats

- I8 gold and queries are mechanical, so they test identifier handling, not human phrasing; the mixed-intent sets M4 and M5 show R6 equal to dense only.
- Gains on I3, I5 and I6 are on seen sets and were not used for the decision.
- The pack, model and queries are one fixed SDK on one Mac. CPU-only, CUDA and Windows are not measured.

## What this means for the proposal

- The lane is dense only, an exact-name map, and a single-token trigram fallback that skips queries containing a dot. It is supported by fresh data from rounds 6 and 8 and costs no measurable recall on mixed-intent queries.
- The query path measures about 37 to 47 ms p95 on a working machine; the full-pack embed projects to about 11.5 minutes (round 7). Both are close to, but not provably inside, the 50 ms and 10-minute defaults.
