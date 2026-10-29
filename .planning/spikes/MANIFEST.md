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
| R2 | embedding-retrieval-lane | round2-confirmation | standard | Mac-only confirmation: Pool B (9,558), V2 156 AI-written vocabulary-gap queries, I1 84 identifier queries, router primary | VALIDATED on this Mac (EmbeddingGemma 2: F 0.050 vs primary 0.483 on V2 test; identifiers unchanged; portable, deterministic, network-denied pass) with listed limitations | round2, router, pool-b |
| R3 | embedding-retrieval-lane | round3-real-sdk-pack | standard | Mac-only test on the real macOS 27 SDK (146,554 declarations, 285 AI-written vocabulary-gap queries in 4 strata, 90 identifier queries, stronger lexical baseline F2) | PARTIAL (EmbeddingGemma 2 meets effect conditions C1 to C3 and determinism, network-denied, portability checks; fails budget C7: 24 min full-pack embed on Metal, 118 ms added p95; absolute V3 recall@10 only 0.18 to 0.21; fusion is 3.4 pts worse than dense only on V3) | round3, sdk, macos27 |
| R4 | embedding-retrieval-lane | round4-router-reranker-scope-swift-prose | standard | Mac-only follow-up on the real macOS 27 SDK: dense-fallback router, new 99-query mixed-intent set M4, Qwen3 reranker over top 50, Pool-lite scoping, Swift doc comments from symbol graphs | PARTIAL (registered router misses P1/P3 by 2.9 and 1.6 pts; unselected candidate R3 equals dense only and adds 6.6 pts on identifiers; reranker +3.9 pts on V3 with p5 0.0, 620 ms per query; Pool-lite raises in-scope recall but drops identifiers 0.902 to 0.279; symbol-graph prose lifts macOS 27 Swift 0.125 to 0.214, strict condition missed at p5 0.0) | round4, router, reranker, swift-prose |
| R5 | embedding-retrieval-lane | round5-exact-name-dense-router-fresh-sets | standard | Mac-only test of the exact-name shortcut plus dense-only router (R3) on fresh sets: M5 171 mixed-intent queries (4 authors, 4 task contexts) and I5 120 identifier queries; replication on V3/I3/M4, Qwen3, int8-256, reranker | PARTIAL (R3 equals dense only on fresh sets, I3 identifier gain not replicated (Q1 not met); beats lexical on mixed 0.920 vs 0.832 and holds with Qwen3; single-token fallback R5 +7.9 pts on I5 but not recommended by the tuning rule; reranker +1.9 pooled, p5 -0.9, 610 ms; int8-256 path 61.7 ms p95 quiet) | round5, router, fresh-sets |
| R6 | embedding-retrieval-lane | round6-single-token-fallback-lexical-free-path | standard | Mac-only confirmation of the single-token trigram fallback (R5) on 240 fresh identifier queries (I6) and a lexical-free query path (name map, int8-256, trigram only for single tokens) | PARTIAL (R5 +3.3 overall, +22.5 on fragments, no loss on misspellings, but S4 fails: one qualified query lost, so fragment-only fallback; lexical-free path matches R5 on identifiers; latency not certified, host never quiet) | docs/research/embedding-retrieval-spike-results-round6.md |
| R7 | embedding-retrieval-lane | round7-full-pack-embed-throughput | standard | Mac-only throughput of the full-pack embed by runtime settings (concurrent contexts, batch size, ordering), fidelity-gated against round 3 vectors | PARTIAL (4 concurrent contexts: 211.6 docs/s vs 96 baseline, projected 693 s vs 24 min; E1 target 244 docs/s not met, full-pack run not performed; lower bound, machine shared) | docs/research/embedding-retrieval-spike-results-round7.md |
