# Embedding retrieval spike, round 5: exact-name shortcut plus dense-only router on fresh queries

Date: 2026-10-29. Status: research evidence only. No product code, dependency, ROADMAP or ADR change. Plan section 14 was frozen before any target was drawn (`.planning/spikes/round5/plan-section-14.frozen.md`, sha256 `25d47249…8c78`); hashes of the fresh sets and harness are in `.planning/spikes/round5/FREEZE.md`; results in `.planning/spikes/round5/results/r5-score.json`. Mac (Metal) only; Windows, CUDA, CPU-only arms and human-written queries were out of scope by decision.

## Short answer

The exact-name shortcut plus dense only (R3) is safe but adds nothing measurable on fresh queries. On the fresh mixed-intent set (M5, 125 test queries) R3 produces the same lists as dense only, and on fresh identifiers (I5, 88 test queries) it equals dense only (0.864), so the +6.6 points seen on I3 in round 4 did not replicate (Q1 not met). R3 clearly beats both lexical arms on mixed queries (0.920 against 0.832 and 0.800) and on vocabulary-gap queries, and it behaves the same with Qwen3 vectors. A single-token fallback (R5) lifts fresh identifiers by 7.9 points (0.943), but the pre-registered tuning rule did not recommend it, so it needs one more confirmation. The reranker is not confirmed (+1.9 points pooled, p5 −0.9). With 256-dimension int8 vectors the quiet-machine query path is 61.7 ms (p95), 12 ms over the 50 ms budget.

## What was run

- Same pack, model, base-pool vectors and prefixes as round 3 (MacOSX27.0.sdk, 146,554 declarations, EmbeddingGemma 2 Q8_0, Metal). Reproduction gate passed (V3 D 0.214, V3 R3 0.214, I3 R3 0.902, M4 R3 0.921).
- **M5 (fresh, mixed intent):** 184 targets drawn by the frozen sampler (excluding every earlier target), four fresh AI authors (two small tier, two mid tier, one task context each: new feature, fixing an error, porting, reading unfamiliar code), 171 accepted by the unchanged M4 checker (13 rejected, dropped). Strata A 63, B 16, C 60, D 32; test half 125.
- **I5 (fresh, identifiers):** 120 mechanical queries, six rules; test half 88.
- Replication on V3, I3 and M4 test halves (already seen in earlier rounds).
- Arms: F (trigram), F2 (stemmed words), D (dense), E (RRF equal weight), R2w3 (round 3), R4 (round 4), R3 (primary), R5 (second candidate), Rq (R3 with int8 256-dimension dense lane), reranker on R3, Qwen3 versions.

## Results (test halves, recall@10, EmbeddingGemma 2)

| Set (n) | F | F2 | D | E | R2w3 | R4 | R3 | R5 | Rq |
|---|---|---|---|---|---|---|---|---|---|
| V3 (206) | 0.005 | 0.005 | 0.214 | 0.146 | 0.180 | 0.184 | 0.214 | 0.214 | 0.209 |
| I3 (61) | 0.803 | 0.656 | 0.836 | 0.902 | 0.902 | 0.902 | 0.902 | 0.967 | 0.934 |
| M4 (63) | 0.889 | 0.810 | 0.921 | 0.873 | 0.905 | 0.905 | 0.921 | 0.921 | 0.873 |
| **M5 (125)** | 0.832 | 0.800 | 0.920 | 0.912 | 0.928 | 0.928 | 0.920 | 0.920 | 0.920 |
| **I5 (88)** | 0.852 | 0.659 | 0.864 | 0.886 | 0.875 | 0.875 | 0.864 | 0.943 | 0.864 |

Bold rows are the fresh sets. Among D, E, R2w3, R4 and R3 the differences on M5 and I5 are 1 to 2 points with p5 at or below 0: none is distinguishable from dense only at this sample size, apart from R5 on identifiers.

### Conditions

| # | Condition | Result |
|---|---|---|
| Q1 | I5: R3 − D ≥ +3 pts, p5 > 0 | **Not met**: 0.0 (p5 −2.3). The I3 gain did not replicate |
| Q2 | M5: R3 − D ≥ −1 pt | **Met**: 0.0 (identical lists: no M5 query is an exact name) |
| Q3 | R3 ≥ best lexical − 1 pt on M5 and I5 | **Met**: M5 0.920 vs 0.832 (+8.8 vs F, p5 +3.2; +12.0 vs F2); I5 0.864 vs 0.852 (+1.1 vs F, p5 −6.8) |
| Q4 | V3: R3 − F2 ≥ +5 pts, p5 > 0 | **Met**: +20.9 (p5 +16.0) |
| Q5 | I5: R5 − R3 ≥ +2 pts, p5 > 0; M5 within 0.5 pt | **Met on the test half**: +7.9 (p5 +3.4); M5 0.0. **Not recommended by the registered tuning rule** (pooled tuning halves: R3 0.962, R5 0.962, no difference) |
| Q6 | Pooled fresh test: RR50 − R3 ≥ +3 pts, p5 > 0; identical reruns | **Not met**: +1.9 (p5 −0.9); reruns identical 60 of 60 |
| Q7 | Qwen3: M5 R3 − D ≥ −1 pt; I5 R3 − D ≥ 0 | **Met**: R3 equals D on M5 (0.912), I5 (0.886), V3 (0.180), M4 (0.857); on I3 R3 0.918 vs D 0.885 |
| Q8 | Rq within 1 pt of R3 on M5, I5, V3 | **Met**: M5 0.0, I5 0.0, V3 −0.5 |
| Q9 | Power flags | Neither underpowered (M5 test 125, I5 test 88) |

Under plan 14.6, Q1 to Q4 are not all met, so R3 is not recorded as replacing the earlier primaries by rule. The practical reading is that all of R3, R4 and R2w3 are equivalent to dense only here, and dense only is the simplest of them.

### Detail

- **Mixed intent (M5):** dense beats the lexical arms in every stratum except B (n 13): A 0.930 (F 0.907), B 0.846 (F 0.923), C 0.953 (F 0.744), D 0.885 (F 0.808). Fusion does not beat dense (E − D −0.8, p5 −4.8).
- **Identifiers (I5) by rule (n):** exact 13: F 1.0, D 1.0, R3 1.0. Qualified 13: all 1.0. Lowercase-joined 16: D 0.938, R3 1.0. Module member 16: all 0.938 for D and R3, lexical 1.0. **Fragment 17:** F 1.0, D 0.588, R3 0.529, R5 0.941. **Misspelled 13:** F 0, D 0.769, R3 0.769, R5 0.769. The trigram arm still wins on fragments and the dense arm on misspellings; R5 takes the better of each for single-token queries.
- **Why R3 did not help:** R3 differs from dense only when a query equals an exact name, qualified name or framework.name pair. On I5 dense already found those 26 queries. The I3 gain came from a handful of queries.
- **Reranker:** pooled RR50 0.915 vs R3 0.897 (+1.9, p5 −0.9); RR20 0.906 (+0.9); M5 0.920 → 0.952 (+3.2, p5 −0.8); I5 unchanged (0.864). Round 4 saw +3.9 on V3, +6.6 on I3, +10.3 on documented Objective-C; with fresh data the effect is positive in direction, small, and not distinguishable from zero. Latency: 50 candidates p50 610 ms, p95 684 ms; 20 candidates p50 244 ms, p95 280 ms.
- **Int8 256-dimension lane:** equal to float32 on the fresh sets and V3; on the seen sets it is mixed (M4 −4.8 points, 3 queries of 63, p5 −9.5; I3 +3.3). Storage 37.5 MB for the full pack.
- **Latency, quiet machine, three passes (p95, embed + int8 256 scan + F2 search):** 61.2, 64.0, 61.7 ms (median 61.7). Components: embed 20.5 to 23, int8 scan 23 to 30, F2 search about 22. The float32 lane totals 107 to 111 ms. Exploratory, not a registered figure: embed plus int8 scan alone (no lexical search; R3 only needs an exact-name lookup) is 45.3, 49.2, 45.4 ms.

## Deviations and caveats

- Q5 is split: the test-half condition is met and the tuning rule did not recommend R5. The tuning halves held too few fragment-style identifiers to separate the arms (78 pooled queries, 0 difference). The rule was fixed in advance, so R5 is reported as not recommended, with the test evidence alongside. A short confirmation on fresh identifiers would settle it.
- I5 test is 88 queries (plan estimate 84); M5 test 125.
- Authors: all Claude models (two tiers). Mixed-intent queries require a name word, which favours lexical arms; dense still wins.
- Single machine, EmbeddingGemma 2 plus the Qwen3 replication; no other embedder or reranker.
- The budget blockers from round 3 stand: 24 minutes of full-pack embedding and a query path above 50 ms.

## What this means for the proposal

- Dense only (with an exact-name guard that costs nothing) is the lane; fusion adds no measurable value on any set, which also removes the need for a lexical search at query time except for identifier-style single tokens.
- Identifier fragments need the trigram arm (R5-style fallback for single-token queries) and misspellings need dense; this is the one routing rule with fresh-data support (+7.9 points, p5 +3.4).
- Reranker: optional and slow, benefit not confirmed on fresh data.
- Int8 256 dimensions: supported on fresh data (37.5 MB), within 12 ms of the 50 ms query budget before dropping the lexical search; roughly 45 to 49 ms without it.
