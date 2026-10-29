---
spike: 002c
idea: embedding-retrieval-lane
name: runtime-mlx-helper
type: comparison
validates: "Given a spike-local Python venv with MLX, when a Node harness calls an out-of-process helper, then the same dense lane can be scored"
verdict: PARTIAL
related: [001, 002a, 002b]
tags: [mlx, apple-silicon, helper-process]
---

# Spike 002c: MLX helper process

## What This Validates
A spike-local venv (`.planning/spikes/.venv-mlx`, Python 3.15, `mlx` 0.32.4 on the Mac GPU, `mlx-embeddings`) behind `mlx_embed.py`, called from `mlx-arm.mjs` over JSON files. The venv is deleted when the spikes finish.

## Results (SDK slice, recall@10)
| Model | a2 dense | a2 hybrid | Hybrid minus FTS5 | a hybrid | Index s (833 docs, whole helper process) |
|---|---|---|---|---|---|
| mlx-community/Qwen3-Embedding-0.6B-8bit | 0.946 | 0.750 | +21.4 | 0.931 | 13.2 |
| mlx-community/embeddinggemma-2-bf16 | not run | not run | not run | not run | not run |

## Investigation Trail
- `mlx-embeddings` in this venv raises "Model type embedding_gemma2 not supported", so EmbeddingGemma 2 cannot run through it today. An MLX route for it would need another package or a model-type addition.
- The per-query time of 30 to 43 ms in the result file includes spawning the Python helper for each batch, so it is not a warm-process figure and is not comparable to the in-process arms. A long-lived helper was not built.
- Licensing: the survey recorded `mlx-embeddings` as GPL-3.0. Used here only as a user-side, out-of-process tool; it would never be bundled or linked.
- Dense and hybrid metrics equal the llama.cpp Q8_0 run, so MLX adds no ranking difference for this model, and it indexed in about the same time as Metal llama.cpp (13 s vs 10 s).

## Verdict
**PARTIAL.** Works for Qwen3-Embedding 8-bit; EmbeddingGemma 2 unsupported by the installed package; no speed advantage over llama.cpp Metal was found, so MLX is not needed as an accelerator on this evidence.
