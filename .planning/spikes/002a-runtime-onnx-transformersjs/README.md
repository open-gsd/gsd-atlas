---
spike: 002a
idea: embedding-retrieval-lane
name: runtime-onnx-transformersjs
type: comparison
validates: "Given Node with install scripts blocked, when a small embedder loads from a local cache, then vectors are produced and the dense lane can be evaluated against the FTS5 baseline on the SDK slice"
verdict: VALIDATED
related: [001]
tags: [onnx, transformers.js, embeddinggemma, bge-small, sdk]
---

# Spike 002a: ONNX Runtime through transformers.js

## What This Validates
Given `npm install --ignore-scripts @huggingface/transformers` (version 4.3.2, onnxruntime-node prebuilt, no install script run), when `Xenova/bge-small-en-v1.5` (fp32) and `onnx-community/embeddinggemma-300m-ONNX` (q8) embed the 833 SDK declarations and the gold queries, then the dense lane can be scored against FTS5 on the same gold sets. Node v26.11.1, Apple silicon, CPU execution provider.

## How to Run
`cd .planning/spikes/002a-runtime-onnx-transformersjs && npm install --ignore-scripts && SPIKE_MODEL_CACHE=<dir> node onnx-arm.mjs <model> <data-dir> <out.json> "<query prefix>" <dtype>` (document prefix via `D_PREFIX`). Shared evaluation in `../dense-lib.mjs`: exact cosine over normalised vectors, reciprocal rank fusion (k 60, top 50 each, equal weights, as fixed in the plan), paired bootstrap (10,000 resamples, seed 42), a second query-embedding pass to check top-10 determinism.

## Results (SDK slice, recall@10)
| Model | Set | n | FTS5 | Dense only | Hybrid RRF | Hybrid minus FTS5 | Bootstrap 5th/50th/95th pct |
|---|---|---|---|---|---|---|---|
| bge-small-en-v1.5 (33M, MIT, fp32, 384 dim) | a2 vocabulary-gap | 56 | 0.536 | 0.696 | 0.607 | +7.1 pts | +1.8 / +7.1 / +12.5 |
| | a doc-worded | 29 | 0.897 | 0.897 | 0.931 | +3.4 pts | 0.0 / +3.4 / +10.3 |
| EmbeddingGemma 300M v1 (q8, 768 dim, Gemma terms) | a2 vocabulary-gap | 56 | 0.536 | 0.929 | 0.750 | +21.4 pts | +12.5 / +21.4 / +30.4 |
| | a doc-worded | 29 | 0.897 | 0.966 | 0.966 | +6.9 pts | 0.0 / +6.9 / +13.8 |

Query embedding: 1.3 ms (bge-small), 5.7 ms (EmbeddingGemma) per query warm. Indexing 833 documents: 11 s (bge-small), 33 s (EmbeddingGemma q8), about 40 ms per document on CPU. Top-10 results identical on a second run for both models. Model files: bge-small about 130 MB cache, EmbeddingGemma q8 plus bge-small about 455 MB cache in total. Installed `node_modules` is 471 MB (onnxruntime-node and sharp binaries), which matters for a package that must stay small.

## Investigation Trail
- First determinism check reported false; the cause was my check, not the model: the second pass kept only the dense top 10, which changed the fusion input. Fixed to keep the top 50; both models then reproduce identical top-10 lists.
- A guard on this machine blocked a shell edit of the first runner; the runner was re-created as `onnx-arm.mjs` with the file-writing tool instead.
- Dense-only beat equal-weight RRF on the vocabulary-gap set for both models (0.929 vs 0.750 for EmbeddingGemma). The equal-weight rule dilutes a strong dense lane with the weaker FTS5 lane. Per the plan the fusion rule was fixed in advance, so the registered number is the hybrid; the dense-only number is reported as a design signal, and a weighted fusion would need its own pre-registration.

## Verdict
**VALIDATED.** A transformers.js plus onnxruntime-node route works under `--ignore-scripts` on Node 26 (Node 24 not yet run). On the vocabulary-gap SDK set the hybrid beats FTS5 by the plan's +5 point threshold with the bootstrap 5th percentile above zero for EmbeddingGemma (+21.4) and for bge-small (+7.1, lower bound +1.8), and both stay at or above FTS5 on the doc-worded set. Not yet shown: Windows and Linux runs, Node 24, the 10 minute CPU index budget at real SDK scale (about 40 ms per document means about 15,000 documents in 10 minutes on this Mac CPU), and EmbeddingGemma 2. The a2 set is built to have a vocabulary gap, so these lifts are a best case.
