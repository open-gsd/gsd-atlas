# Plan section 14: round 5 (frozen 2026-10-29, before any round 5 target is drawn, any query is written, or any round 5 arm is scored)

Status: research evidence only. No product code, dependency, ROADMAP or ADR change. Follows `plan-section-13.frozen.md`; sections 12 and 13 stay frozen.

## 14.1 Why round 5

Round 4 found that the pre-registered router (R4: exact-name hit to lexical, name-token hit to weight 3 fusion, else dense) lost 2.9 points to dense only on vocabulary-gap queries and 1.6 on mixed queries, while the other registered candidate (R3: exact-name hit to lexical, everything else dense only) matched dense only there and added 6.6 points on identifiers. R4 won the tuning choice by four queries of a 36-query half. R3 is the simpler arm, and every number for it so far was seen after the fact. Round 5 registers R3 as the primary arm before looking at any fresh data and tests it on queries that no earlier round has seen.

Out of scope, by decision of the user: Windows, Node 24 CI, CUDA, CPU-only arms, human-written queries. Mac (Metal) only.

## 14.2 Fixed inputs

- Pack, model, document vectors and prefixes as in 13.2 (MacOSX27.0.sdk, 146,554 declarations, EmbeddingGemma 2 Q8_0 on Metal, cached base-pool vectors sha256 b250d376…e19d, dense text `docText3`). Pool-lite is not used (round 4: it loses identifiers). Swift prose enrichment is not used (the pack stays the base pack so that round 5 numbers compare with rounds 3 and 4).
- Earlier sets, used only as replication (they were seen): V3 test (206), I3 test (61), M4 test (63), frozen hashes in `round4/FREEZE.md`.
- Statistics: paired bootstrap, 10,000 resamples, seed 42, 5th percentile (p5). Test/tuning split by `fnv1a(kind|id) mod 10 < 3` is tuning, `kind` being `M5` or `I5`.
- Reproduction gate: before any new set is read, the harness must reproduce V3 test D 0.214, V3 R3 0.214, I3 test R3 0.902, M4 test R3 0.921 on the base pool.

## 14.3 Fresh sets

- **M5 (mixed intent, fresh):** 184 targets drawn by `sample-m5.mjs` (seed 51, reserve seed 52) from the V3-style eligibility rules and strata (A objc documented pre-27, B objc documented macOS 27, C Swift macOS 27, D Swift pre-27) excluding every V3, I3 and M4 target and every rejected target: main A 60, B 12, C 60, D 28 (160), reserve A 8, B 4, C 8, D 4 (24). Stratum B has few eligible declarations left after round 4, hence 12. Four fresh AI authors, 46 targets each (reserve is authored too), on the small and mid model tiers, each with a different task context in the brief: (1) building a new feature, (2) fixing a compile error, deprecation warning or crash, (3) porting or migrating code from another platform or an older API, (4) reading unfamiliar code and checking what a framework offers for one need. Same query rules as M4 (5 to 25 words, at least one name/owner/framework piece, never the full name, no copied documentation text). Checker `round4/check-m4.mjs`, unchanged, rejected queries dropped not repaired. At least 120 accepted queries are required, else a second draw with the same checker. The set is frozen with its sha256 before any arm is scored on it.
- **I5 (identifiers, fresh, mechanical):** 120 queries, seed 53, from the I3 construction (same eligibility and the same six rules: exact, qualified, fragment, lowercase-joined, misspelled, module member), 20 per rule, half Objective-C and half Swift, excluding every earlier target and I3 id and every M5 target.

## 14.4 Arms

Notation as in 13.4: `L` = the F2 (porter-stemmed word) list, `F` = trigram list, `D` = dense top 50 over the full pool, `r2Hit(q, L)` = the exact-name test on the top F2 hit (name, owner.name or framework.name equals the whole query, case-insensitive).

- `F`, `F2` (= L), `D`, `E` (RRF, equal weight), `R2w3` (round 3 primary), `R4` (round 4 primary).
- **`R3` (primary, registered now):** if `r2Hit(q, L)` then `L` else `D`.
- **`R5` (second candidate):** if `r2Hit(q, L)` then `L`; else if the query is a single token (no whitespace) of 5 or more characters then RRF of `F` and `D` with equal weight (k 60); else `D`.
- **`Rq`:** `R3` with the dense lane replaced by an int8 scan at 256 dimensions (MRL truncation of the cached vectors, renormalised, then scaled and rounded as in `round3/quant3.mjs`), top 50.
- **`RR50`, `RR20`:** the `R3` list reranked by Qwen3-Reranker-0.6B Q8_0 over its top 50 and top 20 candidates; exact-name hits skip the reranker.
- **`R3-qwen`, `D-qwen`:** `R3` and `D` with Qwen3-Embedding-0.6B Q8_0 vectors (cached round 3 vectors; document text without prefix, query prefix as in round 3).

No parameter is tuned for `R3`. The tuning halves of M5 and I5 are used for exactly one decision: `R5` is recommended over `R3` only if on the pooled tuning halves of M5 and I5 `R5 − R3` is at least +1 point and `R5` is not below `R3` on the M5 tuning half; otherwise `R3` stays the recommended arm.

## 14.5 Conditions

Evaluated on the test halves.

| # | Condition |
|---|---|
| Q1 | I5: `R3 − D` ≥ +3 points with p5 > 0 (the exact-name gain replicates on fresh identifiers). |
| Q2 | M5: `R3 − D` ≥ −1 point (the shortcut costs nothing on mixed queries). |
| Q3 | `R3` ≥ max(`F`, `F2`) − 1 point on M5 and on I5 (non-inferior to the better lexical arm on both). |
| Q4 | V3 test: `R3 − L` ≥ +5 points with p5 > 0 (replication, seen set). |
| Q5 | I5: `R5 − R3` ≥ +2 points with p5 > 0, and M5: `R5 − R3` within 0.5 point; `R5` recommended only by the rule in 14.4. |
| Q6 | Pooled fresh test (M5 and I5): `RR50 − R3` ≥ +3 points with p5 > 0. `RR20` reported. Two reranker runs over 60 queries give identical top-10 lists. Reranker latency reported (no pass or fail). |
| Q7 | Qwen3: M5 `R3-qwen − D-qwen` ≥ −1 point and I5 `R3-qwen − D-qwen` ≥ 0. |
| Q8 | `Rq` within 1 point of `R3` on M5, I5 and V3 (paired, mean difference), and the added query latency of the `Rq` configuration (embed, int8 256 scan, F2 search) reported as p95 over three passes with nothing else running on the machine; no pass or fail against the 50 ms budget but the figure is compared with it. |
| Q9 | Power flags: M5 test below 80 queries or I5 test below 60 queries marks the conditions that use that set as underpowered. |

## 14.6 Decision rule

Q1 to Q4 met: `R3` (or `R5` by the 14.4 rule) is recorded as the router for the proposal and replaces the round 3 and round 4 primaries. Q6 met: the reranker is recorded as a candidate second stage with its latency as a blocker. Q7 met: the router is not specific to one embedding model. Q8 met: 256-dimension int8 storage is recorded as supported. Anything not met is reported as not met, and no arm is tuned after test results are read.

## 14.7 Procedure and amendments

Order: freeze this plan and the sampler, draw targets, author M5, check and freeze M5 and I5, build lists (`lists5.mjs`, extending `round4/lists4.mjs` with the F, int8-256 and Qwen3 variants), score, rerank, write the results note. Amendments go in `round5/FREEZE.md` with date and reason; any change after a part has been scored is labelled.

## 14.8 Stated in advance

All queries are AI-authored (small and mid-tier Claude models). The M5 test half will be about 100 queries, so a difference below about 4 points is not resolvable at p5. The mixed-intent queries favour lexical arms by construction (a name word is required), so `Q3` is the harder side of the comparison. The budget blockers from round 3 (24 minutes of full-pack embedding, 118 ms added query p95) are not addressed by this round except through the `Rq` latency figure.
