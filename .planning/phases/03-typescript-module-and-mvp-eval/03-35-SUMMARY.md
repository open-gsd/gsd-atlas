---
phase: 03-typescript-module-and-mvp-eval
plan: 35
subsystem: eval
status: complete
evaluation-status: MVP not met
note: "Scored run complete (450 of 450 cells, 0 infrastructure failures, 0 contaminated). Registered analysis: accuracy non-inferior, tokens not fewer, citations below threshold; OVERALL MVP not met. Diagnosis committed; Phase 4 is blocked until a new registered run meets the gate (D-04)."
tags: [eval, scored-run, projection, checkpoint, verdict, diagnosis]
key-files:
  created:
    - docs/eval/analysis.md
    - docs/eval/diagnosis.md
    - docs/eval/results/results.jsonl
    - docs/eval/results/sessions.meta.jsonl
    - docs/eval/results/attempts.jsonl
---

# Phase 3 Plan 35: Scored Eval Run (complete; verdict MVP not met)

**Evaluation status: MVP not met.** The pre-registered scored run executed in full and the registered analysis (`docs/eval/analysis.md`, `OVERALL: MVP not met`) found accuracy non-inferior (atlas 0.8000, grep 0.7511, 5th percentile of the paired bootstrap +0.0133 against the -0.05 margin), tokens not fewer (atlas 47,375.1 against grep 29,393.1 billable tokens per session; paired difference +17,982.0, 95th percentile +20,709.4 against a required value below zero), and citations below threshold (atlas 144 of 198 sessions, 72.7 percent, against 80 percent on the registered point estimate). A miss is a result: nothing registered was changed, no cell was rerun and no session was dropped. The diagnosis is in `docs/eval/diagnosis.md`. Phase 4 is blocked until a new registered run meets the gate (D-04). The final section ("Final result") records the run and the analysis; the sections before it are the in-progress record, kept as written.

This file first recorded Task 1 (pre-run integrity checks and the projection) and the chunked Task 3 progress; the final section was added by the continuation that completed the run.

## Task 1 record (2026-10-18)

- Base: HEAD `8a665e905d927ee8a14ece363006d081cb434983` (the wave 14 tracking commit; merge `47d8b2b` is an ancestor; equals `main`).
- `node scripts/eval/verify-prereg.ts` (with Claude Code 2.1.302 first on PATH): `verify-prereg: ok`, exit 0.
- `git status --short`: empty before and after `npm ci --ignore-scripts && npm run build` (both succeeded, 0 vulnerabilities).
- Registered `stageB.atlasCommit` `37b12e32bf84f9ca1a4052c7d574ebc1aa0fe207` is an ancestor of HEAD; `git diff --stat` from it to HEAD over `src modules schemas diagnostics package.json package-lock.json tsconfig.json tsconfig.build.json scripts/eval skills` prints nothing (the only changes since are the 03-38 summary, ROADMAP.md and the Stage B status line in `docs/eval/preregistration.md`).
- Prepared corpus (`prepare-corpus.ts --corpus gsd-core`, `npm ci --ignore-scripts`, throwaway directory) against the registered record: sha `10ac3a7a947903ba50f538a907af036744d759d5` (equal), `npmCi: true` (equal), `node_modules/typescript` 6.0.3 (equal), `package-lock.json` sha256 `dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb` (equal). No difference.
- `harness plan --scored` (dry, no session): `mode: scored`, 75 questions, 450 cells (atlas 225, grep 225), 3 runs, seed 20261017, concurrency 2, model `claude-sonnet-5-5`, budget 3 USD, wall clock 900000 ms, atlas arm tools `Bash,Read,Skill`, grep arm `Bash,Read`, `gate: ok (preregistration Frozen, Stage B, registered files and skill unchanged, atlas build matches the Stage B commit)`. First ten cells: `q-029|grep|2`, `q-029|atlas|2`, `q-034|grep|1`, `q-034|atlas|1`, `q-066|grep|1`, `q-066|atlas|1`, `q-028|atlas|2`, `q-028|grep|2`, `q-071|grep|2`, `q-071|atlas|2`.
- `claude auth status` (no model call): logged in, claude.ai authentication, first-party provider. The plan's precondition ping (`claude -p "Reply with the single word ok."`) was not run, to keep this segment at 0 USD of model spend; the checkpoint asks the human to confirm the sign-in.
- Spend in this segment: 0 USD of model usage (no `claude -p` session was started).
- Nothing under `scripts/eval`, `skills` or `docs/eval/preregistration.md` was modified.

## Projection (an estimate, not a quote)

`harness project --out-dir docs/eval/pilot --questions 75 --runs 3` prints, from the 10 pilot sessions (Phase 2 atlas, no skill visible): atlas 0.0312 USD per session x 225 = 7.03 USD; grep 0.0250 x 225 = 5.63 USD; total 12.66 USD for 450 sessions; mean wall 7.1 s per session. The pilot paired sd is 0.0000 (5 questions that agreed), so it gives no power information. The pilot's own text calls this figure a floor, and since then the atlas arm changed: it carries the visible skill description (about +977 input tokens per turn, `docs/eval/skill-visibility.md`) and now the precise tier returns real results.

The only measurement of the final atlas arm is the unscored smoke run of plan 03-38 (3 easy pilot questions x 2 arms x 1 run, 0.2588 USD): atlas mean 0.0487 USD per session (billable 161,145 tokens in three sessions) against grep 0.0375 (90,819). Cost per session was 1.30x grep's, billable tokens 1.77x. On the same three questions the pilot's atlas mean was 0.0294, so the final atlas arm cost 1.66x the pilot's atlas arm; grep 1.15x its pilot figure (cache warmth makes single sessions noisy). The skill body was loaded 0 of 3 times.

| Basis | Atlas arm | Grep arm | Total, 450 sessions |
| --- | ---: | ---: | ---: |
| Floor: pilot per-session means (`project` output) | 7.03 | 5.63 | 12.66 USD |
| Smoke per-session means (final atlas arm, easy questions) | 10.96 | 8.44 | 19.4 USD |
| Planning figure: smoke x 1.5 for the harder scored mix (callers 17, emit 10, adr 10, abstain 9, impact 6 ...) | about 17.5 | about 12.7 | **30 USD** |
| High case: smoke x 3 | about 33 | about 25 | about 58 USD |

Projected cost range: 13 USD (floor) to about 58 USD (high), planning figure 30 USD. The 125 percent stop is measured against the planning figure: 37.50 USD (`--stop-at-cost-usd 37.5`). Every session is bounded by the registered 3 USD; the worst case is bounded by the stop (plus at most two in-flight sessions, 6 USD). The authentication is a claude.ai plan, so the cost is the usage the harness reports, and plan rate limits are the more likely interruption than the cost.

Projected wall time at the registered concurrency 2: sessions plus the atlas index build (about 5.9 s per atlas session, outside the token count, run before the session clock). Pilot basis: 450 x 7.1 s + 225 x 5.9 s = about 75 min sequential, about 40 min at concurrency 2 (a floor, easy questions). Planning basis (25 s per session): about 3.5 h sequential, about 1.75 h at concurrency 2. High case (60 s per session): about 8 h sequential, about 4 h at concurrency 2. Retries wait 60 s each and rate-limit pauses add to this. Expect 1.5 to 3 hours, with 4 hours as the high end.

## The command that Task 3 will run (not executed here)

Claude Code 2.1.302 must be the `claude` on PATH for every `node` command that runs or checks the harness (the installed 2.1.303 is refused by the scored gate): the scratch directory `.../scratchpad/claude-2.1.302-bin/` holds a `claude` symlink to `/Users/trekkie/.local/share/claude/versions/2.1.302`. Only `node` commands are prefixed.

```
PATH="<scratch>/claude-2.1.302-bin:$PATH" node scripts/eval/harness.ts run --scored \
  --questions scripts/eval/questions/gsd-core.questions.json \
  --answers scripts/eval/questions/gsd-core.answers.json \
  --corpus-dir <scratch>/prep/gsd-core-O0deib --out-dir <scratch>/run \
  --arms atlas,grep --runs 3 --concurrency 2 --seed 20261017 --model claude-sonnet-5-5 \
  --prereg docs/eval/preregistration.md --stop-at-cost-usd 37.5
```

`<scratch>` is `/private/tmp/claude-501/-Users-trekkie-projects-gsd-atlas/38c0b34a-c419-49e3-bc93-62fb2dc2512b/scratchpad`. The scored gate checks that `dist/` matches the registered atlas build, so the run must be started from a checkout where `npm ci --ignore-scripts && npm run build` has been run at this commit (this worktree has it).

## What the verdict measures (for the analysis)

The atlas arm is the atlas tools together with a visible, loadable `gsd-atlas` skill (Revision 1 of the pre-registration); its description tokens, and the body's whenever a session loads it, are billable to the atlas arm and never subtracted. A result is a result for `tools plus visible skill` and is not split between the two. The committed rows show how often atlas-arm sessions loaded the skill (`toolCallsByName.Skill`).

## Task 2 (checkpoint) decision record (2026-10-18)

The human's replies at the blocking-human cost checkpoint, verbatim, in order:

1. (a) "is there a way to do this in my existing plan without me having to dump money"
2. (b) "i need a cost free way to do this, can we use a local model to just get the measurements."
3. (c) "if you can get the info and extrapolate the costs that is fine to use usage I do not want to pay api costs"
4. (d) "again i do not want to spend any moeny, you can run and get the toekn numbers and extrapolate the cost from those i will not pay for active usage of the api"

The reply is not the literal word "start". The orchestrator's reading, adopted here: the user authorises `start` on their claude.ai Max subscription (no API key; `authMethod` claude.ai, `subscriptionType` max, `ANTHROPIC_API_KEY` unset), run in CHUNKS, with no paid API usage. The dollar figures the harness prints are Claude Code's notional API-equivalent costs, used as a guard and as the unit of the extrapolation; the user does not want any real charge. A local model was not used: the registered design fixes the model (`claude-sonnet-5-5`) and no local model can be measured in its place without a new registration. The user was told that the "extra usage" (pay beyond the plan limit) setting cannot be verified from here and was asked to check that it is off; they did not confirm. Chunk 1 is therefore deliberately small (stop line 5 USD notional against the 37.5 USD registered-run stop), so it cannot approach a Max usage limit. Each chunk ends at the harness cost stop and the next chunk needs a new go-ahead.

Nothing registered changes: `--stop-at-cost-usd` is a harness-side flag of the run, not a registered parameter (the registered 3 USD per-session budget and 900000 ms wall clock are unchanged). The results directory is shared by the chunks, so the cells are the registered seeded order's prefix and the cost stop counts what is already on disk.

Environment check before chunk 1 (names only, no values printed): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID` all unset; `claude --version` 2.1.302 from the scratch symlink; `claude auth status`: loggedIn, authMethod claude.ai, apiProvider firstParty, subscriptionType max. This worktree: `npm ci --ignore-scripts && npm run build` done, `verify-prereg: ok`, `plan --scored` prints `gate: ok`, 450 cells.

## Task 3 progress: chunk 1 (2026-10-18/19)

Command: the registered one from the section above, with `--stop-at-cost-usd 5` instead of 37.5 (a harness-side flag, not a registered parameter). Claude Code 2.1.302 on PATH, results in `<scratch>/run` (`results.jsonl`, `attempts.jsonl`, `sessions.meta.jsonl`, `streams/`; 4.3 MB, not committed: a partial run is not a result). Base for the run: tree at `95f9e8f`, built at this commit, `verify-prereg: ok` and `gate: ok` immediately before. No analysis (`analyze.ts`) was run and no verdict exists; the tables below are descriptive counts of a partial run.

- Cells: 130 of 450 done (atlas 65, grep 65), 65 (question, run) groups, every group complete in both arms, 50 distinct questions. Wall time 1,094 s (18.2 min), 0 resumes, 0 contaminated, 0 prep failures, 0 infrastructure failures, 0 retries (130 attempts for 130 cells), 0 rate-limit messages. Harness ended with `cost stop at 5 USD reached; no further session was started` (exit 1 is that stop, not an error); cost on disk 5.0251 USD notional, so the overshoot past the line was 0.0251 (two in-flight cells). The harness is waiting for a go-ahead: the same command with a higher `--stop-at-cost-usd` continues at cell 131.
- Order and representativeness: `makeSchedule` (`scripts/eval/schedule.ts`) puts the two arms of each (question, run) group adjacent in random order and shuffles the 225 groups with the registered seed; `run` takes cells in that order. This chunk is therefore the first 130 cells of the registered order: a seeded random subset of groups, both arms always paired, not a prefix by question id or category. Category mix of the chunk (cells per arm) against the full set (questions x 3 runs): callers 16 (51), adr 12 (30), references 8 (24), heritage 8 (24), emit 6 (30), impact 6 (18), definition 5 (21), abstain 4 (27). It under-samples abstain and emit, which are cheap-to-medium, so a category-reweighted figure is given as a check.

| Per arm | n | ok | correct (key) | input | output | cache write | cache read | billable (sum of all four) | notional USD | mean billable / session | mean USD / session | mean tool calls | mean wall s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| atlas | 65 | 65 | 52 | 460 | 46,099 | 496,518 | 2,669,371 | 3,212,448 | 2.7149 | 49,422 | 0.04177 | 3.88 | 8.23 |
| grep | 65 | 65 | 52 | 478 | 46,755 | 419,112 | 1,652,092 | 2,118,437 | 2.3102 | 32,591 | 0.03554 | 3.75 | 8.18 |

Billable follows the registered definition (input + output + cache creation + cache read, D-06; cache reads are 83 percent of atlas and 78 percent of grep billable tokens). Paired over the 65 groups: atlas billable / grep billable 1.52, atlas cost / grep cost 1.18, atlas used fewer billable tokens in 6 of 65 pairs, the arms disagreed on correctness in 4 groups (2 only atlas correct, 2 only grep correct). Descriptive only, not the registered test.

Atlas arm behaviour (counts, not a verdict): an atlas tool was called in 25 of 65 sessions (27 calls in total); the `gsd-atlas` skill body was loaded (`toolCallsByName.Skill`) in 0 of 65, as in the 03-38 smoke run; the other 40 atlas sessions used only Bash and Read, so they paid for the atlas tool definitions and the skill description on every turn without using them. Per-category means (notional USD per session, atlas / grep): callers 0.0536 / 0.0490, references 0.0319 / 0.0280, heritage 0.0285 / 0.0207, emit 0.0521 / 0.0365, adr 0.0309 / 0.0286, impact 0.0829 / 0.0673, definition 0.0212 / 0.0181, abstain 0.0221 / 0.0196. Atlas was dearer in every category.

Extrapolation to 450 cells (225 sessions per arm; method: chunk mean per session x 225, with a 95 percent interval from a cluster bootstrap that resamples the 50 questions with all their rows, 4,000 draws; the dollar unit is Claude Code's notional API-equivalent cost, not a charge):

| Basis | Atlas | Grep | Total 450 sessions | Billable tokens, total |
| --- | ---: | ---: | ---: | ---: |
| Point estimate | 9.40 USD | 8.00 USD | **17.4 USD** | 18.45 M |
| Category-reweighted to the full set's question mix | 9.20 USD | 7.74 USD | 16.9 USD | 18.1 M (atlas 48,503 / grep 31,762 mean per session) |
| 95 percent interval (question bootstrap) | 7.95 to 10.95 | 6.77 to 9.39 | 14.8 to 20.2 USD | 15.4 M to 21.9 M |

Reading: expect about 17 USD notional for the whole run (range 15 to 20), against 13 to 58 projected before the run and a 30 USD planning figure; the first chunk is cheaper than the planning figure by 40 percent. The remaining 320 cells would cost about 12.4 USD notional (about 2.5 further chunks of 5 USD) and about 45 min of wall time at the observed 8.4 s per cell with concurrency 2 (the whole run about 63 min, against 1.5 to 3 h projected). The chunk is a random subset of the registered order with every group paired, and the reweighting moves the figure by 3 percent, so the representativeness risk is small; the main remaining uncertainty is the question mix of the unseen 320 cells (abstain and emit are under-sampled) and cache warmth.

Subscription note: the run stayed on the claude.ai Max login (no API key in the environment); no usage-limit or rate-limit message appeared. The notional 5.03 USD is the only measure of usage available; how much of the Max allowance it used is not reported by the harness.

## Chunk 2 decision record (2026-10-19)

The human's reply at the chunk 1 boundary, verbatim: "go for chunk 2". Reading: continue the registered run with the harness cost stop raised to 10 USD notional (about cell 260 of 450); same constraints as chunk 1 (claude.ai Max subscription, no API key, no paid API usage). Environment re-checked before launch (names only): the nine API/Bedrock/Vertex/Foundry variables unset; `claude auth status` loggedIn, claude.ai, firstParty, max; 130 cells on disk; `git diff --stat 37b12e3..HEAD` over the build inputs empty; fresh `npm ci --ignore-scripts && npm run build` in this worktree. Rate-limit rule: any `infrastructureFailure` in this chunk stops the work with nothing deleted or edited.

## Task 3 progress: chunk 2 (2026-10-19)

Command: the registered one with `--stop-at-cost-usd 10`, same `--out-dir` (130 cells already on disk, skipped), Claude Code 2.1.302 on PATH, built at this worktree after a fresh `npm ci --ignore-scripts && npm run build`, `verify-prereg: ok`, clean tree, no change to the build inputs since `37b12e3`. No analysis (`analyze.ts`) was run and no verdict exists; the figures are descriptive counts of a partial run.

- Cells: 155 new, 285 of 450 done (atlas 142, grep 143; the stop fell between the two members of the last pair, so one grep cell has no atlas partner yet), 69 distinct questions. Wall time 1,276 s (21.3 min) for the chunk. 0 infrastructure failures, 0 retries (285 attempts for 285 cells, all `status: ok`), 0 contaminated, 0 rate-limit or usage-limit messages. The harness ended with `the cost stop at 10 USD was reached; no further session was started` (exit 1 is that stop); cost on disk 10.0265 USD notional. The harness is waiting for a go-ahead: the same command with a higher `--stop-at-cost-usd` continues at cell 286.

| Per arm | n | correct (key) | input | output | cache write | cache read | billable | notional USD | mean billable / session | mean USD / session |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| atlas, chunk 2 | 77 | 61 | 500 | 44,952 | 496,375 | 2,765,834 | 3,307,661 | 2.7126 | 42,957 | 0.03523 |
| grep, chunk 2 | 78 | 57 | 508 | 45,155 | 419,261 | 1,591,957 | 2,056,881 | 2.2888 | 26,370 | 0.02934 |
| atlas, cumulative | 142 | 113 | 960 | 91,051 | 992,893 | 5,435,205 | 6,520,109 | 5.4275 | 45,916 | 0.03822 |
| grep, cumulative | 143 | 109 | 986 | 91,910 | 838,373 | 3,244,049 | 4,175,318 | 4.5990 | 29,198 | 0.03216 |

Paired (descriptive, not the registered test): chunk 2, 77 pairs, atlas/grep billable 1.62, cost 1.19, atlas fewer in 4 pairs, only atlas correct 5, only grep correct 0, both wrong 16. Cumulative, 142 pairs, billable 1.57, cost 1.19 (1.18 after chunk 1), atlas fewer in 10, only atlas correct 7, only grep correct 2, both wrong 27.

Atlas arm behaviour: an atlas tool was called in 31 of 77 sessions in this chunk (34 calls), 56 of 142 cumulative (61 calls); the `gsd-atlas` skill body was loaded in 0 of 142.

Extrapolation to 450 cells (chunk-mean per session x 225 per arm; 95 percent interval from a question-cluster bootstrap, 4,000 draws, on the 285 cumulative rows): atlas 8.60 USD, grep 7.24, total **15.8 USD** (13.8 to 18.3), 16.9 M billable tokens (14.5 to 19.8 M); category-reweighted to the full question mix 16.3 USD, 17.4 M. The remaining 165 cells cost about 5.3 to 5.8 USD notional and about 23 min of wall time at 8.2 s per cell; one more chunk with a stop line of at least 17 USD (for example 20) finishes the run. The dollar unit is Claude Code's notional cost, not a charge.

## Chunk 3 decision record (2026-10-19)

The human's replies after chunk 2, verbatim and in order: "go finish" (before the stop); "stop the current chunking run" (the third launch was stopped by the user after 35 cells, 320 of 450 on disk, no process left running); then: "run the full chunk run collecting all data and use GSD_MEMTRACE_GUARD_OFF=1 to block the guard so it'll test atlas instead of be screwed up by the hook".

The orchestrator's reading, adopted here: resume and complete the remaining 130 cells with `--stop-at-cost-usd 20` (cumulative notional cost on disk was about 12 USD; about 5 to 6 USD more expected), then run the registered analysis. Same constraints as before: the claude.ai Max subscription, no API key, no paid API usage.

About `GSD_MEMTRACE_GUARD_OFF=1`: it is a human escape for the user's Memtrace-first PreToolUse hook and has to be exported in the shell that launches Claude Code; it is not self-issuable, and this executor did not set it or work around it (its own Bash and Read calls that touched indexed source were guarded and went through `codegraph` as the guard prescribes). It is also irrelevant to the scored sessions: the harness launches `claude` with `--setting-sources ""` and `--strict-mcp-config` (`scripts/eval/claude-session.ts`), so the user's hooks and MCP servers are not loaded in eval sessions. That claim was checked on all 450 streams (see "Hook-isolation re-check" below); it holds.

Environment check before the final launch (names only, no values printed): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_PROJECT_ID` all unset; `claude --version` 2.1.302 (scratch symlink); `claude auth status`: loggedIn, authMethod claude.ai, apiProvider firstParty, subscriptionType max. Worktree: merge of the previous executor's worktree was clean; `git diff --stat 37b12e3..HEAD` over `src modules schemas diagnostics package.json package-lock.json tsconfig.json tsconfig.build.json scripts/eval skills` printed nothing; fresh `npm ci --ignore-scripts && npm run build`; `verify-prereg: ok`; clean tree; `plan --scored` printed `gate: ok`, 450 cells.

## Final result (2026-10-19)

**Run.** The registered command with `--stop-at-cost-usd 20` and the same `--out-dir` finished with exit 0: `done: 130`, `skipped: 320`, `cost so far: 16.1142 USD`. Totals over the whole run: 450 of 450 cells (atlas 225, grep 225, 75 questions x 3 runs), 225 complete pairs, all 450 sessions `status: ok`, 0 failed, 0 contaminated, 0 infrastructure failures (`infrastructureFailure` is false on all 450 attempt records), 0 retries (450 attempts for 450 cells), 0 rate-limit or usage-limit messages in any chunk log. `harness summary`: 450 rows, no duplicate cell, "questions with both arms: 75".

**Resumes and wall time.** Four launches of the same command (first, then three resumes: the chunk 2 go-ahead, the launch the user stopped after 35 cells, and the final one): 130, 155, 35 and 130 cells in 1,093 s, 1,254 s, 285 s and 1,059 s of elapsed time, 3,690 s (61.5 min) in all; summed session wall time 1,779.8 s (atlas, mean 7.91 s) and 1,716.1 s (grep, mean 7.63 s), which at concurrency 2 is consistent with the elapsed time. Two harness cost stops fired (5 and 10 USD) and one run was stopped by the user. The interruption left the results file with complete lines only, and the resumed run skipped finished cells (no cell was run twice: 450 attempts, 450 cells). Planned 1.5 to 3 hours, observed about 1 hour.

**Cost and tokens (Claude Code's notional API-equivalent cost on the Max subscription; no charge, no API key).** Total 16.1142 USD (atlas 8.7419, grep 7.3723), against the planning figure of 30 USD and the extrapolations of 17.4 and 15.8 USD after chunks 1 and 2. Billable tokens (input + output + cache creation + cache read): atlas 10,659,389 (input 1,552; output 148,740; cache creation 1,589,865; cache read 8,919,232), grep 6,613,442 (input 1,560; output 146,847; cache creation 1,347,241; cache read 5,117,794), 17,272,831 in all.

**Registered analysis** (`node scripts/eval/analyze.ts docs/eval/results/results.jsonl --prereg docs/eval/preregistration.md --out docs/eval/analysis.md`, run on the committed rows, parameters read from the frozen block; exit 0):

| Criterion | Value | Result |
| --- | --- | --- |
| Accuracy (H1) | atlas 0.8000 (180 of 225), grep 0.7511 (169 of 225); observed difference +0.0489; paired cluster bootstrap 5th percentile +0.0133, 95th percentile +0.0889; rule: 5th percentile above -0.0500 | non-inferior |
| Tokens (H2, `upper-bound`) | atlas 47,375.1, grep 29,393.1 mean billable per session; paired difference per question +17,982.0, 5th percentile +15,435.1, 95th percentile +20,709.4; rule: 95th percentile below zero | not fewer |
| Citations (H3, `point_estimate`) | atlas 144 of 198 = 72.7 percent (Wilson 66.1 to 78.5); grep 146 of 198 = 73.7 percent; threshold 80.0 percent (159 sessions needed) | below threshold |
| Overall | `OVERALL: MVP not met` | MVP not met |

Tool-call rate and wall time (reported, not judged): 3.75 tool calls per atlas session and 3.50 per grep session; atlas tools were 11.0 percent of atlas tool calls; mean wall 7,910 ms and 7,627 ms.

**Diagnosis headline** (`docs/eval/diagnosis.md`; descriptive, separate from the verdict). An atlas tool was called in 86 of 225 atlas sessions (38.2 percent, 93 calls: `code_refs` 49, `code_find` 37, `code_impact` 7; the other four tools 0 times). The `gsd-atlas` skill body was loaded in 0 of 225 sessions. 94 percent of the token gap is cache read (+16,895 of +17,982 per session); the atlas context is about 3,200 tokens heavier per turn (a proxy), and the 139 pairs in which atlas was not called account for 65 percent of the gap, so the fixed cost of the tool definitions, server instructions and skill description outweighs any saving. Atlas was dearer in every category (billable ratio 1.36 to 1.86) and used fewer billable tokens than grep in 15 of 225 pairs. Accuracy was at or above grep's in every category (largest: emit +20.0 points, with no atlas call in any of its 30 sessions). The citation shortfall is the same in both arms and sits in ADR, impact and emit answers (answers with no line: 40 of 198 atlas sessions). 13 questions were wrong in both arms in every run.

**What this means.** The MVP gate of D-04 is not met: the claim "fewer tokens at non-inferior accuracy with at least 80 percent verifiable citations" holds for accuracy only. Phase 4 is blocked until a new registered run meets the gate. The proposals for that run are in `docs/eval/diagnosis.md` (section 9); none is applied here. This is a result for `tools plus visible skill` (Revision 1 of the pre-registration): the atlas arm's description tokens were counted and never subtracted, and the skill body was never loaded.

**Hook-isolation re-check (the Memtrace-first guard and `GSD_MEMTRACE_GUARD_OFF`).** Over all 450 raw streams (450 files, one per attempt): `codegraph` 0 files, `memtrace` 0, `MEMTRACE-FIRST` 0, `GSD_MEMTRACE` 0, `"subtype":"hook` 0, `hook_started` or `hook_response` 0. The system events present are `init` (450), `thinking_tokens` (608) and `permission_denied` (21: 5 atlas, 16 grep, shell commands refused because a variable could not be checked; no session failed because of one). The ten streams containing the string `PreToolUse` contain it only in repository source text printed by a tool (a function name or a documentation path in gsd-core), never as an event. The scored sessions therefore ran without the user's hooks, with or without the environment variable.

**Committed files.** `docs/eval/analysis.md` (the registered report), `docs/eval/diagnosis.md`, and `docs/eval/results/results.jsonl` (450 rows), `sessions.meta.jsonl` (456 lines: 450 session records, 4 run starts, 2 cost stops) and `attempts.jsonl` (450). The meta and attempts files had the scratch and temporary directory paths replaced by `<scratch>` and `<tmp>` (as in the pilot files); the rows are byte-identical to the run directory's. Checked before commit: no home directory path, no `/private` path and no mention of the word that names raw session text in any of the three files; no field of any row holds an answer text. **Raw results location (not committed):** `/private/tmp/claude-501/-Users-trekkie-projects-gsd-atlas/38c0b34a-c419-49e3-bc93-62fb2dc2512b/scratchpad/run` (`results.jsonl`, `attempts.jsonl`, `sessions.meta.jsonl`, `streams/` with 450 raw streams); the registered analysis recomputes from the committed rows alone.

**Prohibitions kept.** No registered file was changed (`verify-prereg: ok` before the run and after the analysis; `git status` showed only the new result files and reports), no parameter, question, skill or flag was changed, no cell was rerun, no failed session existed to drop, and the verdict is the one `analyze.ts` printed. ROADMAP.md, STATE.md and REQUIREMENTS.md were not edited by this executor (the orchestrator owns them).

## Deviations from Plan

None to the registered design. The plan's cost-overrun edge (stop at 125 percent of the projection, ask the human) was replaced by the user's own chunked cost stops (5, 10 and 20 USD notional) at the Task 2 checkpoint; the run finished at 16.11 USD, far below the 37.5 USD line the plan would have used. The plan's step to write the log and poll no more than every ten minutes was followed in effect (the run ran in the background and the executor waited for it).

## Blocking-human checkpoint still open

None in this plan. The consequence belongs to the user: Phase 4 stays blocked (D-04) until a new registered run, which needs its own approvals, meets the gate.

## Self-Check

Committed files exist: `docs/eval/analysis.md` (contains `OVERALL: MVP not met` and the echoed parameters), `docs/eval/diagnosis.md`, `docs/eval/results/results.jsonl` (450 lines, each validated by `harness summary` through `ResultRowSchema`), `sessions.meta.jsonl`, `attempts.jsonl`. `node scripts/eval/verify-prereg.ts`: ok. `harness summary --out-dir docs/eval/results`: 450 rows, 75 questions with both arms, no duplicate cell.
