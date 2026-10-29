---
spike: 005
idea: embedding-retrieval-lane
name: backend-portability
type: standard
validates: "Given the same model on 2 or more backends, when ranked, then recall@10 differs by at most 1 point"
verdict: PARTIAL
related: [002a, 002b, 002c]
tags: [portability, backends]
---

# Spike 005: backend portability

Compared on the a2 set (n 56); only recall@10 was compared, not top-10 set overlap.

| Model | Backends compared | Dense recall@10 | Hybrid recall@10 | Within 1 point? |
|---|---|---|---|---|
| EmbeddingGemma 2 (Q8) | ONNX q8 vs llama.cpp Metal Q8_0 | 0.893 vs 0.893 | 0.732 vs 0.732 | Yes (identical) |
| Qwen3-Embedding-0.6B (8-bit) | llama.cpp Metal Q8_0 vs MLX 8-bit | 0.946 vs 0.946 | 0.750 vs 0.750 | Yes (identical) |
| Qwen3-Embedding-0.6B | ONNX q8 vs llama.cpp or MLX | 0.875 vs 0.946 | 0.804 vs 0.750 | **No**: dense -7.1, hybrid +5.4 points |

**Verdict: PARTIAL.** Two of three comparisons are identical. The Qwen3 ONNX run differs by more than the 1 point limit; the likely cause is the ONNX export's `q8` quantisation, which is a different scheme from GGUF Q8_0 and MLX 8-bit, but this was not isolated (the fp16 ONNX variant was not run). Never mix vectors across backends; the stored metadata (model, revision, quantisation, backend, pooling, prefix, dimension) must invalidate the index on any change. Not yet covered: Windows, Linux CPU, the CUDA node.
