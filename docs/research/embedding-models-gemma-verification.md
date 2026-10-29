# EmbeddingGemma and sqlite-vec: claim verification and fit to Phase 3

Date: 2026-10-28. Status: research note, unregistered, no planning artifact created.
Scope: verifies the draft `docs/research/embedding-models-gemma.md` against primary sources, assesses it against Phase 3, and proposes a test.

## 0. Caveat about the draft

The draft file `docs/research/embedding-models-gemma.md` does not exist in this worktree (`docs/research/` did not exist; no branch, stash or commit holds it). The claims below are the ones the task brief listed. Every verdict is on the claim as briefed, not on the draft's exact wording. Where the draft's numbers are unseen (recall percentages, latency table), the verdict is UNSUPPORTED because no primary source contains them. Re-run the table against the real draft once it is committed.

## 1. Summary verdict

- Your suspicions hold. There is no E2B/E4B/4B/12B/27B EmbeddingGemma. Those are Gemma 3n / Gemma 3 generation sizes.
- There are two real EmbeddingGemma generations (see 2.1): v1 (300M, Gemma terms, Sep 2025) and v2 (released 2026-10-06, 740M total with a 270M text part, Apache 2.0 per its Hugging Face card).
- "lembed", "GGMN" and "TurboQuant" are not sqlite-vec features. `sqlite-lembed` is a separate sibling extension that reads `.gguf` models; "GGMN" and "TurboQuant" appear in no primary source I could reach. No sqlite-vec doc mentions GPU, CUDA, Metal, Neural Engine, OpenCL or SIMD.
- `vec_quantize_int8` is the wrong name (the API reference says `vec_quantize_i8`, and its section is an unwritten placeholder). `vec_quantize_binary` exists and behaves as described in 2.4.
- Fit to Phase 3: embeddings cannot fix Phase 3's current blockers (the 1.51 vs 1.5 cost ratio, attribution, adoption). They could plausibly lift three recall tasks (SDK intent lookup, ADR/decision recall, symbol find by description), but only as a candidate proposer behind the exact store.
- Recommendation (section 5): run an offline, unregistered, read-only spike that touches no frozen file and no product code, and promote it to product only through a separate early post-Phase-3 phase paired with Phase 6 (SDK). Do not put it on the Phase 3 gate path.

## 2. Claim-by-claim verification

Source dates: HF EmbeddingGemma-300m card (undated; paper 2025-09-24); HF blog 2025-09-04; EmbeddingGemma 2 coverage 2026-10 (release 2026-10-06 per secondary press); sqlite-vec release list (v0.1.9 dated 2026-03-31, v0.1.10-alpha.4 on 18 May 2026 by the list's day/month, year inferred). All fetched 2026-10-28.

### 2.1 (a) Model sizes and properties

| Claim | Verdict | Evidence |
|---|---|---|
| EmbeddingGemma has E2B/E4B/4B/12B/27B sizes | WRONG | HF card for `google/embeddinggemma-300m` lists one model; 768/512/256/128 are output dims, not model sizes. https://huggingface.co/google/embeddinggemma-300m . EmbeddingGemma 2 card: one checkpoint, "effective size" 270M text, 440M, 570M, 740M depending on encoders loaded. https://huggingface.co/google/embeddinggemma-2 |
| v1 parameters | CONFIRMED (about 300M) | Card: a 300M-parameter model; Google docs and HF blog say 308M, the blog's own table says 268M (internal inconsistency). https://ai.google.dev/gemma/docs/embeddinggemma , https://huggingface.co/blog/embeddinggemma |
| v1 output dim and MRL | CONFIRMED | 768, truncate to 512/256/128 then re-normalise. HF card above |
| v1 max context | CONFIRMED | 2048 tokens. HF card; onnx-community card repeats the 2048 limit |
| v1 licence | CONFIRMED | Gemma licence (Gemma Terms of Use); files gated behind login and agreeing to Google's terms. https://huggingface.co/google/embeddinggemma-300m |
| v1 quantised variants | CONFIRMED | Card lists QAT checkpoints Q4_0, Q8_0 and mixed precision; Transformers.js ONNX offers fp32, q8, q4 dtypes. https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX |
| v1 runtimes | CONFIRMED for Sentence Transformers, Transformers, TEI, Transformers.js, ONNX Runtime. UNSUPPORTED for llama.cpp / Ollama from primary sources | HF blog lists the former and does not mention llama.cpp or Ollama. A third-party GGUF mirror says architecture `gemma-embedding`; current llama.cpp support was not verified here. https://huggingface.co/blog/embeddinggemma |
| fp16 | CONFIRMED hazard | "activations do not support fp16"; use fp32, q8 or q4. onnx-community card |
| v2 exists, parameters, dims, context, licence | CONFIRMED (one primary card, press secondary) | 740M total (270M text + 170M vision + 300M audio), 768 dims, MRL to 128, 8,192 context, Apache 2.0 linked to Gemma 4 licence docs, ungated notice not shown. https://huggingface.co/google/embeddinggemma-2 ; the ai.google.dev page itself says it is deprecated and points to gemma.ai. Release date 2026-10-06 is from press only (https://www.eesel.ai/blog/embeddinggemma-2), not stated on the card |
| v2 runtimes | UNSUPPORTED for ONNX / llama.cpp / transformers.js | Card names Transformers, sentence-transformers, Safetensors; says nothing on ONNX, llama.cpp, transformers.js. HF card above |
| Footprint | CONFIRMED as vendor claim, not measured here | v1 "under 200 MB of RAM when quantized" (HF blog); v2 text-only about 191 MB on a Pixel 11 Pro, per press (Google figure, unverified) |
| Code retrieval | CONFIRMED prompt exists | Query prefix `task: code retrieval | query: ` is defined (HF blog). The blog gives no code-retrieval benchmark number |

Take-away: the draft must say which generation it means. v2 changes the licence story (Apache 2.0 vs Gemma Terms) and the runtime story (no stated ONNX path yet).

### 2.2 (b) lembed, GGMN, TurboQuant

| Claim | Verdict | Evidence |
|---|---|---|
| sqlite-vec has a "lembed" model loader | WRONG as stated | The sqlite-vec README lists `sqlite-lembed` under "See Also" as a separate extension that generates embeddings from `.gguf` models. https://github.com/asg017/sqlite-vec |
| "GGMN" format | UNSUPPORTED | Appears in neither the sqlite-vec README nor docs I read. The nearest real term is `.gguf` |
| "TurboQuant Q2/Q4" in sqlite-vec | UNSUPPORTED | Not in README, docs or the v0.1.x release notes. https://github.com/asg017/sqlite-vec/releases |

### 2.3 (c) Acceleration

| Claim | Verdict | Evidence |
|---|---|---|
| CUDA / Metal / Neural Engine / OpenCL in sqlite-vec | UNSUPPORTED (almost certainly WRONG) | The README describes "pure C with no dependencies" and never mentions GPU, Neural Engine or OpenCL. The docs I could reach also do not mention SIMD. I found no document saying it is CPU-brute-force only either, so "CPU SIMD brute force only" is your belief, not a verified fact. https://github.com/asg017/sqlite-vec |
| ANN index | CORRECTION | v0.1.10 alphas (from 2026-03-31) added rescore, IVF (experimental, not enabled) and DiskANN. v0.1.9 (2026-03-31) is a DELETE bug fix only. The latest is alpha, so a stable v0.1.9 has no ANN. https://github.com/asg017/sqlite-vec/releases |
| Maturity | CONFIRMED | README: pre-v1, "expect breaking changes". A15 already pins 0.1.9 |

### 2.4 (d) and (e) Numbers and function names

| Claim | Verdict | Evidence |
|---|---|---|
| Recall percentages (any) | UNSUPPORTED | No sqlite-vec doc publishes recall figures; the only published quality numbers for the model are MTEB charts on the HF blog, with no code-retrieval figure |
| Latency / storage table (1M symbols about 5 ms) | UNSUPPORTED | sqlite-vec docs give no benchmarks (its own README calls it "fast enough"); the performance page URL I tried returned 404. A brute-force scan is linear in vector count, so 5 ms at 1M x 768 would be implausible for float32 on a CPU (3 GB read per query); treat as invented until measured |
| `vec_quantize_int8` | WRONG name | API reference names `vec_quantize_i8(vector, [start], [end])`; its section is a TODO placeholder, so behaviour is undocumented. https://alexgarcia.xyz/sqlite-vec/api-reference.html |
| `vec_quantize_binary` | CONFIRMED | Input float32 or int8; positive element becomes 1, negative 0 (zero handling undocumented); packed into a bit vector; length must be divisible by 8. Same page |
| Hamming for bit vectors | CONFIRMED | `vec_distance_hamming`, bit vectors only. Same page |
| Cosine in `vec0` | CONFIRMED | `distance_metric=cosine`. https://alexgarcia.xyz/sqlite-vec/features/knn.html |
| MRL handling | CONFIRMED | Docs say slice first then normalise (`vec_slice`, `vec_normalize`). API reference |

### 2.5 (f) A18 arithmetic

The draft's arithmetic was not seen, so here is mine. A18 (`docs/DESIGN.md` line 30): embeddings quantised, one vector per symbol; DESIGN.md line 139 gives a store budget of at most 250 MB (no embeddings) for the larger tier and 50 MB for the smaller.

| Vector format | Bytes per vector | 100k symbols | 1M symbols |
|---|---|---|---|
| float32 x 768 | 3,072 | 307 MB | 3.07 GB |
| int8 x 768 | 768 | 77 MB | 768 MB |
| int8 x 256 (MRL) | 256 | 26 MB | 256 MB |
| binary x 768 | 96 | 9.6 MB | 96 MB |
| binary x 256 | 32 | 3.2 MB | 32 MB |

Any float32 plan breaks A18 outright. int8 at 768 dims by itself is 3x the 250 MB budget at 1M symbols. Only int8 at 256 dims or binary stays plausible, and recall at those formats is exactly what the spike must measure, not assume. Symbol count per LOC is not stated in the repo docs I read; measure it from a real index before quoting any "1M LOC" figure. Vector storage in `vec0` adds overhead beyond the raw bytes (not measured).

### 2.6 Running EmbeddingGemma from Node >= 24, no install scripts, no network by default

| Option | Status | Constraint impact |
|---|---|---|
| Transformers.js + ONNX (`onnx-community/embeddinggemma-300m-ONNX`, dtype fp32/q8/q4) | Documented on the model card (v1). Download size is not stated on the card (measure). | Pulls `onnxruntime-node`, a native dependency; whether it needs an install script, and its size per platform, were not verified here and must be checked against the "no install script" rule (STACK Finding 7). Runtime downloads from the Hub unless the files are placed locally. |
| llama.cpp / node-llama-cpp with a GGUF | Unverified for EmbeddingGemma from primary sources | Native prebuilt binaries; same install-script question. |
| EmbeddingGemma 2 | No stated ONNX / GGUF path on the card | Possibly Transformers-only (Python); a Node route is unproven. |
| Own pure-WASM ONNX runtime | Not evaluated | Slow; out of scope for a spike. |

Implications for the project constraints:
- No network by default: the model must be fetched by an explicit, user-initiated command with a pinned file hash, never on first query. Atlas bundles nothing, so the npm tarball stays MIT and clean.
- Licence: v1 weights are under Gemma Terms (gated, with use restrictions and flow-down obligations). Atlas would only reference them, never redistribute, but the user would have to accept terms on Hugging Face, which is hostile to a "no network, no accounts" product. v2 weights are Apache 2.0 per the card (verify the LICENSE file before relying on it), which removes most of this friction. Vet either before adopting, as PROJECT.md already requires for grammars.
- Determinism: embeddings are floating-point; different CPUs, ONNX Runtime builds and quantisation levels can reorder near-ties. See the risks table.
- Windows: native ONNX/GGUF runtimes need their own CI lanes on all three OSes (the project's platform rule).
- A15 says "only when accelerated hardware is present"; no source here shows sqlite-vec using accelerators, and the embedding model itself would be the part needing acceleration. That condition has to be defined by measured CPU latency, not assumed.

## 3. Phase 3 challenge fit

Phase 3 state (from `.planning/phases/03-typescript-module-and-mvp-eval/.continue-here.md`, `docs/eval/gate-redefinition-proposal.md` sections 5a/5b, `docs/eval/diagnosis.md`, `docs/eval/atlas-output-vs-explore-design.md`, `.planning/REQUIREMENTS.md`):

| Phase 3 challenge | Evidence | Can embeddings help? |
|---|---|---|
| Registered verdict MVP not met (tokens +17,982 billable per session; citations 72.7%) | diagnosis.md | No. Embeddings add tool surface and tokens. |
| Priced ratio 1.51 vs R_max 1.5 (N3) | pilot-results, gate proposal 5b | No; they can only raise cost. R_max is not to be reopened. |
| Adoption: atlas called in 15 of 32 (47%) pilot sessions, N4 needs 50% | gate 5b | No. This is a routing problem (diagnosis items 1-3). A new tool lowers adoption if it enlarges the definitions block (trim saves 1.1-1.9k tokens per offline confirmation). |
| Attribution: only 64% of cited lines equal a row atlas returned | gate 5a | Risk. A fuzzy candidate that the agent then cites from its own reading widens the gap. |
| Completeness gaps (p-307 13 of 40 files; aliased imports `DirectiveMeta as T2DirectiveMeta`; `code_refs createTenant` returning 0) | atlas-output-vs-explore-design.md, angular-pilot-plan.md | No. These are resolution and pagination errors on exact facts. Similarity search does not recover a missed reference with certainty, and a "probably related" file is not an exact fact. |
| Gate items 3, 4, 6 undecided; code-fact gate first, SDK gate separate | .continue-here.md | Neutral. The code-fact gate questions (callers, references, heritage, impact) are structural, which FTS5/graph already answers or misses for non-semantic reasons. |
| Determinism of measurement; corpus pinned to commit SHA | PROJECT.md constraints | Adds a nondeterministic component unless pinned (model build, runtime, quantisation). |
| Frozen fixes before the question draw (decision 7) | gate 5b | A new retrieval stage would need to be in the freeze or outside it. Putting it in the registered configuration changes the thing being measured. |

Honest conclusion: for the registered Phase 3 gate, embeddings address none of the blockers and add cost, size and variance. The draft's one-sidedness shows here: it argues that embeddings are cheap and fast but never says which Phase 3 failure they fix.

Where embeddings could plausibly lift recall (not Phase 3 gate failures, but recall lifts the owner wants), each with a metric and a test design. Existing harness: `scripts/recall.ts` (`runRecall`, `RecallItem`, `RecallReport`) measures per-construct extraction recall against hand-written truth (`<fixture>.truth.json`, written before the extractor runs, T-02-41), never pooled, with `n/a` for non-applicable constructs. It is not a retrieval harness. Keep its rules (truth written first from text, per-stratum rows, never pooled) and add a sibling script rather than editing it. A name like `scripts/retrieval-recall.ts` is a suggestion.

| Task | Where names do not match | Metric | Baseline | Pass threshold |
|---|---|---|---|---|
| 1. SDK API lookup by intent ("draw text with a shadow") | Phase 6 `sdk_lookup`; the SDK packs do not exist yet, so Phase 3 cannot test this on real packs | recall@10 and MRR of the correct symbol among candidates, on a hand-written query set whose gold answers come from the installed SDK, stratified into name-overlap vs no-name-overlap | FTS5 (trigram) alone | Hybrid recall@10 higher than FTS5 by at least 0.15 absolute on the no-overlap stratum, paired bootstrap lower bound above 0, and no stratum worse by more than 0.01 |
| 2. ADR / doc / decision recall ("why do we not use a session id?") | `docs/adr/` has 16 ADRs here; atlas today joins code comments to ADR file names only (`docs/eval/cortex-review-2026-10.md`) | recall@5 of the right ADR for 10-30 questions written by hand, with gold = ADR number and heading | FTS5 over ADR text, plus current ADR-citation lookup | Hybrid recall@5 at least 0.20 absolute above FTS5, on at least 30 questions (10 is too few to detect a difference; the cortex review's 10 unscored questions are a starting set, not a gate) |
| 3. Symbol find by description ("function that resolves tsconfig paths") | `code_find` is name-based | recall@10 of the correct definition (file:line match key as in `MatchKey`) on questions written from the pinned Angular corpus with no identifier tokens in the query | `code_find` FTS5 | Same as task 1 |

Guardrails common to all three:
- Embeddings only propose candidates. The returned fact (definition, signature, citation, since/deprecated version) is read from the exact store by key, so the cite invariant (N2/H3: line from a row atlas returned) is unchanged. A candidate that is not in the exact store is dropped, not shown.
- Count false-positive candidates (precision@k) and never let an embedding score appear as a fact.
- Report with and without the vector stage; never pool with exact-fact results.

## 4. Risks (not hedged away)

| Risk | Detail |
|---|---|
| Determinism of measurement | Float results vary across CPU/ORT builds and quantisation. Mitigate: pin model file hash, runtime version and dtype; report top-k stability over 3 repeated runs per OS; treat cross-OS rank differences as noise within a stated tolerance. Eval numbers for the cited-exact-facts claim must not depend on the vector stage. |
| Store size (A18) | See 2.5. Anything above int8 x 256 or binary blows the budget at scale, and sqlite-vec is a loadable extension, so it needs `allowExtension`/`loadExtension`, which STACK.md says is not enabled in 1.0 builds. |
| Privacy / no network | Model download needs a one-time explicit fetch with a pinned hash. Query text stays local. Any telemetry-free runtime must be confirmed (not verified here). |
| Cross-platform | Native ONNX/GGUF runtimes and a native sqlite-vec binary per OS and arch; Windows file locking and path rules apply to the model cache. Not tested. |
| Model licence | v1: Gemma Terms plus gated download. v2: Apache 2.0 per its card; verify the actual LICENSE file. |
| Corpus pinning | Query sets must be pinned to the corpus commit SHA registered for Angular (`docs/eval/corpus-candidates.*`, frozen) and authored before any retrieval is run. Do not reuse questions already seen by the registered eval, to avoid contaminating the fresh draw (decision 7). |
| Size of runtime | The model download size for ONNX variants is unmeasured; the Memtrace-side classifier discussed in `cortex-review-2026-10.md` is about 642 MB INT8 for scale reference only. |
| sqlite-vec maturity | Pre-v1, breaking changes, ANN only in alphas. |
| Freshness and incremental updates | A vector per symbol must be recomputed when content changes; embedding throughput on a 1M LOC repo is unmeasured and competes with the Governor (A61). |

## 5. Proposal

### Recommendation

Do not put embeddings on the Phase 3 gate path, and do not add them to the registered configuration. Do run a bounded, offline spike now or alongside the engineering-fix work, because it needs no product code, touches no frozen file, and answers the owner's question cheaply. If it passes, promote EMB-01 to an early, separate phase after Phase 3 closes, paired with Phase 6 (so SDK intent lookup is designed together with `sdk_lookup` and tested under EVL-06). Inside Phase 3, the spike is a supplementary note, like the pilot and offline-confirmation notes.

Reason for not folding it into Phase 3 proper: the code-fact gate is about exact structural facts; its misses are resolution bugs; its cost margin (1.51 vs 1.5) has no room; and a new tool or retrieval stage breaks decision 7's freeze unless done before it.

### Spike design (pre-registered before running)

- Plan reference: a todo or candidate plan "03-40 (supplementary, unregistered): embedding candidate-retrieval spike", attached to EMB-01. Do not create it from this note; the owner decides.
- Hypothesis H-E1: on queries with no lexical overlap with the target name, FTS5 plus vector candidates beats FTS5 alone by the thresholds in section 3, at an acceptable cost.
- Pre-registered pass/fail (all must hold):
  1. Recall lift as in section 3, per task, per stratum, never pooled.
  2. Name-overlap stratum no worse than FTS5 by more than 0.01.
  3. Determinism: top-10 identical across 3 repeated runs on one machine; across macOS, Linux and Windows the recall difference is within 0.02.
  4. Cost: embedding model fetch size and per-query p95 latency on CPU recorded; projected vector storage in the chosen format within A18 at the pinned corpus's symbol count.
  5. Privacy: zero network calls after the one explicit model fetch (verified with a socket-denied run).
- Corpus and question set: Angular at the SHA already pinned for the eval (code symbols); this repo's `docs/adr/` at the current commit (ADRs); for SDK, a public SDK symbol list pinned by version, only as a toy since packs do not exist before Phase 6. At least 30 hand-written queries per task and per stratum, gold fixed before any run, authored by someone who has not looked at the FTS5 results.
- Treatments: FTS5 only (baseline); vectors only; hybrid (rank fusion, fixed rule recorded in advance). Model arms: EmbeddingGemma v1 q8/q4 (ONNX) and v2 text-only if a Node path exists; at least one non-Gemma small model as a control so the result is not model-brand-specific.
- Must not change: frozen files (`scripts/eval/**`, `docs/eval/analysis.md`, `diagnosis.md`, `preregistration.md`, `results/**`, `results-cleanroom/**`, `key-audit.md`, `key-set-v2/**`, `probe-notes-2026-10.md`, `reevaluation-options.md`, `corpus-candidates.*`, `skills/gsd-atlas/SKILL.md`); the registered verdict; gate definitions N1-N4; R_max 1.5; decisions 2, 5, 7, 8; the pinned corpus; Phase 4's D-04 block; ADR text (amendments only, owner-approved). The spike adds no dependency to `package.json` and no schema change; it lives in a scratch directory or a clearly marked script, and its results go in `docs/research/` or `docs/eval/` as a new file.
- Cost estimate: about 1-2 working days of agent plus owner time for query authoring (most of the effort), no Max-session spend if the spike uses no LLM calls (retrieval metrics are deterministic and computed locally). If a registered session run later includes the vector stage, that run is priced separately and would be a new registration. The estimate is a judgement, not measured.
- Decision rule after the spike: pass on tasks 2 or 3 only, with SDK untested, means "adopt for ADR / symbol find behind an opt-in flag in the post-Phase-3 phase"; failure means record as negative evidence under EMB-01 and keep FTS5. Either way the claim in PROJECT.md stays "cited exact facts".

## 6. Open questions

1. Where is the draft note? It is not in the repo. Which generation of EmbeddingGemma does it mean (v1 under Gemma Terms or v2 under Apache 2.0)?
2. Does a Node >= 24 route with no install scripts exist for either generation (onnxruntime-node install behaviour, GGUF support for v2)? Not verified here.
3. What are the real ONNX download sizes per dtype, and CPU embedding throughput on the three OSes?
4. Symbols per LOC in the pinned corpus (needed for any A18 figure).
5. Does A15's "only when accelerated hardware is present" stay, or become a measured CPU-latency criterion?
6. Is `loadExtension` acceptable for an opt-in module, given STACK.md keeps it disabled in 1.0 builds?
7. Should the SDK lookup arm be pre-registered into the EVL-06 gate draft, since Phase 6 has no tools yet?
8. Who writes the query sets so they are independent of the FTS5 results?

## Sources

- https://huggingface.co/google/embeddinggemma-300m (fetched 2026-10-28)
- https://ai.google.dev/gemma/docs/embeddinggemma (fetched 2026-10-28; page says it is deprecated)
- https://huggingface.co/blog/embeddinggemma (2025-09-04)
- https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX
- https://huggingface.co/google/embeddinggemma-2 (fetched 2026-10-28)
- https://www.eesel.ai/blog/embeddinggemma-2 and other press (secondary; release 2026-10-06)
- https://github.com/asg017/sqlite-vec and /releases (v0.1.9 2026-03-31)
- https://alexgarcia.xyz/sqlite-vec/api-reference.html , /features/knn.html , /features/vec0.html
- Repo: `docs/DESIGN.md` (A15, A18, A32), `.planning/REQUIREMENTS.md`, `.planning/PROJECT.md`, `docs/eval/*` as cited above, `scripts/recall.ts`.
