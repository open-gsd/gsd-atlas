# Embedding retrieval spike, round 3: real SDK pack (macOS 27)

Date: 2026-10-29. Status: research evidence only. No product code, no dependency, no ROADMAP change. Plan section 12 was frozen before any target was drawn (`.planning/spikes/round3/plan-section-12.frozen.md`, sha256 `935e0147…44cd`), amendments A1 to A3 are in `.planning/spikes/round3/FREEZE.md`, frozen query sets and raw author files are in `.planning/spikes/round3/queries/`, results in `.planning/spikes/round3/results/`.

## Short answer

On the real macOS 27 SDK (146,554 declarations), EmbeddingGemma 2 meets the three registered effect conditions (C1 to C3) and the determinism, network-denied and portability checks (C4 to C6). It fails the registered budget condition (C7): embedding the full pack takes 24 minutes on Metal (budget 10) and the added query p95 is 118 ms (budget 50). Absolute recall is modest: vocabulary-gap queries find the right declaration in the top 10 only 21 percent of the time (round 2 on the 9.5k stand-in pool: 60 percent). The lane helps, but this result does not support "dense retrieval solves SDK intent lookup"; it supports "dense retrieval is the only lane that finds anything when the query shares no words with the API, and it is far from complete".

## What was run

- **Pack:** MacOSX27.0.sdk from Xcode 27.1 (27A9275). 146,554 declarations: 78,903 from Objective-C and C headers (21,263 with a doc comment of 40+ characters), 67,651 from the `arm64e-apple-macos` Swift interfaces of 192 modules (no prose docs). 9,604 were introduced in macOS 27. `Kernel` and `DriverKit` are excluded. The extractor is a heuristic line parser, not a compiler front end.
- **V3 (vocabulary gap):** 285 queries from six fresh AI authors that saw no results (two batches of three), checker-accepted out of 383 submitted. Strata: A objc documented pre-27 (97), B objc documented macOS 27 (57), C Swift macOS 27 with no prose (83), D Swift pre-27 (48). Test half 206, tuning half 79.
- **I3 (identifiers):** 90 mechanical queries (six rules), test half 61, tuning half 29.
- **Arms:** `F` (trigram bm25), `F2` (new, stronger: porter-stemmed word bm25), `L` (the better of the two on V3 tuning, which was `F2`), dense only `D`, RRF `E`, weighted `W2`/`W3`, routers `R1`/`R2`. Primary arm fixed in advance: R2 with the weight tuned on the tuning half (weight 3).
- **Models (Metal):** EmbeddingGemma 2 (primary), Qwen3-Embedding-0.6B, bge-small (re-run with truncation, amendment A3).

## Results: V3 test half (n 206), recall@10, EmbeddingGemma 2 on Metal

| Arm | Recall@10 |
|---|---|
| F (trigram) | 0.005 |
| F2 (porter words) = L | 0.005 |
| D (dense only) | 0.214 |
| E (RRF, equal) | 0.146 |
| Primary (R2, weight 3) | 0.180 |

Primary minus L: +17.5 points, bootstrap 5th percentile +13.1. Primary minus dense only: −3.4 points (p5 −5.8), so on this set the fusion with the near-useless lexical list costs recall. Dense recall@1, @5, @10, @50: 0.053, 0.160, 0.214, 0.340.

| Model | D | Primary | Primary − L (p5) |
|---|---|---|---|
| EmbeddingGemma 2 | 0.214 | 0.180 | +17.5 (+13.1) |
| Qwen3-Embedding-0.6B | 0.180 | 0.150 | +14.6 (+10.7) |
| bge-small (700-char truncation) | 0.068 | 0.058 | +5.3 (+2.9) |

Ordering matches round 2. Qwen3 is the closer alternative.

### By stratum (test halves; recomputed from saved lists, see "Deviations")

| Stratum | n | L | D | Primary | Primary − L (p5) |
|---|---|---|---|---|---|
| A objc documented, pre-27 | 68 | 0.015 | 0.353 | 0.294 | +27.9 (+19.1) |
| B objc documented, macOS 27 | 45 | 0.000 | 0.178 | 0.156 | +15.6 (+6.7) |
| C Swift, macOS 27, no prose | 56 | 0.000 | 0.125 | 0.107 | +10.7 (+3.6) |
| D Swift, pre-27 | 37 | 0.000 | 0.135 | 0.108 | +10.8 (+2.7) |

By part: objc 0.239 (D 0.283), Swift 0.108 (D 0.129). The macOS 27 strata (B, C), where no model has training data, are positive but small: 0.156 and 0.107. Documentation text matters: documented objc is about twice as findable as the prose-less Swift declarations.

### Identifiers (I3 test, n 61)

| Arm | Recall@10 |
|---|---|
| F | 0.803 |
| F2 (= L) | 0.656 |
| D | 0.836 |
| Primary | 0.918 |

By rule (primary / L): exact 0.889 / 1.0 (the one miss is a name collision), qualified 1.0 / 1.0, fragment 0.5 / 0.0, lowercase-joined 1.0 / 1.0, misspelled 1.0 / 0.083, module member 1.0 / 1.0. The misspelled and fragment rules are where dense retrieval helps; exact names are already solved lexically. `R1` (syntactic identifier test) is inferior again (0.656 with `F2` as L).

## Registered pass conditions (EmbeddingGemma 2, Mac)

| # | Condition | Result |
|---|---|---|
| C1 | V3 primary − L ≥ +5 pts, p5 > 0 | **Met**: +17.5, p5 +13.1 |
| C2 | Each stratum non-negative | **Met**: A +27.9, B +15.6, C +10.7, D +10.8 (all p5 > 0; C and D have n 56 and 37) |
| C3 | I3 primary within 1 pt of L | **Met**: 0.918 vs L 0.656. Caveat below |
| C4 | Two Metal runs identical | **Met**: dense and primary top-10 identical for all 375 queries (document vectors reused, query vectors recomputed) |
| C5 | Network-denied run identical | **Met**: on a 5,375-document sub-pool (all gold plus 5,000 random), document vectors rebuilt inside `sandbox-exec` with network denied, 375 of 375 top-10 lists identical |
| C6 | ONNX CPU within 1 pt, overlap ≥ 0.9 | **Met**: 20,496-document sub-pool (gold, union of Metal dense top-50 lists, 5,000 random), ONNX q8 CPU: dense recall identical (V3 0.214, I3 0.836), primary V3 0.175 vs 0.180, mean top-10 overlap 0.968 (98 of 375 lists identical) |
| C7 | Embed ≤ 10 min, added p95 ≤ 50 ms | **Not met** (see below) |
| C8 | Storage reported | Reported (below) |

Under section 12.6, C1 to C3 are met, so the lane is confirmed on a real SDK pack; C7 is a named blocker for the product phase, and the scoping measurements below show how it can be approached.

**Caveat on C3.** `L` is whichever lexical arm is better on V3 tuning, where both score about zero, and `F2` won by one query (0.013 vs 0.000). `F2` is much worse than `F` on identifiers (0.656 vs 0.803). Against `F` the primary arm gains +9.8 points on I3 (p5 0.0), so non-inferiority holds either way, but the +26 points against `L` overstates it.

## Budget, scale and storage (C7, C8)

- **Index time, full pack, Metal:** 146,554 documents in 1,431 s (24 min), 102 documents/s. Qwen3: 96/s (25 min). bge-small: 373/s (6.6 min, truncated). ONNX q8 on CPU for EmbeddingGemma 2: 22.4 documents/s measured on a 20,496-document sub-pool, so about 109 min for the full pack (linear extrapolation).
- **Added query p95 (embed + scan + trigram FTS), full pack, Metal:** 118 ms (embed 29, float32 768 scan 67, FTS 34). ONNX CPU on the sub-pool: 78 ms (embed 33).
- **Scan variants (dense only, V3/I3 test recall@10; scan p95):** float32 768: 0.214 / 0.836, 67.5 ms, 450 MB. int8 768: 0.214 / 0.836, 101.9 ms (the JS int8 loop is slower), 113 MB. int8 256 (MRL truncation): 0.209 / 0.885, 39.3 ms, 37.5 MB. Only the 256-dim scan fits the 50 ms budget alone; embed plus FTS still add about 60 ms in this harness.
- **Pool-lite (scoping option, 12.7):** objc declarations with docs of 40+ characters plus every declaration introduced in macOS 26 or later: 37,293 documents (25.4 percent of the pack), about 6.1 minutes on Metal, containing 276 of the 375 gold documents (73.6 percent; the rest are pre-26 undocumented declarations). Recall inside the lite pool was not measured.
- **Storage:** 37.5 MB as int8 at 256 dims for the full pack (25.6 MB per 100,000 symbols, as in round 2).

## Xcode `DocumentationSearch` spot check (anecdotal)

12 test-half queries (strata A and B, objc), exact text, no filter, run once each by a helper agent through the Xcode MCP tool, 20 results per call: expected symbol at rank 1 for 0 of 12, in the top 3 for 0, in the top 10 for 1 (a near-match). The tool searches prose documentation pages and was not built for symbol lookup by intent; it is not an apples-to-apples baseline, and 12 queries only support "not obviously better".

## Deviations, errors and amendments

- **A1** (before any arm ran): dense text includes owner, framework and signature, as the lexical index does (the round 1 and 2 `docText` would have embedded only name and doc).
- **A2:** the checker accepted 83 of 177 first-batch queries (generic words such as "message" and "component" in the name pieces), below the 150 minimum; a second batch of 220 targets (60 + 30 + 60 + 30 new, plus the 40 reserve) went to three new authors. The checker was not changed. Final: 285 accepted of 383.
- **A3** (after EmbeddingGemma 2 and Qwen3 were scored): bge-small crashed on texts longer than its 512-token context; it was re-run with 700-character truncation. Its numbers are lower bounds for bge.
- **Harness bug, found after scoring:** `run-round3.mjs` read stratum labels from the first target file only, so the per-stratum block in the result JSON covers 83 of 206 test queries. The tables above are recomputed from the saved top-10 lists by `analyze3.mjs` (stratum from both target files). Overall, I3, determinism, sandbox and portability numbers are unaffected.
- **Primary arm:** the registered primary (R2 plus weight 3) is worse than dense only on V3 (−3.4 pts); dense only was not registered as an arm to promote. A router that sends lexically unanswerable queries to dense only is a hypothesis for the next round, not a finding.
- The 12-query Xcode check ran after scoring and did not influence any arm.
- Result files were slimmed (the dense top-50 lists were removed after the equality checks were computed into `results/r3-checks-summary.json`).

## Limitations

- **Lexical baseline near zero by construction:** the checker forbids queries that share name pieces with the target, so `F` and `F2` score about 0 on V3. The "lift" is therefore close to the absolute dense recall, not a lift over a competitive baseline. Real agent queries sit between the vocabulary-gap set and the identifier set.
- **Strict single-id gold:** siblings and overloads count as misses; 13 percent of queries have a same-owner declaration in the dense top 10, so recall@10 understates usefulness for browsing.
- **Pool size and prose effects not isolated:** the drop from round 2 (0.600) to round 3 (0.214) mixes pool size (15×), real near-duplicates, prose-less Swift declarations and a stricter checker. Their individual shares were not measured.
- All queries AI-written by one model family; no human-written sample yet. The extraction is heuristic; macOS only; Windows, Node 24, CUDA and other CPUs untested; the product's own SDK pack will differ.

## Recommended next steps (not started)

1. Register a router that sends lexically unanswerable queries to dense only; re-score on the frozen sets in a new round (cheap, no re-embedding).
2. Test whether the Swift `.swiftdoc` files or Apple's documentation corpus can supply prose for the Swift part (stratum C is the weak spot).
3. Test a reranker over the top 50 (round 1 measured one on a small pack) now that dense recall@50 is 0.34 and recall@10 is 0.21.
4. Decide the pack scoping rule (Pool-lite or per-framework opt-in) and 256-dim int8 storage before drafting the ADR and requirement text; the 10-minute budget is only met by scoping.
5. Windows and Node 24 via a throwaway CI job; a small human-written query sample.
