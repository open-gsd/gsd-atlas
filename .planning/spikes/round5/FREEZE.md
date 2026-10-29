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

## Amendments
(none yet)
