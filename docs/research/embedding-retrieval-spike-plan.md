# Embedding retrieval spike: offline plan (outside the Phase 3 gate)

**Date:** 2026-10-28
**Status:** Proposed. Nothing here is registered or frozen. The owner sets the numbers in section 6 and freezes this file before any model runs.
**Attaches to:** EMB-01 (v2, post-1.0), A15, A18. Feeds the proposal in `.planning/proposals/post-phase-3-embedding-retrieval.md` and the todo `.planning/todos/pending/embedding-retrieval-spike.md`.
**Evidence base:** `docs/research/embedding-models-gemma-verification.md` and `docs/research/small-local-models-survey.md` (both 2026-10-28). Their figures are cited from model cards and are unmeasured here.

## 1. Question and hypothesis

Does a dense lane (optionally followed by a reranker) over the existing FTS5 lane raise recall on queries that do not share words with the target, without hurting exact-identifier queries, within the A18 size budget and an owner-set latency budget?

**H-E1.** On natural-language-intent queries (SDK API lookup and ADR/decision recall), FTS5 plus dense candidates beats FTS5 alone by the threshold in section 6.
**H-E2 (non-inferiority).** On identifier-like code queries, the hybrid is not worse than FTS5 alone by 1 point or more.

Embeddings only propose candidates. Every fact returned still comes from the exact, cited store, so the claim in PROJECT.md stays "cited exact facts".

## 2. Hard boundaries

The spike must not touch: `scripts/eval/**`, `docs/eval/analysis.md`, `diagnosis.md`, `preregistration.md`, `results/**`, `results-cleanroom/**`, `key-audit.md`, `key-set-v2/**`, `probe-notes-2026-10.md`, `reevaluation-options.md`, `corpus-candidates.*`, `skills/gsd-atlas/SKILL.md`. It must not change the registered verdict, gates N1-N4, R_max 1.5, owner decisions 2, 5, 7, 8, the pinned corpus, or Phase 4's D-04 block. No dependency is added to `package.json`, no schema change, no product code. Scratch code lives under `scratch/embedding-spike/` (git-ignored or clearly marked) and results are new files under `docs/research/`.

`scripts/recall.ts` measures extraction recall, not search recall, so it is not reused. The spike builds its own retrieval harness (section 4).

## 3. Shortlist (priors to be tested, not conclusions)

| Role | Model | Why it is on the list | Licence (per survey) |
|---|---|---|---|
| Default candidate | EmbeddingGemma 2 | Apache-2.0, published MTEB Code v1 78.68, ONNX/GGUF/MLX builds | Apache-2.0 |
| Control, non-Gemma | Qwen3-Embedding-0.6B | Official GGUF, mainstream, instruction-aware | Apache-2.0 |
| Code specialist | CodeRankEmbed (137M) | Code retrieval focus; only if a build exists without `trust_remote_code` | MIT |
| Tiny fallback | bge-small-en-v1.5 (33M) | Smallest viable floor, ONNX | MIT |
| Rerank arm | Qwen3-Reranker-0.6B | Precision step over FTS5/dense candidates, GGUF Q8_0 | Apache-2.0 |
| Optional, v1 | EmbeddingGemma 300M (QAT Q4/Q8) | Only if v2 has no workable runtime path | Gemma Terms |

Excluded: Jina models (CC BY-NC per the survey, to be reconfirmed per variant), Jev (hosted API, not a local model or an embedder), JEPA (not a retrieval model), ColBERT-style multi-vector and generative query rewriting (out of scope for this spike). `mlx-embeddings` is GPL-3.0: use MLX only as an out-of-process, user-installed helper, never bundled or linked.

## 4. Harness design

1. **Index builder:** for each query slice, a script builds (a) an FTS5 table with trigram tokenizer over the same fields the product indexes (name, qualified name, doc comment, signature), (b) a vector table per model and backend. Vectors are stored as plain BLOBs scanned in JS (exact cosine) by default, so the spike does not depend on `sqlite-vec` or `loadExtension`. A second pass re-runs the best arm on `sqlite-vec` int8/binary only to measure A18 size.
2. **Metadata per vector set:** model id and revision, quantization, backend and version, pooling, normalisation, query/document prefix, truncation dim. Mismatch means the set is never mixed.
3. **Deterministic ranking:** sort by score descending, then by symbol id, so ties do not vary between runs.
4. **Fusion rule (fixed in advance):** reciprocal rank fusion, k=60, equal weights, top-50 from each lane. No tuning on the evaluation queries.
5. **Rerank arm:** Qwen3-Reranker-0.6B over the top N from the best lane, N in {20, 50}.
6. **Prefixes:** the same query and document prefixes are applied on every backend, otherwise the cross-backend comparison is invalid.
7. **Offline guard:** after the one explicit model fetch, runs are executed with the network denied (sandbox or firewall rule) and any socket attempt fails the run.

## 5. Query slices and gold labels

| Slice | Content | Corpus | Min queries |
|---|---|---|---|
| a | SDK API lookup by natural-language intent | A public SDK symbol list pinned by version (toy set, since SDK packs do not exist before Phase 6) | 50 |
| b | ADR/decision recall by paraphrase | `docs/adr/` at the current commit | 50 |
| c1 | Code symbol find, identifier-like queries | Pinned code corpus | 50 |
| c2 | Code symbol find, prose description | Pinned code corpus | 50 |

Rules: gold answers are written by hand before any model or FTS5 result is seen; the author has not looked at FTS5 output for those queries; each slice is reported alone, never pooled; each slice is stratified into name-overlap and no-name-overlap queries. The 50-query floor mirrors the locked `eval.minQuestions`. Corpus pin: the survey cites `gsd-core` at `10ac3a7a947903ba50f538a907af036744d759d5` and the verification note cites the Angular SHA already pinned for the eval; the owner confirms which one (open question O1). Query authoring is the main cost and must stay independent of the FTS5 results (O2).

## 6. Metrics and thresholds (proposed numbers, owner to confirm before freeze)

Metrics per slice and stratum: recall@5, recall@10, MRR. Plus p50/p95 added query latency, index time, store bytes per symbol.

A candidate passes only if all hold:

1. **Lift (H-E1):** on slices a and b, hybrid recall@10 exceeds FTS5-only by at least +5 points absolute, and the 5th percentile of a paired bootstrap difference (10,000 resamples, query-level) is above zero.
2. **Non-inferiority (H-E2):** on c1 and on the name-overlap stratum of every slice, hybrid recall@10 is not worse than FTS5-only by 1 point or more.
3. **Determinism:** top-10 lists are identical across 3 repeated runs on one machine and backend.
4. **Backend portability:** for each model, recall@10 differs by no more than 1 absolute point between its backend arms. Rankings are compared (recall@k and top-10 set overlap), never raw vectors.
5. **Size:** one vector per symbol at the chosen dimension and quantization stays within A18 at the pinned corpus's symbol count. Symbols per LOC for the corpus must be measured first (open question O4).
6. **Latency:** p95 added query latency within an owner-set budget (no number exists in the repo; O3). CPU-only arm is recorded even if it misses.
7. **Privacy:** zero network calls after the explicit model fetch.

Reranker comparison: run the reranker on the smallest embedder against the largest shortlisted embedder alone. If reranker plus small embedder matches or beats the larger embedder at lower store cost, prefer it; if candidate recall@50 is the limit, the embedder wins.

## 7. Backend matrix

| Arm | Hardware | Backend | Role |
|---|---|---|---|
| A | This Mac, Apple silicon | MLX, user-installed out-of-process helper | Optional accelerator; models with a verified MLX build only |
| B | This Mac | llama.cpp Metal or ONNX Runtime (transformers.js) | Portable baseline and the reference ranking |
| C | Linux Docker node, NVIDIA RTX A2000 12 GB | llama.cpp CUDA, `llama-server --embedding`, GGUF | Optional remote endpoint; 12 GB fits every shortlist model |
| D | Any, CPU only | ONNX or llama.cpp CPU | Fallback floor |

Arm C is reached as a user-configured OpenAI-compatible `/v1/embeddings` endpoint on a loopback or LAN address. In the spike this is a harness setting only. If it later becomes a product feature it must be opt-in, set only in user-level config (`~/.config/gsd-atlas/`), with an address allowlist, consistent with the privacy constraint. The spike does not assume access to the Linux node; arm C runs when the owner provides the endpoint.

## 8. Order of work and cost

1. Owner confirms thresholds, corpus pin and latency budget, then freezes this file (hash recorded in the results file).
2. Measure symbols per LOC and compute the A18 budget (O4).
3. Author and freeze gold queries for slices a, b, c1, c2.
4. Build harness and the FTS5 baseline; record baseline numbers.
5. Run arms B then A then C then D for each shortlisted model.
6. Write `docs/research/embedding-retrieval-spike-results.md` with every slice, stratum, bootstrap interval and the decision.

Estimate: about 1-2 working days of agent plus owner time, most of it query authoring; no Max-session spend because retrieval metrics need no LLM calls. This is a judgement, not a measurement.

## 9. Decision rule

- Pass on slices a or b with c1 non-inferior: propose adopting a dense lane for SDK intent and ADR recall behind an opt-in flag in the post-Phase-3 phase (proposal file). SDK results stay provisional until Phase 6 supplies real packs.
- Pass only on c2: record as a candidate for symbol find, same flag.
- Fail: record negative evidence under EMB-01 and keep FTS5.
- In every outcome the claim in PROJECT.md stays "cited exact facts", the Phase 3 verdict is untouched, and nothing ships in 1.0 unless the owner changes A15.

## 10. Open questions

- **O1:** Which corpus pin: `gsd-core` at 10ac3a7 or the Angular SHA?
- **O2:** Who writes the queries so they are independent of the FTS5 results?
- **O3:** What p95 latency budget and what index-time budget?
- **O4:** Symbols per LOC in the pinned corpus (needed for any A18 figure).
- **O5:** Which runtime path for EmbeddingGemma 2 in Node 24 with install scripts blocked: `onnxruntime-node` postinstall behaviour, transformers.js Hub fetch (can it be hard-disabled?), `node-llama-cpp` postinstall and network behaviour. Unverified in the survey.
- **O6:** EmbeddingGemma 2 weight size for an embedding-only deployment: the card says 740M total with a 270M text part; the GGUF card says about 0.3B and 310 MB at Q8_0.
- **O7:** Is `loadExtension` acceptable for an opt-in module, given the stack keeps it disabled in 1.0 builds? The spike avoids it by default.
- **O8:** Should the SDK arm be pre-registered into the EVL-06 gate draft, given Phase 6 has no tools yet?
