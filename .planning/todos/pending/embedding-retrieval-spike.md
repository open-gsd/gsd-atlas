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

Full design, pre-registered rules and pass conditions: `docs/research/embedding-retrieval-spike-plan.md` section 11. Summary: V2 (at least 120 vocabulary-gap queries, two authors, Pool B of 3,000+ declarations), I1 (at least 80 identifier queries), arms F, D, E, W2, W3, R1, R2 with tuning/test split and a primary arm fixed in advance (router R1 plus tuned weight), 8 pass conditions, network-denied run. Mac only by owner decision (no CUDA, Linux node or CPU-only llama.cpp arms; other hardware is extrapolated and labelled).

Owner inputs needed before anything starts:
- [ ] Freeze plan section 11 (record its sha256).
- [ ] Name the second author (owner and/or an independent fresh agent that has seen no results).
- [ ] Approve Pool B (TypeScript `lib.*.d.ts` plus `@types/node`) and the network-denied tooling (`sandbox-exec`).

Work, in order:
- [ ] Build Pool B and its extraction; record counts and package versions.
- [ ] Author V2 blind, generate I1, run the overlap checker, freeze sets (sha256).
- [ ] Baseline F on tuning and test; embed on backend 1; tune weight on tuning only.
- [ ] Score test halves once; then the ONNX CPU backend for portability and throughput; Qwen3 ONNX fp16 portability check; labelled Mac-only extrapolation of index time.
- [ ] Network-denied end-to-end run on the Mac; size check on Pool B.
- [ ] Write `docs/research/embedding-retrieval-spike-results-round2.md` and apply section 11.8.
- [ ] Windows and Node 24 via a throwaway CI job (after the owner decides; see the Windows todo for the pattern).

Not blocking Phase 3 closure or plan 03-39.

## Update 2026-10-28 (round 2 run, Mac only)

Round 2 ran: results in `docs/research/embedding-retrieval-spike-results-round2.md`, frozen records and raw results in `.planning/spikes/round2/`. EmbeddingGemma 2 meets all eight conditions on this Mac (V2 test recall@10: FTS5 0.050, primary router 0.483; identifiers unchanged; deterministic; network-denied pass). Remaining before an adoption decision:

- [ ] Register router R2 (exact-name gate) or a dense-fallback rule; R1 loses the misspelled-identifier recoveries.
- [ ] Stronger lexical baseline and a small human-written query sample (all V2 queries are AI-written by one model family).
- [ ] Repeat on a real SDK pack from Phase 6; Windows and Node 24 via CI; CPU-only machines with a smaller model.
- [ ] Decide whether to draft the ADR and requirement text for the opt-in lane (see the post-Phase-3 proposal).

## Update 2026-10-29 (round 3 run, real macOS 27 SDK, Mac only)

Round 3 ran on the installed MacOSX27.0.sdk (146,554 declarations): results in `docs/research/embedding-retrieval-spike-results-round3.md`, frozen plan section 12 and records in `.planning/spikes/round3/`. EmbeddingGemma 2 meets effect conditions C1 to C3 (V3 test recall@10: lexical 0.005, dense only 0.214, primary 0.180; identifiers 0.918 vs 0.803 for the better lexical arm) and the determinism, network-denied and ONNX CPU portability checks; it fails the budget condition (24 min full-pack embed on Metal, 118 ms added query p95). Remaining before an adoption decision:

- [ ] Register a dense-only fallback router (the registered primary is 3.4 pts below dense only on V3) and re-score on the frozen sets.
- [ ] Decide pack scoping (Pool-lite is 25 percent of the pack, about 6 min on Metal) and 256-dim int8 storage (37.5 MB for the full pack).
- [ ] Prose for Swift declarations (stratum C has none) and a reranker over the top 50.
- [ ] Human-written query sample; Windows and Node 24 via CI; the product's own SDK pack after Phase 6.
- [ ] Decide whether to draft the ADR and requirement text for the opt-in lane.
