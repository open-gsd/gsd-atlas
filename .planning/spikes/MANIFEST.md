# Spike Manifest

## Ideas

### embedding-retrieval-lane
Test whether an opt-in local embedding lane (plus optional reranker) over FTS5 raises recall on SDK-intent, ADR and code-symbol queries, within the A18 size and owner latency budgets, without touching the cited-exact-facts claim. Plan: `docs/research/embedding-retrieval-spike-plan.md`.

**Requirements:**

- Corpus pin: gsd-core at `10ac3a7a947903ba50f538a907af036744d759d5` (read-only archive in the scratchpad); ADR slice from this repo's `docs/adr/`; SDK slice from installed `@types/node`.
- Budgets (owner, 2026-10-28): p95 added query latency under 50 ms warm; index time under 10 minutes on CPU.
- MLX only via a spike-local venv, `.planning/spikes/.venv-mlx`, deleted when the spikes are complete.
- Scope narrowed (owner, 2026-10-28) to the SDK-intent slice; primary set `gold-a2.json` (vocabulary-gap, 56 queries), non-inferiority check `gold-a.json`.
- No product code, dependency, schema change or frozen file touched.

## Spikes

| # | Idea | Name | Type | Validates | Verdict | Tags |
|---|------|------|------|-----------|---------|------|
| 001 | embedding-retrieval-lane | fts5-baseline-and-gold-queries | standard | FTS5 baseline recall shows headroom | VALIDATED (SDK vocabulary-gap set: FTS5 recall@10 0.536; ADR and code slices at ceiling) | fts5, baseline |
| 002a | embedding-retrieval-lane | runtime-onnx-transformersjs | comparison | ONNX via transformers.js under --ignore-scripts; dense lane vs FTS5 on SDK slice | VALIDATED (EmbeddingGemma 300M q8 hybrid +21.4 pts on a2; bge-small +7.1) | onnx, embeddinggemma |
| 002b | embedding-retrieval-lane | runtime-llamacpp | comparison | node-llama-cpp under --ignore-scripts, Metal | VALIDATED (Qwen3 Q8_0 and EmbeddingGemma 2 Q8_0 match other backends) | llama.cpp, gguf |
| 002c | embedding-retrieval-lane | runtime-mlx-helper | comparison | MLX helper process | PARTIAL (Qwen3 8-bit works; EmbeddingGemma 2 unsupported by mlx-embeddings) | mlx |
| 003 | embedding-retrieval-lane | dense-lane-lift | standard | hybrid vs FTS5 on SDK slice | VALIDATED (+7.1 to +26.8 pts on a2; all bootstrap lower bounds above 0) | lift |
| 004 | embedding-retrieval-lane | identifier-non-inferiority-and-determinism | standard | no loss on identifiers, repeatable top-10 | PARTIAL (determinism and doc-worded pass; identifier queries not tested) | determinism |
| 005 | embedding-retrieval-lane | backend-portability | standard | recall within 1 pt across backends | PARTIAL (2 of 3 identical; Qwen3 ONNX q8 differs by 5 to 7 pts) | portability |
| 006 | embedding-retrieval-lane | reranker-and-a18-size | standard | reranker precision, int8/binary size | PARTIAL (256-dim int8 fits A18; reranker 467 ms fails latency) | reranker, a18 |
