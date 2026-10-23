# Priced cost and baseline-cost regression: two supplementary analyses on existing data

Status: unregistered, descriptive, 2026-10-22. No new sessions, no network, no authentication. It reads, without editing, `docs/eval/memory-tools-evidence-2026-10.md`, `gate-redefinition-proposal.md`, `angular-pilot/v2/pilot-results.md`, `pilot-audit.md` and `analysis.md`, and the logs `angular-pilot/v2/pilot/pilot-sessions.jsonl`, `results/results.jsonl` and `results-cleanroom/results.jsonl`. The registered verdict `OVERALL: MVP not met` stands. N3 in the proposal applies to future data; every "would have been met" below is a description of past data, not a gate result.

## Summary

- Analysis A. Priced cost is the logged `costUsd` of every session (present on all 996 rows; no fallback weighting was needed). A/G priced cost ratio, paired by question, 90% interval: Angular pilot A-reg 1.510 (1.238 to 1.794), A-ts 1.104 (0.985 to 1.223); registered run 1.186 (1.137 to 1.236); clean-room replication 1.293 (1.205 to 1.391). Descriptively, an upper limit of at most 1.5 would NOT have been met by the pilot's A-reg, and WOULD have been met by A-ts, the registered run and the replication.
- The logged cost is exactly linear in the four token counts (2, 4, 0.10 and 10 USD per million tokens for input, cache creation, cache read, output; largest residual 1e-15 USD). Cache reads are 74 to 88% of billable tokens but only 6 to 13% of cost; cache creation (64 to 75%) and output (16 to 27%) carry the cost. Weighting cache reads at 1 instead of 0.05 raises the ratios (registered 1.186 to 1.503 with cache creation and output also weighted, 1.612 unweighted).
- Analysis B. Hypothesis: the A/G ratio shrinks as G's work grows. On priced cost it is not supported on any of the four comparisons (Spearman between -0.12 and +0.15, every 90% interval contains 0, log-log slopes within 0.09 of 0, no identified break-even). On billable tokens there is a negative rank correlation in the 75-question sets (-0.38 in both, intervals excluding 0), but it shrinks to -0.21 (registered) and -0.11 (replication) in the split-half check that removes the shared-G noise, and it is absent in the 16-question pilot for A-reg. Where a token break-even exists it is for ratio 1.5 at about 3.4 G calls (registered, 2.66 to 5.20) or 6.25 (replication, 2.99 to 678); the ratio-1.0 crossing is far outside the observed range of 1 to 9 calls.

## Commands (exact)

```
node --test scripts/analysis-supplementary/lib.test.ts scripts/analysis-supplementary/data.test.ts scripts/analysis-supplementary/run.test.ts
node scripts/analysis-supplementary/run.ts > tables.md     # regenerates the Appendix below byte for byte
npm run typecheck
node scripts/eval/verify-prereg.ts                         # verify-prereg: ok
```

Commits: `bec625c` RED (lib and data tests), `8c6efe8` GREEN, `ab6cbb9` RED (presentation rule), `f2b6526` GREEN. The script reads the three logs read-only and writes nothing.

## Method

Data. Pilot: 96 sessions, 16 questions x 3 conditions (G, A-ts, A-reg) x 2 runs. Registered run and clean-room replication: 450 rows each, 75 gsd-core questions x 2 arms x 3 runs; the `atlas` arm is treated as A-reg (tools loaded upfront, as the pilot's A-reg, per the evidence note section 6). The replication is never pooled with the registered run. All rows have status `ok`.

Priced cost. The `costUsd` field recorded by Claude Code in each session record, used as logged. Because the log has only a total per session, the split by token class (cache read, cache creation, input, output) needs per-token prices; they were recovered by least squares of `costUsd` on the four token counts and reproduce the logged cost to 1e-15 USD on every dataset, so the split is exact, not assumed. The prices are those the log implies (2.00, 4.00, 0.10, 10.00 USD per million); I did not check them against a price list. They are note-consistent with "cache reads are 0.05 of input", but the evidence note's "cache creation 1.25x" does not hold in the log (it is 2x), so the note's 1.52 and 1.19 re-weighting and this analysis agree only approximately (pilot A-reg 1.510 versus 1.52; registered 1.186 versus 1.19), because this one uses the logged cost directly.

Ratio and interval. Per question, mean of the metric over that arm's runs; R = mean over questions of A divided by mean over questions of G (the convention of `pilot-results.md`). The 90% interval resamples questions with replacement (each question's A and G means move together, so the pairing is kept), 10,000 draws, seed 20261022, percentile limits at sorted positions 500 and 9,500 of 10,000. The run-to-run variation inside a question is averaged away, not resampled.

Sensitivity. Sessions are re-measured in weighted tokens with input 1, cache creation 2, output 5 (the ratios the log implies) and cache read at 0.05, 0.1 or 1.0. Weight 0.05 reproduces the logged cost. The last column is the plain billable-token ratio of the earlier analyses (every weight 1).

Analysis B. Per question: G's mean tool calls (final structured answer excluded; for the registered and replication rows this subtracts the `StructuredOutput` call from `toolCalls`, the pilot field already excludes it), G's mean priced cost, and A/G ratios on priced cost and on billable tokens. Spearman rank correlation (average ranks for ties) and the OLS slope of ln(ratio) on ln(x) with question-resampled 90% intervals (same seed and draws). Break-even: the x where the fitted line crosses ratio 1.0 or 1.5, defined only when the slope is negative; if the fit falls in fewer than 95% of the 10,000 draws, no interval is printed ("not identified"), because an interval over only the draws that agree would be conditional and misleading. A break-even outside the observed range of x is marked EXTRAPOLATION.

Regression to the mean. G's mean calls sits in x and G's cost or tokens sits in the denominator of the ratio, and the two are positively related by construction. A question where G happened to run long in these runs has a high x and a low ratio for that reason alone, which manufactures a negative association even if the true ratio does not depend on G's work. Check: x is G's tool calls in one run only; the ratio's denominator is G in the other runs; the numerator is A over all its runs. G's noise in x and in the denominator are then independent. Each choice of the x run is reported (two for the pilot, three for the others) together with the mean over choices. Caveat: one run of integer call counts is a noisier x than a mean, which attenuates the correlation toward 0 even if the effect is real, so the check gives a lower bound on the real association, not an unbiased estimate.

## Analysis A: results

Headline (A over G, priced cost, 90% interval; the upper limit is the N3 quantity, R_max = 1.5 for A-reg):

| dataset | arm / G | priced cost ratio | billable-token ratio | upper limit <= 1.5 |
| --- | --- | ---: | ---: | --- |
| Angular v2 pilot (16 questions) | A-reg | 1.510 (1.238 to 1.794) | 2.250 (1.725 to 2.929) | no |
| Angular v2 pilot | A-ts | 1.104 (0.985 to 1.223) | 1.216 (1.064 to 1.373) | yes |
| Registered run (75 questions) | atlas as A-reg | 1.186 (1.137 to 1.236) | 1.612 (1.526 to 1.706) | yes |
| Clean-room replication (75 questions) | atlas as A-reg | 1.293 (1.205 to 1.391) | 1.791 (1.664 to 1.937) | yes |

Mean cost per session in USD: pilot G 0.0715, A-reg 0.1079, A-ts 0.0790; registered grep 0.0328, atlas 0.0389; replication grep 0.0301, atlas 0.0389. The replication's higher ratio comes from its cheaper grep arm, not a dearer atlas arm (atlas mean cost is the same, 0.0389).

Cache-weighting effect, share of the logged cost by token class:

| dataset | arm | cache read | cache creation | input | output |
| --- | --- | ---: | ---: | ---: | ---: |
| pilot | G / A-ts / A-reg | 8.3 / 9.3 / 13.3% | 65.0 / 65.2 / 64.1% | 0.0% | 26.7 / 25.4 / 22.6% |
| registered | grep / atlas | 6.9 / 10.2% | 73.1 / 72.7% | 0.0% | 19.9 / 17.0% |
| replication | grep / atlas | 5.9 / 9.0% | 74.6 / 74.5% | 0.0% | 19.4 / 16.4% |

Cache reads are 74 to 88% of billable tokens (share of tokens: pilot G 81.4%, A-ts 83.1%, A-reg 87.9%; registered 77.4% / 83.7%; replication 74.1% / 81.6%), so a billable-token ratio is mostly a cache-read ratio. Atlas sessions carry more cache reads (they re-read longer context on every turn), which is why the token ratio is the largest of all the measures.

Sensitivity to the cache-read weight (weighted tokens, input 1, cache creation 2, output 5):

| dataset | arm / G | 0.05 (= logged cost) | 0.1 | 1.0 | plain billable tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| pilot | A-reg | 1.510 (1.238 to 1.794) | 1.580 (1.289 to 1.891) | 2.073 (1.617 to 2.638) | 2.250 (1.725 to 2.929) |
| pilot | A-ts | 1.104 (0.985 to 1.223) | 1.115 (0.995 to 1.235) | 1.189 (1.051 to 1.331) | 1.216 (1.064 to 1.373) |
| registered | A-reg | 1.186 (1.137 to 1.236) | 1.222 (1.172 to 1.274) | 1.503 (1.430 to 1.582) | 1.612 (1.526 to 1.706) |
| replication | A-reg | 1.293 (1.205 to 1.391) | 1.331 (1.241 to 1.430) | 1.652 (1.539 to 1.780) | 1.791 (1.664 to 1.937) |

Per category the priced-cost ratio is in the Appendix. Stable features: impact questions have the highest ratio in all three datasets (pilot A-reg 1.72 on 4 questions, registered 1.41 on 6, replication 2.04 on 6); abstain and heritage are near or below 1.2 for A-reg in the pilot and registered run. Pilot cells have 1 to 4 questions, so those intervals are not informative; the 75-question categories have 6 to 17.

### Conclusion A

Supports: on priced cost the atlas arm cost about 1.19x (registered) and 1.29x (replication) the grep arm on gsd-core, and about 1.10x (A-ts) to 1.51x (A-reg) on the Angular pilot; the earlier token ratios (1.61, 1.79, 2.25) overstate cost by weighting a cheap cache read like an expensive output. On the descriptive reading of N3 (upper limit of the A-reg / G priced ratio at most 1.5) the registered run (1.236) and replication (1.391) would have met it and the pilot A-reg (1.794) would not. The result differs by dataset in a way the data cannot explain: the pilot differs in corpus, questions (16, selected by rule), adoption pattern and sample size.

Does not support: that N3 is met or failed (N3 applies to future data, was set after seeing numbers of this size, and the intervals here are from small question sets; the pilot's lower limit 1.238 is also above 1). It does not show the product is cheaper than grep on any dataset: every point estimate is above 1, and only the pilot's A-ts interval (0.985 to 1.223) reaches below 1. It says nothing about accuracy, and a lower cost ratio does not show the extra cost buys more correct answers. Cost here is Claude Code's logged notional cost on a subscription login (`apiKeySource` none), not an invoice.

## Analysis B: results

Setups (n questions; G calls per question, mean over runs, final answer excluded): pilot 16 questions, 2.0 to 12.5 calls (median 3.0); registered 75, 1.0 to 9.0 (median 2.0); replication 75, 1.0 to 7.0 (median 1.67). Spearman and slope are with x = G calls, 90% intervals in brackets. Break-evens: n/i = not identified (the fit falls in fewer than 95% of draws), ext = outside the observed range.

Priced cost ratio:

| setup | Spearman, all runs | slope, all runs | Spearman, split half (mean of x-run choices) | slope, split half (mean) | break-even 1.0 / 1.5 |
| --- | ---: | ---: | ---: | ---: | --- |
| pilot A-reg | 0.148 (-0.259 to 0.491) | 0.085 (-0.189 to 0.346) | 0.208 | 0.125 | n/i |
| pilot A-ts | -0.149 (-0.574 to 0.296) | -0.071 (-0.258 to 0.086) | 0.016 | -0.009 | n/i |
| registered | -0.124 (-0.321 to 0.078) | -0.043 (-0.109 to 0.020) | -0.082 | -0.010 | n/i |
| replication | -0.107 (-0.306 to 0.095) | 0.003 (-0.100 to 0.101) | 0.023 | 0.034 | n/i |

Billable-token ratio:

| setup | Spearman, all runs | slope, all runs | Spearman, split half (mean) | slope, split half (mean) | break-even 1.0 / 1.5 |
| --- | ---: | ---: | ---: | ---: | --- |
| pilot A-reg | -0.043 (-0.425 to 0.335) | -0.126 (-0.480 to 0.176) | 0.095 | 0.051 | n/i |
| pilot A-ts | -0.402 (-0.703 to 0.034) | -0.163 (-0.374 to 0.001) | -0.025 | 0.024 | n/i (fit falls in 9,474 of 10,000 draws) |
| registered | -0.379 (-0.538 to -0.195) | -0.207 (-0.293 to -0.125) | -0.214 | -0.089 | 24.2 (11.3 to 125.1) ext / 3.40 (2.66 to 5.20) |
| replication | -0.383 (-0.553 to -0.191) | -0.118 (-0.244 to -0.008) | -0.106 | -0.023 | 192.7 (16.1 to >1e6) ext / 6.25 (2.99 to 678) |

Split-half detail (priced cost / billable tokens, Spearman): registered x-run 1, 2, 3: -0.105, -0.027, -0.113 / -0.278, -0.176, -0.189; replication: 0.017, -0.044, 0.097 / -0.142, -0.149, -0.026; only registered run 1 has a Spearman interval excluding 0 on tokens (-0.278, -0.462 to -0.081), and its slope interval includes 0; registered run 3 has a slope interval excluding 0 (-0.098, -0.182 to -0.008). All 16-question pilot split-half intervals include 0. Full rows, including x = G priced cost, are in the Appendix.

Fitted ratio (all-runs line) at the minimum, 3 and the maximum G calls, priced cost: pilot A-reg 1.27 / 1.32 / 1.49, A-ts 1.16 / 1.13 / 1.02, registered 1.23 / 1.17 / 1.12, replication 1.25 / 1.25 / 1.25. Billable tokens: pilot A-reg 2.26 / 2.14 / 1.79, A-ts 1.41 / 1.32 / 1.05, registered 1.93 / 1.54 / 1.23, replication 1.86 / 1.64 / 1.48. Scatter data (per question) is at the end of the Appendix. The pilot's largest ratios come from a few questions with expensive atlas sessions (p-304 A-reg 3.10 at 3 G calls; p-306 2.36; p-314 2.06), not from G's work.

### Conclusion B

Supports: on token counts there is a real negative association between G's number of calls and the A/G ratio on gsd-core (Spearman -0.38 in both 75-question sets, intervals excluding 0), and the fitted token ratio falls from about 1.9 at one call to about 1.2 to 1.5 at 7 to 9 calls. Part of it survives the split-half check in the registered run (about -0.21, three of three x-run choices negative) and a smaller part in the replication (about -0.11, with one choice near 0).

Does not support: the hypothesis on priced cost, which is the quantity N3 uses. Correlations are -0.12 to +0.15 with intervals spanning zero in all four comparisons, slopes are essentially flat, and the fitted priced ratio only moves from about 1.23 to 1.12 across the registered range. It does not support any break-even: for priced cost none is identified, and for tokens the ratio-1.0 crossing is an extrapolation (24 calls registered, 193 replication, against a maximum of 9 and 7 observed). It does not support the claim that a more expensive baseline (6 to 43 calls, as in the vendor harnesses) would bring the cost ratio under 1: the observed baselines are all 1 to 12.5 calls and the data say nothing about the region beyond them. The hypothesis stays untested for large baselines; it is weakly consistent with the token ratio and not with the priced ratio inside the observed range. The weakening under the split-half check says part of the token association is shared G noise, though the check itself attenuates, so the true size lies between the two estimates.

## Limits

- Different corpora, harness variants and rules: the pilot (Angular, 16 questions, conditions A-ts and A-reg, Claude Code 2.1.305) and the gsd-core runs (2.1.302, 75 questions) are not comparable beyond direction; the registered run and the replication use the same questions and are not independent of each other.
- The unit of resampling is the question; run-to-run noise inside a question, session-level heavy tails (one atlas session can cost 10x) and a clustering by category are not modelled. Small categories (1 to 4 questions) give degenerate or unstable intervals.
- Costs are the logged notional cost. I fitted prices from the log; I did not verify them against a price list, and the cache-creation weight in the log (2x input) differs from the evidence note's assumption (1.25x). The sensitivity table keeps the log's creation and output weights and varies only the cache read weight.
- The `atlas` = A-reg mapping for the gsd-core runs follows the evidence note's reading that the registered harness loaded atlas tools upfront; I did not re-verify it from the init records.
- Tool calls are a crude proxy for "work": they exclude the size of results read, and the pilot and gsd-core counts come from different harness fields (the pilot field already excludes the final structured answer; for the gsd-core rows it is subtracted). G calls take few integer values (many questions at 1), so Spearman has heavy ties and the log-log fit is driven by a few high-call questions.
- Many comparisons (four setups, two ratio measures, two x variables, split halves) with no multiplicity correction; treat isolated intervals as exploratory.
- The break-even intervals are percentile intervals over draws in which the fitted slope was negative; where fewer than 95% of draws qualify they are suppressed. The log-log form is an assumption chosen in advance, not fitted among alternatives.
- The split-half check is not an unbiased fix. It removes the shared-noise artefact but uses a single run for x, which is noisier, so it biases the correlation toward 0.
- Nothing here measures correctness; the pilot's A-reg also had the highest exact-set rate (84.4% against 71.9%) and that is not part of N3 as written.
- Not a registered analysis: no part of this was written into `preregistration.md`; `analysis.md` and the result files were not edited, and the existing pilot token numbers (2.250 and 1.216) are reproduced here exactly as a cross-check.

## Appendix: full generated output

Everything below is the unedited output of `node scripts/analysis-supplementary/run.ts`.

## Tables for analysis A (priced cost)

### Angular v2 pilot

Questions: 16; sessions: 96. Logged cost reproduced from tokens at per million tokens input 2.00, cache creation 4.00, cache read 0.10, output 10.00 USD (largest residual 2.8e-16 USD).

Mean per session, and the share of the logged cost by token class (fitted prices; the shares sum to the logged cost):

| arm | sessions | mean cost | mean billable tokens | cache read | cache creation | input | output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G (grep) | 32 | $0.0715 | 72,662 | 8.3% | 65.0% | 0.0% | 26.7% |
| A-reg | 32 | $0.1079 | 163,493 | 13.3% | 64.1% | 0.0% | 22.6% |
| A-ts | 32 | $0.0790 | 88,343 | 9.3% | 65.2% | 0.0% | 25.4% |

Share of billable TOKENS (the unweighted measure of the earlier analyses) in cache reads: G 81.4%, A-reg 87.9%, A-ts 83.1%.

Mean priced cost ratio, arm over G, paired by question (per-question mean over runs, questions resampled, 10,000 draws, seed 20261022, 90% percentile interval), with the billable-token ratio for comparison:

| arm / G | priced cost ratio (90% interval) | billable-token ratio (90% interval) | upper limit <= 1.5? |
| --- | ---: | ---: | ---: |
| A-reg | 1.510 (1.238 to 1.794) | 2.250 (1.725 to 2.929) | no |
| A-ts | 1.104 (0.985 to 1.223) | 1.216 (1.064 to 1.373) | yes |

Per category, priced cost ratio (descriptive; the interval resamples the few questions of the category and is wide):

| category | questions | A-reg / G (90% interval) | A-ts / G (90% interval) |
| --- | ---: | ---: | ---: |
| abstain | 1 | 0.932 (0.932 to 0.932) | 0.811 (0.811 to 0.811) |
| callers | 4 | 1.498 (0.967 to 2.384) | 1.088 (0.936 to 1.309) |
| definition | 1 | 1.226 (1.226 to 1.226) | 1.251 (1.251 to 1.251) |
| heritage | 2 | 0.835 (0.660 to 1.183) | 1.399 (1.288 to 1.454) |
| impact | 4 | 1.722 (1.423 to 1.960) | 1.215 (1.023 to 1.345) |
| references | 4 | 1.513 (1.123 to 2.155) | 0.998 (0.778 to 1.243) |

Sensitivity: the ratio when sessions are measured in weighted tokens (input 1, cache creation 2, output 5; these are the price ratios the log implies) with different cache-read weights. Weight 0.05 is the logged cost itself; weight 1.0 is the billable-token ratio except that cache creation and output are also weighted:

| arm / G | cache-read weight 0.05 | weight 0.1 | weight 1.0 | logged cost | billable tokens (all weights 1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| A-reg | 1.510 (1.238 to 1.794) | 1.580 (1.289 to 1.891) | 2.073 (1.617 to 2.638) | 1.510 (1.238 to 1.794) | 2.250 (1.725 to 2.929) |
| A-ts | 1.104 (0.985 to 1.223) | 1.115 (0.995 to 1.235) | 1.189 (1.051 to 1.331) | 1.104 (0.985 to 1.223) | 1.216 (1.064 to 1.373) |

### Registered run (gsd-core)

Questions: 75; sessions: 450. Logged cost reproduced from tokens at per million tokens input 2.00, cache creation 4.00, cache read 0.10, output 10.00 USD (largest residual 6.4e-16 USD).

Mean per session, and the share of the logged cost by token class (fitted prices; the shares sum to the logged cost):

| arm | sessions | mean cost | mean billable tokens | cache read | cache creation | input | output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G (grep) | 225 | $0.0328 | 29,393 | 6.9% | 73.1% | 0.0% | 19.9% |
| A-reg | 225 | $0.0389 | 47,375 | 10.2% | 72.7% | 0.0% | 17.0% |

Share of billable TOKENS (the unweighted measure of the earlier analyses) in cache reads: G 77.4%, A-reg 83.7%.

Mean priced cost ratio, arm over G, paired by question (per-question mean over runs, questions resampled, 10,000 draws, seed 20261022, 90% percentile interval), with the billable-token ratio for comparison:

| arm / G | priced cost ratio (90% interval) | billable-token ratio (90% interval) | upper limit <= 1.5? |
| --- | ---: | ---: | ---: |
| A-reg | 1.186 (1.137 to 1.236) | 1.612 (1.526 to 1.706) | yes |

Per category, priced cost ratio (descriptive; the interval resamples the few questions of the category and is wide):

| category | questions | A-reg / G (90% interval) |
| --- | ---: | ---: |
| abstain | 9 | 1.054 (0.955 to 1.151) |
| adr | 10 | 1.128 (1.032 to 1.226) |
| callers | 17 | 1.102 (1.016 to 1.202) |
| definition | 7 | 1.166 (1.137 to 1.192) |
| emit | 10 | 1.250 (1.142 to 1.375) |
| heritage | 8 | 1.239 (1.160 to 1.323) |
| impact | 6 | 1.412 (1.284 to 1.591) |
| references | 8 | 1.200 (1.085 to 1.325) |

Sensitivity: the ratio when sessions are measured in weighted tokens (input 1, cache creation 2, output 5; these are the price ratios the log implies) with different cache-read weights. Weight 0.05 is the logged cost itself; weight 1.0 is the billable-token ratio except that cache creation and output are also weighted:

| arm / G | cache-read weight 0.05 | weight 0.1 | weight 1.0 | logged cost | billable tokens (all weights 1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| A-reg | 1.186 (1.137 to 1.236) | 1.222 (1.172 to 1.274) | 1.503 (1.430 to 1.582) | 1.186 (1.137 to 1.236) | 1.612 (1.526 to 1.706) |

### Clean-room replication (gsd-core)

Questions: 75; sessions: 450. Logged cost reproduced from tokens at per million tokens input 2.00, cache creation 4.00, cache read 0.10, output 10.00 USD (largest residual 1.1e-15 USD).

Mean per session, and the share of the logged cost by token class (fitted prices; the shares sum to the logged cost):

| arm | sessions | mean cost | mean billable tokens | cache read | cache creation | input | output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G (grep) | 225 | $0.0301 | 23,952 | 5.9% | 74.6% | 0.0% | 19.4% |
| A-reg | 225 | $0.0389 | 42,906 | 9.0% | 74.5% | 0.0% | 16.4% |

Share of billable TOKENS (the unweighted measure of the earlier analyses) in cache reads: G 74.1%, A-reg 81.6%.

Mean priced cost ratio, arm over G, paired by question (per-question mean over runs, questions resampled, 10,000 draws, seed 20261022, 90% percentile interval), with the billable-token ratio for comparison:

| arm / G | priced cost ratio (90% interval) | billable-token ratio (90% interval) | upper limit <= 1.5? |
| --- | ---: | ---: | ---: |
| A-reg | 1.293 (1.205 to 1.391) | 1.791 (1.664 to 1.937) | yes |

Per category, priced cost ratio (descriptive; the interval resamples the few questions of the category and is wide):

| category | questions | A-reg / G (90% interval) |
| --- | ---: | ---: |
| abstain | 9 | 1.193 (1.050 to 1.339) |
| adr | 10 | 1.178 (1.082 to 1.293) |
| callers | 17 | 1.180 (1.101 to 1.261) |
| definition | 7 | 1.203 (1.123 to 1.265) |
| emit | 10 | 1.199 (1.077 to 1.318) |
| heritage | 8 | 1.242 (1.211 to 1.288) |
| impact | 6 | 2.043 (1.704 to 2.401) |
| references | 8 | 1.142 (0.914 to 1.420) |

Sensitivity: the ratio when sessions are measured in weighted tokens (input 1, cache creation 2, output 5; these are the price ratios the log implies) with different cache-read weights. Weight 0.05 is the logged cost itself; weight 1.0 is the billable-token ratio except that cache creation and output are also weighted:

| arm / G | cache-read weight 0.05 | weight 0.1 | weight 1.0 | logged cost | billable tokens (all weights 1) |
| --- | ---: | ---: | ---: | ---: | ---: |
| A-reg | 1.293 (1.205 to 1.391) | 1.331 (1.241 to 1.430) | 1.652 (1.539 to 1.780) | 1.293 (1.205 to 1.391) | 1.791 (1.664 to 1.937) |

## Tables for analysis B (baseline-cost regression)

### Angular pilot, A-reg versus G

16 questions. G tool calls per question (mean over runs, final answer excluded): min 2.00, median 3.00, max 12.50.

All runs (x = G mean over runs; ratio = A mean over G mean). This version has G in both x and the denominator, so it is exposed to regression to the mean:

| x | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| G calls | priced cost | 16 | 0.148 (-0.259 to 0.491) | 0.085 (-0.189 to 0.346) | not identified (fit falls in only 2824 of 10000 draws) | not identified (fit falls in only 2835 of 10000 draws) |
| G calls | billable tokens | 16 | -0.043 (-0.425 to 0.335) | -0.126 (-0.480 to 0.176) | not identified (fit falls in only 7385 of 10000 draws) | not identified (fit falls in only 7392 of 10000 draws) |
| G priced cost (USD) | priced cost | 16 | 0.079 (-0.342 to 0.471) | 0.084 (-0.169 to 0.317) | not identified (fit falls in only 2632 of 10000 draws) | not identified (fit falls in only 2643 of 10000 draws) |
| G priced cost (USD) | billable tokens | 16 | -0.044 (-0.442 to 0.358) | 0.027 (-0.288 to 0.294) | not identified (fit falls in only 4320 of 10000 draws) | not identified (fit falls in only 4341 of 10000 draws) |

Fitted ratio (A over G) against G calls, read off the all-runs log-log line: priced cost 1.27 at 2.00, 1.32 at 3.00, 1.49 at 12.50; billable tokens 2.26 at 2.00, 2.14 at 3.00, 1.79 at 12.50.

Regression-to-the-mean check (split half). x = G tool calls in ONE run; the denominator = G in the OTHER runs; the numerator = A over all its runs. G noise in x and in the denominator are independent. One row per choice of the x run:

| x run | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| run 1 | priced cost | 16 | 0.077 (-0.341 to 0.469) | 0.021 (-0.214 to 0.290) | not identified (fit falls in only 4125 of 10000 draws) | not identified (fit falls in only 4139 of 10000 draws) |
| run 2 | priced cost | 16 | 0.338 (-0.087 to 0.657) | 0.229 (-0.118 to 0.514) | not identified (fit falls in only 1379 of 10000 draws) | not identified (fit falls in only 1382 of 10000 draws) |
| run 1 | billable tokens | 16 | 0.175 (-0.211 to 0.531) | 0.011 (-0.248 to 0.273) | not identified (fit falls in only 4481 of 10000 draws) | not identified (fit falls in only 4494 of 10000 draws) |
| run 2 | billable tokens | 16 | 0.016 (-0.374 to 0.403) | 0.091 (-0.424 to 0.537) | not identified (fit falls in only 4239 of 10000 draws) | not identified (fit falls in only 4244 of 10000 draws) |

Mean over the x-run choices: priced cost Spearman 0.208, slope 0.125; billable tokens Spearman 0.095, slope 0.051.

### Angular pilot, A-ts versus G

16 questions. G tool calls per question (mean over runs, final answer excluded): min 2.00, median 3.00, max 12.50.

All runs (x = G mean over runs; ratio = A mean over G mean). This version has G in both x and the denominator, so it is exposed to regression to the mean:

| x | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| G calls | priced cost | 16 | -0.149 (-0.574 to 0.296) | -0.071 (-0.258 to 0.086) | not identified (fit falls in only 7495 of 10000 draws) | not identified (fit falls in only 7499 of 10000 draws) |
| G calls | billable tokens | 16 | -0.402 (-0.703 to 0.034) | -0.163 (-0.374 to 0.001) | not identified (fit falls in only 9474 of 10000 draws) | not identified (fit falls in only 9478 of 10000 draws) |
| G priced cost (USD) | priced cost | 16 | -0.065 (-0.519 to 0.386) | -0.065 (-0.222 to 0.097) | not identified (fit falls in only 7491 of 10000 draws) | not identified (fit falls in only 7495 of 10000 draws) |
| G priced cost (USD) | billable tokens | 16 | -0.247 (-0.619 to 0.208) | -0.106 (-0.254 to 0.058) | not identified (fit falls in only 8650 of 10000 draws) | not identified (fit falls in only 8654 of 10000 draws) |

Fitted ratio (A over G) against G calls, read off the all-runs log-log line: priced cost 1.16 at 2.00, 1.13 at 3.00, 1.02 at 12.50; billable tokens 1.41 at 2.00, 1.32 at 3.00, 1.05 at 12.50.

Regression-to-the-mean check (split half). x = G tool calls in ONE run; the denominator = G in the OTHER runs; the numerator = A over all its runs. G noise in x and in the denominator are independent. One row per choice of the x run:

| x run | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| run 1 | priced cost | 16 | -0.179 (-0.581 to 0.291) | -0.082 (-0.350 to 0.134) | not identified (fit falls in only 7192 of 10000 draws) | not identified (fit falls in only 7198 of 10000 draws) |
| run 2 | priced cost | 16 | 0.211 (-0.304 to 0.653) | 0.064 (-0.136 to 0.194) | not identified (fit falls in only 2494 of 10000 draws) | not identified (fit falls in only 2499 of 10000 draws) |
| run 1 | billable tokens | 16 | -0.018 (-0.439 to 0.380) | 0.008 (-0.212 to 0.166) | not identified (fit falls in only 4622 of 10000 draws) | not identified (fit falls in only 4632 of 10000 draws) |
| run 2 | billable tokens | 16 | -0.031 (-0.487 to 0.454) | 0.040 (-0.283 to 0.288) | not identified (fit falls in only 4335 of 10000 draws) | not identified (fit falls in only 4340 of 10000 draws) |

Mean over the x-run choices: priced cost Spearman 0.016, slope -0.009; billable tokens Spearman -0.025, slope 0.024.

### Registered run, atlas (as A-reg) versus grep

75 questions. G tool calls per question (mean over runs, final answer excluded): min 1.00, median 2.00, max 9.00.

All runs (x = G mean over runs; ratio = A mean over G mean). This version has G in both x and the denominator, so it is exposed to regression to the mean:

| x | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| G calls | priced cost | 75 | -0.124 (-0.321 to 0.078) | -0.043 (-0.109 to 0.020) | not identified (fit falls in only 8623 of 10000 draws) | not identified (fit falls in only 8642 of 10000 draws) |
| G calls | billable tokens | 75 | -0.379 (-0.538 to -0.195) | -0.207 (-0.293 to -0.125) | 24.19 (11.31 to 125.10), EXTRAPOLATION (observed 1.00 to 9.00) | 3.40 (2.66 to 5.20) |
| G priced cost (USD) | priced cost | 75 | -0.160 (-0.334 to 0.032) | -0.075 (-0.143 to -0.011) | $0.2791 ($0.0813 to $558.0798; 9726 of 10000 draws usable), EXTRAPOLATION (observed $0.0162 to $0.1182) | $0.0013 ($0.0000 to $0.0052; 9730 of 10000 draws usable), EXTRAPOLATION (observed $0.0162 to $0.1182) |
| G priced cost (USD) | billable tokens | 75 | -0.135 (-0.313 to 0.052) | -0.101 (-0.185 to -0.007) | $3.7445 ($0.3949 to >1e6; 9585 of 10000 draws usable), EXTRAPOLATION (observed $0.0162 to $0.1182) | $0.0683 ($0.0395 to $1.0772; 9589 of 10000 draws usable) |

Fitted ratio (A over G) against G calls, read off the all-runs log-log line: priced cost 1.23 at 1.00, 1.17 at 3.00, 1.12 at 9.00; billable tokens 1.93 at 1.00, 1.54 at 3.00, 1.23 at 9.00.

Regression-to-the-mean check (split half). x = G tool calls in ONE run; the denominator = G in the OTHER runs; the numerator = A over all its runs. G noise in x and in the denominator are independent. One row per choice of the x run:

| x run | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| run 1 | priced cost | 75 | -0.105 (-0.327 to 0.115) | -0.014 (-0.103 to 0.068) | not identified (fit falls in only 6078 of 10000 draws) | not identified (fit falls in only 6101 of 10000 draws) |
| run 2 | priced cost | 75 | -0.027 (-0.215 to 0.156) | 0.009 (-0.059 to 0.082) | not identified (fit falls in only 4385 of 10000 draws) | not identified (fit falls in only 4411 of 10000 draws) |
| run 3 | priced cost | 75 | -0.113 (-0.309 to 0.091) | -0.024 (-0.089 to 0.043) | not identified (fit falls in only 7283 of 10000 draws) | not identified (fit falls in only 7310 of 10000 draws) |
| run 1 | billable tokens | 75 | -0.278 (-0.462 to -0.081) | -0.104 (-0.216 to 0.006) | not identified (fit falls in only 9398 of 10000 draws) | not identified (fit falls in only 9412 of 10000 draws) |
| run 2 | billable tokens | 75 | -0.176 (-0.350 to 0.014) | -0.065 (-0.168 to 0.052) | not identified (fit falls in only 8350 of 10000 draws) | not identified (fit falls in only 8366 of 10000 draws) |
| run 3 | billable tokens | 75 | -0.189 (-0.373 to 0.005) | -0.098 (-0.182 to -0.008) | 340.47 (31.34 to >1e6; 9601 of 10000 draws usable), EXTRAPOLATION (observed 1.00 to 10.00) | 5.43 (2.98 to 84.19; 9605 of 10000 draws usable) |

Mean over the x-run choices: priced cost Spearman -0.082, slope -0.010; billable tokens Spearman -0.214, slope -0.089.

### Clean-room replication, atlas (as A-reg) versus grep

75 questions. G tool calls per question (mean over runs, final answer excluded): min 1.00, median 1.67, max 7.00.

All runs (x = G mean over runs; ratio = A mean over G mean). This version has G in both x and the denominator, so it is exposed to regression to the mean:

| x | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| G calls | priced cost | 75 | -0.107 (-0.306 to 0.095) | 0.003 (-0.100 to 0.101) | not identified (fit falls in only 4830 of 10000 draws) | not identified (fit falls in only 4851 of 10000 draws) |
| G calls | billable tokens | 75 | -0.383 (-0.553 to -0.191) | -0.118 (-0.244 to -0.008) | 192.65 (16.12 to >1e6; 9587 of 10000 draws usable), EXTRAPOLATION (observed 1.00 to 7.00) | 6.25 (2.99 to 678.12; 9593 of 10000 draws usable) |
| G priced cost (USD) | priced cost | 75 | -0.195 (-0.375 to -0.005) | -0.031 (-0.139 to 0.073) | not identified (fit falls in only 6887 of 10000 draws) | not identified (fit falls in only 6905 of 10000 draws) |
| G priced cost (USD) | billable tokens | 75 | -0.286 (-0.468 to -0.094) | -0.039 (-0.152 to 0.078) | not identified (fit falls in only 7227 of 10000 draws) | not identified (fit falls in only 7253 of 10000 draws) |

Fitted ratio (A over G) against G calls, read off the all-runs log-log line: priced cost 1.25 at 1.00, 1.25 at 3.00, 1.25 at 7.00; billable tokens 1.86 at 1.00, 1.64 at 3.00, 1.48 at 7.00.

Regression-to-the-mean check (split half). x = G tool calls in ONE run; the denominator = G in the OTHER runs; the numerator = A over all its runs. G noise in x and in the denominator are independent. One row per choice of the x run:

| x run | ratio of | n | Spearman (90%) | slope of ln(ratio) on ln(x) (90%) | break-even ratio 1.0 | break-even ratio 1.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| run 1 | priced cost | 75 | 0.017 (-0.186 to 0.213) | 0.031 (-0.062 to 0.120) | not identified (fit falls in only 2938 of 10000 draws) | not identified (fit falls in only 2964 of 10000 draws) |
| run 2 | priced cost | 75 | -0.044 (-0.252 to 0.158) | 0.027 (-0.080 to 0.130) | not identified (fit falls in only 3425 of 10000 draws) | not identified (fit falls in only 3436 of 10000 draws) |
| run 3 | priced cost | 75 | 0.097 (-0.098 to 0.288) | 0.044 (-0.039 to 0.119) | not identified (fit falls in only 1783 of 10000 draws) | not identified (fit falls in only 1799 of 10000 draws) |
| run 1 | billable tokens | 75 | -0.142 (-0.340 to 0.056) | -0.037 (-0.144 to 0.065) | not identified (fit falls in only 7214 of 10000 draws) | not identified (fit falls in only 7242 of 10000 draws) |
| run 2 | billable tokens | 75 | -0.149 (-0.345 to 0.049) | -0.029 (-0.151 to 0.079) | not identified (fit falls in only 6658 of 10000 draws) | not identified (fit falls in only 6680 of 10000 draws) |
| run 3 | billable tokens | 75 | -0.026 (-0.226 to 0.164) | -0.004 (-0.105 to 0.079) | not identified (fit falls in only 5211 of 10000 draws) | not identified (fit falls in only 5251 of 10000 draws) |

Mean over the x-run choices: priced cost Spearman 0.023, slope 0.034; billable tokens Spearman -0.106, slope -0.023.

## Scatter data (one row per question, sorted by G tool calls)

### Angular v2 pilot

| question | category | G calls | G cost | A-reg cost | A-reg/G cost | A-reg/G tokens | A-ts cost | A-ts/G cost | A-ts/G tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| p-309 | heritage | 2.00 | $0.0222 | $0.0263 | 1.18 | 1.69 | $0.0286 | 1.29 | 1.58 |
| p-315 | definition | 2.00 | $0.0194 | $0.0238 | 1.23 | 1.72 | $0.0243 | 1.25 | 1.56 |
| p-301 | callers | 2.50 | $0.0629 | $0.0766 | 1.22 | 2.86 | $0.0674 | 1.07 | 1.76 |
| p-310 | heritage | 2.50 | $0.0442 | $0.0291 | 0.66 | 1.20 | $0.0642 | 1.45 | 1.14 |
| p-303 | callers | 3.00 | $0.0598 | $0.0519 | 0.87 | 1.48 | $0.0515 | 0.86 | 1.01 |
| p-304 | callers | 3.00 | $0.0649 | $0.2013 | 3.10 | 8.83 | $0.0963 | 1.48 | 2.11 |
| p-306 | references | 3.00 | $0.0354 | $0.0834 | 2.36 | 3.49 | $0.0404 | 1.14 | 1.32 |
| p-314 | impact | 3.00 | $0.0500 | $0.1031 | 2.06 | 3.42 | $0.0493 | 0.99 | 1.26 |
| p-316 | abstain | 3.00 | $0.0274 | $0.0255 | 0.93 | 1.25 | $0.0222 | 0.81 | 0.95 |
| p-302 | callers | 4.00 | $0.1028 | $0.1054 | 1.03 | 1.35 | $0.1007 | 0.98 | 1.07 |
| p-312 | impact | 5.00 | $0.0664 | $0.1155 | 1.74 | 2.92 | $0.0959 | 1.44 | 1.44 |
| p-311 | impact | 7.00 | $0.0755 | $0.0864 | 1.14 | 0.85 | $0.0778 | 1.03 | 0.79 |
| p-307 | references | 9.00 | $0.1188 | $0.2535 | 2.13 | 3.13 | $0.1100 | 0.93 | 1.08 |
| p-305 | references | 10.00 | $0.1285 | $0.1010 | 0.79 | 1.14 | $0.0871 | 0.68 | 0.79 |
| p-313 | impact | 10.50 | $0.1282 | $0.2460 | 1.92 | 2.38 | $0.1659 | 1.29 | 1.41 |
| p-308 | references | 12.50 | $0.1374 | $0.1976 | 1.44 | 1.81 | $0.1815 | 1.32 | 1.42 |

### Registered run (gsd-core)

| question | category | G calls | G cost | A-reg cost | A-reg/G cost | A-reg/G tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| q-007 | callers | 1.00 | $0.0263 | $0.0352 | 1.34 | 3.00 |
| q-016 | references | 1.00 | $0.0162 | $0.0206 | 1.27 | 2.03 |
| q-023 | emit | 1.00 | $0.0184 | $0.0236 | 1.28 | 2.00 |
| q-025 | emit | 1.00 | $0.0215 | $0.0276 | 1.28 | 2.52 |
| q-057 | references | 1.00 | $0.0167 | $0.0241 | 1.44 | 1.81 |
| q-058 | references | 1.00 | $0.0213 | $0.0237 | 1.11 | 1.93 |
| q-059 | references | 1.00 | $0.0213 | $0.0240 | 1.13 | 1.68 |
| q-011 | callers | 1.33 | $0.0423 | $0.0531 | 1.25 | 1.80 |
| q-013 | references | 1.33 | $0.0479 | $0.0623 | 1.30 | 1.74 |
| q-014 | references | 1.33 | $0.0512 | $0.0476 | 0.93 | 1.67 |
| q-015 | references | 1.33 | $0.0162 | $0.0237 | 1.46 | 1.81 |
| q-026 | emit | 1.33 | $0.0197 | $0.0279 | 1.42 | 2.20 |
| q-056 | callers | 1.33 | $0.0187 | $0.0240 | 1.29 | 2.21 |
| q-012 | references | 1.67 | $0.0233 | $0.0310 | 1.33 | 2.32 |
| q-021 | heritage | 1.67 | $0.0237 | $0.0290 | 1.22 | 1.89 |
| q-049 | abstain | 1.67 | $0.0192 | $0.0204 | 1.06 | 1.25 |
| q-052 | callers | 1.67 | $0.0519 | $0.0518 | 1.00 | 1.98 |
| q-063 | emit | 1.67 | $0.0199 | $0.0308 | 1.55 | 2.03 |
| q-004 | callers | 2.00 | $0.0331 | $0.0393 | 1.19 | 1.14 |
| q-005 | callers | 2.00 | $0.0310 | $0.0475 | 1.53 | 1.37 |
| q-018 | heritage | 2.00 | $0.0187 | $0.0228 | 1.22 | 1.74 |
| q-019 | heritage | 2.00 | $0.0227 | $0.0226 | 1.00 | 1.74 |
| q-020 | heritage | 2.00 | $0.0182 | $0.0224 | 1.23 | 1.74 |
| q-024 | emit | 2.00 | $0.0400 | $0.0398 | 0.99 | 1.90 |
| q-032 | adr | 2.00 | $0.0204 | $0.0237 | 1.16 | 1.71 |
| q-035 | adr | 2.00 | $0.0258 | $0.0339 | 1.31 | 1.80 |
| q-040 | definition | 2.00 | $0.0189 | $0.0213 | 1.13 | 1.17 |
| q-041 | definition | 2.00 | $0.0185 | $0.0219 | 1.18 | 1.55 |
| q-042 | definition | 2.00 | $0.0177 | $0.0217 | 1.22 | 1.74 |
| q-043 | definition | 2.00 | $0.0183 | $0.0201 | 1.10 | 1.16 |
| q-044 | definition | 2.00 | $0.0172 | $0.0204 | 1.18 | 1.37 |
| q-045 | abstain | 2.00 | $0.0179 | $0.0238 | 1.33 | 1.78 |
| q-046 | abstain | 2.00 | $0.0184 | $0.0232 | 1.26 | 1.77 |
| q-050 | abstain | 2.00 | $0.0278 | $0.0200 | 0.72 | 0.98 |
| q-051 | callers | 2.00 | $0.0225 | $0.0321 | 1.42 | 1.76 |
| q-060 | heritage | 2.00 | $0.0183 | $0.0224 | 1.22 | 1.93 |
| q-061 | heritage | 2.00 | $0.0190 | $0.0235 | 1.24 | 1.74 |
| q-062 | heritage | 2.00 | $0.0190 | $0.0233 | 1.22 | 1.55 |
| q-066 | adr | 2.00 | $0.0323 | $0.0318 | 0.98 | 2.03 |
| q-068 | adr | 2.00 | $0.0263 | $0.0278 | 1.06 | 1.64 |
| q-071 | definition | 2.00 | $0.0178 | $0.0202 | 1.13 | 1.17 |
| q-072 | definition | 2.00 | $0.0182 | $0.0221 | 1.21 | 1.74 |
| q-074 | abstain | 2.00 | $0.0168 | $0.0200 | 1.19 | 1.18 |
| q-006 | callers | 2.33 | $0.0421 | $0.0255 | 0.60 | 1.09 |
| q-017 | heritage | 2.33 | $0.0237 | $0.0364 | 1.53 | 2.13 |
| q-031 | adr | 2.33 | $0.0325 | $0.0308 | 0.95 | 1.60 |
| q-038 | impact | 2.33 | $0.0300 | $0.0490 | 1.63 | 2.64 |
| q-047 | abstain | 2.33 | $0.0317 | $0.0342 | 1.08 | 1.72 |
| q-048 | abstain | 2.33 | $0.0196 | $0.0208 | 1.06 | 1.20 |
| q-055 | callers | 2.33 | $0.0391 | $0.0506 | 1.30 | 1.87 |
| q-073 | abstain | 2.33 | $0.0204 | $0.0200 | 0.98 | 1.02 |
| q-009 | callers | 2.67 | $0.0293 | $0.0268 | 0.92 | 1.12 |
| q-027 | emit | 2.67 | $0.0245 | $0.0288 | 1.18 | 1.80 |
| q-029 | adr | 2.67 | $0.0351 | $0.0444 | 1.27 | 2.01 |
| q-030 | adr | 2.67 | $0.0261 | $0.0356 | 1.36 | 1.52 |
| q-037 | impact | 2.67 | $0.0336 | $0.0577 | 1.72 | 2.21 |
| q-064 | emit | 2.67 | $0.0238 | $0.0440 | 1.85 | 2.74 |
| q-067 | adr | 2.67 | $0.0222 | $0.0311 | 1.40 | 2.09 |
| q-075 | abstain | 2.67 | $0.0212 | $0.0211 | 1.00 | 1.37 |
| q-002 | callers | 3.00 | $0.0254 | $0.0281 | 1.11 | 1.62 |
| q-028 | emit | 3.00 | $0.0464 | $0.0457 | 0.98 | 1.05 |
| q-034 | adr | 3.00 | $0.0297 | $0.0250 | 0.84 | 1.20 |
| q-001 | callers | 3.33 | $0.0395 | $0.0542 | 1.37 | 1.48 |
| q-033 | adr | 3.33 | $0.0229 | $0.0241 | 1.05 | 1.32 |
| q-070 | impact | 3.33 | $0.0440 | $0.0737 | 1.68 | 2.46 |
| q-003 | callers | 4.00 | $0.0493 | $0.0695 | 1.41 | 1.71 |
| q-010 | callers | 4.00 | $0.0718 | $0.0672 | 0.94 | 1.01 |
| q-065 | emit | 4.00 | $0.0655 | $0.0739 | 1.13 | 1.67 |
| q-054 | callers | 4.33 | $0.0740 | $0.0759 | 1.03 | 1.11 |
| q-053 | callers | 5.00 | $0.0788 | $0.0634 | 0.81 | 1.18 |
| q-022 | emit | 5.33 | $0.0843 | $0.1131 | 1.34 | 1.73 |
| q-036 | impact | 5.33 | $0.0779 | $0.1084 | 1.39 | 1.87 |
| q-039 | impact | 6.67 | $0.0574 | $0.0772 | 1.34 | 1.62 |
| q-069 | impact | 7.33 | $0.0869 | $0.0997 | 1.15 | 1.25 |
| q-008 | callers | 9.00 | $0.1182 | $0.1302 | 1.10 | 1.20 |

### Clean-room replication (gsd-core)

| question | category | G calls | G cost | A-reg cost | A-reg/G cost | A-reg/G tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| q-005 | callers | 1.00 | $0.0268 | $0.0439 | 1.64 | 2.23 |
| q-013 | references | 1.00 | $0.0461 | $0.0731 | 1.59 | 2.68 |
| q-014 | references | 1.00 | $0.0656 | $0.0452 | 0.69 | 1.30 |
| q-015 | references | 1.00 | $0.0152 | $0.0230 | 1.52 | 1.83 |
| q-016 | references | 1.00 | $0.0159 | $0.0204 | 1.28 | 2.04 |
| q-018 | heritage | 1.00 | $0.0163 | $0.0199 | 1.22 | 1.75 |
| q-019 | heritage | 1.00 | $0.0158 | $0.0195 | 1.23 | 1.75 |
| q-020 | heritage | 1.00 | $0.0158 | $0.0192 | 1.22 | 1.75 |
| q-023 | emit | 1.00 | $0.0198 | $0.0258 | 1.30 | 2.28 |
| q-026 | emit | 1.00 | $0.0184 | $0.0259 | 1.41 | 2.62 |
| q-033 | adr | 1.00 | $0.0157 | $0.0213 | 1.36 | 2.64 |
| q-037 | impact | 1.00 | $0.0241 | $0.0828 | 3.43 | 6.27 |
| q-040 | definition | 1.00 | $0.0163 | $0.0202 | 1.24 | 1.75 |
| q-041 | definition | 1.00 | $0.0161 | $0.0197 | 1.22 | 1.74 |
| q-042 | definition | 1.00 | $0.0154 | $0.0189 | 1.23 | 1.76 |
| q-043 | definition | 1.00 | $0.0155 | $0.0199 | 1.28 | 1.77 |
| q-044 | definition | 1.00 | $0.0149 | $0.0197 | 1.32 | 1.79 |
| q-048 | abstain | 1.00 | $0.0148 | $0.0184 | 1.24 | 1.77 |
| q-057 | references | 1.00 | $0.0166 | $0.0236 | 1.42 | 2.09 |
| q-058 | references | 1.00 | $0.0243 | $0.0231 | 0.95 | 1.59 |
| q-059 | references | 1.00 | $0.0204 | $0.0280 | 1.38 | 1.77 |
| q-061 | heritage | 1.00 | $0.0163 | $0.0200 | 1.22 | 1.74 |
| q-062 | heritage | 1.00 | $0.0160 | $0.0190 | 1.19 | 1.73 |
| q-071 | definition | 1.00 | $0.0200 | $0.0196 | 0.98 | 1.76 |
| q-072 | definition | 1.00 | $0.0158 | $0.0192 | 1.21 | 1.75 |
| q-004 | callers | 1.33 | $0.0280 | $0.0423 | 1.51 | 1.78 |
| q-007 | callers | 1.33 | $0.0387 | $0.0329 | 0.85 | 1.18 |
| q-017 | heritage | 1.33 | $0.0189 | $0.0264 | 1.40 | 2.01 |
| q-021 | heritage | 1.33 | $0.0198 | $0.0238 | 1.20 | 1.92 |
| q-024 | emit | 1.33 | $0.0415 | $0.0395 | 0.95 | 1.59 |
| q-025 | emit | 1.33 | $0.0198 | $0.0276 | 1.39 | 2.23 |
| q-035 | adr | 1.33 | $0.0242 | $0.0264 | 1.09 | 1.87 |
| q-060 | heritage | 1.33 | $0.0157 | $0.0194 | 1.24 | 1.76 |
| q-074 | abstain | 1.33 | $0.0152 | $0.0198 | 1.30 | 1.53 |
| q-011 | callers | 1.67 | $0.0455 | $0.0556 | 1.22 | 1.73 |
| q-051 | callers | 1.67 | $0.0193 | $0.0347 | 1.80 | 1.54 |
| q-063 | emit | 1.67 | $0.0210 | $0.0245 | 1.17 | 1.47 |
| q-068 | adr | 1.67 | $0.0256 | $0.0234 | 0.91 | 1.41 |
| q-073 | abstain | 1.67 | $0.0179 | $0.0197 | 1.10 | 1.30 |
| q-002 | callers | 2.00 | $0.0227 | $0.0294 | 1.29 | 1.55 |
| q-009 | callers | 2.00 | $0.0277 | $0.0334 | 1.21 | 1.99 |
| q-012 | references | 2.00 | $0.0266 | $0.0271 | 1.02 | 1.46 |
| q-032 | adr | 2.00 | $0.0209 | $0.0243 | 1.17 | 1.69 |
| q-034 | adr | 2.00 | $0.0234 | $0.0396 | 1.69 | 1.77 |
| q-045 | abstain | 2.00 | $0.0167 | $0.0235 | 1.40 | 1.81 |
| q-046 | abstain | 2.00 | $0.0191 | $0.0263 | 1.37 | 2.17 |
| q-047 | abstain | 2.00 | $0.0323 | $0.0383 | 1.19 | 1.71 |
| q-049 | abstain | 2.00 | $0.0197 | $0.0321 | 1.63 | 1.70 |
| q-050 | abstain | 2.00 | $0.0262 | $0.0197 | 0.75 | 1.04 |
| q-052 | callers | 2.00 | $0.0544 | $0.0459 | 0.84 | 1.65 |
| q-055 | callers | 2.00 | $0.0421 | $0.0511 | 1.21 | 1.53 |
| q-056 | callers | 2.00 | $0.0232 | $0.0228 | 0.98 | 1.27 |
| q-064 | emit | 2.00 | $0.0239 | $0.0323 | 1.35 | 2.26 |
| q-006 | callers | 2.33 | $0.0273 | $0.0334 | 1.22 | 1.34 |
| q-003 | callers | 2.67 | $0.0510 | $0.0560 | 1.10 | 1.57 |
| q-028 | emit | 2.67 | $0.0415 | $0.0350 | 0.84 | 1.32 |
| q-029 | adr | 2.67 | $0.0295 | $0.0394 | 1.34 | 1.35 |
| q-031 | adr | 2.67 | $0.0322 | $0.0329 | 1.02 | 1.75 |
| q-075 | abstain | 2.67 | $0.0205 | $0.0199 | 0.97 | 1.07 |
| q-001 | callers | 3.00 | $0.0398 | $0.0422 | 1.06 | 1.28 |
| q-022 | emit | 3.00 | $0.0517 | $0.0757 | 1.46 | 1.95 |
| q-027 | emit | 3.00 | $0.0253 | $0.0288 | 1.14 | 1.64 |
| q-030 | adr | 3.00 | $0.0257 | $0.0278 | 1.08 | 1.49 |
| q-065 | emit | 3.00 | $0.0571 | $0.0685 | 1.20 | 1.69 |
| q-066 | adr | 3.00 | $0.0279 | $0.0316 | 1.13 | 1.65 |
| q-070 | impact | 3.00 | $0.0411 | $0.0652 | 1.59 | 1.67 |
| q-054 | callers | 3.33 | $0.0721 | $0.0863 | 1.20 | 1.19 |
| q-067 | adr | 3.33 | $0.0257 | $0.0287 | 1.12 | 1.54 |
| q-069 | impact | 3.33 | $0.0661 | $0.1577 | 2.39 | 4.10 |
| q-010 | callers | 3.67 | $0.0651 | $0.0781 | 1.20 | 1.53 |
| q-038 | impact | 3.67 | $0.0362 | $0.0567 | 1.56 | 1.69 |
| q-036 | impact | 4.33 | $0.0632 | $0.1388 | 2.20 | 2.80 |
| q-039 | impact | 4.33 | $0.0535 | $0.0795 | 1.49 | 1.73 |
| q-053 | callers | 4.33 | $0.0717 | $0.0712 | 0.99 | 1.28 |
| q-008 | callers | 7.00 | $0.0815 | $0.1102 | 1.35 | 2.03 |

