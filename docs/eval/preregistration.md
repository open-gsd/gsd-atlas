# Pre-registration of the MVP eval (plan 03-16)

Status: Frozen (Stage A, revision 1, 2026-10-19, by Tom Boucher)

This document records the design of the eval that decides whether the gsd-atlas MVP meets its claim. It describes the design only. It reports no scored result and hints at none. Once the status line above reads `Frozen`, `node scripts/eval/verify-prereg.ts` (run by the static CI job) fails when any of the sixteen registered files changes, and a changed registered value is a new registered run (see Deviations policy).

## Purpose

The claim under test is the Phase 3 goal in ROADMAP.md: agents using atlas consume fewer tokens than a grep-only baseline at non-inferior accuracy, and give answers whose cited file and line can be verified (EVL-02, EVL-03). The design below fixes, before any scored session runs, the question set and its answer keys, the scorer, the statistics, the harness and the run configuration. The human reviews and approves the question set and the registered parameters at the checkpoints recorded under Approvals; the freeze tool then computes the hashes and writes them into the `prereg-json` block at the end of this document. The precise-tier code is written after the freeze, never before it (D-08).

## Hypotheses

- **H1, accuracy is non-inferior (D-04).** The accuracy of the atlas arm is not worse than the accuracy of the grep arm by 5 percentage points or more. It is judged on the lower end of the paired cluster bootstrap of the accuracy difference: the claim holds when the 5th percentile of the bootstrap distribution of (atlas accuracy minus grep accuracy) is strictly greater than minus 0.05. A miss means the MVP is not met; the work is then diagnosed and iterated before Phase 4.
- **H2, atlas uses fewer billable tokens.** Billable tokens of a session are input, output, cache-creation and cache-read tokens added together (D-06). The registered criterion is the stricter form set under Analysis: the 95th percentile of the paired bootstrap difference must be below zero.
- **H3, citations are verifiable (EVL-03).** In at least 80 percent of the atlas arm's sessions on questions that have an answer, the answer cites at least one file and line and every cited file and line verifies on disk. How "at least 80 percent" is judged (the point estimate, or the Wilson lower bound) was the user's explicit choice (OQ4): the point estimate, with the interval reported.

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
- **Token criterion.** The same paired cluster bootstrap is applied to billable tokens per session: the question's difference is the mean billable tokens of the atlas runs minus the mean of the grep runs. The criterion `point` would be that the observed mean of those differences is below zero (atlas uses fewer tokens overall). The registered criterion is the stricter `upper-bound`: the 95th percentile of the bootstrap distribution of the difference (atlas minus grep) must be below zero, which is more likely to miss on noise. The observed difference and the 5th and 95th percentiles are reported. The user chose the stricter criterion at the Task 3 checkpoint (see Approvals).
- **Citation criterion.** The rate is the share of atlas-arm sessions on the 66 non-abstain questions (66 x 3 = 198 sessions) whose answer has a verifiable citation, with the Wilson score interval at z = 1.96 (`wilsonZ`) reported for both arms. The threshold is 0.8 (`citationRate`). The registered judgement (`citationJudgedOn`) is the point estimate: the criterion holds when the observed rate is at or above 0.8, which needs 159 of the 198 sessions. The Wilson interval is reported next to it, not judged on (judged on its lower bound, 170 of 198 sessions, 85.9 percent, would be needed). The Wilson interval treats the sessions as independent, although the three runs of a question are not. The user confirmed `point_estimate` explicitly at the Task 3 checkpoint, which replaces the earlier answer `wilson_lower_bound` given at plan 03-01; the confirmation is the `OQ4 confirmed by the user:` line under Approvals.
- **Failure handling.** A session that ran and did not finish with status `ok` (timeout, budget stop, error, kill) counts as incorrect, has no verifiable citation, and keeps its tokens. Failed sessions are never dropped. The only registered rule is `incorrect-keep-tokens`.
- **Completeness rule.** The expected cells are every (question, arm, run) triple. A row outside the expected cells, or two rows for one cell, is an error. A run with a missing cell is incomplete: it gets no verdict, and the analysis exits non-zero.
- **Verdict.** The overall verdict is true when accuracy (H1), tokens (H2) and citations (H3) all hold.

## Run configuration

- **Model.** `claude-sonnet-5-5`, the id the Claude Code default resolved to and reported in every session's init event; the harness passes it as `--model` in a scored run.
- **Claude Code.** Version `2.1.302`; a scored run refuses a different version.
- **Concurrency.** 2 sessions in flight at once (`eval.concurrency`).
- **Per-session bounds.** `--max-budget-usd` 3 (USD) and a wall-clock kill at 900,000 ms (15 minutes), the values the user chose at plan 03-14 (`eval.maxBudgetUsdPerSession`, `eval.sessionWallClockMs`).
- **Retry rule.** A session that reached the model is final, whether it succeeded or failed; it is never retried. Only an infrastructure failure, a rate-limit or overload result (status 429 or 529, or the same words in the result text) with no tool call made, is retried, at most 2 times, after waiting 60,000 ms (`DEFAULT_RETRY_DELAY_MS` in `scripts/eval/arms.ts`, a planner-added value approved by the user together with this pre-registration; see Approvals). Every attempt is logged.
- **Cost stop.** The harness has an optional running-cost stop (`--stop-at-cost-usd`) that stops scheduling when the results directory has cost that much. It is a spending guard, not a registered value, and it cannot change a session's result; a run stopped by it is incomplete and gets no verdict.
- **Registered flags.** Model, runs, concurrency, seed, per-session budget and wall clock are taken from the `prereg-json` block; a scored run refuses a command-line flag that differs.

## Stages

- **Stage A (this document, plan 03-16)** freezes everything except the skill and the final atlas build. It registers the sha256 of these sixteen files: `scripts/eval/questions/gsd-core.questions.json`, `scripts/eval/questions/gsd-core.answers.json`, `scripts/eval/questions.ts`, `scripts/eval/oracle.ts`, `scripts/eval/score.ts`, `scripts/eval/answer-schema.json`, `scripts/eval/stats.ts`, `scripts/eval/rows.ts`, `scripts/eval/analyze.ts`, `scripts/eval/prereg.ts`, `scripts/eval/claude-session.ts`, `scripts/eval/arms.ts`, `scripts/eval/harness.ts`, `scripts/eval/schedule.ts`, `scripts/eval/results.ts` and `scripts/eval/prepare-corpus.ts`. Line endings are read as LF.
- **Stage B (plan 03-33)** adds the sha256 of `skills/gsd-atlas/SKILL.md` and the atlas commit before the first scored session, and may change nothing else (D-09, D-23). `verifyPrereg` refuses a Stage B record without a frozen Stage A.

## Deviations policy

Nothing registered here changes after the freeze. A change to a question, a key, a registered parameter or a registered file, made after the freeze, is a new registered run: a new version of this document with its own approvals and hashes, run from the start, with the earlier registration kept and cited. A change made after the first scored session never replaces the earlier result. Findings from the scored run, including defects in the harness or the keys, are reported as findings next to the original result and are not applied to it.

## Approvals

The question set and its answer keys (Task 2 of plan 03-16) and the registered parameters, the citation and token criteria and the run configuration (Task 3) were approved by the user on 2026-10-18. The replies are recorded verbatim.

Question set and answer keys (all 75 scored questions and the 5 pilot questions, no replacements). Reply:

> approve questions

Registered parameters, criteria and run configuration. Reply, as first sent:

> point_estimate, stricter point estimate, approve pre-registration

The reply did not use the `oq4=` form and named both the `approve` and the `stricter` options, so the user was asked to clarify which applied. The user answered:

> both unless they conflict and you didn't tell me

The parts do not conflict, so both apply. The reply is resolved as `approve` with `stricter oq4=point_estimate`:

- The EVL-03 citation criterion (OQ4) is judged on the point estimate at or above 0.8 (`citationJudgedOn` is `point_estimate`), replacing the answer `wilson_lower_bound` given at plan 03-01.
- The token criterion is the stricter form: the 95th percentile of the paired bootstrap difference below zero (`tokenCriterion` is `upper-bound`).
- The rest of the document is approved as written, including the 5-point margin on the 5th percentile, the failure rule and the run configuration. The approval covers the retry delay `DEFAULT_RETRY_DELAY_MS` of 60,000 ms (infrastructure failures only, at most 2 retries).

OQ4 confirmed by the user: point_estimate

## Machine-readable block

```prereg-json
{
  "stage": "A",
  "status": "Frozen",
  "revision": 1,
  "params": {
    "marginPoints": 5,
    "intervalLevel": 0.95,
    "resamples": 10000,
    "seed": 20261017,
    "runsPerCell": 3,
    "citationRate": 0.8,
    "citationJudgedOn": "point_estimate",
    "wilsonZ": 1.96,
    "tokenCriterion": "upper-bound",
    "failureRule": "incorrect-keep-tokens",
    "concurrency": 2,
    "maxBudgetUsdPerSession": 3,
    "sessionWallClockMs": 900000,
    "model": "claude-sonnet-5-5",
    "claudeVersion": "2.1.302",
    "corpusSha": "10ac3a7a947903ba50f538a907af036744d759d5",
    "npmCiRan": true
  },
  "files": {
    "scripts/eval/questions/gsd-core.questions.json": "841b2bdb202f286c3da5ac3a2c6b01ec4a1520e4a6d343089697e1f8f326700f",
    "scripts/eval/questions/gsd-core.answers.json": "e9e43d565bfbacc1c2ce045debdae4ee11e32510471c85465ad1e1f50d92413a",
    "scripts/eval/questions.ts": "425623eda7487496bf2a0ef959ef0ee079e8ccf4d0f41fca324ae01cee03dc64",
    "scripts/eval/oracle.ts": "8d83f5d8197f12e2234b7d83c831951022d658c1306304887bf1650364f53fdc",
    "scripts/eval/score.ts": "27cae3d4e1bf257d0bdd68ba0e393df7465b10afa8ef06dcd41208379fc1775e",
    "scripts/eval/answer-schema.json": "6da389ecb51825629b7770a562b88db67e245d775f7ec903475df97f6c03b72a",
    "scripts/eval/stats.ts": "e6f50d1f08ab1d53f6b9101e0bc890ca6f8b462a3acb671e5fd50e9dd829b851",
    "scripts/eval/rows.ts": "c2a24b17cf8b0f2508a7ae0ce8f5419bfea6f90056f929a699893e424f3222de",
    "scripts/eval/analyze.ts": "8328e47c7a21c34e2ffec617f2646cb3b290f6fb3f79fb58f0497eb516c015d0",
    "scripts/eval/prereg.ts": "3c56b620a930cac85efc8c192abadc384ffc161b311bb454af8790fb5f124d39",
    "scripts/eval/claude-session.ts": "5614e97efc8bfea2f792563aa0f0fd91c582122ec2ede2790b994b24fbd1b0a1",
    "scripts/eval/arms.ts": "012853d454054530013bf02bc35b3417f92ff8bb8593b9901841a6dac108e2ed",
    "scripts/eval/harness.ts": "ae00063ce1b19d129a175213ebaf15c13a0996a103004894760dd1cf9ee79d4b",
    "scripts/eval/schedule.ts": "ef4cd8c0157b6e836f8470652b658fb022f55ef96df6c1865c85043a42097d9d",
    "scripts/eval/results.ts": "669e0b0909cb6d3c73ea966e9b5394154ed762eb2ed15cf238c35f0530abc373",
    "scripts/eval/prepare-corpus.ts": "cee98c9221f18e0cff4905e60970684cef3a9b6a520cfb668b73397e39ba3dba"
  },
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
  },
  "supersedes": [
    {
      "revision": 0,
      "status": "Status: Frozen (Stage A, 2026-10-18, by Tom Boucher)",
      "frozenAtCommit": "8a1da047ad61aa6d2f41b69dae7de9206d654147",
      "params": {
        "marginPoints": 5,
        "intervalLevel": 0.95,
        "resamples": 10000,
        "seed": 20261017,
        "runsPerCell": 3,
        "citationRate": 0.8,
        "citationJudgedOn": "point_estimate",
        "wilsonZ": 1.96,
        "tokenCriterion": "upper-bound",
        "failureRule": "incorrect-keep-tokens",
        "concurrency": 2,
        "maxBudgetUsdPerSession": 3,
        "sessionWallClockMs": 900000,
        "model": "claude-sonnet-5-5",
        "claudeVersion": "2.1.302",
        "corpusSha": "10ac3a7a947903ba50f538a907af036744d759d5",
        "npmCiRan": true
      },
      "files": {
        "scripts/eval/questions/gsd-core.questions.json": "841b2bdb202f286c3da5ac3a2c6b01ec4a1520e4a6d343089697e1f8f326700f",
        "scripts/eval/questions/gsd-core.answers.json": "e9e43d565bfbacc1c2ce045debdae4ee11e32510471c85465ad1e1f50d92413a",
        "scripts/eval/questions.ts": "425623eda7487496bf2a0ef959ef0ee079e8ccf4d0f41fca324ae01cee03dc64",
        "scripts/eval/oracle.ts": "8d83f5d8197f12e2234b7d83c831951022d658c1306304887bf1650364f53fdc",
        "scripts/eval/score.ts": "27cae3d4e1bf257d0bdd68ba0e393df7465b10afa8ef06dcd41208379fc1775e",
        "scripts/eval/answer-schema.json": "6da389ecb51825629b7770a562b88db67e245d775f7ec903475df97f6c03b72a",
        "scripts/eval/stats.ts": "e6f50d1f08ab1d53f6b9101e0bc890ca6f8b462a3acb671e5fd50e9dd829b851",
        "scripts/eval/rows.ts": "c2a24b17cf8b0f2508a7ae0ce8f5419bfea6f90056f929a699893e424f3222de",
        "scripts/eval/analyze.ts": "8328e47c7a21c34e2ffec617f2646cb3b290f6fb3f79fb58f0497eb516c015d0",
        "scripts/eval/prereg.ts": "2e6d86fe1ccc20171a9e8c41b9f1b827f5207113bbb5de62429cfe2f7bfbcc25",
        "scripts/eval/claude-session.ts": "e967fc6549ed2072160b35be3caf47f3f80e5f6fbcf020fbbb64fc23ca3c0ca6",
        "scripts/eval/arms.ts": "e33cc7066d5a3384580baef78d54db1433d98c1ca7b03022a92681a795fd4c31",
        "scripts/eval/harness.ts": "c659db81e9d7cb3e3a61a8df9c13846ba23463990920b797794e6c8e58852870",
        "scripts/eval/schedule.ts": "ef4cd8c0157b6e836f8470652b658fb022f55ef96df6c1865c85043a42097d9d",
        "scripts/eval/results.ts": "669e0b0909cb6d3c73ea966e9b5394154ed762eb2ed15cf238c35f0530abc373",
        "scripts/eval/prepare-corpus.ts": "cee98c9221f18e0cff4905e60970684cef3a9b6a520cfb668b73397e39ba3dba"
      },
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
  ]
}
```

## Revision 1 (2026-10-18)

Opened on 2026-10-18 by Tom Boucher. Reason: Under the registered --tools Bash,Read the atlas model sees no skill (the init event lists it, the model has no Skill tool); the atlas arm gets the Skill tool so the scored run carries the skill, per the user's instruction of 2026-10-18.

### What changed

This section amends three earlier sections of this document: Hypotheses (H2, only as to what the atlas arm is), Design (the Atlas arm bullet and the Isolation flags bullet) and Stages (where Stage B is recorded). Where Revision 1 differs from an earlier section, Revision 1 governs and the earlier text stays in place as history. The text of the first registration, frozen at commit `8a1da04`, is not rewritten; the freezer compares the document with its version at that commit and refuses a revision that changed it.

**Hypotheses, H2, as amended.** H2, atlas uses fewer billable tokens, compares the grep arm with the atlas arm as Revision 1 defines it: the atlas tools together with the skill the model can see. The tokens of that skill are billable tokens of the atlas arm: its description is in the context on every turn of every atlas session, and its body adds its size in every session that loads it. They are counted as any other token (D-06) and never subtracted. H1 and H3 are unchanged.

**Design, the Atlas arm bullet, as amended.** The same two built-in tools with the same shell limits, plus the built-in `Skill` tool, open to one skill only through the single allow rule `Skill(gsd-atlas-eval:gsd-atlas)`; the `gsd-atlas` MCP server with its seven tools (`code_find`, `code_refs`, `code_context`, `code_impact`, `code_explain`, `atlas_status`, `lang_list`); and the `gsd-atlas` skill, loaded from a plugin directory that holds the registered skill file and nothing else. Claude Code's own skills are designed out of what the model sees by an inline `--settings` argument, so that the registered skill is the only skill in the model's list. The init event of every session is compared with its arm's registered environment: in the atlas arm the built-in tools are exactly `Bash`, `Read` and `Skill`, the registered skill is listed and is the only skill listed; a session that differs is not scored and stops the run. The grep arm bullet is unchanged.

**Design, the Isolation flags bullet, as amended for the atlas arm.** Each atlas session runs `claude -p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --mcp-config <per-session file> --plugin-dir <skill plugin> --settings '{"disableBundledSkills":true,"skillOverrides":{"plugin-authoring":"off","design":"off","doctor":"off"}}' --tools Bash,Read,Skill --allowedTools <read-only shell patterns, Read, Skill(gsd-atlas-eval:gsd-atlas), atlas tools> --max-budget-usd <budget> --json-schema <answer schema> --no-session-persistence`. The sentence for the grep arm is as it was: `claude -p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --mcp-config <per-session file> --tools Bash,Read --allowedTools <read-only shell patterns, Read> --max-budget-usd <budget> --json-schema <answer schema> --no-session-persistence`, with an empty server map, no plugin directory and no `--settings`. Throwaway clone, own atlas store, empty user directory and the index built before the clock are unchanged.

**Bundled skills, and the proof.** Claude Code 2.1.302 lists 19 skills of its own in the init event and, once a `Skill` tool exists, shows the model 14 skills of its own (three of them are not in the init list). Three ways to remove them were tried live, in the order of the plan: deny rules by name (`Skill(<name>)` entries in `--disallowedTools`) did not remove any skill from the model's list; `disableBundledSkills` removed all but `plugin-authoring`; and `disableBundledSkills` together with `skillOverrides` set to `"off"` for the three skills it leaves (`plugin-authoring`, `design`, `doctor`) leaves the init event and the model's list with the registered skill alone. The last is the registered form. The probes and their cost are in `docs/eval/skill-visibility.md`.

**Stages, as amended.** Stage A is this document at Revision 1: it registers the sha256 of the same sixteen files, recomputed after the revision; the four run-configuration files listed below have new hashes and the other twelve have the hashes of the first registration. Stage B is recorded by plan 03-38 on top of this revision (the sha256 of `skills/gsd-atlas/SKILL.md` and the atlas commit), and its line goes below the Stage A revision line.

**Scored gate, the atlas build.** The harness now compares the Stage B `atlasCommit` with the checkout that holds the atlas binary under test (T-03-334): the registered commit must be HEAD or an ancestor of it, none of `src`, `modules`, `schemas`, `diagnostics`, `package.json`, `package-lock.json`, `tsconfig.json` and `tsconfig.build.json` may differ between that commit and HEAD or have an uncommitted change, and the binary may not be older than the newest of those files. The check is in the harness, not in `verify-prereg`, so later phases can change `src` without turning the CI static job red.

**The record.** The `prereg-json` block gains two optional fields, `revision` and `supersedes`. A record with `revision` N carries exactly N superseded records, oldest first and numbered from 0, each holding the superseded status line, the full id of the commit that froze it, its parameters, its question set and its sixteen hashes. The hashes of the superseded record were read from the git blobs at that commit, not copied from text. The table under Superseded records below holds the same.

**Consequence for tokens, in plain words.** The skill description is in the context on every turn of every atlas session, and the skill body adds its size each time a session loads it. Both are billable tokens of the atlas arm, counted against it, and never subtracted. Measured on a one-turn probe with the same prompt, the Skill tool and the description add about 980 input tokens per turn (9,268 input and cache tokens with the registered tools, 10,245 with Revision 1); leaving Claude Code's own skills visible would have added about 2,350 more, which the settings above remove. The three wording choices that plan 03-33 left open in the skill were kept as built before the smoke run; each may add a tool call or tokens to atlas sessions, all counted.

Changed registered files: scripts/eval/arms.ts, scripts/eval/claude-session.ts, scripts/eval/harness.ts, scripts/eval/prereg.ts

### Why

The user instructed, on 2026-10-18 at the blocking checkpoint of plan 03-33, in these words:

> re-open stage a and run with the skill now that it's built

D-03 and D-09 say that the atlas arm of the scored comparison uses the skill. The first registration did not deliver that. Under the registered `--tools Bash,Read` the init event of an atlas session lists `gsd-atlas-eval:gsd-atlas`, which is all that `checkInit` read, but the model has no `Skill` tool and sees no skill list. Two live probes of plan 03-33 (0.035 USD) found it: asked to quote the description of the skill, the model answered that it could see no skill and had no Skill tool; with `Skill` added to the tools it saw the full description and could load the body. Plan 03-38 ran the check again on the installed version with the harness's own flags (eight probes, 0.19 USD, in `docs/eval/skill-visibility.md`): with the registered flags the model sees no skill; with the Skill tool it quotes the description and loads the body without a permission error; the grep arm, which has no Skill tool, sees no skill.

The scored comparison as first registered would therefore have measured the atlas tools and the server instructions without the skill, while D-03 and D-09 describe the atlas tools with the skill. Revision 1 makes the registration match the design.

It also corrects two statements of the 03-14 pilot. Finding 5 said that the skill's description is all the model can see, and Finding 6 said that the atlas arm's extra tokens came from carrying the skill description. Under the registered tools the atlas model saw no description, so neither holds for that configuration. `docs/eval/pilot.md` carries a dated correction note.

### What did not change

Every registered parameter keeps its value: margin 5 points on the 5th percentile of the paired cluster bootstrap (`marginPoints` 5, `intervalLevel` 0.95), 10,000 resamples (`resamples`), seed 20261017 (`seed`), 3 runs per cell (`runsPerCell`), the citation rate 0.8 judged on the point estimate (`citationRate` 0.8, `citationJudgedOn` `point_estimate`, `wilsonZ` 1.96), the stricter token criterion `upper-bound`, the failure rule `incorrect-keep-tokens`, concurrency 2, `maxBudgetUsdPerSession` 3, `sessionWallClockMs` 900000, the model `claude-sonnet-5-5`, Claude Code `2.1.302`, the corpus sha `10ac3a7a947903ba50f538a907af036744d759d5` and `npmCiRan` true.

The question set (75 questions: callers 17, references 8, heritage 8, emit 10, adr 10, impact 6, definition 7, abstain 9), the answer keys, the oracle, the scorer, the statistics, the analysis, the row schema and the answer schema are unchanged. So are the files `scripts/eval/schedule.ts`, `results.ts` and `prepare-corpus.ts`. In all, twelve of the sixteen registered files are hash-identical to the first registration; only the four run-configuration files named above differ.

The grep arm is unchanged: built-ins `Bash` and `Read`, the same read-only shell patterns, no MCP server, no skill, no Skill tool and no `--settings`; its arguments are asserted against literal copies of their pre-revision values in `scripts/eval/harness.test.ts`.

These statements are enforced and not only made. The freezer refuses to freeze this revision unless the parameters and the question set equal the superseded record, unless every registered file other than the four run-configuration files hashes to the value of the superseded record, unless the files named on the `Changed registered files:` line are exactly the files whose hash changed, and unless the text of the first registration is intact.

### No scored data

No scored session has run and no scored result exists. The harness refuses `--scored` without a Stage B record and none exists; `docs/eval/results/` holds no results file; and the freezer refuses to reopen or to revise a record that has a Stage B record or a committed results file.

The only sessions seen are the ten pilot sessions of plan 03-14 (the Phase 2 grammar-tier atlas against five pilot questions that are disjoint from the scored set), eight throwaway visibility probes that asked the model what it can see (no repository question), and six unscored smoke sessions on three of the pilot questions (`p-001`, `p-003`, `p-004`, both arms, one run). None of them touched a scored question or key.

This revision is made after the precise-tier code exists, and the document says so plainly. The first registration said that the precise-tier code is written after the freeze (D-08), and it was: the resolver was written after commit `8a1da04`. Revision 1 is the first change to the registration made with that code in the tree. Nothing it changes concerns the questions, the keys, the oracle, the scorer, the statistics or the analysis, and the atlas build that the scored run uses is recorded at Stage B, not here. The skill text was written by plan 03-33 before the smoke run and was not tuned on it or on any probe: the three wording choices left open by plan 03-33 were decided before the smoke run (keep all three as built), and a test checks that no file path of the answer keys appears in the skill.

The direction of the change is against the atlas arm on cost and for it on routing. It adds billable tokens to the atlas arm (the description on every turn, the body when loaded), and it adds a routing channel (a skill the model can see). Both are counted in the comparison, and the registered criteria were chosen before this finding and do not move.

### Superseded records

| Record | Value |
| --- | --- |
| Superseded status line | `Status: Frozen (Stage A, 2026-10-18, by Tom Boucher)` |
| Superseded at commit | `8a1da047ad61aa6d2f41b69dae7de9206d654147` |
| `scripts/eval/questions/gsd-core.questions.json` | `841b2bdb202f286c3da5ac3a2c6b01ec4a1520e4a6d343089697e1f8f326700f` |
| `scripts/eval/questions/gsd-core.answers.json` | `e9e43d565bfbacc1c2ce045debdae4ee11e32510471c85465ad1e1f50d92413a` |
| `scripts/eval/questions.ts` | `425623eda7487496bf2a0ef959ef0ee079e8ccf4d0f41fca324ae01cee03dc64` |
| `scripts/eval/oracle.ts` | `8d83f5d8197f12e2234b7d83c831951022d658c1306304887bf1650364f53fdc` |
| `scripts/eval/score.ts` | `27cae3d4e1bf257d0bdd68ba0e393df7465b10afa8ef06dcd41208379fc1775e` |
| `scripts/eval/answer-schema.json` | `6da389ecb51825629b7770a562b88db67e245d775f7ec903475df97f6c03b72a` |
| `scripts/eval/stats.ts` | `e6f50d1f08ab1d53f6b9101e0bc890ca6f8b462a3acb671e5fd50e9dd829b851` |
| `scripts/eval/rows.ts` | `c2a24b17cf8b0f2508a7ae0ce8f5419bfea6f90056f929a699893e424f3222de` |
| `scripts/eval/analyze.ts` | `8328e47c7a21c34e2ffec617f2646cb3b290f6fb3f79fb58f0497eb516c015d0` |
| `scripts/eval/prereg.ts` | `2e6d86fe1ccc20171a9e8c41b9f1b827f5207113bbb5de62429cfe2f7bfbcc25` |
| `scripts/eval/claude-session.ts` | `e967fc6549ed2072160b35be3caf47f3f80e5f6fbcf020fbbb64fc23ca3c0ca6` |
| `scripts/eval/arms.ts` | `e33cc7066d5a3384580baef78d54db1433d98c1ca7b03022a92681a795fd4c31` |
| `scripts/eval/harness.ts` | `c659db81e9d7cb3e3a61a8df9c13846ba23463990920b797794e6c8e58852870` |
| `scripts/eval/schedule.ts` | `ef4cd8c0157b6e836f8470652b658fb022f55ef96df6c1865c85043a42097d9d` |
| `scripts/eval/results.ts` | `669e0b0909cb6d3c73ea966e9b5394154ed762eb2ed15cf238c35f0530abc373` |
| `scripts/eval/prepare-corpus.ts` | `cee98c9221f18e0cff4905e60970684cef3a9b6a520cfb668b73397e39ba3dba` |

### Approvals (Revision 1)

The user answered the Task 4 blocking-human checkpoint of plan 03-38 on 2026-10-18. The reply is recorded verbatim:

> approve oq4=point_estimate

The reply is read as `approve` with one explicit `oq4=` token whose value is `point_estimate`, the registered value. It approves Revision 1 as written (the atlas arm gains the Skill tool and the skill, the grep arm and every other registered item are unchanged) together with the skill text as shown at the checkpoint. The token criterion (`upper-bound`, the 95th percentile of the paired bootstrap difference below zero) and every other registered parameter are unchanged and are not reopened by this reply. The line below is taken from the reply's `oq4=` token alone; it is not copied from the block or inferred.

OQ4 re-confirmed by the user at Revision 1: point_estimate

## Stage B approval (plan 03-38)

On 2026-10-18 the user answered the Task 6 blocking-human checkpoint of plan 03-38, which asked whether to record Stage B now (the sha256 of the final skill and the current HEAD as the atlas commit) or to wait. The reply is recorded verbatim:

> freeze-b

The reply is read as the option `freeze-b`: the build and the skill are final, and Stage B is recorded at the HEAD that carries this section. The tree at the time of the reply was clean at `51a7c21a777186e70cc7e28e996dc1f47a67ab2b`, the skill file `skills/gsd-atlas/SKILL.md` had the sha256 `00ce2dc7ab33fe087a5ace67409a161c557c99a658f5c2a4527c7efc60bc48cb` (unchanged since the checkpoint), and plan 03-32 and the build-performance work were in that tree. The commit that adds this section changes only this document; the atlas commit that Stage B records is therefore the HEAD that holds this section, which has the same `src`, `modules`, `schemas`, `diagnostics`, package files and compiler configuration as `51a7c21`.

Nothing else is changed by this approval: every registered parameter, the question set, the keys and the sixteen Stage A hashes are those of Revision 1.
