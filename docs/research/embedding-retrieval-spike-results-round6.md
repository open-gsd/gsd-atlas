# Embedding retrieval spike, round 6: single-token trigram fallback (R5) on fresh identifiers, and the lexical-free query path

Date: 2026-10-29. Status: research evidence only. No product code, dependency, ROADMAP or ADR change. Plan section 15 was frozen before any target was drawn (`.planning/spikes/round6/plan-section-15.frozen.md`, sha256 `f1a5ccc1…b483`); sampler, I6 set, harness and scorer hashes are in `.planning/spikes/round6/FREEZE.md` (A1 to A4); results in `.planning/spikes/round6/results/r6-score.json`. Mac (Metal) only.

## Short answer

R5 is confirmed as a fragment fix and not confirmed as a whole by the registered rule. On 240 fresh identifier queries R5 beats R3 by 3.3 points (p5 +1.3), and by 22.5 points on identifier fragments (0.650 to 0.875, p5 +12.5), with no loss on misspellings. The registered S4 condition fails, though: one qualified-name query out of 40 (`USDKit.arrayCount`) is lost (−2.5 points), more than the 1-point allowance. By the decision rule that records R5 as a fragment-only fallback with the harm stated. The lexical-free path (map for exact names, int8 256-dimension dense lane, trigram search only for single tokens) matches or exceeds R5 on identifiers. Its latency could not be certified: the machine never became quiet, so S8 has no valid pass. Under load of 3 to 6 the non-trigger path measured p95 39.5 to 44.8 ms, inside the 50 ms budget but not under the registered protocol.

## Results (recall@10)

| Set (n) | F | F2 | D | R3 | R5 | R5-nolex |
|---|---|---|---|---|---|---|
| **I6 (240, fresh)** | 0.829 | 0.671 | 0.917 | 0.921 | 0.954 | 0.967 |
| I5 test (88) | 0.852 | 0.659 | 0.864 | 0.864 | 0.943 | 0.955 |
| M5 test (125) | 0.832 | 0.800 | 0.920 | 0.920 | 0.920 | 0.920 |
| M4 test (63) | 0.889 | 0.810 | 0.921 | 0.921 | 0.921 | 0.873 |
| V3 test (206) | 0.005 | 0.005 | 0.214 | 0.214 | 0.214 | 0.209 |
| I3 test (61) | 0.803 | 0.656 | 0.836 | 0.902 | 0.967 | n/a |

I6 by rule (n 40 each): exact R3/R5 1.0; qualified R3 1.0, R5 0.975; lowercase-joined 1.0/1.0; module member 0.950/0.950; **fragment R3 0.650, R5 0.875, F 0.975, D 0.675**; misspelled R3/R5 0.925 (F 0.025). The fallback fires for 78 of the 240 I6 queries, 30 of the I5 test queries, 24 of I3, and for none in M4, M5 or V3.

## Conditions

| # | Condition | Result |
|---|---|---|
| S1 | I6 R5 − R3 ≥ +3, p5 > 0 | **Met**: +3.3 (p5 +1.3) |
| S2 | Fragment R5 − R3 ≥ +20, p5 > 0 | **Met**: +22.5 (p5 +12.5) |
| S3 | Misspelled R5 − R3 ≥ −5 | **Met**: 0.0 |
| S4 | Exact, qualified, lowercase-joined, module member within 1 pt | **Not met**: qualified −2.5 (one query, p5 −7.5); the other three 0.0 |
| S5 | Replay M5, M4, V3 within 0.5; none loses more than 1 | **Met**: 0.0, 0.0, 0.0; I5 +8.0, I3 +6.6 |
| S6 | I5 test + I6 pooled (328) R5 − R3 ≥ +3, p5 > 0 | **Met**: +4.6 (p5 +2.7) |
| S7 | R5-nolex within 1.5 of R5 on I6, I5, M5, V3 | **Met**: +1.3, +1.1, 0.0, −0.5 |
| S8 | Non-trigger p95 ≤ 50 ms in three quiet passes | **Not evaluable**: no pass had load below 1.5 (see below) |
| S9 | Trigger-path p95 and trigger rate (info) | Trigram search adds 0.7 to 3.2 ms; trigger rate 14.5% of the latency mix |

The decision rules give: S1, S2, S3 and S5 met, S4 not met, so R5 is recorded as a **fragment-only fallback with a stated harm**, not as confirmed. The harm is one lost query: `USDKit.arrayCount`. There the lexical top hit is `_arrayCount`, a different declaration, so the exact-name shortcut does not fire and the trigram lane pulls the near-name above the target; dense alone found it. Exploratory arms with triggers of 4 and 6 characters are identical to R5 on I6.

## Latency (informational: protocol not met)

Plan 15.5 required load average (1 min) below 1.5. The host never reached that: an iOS simulator runtime and other sessions kept it between 3 and 12 for the whole window. The harness waited 20 minutes before each of two runs, then proceeded with loads 3.0 to 6.0 (run 1) and 4.6 to 12.3 (run 2); all six passes are discarded under the protocol, and the third and fourth runs were stopped. Per-pass p95 for the non-trigger path (embed + int8 256 scan + map lookup), in order: 39.8, 40.9, 43.9, 41.0 (load 3.0 to 6.0), then 44.7 (load 4.6) and 82.2 (load 12.3). Components at load 3 to 6: embed p50 about 9.7 ms (p95 18 to 21), int8 scan p50 21 ms (p95 23 to 24), map lookup negligible, trigram search p95 2 to 3 ms. Trigger-path p95 36 to 49 ms.

Reading: the lexical-free path is plausibly about 40 to 45 ms p95 under moderate load, 15 to 20 ms below round 5's 61.7 ms (which included the stemmed word search), but the registered claim needs a quiet-machine rerun. Nothing here is evidence that S8 is met.

## Deviations and caveats

- I6 rule construction changed from I3/I5: the rule advances every two picks, so each rule has 20 Objective-C and 20 Swift targets (the earlier construction tied three rules to Objective-C and three to Swift). The pooled S6 therefore mixes two constructions.
- R5 and R3 on I3/I5 are re-scored from saved round 5 lists; the I6 lists were built with the same code.
- S4 failed on a single query of 40. With n 40 per stratum the condition cannot separate one lost query from noise; the strict rule is applied as registered.
- R5-nolex is slightly better than R5 on identifiers (+1.3, p5 +0.4 on I6) because the map-based exact lookup returns the exact-name documents first, whatever the stemmed word ranking; on M4 it falls to 0.873 (int8 256-dimension, 3 queries of 63, as in round 5).
- All queries mechanical (identifiers) or earlier-round sets; single machine, single model.

## What this means for the proposal

- Dense only plus a name map plus a single-token trigram fallback is a coherent lane: no word-level lexical search at query time, one 37.5 MB int8 matrix, trigram index only for identifier-style tokens. On fresh identifiers it reaches 0.967 (against 0.917 dense only and 0.829 trigram only).
- To close S4 cheaply, the fallback could skip queries containing a dot (qualified names), which the map already handles; this is a post hoc suggestion and not tested.
- The 50 ms budget is likely met by this path; certification needs a quiet-machine run (load below 1.5), which this round could not obtain.
- The 24-minute full-pack embed remains the open budget blocker.

## Amendment A5: latency rerun at the observed load (not a registered result)

A quiet machine (load below 1.5) was not available: after an unrelated ffmpeg job ended, system work still held the 1-minute load average at 8 to 14 with the CPU 65 to 75% idle. One run of three passes over 722 queries was taken anyway. Pass-start load was 13.8, 10.8 and 9.4, so by the frozen rule no pass is valid and S8 remains not evaluable.

| Pass | Load at start | Non-trigger p95 (ms) | Trigger path p95 (ms) | Overall p95 (ms) |
|---|---|---|---|---|
| 1 | 13.8 | 48.9 | 40.4 | 48.2 |
| 2 | 10.8 | 46.0 | 41.6 | 44.4 |
| 3 | 9.4 | 43.1 | 38.9 | 42.0 |

Components: embed p50 9.4 to 10.5 ms (p95 20.0 to 25.7), int8 scan p50 about 22 ms (p95 about 24), map lookup under 0.1 ms, trigram search p50 0.8 ms (p95 2.3 to 2.5). The trigger rate is 14.5%. Recall tables are unchanged.

Reading: all three non-trigger p95 values are under 50 ms, and the median is 46.0 ms, even though the host was busy. Load can only inflate these figures, so the lexical-free path very likely fits the budget on a quiet machine, but that is an inference and not a certified result. The first pass (48.9 ms) is close to the limit. Certification still needs three passes at load below 1.5.

## Amendment A6: second latency run on a working machine (by user decision, not a registered result)

The user decided not to wait for load below 1.0, since a machine in ordinary use does not reach it. A second run of three passes over 722 queries was taken at a 1-minute load of 4.1 to 4.5 with the CPU mostly idle. By the frozen rule these passes are not valid, so S8 stays formally not evaluable.

| Pass | Load at start | Non-trigger p95 (ms) | Trigger path p95 (ms) | Overall p95 (ms) |
|---|---|---|---|---|
| 1 | 4.38 | 39.3 | 40.6 | 39.4 |
| 2 | 4.51 | 37.4 | 39.0 | 37.7 |
| 3 | 4.49 | 36.9 | 36.7 | 36.9 |

Components: embed p95 14.7 to 16.9 ms, int8 scan p95 about 22.5 ms, trigram search p95 2.3 to 2.5 ms. The trigger rate is 14.5%.

Reading: at roughly half the load of the A5 run, the non-trigger p95 is 37 to 39 ms, a margin of 11 to 13 ms under the 50 ms budget, and the trend across all runs is that p95 falls as load falls. This is the best available estimate of the lexical-free path on a machine in ordinary use (about 37 to 39 ms p95, M-series Mac, EmbeddingGemma 2 Q8_0 on Metal). It is not a certified result under the protocol.
