# Round 6 freeze record (2026-10-29)

Recorded before any round 6 target is drawn and before any round 6 arm is scored. Nothing has been run against the retrieval stack in this round.

| Item | sha256 |
|---|---|
| plan-section-15.frozen.md | f1a5ccc1c3420a8c83dbea810b18d06020c77ef3595124e02982ddb20141b483 |
| round5 gold-i5.json (excluded from I6, replay set) | 738b69e1c964f33208b22c5a5307c67f85bccb9baf1026eb4c8a563072e8691d |
| round5 gold-m5.json (replay set) | 12cf5bcb7527b2e60f5a62e12df388a3984ce73cc30be2849c7977b3de5dfa4c |
| round5 results/r5-score.json (R5 vs R3 baseline) | see round5/results |

Next steps (not started): write and hash sample-i6.mjs (seed 61, I5 rule definitions, exclude all earlier targets) and a dry run of eligibility; draw I6 and record its hash; write and hash lists6.mjs, score6.mjs and latency6.mjs as amendments; then run.

## Amendments
(none yet)

### A1 (2026-10-29, before the I6 draw): sampler written
sample-i6.mjs sha256 72397344b1c0f4880084eb0d4ec2973ea7a9571fc0f8a1e09a8202b71b264050. One departure from the I3/I5 construction: the rule advances every two picks while the part (objc, swift) alternates, so each rule gets 20 objc and 20 swift targets. The earlier construction tied three rules (exact, fragment, misspelled) to objc and three to swift. Query rules, seed 61 and exclusions (V3, I3, M4, M5, I5 targets) are as in plan 15.3. Pooling with I5 (S6) therefore mixes two constructions; reported as such.

### A2 (2026-10-29, after the I6 draw, before any arm was scored)
queries/gold-i6.json sha256 e81ad62f4add57c0b1397acc552d84da9c29f2c397adf5c305727793be6637ba (240 queries, 40 per rule; 922 ids excluded; eligible 33,152: objc 21,789, swift 11,363). Harness hashed before use: lists6.mjs e1fadb689bcb1bcb3fbf9c555bb5d4c1e1ce64edb3b33c1081e4fe6eb03ff05d (I6 lists only; replay sets reuse the round 5 lists, which the same code produced), latency6.mjs 1636e5136467e88d658ae0520622c6591b8737e8ba3284f3aee9787a4a8e93fd. score6.mjs is hashed in A3 before it is run. Trigger definition for R5 and R5-nolex: no exact-name hit, query has no whitespace and at least 5 characters. R5-nolex exact hit list: matching ids by name, owner.name or module.name map (id order), then the dense list, 50 deep. The host had a load average of 15 at the start (an iOS simulator runtime was booting); latency passes run only when load1 < 1.5 per plan 15.5.

### A3 (2026-10-29, before any arm was scored)
score6.mjs sha256 68daa1b0fc4940896f52182cb220d3fbfecfa649964f924dfd25df3a9e899dc2. I6 lists built (embeddinggemma-2-Q8_0, same command as round 5). Latency passes are taken from latency6.mjs runs whose recorded load1 at pass start is below 1.5; passes above are discarded and reported, and the run is repeated (up to four runs) until three valid passes exist.

### A4 (2026-10-29, results)
Scored with score6.mjs (unchanged, hash in A3). Latency: six passes recorded, none with load1 below 1.5 (host load 3 to 12 throughout); runs 3 and 4 were stopped, so S8 is reported as not evaluable and the loaded-machine figures as informational. S4 failed on one query (USDKit.arrayCount). Results: results/r6-score.json; note: docs/research/embedding-retrieval-spike-results-round6.md.
