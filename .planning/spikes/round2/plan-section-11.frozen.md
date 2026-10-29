## 11. Confirmation round (round 2), proposed 2026-10-28

**Why:** Round 1 (`docs/research/embedding-retrieval-spike-results.md`) gave a provisional pass on SDK intent: FTS5 recall@10 0.536 against hybrid 0.607 to 0.804 on 56 vocabulary-gap queries. It left five gaps: identifier-query non-inferiority untested; fusion and routing rules not explored (equal-weight RRF lost to dense-only); one author, small n, one 833-declaration pool; no network-denied run; no CUDA, CPU-only, Windows or Node 24 evidence. Round 2 closes the first four on this Mac (hardware coverage stays open by owner decision, see below) with rules fixed before any test query is scored. **Status: proposed. The owner freezes this section (record its sha256 in the results file) before gold authoring starts.** Scope stays SDK-only. Same boundaries as section 2: no product code, no dependency in the root `package.json`, no frozen file.

### 11.1 Inputs the owner must supply
1. **Second author** for the vocabulary-gap set: the owner, or an independent fresh agent that has not seen `gold-a.json`, `gold-a2.json`, any result file or FTS5 output. Recommended: 50 queries from the owner and 70 or more from the independent agent, so no single author exceeds 60 percent.
2. **Approvals:** (a) a second, larger pool B (below); (b) use of `sandbox-exec` for the network-denied run on the Mac.

*Owner decision 2026-10-28: no CUDA, Linux-node or CPU-only llama.cpp arms in this round ("don't need to configure all that, use the mac and extrapolate out"). Round 2 runs on this Mac only; anything about other hardware is an extrapolation and is labelled as such.*

### 11.2 Pools
- **Pool A:** the 833 `@types/node` 24.19.2 declarations used in round 1.
- **Pool B (scale and distractors):** Pool A plus the installed `typescript` package's `lib.*.d.ts` declarations that have a descriptive comment (extract with the same rules as `extract.mjs`; record counts and the package version). Target at least 3,000 documents; if fewer exist, report the real count and treat scale as unproven. All new sets are scored on Pool B; Pool A results are reported as a secondary column for continuity with round 1.

### 11.3 Gold sets (all authored blind, frozen by sha256 before any search is run)
- **V2, vocabulary-gap set:** at least 120 queries, targets drawn with seed 31 from Pool B, disjoint from every round 1 target. Wording rule as in round 1: task descriptions and synonyms, no identifier of the target, at most one-third of content words in the target's name, signature and comment. A script rejects violating queries before freezing (text overlap only, never search output). Split by seeded hash of the query id into **tuning (30 percent)** and **test (70 percent)**; only the test part is used for any pass or fail statement.
- **I1, identifier set:** at least 80 queries, generated mechanically from new targets (seed 32), one of each rule in rotation: exact name; qualified name (`module.member`); camel-case fragment; lower-case with separators removed; one-character misspelling; module word plus member (for example "fs readFileSync"). Same tuning and test split.
- **D, doc-worded set:** keep `gold-a.json` (29) as a regression check, reported but not part of any gate.

### 11.4 Models and backends
- **Models (fixed):** EmbeddingGemma 2 Q8_0 GGUF; Qwen3-Embedding-0.6B Q8_0 GGUF; bge-small-en-v1.5 Q8_0 GGUF (ggml-org build). Prefixes exactly as in round 1. One extra run to isolate the round 1 portability gap: Qwen3-Embedding ONNX with `fp16` instead of `q8`.
- **Backends (Mac only):** (1) llama.cpp Metal via node-llama-cpp (reference); (2) ONNX Runtime CPU via transformers.js, kept only because it already works with no setup and gives the second backend that portability needs. No llama.cpp CPU, CUDA or Linux container arm. Windows and Node 24 are not run; they are listed as not covered.
- **Extrapolation (labelled, not measured):** from the measured documents per second on Metal and on ONNX CPU, report the document count that fits in the 10 minute index budget, and state it as a Mac-only figure. For the A2000 and for other CPUs, state only that they were not tested; do not quote speeds for them. Any scale claim beyond Pool B's real size is a linear projection and is marked so.
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
5. **Backend portability** (same model, Metal llama.cpp vs ONNX CPU; ONNX uses its own q8 export, so Qwen3 is also checked with the ONNX fp16 export): recall@10 within 1 point and mean top-10 set overlap (intersection over 10) of at least 0.90 per query.
6. **Latency:** p95 added query time under 50 ms warm on backend 1; embedding throughput measured on 5,000 documents (or all of Pool B if smaller) on both backends, from which the document count that fits in 10 minutes is reported as a Mac-only extrapolation (it bounds the corpus size, it does not pass or fail the idea).
7. **Privacy:** an end-to-end run (index and all test queries) completes with identical top 10 under a network-denied environment: `sandbox-exec -p '(version 1)(allow default)(deny network*)'` on the Mac with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` and models already in the local cache. Any socket attempt or download fails the run. (If `sandbox-exec` is unavailable on this macOS version, report that and use a packet-capture check on the loopback and external interfaces instead.)
8. **Size:** 256-dimension int8 storage confirmed on Pool B within A18 for the real count (bytes per vector times documents, plus table overhead measured).

### 11.7 Order of work
1. Owner freezes this section and supplies 11.1. 2. Build Pool B and its extraction; record counts. 3. Author V2 (two authors) and generate I1; run the overlap checker; freeze all sets and record sha256. 4. Run F on tuning and test; record. 5. Embed Pool B and all queries on backend 1 for each model; run arms D, E, W2, W3, R1, R2 on tuning only; choose the weight. 6. Score the test halves once, for every model, on backend 1 (no re-runs after looking). 7. Run backend 2 (ONNX CPU) for the same arms and compute portability, overlap and throughput; write the labelled extrapolation. 8. Run the network-denied pass. 9. Write `docs/research/embedding-retrieval-spike-results-round2.md` with every condition, interval and the decision.

### 11.8 Decision after round 2
- **All of 1 to 5, 7 and 8 met for at least one model:** propose the post-Phase-3 phase (proposal file) with that model as the default candidate, the router and weight as the registered design, and the open items (CPU index time bound, Windows and Node 24) as phase work.
- **1 met, 2 or 3 failed:** record the dense lane as safe only behind query routing, or as not worth the complexity; keep EMB-01 post-1.0.
- **1 failed on the larger pool and second author:** record round 1 as an artefact of one author and a small pool; keep EMB-01 post-1.0.

### 11.9 Cost and risk
About 1.5 to 2.5 working days, most of it query authoring; no LLM calls in scoring, so no session spend except an independent agent for the 70 queries. Risks: the independent agent's queries may be easier or harder than the owner's (report per author); hardware other than this Mac stays untested, so CUDA and non-Apple CPU behaviour are open questions, not findings; Pool B from TypeScript's `lib` declarations is a different domain from Node and may flatter or hurt dense retrieval (report per pool part).
