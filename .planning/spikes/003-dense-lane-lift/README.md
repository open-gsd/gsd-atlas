---
spike: 003
idea: embedding-retrieval-lane
name: dense-lane-lift
type: standard
validates: "Given FTS5 and one working runtime, when FTS5 and dense results are fused with RRF, then SDK-intent recall@10 rises by at least 5 points with the bootstrap 5th percentile above zero"
verdict: VALIDATED
related: [001, 002a, 002b, 002c]
tags: [lift, rrf, bootstrap]
---

# Spike 003: dense lane lift (SDK slice)

Computed by `../dense-lib.mjs` in every arm: reciprocal rank fusion (k 60, equal weights, top 50 each, fixed in the plan), paired bootstrap on per-query recall@10 difference (10,000 resamples, seed 42). Data: the `results/` folders of 002a, 002b and 002c. FTS5 baseline recall@10: 0.536 on a2 (56 vocabulary-gap queries), 0.897 on a (29 doc-worded).

| Model, backend | a2 dense | a2 hybrid | Lift (bootstrap 5th / 95th pct) | a hybrid |
|---|---|---|---|---|
| bge-small 33M, ONNX fp32 | 0.696 | 0.607 | +7.1 (+1.8 / +12.5) | 0.931 |
| EmbeddingGemma 300M v1, ONNX q8 | 0.929 | 0.750 | +21.4 (+12.5 / +30.4) | 0.966 |
| EmbeddingGemma 2, ONNX q8 and GGUF Q8_0 | 0.893 | 0.732 | +19.6 (+10.7 / +28.6) | 0.931 to 0.966 |
| Qwen3-Embedding-0.6B, ONNX q8 | 0.875 | 0.804 | +26.8 (+17.9 / +37.5) | 0.931 |
| Qwen3-Embedding-0.6B, GGUF Q8_0 and MLX 8-bit | 0.946 | 0.750 | +21.4 (+12.5 / +30.4) | 0.931 |

**Verdict: VALIDATED** against the plan threshold (at least +5 points, bootstrap 5th percentile above zero) for every model on the vocabulary-gap set. Observations: (1) dense-only beats the equal-weight hybrid on a2 for every model except Qwen3 ONNX, which means plain RRF dilutes a strong dense lane; a weighted fusion or query routing would be a new pre-registered experiment. (2) The lift is a best case: a2 is built to have a vocabulary gap, one author, one pool of 833 declarations. (3) On the doc-worded set a, hybrid is at or above FTS5 for every model (0.931 to 0.966 vs 0.897).
