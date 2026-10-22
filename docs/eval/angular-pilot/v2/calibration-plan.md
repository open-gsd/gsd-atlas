# Angular pilot, rule v2: calibration plan (pre-declared before any session)

**Unscored, unregistered.** The registered verdict `OVERALL: MVP not met` stands. This file is committed before the first model session of the v2 calibration batch. The v2 keys are first-reader audited only (`key-audit.md`); a second reader is pending.

## 1. The four questions

One question per category, each the one with the largest whole-tree grep proxy in its category in the preface table of `key-audit.md`:

| category | id | symbol | grep files (tree) |
| --- | --- | --- | ---: |
| callers | p-304 | `stringify` | 246 |
| references | p-307 | `Component` (compiler, `render3/r3_ast.ts` class) | 2,989 |
| impact | p-312 | `translate` | 257 |
| heritage | p-310 | `NgModuleRef` | 53 |

These are the hardest-per-category questions on the proxy, so this check is deliberately favourable to the premise (it is not a sample of the 16-question mix).

Premise reading, applied to the grep (G) mean billable tokens over these 4 sessions:

- **PASS**: mean >= 68,000. Proceed to the full 96-session run, which then measures the real mix.
- **FAIL**: mean < 55,000. Even on the hardest question per category the premise fails for this corpus and question style.
- **55,000 to 68,000**: judgement. Both readings are reported, no single verdict is forced.

## 2. Conditions and sessions

Three conditions, once each per question, 12 sessions: **G** (grep arm as registered), **A-ts** (atlas, tools deferred through ToolSearch, no skill), **A-reg** (atlas as registered). Order is the driver's seeded group order (seed 20261021), adjacent triples per question. Model `claude-sonnet-5-5`, Claude Code 2.1.305, subscription login only, sequential, `nice -n 10`, per-session budget 1.5 USD, notional cap 4 USD (`--cap-usd 4`). No 96-session pilot stage and no closed-book stage are run.

## 3. Stop rules (the driver's, unchanged)

Stop and report, do not work around: overage on in any reading; either rate window >= 0.60; any non-ok session (infrastructure failure) in the chunk check; an API key in any init event; a Claude Code version or environment mismatch; a permission prompt or classifier denial; notional spend past the cap; a failed subscription-login check (four fields: loggedIn true, authMethod claude.ai, apiProvider firstParty, subscriptionType max).

## 4. What is reported

Per-condition mean and median billable tokens with the input / cache creation / cache read / output split, first-request tokens, tool calls, atlas call rate (A-ts, A-reg), ToolSearch calls, skill loaded, wall time, cost, answer vs key (exact-set equality, matched / missing / extra), per-category numbers, rate readings before and after, the premise verdict against section 1, and a labelled projection for 96 sessions.
