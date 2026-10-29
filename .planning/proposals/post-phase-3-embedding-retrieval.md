# Proposal: Embedding-assisted retrieval (EMB-01 pulled forward), post-Phase-3

**Date:** 2026-10-28
**Status:** Proposal only. Not in ROADMAP.md, not a registered phase, no requirement IDs changed. The owner decides after the spike.
**Gate:** Opens only if the offline spike (`docs/research/embedding-retrieval-spike-plan.md`) passes the pre-frozen thresholds. If it fails, EMB-01 stays post-1.0 and the negative result is recorded.

## Why

Phase 3's claim is cited exact facts at bounded cost. Exact lookup (FTS5 plus the fact store) misses queries that share no words with the target: SDK APIs asked for by intent, ADRs asked for by paraphrase, symbols described in prose. A dense candidate lane could lift recall there. It cannot fix Phase 3's blockers (cost ratio 1.51 vs R_max 1.5, resolution gaps, attribution), so it stays out of the Phase 3 gate.

## Proposed placement

An early phase after Phase 3 closes, paired with Phase 6 (Platform SDK Facts) so SDK intent lookup is designed with `sdk_lookup` and tested under EVL-06 with real SDK packs. It does not need to block Phases 4 or 5.

Working title: **Phase 3.5 / 6a: Opt-in Local Retrieval Lane** (numbering is the owner's call; ROADMAP.md is not edited here).

**Goal:** An agent that asks for an API, decision or symbol by intent gets the right cited fact in the top results, with a local model the user opted into, and nothing leaves the machine.

**Depends on:** Phase 3 closed; spike passed; Phase 6 packs for the SDK arm.

**Requirements:** EMB-01 (promoted from v2), plus new IDs to be written if adopted (candidates: EMB-02 backend metadata and staleness, EMB-03 opt-in endpoint config, EMB-04 retrieval eval slices).

## Scope if adopted

1. **Opt-in only.** Off by default; enabled per repo or user config; model fetch is a separate explicit user action with size shown; no network at query time.
2. **Candidate lane, not fact source.** Dense results feed the same cited-fact path; every returned fact carries its existing citation. Fusion rule fixed (RRF) and recorded.
3. **Backends behind one interface:** portable baseline (ONNX or llama.cpp), optional MLX helper on macOS (out of process; `mlx-embeddings` is GPL-3.0 so never bundled), optional user-configured OpenAI-compatible `/v1/embeddings` endpoint (loopback or LAN allowlist, user-level config only).
4. **Vector store:** per-symbol, content-hash keyed, with model, revision, quantization, backend, pooling, prefix and dimension in metadata; mismatch means stale and re-embed. Storage within A18 (int8 at 256 dims or binary). `sqlite-vec` only if the spike shows a JS BLOB scan is too slow at real symbol counts; `loadExtension` stays off in default builds (needs an ADR amendment otherwise).
5. **Eval:** slices a, b, c1, c2 from the spike become a registered retrieval eval with per-slice reporting, paired bootstrap and non-inferiority on identifier queries.
6. **Docs/ADR:** a new ADR for the opt-in gate, config schema and fallback; dated amendments to A15 only with owner approval.

## Out of scope

Jev (hosted, not local, not an embedder), JEPA, ColBERT-style multi-vector, generative query rewriting, default-on embeddings, Jina models (CC BY-NC per the survey), any change to the "cited exact facts" claim.

## Success criteria (draft, inherit from the spike)

1. Recall@10 lift of at least +5 points on NL-intent slices with the bootstrap lower bound above zero.
2. No loss of 1 point or more on identifier-like queries.
3. Backend portability within 1 point recall@10; deterministic top-10 on one backend.
4. Store growth within A18; latency within the owner's budget; zero network calls after the explicit fetch.
5. Works on macOS, Linux and Windows with the portable baseline (Windows follows the existing post-alpha CI plan).

## Risks

Model licence drift (EmbeddingGemma 2 licence known only from its model card); EmbeddingGemma 2 runtime path from Node 24 with install scripts blocked is unverified; embedding throughput competes with the Governor (A61); sqlite-vec is pre-v1 with ANN only in alphas; query-set authoring cost and independence; SDK results provisional until Phase 6.

## Decision requested later

After the spike results: (1) adopt as an early phase, (2) fold into Phase 6 as a plan, or (3) record negative evidence and keep EMB-01 post-1.0.
