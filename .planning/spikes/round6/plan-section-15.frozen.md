# Plan section 15 (round 6): single-token trigram fallback (R5) confirmation and lexical-free query path

Frozen 2026-10-29 before any round 6 target is drawn and before any round 6 arm is scored. Research only: no product code, dependency, ROADMAP or ADR change. Mac (Metal) only. All queries AI-authored or mechanical (no human-written queries). Same pack, model, base-pool vectors, prefixes and `docText3` as rounds 3 to 5.

## 15.1 Questions

1. Does the single-token trigram fallback (R5) improve identifier retrieval over R3 on a fresh identifier set, as the I5 test half suggested (+7.9, p5 +3.4) but the registered tuning rule did not recommend?
2. Does a router that needs no word-level lexical search (F2) at query time reproduce R3/R5 recall exactly, and what is the added query latency of that path on a quiet machine?

## 15.2 Arms

- **D**: dense only (float32 top 50).
- **R3**: exact-name hit (case-insensitive equality with name, qualified name, or framework.name pair) returns the exact-hit list, else D. The exact-hit list is the round 5 definition.
- **R5**: R3, plus: a query that is a single token of at least 5 characters (round 5 definition) and has no exact-name hit returns RRF(F trigram, D, k 60, weight 1).
- **R5-nolex** (the product-shaped path): exact-name lookup through an in-memory map, not FTS; trigram search only when the R5 trigger fires; dense lane int8 256 dimensions (MRL truncation, renormalised, x127x3 rounded as round 5); no F2 search anywhere.
- **R5-t4 / R5-t6** (exploratory, never decisive): R5 with the length trigger at 4 and at 6 characters.
- Reference lexical arms F and F2 as in round 5.

## 15.3 Sets

- **I6 (fresh, mechanical identifiers):** 240 queries, 40 for each of the six I5 rules (exact, qualified, lowercase-joined, module member, fragment, misspelled), drawn by a new seed (61) from the pool, excluding every target of V3, I3, M4, M5, I5. Rule definitions, query construction and gold unchanged from `round5/sample-m5.mjs`. If a rule has fewer than 40 eligible targets, it takes all of them and the shortfall is reported. No tuning split: the whole set is test.
- **Replay (regression only):** M5 test (125), M4 test (63), V3 test (206), I5 test (88), I3 test (61) with R3, R5 and R5-nolex.
- I6 sampler and list builder are written and hashed (amendment in `FREEZE.md`) before the draw; the draw hashes are recorded before scoring.

## 15.4 Conditions (strict, fixed in advance; paired bootstrap 10,000, seed 42, p5 lower bound)

| # | Condition | Metric |
|---|---|---|
| S1 | R5 − R3 ≥ +3 pts on I6 overall, p5 > 0 | recall@10 |
| S2 | R5 − R3 ≥ +20 pts on the fragment stratum (n 40), p5 > 0 | recall@10 |
| S3 | R5 − R3 ≥ −5 pts on the misspelled stratum | recall@10 |
| S4 | R5 within 1 pt of R3 on exact, qualified, lowercase-joined and module-member strata | recall@10 |
| S5 | Replay: R5 − R3 within 0.5 pt on M5, M4, V3 test; no replay set loses more than 1 pt | recall@10 |
| S6 | Pooled I5 test + I6 (n 328): R5 − R3 ≥ +3 pts, p5 > 0 | recall@10 |
| S7 | Equivalence gate: R5-nolex recall within 1.5 pts of R5 on I6, I5, M5, V3 (the cost of int8-256 and map-based exact lookup) | recall@10 |
| S8 | Latency (non-trigger path = embed + int8 256 scan + map lookup): p95 ≤ 50 ms in each of three passes on a quiet machine | ms |
| S9 | Latency (trigger path, adds trigram search): p95 reported; informational, with the share of queries that trigger it in M5, M4, I6 | ms |

Decision rules:
- R5 is recorded as confirmed only if S1, S2, S3, S4 and S5 are all met. S6 is supporting; if S1 and S2 are met and S6 is not, the result is "confirmed on I6, pooled unclear".
- If S2 is met and S3 or S4 fails, R5 is recorded as a fragment-only fallback, with the harm stated.
- If S1 is not met, R5 is recorded as not confirmed and the I5 gain as not replicated.
- The routing decision is by these rules, not by post hoc subgroup choices. R5-t4 and R5-t6 are exploratory.

## 15.5 Latency protocol

- Quiet machine: no other GPU or heavy process; load average (1 min) below 1.5 at the start of each pass, recorded. A pass with a violating sample is discarded and re-run, and the discard is reported.
- Three passes of every query of M5 test, M4 test, I6 and V3 test, in a single process with the model, int8 matrix, map and trigram index loaded and one warm-up query excluded. Time per query: embed, int8 scan, map lookup, trigram search (when triggered), fusion; report p50 and p95 per component and in total, for the non-trigger and trigger paths separately, and the overall p95 weighted by the actual trigger rate.
- S8 judges the median of the three pass p95s and also requires each pass to be ≤ 50 ms; the pass values are all reported.
- The round 5 exploratory figures (embed + int8 scan 45.3 / 49.2 / 45.4 ms) are not reused as evidence.

## 15.6 Power and flags

- Fragment stratum n 40: a +20 point difference is detectable; smaller fragment effects are flagged as underpowered. Other strata (n 40 each) detect only large differences and are reported with intervals.
- The mixed-intent replay sets contain almost no triggers; S5 is expected to hold trivially and is reported with the trigger count.

## 15.7 Out of scope

Reranker, fusion arms, other embedders, Windows, CUDA, CPU-only, the 24-minute full-pack embed, and product code. Round 6 does not change any earlier result; amendments go to `round6/FREEZE.md`.

## 15.8 Deliverables

`round6/results/r6-score.json`, `docs/research/embedding-retrieval-spike-results-round6.md`, MANIFEST row R6, todo and proposal status updates, one commit on this branch, not pushed.
