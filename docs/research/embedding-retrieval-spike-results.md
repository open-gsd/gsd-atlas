# Embedding retrieval spike: results (SDK slice)

**Date:** 2026-10-28
**Plan:** `docs/research/embedding-retrieval-spike-plan.md` (thresholds there were proposed; the owner narrowed scope to the SDK-intent slice during the spike). Per-spike detail and raw numbers: `.planning/spikes/` (MANIFEST and READMEs 001 to 006).
**Status:** Preliminary. One machine (Apple silicon, Node 26.11.1), one pool (833 `@types/node` 24.19.2 declarations), one author for the gold queries, n 56 and 29. Nothing here is registered, and nothing in Phase 3, product code, dependencies or frozen files was touched.

## Summary

- **FTS5 is at ceiling on three of four slices.** Doc-derived queries: ADR 1.000, code identifiers 1.000, code prose 1.000 recall@10; SDK 0.897. Those slices cannot show a +5 point lift, so the spike narrowed to SDK intent.
- **On SDK queries worded without the docs' vocabulary (56 queries), FTS5 recall@10 is 0.536.** A dense lane recovers most of that: dense-only 0.875 to 0.946 and hybrid (equal-weight RRF) 0.607 to 0.804, i.e. +7.1 to +26.8 points with the bootstrap 5th percentile above zero for all four models tried.
- **It works under the project's constraints on this machine:** `npm install --ignore-scripts` for both transformers.js (ONNX Runtime) and node-llama-cpp (Metal) ran models from a local cache; query embedding 1.3 to 21 ms warm; top-10 deterministic on repeat; 256-dimension int8 vectors cost 25.6 MB per 100,000 symbols.
- **Open problems:** identifier-query non-inferiority is untested; equal-weight RRF underperforms dense-only (a fusion or routing design question); the reranker is too slow (about 467 ms per call); one backend comparison (Qwen3 ONNX q8) differs by more than 1 point; indexing speed on CPU limits corpus size; privacy (no network after fetch) was not verified with a socket-denied run; Windows, Linux, CUDA and Node 24 untested.

## Results

FTS5 baseline recall@10: 0.536 (a2, vocabulary-gap, n 56), 0.897 (a, doc-worded, n 29).

| Model (licence), backend, quantisation | a2 dense | a2 hybrid | Lift, pts (bootstrap 5th pct) | a hybrid | Query ms | Index s |
|---|---|---|---|---|---|---|
| bge-small-en-v1.5 (MIT), ONNX fp32 | 0.696 | 0.607 | +7.1 (+1.8) | 0.931 | 1.3 | 11 |
| EmbeddingGemma 300M v1 (Gemma terms), ONNX q8 | 0.929 | 0.750 | +21.4 (+12.5) | 0.966 | 5.7 | 33 |
| EmbeddingGemma 2 (Apache-2.0), ONNX q8 | 0.893 | 0.732 | +19.6 (+10.7) | 0.931 | 6.8 | 42 |
| EmbeddingGemma 2, llama.cpp Metal Q8_0 | 0.893 | 0.732 | +19.6 (+10.7) | 0.931 | 9.4 | 10 |
| Qwen3-Embedding-0.6B, ONNX q8 | 0.875 | 0.804 | +26.8 (+17.9) | 0.931 | 21.1 | 39 |
| Qwen3-Embedding-0.6B, llama.cpp Metal Q8_0 | 0.946 | 0.750 | +21.4 (+12.5) | 0.931 | 10.1 | 10 |
| Qwen3-Embedding-0.6B, MLX 8-bit | 0.946 | 0.750 | +21.4 (+12.5) | 0.931 | n/a (helper process) | 13 |

Reranker (Qwen3-Reranker-0.6B Q8_0, set a2): dense then rerank 0.964; hybrid then rerank (top 50) 0.964; about 467 ms per call.
Storage (EmbeddingGemma 2 vectors): 256-dim int8 recall@10 0.875 at 25.6 MB per 100k symbols; 768-dim float32 0.893 at 307 MB.

## Against the plan's pass conditions

| Condition | Result |
|---|---|
| Lift: +5 pts on NL-intent slices, bootstrap 5th pct above 0 | Met on a2 by every model; slice b (ADR) not tested because FTS5 is at ceiling |
| Non-inferiority on identifiers and name-overlap queries | **Not tested** for SDK; code identifier queries were at ceiling for FTS5 alone |
| Determinism (3 repeats) | Met on one repeat for every arm |
| Backend portability within 1 pt | Met for EmbeddingGemma 2 (ONNX vs GGUF) and Qwen3 (GGUF vs MLX); **not met** for Qwen3 ONNX q8 vs the others |
| Size within A18 | Met with 256-dim int8; not with 768-dim float32 |
| Latency: p95 added query under 50 ms warm | Met for embedding (1 to 21 ms); **not met** by the reranker |
| Index time under 10 min on CPU | ONNX CPU about 40 ms per document, so roughly 15,000 documents; llama.cpp Metal about 12 ms per document. Real SDK packs of 100k+ symbols exceed the CPU budget without batching or a GPU. CPU-only llama.cpp not tested |
| Privacy: no network after the explicit fetch | **Not verified** (no socket-denied run) |

## Decision rule applied

The plan's rule: pass on SDK intent with identifier queries non-inferior means "adopt for that slice behind an opt-in flag in the post-Phase-3 phase". Because the identifier check, the privacy run and cross-platform runs are open, the honest status is **provisional pass on SDK intent**. The case is strong enough to keep the post-Phase-3 proposal alive and to run a confirmation round, not strong enough to design the feature.

## Practical implications

- **Default model candidates:** EmbeddingGemma 2 (Apache-2.0, 270M text) or Qwen3-Embedding-0.6B (Apache-2.0 per the survey); bge-small (MIT, 33M) as a tiny floor with a smaller but still significant lift. Choose on the confirmation round, not on these numbers alone.
- **Backends:** llama.cpp via node-llama-cpp and ONNX via transformers.js both work with scripts blocked. Package weight differs: transformers.js `node_modules` 471 MB (onnxruntime-node 287 MB), node-llama-cpp 73 MB. MLX added nothing over llama.cpp Metal and its Python package is GPL-3.0 and lacks EmbeddingGemma 2 support.
- **Fusion:** a weighted fusion or a query router (identifier-like to FTS5, descriptive to dense) should be tested; equal-weight RRF was the pre-registered rule and lost to dense-only on a2.
- **Reranker:** an optional explicit mode at most.

## Recommended next round (not started)

1. Add an SDK identifier-query set and a larger, second-author vocabulary-gap set (at least 100 queries); re-run FTS5, dense-only, equal RRF, weighted RRF and router arms with pre-registered rules.
2. Run on the Linux A2000 node (llama.cpp CUDA) and on CPU-only to settle index-time and portability, plus Windows and Node 24 through CI.
3. Run once with the network denied after model fetch.
4. Repeat on a real, larger SDK pack when Phase 6 produces one.
