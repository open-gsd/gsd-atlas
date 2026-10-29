---
created: 2026-10-28
title: Offline embedding retrieval spike (EMB-01 input, outside the Phase 3 gate)
area: retrieval/research
---

Owner decision (2026-10-28): run an offline spike on whether a small local embedding model (plus optional reranker) improves SDK-intent, ADR and code-symbol recall over the FTS5 baseline. It stays outside the Phase 3 gate: it adds no product code, no dependency and touches no frozen file, and it does not change the registered verdict, gates N1-N4, R_max 1.5 or owner decisions 2, 5, 7, 8. The claim stays "cited exact facts"; embeddings only propose candidates.

Plan: `docs/research/embedding-retrieval-spike-plan.md` (harness, shortlist, thresholds, backend matrix, decision rule).
Evidence: `docs/research/embedding-models-gemma-verification.md`, `docs/research/small-local-models-survey.md`.
Phase proposal: `.planning/proposals/post-phase-3-embedding-retrieval.md`.

## To do

- [ ] Owner confirms thresholds, corpus pin (gsd-core 10ac3a7 or the Angular SHA), latency budget; freeze the plan file (record its hash).
- [ ] Measure symbols per LOC on the pinned corpus; compute the A18 budget.
- [ ] Author and freeze gold queries (slices a SDK intent, b ADR, c1 identifier, c2 prose), independent of FTS5 output.
- [ ] Build the retrieval harness under `scratch/embedding-spike/`; record the FTS5 baseline.
- [ ] Run shortlist (EmbeddingGemma 2, Qwen3-Embedding-0.6B, CodeRankEmbed, bge-small, Qwen3-Reranker-0.6B) on Mac (MLX, llama.cpp Metal/ONNX), the Linux A2000 llama.cpp CUDA endpoint, and CPU.
- [ ] Write `docs/research/embedding-retrieval-spike-results.md` and apply the decision rule.

Not blocking Phase 3 closure or plan 03-39. Do not start before the owner freezes the plan.

## Update 2026-10-28 (spike run, SDK slice)

Spikes 001 to 006 ran on this Mac and are committed under `.planning/spikes/`; results in `docs/research/embedding-retrieval-spike-results.md`. Scope was narrowed to SDK intent because FTS5 was at ceiling on ADR and code slices. Provisional pass: on 56 vocabulary-gap queries FTS5 recall@10 0.536 vs hybrid 0.607 to 0.804. Remaining before any adoption decision:

- [ ] SDK identifier-query set and larger second-author gold set; weighted fusion and router arms (pre-registered).
- [ ] Linux A2000 CUDA run, CPU-only run, Windows and Node 24 via CI.
- [ ] Network-denied run after model fetch.
- [ ] Re-run on a real SDK pack from Phase 6.
