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

## 11. Confirmation round (round 2), proposed 2026-10-28

**Why:** Round 1 (`docs/research/embedding-retrieval-spike-results.md`) gave a provisional pass on SDK intent: FTS5 recall@10 0.536 against hybrid 0.607 to 0.804 on 56 vocabulary-gap queries. It left five gaps: identifier-query non-inferiority untested; fusion and routing rules not explored (equal-weight RRF lost to dense-only); one author, small n, one 833-declaration pool; no network-denied run; no CUDA, CPU-only, Windows or Node 24 evidence. Round 2 closes them with rules fixed before any test query is scored. **Status: proposed. The owner freezes this section (record its sha256 in the results file) before gold authoring starts.** Scope stays SDK-only. Same boundaries as section 2: no product code, no dependency in the root `package.json`, no frozen file.

### 11.1 Inputs the owner must supply
1. **Second author** for the vocabulary-gap set: the owner, or an independent fresh agent that has not seen `gold-a.json`, `gold-a2.json`, any result file or FTS5 output. Recommended: 50 queries from the owner and 70 or more from the independent agent, so no single author exceeds 60 percent.
2. **A2000 endpoint:** host and port of the llama.cpp server, which models and quantisations it serves, its `--pooling` setting, and whether it needs a key. The harness only sends a model name, text and the fixed prefixes; it reads vectors back.
3. **Approvals:** (a) a second, larger pool B (below); (b) use of `sandbox-exec` for the network-denied run on the Mac and `docker run --network none` on the Linux node.

### 11.2 Pools
- **Pool A:** the 833 `@types/node` 24.19.2 declarations used in round 1.
- **Pool B (scale and distractors):** Pool A plus the installed `typescript` package's `lib.*.d.ts` declarations that have a descriptive comment (extract with the same rules as `extract.mjs`; record counts and the package version). Target at least 3,000 documents; if fewer exist, report the real count and treat scale as unproven. All new sets are scored on Pool B; Pool A results are reported as a secondary column for continuity with round 1.

### 11.3 Gold sets (all authored blind, frozen by sha256 before any search is run)
- **V2, vocabulary-gap set:** at least 120 queries, targets drawn with seed 31 from Pool B, disjoint from every round 1 target. Wording rule as in round 1: task descriptions and synonyms, no identifier of the target, at most one-third of content words in the target's name, signature and comment. A script rejects violating queries before freezing (text overlap only, never search output). Split by seeded hash of the query id into **tuning (30 percent)** and **test (70 percent)**; only the test part is used for any pass or fail statement.
- **I1, identifier set:** at least 80 queries, generated mechanically from new targets (seed 32), one of each rule in rotation: exact name; qualified name (`module.member`); camel-case fragment; lower-case with separators removed; one-character misspelling; module word plus member (for example "fs readFileSync"). Same tuning and test split.
- **D, doc-worded set:** keep `gold-a.json` (29) as a regression check, reported but not part of any gate.

### 11.4 Models and backends
- **Models (fixed):** EmbeddingGemma 2 Q8_0 GGUF; Qwen3-Embedding-0.6B Q8_0 GGUF; bge-small-en-v1.5 Q8_0 GGUF (ggml-org build). Prefixes exactly as in round 1. One extra run to isolate the round 1 portability gap: Qwen3-Embedding ONNX with `fp16` instead of `q8`.
- **Backends:** (1) llama.cpp Metal via node-llama-cpp on this Mac (reference); (2) llama.cpp CPU only on this Mac (`gpu: false`); (3) ONNX Runtime CPU via transformers.js on this Mac; (4) llama.cpp CUDA on the Linux A2000 node through its `/v1/embeddings` endpoint (a new `http-arm.mjs`); (5) llama.cpp CPU in the same Docker image on the Linux node if the owner allows a CPU-only container run. Windows and Node 24 are not run locally; they go to CI as a throwaway job after the owner decides (listed under the Windows todo pattern).
- MLX is dropped from round 2 (no advantage found in round 1; GPL-3.0 package).

### 11.5 Arms and pre-registered rules
All arms rank the same candidate pool, take top 50 from each lane, and break ties by symbol id.
| Arm | Rule |
|---|---|
| F | FTS5 only (round 1 baseline, unchanged query construction) |
| D | Dense only (cosine) |
| E | Equal-weight RRF, k 60 (round 1 rule) |
| W2, W3 | Weighted RRF with dense weight 2 and 3, lexical weight 1, k 60 |
| R1 (router) | If the query is **syntactically identifier-like** (a single whitespace-free token that matches `^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$`, or exactly two tokens where the second matches that pattern and the first is a known module name in the pool), return **F**; otherwise return **W** with the weight chosen below |
| R2 (router) | If FTS5 top 1 has the query's token equal (case-insensitive) to its name or qualified name, return **F**; otherwise return **W** with the weight chosen below |
**Tuning:** the weight in W and in the routers is chosen from {1 (=E), 2, 3} using the **tuning** halves of V2 and I1 only: the weight with the highest mean of V2 recall@10 and I1 recall@10 on tuning, ties to the smaller weight. Router definitions above are fixed now and are not tuned.
**Primary arm (decided before any test scoring): R1 with the tuned weight.** All other arms are descriptive; no pass or fail statement is made about them, which controls for multiple comparisons.

### 11.6 Pass conditions (applied to the **test** halves, Pool B, reference backend, per model)
1. **Lift:** V2 test recall@10 of the primary arm exceeds F by at least 5 points and the paired-bootstrap 5th percentile of the difference is above zero (10,000 resamples, seed 42).
2. **Identifier non-inferiority:** on I1 test, the paired-bootstrap 5th percentile of (primary minus F) is at least minus 2 points, and the point estimate is not below minus 1 point. The same check on the name-overlap stratum of V2 test.
3. **Routing earns its place:** primary minus E on V2 test is at least 0 points (otherwise equal-weight RRF is simpler and wins).
4. **Determinism:** top 10 identical across 3 repeated runs on each backend.
5. **Backend portability** (same model and quantisation across backends 1 to 4): recall@10 within 1 point and mean top-10 set overlap (intersection over 10) of at least 0.90 per query pair.
6. **Latency:** p95 added query time under 50 ms warm on backends 1 and 4; embedding throughput measured on 5,000 documents per backend, from which the document count that fits in 10 minutes is reported (the 10 minute index budget applies to the CPU backends 2 and 3 and is expected to bound the corpus size, not to pass or fail the idea).
7. **Privacy:** an end-to-end run (index and all test queries) completes with identical top 10 under a network-denied environment: `sandbox-exec -p '(version 1)(allow default)(deny network*)'` on the Mac with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` and models already in the local cache; `docker run --network none` on the Linux node. Any socket attempt or download fails the run. (If `sandbox-exec` is unavailable on this macOS version, report that and use a packet-capture check on the loopback and external interfaces instead.)
8. **Size:** 256-dimension int8 storage confirmed on Pool B within A18 for the real count (bytes per vector times documents, plus table overhead measured).

### 11.7 Order of work
1. Owner freezes this section and supplies 11.1. 2. Build Pool B and its extraction; record counts. 3. Author V2 (two authors) and generate I1; run the overlap checker; freeze all sets and record sha256. 4. Run F on tuning and test; record. 5. Embed Pool B and all queries on backend 1 for each model; run arms D, E, W2, W3, R1, R2 on tuning only; choose the weight. 6. Score the test halves once, for every model, on backend 1 (no re-runs after looking). 7. Run backends 2 to 5 for the same arms and compute portability, overlap and throughput. 8. Run the network-denied pass. 9. Write `docs/research/embedding-retrieval-spike-results-round2.md` with every condition, interval and the decision.

### 11.8 Decision after round 2
- **All of 1 to 5, 7 and 8 met for at least one model:** propose the post-Phase-3 phase (proposal file) with that model as the default candidate, the router and weight as the registered design, and the open items (CPU index time bound, Windows and Node 24) as phase work.
- **1 met, 2 or 3 failed:** record the dense lane as safe only behind query routing, or as not worth the complexity; keep EMB-01 post-1.0.
- **1 failed on the larger pool and second author:** record round 1 as an artefact of one author and a small pool; keep EMB-01 post-1.0.

### 11.9 Cost and risk
About 2 to 3 working days, most of it query authoring and the Linux node run; no LLM calls in scoring, so no session spend except an independent agent for the 70 queries. Risks: the independent agent's queries may be easier or harder than the owner's (report per author); the A2000 endpoint's model or pooling may not match the Mac builds (record exact build and flags; a mismatch is a finding, not a failure of the idea); Pool B from TypeScript's `lib` declarations is a different domain from Node and may flatter or hurt dense retrieval (report per pool part).
