---
spike: 001
idea: embedding-retrieval-lane
name: fts5-baseline-and-gold-queries
type: standard
validates: "Given the pinned corpus and hand-written gold queries (slices a, b, c1, c2), when FTS5 alone runs, then per-slice baseline recall@10 is recorded and shows headroom on the plain-language slices"
verdict: VALIDATED
related: []
tags: [fts5, baseline, recall, embeddings]
---

# Spike 001: FTS5 baseline and gold queries

## What This Validates
Given gold queries per slice, when FTS5 (trigram, bm25) alone runs, then baseline recall@10 shows headroom for a dense lane. If FTS5 is already near ceiling, the idea has little room.

## Research
Plan: `docs/research/embedding-retrieval-spike-plan.md`. Baseline query construction (fixed before running): content words of 3+ characters, stopwords removed, OR-joined quoted terms, bm25 with weights name 6, name-split 4, others 1, ties by id. FTS5 trigram table per slice with columns name, name-split, path, doc comment, signature.

## How to Run
`node extract.mjs <gsd-core-pin-dir> <data-dir>` then `node baseline.mjs <data-dir>`. The corpus is a read-only `git archive` of gsd-core at `10ac3a7a947903ba50f538a907af036744d759d5` (owner-approved, extracted to the session scratchpad). Pool sizes: 2,881 code symbols (1,444 with a doc comment), 122 ADR sections (this repo's `docs/adr/`), 833 Node SDK declarations with JSDoc (`@types/node` 24.19.2).

## Investigation Trail
- Gold: 29 SDK-intent (slice a) and 28 ADR (b) queries and 30 code-prose queries (c2) hand-written from a seeded sample (seeds 11, 12, 13), read from each target's own text, before any search ran. 40 identifier-like queries (c1) are generated mechanically (exact name, spaced words, 2/3 prefix, 2/3 suffix). All below the plan's 50-per-slice floor, so results are preliminary.
- First extraction kept only the last 14 comment lines of long JSDoc blocks, which cut off the description; fixed to keep the whole block's prose before the first code fence, then re-extracted.
- Diagnostic (`diag.mjs`): queries with at most half their content words present in the target text: a 10/29, b 2/28, c2 1/30.

## Results
| Slice | n | recall@5 | recall@10 | MRR | Misses at 10 |
|---|---|---|---|---|---|
| a SDK intent | 29 | 0.862 | 0.897 | 0.643 | setDefaultAutoSelectFamily (rank 17), Stats (none), readvSync (rank 11) |
| b ADR | 28 | 1.000 | 1.000 | 0.982 | none |
| c1 identifier | 40 | 1.000 | 1.000 | 0.913 | none |
| c2 code prose | 30 | 1.000 | 1.000 | 0.911 | none |

FTS5 query time: 0.2 to 1.4 ms per query on these pool sizes.

**First-set result (29 SDK queries written from target text): PARTIAL.** The spike's kill condition (no headroom) is mostly tripped: only slice a leaves room (at most 10.3 points, 3 misses), and b, c1, c2 are at ceiling, so a +5 point lift cannot be shown there. Caveats that limit this conclusion: (1) gold queries were written from the targets' own text, which favours lexical search; (2) the pools are small (122, 833, 2,881), so distractors are few; real SDK packs will be far larger; (3) n is below the floor, so the slice-a interval is wide (3 misses out of 29).

## Follow-up: vocabulary-gap SDK set (owner-directed, 2026-10-28)
Because the first set was worded from the targets' own text, a second SDK set (`gold-a2.json`, 56 queries, different targets, seed 21) was written as task descriptions and synonyms, deliberately avoiding the docs' vocabulary. Written before any search ran; `baseline-a2.mjs` measures it.

| Set | n | recall@5 | recall@10 | MRR | Mean share of query words found in target text |
|---|---|---|---|---|---|
| a2 vocabulary-gap SDK | 56 | 0.446 | 0.536 | 0.290 | 0.28 (39 of 56 at or below 0.34) |

By name overlap: queries sharing a name word 14, recall@10 0.714; no shared name word 42, recall@10 0.476. 26 of 56 miss the top 10 (11 of them are not found in the top 50 at all, for example `createZstdCompress`, `isDate`, `match`, `url`).

**Verdict: VALIDATED for headroom on vocabulary-gap SDK queries.** FTS5 alone leaves about 46 points for a dense lane to recover. Caveats: this set is built to have a vocabulary gap, so it is a best case for embeddings, not a sample of real agent queries; n is 56 on a single 833-declaration pool (`@types/node` 24.19.2); one author. Overall for spike 001: FTS5 is at ceiling on ADR and code slices (so those slices cannot show a lift on this evidence) and has large headroom on vocabulary-gap SDK intent. Remaining spikes narrow to the SDK slice, using `gold-a2.json` as the primary set and `gold-a.json` as the non-inferiority check.
