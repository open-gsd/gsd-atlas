---
spike: 006
idea: embedding-retrieval-lane
name: reranker-and-a18-size
type: standard
validates: "Given the best lane, when Qwen3-Reranker-0.6B reranks the top 20 or 50 and vectors are stored int8 or binary, then precision improves and store growth stays within the A18 budget"
verdict: PARTIAL
related: [003]
tags: [reranker, quantization, a18, latency]
---

# Spike 006: reranker and A18 sizing

## Reranker (`rerank.mjs`, Qwen3-Reranker-0.6B Q8_0 via node-llama-cpp Metal; embedder EmbeddingGemma 2 Q8_0; recall@10, set a2)
| Candidates | Top-N 20 | Top-N 50 |
|---|---|---|
| FTS5 alone, no rerank | 0.536 | 0.536 |
| FTS5 then rerank | 0.643 | 0.732 |
| Dense then rerank | 0.964 | 0.964 |
| Hybrid then rerank | 0.893 | 0.964 |
Without rerank: dense 0.893, hybrid 0.732. On set a (doc-worded): hybrid then rerank 1.000 at both N, FTS5 then rerank 0.966.
Latency: about 467 ms per rerank call on average (mix of N 20 and 50) on Metal. That is roughly ten times the 50 ms p95 budget. Rerank adds 7 to 23 points over its input lane but fails the latency budget here.

## Storage (`quant.mjs`, EmbeddingGemma 2 Q8_0 vectors, dense-only recall@10 on a2; int8 uses a fixed scale of 3x127 clipped, an ad hoc choice)
| Dim and format | Recall@10 | Bytes per vector | MB per 100,000 symbols |
|---|---|---|---|
| 768 float32 | 0.893 | 3072 | 307 |
| 768 int8 | 0.857 | 768 | 77 |
| 768 binary | 0.804 | 96 | 9.6 |
| 256 float32 | 0.893 | 1024 | 102 |
| 256 int8 | 0.875 | 256 | 25.6 |
| 256 binary | 0.625 | 32 | 3.2 |
| 128 int8 | 0.804 | 128 | 12.8 |
256 dimensions at int8 keeps 0.875 (about 2 points below float32 full size) for 25.6 MB per 100k symbols, which fits the 250 MB A18 budget; float32 at 768 dimensions (307 MB per 100k) does not.

**Verdict: PARTIAL.** Storage passes with 256-dim int8. The reranker raises precision a lot but fails the latency budget on this machine (CPU-only and CUDA timings untested), so it cannot be a default step; it fits only an optional, explicit "deep" mode.
