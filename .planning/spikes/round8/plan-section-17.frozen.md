# Plan section 17 (round 8): the dotted-query exception to R5 (S4) and a fresh latency check (S8)

Frozen 2026-10-29 before any round 8 target is drawn and before any round 8 arm is scored. Research only: no product code, dependency, ROADMAP or ADR change. Mac (Metal) only. All queries mechanical. Same pack, model, base-pool vectors, prefixes and `docText3` as rounds 3 to 7. Runs after round 7 has finished so that the two do not compete for the GPU.

## 17.1 Questions

1. Round 6 recorded R5 as a fragment-only fallback because it failed S4 on one query (`USDKit.arrayCount`: the exact shortcut did not fire, the trigram lane pushed a near-name above the target). Does skipping the fallback for queries that contain a dot remove that harm without losing the fragment gain, on a fresh identifier set?
2. Does the lexical-search-free query path meet the 50 ms p95 budget under a stated working-machine protocol, since the quiet-machine protocol (load below 1.5) proved unreachable on this machine?

## 17.2 Arms

- **R3**, **R5**, **D**, **F**: as in round 6.
- **R6**: R5, except the single-token trigram fallback is not triggered when the query contains the character `.`. The trigger is otherwise round 6's (no whitespace, at least 5 characters, no exact-name hit). The change is fixed here and not tuned.
- **R6-nolex**: the product-shaped path of round 6 (name map for exact hits, int8 256-dimension dense lane, trigram search only when the R6 trigger fires, no F2).

## 17.3 Set

- **I8 (fresh, mechanical identifiers):** 240 queries, 40 for each of the six round 5 rules (exact, qualified, lowercase-joined, module member, fragment, misspelled), seed 81, excluding every target of V3, I3, M4, M5, I5 and I6. Rule definitions, query construction and gold unchanged from `round6/sample-i6.mjs` (the sampler is copied with only the seed and the exclusion list changed; the diff is recorded). Whole set is test.
- **Replay (regression only, informational for R6):** I6 (240), I5 test (88), M5 test (125), M4 test (63), V3 test (206), I3 test (61), with R3, R5, R6 and R6-nolex. I6 and I5 were seen; they are not decisive.

## 17.4 Conditions (paired bootstrap 10,000, seed 42, p5 lower bound)

| # | Condition | Metric |
|---|---|---|
| T1 | I8: R6 − R3 ≥ +3 pts overall, p5 > 0 | recall@10 |
| T2 | I8: R6 − R3 ≥ +20 pts on the fragment stratum, p5 > 0 | recall@10 |
| T3 | I8: R6 − R3 ≥ −5 pts on the misspelled stratum | recall@10 |
| T4 | I8: R6 within 1 pt of R3 on exact, qualified, lowercase-joined and module-member strata (the S4 test) | recall@10 |
| T5 | Replay: R6 − R3 within 0.5 pt on M5, M4, V3 test; no replay set loses more than 1 pt | recall@10 |
| T6 | R6-nolex within 1.5 pts of R6 on I8, I6, M5, V3 | recall@10 |
| T7 | Round 6 S4 query: on I6, R6 returns the gold for `USDKit.arrayCount` within the top 10 | hit |
| L1 | Latency (working-machine protocol below): non-trigger p95 ≤ 50 ms in each of three passes, and median of pass p95s ≤ 50 ms | ms |

Decision rules:
- R6 is recorded as confirmed (R5 with the dot exception) only if T1, T2, T3, T4 and T5 are all met. T6 and T7 are supporting.
- If T4 fails on I8 again, the dot exception is recorded as not fixing the harm and R5 stays fragment-only.
- If T2 fails but T4 is met, the exception cost the fragment gain (fragments with a dot are not expected, so this would be reported as an unexpected finding).
- Nothing about R6 is claimed from I6, I5 or the other seen sets.

## 17.5 Latency protocol (L1), stated now because the round 6 protocol could not be met

- The round 6 rule (load1 below 1.5 per pass) stays recorded as unmet; this protocol is a different, weaker one and results under it are named "working-machine" and never "quiet".
- Pass-start requirement: 1-minute load average at most 6.0 and CPU idle at least 60%, both recorded at the start and end of each pass. A pass that starts outside this is re-run once; if it still is, it is reported and excluded from L1, which then needs three included passes.
- Three passes of the 722-query latency mix (M5 test, M4 test, I6, V3 test, I5 test as in round 6), one process, model, int8 matrix, name map and trigram index loaded, one warm-up query excluded. Per-component p50 and p95, non-trigger and trigger paths separately, trigger rate.
- No other session of this project runs a model or a benchmark during the passes.
- L1 is evidence for the budget under ordinary use of this machine, not a hardware-independent claim.

## 17.6 Power and flags

The fragment stratum (n 40) detects a +20 point effect; other strata detect only large differences and are reported with intervals. Dotted queries occur only in the qualified and module-member rules; their count in I8 is reported, and the number of queries R6 routes differently from R5 is reported.

## 17.7 Out of scope

Reranker, fusion arms, other embedders, the full-pack embed (round 7), Windows, CUDA, CPU-only, and product code. Round 8 changes no earlier result; amendments go to `round8/FREEZE.md`.

## 17.8 Deliverables

`round8/results/r8-score.json`, `docs/research/embedding-retrieval-spike-results-round8.md`, MANIFEST row R8, todo and proposal status updates, commits on this branch.
