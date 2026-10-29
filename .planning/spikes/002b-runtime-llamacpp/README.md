---
spike: 002b
idea: embedding-retrieval-lane
name: runtime-llamacpp
type: comparison
validates: "Given node-llama-cpp installed with --ignore-scripts, when GGUF embedders run, then the dense lane works on Metal and matches the other backends"
verdict: VALIDATED
related: [001, 002a, 002c]
tags: [llama.cpp, node-llama-cpp, gguf, metal]
---

# Spike 002b: llama.cpp through node-llama-cpp (Metal)

## What This Validates
`npm install --ignore-scripts node-llama-cpp` (3.22.2) pulls a prebuilt `@node-llama-cpp/mac-arm64-metal` package (18 MB; 73 MB `node_modules` in total). With no install script run, `getLlama()` selected Metal and ran GGUF models from a local cache.

## How to Run
`cd 002b-runtime-llamacpp && npm install --ignore-scripts && D_PREFIX=... node llama-arm.mjs <model.gguf> <data-dir> <out.json> "<query prefix>"`.

## Results (SDK slice, recall@10)
| Model (GGUF) | a2 dense | a2 hybrid | Hybrid minus FTS5 (bootstrap 5th pct) | a hybrid | Query ms | Index s (833 docs) |
|---|---|---|---|---|---|---|
| Qwen3-Embedding-0.6B Q8_0 (1024 dim) | 0.946 | 0.750 | +21.4 (+12.5) | 0.931 | 10.1 | 9.7 |
| EmbeddingGemma 2 Q8_0 (768 dim, Apache-2.0) | 0.893 | 0.732 | +19.6 (+10.7) | 0.931 | 9.4 | 10.0 |

FTS5 baseline: 0.536 (a2), 0.897 (a). Top-10 identical on repeat for both models.

## Investigation Trail
- Same model and quantisation gives the same metrics on different runtimes: EmbeddingGemma 2 Q8 is identical to the ONNX q8 run in 002a (dense 0.893, hybrid 0.732), and Qwen3 Q8_0 is identical to the MLX 8-bit run in 002c (dense 0.946, hybrid 0.750).
- Load-time warnings from llama.cpp about control tokens were printed for both models and did not change results.
- The Linux/A2000 CUDA arm (arm C) was not run: no endpoint was provided, and there is no `llama-server` on this Mac. The same GGUF files and harness apply when it is available.

## Verdict
**VALIDATED** on Apple silicon Metal under `--ignore-scripts`. Untested: CUDA node, Windows, Linux, CPU-only llama.cpp, Node 24.
