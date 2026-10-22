# Angular pilot, rule v2: run plan and reading rules (pre-declared before any pilot session)

**Unscored, unregistered.** The registered verdict `OVERALL: MVP not met` stands; nothing registered is touched. This file is committed before the first of the 96 pilot sessions. It restates section 6 of `../../angular-pilot-plan.md` (adopted by the owner on 2026-10-21, section 10) as rules that are applied mechanically afterwards by `scripts/angular-pilot/pilot-analysis.ts` (tests: `pilot-analysis.test.ts`). Nothing below is adjusted after data arrive. If a rule turns out to be unusable, the result is reported as such and the owner decides; the rule is not rewritten.

## Run

- 16 questions `p-301`..`p-316` of `pilot-questions.json` in this directory (rule v2, with the p-313 wording change in `wording-log.md`; keys `pilot-answers.json`, p-313 at 19 files per `key-corrections.md`) x 3 conditions G, A-ts, A-reg x 2 runs = 96 sessions. Schedule: the driver's `buildSchedule`, seed 20261021, each (question, run) one adjacent group of three conditions in random order, 7 chunks (six of 15 sessions, one of 6).
- Claude Code 2.1.305, model `claude-sonnet-5-5`, subscription login only, concurrency 1, every session under `nice -n 10`, per-session budget 1.5 USD, driver cap `--cap-usd 14` (ceiling 30). The prepared checkout comes from `prepare-checkout.ts` into an empty scratch directory from the angular clone at `3cc1edf3210a9debb0be57a4e99e53a54505db32` (read only); the atlas build is this worktree after `npm ci --ignore-scripts && npm run build`. The driver builds each atlas session's index itself.
- Command (paths in the scratchpad): `node scripts/angular-pilot/driver.ts --launch --stage pilot --corpus <prepared> --out <dir> --scratch <dir> --ledger <file> --repo <worktree> --docs docs/eval/angular-pilot/v2 --cap-usd 14`.
- Stop and report, never work around: overage on in any reading, either window >= 0.60, any non-ok session in a chunk check (an infrastructure failure is recorded as a wrong answer and counted; no result is edited or deleted and no cell is rerun silently), an API key in an init event, a Claude Code version or environment mismatch, a permission prompt or classifier denial, spend past the cap, a failed four-field login filter (loggedIn true, authMethod claude.ai, apiProvider firstParty, subscriptionType max).
- The 12 calibration sessions (`calibration/`, `calibration-notes.md`) are NOT pooled into any pilot number. The closed-book control is not part of this run.

## Definitions

- **Billable tokens**: input + output + cache creation + cache read of a session (the driver record's `usage.billable`).
- **Question mean**: for a question and a condition, the mean billable tokens of its two runs.
- **R** (for A-ts and A-reg separately): the mean over the 16 questions of the A question means, divided by the mean over the 16 questions of the G question means. Interval: bootstrap with 10,000 draws; each draw resamples the 16 questions with replacement (the same question index drawn for A and G), R is recomputed on the draw; the generator is mulberry32 seeded 20261021 and re-seeded for each condition (so both conditions use the same resamples); the interval is the 90% percentile interval, the 500th and the 9,500th of the 10,000 sorted draws (1-based). The point R is the unresampled ratio.
- **Correctness** (per condition, 32 sessions): the share of sessions whose answer set equals the audited key (exact-set equality at the key's granularity, registered matching rules, the driver's `compareAnswer`). The audited key is `pilot-answers.json` as committed at launch. A session whose answer cannot be read counts as wrong. Reported beside it: matched / missing / extra counts (sums, and per session in the not-exact list).
- **Adoption** (per A condition, 32 sessions): the share of sessions with at least one atlas tool call (a tool whose name starts with `mcp__gsd-atlas__`; a ToolSearch call alone is not an atlas call).
- **Premise check** on the G mean (mean over the 16 questions of the G question means, equal to the mean of the 32 G sessions): **>= 68,000 passed**; **< 55,000 failed** (the premise "grep is expensive on these targets" failed in tokens, reported as the finding, no registration on this corpus); **between** is judgement and both readings are reported.
- **Keys changed by the audit**: counted at launch from `key-corrections.md`: 1 of 16 (p-313). This item concerns the key audit before the pilot; the later audit of session answers against the keys is not part of the classification.

## Outcome classes (n = 16 questions: triage thresholds, not tests)

Evaluated in this order; the first that holds is the class, and flags that also hold are listed.

1. **Worth a registered run**: for one A condition X (A-ts or A-reg, all four tests on the same X): R(X) <= 0.85 AND correctness(X) >= correctness(G) - 0.10 AND adoption(X) >= 50% AND the premise check passed.
2. **Stop and reconsider the token gate**: (a) both A conditions have R >= 1.10 AND the premise check passed; OR (b) atlas sessions that made an atlas call (both A conditions, pooled) cost at least as much as G sessions on the same questions: the mean billable of those called A sessions is >= the mean, over the same called sessions, of the mean G billable of each session's question (both G runs). The premise qualifier attaches to (a) only, as the plan words it. (b) is not evaluated when no A session made an atlas call.
3. **Inconclusive** otherwise. Named triggers, reported as flags: 0.85 < R < 1.10 for either A condition; adoption < 20% for either A condition; correctness < 50% for any of the three conditions on the audited keys; more than 3 of 16 keys changed by the audit. When none of them holds and classes 1 and 2 do not, the class is still inconclusive and the report says it is the residual.
4. If the premise check is between, the class is computed twice (premise treated as passed, as not passed) and both are reported; the class is `judgement` unless the two agree. If the premise failed, class 1 and clause 2(a) cannot hold, and the report states "premise failed" as the finding.
5. Precedence follows the plan's order: if class 1 holds and 2(b) also holds, the class is "worth" and the report lists "stop clause 2 also holds". Flags are never used to change a class.

## Reported beside the class (no thresholds attached)

- Per-condition table: billable mean and median, the same on exact-set sessions only, the input / cache creation / cache read / output split, first-request tokens, tool calls, ToolSearch calls, skill loaded, wall time, cost, matched / missing / extra.
- **Per-category tables** (callers 4, references 4, heritage 2, impact 4, definition 1, abstain 1 questions): mean billable per condition, ratio to G, correctness, adoption. Descriptive only: n is 1 to 4 questions per cell, no interval.
- **A sessions with and without an atlas call**: billable mean and correctness of the two groups, per A condition and pooled; and per question that has both kinds among its A sessions (pooled over A-ts and A-reg), the mean billable of the called against the not-called sessions on that same question. Descriptive, no test.
- Wall time, cost, the rate-limit readings (five-hour, seven-day, overage) of the first and last session of each chunk and the maxima, the chunk-check log, the list of every session whose answer is not an exact match with matched / missing / extra counts and file names (listed for the later audit against the keys; no key defect is decided by the run).
- Deviations and unverified items.

## Data

`pilot/pilot-sessions.jsonl` (one row per session: counts, tokens, statuses, no answer prose), `pilot/summary.json`, `pilot/tables.md`, produced by `node scripts/angular-pilot/pilot-analysis.ts --out <driver out dir> --docs docs/eval/angular-pilot/v2 --dest docs/eval/angular-pilot/v2/pilot`. Results: `pilot-results.md`.
