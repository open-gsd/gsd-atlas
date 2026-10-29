# Plan section 16 (round 7): full-pack embed throughput on the Mac

Frozen 2026-10-29 before any variant is timed. Research only: no product code, dependency, ROADMAP or ADR change. Mac (Metal) only (Apple M5 Max, 128 GB); CPU-only, CUDA and Windows are out of scope. Same pack (MacOSX27.0.sdk, 146,554 declarations), model (EmbeddingGemma 2 Q8_0 GGUF via node-llama-cpp 3.22.2), document prefix and `docText3` as rounds 3 to 6. Baseline: sequential, one embedding context, `contextSize` 1024, 102.4 docs/s, 1,415 s for the full pack.

## 16.1 Question

Can the full-pack embed be brought to 600 s or less (the 10-minute index budget, at least 244 docs/s) on this machine without changing the vectors, using only runtime settings (concurrent contexts, batch size, ordering)? Text, prefix, model and quantisation are fixed, so any gain is throughput, not a change of method.

## 16.2 Variants (timed on one fixed sample)

Sample: 3,000 documents of the 146,554, the documents with `fnv1a(id) mod 48 == 0` (about 3,050), sorted by id, first 3,000. Each variant embeds the same sample in the same session after one warm-up pass of 100 documents (excluded). Order of variants is rotated per repetition; each variant is run 3 times; report median docs/s and all runs.

- **T0**: one context, sequential, contextSize 1024 (baseline repeated in this session).
- **T1**: one context, contextSize 1024, batchSize 2048, sequential.
- **T2**: N independent embedding contexts on one loaded model, N in {2, 4, 8}, a shared queue, each context handling one document at a time, contextSize 1024.
- **T3**: the best N from T2 with the queue ordered by descending character length (longest first).
- **T4**: the best of T1 to T3 with contextSize reduced to the smallest of {512, 256} that fits every sample document, as measured by `calculateInputLength` (a variant is void if any document in the full pack, not just the sample, exceeds it; the full-pack maximum token length is computed first and reported).

## 16.3 Fidelity gate (applies to every variant; a variant failing it is excluded)

Vectors are L2-normalised float32 as in round 3. For the 3,000 sample documents, compare with the cached round 3 vectors (`eg2-gguf-cfbf0ea6e087.f32`): mean cosine at least 0.9999 and minimum cosine at least 0.999. Concurrency and batching may change floating-point summation order, so exact equality is not required.

## 16.4 Conditions

| # | Condition | Metric |
|---|---|---|
| E1 | Some variant passing the fidelity gate reaches at least 244 docs/s (median of 3) on the sample, i.e. 600 s projected for the full pack | docs/s |
| E2 | The full-pack run of the best passing variant finishes in 600 s or less, wall clock, measured once | s |
| E3 | Full-pack vectors: mean cosine to round 3 at least 0.9999, minimum at least 0.999 over all 146,554 documents | cosine |
| E4 | Retrieval unchanged: for the 722 latency-mix queries (the `latency6.mjs` mix) the dense top-10 from the new matrix against the old matrix has a mean overlap of at least 0.99 and the gold-hit rate at 10 differs by at most 0.3 points | overlap, recall@10 |

Decision rules: E1 not met means the 10-minute embed budget is not reachable by settings alone on this machine and the finding stands as "about N minutes with the best settings". E1 met but E2 not met means the projection was optimistic (report why). E3 or E4 failing voids the variant for production use. The full-pack run is performed only if E1 is met and a passing variant exists.

## 16.5 Load and honesty

Throughput is measured whatever the load; the 1-minute load average and CPU idle percentage are recorded before and after each timed run and reported with the figures. No run is discarded for load, and none is called certified when load was above 1.5. Results from a loaded machine are lower bounds on throughput.

## 16.6 Out of scope

Other models, quantisations, shorter text, reduced dimension at embed time (MRL truncation is applied after embedding, as before), CPU-only and CUDA arms, and any product code. Round 7 changes no earlier result; amendments go to `round7/FREEZE.md`.

## 16.7 Deliverables

`round7/bench7.mjs`, `round7/results/r7-bench.json`, `docs/research/embedding-retrieval-spike-results-round7.md`, MANIFEST row R7, todo and proposal status updates, commits on this branch.
