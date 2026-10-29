# Round 4 freeze record (2026-10-29)

Recorded before any round 4 arm is scored and before any M4 query is written.

| Item | sha256 |
|---|---|
| plan-section-13.frozen.md | e51b94cab5e5d740036baae875974a0358837b0af94aae7ece0db812f1d00f49 |
| sample-m4.mjs | 4634c43dcee516ddf263f7adb384dead0490bd79df9d054e0649a98c27134204 |
| check-m4.mjs | d8c612e3d0045c7b98d0327bc7b4f86a4f74c5637241a0da55eea569cd2c1329 |
| queries/m4-targets.json (seed 47, reserve seed 48; eligible A 10,214, B 42, C 1,281, D 7,966; main 90, reserve 18, 36 targets per author) | 07ff8e27a4f2e1000bdde3ee59996ef8ad55a209d2911175c3bfcac60870a2e9 |
| round3 gold-v3.json (V3, 285) | 1d72a3a0efd2729291a7e4cbc58ae8abb1df4497939fb8c6867c23d268f936c9 |
| round3 gold-i3.json (I3, 90) | 608b02f7ae39c451030b58d869ff64478dfe6427dd868a807a6797a6f467c179 |
| sdk docs.json (146,554 declarations) | c47083b3afa8547dc5c7cbaa979189c580e74267d80fa3160326f0fea617cb23 |
| EmbeddingGemma 2 document vectors (round 3, base pool) | b250d376a25f6f9046aefcb1704167b54990f67e50055b58d9f7f6d2fc39e19d |

Feasibility probe before the freeze (no query set or arm involved): `swift-symbolgraph-extract` on Foundation returned 13,342 symbols, 5,079 with doc comments, so Part D is possible. The 169 Swift modules of the pack were queued for extraction right after the freeze; extraction output does not depend on any query.

## Amendments
(none yet)

## M4 frozen (2026-10-29, before any arm was scored on it)
Three fresh AI authors (one on the small model tier, two on the mid tier, so not one model family), 36 targets each (30 main + 6 reserve each, all authored). Checker `check-m4.mjs` accepted 99 of 108, rejected 9 (dropped, not repaired): 4 for no name/owner/framework piece, 4 for containing the full name, 1 for an unknown id typed by the author. Plan 13.3 asked for at least 60 accepted. Raw author files and target files are in `queries/`.

| Set | n | sha256 |
|---|---|---|
| queries/gold-m4.json (A 34, B 18, C 34, D 13) | 99 | 94e801f87a4ec94506a9d6dd6815d3e98904fb8cac3ad21c794f2ec44cd6c38b |

lists4.mjs sha256 at freeze: e7d4ccd5e0eb30b401058f86ef1720c08939ba39e6bd7c0458da02f23f13996a.

Swift enrichment (Part D input, built from symbol graphs before any arm was scored): `enrich-swift.mjs` over 169 modules, 380 graphs, 113,488 symbols; 25,698 of 67,651 Swift records without prose gained a doc comment (38.0 percent). Enriched docs.json sha256 d8466fbe337b6b7d01af05d6148b9cf1a5e15d9d1373661d19973d1857a4e90d; enrich-swift.mjs sha256 62fe46166eb4286180dd59986ab5b48fe6aca2b47338805b54f0053d8ad5d572.
