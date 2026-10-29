# Round 5 freeze record (2026-10-29)

Recorded before any round 5 query is written and before any round 5 arm is scored. Nothing has been run against the retrieval stack in this round.

| Item | sha256 |
|---|---|
| plan-section-14.frozen.md | 25d47249160b0757d488ac87b0de58258dd1682d3ff6b6f1a76e296231048c78 |
| sample-m5.mjs | 47f7b267cc8adcd0cb3be6684c8f662233b510210b74cebc5bf47424f2388ba5 |
| round4/check-m4.mjs (checker for M5, unchanged) | d8c612e3d0045c7b98d0327bc7b4f86a4f74c5637241a0da55eea569cd2c1329 |
| round4 gold-m4.json (replication set) | 94e801f87a4ec94506a9d6dd6815d3e98904fb8cac3ad21c794f2ec44cd6c38b |
| round3 gold-v3.json (replication set) | 1d72a3a0efd2729291a7e4cbc58ae8abb1df4497939fb8c6867c23d268f936c9 |
| round3 gold-i3.json (replication set) | 608b02f7ae39c451030b58d869ff64478dfe6427dd868a807a6797a6f467c179 |

Sampler dry run (output kept outside the repo, a deterministic draw by seed; it only confirms that eligibility suffices and involves no retrieval): eligible A 10,178, B 24, C 1,245, D 7,948; main 160 (A 60, B 12, C 60, D 28), reserve 24 (A 8, B 4, C 8, D 4), 46 targets per author; I5 eligible 33,272, 120 queries, 20 per rule. Hashes of that draw, to be matched by the real draw: m5-targets.json 8d3df41b6a3577c864293faf709633903b672a0f68c02b45874b5042066a8780, gold-i5.json 738b69e1c964f33208b22c5a5307c67f85bccb9baf1026eb4c8a563072e8691d.

Next steps (not started): run the sampler into the scratchpad, copy the targets into `queries/`, brief four fresh authors with the task contexts written in the target files, check with `check-m4.mjs`, freeze M5 and I5 hashes here, write and hash `lists5.mjs` and `score5.mjs` as amendments, then run.

## M5 and I5 frozen (2026-10-29, before any arm was scored on them)
Targets drawn by the frozen sampler (hashes match the dry run): queries/m5-targets.json 8d3df41b…8780, queries/gold-i5.json 738b69e1…691d (120 queries, 20 per rule). Four fresh AI authors (two on the small tier, two on the mid tier), 46 targets each, task contexts as in plan 14.3. `round4/check-m4.mjs` (unchanged) accepted 171 of 184 submitted, rejected 13 (dropped, not repaired). Plan 14.3 required at least 120. Strata of the accepted set: A 63, B 16, C 60, D 32; test half 125 queries.

| Set | n | sha256 |
|---|---|---|
| queries/gold-m5.json | 171 | 12cf5bcb7527b2e60f5a62e12df388a3984ce73cc30be2849c7977b3de5dfa4c |
| queries/gold-i5.json | 120 | 738b69e1c964f33208b22c5a5307c67f85bccb9baf1026eb4c8a563072e8691d |

Harness written and hashed before the first arm was scored: lists5.mjs dab68913fe31d96e5ce957c7bda0f869c33f14c5ac07ea1fe06e7b09d59efa6e, score5.mjs 36b70675d1b1a919fd8fecf3fe4a131049132d426c1a4d15e6cb01ce7216ffb4, rerank5.mjs 6adaac12016f022071a744209d84e860b2f1927734f34fcef902f263aac76dff. Raw author files and target files are in queries/.

## Amendments
(none yet)
