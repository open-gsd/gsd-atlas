# Small local models for gsd-atlas: embedders, rerankers, sparse and late-interaction options, and runtimes

Date: 2026-10-28. Status: research note, not a decision. Nothing here changes A15 (vectors are post-1.0, opt-in) or EMB-01.

Method: model cards, registry metadata and official docs fetched on 2026-10-28. Every number below is copied from a cited page. Where a page did not state a fact, the cell says UNVERIFIED or "not stated". No benchmark number was invented, and no benchmark was run for this note. Scores from different model cards are not comparable unless the card names the same benchmark version.

## Summary and recommendation

1. **Do not build anything until a retrieval eval exists.** `scripts/recall.ts` measures per-construct extraction recall against hand-written truth files (its header says so). It does not measure natural-language retrieval. A new retrieval harness is the first deliverable (see Test design). The existing pieces to reuse are the pinned corpus (`gsd-core` @ `10ac3a7`, `fetchCorpus`), the truth-written-before-run rule (T-02-41) and the paired-bootstrap style of `docs/eval/preregistration.md`.
2. **Licence screens out most of the Jina line.** Every Jina model fetched here (v5-text-nano, v5-text-small, code-embeddings-0.5b, reranker-v3, reranker-v3.5) is CC BY-NC 4.0. That is not MIT-compatible for bundling or redistribution and not safe as a default. Jina v3 and v4 cards could not be read (fetch failed or not attempted): UNVERIFIED.
3. **The Gemma premise needs re-checking.** The Hub now has `google/embeddinggemma-2`, licensed Apache-2.0, not the Gemma terms that cover `embeddinggemma-300m`. If the Gemma note in `docs/research/embedding-models-gemma.md` assumes the Gemma terms or the 300M model only, it is out of date. I did not read that note, which another agent is verifying.
4. **Short-list to test (4 arms):** EmbeddingGemma 2 (default candidate), Qwen3-Embedding-0.6B (with Qwen3-Reranker-0.6B as a rerank arm), bge-small-en-v1.5 (tiny fallback), CodeRankEmbed (code-symbol specialist). EmbeddingGemma-300M is a control only if the owner wants to measure Gemma 1 vs 2.
5. **Opinionated prior, to be overturned by the eval:** best default = EmbeddingGemma 2 (Apache-2.0, 8K context, published MTEB Code v1 78.68, ONNX/GGUF/MLX builds exist, 310 MB at Q8_0). Best tiny fallback = bge-small-en-v1.5 (MIT, 33.4M params, 384 dims, ONNX). A reranker is more likely than a bigger embedder to improve precision over FTS5 candidates, but it cannot fix recall when FTS5 never retrieves the right row; so the order is embedder for candidate recall, reranker only if precision@k is still short. This is a hypothesis, not a finding.
6. **JEPA and Jev are not retrieval models.** See item 4. Neither helps recall.
7. **Runtime:** portable baseline = ONNX (transformers.js) or llama.cpp; llama.cpp via `llama-server` also covers the Linux/CUDA node and Mac Metal. MLX is a macOS-only optional accelerator and the only MLX embedding library found is GPL-3.0, so it should be an external tool the user installs, never a dependency. I found no embedding-specific MLX-vs-llama.cpp benchmark, so there is no evidence that MLX is worth a backend for small embedders.
8. **sqlite-vec is optional even when embeddings ship.** One vector per symbol (DESIGN.md size rules) is small enough that BLOB plus a JS dot product may suffice. sqlite-vec is pre-v1 (latest stable 0.1.9; newest 0.1.10-alpha.4, 2026-05-18).

## Comparison table

Unless stated, "context" is the tokens the card states. "Score" columns repeat only what the card prints.

| Model | Params | Dims / MRL | Context | Published scores (card) | Licence | Formats seen | Source |
|---|---|---|---|---|---|---|---|
| EmbeddingGemma 2 (`google/embeddinggemma-2`) | 740M total incl. vision/audio encoders; card says 270M text model; GGUF repo says 0.3B | 768; MRL 512/256/128 | 8,192 | MTEB multi v2 61.36; Eng v2 68.46; Code v1 78.68 | Apache-2.0 | GGUF Q8_0 310 MB, BF16 558 MB (ggml-org); ONNX (onnx-community); MLX (mlx-community) | https://huggingface.co/google/embeddinggemma-2 , https://huggingface.co/ggml-org/embeddinggemma-2-GGUF |
| EmbeddingGemma 300M | ~0.3B | 768; MRL 512/256/128 | 2,048 | Multi v2 61.15; Eng v2 69.67; Code v1 68.76 (Q4_0 QAT 67.99, Q8_0 68.70) | Gemma terms plus Prohibited Use Policy; login to accept | GGUF, ONNX, MLX exist; formats not on card | https://huggingface.co/google/embeddinggemma-300m |
| Qwen3-Embedding-0.6B | 0.6B | up to 1024; user-defined 32-1024; MRL yes | 32K | MTEB multi 64.33; Eng v2 70.70; C-MTEB 66.33; MTEB-Code not on card | Apache-2.0 | Official GGUF repo; ONNX (onnx-community, Qdrant); MLX 4bit-DWQ/8bit/mxfp8 | https://huggingface.co/Qwen/Qwen3-Embedding-0.6B , https://huggingface.co/api/models?author=Qwen&search=Qwen3-Embedding |
| CodeRankEmbed | 137M | dims not on card (UNVERIFIED) | 8,192 | CoIR NDCG@10 60.1; CodeSearchNet MRR 77.9 | MIT | needs `trust_remote_code` (nomic_bert); ONNX not stated | https://huggingface.co/nomic-ai/CodeRankEmbed |
| nomic-embed-code | 7B | not stated | not stated | CodeSearchNet per language (Python 81.7, Go 93.8, ...); CoIR not reported | Apache-2.0 | not stated | https://huggingface.co/nomic-ai/nomic-embed-code |
| nomic-embed-text-v2-moe | 475M total, 305M active | 768, truncatable to 256; MRL | 512 | BEIR 52.86; MIRACL 65.80 | Apache-2.0 | not named on card | https://huggingface.co/nomic-ai/nomic-embed-text-v2-moe |
| bge-small-en-v1.5 | 33.4M | 384 | 512 | MTEB avg 62.17; retrieval 51.68 | MIT | ONNX on card | https://huggingface.co/BAAI/bge-small-en-v1.5 |
| bge-m3 | not stated | 1024 | 8,192 | not on fetched view | MIT | dense + sparse + ColBERT multi-vector; ONNX tag | https://huggingface.co/BAAI/bge-m3 |
| all-MiniLM-L6-v2 | 22.7M | 384 | 256 word pieces (truncates) | none on fetched view | Apache-2.0 | ONNX, OpenVINO | https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 |
| snowflake-arctic-embed-m-v2.0 | not stated | not stated | not stated | tagged mteb, no scores on fetched view | Apache-2.0 | ONNX / Transformers.js tag; `trust_remote_code` in example | https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0 |
| jina-embeddings-v5-text-nano | 239M | 768; MRL 32-768 | 8,192 (page also says 32K) | MTEB Eng v2 71.0; MMTEB 65.5 | CC BY-NC 4.0 | GGUF, ONNX | https://huggingface.co/jinaai/jina-embeddings-v5-text-nano |
| jina-embeddings-v5-text-small | 677M | 1024; MRL 32-1024 | 32,768 | MTEB Eng v2 71.7; MMTEB 67.7 | CC BY-NC 4.0 | ONNX | https://huggingface.co/jinaai/jina-embeddings-v5-text-small |
| jina-code-embeddings-0.5b | 0.5B | 896; MRL 64-896 | 32,768 | not on card (points to arXiv 2508.21290) | CC BY-NC 4.0 | GGUF 316 MB (IQ1_S) to 994 MB (F16) | https://huggingface.co/jinaai/jina-code-embeddings-0.5b , https://huggingface.co/jinaai/jina-code-embeddings-0.5b-GGUF |
| jina-embeddings-v3 / v4 | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED (v3 fetch failed; v4 not fetched) | | |

Rerankers and late interaction:

| Model | Params | Context | Published scores | Licence | Formats | Source |
|---|---|---|---|---|---|---|
| Qwen3-Reranker-0.6B | 0.6B | 32K | reranking top-100 from Qwen3-Embedding-0.6B: MTEB-R 65.80; MTEB-Code 73.42 | Apache-2.0 | GGUF (ggml-org Q8_0, 113K downloads) | https://huggingface.co/Qwen/Qwen3-Reranker-0.6B |
| bge-reranker-v2-m3 | 0.6B | card uses max_length 512 | charts only, no numbers | Apache-2.0 | ONNX not mentioned | https://huggingface.co/BAAI/bge-reranker-v2-m3 |
| jina-reranker-v3 | 0.6B | 131K | BEIR 61.94; CoIR 70.64 | CC BY-NC 4.0 | GGUF, MLX | https://huggingface.co/jinaai/jina-reranker-v3 |
| jina-reranker-v3.5 | 0.6B | 131K | BEIR 63.20 (v3: 62.10) | CC BY-NC 4.0 | GGUF, MLX | https://huggingface.co/jinaai/jina-reranker-v3.5 |
| answerai-colbert-small-v1 | 33.4M | not stated | BEIR avg 53.79 (bge-small-en 51.68) | Apache-2.0 | ONNX tag; dim 96 inferred from example output | https://huggingface.co/answerdotai/answerai-colbert-small-v1 |

## 1. Embedding models

**EmbeddingGemma.** Two generations exist. Gen 1 (300M) is text-only, 2K context, Gemma-terms licence, and its card reports MTEB Code v1 68.76 at 768 dims, dropping to 62.96 at 128 dims, so MRL truncation to 128 costs about 6 points on code (card table). QAT Q4_0 and Q8_0 checkpoints are evaluated after quantization at 67.99 and 68.70. Gen 2 reports Code v1 78.68 and says code is "about 14% higher" than gen 1, adds image/video/audio encoders, and is Apache-2.0 (card). Both are scores the vendor published; I did not reproduce them. The "Code v1" benchmark is a mix of retrieval tasks, not a symbol-lookup test.

**Qwen3-Embedding-0.6B.** Apache-2.0, 32K context, user-defined dimensions 32-1024, instruction-aware: the authors say a task instruction typically improves results by 1-5% and is for queries only (card). The card prints no MTEB-Code number; the Qwen3 Reranker card does print MTEB-Code 73.42 for the rerank step over its top-100. Best GGUF and ONNX ecosystem of the candidates by download count (8.27M downloads for the base repo, 155K for the official GGUF; HF API listing).

**Code-specific.** CodeRankEmbed is the only small, MIT, code-tuned embedder found: 137M params, CoIR 60.1, needs a fixed query prefix ("Represent this query for searching relevant code") and `trust_remote_code`. That last point matters: transformers.js and ONNX export paths cannot execute arbitrary Python, so an ONNX build must exist separately; none is stated on the card (UNVERIFIED). nomic-embed-code is 7B, out of scope for "small". jina-code-embeddings-0.5b is CC BY-NC.

**Others.** bge-small-en-v1.5 (MIT, 33.4M, 384 dims) is the plain tiny baseline; its card says the query instruction is optional in v1.5. all-MiniLM-L6-v2 truncates at 256 word pieces, which is a poor fit for long doc comments and ADR text, and is trained on general web pairs, not code (card). nomic-embed-text-v2-moe has a 512-token limit. I did not find, and do not claim, any other mainstream sub-1B code embedder released in 2026: a general search turned up only blog roundups of varying age and one unverified arXiv paper (https://arxiv.org/pdf/2607.27506) about a 335M "B1ade" embedder that I did not read.

**Unfetched or unresolved:** Jina v3/v4, SFR/E5/GTE families, Granite Embedding R2 (a search hit, https://arxiv.org/pdf/2508.21085, not read). Treat the list as non-exhaustive.

**Licence and use restrictions in plain terms.** Apache-2.0 and MIT: bundle or download freely with notices. Gemma terms (gen 1): user must accept Google's terms and the Prohibited Use Policy; redistribution conditions live in those terms, which I did not read (UNVERIFIED). CC BY-NC 4.0 (all Jina): no commercial use without a licence from Jina; incompatible with an MIT product that others may use commercially.

## 2. Late interaction and sparse

- **Multi-vector (ColBERT style):** answerai-colbert-small-v1 is 33.4M params, 96-dim per-token vectors, Apache-2.0, BEIR avg 53.79 versus bge-small-en at 51.68 (card). Storage is per token, not per symbol. That breaks the "one vector per symbol" size rule (DESIGN.md) by roughly the token count of each symbol, and sqlite-vec has no MaxSim operator (its documented distance functions are L2, cosine, Hamming; API reference). Fit with SQLite: poor. Would need a custom scoring loop in JS. Not recommended for 1.0 scope.
- **bge-m3** emits dense, sparse lexical weights and multi-vector from one model (card), so a single model could feed an FTS-like sparse index. Its 1024 dims, 8K context and size (not stated on the card) make it heavier than the short-list. SPLADE: no model card was read; UNVERIFIED. A learned sparse index would be a posting-list table in plain SQLite, which fits, but there is no evidence here that it beats FTS5 trigram on identifier queries.
- **Verdict:** FTS5 already supplies the lexical lane. The gap to fill is vocabulary mismatch (query says "pick a photo", SDK says `PHPickerViewController`), which a dense embedder addresses directly.

## 3. Rerankers

- Qwen3-Reranker-0.6B: Apache-2.0, 32K, official-style GGUF at Q8_0 (ggml-org), prompt format `<Instruct>/<Query>/<Document>` with a yes/no answer (card). It is a causal decoder; llama.cpp states such rerankers have no `--ubatch-size` input limit, unlike bidirectional encoders such as bge-reranker-v2-m3 (llama.cpp server README).
- bge-reranker-v2-m3: Apache-2.0, 0.6B, based on bge-m3, evaluated by reranking top-100 (card, charts only).
- Jina rerankers: CC BY-NC. Excluded for licence even though jina-reranker-v3 reports CoIR 70.64.
- Cost model: a cross-encoder scores one (query, candidate) pair per forward pass. Reranking the top 50 FTS5 hits costs 50 passes per query; top 20 costs 20. That latency is bounded and deterministic in count, but not free. I have no latency measurement for any of these.
- llama.cpp serves rerank at `/reranking` (aliases `/rerank`, `/v1/rerank`) when started with `--reranking` or `--embedding --pooling rank`; scores are 0-1 probabilities (server README).

## 4. "Would a Jev like model help any?"

**Interpretation (primary), after the coordinator's correction:** Jev is TypeSafe AI's "System One" model. Evidence from the vendor's own pages:
- The launch post calls it "a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out"; it gives up free-form generation; question types are Choice, Score, Noul (yes/no) (https://typesafe.ai/blog/introducing-system-one-models-and-jev , https://docs.typesafe.ai).
- It is early access and hosted. The post does not state weights, size or licence. Latency 70-500 ms and $0.042 per million input tokens are vendor claims; the post says speed was measured from the team's laptops and that its comparisons ran through TypeSafe's own wrapper (same post). Retrieval, code and embeddings are not mentioned (same post and docs).
- The only open-source item is a Python LLM wrapper, `system-one-adapter-python` (linked from the post). I could not open that repo; a web search described it as a drop-in client backed by ordinary LLM APIs (UNVERIFIED, third-party summaries only).

**Blunt assessment:**
- It is not a local model and not an embedder. It cannot improve recall of the candidate set, which is what an embedding lane does.
- It is a hosted API, which conflicts with "no network by default, no telemetry" and the trust-boundaries ADR. It could only ever be an explicit opt-in.
- Its only conceivable role is a query router (for example: is this question about code symbols, SDK APIs or ADRs, and which tool/index should answer?). That is a classification step, not retrieval. An equivalent local router needs no hosted model: (a) a small embedder (any short-list model) plus a linear or nearest-centroid head over a few dozen labelled examples, fully offline and deterministic; or (b) a rule-based router on query shape (identifier-like vs prose), which is free. A grammar-constrained small LM (llama.cpp supports grammar sampling; not verified here) also works but adds a generative model, see item 5.
- Verdict: **does not help recall; do not adopt.** Revisit only if routing errors, not retrieval errors, show up as a measured failure class in the eval.

**Other readings considered:**
- (a) JEPA-style (I-JEPA, V-JEPA, LLM-JEPA): LLM-JEPA is a training objective for fine-tuning and pretraining LLMs, evaluated on NL-RX, GSM8K, Spider and RottenTomatoes with Llama3/OpenELM/Gemma2/Olmo; the abstract names no retrieval system or standalone embedder as an output (https://arxiv.org/abs/2509.14252). I-JEPA and V-JEPA are vision and video models. **Not relevant to text or code retrieval.** One line is enough.
- (b) Jina models: covered in item 1; usable technically, blocked by CC BY-NC licence.
- (c) Other spellings (a typo for a Jina or Gemma model) were considered; the coordinator's correction identifies TypeSafe's Jev, so none was pursued.

## 5. Small generative LMs (query rewriting / HyDE)

Only as an optional helper. Candidates (small Gemma, Qwen3 small, Phi, SmolLM) were not benchmarked or individually fetched for this note; model facts UNVERIFIED. Assessment against the claims:
- **Cited exact facts:** a rewriter that only changes the query is acceptable if every returned fact still comes from the Fact Store with its file and line. HyDE (generate a hypothetical answer, embed it) injects model-invented text into retrieval and is the riskier variant; keep it out of any path that yields a fact.
- **Determinism:** sampled generation is not deterministic; greedy decoding on one pinned backend and quantization is repeatable, but not across backends (see Determinism).
- **Bounded cost:** adds seconds and hundreds of MB to GB of weights per query path, on a tool that otherwise answers in sub-second.
- Recommendation: out of scope for the first embedding eval. Revisit only if recall on NL-intent queries stays short after embedder plus reranker.

## 6. Runtimes

### Node-callable runtimes

| Runtime | Version / licence | Install scripts | Prebuilt binaries | GPU | Model download | Source |
|---|---|---|---|---|---|---|
| `@huggingface/transformers` (transformers.js) | 4.3.2, Apache-2.0 | none defined | via onnxruntime-node | via ONNX Runtime (EPs not checked) | UNVERIFIED whether default is runtime fetch from the Hub; would need to be disabled and the model path set explicitly | https://registry.npmjs.org/@huggingface/transformers/latest |
| `onnxruntime-node` | 1.31.1, MIT; os: win32, darwin, linux | `postinstall: node ./script/install` | what the script fetches is UNVERIFIED | UNVERIFIED | none (library only) | https://registry.npmjs.org/onnxruntime-node/latest |
| `node-llama-cpp` | 3.22.2, MIT; Node >=20 | `postinstall: node ./dist/cli/cli.js postinstall` | 14 optional-dependency packages: mac-x64, mac-arm64-metal, linux x64/arm64/armv7l/riscv64, linux-x64 cuda/cuda-ext/vulkan, win-x64, win-arm64, win-x64 cuda/cuda-ext/vulkan | Metal, CUDA, Vulkan | library loads local GGUF; download helper (ipull) is a dependency, opt-in use UNVERIFIED | https://registry.npmjs.org/node-llama-cpp/latest |
| `llama-server` (llama.cpp) as a separate process | server README | n/a (user installs binary) | n/a | per build | `-hf` downloads from Hugging Face; `--offline` blocks network and uses the cache | https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md |
| Ollama / LM Studio | not fetched | n/a | n/a | n/a | n/a | UNVERIFIED: both expose OpenAI-compatible local endpoints per vendor docs I did not read |

Key facts and implications:
- transformers.js has no install script of its own but depends on `onnxruntime-node` 1.30.0 and `onnxruntime-web`, and `onnxruntime-node` has a `postinstall`. Under npm 11.20's default of blocking dependency scripts (project STACK finding 7), whether it still works is **UNVERIFIED and must be tested** with scripts disabled before it is listed as a viable no-install-script runtime.
- node-llama-cpp also has a `postinstall`. Its binaries are optional-dependency packages (like `@parcel/watcher`), so it may work with scripts blocked; UNVERIFIED.
- A separate `llama-server` process avoids both: gsd-atlas ships no native model dependency and talks HTTP to a binary the user installed, which fits "no install scripts" best at the cost of a second process.

### llama.cpp server as an optional endpoint (relevant to the Linux/CUDA node)

Facts from the server README: `--embedding` restricts the server to embedding use; `--pooling {none,mean,cls,last,rank}` (model default if omitted); other poolings return one Euclidean-normalised vector by default (`--embd-normalize 2`); `/v1/embeddings` is OpenAI-compatible; `--reranking` enables `/reranking`; `--api-key` / `--api-key-file`; default `--host 127.0.0.1`; `-hf <user>/<model>[:quant]` downloads at start and `--offline` forbids network.

Design for gsd-atlas, all proposals:
- Disabled by default. Enabled only by an explicit entry in user-level config (`~/.config/gsd-atlas/`), never from repo config or repo text (trust-boundaries ADR; repo text is untrusted).
- Endpoint allowlist: loopback by default; a LAN address only if the user lists it; no public hostnames. Key read from a file referenced by config, never printed.
- Disclose in `status` that symbol text (names, signatures, doc comments) leaves the process for the embedding call. This is a privacy cost the config prompt should state, since gsd-atlas stores no source text but would transmit it to embed it.
- Record the endpoint's model name, quant and pooling in stored vector metadata (Determinism section). Model download stays a separate explicit command; gsd-atlas never starts `llama-server -hf`.

### MLX (owner's Mac)

- **mlx-embeddings** (https://github.com/Blaizzy/mlx-embeddings): `pip install mlx-embeddings`; **GPL-3.0**; supports BERT, XLM-RoBERTa, ModernBERT, Qwen3 and Qwen3-VL embedding/reranking, Llama-bidirectional; a conversion CLI with affine, mxfp4, nvfp4, mxfp8 quant; **no server mode** documented; no release number stated; "runs locally on your Mac". Gemma-embedding architecture support is not listed there, so how the `embeddinggemma` MLX conversions are loaded is UNVERIFIED.
- **mlx-community conversions that exist** (HF API listing, downloads then licence tag): Qwen3-Embedding-0.6B-4bit-DWQ (32,002; Apache-2.0), Qwen3-Embedding-0.6B-8bit (3,521), Qwen3-Embedding-0.6B-mxfp8 (662), embeddinggemma-2-bf16/8bit/4bit/mxfp8/mxfp4/nvfp4/5bit/6bit (Apache-2.0), embeddinggemma-300m-4bit/8bit/bf16/6bit/5bit and two QAT variants (tag `gemma`), Qwen3-VL-Embedding-2B (Apache-2.0), LFM2.5-Embedding-350M (tag `other`), Octen-Embedding-4B (Apache-2.0). Source: https://huggingface.co/api/models?author=mlx-community&search=embedding. No MLX conversions of CodeRankEmbed, bge-small or the nomic models appeared in that query. Jina rerankers list MLX builds on their cards (CC BY-NC).
- **How Node would call it:** (1) a spawned Python helper over stdin/stdout JSON lines or a Unix socket; (2) a local HTTP server (none ships with mlx-embeddings, so it would be custom code); (3) a Swift binary built on mlx-swift (not researched; UNVERIFIED). Every route puts Python and a pip environment outside npm, adds a cold start that includes interpreter launch and weight load (not measured), and needs the user to install it.
- **Fit with the constraints:** no network by default and explicit-download are satisfiable (weights come from a user-run command). "No install scripts" is met only in the sense that gsd-atlas itself ships none. The GPL-3.0 licence means gsd-atlas must not import or vendor it; invoking a user-installed program as a separate process is an arm's-length boundary, but that is a legal question for the owner and I have not assessed it.
- **Platform:** MLX runs only on macOS (comparison summary in the search results below). macOS, Linux and Windows are all 1.0 platforms, so MLX can only be an optional macOS accelerator on top of a portable ONNX or llama.cpp baseline.
- **Speed evidence:** I found no embedding-specific MLX vs llama.cpp benchmark. Generation numbers only: one vllm-mlx paper reports 21-87% higher throughput than llama.cpp on LLMs from Qwen3-0.6B up, and a summary cites M4 Max at 525 vs 281 tok/s for a 0.6B model; both are generation workloads, one is by the vendor of the faster framework (https://arxiv.org/html/2601.19139v1 , search summary). An encoder pass on short symbol text is a different workload. **No evidence that MLX gives a material benefit for small embedders: measure it in the eval, do not assume it.**

### sqlite-vec facts

- Versions: npm `latest` 0.1.9, `alpha` 0.1.10-alpha.4 (published 2026-05-18, fixes for new ivf/diskann features) (https://registry.npmjs.org/sqlite-vec , https://api.github.com/repos/asg017/sqlite-vec/releases). README: "pre-v1, so expect breaking changes"; 163 open issues; Mozilla Builders project. Licence: MIT OR Apache-2.0 (npm metadata).
- What it does: `vec0` virtual tables store float, int8 and binary vectors; KNN via `match` + `k`. Docs do not state whether KNN is exact brute force, and I found no SIMD documentation (only an `avx` string in a debug example). The repo contains ivf and diskann source files and the alpha adds fixes for them, so ANN is arriving; brute-force default is UNVERIFIED by these pages.
- Quantization: `vec_quantize_binary()` is documented (positive to 1, negative to 0, bit-packed; float32 or int8 input). `vec_quantize_i8()` appears in the reference but its body is a placeholder ("todo"). Distances documented: L2, cosine, Hamming. So int8 quantization would have to be done in gsd-atlas JS before insert; A18's "int8 or binary" is feasible, but the int8 helper is not.
- `node:sqlite`: documented as `new DatabaseSync(":memory:", { allowExtension: true })` then `sqliteVec.load(db)`, vectors passed as `Uint8Array` over a `Float32Array` buffer (https://alexgarcia.xyz/sqlite-vec/js.html). That matches `.claude/CLAUDE.md`'s note that `loadExtension` works on Node 24.22 and 26.12.
- Platforms: README says Linux, macOS, Windows. npm optional dependencies seen in the visible portion of the registry document (version 0.1.4 only): linux-x64, darwin-x64, linux-arm64, windows-x64, darwin-arm64. Windows-arm64 and the 0.1.9 list: UNVERIFIED. Install scripts for 0.1.9: UNVERIFIED (response truncated).
- Alternatives: `sqlite-vector` and `vectorlite` were not researched (UNVERIFIED). Plain BLOB plus a JS dot product: my arithmetic, not a measurement: 200,000 symbols x 256 int8 dims = 51.2 MB and about 51 million multiply-adds per query, which a single Node thread should do in well under a second. That is plausible for "one vector per symbol", and avoids loading a native extension at all (also removes `allowExtension`'s security surface). Confirm with a micro-benchmark before choosing.

## 7. Determinism, eval and recommendation

### Determinism

Embeddings will not be bit-identical across ONNX Runtime, llama.cpp (CPU/Metal/CUDA) and MLX, nor across quantizations. Expect small non-zero differences in the vectors, from different kernels, accumulation order, fp16/bf16 vs fp32 and quantized weights. I have no measurement of the size. Handle it by design:
- Never compare vectors across backends, and never mix them in one index.
- Store in vector metadata: model id and revision hash, quantization, backend and version, pooling, normalisation, prefix/instruction, truncation dim, and a schema version. A mismatch on any field marks the vectors stale and triggers re-embed (the store is derived and rebuildable, A3).
- Within one backend, make ordering deterministic: sort by score descending, then by symbol id, so ties and near-ties do not vary run to run.
- Evaluate with rankings: compare recall@k across backends (below), not vectors.

### Backend matrix for the test design

| Arm | Hardware | Backend | Use |
|---|---|---|---|
| A | Mac, Apple silicon (dev) | MLX (user-installed Python helper) | optional accelerator; only models with a verified MLX build |
| B | Mac | llama.cpp Metal (`llama-server` or node-llama-cpp `mac-arm64-metal`) and/or ONNX | portable baseline |
| C | Linux Docker, RTX A2000 12 GB | llama.cpp CUDA via GGUF, `llama-server --embedding` | remote optional endpoint |
| D | any, CPU only | ONNX (transformers.js) or llama.cpp CPU | fallback floor |

Model fit and format status:
- 12 GB VRAM is not binding for any short-list model: weights are far smaller (EmbeddingGemma 2 GGUF Q8_0 310 MB, BF16 558 MB; CodeRankEmbed 137M; bge-small 33.4M). Qwen3-Embedding-0.6B at Q8 is about 0.6 GB by parameter-count arithmetic (not a measured file size). Even 4B and 8B Qwen3 embedders would fit by arithmetic, but they are outside "small".
- GGUF: EmbeddingGemma 2 (ggml-org, unsloth), EmbeddingGemma 300M (ggml-org incl. QAT Q4_0/Q8_0), Qwen3-Embedding 0.6B/4B/8B (official `Qwen/...-GGUF`), Qwen3-Reranker-0.6B (ggml-org Q8_0). CodeRankEmbed, bge-small, bge-reranker-v2-m3: no GGUF found in this research (UNVERIFIED; not searched). Pooling: pass `--pooling` explicitly where the GGUF metadata is uncertain; the EmbeddingGemma 2 GGUF card does not state it.
- Prefix handling: Qwen3 needs an instruction on queries; EmbeddingGemma gen 1 and CodeRankEmbed require task or query prefixes. The harness must apply the same prefix on every backend, otherwise the cross-backend comparison is invalid.

### Test design

Questions to answer: does adding a dense lane (and optionally a rerank step) over FTS5 improve recall on three slices, without hurting exact-identifier queries, within the size and latency budgets?

1. **Build the retrieval harness first** (new, not `scripts/recall.ts`). Corpus: reuse `gsd-core` pinned at `10ac3a7a947903ba50f538a907af036744d759d5` for code and ADR slices; add an SDK slice from the installed SDK facts (needs a pinned SDK pack; UNVERIFIED which). Cross-check against `docs/eval/key-set-v2` questions for overlap.
2. **Three query slices, truth written by hand before any model runs** (same rule as T-02-41): (a) SDK API by natural-language intent; (b) ADR/decision recall by paraphrase; (c) code symbol find, split into identifier-like queries and prose-like queries. Proposed size: at least 50 queries per slice (the locked `eval.minQuestions` floor is 50); registered in advance like the prereg.
3. **Arms:** FTS5-only baseline; FTS5 + dense via reciprocal-rank fusion; dense-only; FTS5 + dense + reranker over top-N (try N = 20 and 50). Models: the four short-list embedders, Qwen3-Reranker-0.6B as the rerank arm.
4. **Metrics:** recall@5, recall@10, MRR, per slice, never pooled (same discipline as the per-construct recall report). Also p50/p95 query latency, index time, and store bytes against A18.
5. **Cross-backend rule:** run each embedder on every available backend arm and compare the recall@k and ranking overlap between backends (for example top-10 set overlap), not vector distance. A model passes backend-portability if recall@10 differs by no more than 1 absolute point between its backend arms (proposed threshold).
6. **Pass threshold (proposed, for the owner to change before freezing):** a candidate passes if (i) on the NL-intent slices (a) and (b) combined, hybrid recall@10 exceeds the FTS5 baseline by at least +5 points absolute with the 5th percentile of a paired bootstrap difference above zero; (ii) on identifier-like code queries, hybrid recall@10 is not worse than baseline by 1 point or more (non-inferiority); (iii) p95 added query latency under an owner-set budget (no number is set in the repo that I found); (iv) store growth within A18 at 1 vector per symbol, int8 or binary. The structure mirrors the H1 non-inferiority form in `docs/eval/preregistration.md`; the numbers are mine, not registered.
7. **Rerank vs bigger embedder:** run the rerank arm on the smallest embedder and compare against the largest short-list embedder alone. If reranker + small embedder matches or beats the larger embedder on precision with lower store cost, prefer it; if recall@50 of the candidate set is the limiter, the embedder wins. Run it, do not assume.
8. **Honest limits:** the corpus is mostly TypeScript and JavaScript; Swift and SDK slices depend on fixtures that may not be pinned yet.

### Recommendation (priors to be tested)

- Default: **EmbeddingGemma 2**, if it beats Qwen3-Embedding-0.6B on slices (a) to (c) at equal or lower store cost. The reason is licence (Apache-2.0), format coverage (ONNX, GGUF, MLX) and published code score; not a measured win.
- Tiny fallback: **bge-small-en-v1.5** (MIT, 33.4M, 384 dims, ONNX), subject to the 512-token limit being acceptable for doc comments.
- Code-symbol specialist to include in the test: **CodeRankEmbed** (MIT, CoIR 60.1), only if a loadable ONNX or GGUF build can be produced without `trust_remote_code`.
- Reranker: **Qwen3-Reranker-0.6B** (Apache-2.0, GGUF Q8_0) as the only reranker worth testing; exclude Jina rerankers on licence.
- Do not adopt Jev, JEPA models, ColBERT-style multi-vector, or generative query rewriting in this phase.

## Open questions

1. Does the Gemma note assume EmbeddingGemma 300M and the Gemma terms? If so it should be revised to cover EmbeddingGemma 2 (Apache-2.0).
2. EmbeddingGemma 2 parameter count: the card says 740M total with a 270M text model, the GGUF card says 0.3B and 310 MB at Q8_0. Confirm which weights an embedding-only deployment loads, and the real text-only file size.
3. Does `onnxruntime-node` (and therefore transformers.js) work under npm 11.20 with install scripts blocked? What does its `postinstall` fetch? Does transformers.js fetch models from the Hub by default, and can that be hard-disabled?
4. Does `node-llama-cpp` run with its `postinstall` blocked, and does it make any network call on its own?
5. Is a CodeRankEmbed ONNX or GGUF build available without `trust_remote_code`?
6. sqlite-vec: is default KNN exact brute force, which platform packages exist at 0.1.9 (Windows arm64), any install script, and is a JS-only BLOB scan fast enough at the real symbol counts?
7. MTEB-Code and CoIR numbers for Qwen3-Embedding-0.6B (not on its card), and any independent (non-vendor) reproduction of the EmbeddingGemma 2 code score.
8. mlx-embeddings is GPL-3.0: is a user-installed external helper acceptable to the owner, and is any MLX path worth building given no embedding-specific speed evidence?
9. Cost of sending symbol text to a remote `llama-server`: does the owner accept that for an opt-in endpoint, and what allowlist policy (loopback only, or named LAN hosts)?
10. Which pinned SDK pack serves as the SDK-intent corpus for slice (a)?
11. Jina v3/v4 and Granite Embedding R2 facts remain unread.
