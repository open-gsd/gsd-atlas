# Plan section 13: round 4 (frozen 2026-10-29, before any round 4 arm is scored and before the M4 targets are drawn)

Status: research evidence only. No product code, dependency, ROADMAP or ADR change. Follows `plan-section-12.frozen.md`; section 12 stays frozen and is not edited.

## 13.1 Questions and scope

Round 3 left four open points. Round 4 answers each with a pre-registered arm:

1. **Fusion cost.** The registered arm (R2, weight 3) scored 3.4 points below dense only on V3 because the lexical list is almost empty on vocabulary-gap queries. Can a router keep the identifier gains without that cost?
2. **Real queries sit between the two extremes.** V3 forbids shared words, I3 is the bare identifier. A third set, M4, holds natural-language queries that mention part of the API name or its owner, which is what agent queries look like in practice.
3. **Reranker.** A cross-encoder over the top 50 (dense recall@50 is 0.34 against 0.21 at @10).
4. **Budget and weak spots.** Pool-lite scoping (recall inside the scoped pool, which round 3 never measured) and prose for the Swift declarations (stratum C 0.107, D 0.135).

Out of scope, by decision of the user: Windows, Node 24 CI, CUDA, CPU-only arms, human-written queries. The consumers of this lookup are AI agents, so AI-authored queries are the intended distribution; the remaining concern (one model family writes all queries) is handled in 13.3 by drawing M4 authors with a different brief, not by adding human authors.

## 13.2 Inputs (fixed)

- Pack: `docs.json` of MacOSX27.0.sdk (sha256 c47083b3afa8547dc5c7cbaa979189c580e74267d80fa3160326f0fea617cb23, 146,554 declarations), the same extractor output as round 3.
- Frozen sets: `round3/queries/gold-v3.json` (285, sha256 1d72a3a0efd2729291a7e4cbc58ae8abb1df4497939fb8c6867c23d268f936c9), `gold-i3.json` (90, sha256 608b02f7ae39c451030b58d869ff64478dfe6427dd868a807a6797a6f467c179). Test/tuning split: `fnv1a(kind|id) mod 10 < 3` is tuning. Strata labels are read from both target files (round 3 bug not repeated).
- Model: EmbeddingGemma 2 Q8_0 GGUF on Metal, prefixes `title: none | text: ` (documents) and `task: search result | query: ` (queries), dense text `docText3` (name, split name, qual, first 240 characters of the signature, doc, truncated to 1,200 characters). Cached round 3 document vectors (`eg2-gguf-cfbf0ea6e087.f32`) are reused for the base pool.
- Reranker: Qwen3-Reranker-0.6B Q8_0 GGUF (`ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF`) through node-llama-cpp `rankAll`, ranking context 1,024 tokens, document text `docText3` without the 1,200-character truncation beyond 1,200 (same text as the dense lane).
- Statistics: paired bootstrap, 10,000 resamples, seed 42; 5th percentile (p5) of the paired difference is the lower bound reported.
- Reproduction gate: before any new arm is read, the harness must reproduce the round 3 numbers on the base pool (V3 test D 0.214, R2w3 0.180, I3 test D 0.836, R2w3 0.918, L = F2). A mismatch stops the round.

## 13.3 M4 (mixed-intent set)

- 90 queries, three fresh AI authors (30 each) that see no results and did not write for rounds 1 to 3. Targets drawn by `sample-m4.mjs` (seed 47) from the same eligibility rules and strata as V3 (A objc documented pre-27, B objc documented macOS 27, C Swift macOS 27, D Swift pre-27), 10, 5, 10 and 5 per author (A 30, B 15, C 30, D 15), excluding every earlier V3 target, rejected target and I3 target, plus 6 reserve targets per author.
- Brief: write the question an agent would put to a documentation lookup while implementing the task the declaration serves. The query must contain **at least one** word that is a piece of the declaration name, of its owner type, or of the framework name (so it is not a pure vocabulary-gap query), must not contain the full declaration name, and must be 5 to 25 words. Authors are told to describe the goal and to mention the owner type or framework where an agent normally would.
- Checker `check-m4.mjs` (text only): accepts a query only if it has 5 to 25 words, contains at least one name/owner/framework piece of length 3 or more as a whole word, and does not contain the full name (case-insensitive). Rejected queries are dropped, not repaired; at least 60 accepted queries are required, else a second draw with the same checker.
- M4 is frozen (sha256 recorded) before any arm is scored on it. Split rule as above.

## 13.4 Arms

Notation: `L` lexical list (F or F2 as chosen by round 3's rule on V3 tuning, recomputed), `D` dense top 50, `Wk` weighted RRF (k 60, weight k on dense), `r2Hit` the round 3 exact-name test on the lexical top hit, `nameTok(q, d)` = at least one query token (lowercase, 4+ characters) equals the lowercase name of document `d` or one of its split-name pieces.

Part A, routers (base pool, base docs, no embedding other than queries):
- `R2w3` (round 3 primary, reproduction check).
- `R3` = if `r2Hit` then `L` else `D`.
- `R4` = if `r2Hit` then `L`, else if `nameTok(q, L[0])` then `W3`, else `D`.
- Primary router: the higher mean of tuning-half recall@10 over V3, I3 and M4; a tie goes to `R3`. Fixed before scoring; no other candidates are added.

Part B, reranker: `RR50` = primary router list, top 50 candidates, reranked by Qwen3-Reranker, except that queries with `r2Hit` keep the lexical order. `RR20` = same with 20 candidates (secondary). Candidate lists are the lists of Part A, no other fusion.

Part C, Pool-lite: pool = Objective-C/C declarations with documentation of 40 or more characters plus every declaration introduced in macOS 26 or later (round 3 definition; the harness aborts unless it selects 37,293 documents). Arms `D_lite` (dense over the lite vectors, already cached) and `R_lite` (primary router with F2 restricted to the lite ids). Reported twice: on queries whose gold is inside the lite pool (in scope) and on all queries (gold outside the pool counts as a miss).

Part D, Swift prose: for each of the 192 Swift modules, `swift-symbolgraph-extract -module-name M -target arm64e-apple-macos27.0 -sdk MacOSX27.0.sdk -minimum-access-level public -skip-synthesized-members` yields doc comments. Join key `module|owner.name` (module = file prefix before `@`, owner = path component before the name, empty if none); the first doc comment per key wins; every pack record of part `swift` with an empty `doc` and a matching key receives the text (whitespace-collapsed, at most 600 characters). Pack records with existing prose are unchanged. Documents whose dense text changed are re-embedded; all other vectors are reused. Both lexical indexes are rebuilt from the enriched docs. Arms `D_sw` and `primary_sw` (primary router, enriched pool). The pack is otherwise identical. Coverage (records enriched, per module) is reported.

## 13.5 Conditions

Evaluated on the test halves with EmbeddingGemma 2 on Metal unless noted.

| # | Condition |
|---|---|
| P1 | Primary router minus `D` on V3 is at least -1 point (the fusion cost is gone). |
| P2 | Primary router on I3 is at least `F` minus 1 point (non-inferior to the trigram baseline, as in round 3) and not below `R2w3` by more than 2 points. |
| P3 | Primary router on M4 is at least the better of `L` and `D` minus 1 point. |
| P4 | Primary router minus `L` on V3 is at least +5 points with p5 above 0 (round 3 C1 holds for the router). |
| RK1 | `RR50` minus the primary router on V3 is at least +3 points with p5 above 0. |
| RK2 | `RR50` on I3 and on M4 is not below the primary router by more than 1 point on either. |
| RK3 | Two reranker runs on the same 60 queries (30 V3, 15 I3, 15 M4, first by id order) give identical top-10 lists. |
| RK4 | Reranker added latency (p95, 50 candidates) is reported; no pass or fail. |
| L1 | In scope (gold inside the lite pool), `D_lite` recall@10 on V3 is at least `D` on the same queries minus 1 point. |
| L2 | Reported: all-query recall of `R_lite`, index time and storage of the lite pool. No pass or fail. |
| SW1 | V3 strata C and D together: `D_sw` minus `D` is at least +3 points with p5 above 0. |
| SW2 | V3 strata A and B: `D_sw` is not below `D` by more than 1 point; I3 and M4 primary_sw not below primary by more than 1 point. |
| SW3 | Reported: Swift records enriched, extra embedding time. |

## 13.6 Decision rule

Each part is judged on its own conditions. P1 to P4 met: the router replaces the round 3 primary arm in the proposal. RK1 and RK2 met: the reranker is recorded as a candidate second stage with its latency as the blocker. L1 met: Pool-lite is recorded as the supported scoping rule for the index-time budget. SW1 and SW2 met: Swift prose from symbol graphs is recorded as a pack requirement. Anything not met is reported as not met; no arm is tuned after seeing test results.

## 13.7 Procedure and amendments

Order: reproduction gate, M4 authored and frozen, Part A and C (no embedding beyond queries), Part B, Part D. Amendments are appended to `FREEZE.md` with date and reason; a change after a part has been scored is labelled as such.

## 13.8 Known limitations (stated in advance)

All queries are AI-authored. M4 is small (90) and its test half is about 60. The reranker latency (about 0.5 s per query in round 1) will exceed the 50 ms budget by an order of magnitude and cannot pass a latency condition on this runtime. Symbol-graph join keys are heuristic: overloads share a key and the first doc comment wins. The Swift stratum labels C and D were defined by absence of prose in the unenriched pack.
