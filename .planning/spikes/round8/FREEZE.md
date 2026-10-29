# Round 8 freeze record (2026-10-29)

Recorded before any round 8 target is drawn and before any arm is scored. Nothing has been run in this round.

| Item | sha256 |
|---|---|
| plan-section-17.frozen.md | c0efb70ce59ddb150d9e5f87e00f06332e47d56a2a8a225f39ce7caecd1f0951 |

## Amendments
### A1 (2026-10-29, before any arm is scored)
sample-i8.mjs sha256 443647170c45663c8248a8a35fe021cad17b965f5371fbbdc9f005ef3ddca0dd (copy of round6/sample-i6.mjs: seed 81 instead of 61, I6 gold ids added to the exclusion list, output gold-i8.json). I8 drawn; queries/gold-i8.json sha256 b3f6180e3ae903ea697536cf49cd9fb46128819af2d8865c0a814149f0304c61 (240 queries, 40 per rule). The draw excludes every target of V3, I3, M4, M5, I5 and I6.

### A2 (2026-10-29, before any arm is scored)
Harness written and hashed: lists8.mjs a1ca91aaa86b4031d45d01d8a3cbc6c81fcca799c57919fc51070b705540c45f (round6/lists6.mjs with I8 and gold-i8.json), latency8.mjs 07d99a6ede150fa19635a56c308f29b596599185f59b859119c22ea9dd2e3496 (round6/latency6.mjs with the R6 trigger, which adds "query has no dot", the round 6 I6 and the round 8 I8 added to the query mix, and CPU idle recorded at pass start and end), score8.mjs 54c5152d5ed6e6da5c3819244e7eacc12ab954dfc8e28a4ed57e1a13c166a4ec. Stated choices: (1) the latency file contains the 722-query round 6 mix plus the 240 I8 queries so that R6-nolex lists exist for I8; L1 statistics use the 722-query mix only (I8 rows are excluded from timing). (2) T5 follows plan 17.4 on M5, M4 and V3 (within 0.5 pt) and reports I5, I3 and I6 as seen sets; the all-sets no-loss check is applied to the same six sets. (3) L1 includes a pass only if its start load1 is at most 6.0 and CPU idle at least 60%; one re-run is allowed per excluded pass.
