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

## Update 2026-10-28 (round 1 run, SDK slice)

Spikes 001 to 006 ran on this Mac and are committed under `.planning/spikes/`; results in `docs/research/embedding-retrieval-spike-results.md`. Scope was narrowed to SDK intent because FTS5 was at ceiling on ADR and code slices. Provisional pass: on 56 vocabulary-gap queries FTS5 recall@10 0.536 vs hybrid 0.607 to 0.804.

## Round 2: confirmation round (planned 2026-10-28, not started)

Full design, pre-registered rules and pass conditions: `docs/research/embedding-retrieval-spike-plan.md` section 11. Summary: V2 (at least 120 vocabulary-gap queries, two authors, Pool B of 3,000+ declarations), I1 (at least 80 identifier queries), arms F, D, E, W2, W3, R1, R2 with tuning/test split and a primary arm fixed in advance (router R1 plus tuned weight), 8 pass conditions, network-denied run, A2000 CUDA and CPU-only arms.

Owner inputs needed before anything starts:
- [ ] Freeze plan section 11 (record its sha256).
- [ ] Name the second author (owner and/or an independent fresh agent that has seen no results).
- [ ] A2000 endpoint details: host, port, models and quantisations served, `--pooling`, key.
- [ ] Approve Pool B (TypeScript `lib.*.d.ts` plus `@types/node`) and the network-denied tooling (`sandbox-exec`, `docker run --network none`).

Work, in order:
- [ ] Build Pool B and its extraction; record counts and package versions.
- [ ] Author V2 blind, generate I1, run the overlap checker, freeze sets (sha256).
- [ ] Baseline F on tuning and test; embed on backend 1; tune weight on tuning only.
- [ ] Score test halves once; then backends 2 to 5 (Metal, llama.cpp CPU, ONNX CPU, A2000 CUDA, optional Linux CPU container); Qwen3 ONNX fp16 portability check.
- [ ] Network-denied end-to-end run; size check on Pool B.
- [ ] Write `docs/research/embedding-retrieval-spike-results-round2.md` and apply section 11.8.
- [ ] Windows and Node 24 via a throwaway CI job (after the owner decides; see the Windows todo for the pattern).

Not blocking Phase 3 closure or plan 03-39.
