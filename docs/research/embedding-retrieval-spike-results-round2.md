# Embedding retrieval spike: round 2 results (confirmation round)

**Date:** 2026-10-28
**Plan:** `docs/research/embedding-retrieval-spike-plan.md` section 11, frozen with sha256 `ed37944aaa891aa1c034bc89250ee17b91bcae31858780a05da7c980f922afe7` (frozen text, amendments A1 to A5 and the sha256 of every query set: `.planning/spikes/round2/FREEZE.md`).
**Scope:** SDK declarations only; this Mac only (Apple silicon, Node 26.11.1). Test halves scored once per model; the weight was tuned on the tuning halves only. Raw per-run files: `.planning/spikes/round2/results/`.
**Status:** preliminary evidence for a decision; not a registered result. Nothing in Phase 3, product code, dependencies or frozen files was touched.

## What was run

- **Pool B:** 9,558 declarations: 833 from `@types/node` 24.19.2 and 8,725 from TypeScript 6.0.3 `lib.*.d.ts` (`lib.dom` 5,719, `lib.webworker` 1,970, ECMAScript libraries about 1,000).
- **V2 vocabulary-gap set:** 156 queries that passed the text-overlap checker, written blind by three separate fresh AI agents (agent 1: 74, agent 2: 34, agent 3: 48; 30 further agent queries were rejected by the checker and dropped, not repaired). 36 tuning, 120 test. No human-written queries exist in V2 (amendment A3).
- **I1 identifier set:** 84 mechanically generated queries (exact name, qualified name, fragment, lower-case run-together, one-character misspelling, module plus member). 16 tuning, 68 test.
- **Models and backends:** EmbeddingGemma 2 Q8_0, Qwen3-Embedding-0.6B Q8_0, bge-small-en-v1.5 Q8_0 on llama.cpp Metal (reference); ONNX Runtime CPU through transformers.js for portability (EmbeddingGemma 2 q8, Qwen3 q8 and fp16, bge-small q8).
- **Arms:** F (FTS5), D (dense), E (equal RRF), W2/W3 (weighted RRF), R1/R2 (routers). **Pre-registered primary: R1 with the tuned weight.** R1 sends identifier-shaped queries to F and the rest to the weighted hybrid; R2 sends a query to F only when FTS5's top hit equals the query as an exact name.

## Results: V2 test half (n 120), recall@10, Metal

| Model | F | D | E | Primary R1 (weight) | Lift over F, pts (bootstrap 5th pct) | Over E, pts (5th pct) |
|---|---|---|---|---|---|---|
| EmbeddingGemma 2 | 0.050 | 0.600 | 0.342 | 0.483 (3) | +43.3 (+35.8) | +14.2 (+9.2) |
| Qwen3-Embedding-0.6B | 0.050 | 0.583 | 0.350 | 0.467 (3) | +41.7 (+33.3) | +11.7 (+5.8) |
| bge-small | 0.050 | 0.283 | 0.217 | 0.242 (2) | +19.2 (+13.3) | +2.5 (-0.8) |

By author (EmbeddingGemma 2, F / D / primary): agent 1 (n 54) 0.056 / 0.630 / 0.519; agent 2 (n 28) 0.071 / 0.643 / 0.571; agent 3 (n 38) 0.026 / 0.526 / 0.368. By pool part: `@types/node` (n 57) 0.088 / 0.649 / 0.526; TypeScript lib (n 63) 0.016 / 0.556 / 0.444. The lift holds for every author and both parts; Qwen3 and bge-small show the same pattern (`breakdown.mjs`).

## Results: I1 test half (n 68), recall@10, Metal

| Model | F | D | E | Primary R1 | R2 (not primary) |
|---|---|---|---|---|---|
| EmbeddingGemma 2 | 0.838 | 0.985 | 1.000 | 0.838 | 1.000 |
| Qwen3-Embedding-0.6B | 0.838 | 0.941 | 0.985 | 0.838 | 0.956 |
| bge-small | 0.838 | 0.956 | 0.985 | 0.838 | 0.985 |

The 11 misspelled-name queries score 0 on FTS5; every other identifier rule scores 1.0 on FTS5. R1 sends all identifier-shaped queries (including the misspelled ones) to FTS5, so it matches F exactly and loses the misspelling recoveries that dense or hybrid search provides. R2 recovers them (1.000 for EmbeddingGemma 2) with the same V2 result as R1, because no V2 query is identifier-shaped. **R1 passes its pre-registered conditions but is dominated by R2.** The I1 test numbers are not blind (amendment A2).

## Pass conditions (section 11.6), reference backend Metal

| # | Condition | EmbeddingGemma 2 | Qwen3-Embedding-0.6B | bge-small |
|---|---|---|---|---|
| 1 | Lift at least +5 pts, 5th pct above 0 | Met (+43.3) | Met (+41.7) | Met (+19.2) |
| 2 | Identifier non-inferiority (5th pct of primary minus F at least -2 pts) | Met (difference 0 by construction); V2 name-overlap stratum has only 3 test queries, so it is underpowered | Met (same caveat) | Met (same caveat) |
| 3 | Primary at least equal to E | Met (+14.2) | Met (+11.7) | Met on the point estimate (+2.5), interval spans 0 |
| 4 | Determinism, 3 repeats | Met: three Metal runs and one network-denied run, each rebuilding query vectors, gave identical top 10 on all 240 queries | Not repeated | Met for bge-small ONNX (two runs identical on 240/240) |
| 5 | Portability within 1 pt and top-10 overlap at least 0.90 (Metal vs ONNX) | Met: primary 48.3 vs 47.5, overlap 0.975 (dense) and 0.979 (primary) | q8 ONNX **not met** (dense 58.3 vs 45.0, overlap 0.56); **fp16 ONNX met** (primary 46.7 vs 47.5, overlap 0.971). The ONNX q8 export, not the backend, is the cause | **Not met**: primary 24.2 vs 26.7, overlap 0.725 |
| 6 | Added query time p95 under 50 ms warm | Met on Metal (20.5 ms); ONNX CPU 46.3 ms | Met on Metal (26.3 ms); ONNX fp16 CPU **81.8 ms (not met)** | Met (13.4 Metal, 12.2 ONNX) |
| 7 | Network-denied end-to-end run, identical top 10 | Met (macOS `sandbox-exec` denying network, offline environment flags set, document vectors rebuilt inside the sandbox; 240/240 identical) | Not run | Met for the ONNX path (240/240 identical) |
| 8 | Storage within A18 | Met: 9,558 vectors take 29.4 MB as 768 float32, 7.3 MB as 768 int8, 2.4 MB as 256 int8 (round 1: 256 int8 recall 0.875 vs 0.893 float32; 25.6 MB per 100,000 symbols) | Not measured at 1024 dims | Not measured |

## Throughput and the Mac-only extrapolation (labelled; nothing beyond this Mac was tested)

| Model, backend | Documents per second (Pool B embedding) | Documents embeddable in a 10 minute budget (linear projection) |
|---|---|---|
| EmbeddingGemma 2, Metal | 102 | about 61,000 |
| EmbeddingGemma 2, ONNX CPU q8 | 19 | about 11,600 |
| Qwen3, Metal | 88 | about 53,000 |
| Qwen3, ONNX CPU fp16 | 11 | about 6,600 |
| bge-small, Metal | 253 | about 152,000 |
| bge-small, ONNX CPU q8 | 165 | about 99,000 |

The 10 minute CPU budget therefore bounds the index size at roughly 7,000 to 12,000 documents for the larger models and about 100,000 for bge-small on this machine's CPU. A real SDK pack of 100,000 or more symbols needs the GPU path, batching or incremental embedding, and a smaller model for CPU-only machines. Other CPUs, CUDA and Windows were not tested; any figure for them would be a guess.

## Decision applied (section 11.8)

EmbeddingGemma 2 (Apache-2.0, 270M text part) meets conditions 1 to 8 on this Mac. Under the frozen rule that means: **propose the post-Phase-3 phase with EmbeddingGemma 2 as the default candidate, with the router design and weight as the registered design and the open items below as phase work.** Qwen3-Embedding-0.6B is a close second but needs the ONNX fp16 export (slow on CPU) or a GGUF build for portability. bge-small is the CPU-friendly floor but fails portability and gives a much smaller lift.

## Limitations that bound this conclusion

1. **The lexical baseline is weak here by construction.** FTS5 falls from 0.536 (round 1, 833-declaration pool) to 0.050 (round 2, 9,558 declarations, checker-enforced vocabulary gap). Real agent queries sit between those two points, so +43 points is an upper bound, not an expected gain. A stronger lexical baseline (stemming, synonyms, query expansion) was not tested.
2. **All 156 vocabulary-gap queries are AI-written by the same model family.** Shared phrasing habits could favour dense models trained on similar text. A small human-written sample would test that.
3. **R1 is not the best router.** R2 dominates it on identifier queries; the pre-registered rule was kept. A later round should register R2 (or a combined rule) before any adoption.
4. **Pool B is DOM-heavy.** 5,719 of 9,558 documents are DOM declarations, unlike the `@types/node` material, and the name-overlap stratum has 3 test queries.
5. **Not covered:** Windows, Linux, Node 24, CUDA, CPU architectures other than this Mac, the Qwen3 and EmbeddingGemma 2 ONNX paths under the network-denied sandbox, and a real SDK pack from Phase 6 (the pool is declaration files, not installed platform SDKs).
6. **The harness was changed once after the Metal runs** (the import path of the ONNX branch, amendment A5); the arms, split, tuning and metrics are unchanged.

## Recommended next steps (not started)

1. Register R2, or a router that falls back to dense when FTS5 has no exact name hit, with the weight and thresholds fixed before scoring.
2. Add a stronger lexical baseline and a small human-written query sample.
3. Repeat on a real SDK pack once Phase 6 produces one.
4. Windows and Node 24 on CI; CPU-only machines with a smaller model.
5. Draft the ADR and requirement text for the opt-in lane only after steps 1 to 3.
