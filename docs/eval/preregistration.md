# Pre-registration of the MVP eval (plan 03-16)

Status: Draft

This document records the design of the eval that decides whether the gsd-atlas MVP meets its claim. It describes the design only. It reports no scored result and hints at none. Once the status line above reads `Frozen`, `node scripts/eval/verify-prereg.ts` (run by the static CI job) fails when any of the sixteen registered files changes, and a changed registered value is a new registered run (see Deviations policy).

## Purpose

The claim under test is the Phase 3 goal in ROADMAP.md: agents using atlas consume fewer tokens than a grep-only baseline at non-inferior accuracy, and give answers whose cited file and line can be verified (EVL-02, EVL-03). The design below fixes, before any scored session runs, the question set and its answer keys, the scorer, the statistics, the harness and the run configuration. The human reviews and approves the question set and the registered parameters at the checkpoints recorded under Approvals; the freeze tool then computes the hashes and writes them into the `prereg-json` block at the end of this document. The precise-tier code is written after the freeze, never before it (D-08).

## Hypotheses

- **H1, accuracy is non-inferior (D-04).** The accuracy of the atlas arm is not worse than the accuracy of the grep arm by 5 percentage points or more. It is judged on the lower end of the paired cluster bootstrap of the accuracy difference: the claim holds when the 5th percentile of the bootstrap distribution of (atlas accuracy minus grep accuracy) is strictly greater than minus 0.05. A miss means the MVP is not met; the work is then diagnosed and iterated before Phase 4.
- **H2, atlas uses fewer billable tokens.** Billable tokens of a session are input, output, cache-creation and cache-read tokens added together (D-06). The registered criterion is set under Analysis; it is awaiting the human's decision at Task 3.
- **H3, citations are verifiable (EVL-03).** In at least 80 percent of the atlas arm's sessions on questions that have an answer, the answer cites at least one file and line and every cited file and line verifies on disk. How "at least 80 percent" is judged (the point estimate, or the Wilson lower bound) is the user's explicit choice (OQ4); it is awaiting the human's decision at Task 3.

## Design

- **Paired by question.** Every question is asked in both arms. The comparison is the difference between the arms on the same question.
- **Size.** 75 scored questions (`eval.scoredQuestions`; the locked floor `eval.minQuestions` is 50), 3 runs of every question in every arm (`eval.runsPerCell`), two arms: 75 x 3 x 2 = 450 scored sessions.
- **Grep arm.** The built-in tools `Bash` and `Read` only. `Bash` is limited to these read-only commands: `rg`, `git grep`, `git ls-files`, `grep`, `cat`, `head`, `tail`, `wc`, `ls`, `find`, `sort`, `uniq`. No other server, tool or skill.
- **Atlas arm.** The same two built-in tools with the same shell limits, plus the `gsd-atlas` MCP server with its seven tools (`code_find`, `code_refs`, `code_context`, `code_impact`, `code_explain`, `atlas_status`, `lang_list`) and the `gsd-atlas` skill, loaded from a plugin directory that holds the registered skill file and nothing else. The init event of every session is compared with its arm's registered environment; a session that differs is not scored and stops the run.
- **The same prompt and answer schema.** Both arms receive the same text: one fixed sentence ("Answer the question about the repository in the current directory. Report file paths relative to the repository root.") followed by the question. Both arms deliver the answer through the same JSON schema (`scripts/eval/answer-schema.json`), which makes Claude Code add its own `StructuredOutput` tool to both.
- **Isolation flags.** Each session runs `claude -p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --mcp-config <per-session file> [--plugin-dir <skill plugin>] --tools Bash,Read --allowedTools <read-only shell patterns, Read, atlas tools> --max-budget-usd <budget> --json-schema <answer schema> --no-session-persistence`. Each session works in its own throwaway clone of the prepared checkout, with its own atlas store and an empty user directory. The atlas index for a session is built before the session clock starts and is not part of its token count.
- **Balanced seeded order.** For every (question, run) the two arms form one adjacent group in random order, and the groups are shuffled, using the registered seed 20261017. Prompt-cache warmth and rate-limit drift then fall evenly on both arms.

## Corpus

- Repository: `gsd-core`, pinned at commit `10ac3a7a947903ba50f538a907af036744d759d5`.
- Preparation (OQ8): `npm ci --ignore-scripts` ran in a throwaway checkout at that commit, so the project's own TypeScript 6.0.3 is installed under `node_modules`; `package-lock.json` has sha256 `dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb`. The registered value is `npmCiRan: true`, and a scored run refuses a checkout whose preparation record says otherwise.
- The compiler used for the answer keys is TypeScript 6.0.3 on that prepared checkout.

## Questions

- 75 scored questions: callers 17, references 8, heritage 8, emit 10, adr 10, impact 6, definition 7, abstain 9. The categories include callers, implementers, the `.cts` to `.cjs` emit mapping, ADR citations and abstain, as the requirement asks. A separate set of 5 pilot questions (`p-001` to `p-005`) is not part of the scored set.
- The questions were drafted by an agent from the gsd-core source and ADRs without running atlas, and the order of the candidates comes from a seeded shuffle of a compiler-derived census (seed 20261017). The set was extended from 50 to 75 questions by continuing the same order. `docs/eval/questions-review.md` lists every question, its answer-set size and the rejected candidates.
- Answer keys come from the independent compiler-based oracle `scripts/eval/oracle.ts`, version `03-14.1`. Of the 75 keys, 60 are compared at granularity `file`, 8 at `file+symbol` and 7 at `file+line`; all 75 use the equality rule `exact-set`.
- The sha256 of the question file and the answer file are in the `prereg-json` block of this document, with the hashes of the other registered files.

## Scoring

- **Granularity and equality.** An answered item is reduced to what the key's granularity compares: the file for `file`, the file and symbol for `file+symbol`, the file and line for `file+line`. Key items and answered items are matched one to one. With `exact-set` equality an answer is correct when no key item is missing and no answered item is extra.
- **Line slack.** At `file+line` granularity an answered line matches a key line when the two are at most 2 lines apart (`LINE_SLACK` in `scripts/eval/score.ts`), and each key line is matched at most once. Symbols match when they are equal, or when one names only the method and the other names it with its class.
- **Paths.** An answered path is normalised (backslashes to slashes, a leading `./` removed, an absolute path inside the checkout made relative). A path that is outside the checkout, has a `..` segment, is empty or contains a NUL byte makes the answer incorrect.
- **Citation verification.** Every answered item that carries a line is checked on disk against the pinned prepared checkout with the oracle's `verifyCitation`. The answer has a verifiable citation when it cites at least one line and every cited line verifies. At most 200 citations of one answer are checked; the rest count as failures. Abstain questions have nothing to cite and are left out of the citation rate.
- **Abstain rule.** On an abstain question the only correct answer is `not_found` with no items. A `found` answer is a fabricated answer; `not_found` with items is incorrect. On any other question `not_found` is incorrect ("gave up").
- **Unparseable answers.** Text that is not the registered JSON shape is scored incorrect. The only tolerance is that the text between the first `{` and the last `}` is tried once when the whole text is not JSON. Nothing is repaired.

## Analysis

- **Accuracy statistic.** For every question, the accuracy of an arm is the mean of its runs (1 for a correct session, 0 for an incorrect one), and the question's difference is atlas minus grep. The unit of resampling is the question: all runs of a question stay together. The bootstrap draws 75 questions with replacement, 10,000 times (`resamples`), from a random stream seeded with 20261017 (`seed`, the mulberry32 generator), and records the mean difference of each draw. The sorted distribution is read without interpolation: the 5th percentile is the element at index floor(0.05 x (10,000 - 1)) and the 95th percentile the element at index floor(0.95 x (10,000 - 1)). The registered interval level is 0.95 one-sided (`intervalLevel`), which is the 90 percent two-sided interval whose lower end is the 5th percentile. H1 holds when the 5th percentile is strictly greater than minus 0.05 (`marginPoints` 5).
- **Token criterion.** The same paired cluster bootstrap is applied to billable tokens per session: the question's difference is the mean billable tokens of the atlas runs minus the mean of the grep runs. The default criterion, `point`, is that the observed mean of those differences is below zero (atlas uses fewer tokens overall), with the 5th and 95th percentiles reported. The alternative, `upper-bound`, requires the 95th percentile of the bootstrap distribution to be below zero, which is stricter and more likely to miss on noise. This Draft registers `point`, the default; it is awaiting the human's decision at Task 3.
- **Citation criterion.** The rate is the share of atlas-arm sessions on the 66 non-abstain questions (66 x 3 = 198 sessions) whose answer has a verifiable citation, with the Wilson score interval at z = 1.96 (`wilsonZ`) reported for both arms. The threshold is 0.8 (`citationRate`). Judged on the point estimate, 159 of the 198 sessions are needed; judged on the Wilson lower bound, 170 of 198 (85.9 percent) are needed. The Wilson interval treats the sessions as independent, although the three runs of a question are not. This Draft registers `wilson_lower_bound`, the value of the user's earlier answer at plan 03-01 (the `Gate OQ4` line of 03-DECISIONS.md); it is awaiting the human's decision at Task 3, and the freezer refuses to freeze unless the Approvals section holds the user's explicit line.
- **Failure handling.** A session that ran and did not finish with status `ok` (timeout, budget stop, error, kill) counts as incorrect, has no verifiable citation, and keeps its tokens. Failed sessions are never dropped. The only registered rule is `incorrect-keep-tokens`.
- **Completeness rule.** The expected cells are every (question, arm, run) triple. A row outside the expected cells, or two rows for one cell, is an error. A run with a missing cell is incomplete: it gets no verdict, and the analysis exits non-zero.
- **Verdict.** The overall verdict is true when accuracy (H1), tokens (H2) and citations (H3) all hold.

## Run configuration

- **Model.** `claude-sonnet-5-5`, the id the Claude Code default resolved to and reported in every session's init event; the harness passes it as `--model` in a scored run.
- **Claude Code.** Version `2.1.302`; a scored run refuses a different version.
- **Concurrency.** 2 sessions in flight at once (`eval.concurrency`).
- **Per-session bounds.** `--max-budget-usd` 3 (USD) and a wall-clock kill at 900,000 ms (15 minutes), the values the user chose at plan 03-14 (`eval.maxBudgetUsdPerSession`, `eval.sessionWallClockMs`).
- **Retry rule.** A session that reached the model is final, whether it succeeded or failed; it is never retried. Only an infrastructure failure, a rate-limit or overload result (status 429 or 529, or the same words in the result text) with no tool call made, is retried, at most 2 times, after waiting 60,000 ms (`DEFAULT_RETRY_DELAY_MS` in `scripts/eval/arms.ts`, a planner-added value that is awaiting the human's approval at Task 3). Every attempt is logged.
- **Cost stop.** The harness has an optional running-cost stop (`--stop-at-cost-usd`) that stops scheduling when the results directory has cost that much. It is a spending guard, not a registered value, and it cannot change a session's result; a run stopped by it is incomplete and gets no verdict.
- **Registered flags.** Model, runs, concurrency, seed, per-session budget and wall clock are taken from the `prereg-json` block; a scored run refuses a command-line flag that differs.

## Stages

- **Stage A (this document, plan 03-16)** freezes everything except the skill and the final atlas build. It registers the sha256 of these sixteen files: `scripts/eval/questions/gsd-core.questions.json`, `scripts/eval/questions/gsd-core.answers.json`, `scripts/eval/questions.ts`, `scripts/eval/oracle.ts`, `scripts/eval/score.ts`, `scripts/eval/answer-schema.json`, `scripts/eval/stats.ts`, `scripts/eval/rows.ts`, `scripts/eval/analyze.ts`, `scripts/eval/prereg.ts`, `scripts/eval/claude-session.ts`, `scripts/eval/arms.ts`, `scripts/eval/harness.ts`, `scripts/eval/schedule.ts`, `scripts/eval/results.ts` and `scripts/eval/prepare-corpus.ts`. Line endings are read as LF.
- **Stage B (plan 03-33)** adds the sha256 of `skills/gsd-atlas/SKILL.md` and the atlas commit before the first scored session, and may change nothing else (D-09, D-23). `verifyPrereg` refuses a Stage B record without a frozen Stage A.

## Deviations policy

Nothing registered here changes after the freeze. A change to a question, a key, a registered parameter or a registered file, made after the freeze, is a new registered run: a new version of this document with its own approvals and hashes, run from the start, with the earlier registration kept and cited. A change made after the first scored session never replaces the earlier result. Findings from the scored run, including defects in the harness or the keys, are reported as findings next to the original result and are not applied to it.

## Approvals

Awaiting the human's decisions: the question set and its answer keys (Task 2) and the registered parameters, the citation and token criteria and the run configuration (Task 3). The replies will be recorded here verbatim with their date, and the explicit OQ4 value will be recorded as its own line. No approval is recorded in this Draft.

## Machine-readable block

```prereg-json
{
  "stage": "A",
  "status": "Draft",
  "params": {
    "marginPoints": 5,
    "intervalLevel": 0.95,
    "resamples": 10000,
    "seed": 20261017,
    "runsPerCell": 3,
    "citationRate": 0.8,
    "citationJudgedOn": "wilson_lower_bound",
    "wilsonZ": 1.96,
    "tokenCriterion": "point",
    "failureRule": "incorrect-keep-tokens",
    "concurrency": 2,
    "maxBudgetUsdPerSession": 3,
    "sessionWallClockMs": 900000,
    "model": "claude-sonnet-5-5",
    "claudeVersion": "2.1.302",
    "corpusSha": "10ac3a7a947903ba50f538a907af036744d759d5",
    "npmCiRan": true
  },
  "files": {},
  "questionSet": {
    "count": 75,
    "byCategory": {
      "callers": 17,
      "references": 8,
      "heritage": 8,
      "emit": 10,
      "adr": 10,
      "impact": 6,
      "definition": 7,
      "abstain": 9
    }
  }
}
```
