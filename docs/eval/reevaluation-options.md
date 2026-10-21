# Re-evaluation options after the MVP eval miss

Status: research note, not a registered document. The registered verdict stands: `OVERALL: MVP not met` (`docs/eval/analysis.md`, last line). Nothing here edits, re-scores or re-interprets that verdict, a registered file, a question, a key or a result row. No decision record is described here as ratified. Written 2026-10-21 by an agent; the recommendation in section 4 is the agent's judgement and the decision is the user's.

## Summary (10 lines)

1. The registered run met H1 (atlas 0.800 vs grep 0.751, 5th percentile +0.0133) and missed H2 (atlas 1.61x grep billable tokens, whole interval above zero) and H3 (72.7% against 80%); the clean-room replication agreed on all three (accuracy 0.769 vs 0.764, tokens 1.79x, citations 70.2%).
2. Existing documents say only a new registered run that meets the gate unblocks Phase 4 (`diagnosis.md:3`, `comparison.md:18`, D-04 in `03-CONTEXT.md:24`); they provide no other path, and they do not stop the user from making an explicit, recorded decision to proceed that leaves the verdict unchanged.
3. Atlas is not shown to be more accurate than grep: the +4.9 point difference in the registered run shrank to +0.4 in the replication (between-run difference -4.4 points, interval -9.3 to 0.0, marked "not compatible"); non-inferiority held both times. The only category with a repeated gain is `emit` (+20.0, +13.3 points), where atlas made zero atlas calls.
4. `impact` fell from +5.6 to -16.7 points in the replication (6 questions; atlas always used); the pooled descriptive difference is -5.6 points with an interval that includes zero. Small n; not a finding.
5. 94% of the token gap is cache read; an atlas call was made in only 34-38% of atlas sessions, the skill body was loaded in 0 of 450; 139 of 225 pairs (registered run) with no atlas call still carry about 65% of the gap. Per-turn fixed context is the lead cause (derived in section 2.4).
6. The corpus is not tiny: at the pinned commit it has 3,976 tracked files and 1,689 JS/TS files with about 1.02 million lines (local count), above the 1,000-file mark where Cursor reports its larger effect; but its questions are name-addressable and grep sessions are short (3.5 tool calls, median 20.9k billable tokens), so "grep is cheap here" is supported, "the corpus is small" is not.
7. Published evidence is thin and mostly vendor or preliminary: the closest controlled study (arXiv 2608.13568, single author, preliminary) finds LSP tools cost more tokens on symbol localisation, help precision on reference tasks, and agents default to grep. Cursor (first party, semantic search, not a graph) reports +12.5% accuracy on its own benchmark. None tests caller/impact graphs on Swift or C++.
8. No published evidence was found that retrieving platform-SDK availability metadata raises answer quality for Apple APIs; the nearest is a Python deprecated-API study (seven LLMs, 145 API mappings) where supplying replacement information changed completions. The SDK half of the product is untested by this eval, which uses a corpus with no platform SDK.
9. Options range from a new registered run after tool/skill/prompt fixes (about the replication's cost, 15.5 USD notional and about 6.5 h, per run) to scoping the claim to what was met, or an explicit user decision to proceed; redefining a threshold is honest only if registered before the new data, on a fresh question set.
10. Agent judgement: run cheap, unscored, non-corpus probes first (fixed-overhead measurement, deferred tool loading, forced routing); decide before any new data whether "fewer tokens on gsd-core" is the right 1.0 gate; then register one new run on a corpus where grep is expensive. Section 4 lists what would change this.

## 1. Options to re-evaluate

### 1.1 What the existing documents permit and forbid

| Source | What it says | Consequence |
| --- | --- | --- |
| `docs/eval/preregistration.md` Deviations policy (line 76) | Nothing registered changes after the freeze. A change to a question, key, parameter or registered file is a new registered run: a new document version with its own approvals and hashes, run from the start, earlier registration kept and cited. A change after the first scored session never replaces the earlier result. Findings from the scored run are reported next to it and not applied to it. | A new run with changed tools, skill, prompt, schema or thresholds is permitted as a new registration. Editing or re-scoring the existing result is forbidden. |
| `preregistration.md` Revision 1 and Stage B (lines 223-322) | The atlas arm's `skills/gsd-atlas/SKILL.md` sha256 and the atlas commit are registered. Revision 1 reopened Stage A before any scored data existed, and the freezer refuses to reopen a record that has a Stage B record or a committed results file. | This record cannot be reopened. A new run needs a new registration, not a Revision 2 of this one (the freezer text is quoted in the Revision 1 "No scored data" section). I did not check the freezer code. |
| `03-CONTEXT.md:24` (D-04) | Hard gate: a miss means the MVP is not met; the work is diagnosed and iterated before Phase 4 starts. A margin changed after seeing results voids the claim; changing it means a new registered run. | Diagnosis exists (`diagnosis.md`). Iteration is the open item. |
| `diagnosis.md:3, 133` | Proposals are not applied; each would be a new registered run; Phase 4 stays blocked until such a run meets the gate. | No mechanism is provided for unblocking without a passing run. |
| `results-cleanroom/comparison.md:18` | A replication cannot make the MVP met, not met, or unblock Phase 4; only a new registered run that meets the gate does. | The replication is supplementary and is never pooled with the original. |
| `diagnosis.md` section 9 items 1-6 | Cut the fixed footprint; make a call replace shell calls; fix routing for emit, heritage, ADR; decide the citation design on purpose; review the 13 both-wrong questions; keep the accuracy property. | These are the repository's own proposed iteration list. They are D-23-sensitive: routing changes "have to be decided before the next freeze and not tuned on this data's questions". |
| `.planning/ROADMAP.md:342` | Phases 4 and 5 are technically independent of each other; Phase 4 needs Phase 3's Tenant/HostClient, compiler pool and diagnostics; Phase 5 depends on Phase 3. | The block on Phase 4 is a decision (D-04), not a technical dependency on the eval result. This is a reading of the roadmap text, not a verified dependency graph. |
| `REQUIREMENTS.md:94-95` | EVL-03: on gsd-core, fewer tokens at non-inferior accuracy, citations >= 80%. EVL-04 (Phase 9): pooled eval across gsd-core, gsd-pi, gsd-path and the Swift reference app beats grep on tokens at non-inferior accuracy. | Both requirements are about tokens. Changing "tokens" to something else changes requirements, which is a user decision recorded outside the eval. |

The registered verdict is never edited under any option below. Under every option, the old result and its replication stay in the repository and are cited by any new registration.

### 1.2 Options

Cost basis: the registered run cost 16.1142 USD notional (Claude Code's API-equivalent, not a charge) and the replication 15.5075 USD notional and about 6.5 h (`comparison.md`, the brief for this note). Max-plan allowance consumed is not recorded in any document I read; the notional figure is the only cost figure available. The roadmap notes the chunks were scheduled around the Max seven-day window (`ROADMAP.md:243`).

| Option | What it changes | Cost | Validity risks | What the registered verdict says afterwards |
| --- | --- | --- | --- | --- |
| A. New registered run after tool, skill and prompt fixes (diagnosis section 9 items 1-3) | New atlas commit, tool schemas, server instructions, skill text; possibly the prompt. Needs a new registration with approvals and hashes. | One full-size run is about 16 USD notional and roughly 6.5 h (same design, 450 sessions). Plus engineering time for the fixes. | (1) The 75 questions and their outcomes have been seen and analysed; fixes informed by them are not blind unless a fresh question set is drawn. (2) A second attempt after a miss is a forking path; both attempts must be reported. (3) Claude Code 2.1.302 and `claude-sonnet-5-5` pins may no longer be obtainable; a different pin is a different registration. (4) To pass H2 as registered, atlas billable tokens must fall from 47.4k to below the grep mean 29.4k per session, a cut of about 38% (derived from `analysis.md`). | Unchanged: not met. A new run gets its own verdict. |
| B. A new run with the same hypotheses on a different corpus or question set, same arms | New corpus (for example a larger repo) and fresh questions with the same oracle method. | About 16 USD notional per corpus if session length is similar; likely more on a larger repo (estimate, not measured). Question drafting and key review dominate effort (`pilot.md` Power section says drafting is the constraint). | Corpus choice must be justified before data and not by the expected result. A pass on a hand-picked corpus does not generalise. Pooling across corpora is EVL-04's design, not EVL-03's. | Unchanged for gsd-core. |
| C. A differently designed registered eval (for example forced routing arm, line-required answer schema, categories where graph facts matter) | The design: arms (a hook that denies shell search when an atlas tool applies is a documented Claude Code mechanism, see section 3), schema (require a line per item, registered for both arms, changes the meaning of H3 per `diagnosis.md` item 4), question mix. | Same per-run cost; plus design, pre-registration and approvals. | Forced routing measures the tools, not the tools-plus-skill product an agent actually gets; claims must be worded for what was measured. The hook changes the grep arm's environment too if applied symmetrically. | Unchanged. The new design has its own gate. |
| D. Redefine hypotheses or thresholds (for example judge tokens in priced cost, or accuracy on the classes where graph facts matter) | The meaning of the gate. | Near zero to write; the cost is the run that follows. | Honest only if registered before the data it will be judged on. Applied to the existing 450 rows it is post-hoc: for reference, priced cost was 8.7419 vs 7.3723 USD (1.19x, `analysis.md`), so even a priced metric would not flip H2 on this data. A redefinition motivated by the observed 1.6x needs an argument independent of that number. | Unchanged. A redefined gate applies only to data collected after it is registered. |
| E. Scope the claim to what was met | Wording in README, alpha limitations and the roadmap: accuracy non-inferior, citations equal to grep, tokens higher, MVP not met. `docs/reference/alpha-limitations.md` already carries the evaluation status per the 03-36 summary; I did not re-read it. | Documentation time only. | None, if the wording matches the analysis; risk is wording that implies the gate was met. | Unchanged, and consistent with it. |
| F. Unblock Phase 4 by an explicit recorded user decision, with no re-run | D-04 is amended or waived by a dated decision. Phase 4 starts while the MVP is documented as not met. | No eval cost. Opportunity cost: hardening work proceeds on a product whose headline claim (fewer tokens) is not established. | The decision must not be presented as the gate being met. D-04 states a changed margin "voids the claim"; a waiver is not a re-interpretation of the result. Phase 5 (Swift) and Phase 9 (EVL-04) would inherit the open claim. | Unchanged: not met. The documents would need to say Phase 4 started by decision. |
| G. Close Phase 3 without further eval, defer the token claim to EVL-04 | The claim is tested once, pooled, at Phase 9 across four corpora including Swift. | Deferred cost; no spend now. | The product ships hardening and SDK work on an unproven token claim for up to five phases; EVL-04 can fail too. | Unchanged. |

Options combine: E is cheap and compatible with every other option; A or B can follow F.

## 2. Accuracy and generalisation

### 2.1 Method and caveats

Source rows: `docs/eval/results/results.jsonl` (registered run) and `docs/eval/results-cleanroom/results.jsonl` (replication), 450 compact rows each, no answer text. I recomputed paired cluster bootstraps with the registered procedure (resample 75 questions, all runs of a question together, 10,000 resamples, seed 20261017, mulberry32 is not reimplemented here: I used Python's generator, so intervals agree with the registered ones to within about 0.001 rather than exactly). The registered 5th percentile (+0.0133) and 95th (+0.0889) were reproduced to four places for the registered run. Pooling the two runs is a descriptive device of this note (six sessions per question per arm); the replication report says its numbers are never pooled with the original and I do not use the pooled figure for any verdict. Per-category intervals have 6 to 17 questions and are shown only to say how wide they are.

### 2.2 Is atlas better than grep on accuracy?

| Quantity | Registered run | Replication | Pooled (descriptive) |
| --- | ---: | ---: | ---: |
| Atlas accuracy | 0.8000 | 0.7689 | 0.7844 |
| Grep accuracy | 0.7511 | 0.7644 | 0.7578 |
| Paired difference (atlas minus grep) | +0.0489 | +0.0044 | +0.0267 |
| 90% two-sided interval (5th to 95th percentile) | +0.0133 to +0.0889 | -0.0267 to +0.0356 | about 0.000 to +0.058 |
| Questions atlas better / worse / tie | 10 / 2 / 63 | 3 / 4 / 68 | 9 / 4 / 62 |
| Session pairs: both right / atlas only / grep only / both wrong | 166 / 14 / 3 / 42 | 163 / 10 / 9 / 43 | 329 / 24 / 12 / 85 |
| Two-sided sign test on atlas-only vs grep-only (sessions treated as independent, which they are not) | p = 0.013 | p = 1.0 | p = 0.065 |

Sources: `analysis.md` and `analysis-cleanroom.md` for the first two columns' accuracy and the registered intervals; the other rows are my computation from the rows. The replication report (`comparison.md`, S1) puts the between-run difference at -0.0444 with a 2.5th to 97.5th percentile range of -0.0933 to 0.0000 and marks the accuracy statistic "NO" (not compatible), which is the only statistic that moved.

Reading: non-inferiority held in both runs (5th percentiles +0.0133 and -0.0267 against the -0.05 limit). Superiority is not established: the registered run's gain is about the size of the run-to-run difference, and the replication shows no gain. Atlas never did worse than grep on the question mix overall, and never meaningfully better.

Whether atlas was used did not separate the arms. Registered run: atlas accuracy 87.2% (n 86) in sessions with an atlas call and 75.5% (n 139) without, against grep 82.6% and 70.5% on the same pairs (`diagnosis.md` section 2). Replication, my computation: atlas 82.9% (n 76) with a call and 73.8% (n 149) without, grep 85.5% and 71.8% on the same pairs. In the replication the atlas sessions that used atlas were less accurate than grep on the same questions by 2.6 points; in the registered run they were ahead by 4.6. This is descriptive and confounded by question type (atlas was called on every `impact` question and almost none of the `emit` ones).

### 2.3 Where atlas helps or hurts, by category

Accuracy difference, atlas minus grep, in percentage points; interval is a 90% bootstrap over the category's questions (few questions, wide).

| Category | Questions | Registered run | Replication | Pooled, 90% interval | Atlas call rate, registered run (replication in brackets where computed) |
| --- | ---: | ---: | ---: | --- | ---: |
| abstain | 9 | 0.0 | 0.0 | 0.0 (0.0, 0.0) | 92.6% |
| definition | 7 | 0.0 | 0.0 | 0.0 (0.0, 0.0) | 57.1% |
| heritage | 8 | 0.0 | 0.0 | 0.0 (0.0, 0.0) | 4.2% |
| references | 8 | 0.0 | 0.0 | 0.0 (0.0, 0.0) | 37.5% |
| callers | 17 | +3.9 | -2.0 | +1.0 (-3.9, +4.9) | 35.3% (29.4%) |
| adr | 10 | +6.7 | +3.3 | +5.0 (-3.3, +18.3) | 10.0% |
| emit | 10 | +20.0 | +13.3 | +16.7 (+3.3, +31.7) | 0.0% (0.0%) |
| impact | 6 | +5.6 | -16.7 | -5.6 (-16.7, +5.6) | 100% (100%) |

Note: registered-run call rates are from `diagnosis.md` section 3; I computed replication call rates only for callers, emit and impact. Pooled cells are my computation; per-category accuracy for both runs is also in `comparison.md` (per-category table).

Findings supported by the rows:

- No difference at all: abstain, definition, heritage and references have identical accuracy in both arms in both runs (abstain, definition and heritage at 100%, references at 75.0% and 79.2%). That is 32 of the 75 questions on which atlas showed nothing, and on three of the four grep is already at the ceiling.
- Emit is the one repeated difference (4 questions better, none worse, pooled interval above zero), and atlas made no atlas tool call on any emit session in either run. So the gain cannot be attributed to atlas tool output. Candidates the rows cannot separate: the visible skill description or server instructions priming the model about the `.cts` to `.cjs` mapping, or noise on 10 questions. Grep accuracy on emit is 0.30 in both runs, so the mapping is something grep sessions find hard. This is an open question (`diagnosis.md` section 3 says the same).
- Impact: the question set has six impact questions; atlas was used on all 18 sessions of each run. Registered run: +5.6 points (q-038, q-070 better; q-039 worse). Replication: -16.7 points (atlas 0.389 vs grep 0.556; q-037 fell from 3 of 3 to 1 of 3, q-038 from 3 to 2). Per question, atlas gets different answers across runs for the same question, so the fall is plausibly run-to-run variance on six questions. It is also the most expensive category (billable ratio 1.80 in the registered run, 2.67 in the replication, `comparison.md`). It is the category where atlas is used and still does not win.
- Both arms wrong together: 11 questions were wrong in all 12 sessions across both runs (q-001, q-008, q-010, q-011, q-014, q-022, q-024, q-028, q-036, q-065, q-069; my computation). `diagnosis.md` section 4 listed 13 for the registered run alone. `questions-review.md` and `pilot.md` (Findings 7 and 8) show key and question defects exist on this corpus; whether any of the 11 is a key defect is not examined and bounds accuracy to about 85% in both arms.

### 2.4 Tokens and where the gap sits

| Fact | Value | Source |
| --- | --- | --- |
| Billable ratio atlas/grep | 1.61 (registered), 1.79 (replication) | `analysis.md`, `comparison.md` |
| Paired difference per session | +17,982 (5th to 95th +15,435 to +20,709); replication +18,954 (+15,419 to +23,070) | analyses |
| Share of the gap that is cache read | 94% | `diagnosis.md` section 1 |
| Atlas sessions that called an atlas tool | 38.2% / 33.8%; skill body loaded 0 of 225 in each | `comparison.md` |
| Pairs with no atlas call: share of gap | about 65% (registered) | `diagnosis.md` section 1 |
| Extra context per turn | about 3,200 tokens (derived there); skill description alone about 977 input tokens per turn (probe) | `diagnosis.md`, `skill-visibility.md` |
| Fixed overhead times turns | 3,200 x (3.75 + 1) is about 15,200 tokens against a gap of 17,982 | my arithmetic on `diagnosis.md` proxies; an estimate, the diagnosis itself calls the turn proxy rough |

Extra check (my computation, selection effects apply because pairs are sorted by the grep arm's own cost): ratio atlas/grep by quartile of grep billable tokens, registered run 2.15, 1.74, 1.69, 1.39 (atlas cheaper in 0, 0, 5, 10 of about 56 pairs); replication 1.88, 2.24, 1.60, 1.71 (cheaper in 0, 0, 1, 7). So in the registered run the ratio fell as grep got more expensive, as the "grep is cheap here" hypothesis predicts, but in the replication it did not. Atlas was never cheaper than grep on average in any quartile. I would not read a scale effect into this data.

### 2.5 Is the result specific to a small TypeScript corpus where grep is cheap?

Corpus facts, computed locally from the pinned commit `10ac3a7a947903ba50f538a907af036744d759d5` of a local gsd-core clone with `git ls-tree` and `git show` (read-only):

| Fact | Value |
| --- | ---: |
| Tracked files | 3,976 (65.3 MB) |
| Files by extension | .md 1,805; .cjs 1,361; .json 342; .cts 284; .js 42 |
| JS/TS files (`.ts .cts .cjs .js .mjs`) | 1,689 files, 1,019,320 lines |
| `src/` JS/TS files | 274 files, 167,240 lines |
| Test files under `tests/` | 1,558 |

Cross-check: `free-alternatives.md` cites 3,976 tracked files and 1,690 files indexed by Serena, consistent with these counts. The "about 270 src files" in the brief matches `src/` only; the code the questions range over is larger.

What the evidence supports:

- Supported by rows: grep sessions were short and cheap (mean 3.5 tool calls, 29,393 billable tokens, median 20,876, 90th percentile 52,555; `diagnosis.md` section 1). There is little for a tool to save when a grep arm answers in about three calls. Atlas was cheaper in 15 of 225 pairs.
- Not supported: "the corpus is small". At 1,689 JS/TS files and about 1.0 M lines it is above the 1,000-file mark where Cursor reports its larger online effect (section 3, source S5). Lines per file are high (about 600; the `.cjs` files are mostly large single-file tools), which favours grep-and-read less than a flat count suggests; that is conjecture, I did not measure it.
- Not tested at all: other languages (Swift, C++), SDK-heavy questions, repositories where identifiers are ambiguous. `gsd-core` has distinctive names and the oracle-derived questions are name-addressed, which is the case where the preliminary LSP study finds grep strong (S3).
- Conjecture: the effect would differ on a repo with many same-named symbols, deep call chains or generated code, because that is where lexical search returns noise. S3 supports the direction for LSP tools on reference tasks; S6 (CodeGraph's own benchmark, secondary only) says savings scale with repo size. Neither is evidence about atlas.

Experiments that would settle it, with rough size and cost (my estimates, notional USD at the registered run's per-session cost of about 0.036 USD; larger repos will cost more per session):

| Experiment | Size | Rough cost | What it would settle |
| --- | --- | --- | --- |
| One-turn probe of the atlas arm's fixed context, with and without the skill, with tool definitions trimmed or deferred | 6-10 sessions | under 1 USD (the 03-38 probes cost 0.01-0.05 each) | How much of the 3,200 tokens per turn is removable before any registered run |
| Adoption test: description-only vs forced routing (a PreToolUse hook) on fresh, non-scored questions | 20-30 questions x 3 runs x 2 arms | about 4-8 USD | Whether the 34-38% call rate is the limit on the token result |
| Second and third corpus of different size, same oracle and design | 75 questions x 3 runs x 2 arms per corpus | about 16 USD each, more if sessions are longer | Whether the token and accuracy result depends on repo size |
| Swift reference app with the Phase 5 module | needs Phase 5 first | not estimable now | Language dependence; cannot be run until the module exists (`ROADMAP.md` Phase 5) |
| SDK-availability questions with a Linux box and an SDK pack | new question type, grep arm has no SDK to search | not estimated | Whether the SDK half has an advantage grep cannot match (section 3.5) |

## 3. External evidence

All web sources accessed 2026-10-21. "Fetched" means I read the primary page through the fetch tool, whose answers are produced by a small summarising model; numbers below were checked against the fetched text only as far as that tool returned them. "Search only" means I saw the claim in search results but could not read the primary. Dates of arXiv identifiers are as the fetch tool reported them.

### 3.1 Code graph, LSP and repo-map tools against grep

- S3, arXiv 2608.13568, "Does a Language Server Save Tokens for Coding Agents? A Measurement Methodology and Preliminary Study" (Pengcheng Xu, single author; the fetch reported "submitted 29 June 2026", which does not match the 2608 identifier prefix, so verify the date). Python and TypeScript repositories, Claude Opus 4.8, Sonnet 4.6, Haiku 4.5. Reported: for symbol-named localisation the LSP costs +6% to +118% tokens and agents ignore it when free (0-6% semantic tool use); for reference completeness the LSP buys precision but not token savings, and saves tokens only for the weakest model; agents use the LSP about half the time on reference tasks unprompted; on multi-file renames graded by tests, grep solves them and a location-only LSP fails about three quarters by missing a call site. The author concludes for an adaptive router keyed on task class, model and lexical noise. Preliminary, not peer-reviewed. This is the closest published match to the atlas result and agrees with it in direction.
- S4, arXiv 2408.03910, CodexGraph (Liu et al., NAACL 2025 per the ACL Anthology listing seen in search). Fetched abstract: graph-database interface for code repositories, evaluated on CrossCodeEval, SWE-bench and EvoCodeBench, "competitive performance"; the abstract gives no numbers and states it is work in progress. It does not compare against grep.
- S7, arXiv 2503.09089, LocAgent (Chen et al.; ACL 2025 per search). Fetched abstract: graph-guided agents for code localisation; a fine-tuned 32B model reaches up to 92.7% file-level accuracy at about 86% lower cost than proprietary models, and issue resolution improves 12% at Pass@10. Python (SWE-bench Lite) only per search summaries; the comparison is against other agents, not grep.
- S5, Cursor, "Improving agent with semantic search" (first party, `cursor.com/blog/semsearch`). Fetched: on average 12.5% higher accuracy (6.5% to 23.5% by model) on an offline codebase-retrieval benchmark; online A/B code retention up 0.3% overall and 2.6% on codebases with 1,000 or more files; 2.2% more dissatisfied follow-ups without it. This is embedding search used beside grep, not a graph tool, on Cursor's own benchmark.
- S2, Anthropic first-party position on agentic search over a vector index: I could not fetch a primary. Search results attribute to a Claude Code developer a statement (Hacker News, February 2025; X, February 2026) that agentic search worked better than a local vector database; only secondary pages were seen. Treat as unverified.
- S6, CodeGraph's own benchmark and product pages, a Product Hunt post for another graph tool, a Glama listing for GraphPilot: vendor or author claims of 23-64% token savings, 61% fewer tokens, and graph tools needing fewer tokens on structural questions; seen in search results only, not fetched, small task sets, self-reported. Listed only because they say savings grow with repo size and that grep stays cheaper on simple lookups, which is the pattern in this eval.
- Aider's repo map (`aider.chat/docs/repomap.html`, fetched): a ranked map of files and symbols sized to a token budget (`--map-tokens`, default 1k), partial by design; the page gives no measured results. The local test of it (`free-alternatives.md`) found the model ignored the map.

### 3.2 Repository-level benchmarks

- SWE-agent (arXiv 2405.15793, NeurIPS 2024, fetched abstract): interface design changes agent performance without changing the model; 12.5% on SWE-bench and 87.7% on HumanEvalFix at the time. Supports that tool and interface design matters; says nothing on graph tools versus grep.
- SWE-QA (arXiv 2509.14635; ACL Findings 2026 per search) and SWE-QA-Pro (arXiv 2603.16124, fetched abstract): repository-level code question answering. SWE-QA-Pro uses long-tail repositories to reduce memorisation and reports agentic workflows beat direct answering by roughly 13 points for Claude Sonnet 4.5. These are agent-versus-no-agent comparisons; they do not isolate a graph tool from grep. Search only for SWE-QA counts (576 or 720 question pairs, version-dependent).
- Multi-SWE-bench (arXiv 2504.02605, NeurIPS 2025; search only): Java, TypeScript, JavaScript, Go, Rust, C, C++; the abstract says LLMs that do well on Python generalise less well to other languages and degrade on cross-file issues. I did not see per-language numbers.
- RepoBench, CrossCodeEval, CodeSearchNet-style and long-context code QA: I did not fetch these. No benchmark on caller, implementer or impact questions with oracle keys was found that compares a code graph with grep. That gap is why this eval used a compiler-derived oracle, and it means there is no external base rate to compare the 0.80/0.75 accuracy against.

### 3.3 Tool adoption, skills and routing

- S3 (above): agents defaulted to grep on symbol-named tasks and used the LSP about half the time on reference tasks. This eval: atlas called in 34-38% of sessions, in 100% of `impact`, about 93% of `abstain` and 0% of `emit` (registered run).
- Agent Skills documentation (`agentskills.io/skill-creation/optimizing-descriptions`, fetched): the description is the primary trigger; "agents typically only consult skills for tasks that require knowledge or capabilities beyond what they can handle alone"; recommends imperative, "pushy" descriptions and measuring a trigger rate over several runs. Consistent with 0 of 450 sessions loading the skill body: the questions were answerable with Bash.
- Claude Code skills documentation (`code.claude.com/docs/en/skills`, fetched, truncated at 100,000 of 110,500 characters): descriptions are in context by default and capped at 1,536 characters per entry; the body loads only on invocation; `disable-model-invocation` and `skillOverrides` control exposure. The page does not describe hooks as a way to make Claude load a skill.
- Claude Code hooks documentation (`code.claude.com/docs/en/hooks`, fetched, truncated at 100,000 of 269,866 characters): PreToolUse hooks can deny a call with a reason the model sees, and can add context; I could not confirm from the excerpt whether context is delivered on a denied call. A hook-based redirect from shell search to an atlas tool is therefore a documented mechanism, but it changes what is measured (option C).
- Anthropic, "Writing effective tools for agents" (`anthropic.com/engineering/writing-tools-for-agents`, fetched): tool-description refinement is among the most effective methods for improving tools; more tools do not always help and overlapping tools distract; Claude Code caps tool responses at 25,000 tokens by default; concise response modes use fewer tokens (72 against 206 tokens in the post's example); track tool calls, tokens and errors. Matches `diagnosis.md` section 7 causes 2 and 3 (large `code_refs` and `code_impact` payloads, low routing).
- MCP deferral: the Claude Code MCP page (`code.claude.com/docs/en/mcp`, fetched, truncated) mentions tool search as the default way tool definitions are loaded, with exceptions (`ENABLE_TOOL_SEARCH=false`, older models). I could not read the section that gives thresholds. Whether the eval's `--tools Bash,Read` plus `--strict-mcp-config` harness had deferral active is not established by anything I read; it is a lead to check in the session init event, not a finding.
- Vendor and community figures on MCP definition overhead (a median of about 2,064 tokens per server across 3,875 servers, a GitHub MCP server at about 42,000 tokens, code-execution reducing input tokens 78.5%) were seen in search results only and are not relied on.
- arXiv 2609.29454 (smart-contract audit skills, fetched): skill triggering is described as "a key bottleneck", with effectiveness depending mainly on the model. Different domain; cited only for the triggering finding.

### 3.4 Token cost of agentic search

- First-party numbers on grep-only agentic search cost were not found. The Zilliz post "Why I'm Against Claude Code's Grep-Only Retrieval" and similar pages claim grep burns tokens; they are vendor-adjacent and were not fetched.
- S3 measures tokens-to-success directly and finds LSP tools do not reduce tokens on name-addressed localisation. This eval's grep arm is cheap for the same reason (3.5 tool calls).
- Anthropic's tools post and Claude Code's 25,000-token tool-result cap bear on payload design (section 3.3).

### 3.5 Language dependence, indexers and the SDK half

- Typed versus dynamic: no controlled study found. Multi-SWE-bench's abstract (search only) is the only cross-language statement seen.
- Swift: SwiftEval (arXiv 2505.24324, search only) is a Swift-specific code generation benchmark of 28 problems and 44 models; it concerns language features, not code navigation or SDK drift. A SwiftUI fine-tuning paper (UICoder) was seen only through a news summary with figures I could not confirm, and I do not use them. No evidence on Swift caller or reference tools was found. The repository's own stack document records tree-sitter-swift parse failure of 11.8% and 6.9% on two real codebases for release 0.7.3 (`.claude/CLAUDE.md` Finding 4), which is local evidence that Swift is harder for a grammar tier.
- C++: the clangd installation page (`clangd.llvm.org/installation`, fetched) says clangd needs build flags, usually from `compile_commands.json`; without it clangd assumes plain `clang` and gives spurious missing-include errors; a `compile_flags.txt` fallback disables background indexing. A Chromium clangd page (search only) adds that generated headers need a build first. This is first-party evidence that C++ navigation depends on the build system; it supports the project's "no build" premise being harder for C++, and says nothing about token cost.
- SCIP: the Sourcegraph announcement (`sourcegraph.com/blog/announcing-scip`, fetched) reports a 10x CI speedup replacing lsif-node with scip-typescript ("not due to the protocol alone"), LSIF about 4x larger gzip-compressed, indexers built on each language's compiler tooling (`scip-typescript` on the TypeScript checker, `scip-java` on compiler plugins). That supports build-system and compiler dependence for precise indexers. It contains no agent-accuracy data.
- Platform-API staleness: arXiv 2406.09834 (fetched abstract and part of the HTML): seven LLMs, 145 API mappings from eight Python libraries, 28,125 completion prompts; the deprecated-usage rate across models was reported by the fetch tool as about 25% to 38% (24.9% to 37.4%), which I could not cross-check against the table, so treat the exact figures as unverified; the `ReplaceAPI` fix produced the replacing API in 85.2% to 99.6% of cases for open-source models and `InsertPrompt` in 25.7% to 97.2% across all seven. This is evidence that models emit deprecated APIs at material rates and that supplying API-evolution information changes completions. It is Python libraries, not Apple SDKs, and it measures completions, not agent answers. arXiv 2503.22821 (API misuse taxonomy) and arXiv 2601.19106 (deterministic AST check for knowledge-conflicting hallucinations) appeared in search only.
- No published study of Apple SDK availability retrieval (introduced or deprecated OS versions) was found. The product claim for the SDK half (an agent told the real availability of an API even where no SDK is installed) is therefore untested externally and is not tested by the gsd-core eval, whose corpus has no platform SDK. Grep over a repo cannot return OS-version facts that are not in the repo; that is a design argument, not a measured result.

## 4. Recommendation (agent's judgement; the decision is the user's)

Ranked, with the first three being cheap or free:

1. Write the claim honestly now (option E). State in the README and roadmap what the registered result shows: accuracy non-inferior, citations equal in both arms, tokens higher, MVP not met, with the replication as supplementary agreement. It costs documentation time and removes the pressure to fit later work around the number.
2. Run unscored, non-corpus probes to find out whether H2 is attainable at all, before registering anything (cost under about 10 USD notional in total, my estimate). (a) Measure the atlas arm's per-turn fixed context with the one-turn probe method of `skill-visibility.md`, with the seven tools, with only `code_find`, `code_refs` and `code_impact` (the three that were called), and with tool definitions deferred if the harness allows it. (b) Test on fresh questions, not the 75 scored ones, whether a routing rule or a hook raises the call rate and whether an atlas call replaces shell calls. (c) Cap and compact `code_refs` and `code_impact` payloads (mean 4,656 and 7,700 bytes in the raw streams). The arithmetic is unforgiving: with about 15,200 tokens of the 17,982-token gap explained by fixed per-turn context, even removing all of it leaves atlas at parity on gsd-core; fewer tokens needs an atlas call to replace multiple grep turns, and grep sessions here average 3.5 calls.
3. Decide, before any new data, whether "fewer billable tokens on gsd-core" is the right 1.0 gate. If the user keeps it, option A or B is the honest path. If the user judges that the product's value lies in cited structural facts, SDK availability and larger or harder repositories, register that gate in advance (option D) on a new question set or corpus, with reasons that do not depend on the observed 1.6x; the old verdict and its replication are cited, not replaced.
4. If a re-run is wanted, prefer option B over repeating gsd-core: a corpus where grep is expensive (larger, more ambiguous names), fresh questions drawn with the same oracle, a registered line-per-item answer schema applied to both arms, 75 questions x 3 runs x 2 arms (about 16 USD notional or more, 6 to 7 h), with the fixes from step 2 frozen first. Draw new questions so the redesign is not tuned on questions already analysed (D-23).
5. Treat option F as a legitimate separate decision, not a substitute for steps 2 to 4. Phases 4 and 5 are technically independent of the eval result per the roadmap's own text, so work on Host hardening is not wasted if the product continues, but D-04 was written as a hard gate and the existing documents offer no waiver mechanism. If the user chooses F, record it as a dated decision that leaves the verdict "not met" and name the open claim in the Phase 4 context. I have not checked what Phase 4's own plans assume about the eval outcome.

What would change my mind:

- If the one-turn probes show the fixed context can be cut to under about 1,000 tokens per turn and a call replaces at least one shell call in most routed sessions, a re-run on gsd-core (option A) becomes reasonable and cheaper to justify than a new corpus.
- If forced routing raises calls to near 100% and tokens still rise 1.5x or more, the token claim is unlikely to be met on any name-addressable corpus and I would move toward D plus G (redefine the gate in advance, defer the token claim to EVL-04).
- If a larger-corpus run shows a falling atlas/grep ratio with grep cost that survives replication (the registered run's quartile pattern did not replicate here), the "small corpus" explanation gains weight and option B moves to first.
- If the 11 always-wrong questions turn out to be key defects, accuracy figures for both arms are understated and a key review (diagnosis item 5) comes before any run.
- If the emit gain reproduces with atlas tools disabled but the skill description present, the gain belongs to the description and the product framing (what is measured) changes.
- If a published, controlled study appears that compares graph tools with grep on caller or impact questions, it should replace sections 3.1 and 3.2, which are thin.

## Sources (accessed 2026-10-21)

Local files (repository, this worktree): `docs/eval/analysis.md`, `docs/eval/diagnosis.md`, `docs/eval/preregistration.md`, `docs/eval/pilot.md`, `docs/eval/skill-visibility.md`, `docs/eval/questions-review.md`, `docs/eval/free-alternatives.md`, `docs/eval/results/results.jsonl`, `docs/eval/results-cleanroom/{comparison.md,analysis-cleanroom.md,results.jsonl}`, `.planning/phases/03-typescript-module-and-mvp-eval/{03-CONTEXT.md,03-POST-EVAL-FIXES.md}`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`. `docs/eval/replication-cleanroom.md` was not read; the 15.5 USD and about 6.5 h replication figures come from `comparison.md` (cost) and the task brief (time).

| Id | Source | URL | Read |
| --- | --- | --- | --- |
| S1 | SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering | https://arxiv.org/abs/2405.15793 | fetched |
| S2 | Claude Code "agentic search instead of RAG" (secondary summaries only; primary not fetched) | https://zilliz.com/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens | search result only, not fetched |
| S3 | Does a Language Server Save Tokens for Coding Agents? | https://arxiv.org/abs/2608.13568 | fetched |
| S3b | Blog post on the same study (no numbers on page) | https://www.agentconnect.md/blog/grep-beat-lsp-harness/ | URL from a fetched page; not itself fetched |
| S4 | CodexGraph | https://arxiv.org/abs/2408.03910 | fetched |
| S5 | Cursor, Improving agent with semantic search | https://cursor.com/blog/semsearch | fetched |
| S6 | CodeGraph and other vendor benchmarks | https://pypi.org/project/awgraph/ and other pages from search | search result only, not fetched |
| S7 | LocAgent | https://arxiv.org/abs/2503.09089 | fetched |
| S8 | SWE-QA | https://arxiv.org/abs/2509.14635 | search result only, not fetched |
| S9 | SWE-QA-Pro | https://arxiv.org/abs/2603.16124 | fetched |
| S10 | Multi-SWE-bench | https://arxiv.org/abs/2504.02605 | search result only, not fetched |
| S11 | Anthropic, Writing effective tools for agents | https://www.anthropic.com/engineering/writing-tools-for-agents | fetched |
| S12 | Agent Skills, Optimizing skill descriptions | https://agentskills.io/skill-creation/optimizing-descriptions | fetched |
| S13 | Claude Code, Skills | https://code.claude.com/docs/en/skills | fetched, truncated |
| S14 | Claude Code, Hooks | https://code.claude.com/docs/en/hooks | fetched, truncated |
| S15 | Claude Code, MCP | https://code.claude.com/docs/en/mcp | fetched, truncated |
| S16 | Agent skills for smart contract auditing | https://arxiv.org/abs/2609.29454 | fetched |
| S17 | Aider, Repository map | https://aider.chat/docs/repomap.html | fetched |
| S18 | clangd, Installation | https://clangd.llvm.org/installation | fetched |
| S19 | Sourcegraph, Announcing SCIP | https://sourcegraph.com/blog/announcing-scip | fetched |
| S20 | LLMs Meet Library Evolution (deprecated APIs in code completion) | https://arxiv.org/abs/2406.09834 | fetched (abstract and part of HTML) |
| S21 | API misuse in LLM-generated code | https://arxiv.org/abs/2503.22821 | search result only, not fetched |
| S22 | Hallucinations in LLM-generated code, AST correction | https://arxiv.org/abs/2601.19106 | search result only, not fetched |
| S23 | SwiftEval | https://arxiv.org/abs/2505.24324 | search result only, not fetched |
| S24 | Chromium clangd documentation | https://chromium.googlesource.com/chromium/src/+/master/docs/clangd.md | search result only, not fetched |

## Limits

- The fetch tool answers through a small model; quoted numbers are as it returned them. Items marked "search only" or "not fetched" were not read at the primary and carry only search-snippet reliability. I did not retrieve full papers beyond abstracts except part of S20.
- S3 is a single-author preliminary study and its date and identifier look inconsistent; I could not check its repository (`Poytr1/lsp-vs-grep-token-study`).
- I could not verify the Anthropic statements on why Claude Code dropped a vector index; only secondary pages were seen.
- The local bootstrap uses Python's random generator, not the registered mulberry32, so intervals reproduce the registered ones closely but not bit for bit. Pooled and replication-side extra statistics (quartiles, used versus unused accuracy, always-wrong question list) are my computations from the compact rows, are exploratory, and are not registered analyses. Sessions are clustered by question and the sign tests treat them as independent, so those p-values are descriptive.
- Corpus counts come from a local clone of gsd-core read at the pinned commit; they were not cross-checked against the registered preparation record beyond the file count agreeing with `free-alternatives.md`.
- I did not read `docs/eval/replication-cleanroom.md`, `docs/reference/alpha-limitations.md`, the freezer code, or Phase 4's own plans; claims about what they say or allow rest on the files listed above.
- Cost figures are notional API-equivalent costs from the analyses; Max-plan allowance use is not recorded anywhere I read. Estimates for other corpora and for probes are extrapolations from per-session costs and are labelled as such.
- Nothing in this note was used to select, change or score any registered question, key or result, and the result files were read only.
