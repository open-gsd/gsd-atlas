# Embedding retrieval spike, round 4: router, mixed queries, reranker, scoping, Swift prose

Date: 2026-10-29. Status: research evidence only. No product code, dependency, ROADMAP or ADR change. Plan section 13 was frozen before any arm was scored or any M4 target was drawn (`.planning/spikes/round4/plan-section-13.frozen.md`, sha256 `e51b94ca…0f49`); amendment A1 and the frozen M4 record are in `.planning/spikes/round4/FREEZE.md`; results in `.planning/spikes/round4/results/`. Windows, CUDA, CPU-only arms and human-written queries were out of scope by decision (the consumers of this lookup are AI agents, so AI-authored queries are the intended distribution).

## Short answer

Two of the four registered parts miss at least one condition (router, reranker and Swift prose each have a strict miss); Pool-lite meets its one condition but exposes a cost on identifiers.

1. **Router.** The pre-registered primary router (R4) fails two of its four conditions (P1, P3): it is still 2.9 points below dense only on vocabulary-gap queries and 1.6 below on mixed queries. The simpler candidate registered next to it, R3 (exact-name hit goes to lexical, everything else dense only), equals dense only on V3 and M4 and adds 6.6 points on identifiers. It was not the tuned pick, so it is reported here as an observation, not as a passed condition.
2. **Reranker.** Adds 3.9 points on V3 (p5 exactly 0.0, so the strict condition is missed) and clear gains on identifiers (+6.6) and documented Objective-C (+10.3), none on Swift. It costs 620 ms per query at 50 candidates, 12 times the 50 ms budget.
3. **Pool-lite.** Inside the scope the dense lane is better (0.302 against 0.218), but identifiers outside the scope become unreachable (I3 0.902 to 0.279 with the dense lane scoped), so scoping the dense lane alone is not supported.
4. **Swift prose.** Doc comments from `swift-symbolgraph-extract` reach 38 percent of the prose-less Swift declarations. Stratum C (macOS 27 Swift) rises from 0.125 to 0.214, the pooled Swift strata by 5.4 points (p5 exactly 0.0, strict condition missed).

## Inputs

- Same pack, frozen V3 (285) and I3 (90) sets, EmbeddingGemma 2 Q8_0 on Metal and cached round 3 vectors as in section 13.2. Reproduction gate passed (V3 D 0.214, R2w3 0.180, I3 D 0.836, I3 R2w3 0.902, I3 test lists identical to the saved ones) after amendment A1 (below).
- **M4 (new, mixed intent):** 99 queries from three fresh AI authors (one small and two mid-tier models, so not one model family), 108 submitted, 99 accepted by `check-m4.mjs`; strata A 34, B 18, C 34, D 13; test half 63, tuning half 36. Each query holds at least one name, owner or framework word and describes a goal, the way an agent writes it. Lexical recall is high here by construction (F 0.889, F2 0.810).
- **Primary router:** chosen on tuning halves only (mean recall@10 over V3, I3, M4): R3 0.677, R4 0.705, so R4 (exact-name hit goes to lexical, name-token hit on the lexical top result goes to weight 3 fusion, otherwise dense only). The M4 tuning half (36 queries) decided it: R4 0.944, R3 0.833 (four queries).
- **Reranker:** Qwen3-Reranker-0.6B Q8_0 via node-llama-cpp over the primary router's top 50 (20 as secondary), exact-name hits skip it.
- **Swift prose:** 169 Swift modules extracted with `swift-symbolgraph-extract` (380 graphs, 113,488 symbols, 51,773 with a doc comment); 25,698 of 67,651 prose-less Swift records matched by `module|owner.name` and enriched; those documents were re-embedded in 292 s, both lexical indexes rebuilt.

## Results (test halves, recall@10, EmbeddingGemma 2)

| Set (n) | F | F2 = L | D | E (RRF) | R2w3 (round 3) | R3 | R4 (primary) |
|---|---|---|---|---|---|---|---|
| V3 vocabulary gap (206) | 0.005 | 0.005 | 0.214 | 0.146 | 0.180 | 0.214 | 0.184 |
| I3 identifiers (61) | 0.803 | 0.656 | 0.836 | 0.902 | 0.902 | 0.902 | 0.902 |
| M4 mixed (63) | 0.889 | 0.810 | 0.921 | 0.873 | 0.905 | 0.921 | 0.905 |

On mixed queries dense only (0.921) beats the lexical arms (0.810 to 0.889) and the equal-weight fusion (0.873). Fusion does not beat dense only on any of the three sets; its only gain over dense is on identifiers, and the exact-name shortcut (R3) captures all of it.

### Conditions

| # | Condition | Result |
|---|---|---|
| P1 | primary − D on V3 ≥ −1 pt | **Not met**: −2.9 (p5 −4.9) |
| P2 | I3 primary ≥ F − 1 pt and ≥ R2w3 − 2 pts | **Met**: +9.8 vs F, 0.0 vs R2w3 |
| P3 | M4 primary ≥ max(L, D) − 1 pt | **Not met**: 0.905 vs 0.921 (−1.6) |
| P4 | primary − L on V3 ≥ +5 pts, p5 > 0 | **Met**: +18.0 (p5 +13.6) |
| RK1 | V3: RR50 − primary ≥ +3 pts, p5 > 0 | **Not met**: +3.9, p5 0.0 (mean passes, the p5 bound does not) |
| RK2 | I3 and M4 not below primary by more than 1 pt | **Met**: +6.6 (p5 +1.6) and +1.6 (p5 −4.8) |
| RK3 | two reranker runs identical (60 queries) | **Met**: 60 of 60 |
| RK4 | added reranker latency (reported) | 50 candidates: p50 620 ms, p95 693 ms; 20 candidates: p50 249 ms, p95 283 ms |
| L1 | in scope, D_lite − D_full ≥ −1 pt | **Met**: +8.4 (p5 +5.0) |
| L2 | all-query recall of the lite pool (reported) | below |
| SW1 | V3 strata C+D: D_sw − D ≥ +3 pts, p5 > 0 | **Not met**: +5.4, p5 0.0 |
| SW2 | A, B and I3, M4 not hurt | **Met**: A+B +0.9, I3 +1.6, M4 +3.2 |
| SW3 | enrichment cost (reported) | 25,698 records (38.0 percent), 292 s re-embedding on Metal |

The three strict misses (RK1, SW1 and, with a larger gap, P1 and P3) are listed as not met. RK1 and SW1 have positive means above the +3 threshold; their lower bound sits exactly at 0.0 because the paired differences are sparse (a few queries change). They are close calls, not confirmations.

### Router detail

- Primary minus L on V3 by stratum: A +29.4, B +15.6, C +10.7, D +10.8 (all p5 > 0), as in round 3.
- M4: primary − L +9.5 (p5 +3.2), primary − D −1.6 (p5 −6.4), D − L +11.1 (p5 +3.2). By stratum (D, primary): A 0.950 / 0.950, B 1.000 / 1.000, C 0.833 / 0.833, D 1.000 / 0.889 (n 9).
- I3 by rule, primary: exact 0.889, qualified 1.0, fragment 0.5 (D alone 0.5, F 1.0), lowercase-joined 1.0, misspelled 1.0, module member 1.0. The fragment rule is the one place the trigram arm still wins (F 1.0).
- **Exploratory, after seeing the above, not a registered condition:** R3 (unselected registered candidate): V3 0.214 (R3 − R4 +2.9, p5 +1.0), I3 0.902 (R3 − D +6.6, p5 +1.6), M4 0.921 (R3 − R4 +1.6, p5 −3.2), and R3 − L on V3 +20.9 (p5 +16.0). It would pass P1 to P4. The tuning half picked R4 by four M4 queries, which is within noise.

### Reranker detail

- V3 test: primary 0.184, RR50 0.223, RR20 0.214. Dense recall@50 of the primary list is 0.34 on V3 (the reranker cannot find what is not a candidate).
- By stratum (primary → RR50): A 0.309 → 0.412 (+10.3, p5 +1.5), B 0.156 → 0.178, C 0.107 → 0.107, D 0.108 → 0.108. The reranker helps where documentation text exists and does nothing for prose-less Swift declarations.
- I3 0.902 → 0.967; M4 0.905 → 0.921.
- Latency exceeds the 50 ms budget by an order of magnitude on this runtime. It is a candidate for an opt-in second stage, not for the default path.

### Pool-lite (37,293 documents, 25.4 percent)

| | Full pool | Pool-lite |
|---|---|---|
| V3 test, gold in scope (n 179), dense only | 0.218 | 0.302 |
| V3 test, all (n 206), dense only | 0.214 | 0.262 |
| V3 test, all, primary | 0.184 | 0.238 |
| I3 test, primary | 0.902 | 0.279 |
| M4 test, primary | 0.905 | 0.778 |

Gold inside the lite pool: V3 248 of 285, I3 28 of 90, M4 86 of 99. Index time is about 6 minutes (round 3). A smaller pool raises recall on what is in it, but the pool excludes undocumented pre-26 declarations, which is where most identifier queries land (I3 targets are mostly such names). Exploratory arm (lexical lane over the full pool, dense lane over the lite pool): V3 0.248 (R4) or 0.262 (R3), I3 0.639, M4 0.810 or 0.794; it recovers part of the identifier loss and not all, because misspelled and fragment identifiers are solved by dense and not by lexical.

### Swift prose

| V3 test | Dense base | Dense with prose | Change (p5) |
|---|---|---|---|
| Strata C+D (n 93) | 0.129 | 0.183 | +5.4 (0.0) |
| C (macOS 27 Swift, n 56) | 0.125 | 0.214 | +8.9 (+1.8) |
| D (pre-27 Swift, n 37) | 0.135 | 0.135 | 0.0 (−8.1) |
| A+B (objc, n 113) | | | +0.9 (0.0) |

Primary arm on C+D: 0.108 → 0.183 (+7.5, p5 +2.2, not a registered condition). On Swift-only M4 queries: primary 0.848 → 0.909 (n 33). The gain comes from stratum C; D (pre-27) does not move because the symbol graphs carry few comments for those records. The enrichment is derived from the SDK alone, with no network, and costs about 5 minutes of extra embedding on Metal (about 38 percent of the Swift records).

## Deviations, errors and amendments

- **A1 (before any new-arm result was read):** the plan quoted the round 3 I3 value of R2w3 as 0.918. The gate reproduced 0.902; the saved round 3 result file also says 0.902, and 0.918 is the value of the weight 1 and 2 variants. The round 3 note and the todo carried the wrong figure and were corrected with a dated paragraph. Round 3 conditions and verdict are unchanged.
- **M4 draw:** 108 queries submitted (90 main plus 18 reserve, all authored), 99 accepted; plan 13.3 asked for at least 60.
- **Exploratory arms** (R3 against the conditions, hybrid-lite) were added after the registered results and are labelled as such.
- **Latency figures** from the stage 1 run (scan p95 about 178 ms) were taken while the Swift re-embedding job was running on the same GPU and are not valid; the round 3 figure (added p95 118 ms on a quiet machine) stands.
- The bug where `score4.mjs` crashed on a placeholder field was fixed before any reranker number was read.

## Limitations

- All queries are AI-authored. M4 authors are not one family (small and mid-tier models), but all are Claude models; no other vendor's model wrote queries.
- M4 test half is 63 queries and the tuning half 36; the router choice rests on four queries. The RK1 and SW1 lower bounds are exactly 0.0 and sensitive to a handful of queries.
- Lexical recall is high on M4 by design (it requires a name word), so M4 favours the lexical arms more than V3; real agent traffic is a mixture of V3-like, M4-like and identifier queries in unknown proportions.
- Symbol-graph join keys are heuristic (overloads share a key, first comment wins); 62 percent of the Swift records stay without prose.
- Single machine (Metal), EmbeddingGemma 2 only in this round. Windows, Node 24, CUDA and CPU-only paths were not run by decision.
- The reranker was Qwen3-Reranker-0.6B only; no other reranker, no distillation, no batching or caching was tried.

## What this means for the proposal

- Replace the fusion step with the exact-name shortcut plus dense only (R3); register it and re-score on frozen sets in a short round with a fresh M4-style tuning set, not the 36-query half that tipped this round.
- Treat the reranker as optional and slow (RR20 at about 250 ms is the cheaper end), valuable for documented declarations and identifiers.
- Keep the dense lane over the full pool; if the index-time budget requires scoping, scope documents by what the lexical lane can already answer, not the dense lane by documentation presence.
- Make symbol-graph prose a pack input for Swift; it helps stratum C at no network cost.
- Budget is still the blocker: 24 minutes of full-pack embedding and a query path of 118 ms before any reranker.
