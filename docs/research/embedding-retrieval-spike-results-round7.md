# Embedding retrieval spike, round 7: full-pack embed throughput on the Mac

Date: 2026-10-29. Status: research evidence only. No product code, dependency, ROADMAP or ADR change. Plan section 16 was frozen before any variant was timed (`.planning/spikes/round7/plan-section-16.frozen.md`); harness hash and one stated deviation are in `.planning/spikes/round7/FREEZE.md`; raw output in `.planning/spikes/round7/results/r7-bench.json`. Mac (Metal, Apple M5 Max, 128 GB) only.

## Short answer

Runtime settings alone cut the full-pack embed from about 24 minutes to a projected 11.5 minutes (693 s) with four concurrent embedding contexts, producing the same vectors (cosine 1.0 on the 3,000-document sample). That misses the registered 10-minute target (E1: at least 244 docs/s, got 211.6), so by the plan's rule the full-pack run was not performed and the 10-minute index budget stays unmet by settings alone on this machine. The result is a lower bound: the machine was shared throughout.

## What was run

Same pack (146,554 declarations), model (EmbeddingGemma 2 Q8_0 via node-llama-cpp 3.22.2), document prefix and `docText3` as rounds 3 to 6. A fixed 3,000-document sample, three repetitions per variant after a 100-document warm-up, median docs/s, fidelity against the round 3 vectors for every variant.

| Variant | Setting | docs/s (median) | Runs | Projected full pack | Fidelity (mean / min cosine) |
|---|---|---|---|---|---|
| T0 | one context, sequential (baseline) | 96.0 | 96.0, 102.2, 81.5 | 1,527 s | 1.0 / 1.0 |
| T1 | one context, batchSize 2048 | 86.6 | 95.9, 86.6, 74.5 | 1,692 s | 1.0 / 1.0 |
| T2-n2 | 2 concurrent contexts | 177.2 | 167.7, 179.4, 177.2 | 827 s | 1.0 / 1.0 |
| **T2-n4** | **4 concurrent contexts** | **211.6** | 211.6, 212.2, 207.1 | **693 s** | 1.0 / 1.0 |
| T2-n8 | 8 concurrent contexts | 180.6 | 179.5, 180.8, 180.6 | 811 s | 1.0 / 1.0 |
| T3-n4 | 4 contexts, longest documents first | 207.9 | 206.4, 207.9, 209.2 | 705 s | 1.0 / 1.0 |
| T4 | smaller context size | void | | | the longest document in the full pack is 550 tokens, above 512 |

## Conditions

| # | Condition | Result |
|---|---|---|
| E1 | A fidelity-passing variant reaches 244 docs/s | **Not met**: best 211.6 (T2-n4), a 2.2 times speed-up over the baseline of this session, projecting 693 s |
| E2 | Full-pack run finishes in 600 s or less | Not run (E1 not met, per plan 16.4) |
| E3 | Full-pack vectors match round 3 | Not run. On the sample, mean and minimum cosine are 1.0 for every variant |
| E4 | Retrieval unchanged | Not run |

## Reading

- Concurrent contexts are the lever: 2 contexts give 1.8 times, 4 give 2.2 times. Eight contexts are slower than four, so the GPU is saturated near four. Batch size alone (T1) does nothing, and longest-first ordering (T3) does not help.
- The baseline of this session (96 docs/s) is below the 102.4 of the round 3 full run, with one repetition at 81.5 under load, so the baseline itself is noisy at about ±10%.
- Load was not controlled (plan 16.5). T2-n4 ran at a 1-minute load of 2.5 to 2.9 with CPU 80 to 84% idle; T2-n8 reached a load of 18.3 in its third repetition; T3-n4 ran at 11 to 15. The best figure is therefore the cleanest one and the others are lower bounds. A quieter machine could plausibly move T2-n4 from 211.6 toward 244, but that is not shown.
- Stated deviation (FREEZE.md A1): variants ran in a fixed order with repetitions back to back, not rotated, so drift can favour earlier variants; T0 was not repeated at the end.
- The context size cannot be reduced, because 550-token documents exist; truncating them would change vectors and is outside this round.

## What this means for the proposal

- The 24-minute full-pack embed was an artefact of embedding one document at a time. With four concurrent contexts it is about 11.5 minutes on an M5 Max, still above the 10-minute default budget, and the default would need either a few more points of throughput, a quieter machine, or a documented budget exception. The figure is for the Metal path of this one machine; CPU-only, CUDA and Windows are not measured.
- The index could also be built incrementally per module, which makes the full-pack time a first-run cost, not a per-update cost; this was not measured.
- No retrieval result changes.
