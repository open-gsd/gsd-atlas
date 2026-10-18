---
phase: 03-typescript-module-and-mvp-eval
plan: 10
subsystem: eval-harness
tags: [eval, harness, claude-p, isolation, schedule, resume, pre-registration, pilot]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "claude-session.ts (03-02), score.ts and oracle.ts (03-03, 03-04), rows.ts and prereg.ts (03-05), prepare-corpus.ts and verify-prereg.ts (03-07)"
provides:
  - "scripts/eval/harness.ts: runCell, runAll and the commands plan, run, pilot, summary, project"
  - "scripts/eval/arms.ts: the two arms, read-only shell patterns, atlas tool names, MCP config, plugin directory, init check"
  - "scripts/eval/schedule.ts: Cell, cellId, makeSchedule (seeded, pair-adjacent, balanced), partition"
  - "scripts/eval/results.ts: ResultsStore over results.jsonl, attempts.jsonl and sessions.meta.jsonl"
  - "fake-claude-answer.mjs and fake-atlas.mjs fixtures: the whole harness is tested without a model or network"
affects: [03-09, 03-14, 03-16, 03-17]
actuals:
  tokens: 33000
  tasks: 3
  commits: 6
commits: 6
plan_head_before: 455baaa40a3f4dc910e8ea67aea5602201c80bbc
plan_head_after: 1002d0f2bfb645150cf54c582d7bd4d4a745c1d6
tech-stack:
  added: []
  patterns:
    - "One row appended in one write after scoring; an incomplete tail is cut off when the store opens"
    - "Per-cell session directory holding the clone, an atlas store, an empty user dir, the MCP config and the plugin; only the clone is the agent's cwd"
    - "Fake executables driven by environment variables, built from the arguments they receive"
key-files:
  created:
    - scripts/eval/arms.ts
    - scripts/eval/schedule.ts
    - scripts/eval/results.ts
    - scripts/eval/harness.ts
    - scripts/eval/harness.test.ts
    - scripts/eval/__fixtures__/fake-claude-answer.mjs
    - scripts/eval/__fixtures__/fake-atlas.mjs
  modified: []
key-decisions:
  - "A contaminated init event, a failed atlas index build and a throwing cell all stop scheduling (cells in flight finish) and the run exits 1; none of them produces a row, so none is silently dropped or scored"
  - "A scored run takes model, runs, concurrency, seed, budget and wall clock from the registration, refuses a different flag value, refuses fake executables, and also checks the Claude Code version and the prepared checkout commit"
  - "Pilot results always live in a directory named pilot; a scored run refuses such a directory"
requirements-advanced: [EVL-02, EVL-03]
requirements-completed: []
coverage:
  - id: D1
    description: "A cell runs end to end against fakes: clone, build (atlas arm, outside the token count), isolated session, init check, score, exactly one valid result line; a rerun skips it"
    requirement: "EVL-02"
    verification:
      - kind: unit
        ref: "scripts/eval/harness.test.ts#one cell end to end: clone, build, session, score, one result line"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#second run skips the cell and appends nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "Isolation: own clone, own atlas store, empty user dir per cell; grep arm has no server; contaminated init aborts instead of being scored"
    requirement: "EVL-02"
    verification:
      - kind: unit
        ref: "scripts/eval/harness.test.ts#separate stores per cell: each cell has its own store and an empty user directory inside its session directory"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#grep arm has no server: no build, an empty server map, no plugin"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#contaminated init: the difference is stored, nothing is scored"
        status: pass
    human_judgment: false
  - id: D3
    description: "Seeded balanced order and bounded concurrency"
    requirement: "EVL-02"
    verification:
      - kind: unit
        ref: "scripts/eval/harness.test.ts#schedule balanced: arms adjacent for every (question, run), both orders occur, no cell repeats"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#concurrency bound: never more than two sessions at once, every cell has its own directories, ten complete lines"
        status: pass
    human_judgment: false
  - id: D4
    description: "Registered failure rules: a session that reached the model is final; only rate-limit or overload failures with no tool call are retried, twice, each attempt logged"
    requirement: "EVL-03"
    verification:
      - kind: unit
        ref: "scripts/eval/harness.test.ts#garbage not retried: an unparseable answer is a final incorrect row"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#ratelimit retried twice: three attempts, each logged, then a final error row"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#an error after at least one tool call is final immediately"
        status: pass
    human_judgment: false
  - id: D5
    description: "Scored-run gate: Frozen Stage B registration, registered files and skill hash unchanged, flags equal to the registration, exit 2 before any session"
    requirement: "EVL-02"
    verification:
      - kind: unit
        ref: "scripts/eval/harness.test.ts#scored gate refuses a registered file that changed"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#scored gate refuses a skill whose hash differs from the Stage B hash"
        status: pass
    human_judgment: false
  - id: D6
    description: "Interrupt safety and reporting: SIGKILL leaves only complete lines and a restart finishes each cell once; summary and project print the pilot figures the user needs"
    requirement: "EVL-03"
    verification:
      - kind: unit
        ref: "scripts/eval/harness.test.ts#interrupt leaves complete lines: SIGKILL mid-run, then a second start finishes the remaining cells exactly once"
        status: pass
      - kind: unit
        ref: "scripts/eval/harness.test.ts#projection offsets: sessions and cost per arm as an estimate, and 1.645 * sd / sqrt(N) for N = 50, 75, 100"
        status: pass
    human_judgment: false
  - id: D7
    description: "The harness against the real `claude` and the built atlas binary (flags accepted, the skill actually loads under --tools Bash,Read, the read-only shell patterns restrict as intended)"
    verification: []
    human_judgment: true
    rationale: "Every test uses fake executables by design (no model in CI). Plan 03-14 is the first real run and is where these facts are established."
duration: about 1h (start time was not captured; approximate)
completed: 2026-10-18
status: complete
---

# Phase 3 Plan 10: Eval harness Summary

**A two-arm `claude -p` harness with per-cell clones and atlas stores, an init-event isolation check, a seeded pair-adjacent schedule, resumable single-write result rows, the registered retry rule, a scored-run gate on the frozen pre-registration, and `plan`, `run`, `pilot`, `summary` and `project` commands, all tested against fake executables.**

## Performance

- **Duration:** about 1 h (start time was not captured; approximate)
- **Completed:** 2026-10-18T05:55Z
- **Tasks:** 3 (1 tracer, 2 auto), each as a RED test commit then a GREEN feat commit
- **Files:** 7 created (4 modules, 1 test file, 2 fixtures); nothing existing was modified

## Accomplishments

- **One cell** (`runCell`): clones the prepared checkout into `<scratch>/<q>.<arm>.<run>/repo`, gives the cell its own `GSD_ATLAS_STORE_DIR` and an empty `GSD_ATLAS_USER_DIR` beside it, builds the atlas index there for the atlas arm (`build`, then `maintain resolve`, whose status is only recorded), starts the session with the clone as cwd, scores against the pinned prepared checkout (not the agent's copy), and appends one validated row. The raw stream, `prepMs`, build and maintain status and the init summary go to `sessions.meta.jsonl`, not to the row.
- **Arms** (`arms.ts`): built-in tools exactly `Bash` and `Read` in both arms; twelve read-only shell patterns; the atlas arm adds the `gsd-atlas` MCP server (config written per cell), the seven `mcp__gsd-atlas__*` tool names and the skill through a `gsd-atlas-eval` plugin directory. `checkInit` compares the init event with the arm (exact built-ins, server, a non-empty subset of the seven atlas tools, skill present or absent) and returns one string per difference.
- **Order and concurrency**: `makeSchedule` shuffles the arms inside each (question, run) pair and then the pairs, with a local seeded generator; `runAll` runs a shared queue with at most `concurrency` sessions in flight.
- **Failure rules**: a session that reached the model is one final row (timeouts and kills keep the tokens recovered from the raw stream); only a rate limit or overload with no tool call is retried (twice, every attempt in `attempts.jsonl`, third failure is a final `error` row).
- **Gate and commands**: `--scored` needs a Frozen Stage B registration that `verifyPrereg` passes and a skill whose hash equals the Stage B hash; otherwise exit 2 before the results directory exists. `plan` prints counts per arm, the first 10 cells, the flags and the registered values. `summary` and `project` print the pilot cost and the paired-difference figures plan 03-14 needs.

## Task Commits

1. **Task 1 (tracer): one cell end to end** - RED `913cc0e` (test), GREEN `2dc00fa` (feat)
2. **Task 2: arms, schedule, concurrency, failure rules, scored gate, CLI** - RED `0060333` (test), GREEN `297ca6d` (feat)
3. **Task 3: summary, project, interrupt safety** - RED `c8b8c8d` (test), GREEN `1002d0f` (feat)

**Tracer gate:** the tracer `<verify>` is automated only (`node --test scripts/eval/harness.test.ts && npm run typecheck`), no `gate="blocking-human"`. It was re-run after the commit (9 of 9 pass, typecheck clean) and expansion continued.

**RED evidence:** each RED commit carries the new tests plus interface-only stubs, so the test file loads and the target tests fail on the planned assertions (for example `'skipped' !== 'done'` for the tracer, empty schedules for Task 2, an unknown-command exit code for Task 3). I did not run `gsd_run check tdd-red-evidence` on a persisted record; the semantic assessment is by reading the failures. Some Task 2 and Task 3 cases (init contamination, the interrupt test) were already green at their RED commit because the tracer or Task 2 code covered them; they stay as regression cases.

## Verification

- `node --test scripts/eval/harness.test.ts scripts/eval/claude-session.test.ts`: 105 tests, 105 pass. `harness.test.ts` alone: 54 pass, run four times with no flake.
- `npm run typecheck`: clean. `npm test` (whole repository): 3,022 tests, 3,021 pass, 1 skipped (no failures).
- `node scripts/eval/harness.ts plan --questions <fixture question file> --runs 1 --arms atlas,grep`: exit 0 (plan 03-09's `pilot.questions.json` did not exist yet, so a one-question file was used).
- No file in `scripts/eval` imports a path containing `src/`.
- Acceptance titles present: `one cell end to end`, `second run skips`, `grep arm has no server`, `separate stores per cell`, `row survives cleanup failure`, `schedule balanced`, `schedule deterministic`, `contaminated init`, `concurrency bound`, `garbage not retried`, `ratelimit retried twice`, `scored gate`, `same prompt both arms`, `plan prints`, `summary per arm`, `projection offsets`, `interrupt leaves complete lines`, `duplicate cell reported`. `arms.ts` contains `Bash(rg:*)` and `mcp__gsd-atlas__code_refs`; `harness.ts` contains `1.645`.

## Deviations from Plan

**1. [Process] Separate RED and GREEN commits per task.** The plan names one commit per task. With `workflow.tdd_mode` true the tdd reference requires a RED `test(...)` commit first, so there are six commits, not three. Impact: none on content.

**2. [Interpretation] The agent's cwd is `<session>/repo`, not the whole session directory.** Plan text says the session directory is the cwd and that the store and user dirs lie "inside it". Putting the atlas store (SQLite files) inside the tree the agent greps would hand the grep arm noise and the atlas arm a way to read its own database, so the store, user dir, MCP config and plugin sit beside `repo/` inside the session directory. The tests assert "inside the session directory" and "not inside the checkout the agent searches".

**3. [Rule 2 - Missing critical functionality] Extra checks in the scored gate.** Beyond `verifyPrereg` and the skill hash, a scored run also checks: Frozen status and Stage B, that model/runs/concurrency/seed/budget/wall clock flags (when given) equal the registration, that `--claude-executable` and `--claude-prefix-arg` are absent, the pilot directory is not used, `claude --version` contains the registered version, the question file's corpus sha, count and category counts match, and the prepared checkout's sha and `npm ci` state match. Without these a "scored" run could differ from what was registered. All exit 2 before any session.

**4. [Rule 2] Incomplete tail repair and duplicate refusal in `ResultsStore`.** A killed process could leave a half line that the next append would glue a row onto. The store cuts an incomplete final line off when it opens and refuses a second row for a cell. The interrupt test covers it.

**5. [Rule 2] Timeouts and kills keep their tokens.** A session killed at the wall clock prints no result event, so `usage` would be zero and the failed session would look free (EVL-03 says it keeps its tokens). The harness sums the usage of the assistant messages in the raw stream (one report per message id, last wins). This is an approximation and is labelled so in the code.

**6. [Scope, small] `run` requires `--scored` or `--pilot`; `--out-dir` for a pilot always ends in `pilot`.** So an unregistered run cannot land in a results directory by accident. A prep failure (the atlas build exiting non-zero) is a hard stop like contamination, not a scored failure.

**7. [Scope, small] Cell identity and `Cell`/`cellId` were created in `schedule.ts` in Task 1** (the plan lists that file under Task 2) because `runCell` and the store both need them.

**Total deviations:** 7 (1 process, 1 interpretation, 4 added safeguards, 1 small scope). **Impact:** none on the plan's behavior bullets; all stricter.

## Constants and values to approve (03-CONSTANTS.md rule)

- `DEFAULT_RETRY_DELAY_MS = 60_000` in `arms.ts` is **planner-added and not in 03-CONSTANTS.md**. The plan says only that the delay is injected as 0 in tests. 60 s is my proposal; `arms.ts` is a Stage A file, so the freeze review (plan 03-16) hashes and shows it. Change it with `--retry-delay-ms` for the pilot if needed.
- `MAX_INFRASTRUCTURE_RETRIES = 2` is the plan's own number. `DEFAULT_RUNS = 3`, `DEFAULT_CONCURRENCY = 2` and `DEFAULT_SEED = 20261017` repeat the approved `eval.runsPerCell`, `eval.concurrency` and `eval.bootstrapSeed`.
- No budget or wall-clock default exists: `eval.maxBudgetUsdPerSession` and `eval.sessionWallClockMs` stay deferred; a pilot must pass `--max-budget-usd` and `--wall-clock-ms`.
- Build and `maintain` have no timeout unless `--prep-timeout-ms` is given (I did not invent one).

## Issues Encountered and notes for dependent plans

- **Plan 03-14** expects a harness-side stop when the running cost reaches 32 dollars. This plan does not implement it (its files list names `harness.ts`, so 03-14 can add it). It also passes `--pilot` to `plan`; that works.
- **The Skill tool is not in `--tools Bash,Read`.** The plan and D-03 fix the built-ins at exactly `Bash` and `Read`, and `checkInit` enforces that. Whether the `gsd-atlas-eval:gsd-atlas` skill still reaches the model (its description is listed; the body loads on invocation) can only be seen with the real `claude`. The pilot should check `init.skills` (stored in the meta sidecar) and whether any session read or used the skill. If it cannot, the fix is a registered change to `arms.ts`, not a quiet one.
- **The read-only shell patterns are prefix patterns.** `Bash(find:*)` allows `find -exec` and `-delete`, and redirections after `cat` may be allowed depending on how Claude Code matches compound commands. Writes can only land in the throwaway clone, but a session can also read any file the user can, including the answer keys under `scripts/eval/questions/`. The plan's list was followed as written; the pilot should look at the raw streams for any such use.
- **Answers are scored against the prepared checkout.** An agent that answers with an absolute path into its own clone is scored as `invalid path` (the scorer rejects paths outside the checkout it is given). The shared prompt preamble tells both arms to use paths relative to the repository root.
- A contaminated init, failed build or thrown cell leaves its cell without a row on purpose; after the fix, starting again runs it. `summary` reports row counts so an incomplete run is visible.
- Windows: the harness avoids shells (`process.execPath` plus script paths); live use of the real `claude` on Windows stays unsupported as in `claude-session.ts`. The suite ran on macOS only; the read-only-directory cleanup test skips on Windows and as root.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint or trust boundary; the plan's T-03-101 to T-03-105 are mitigated as described above (read-only patterns, no write/network/sub-agent tools, per-cell clone and store, init comparison on every session, empty setting sources and strict MCP config via `claude-session.ts`, gate before any session, retry rule with a log, concurrency from the approved constants).

## User Setup Required

None - no external service configuration required. (`npm ci --ignore-scripts` was run in the worktree to test; it left an ignored `node_modules` directory, not a symlink.)

## Next Phase Readiness

Plan 03-14 can run the pilot with `harness.ts pilot`, read `summary`, and produce the projection with `project`. Plan 03-16 hashes `arms.ts`, `harness.ts`, `schedule.ts` and `results.ts` and should show the user the retry delay above. Plan 03-09's `pilot.questions.json` plugs into `plan` without changes.

## Self-Check: PASSED

- All seven created files exist; `03-10-SUMMARY.md` written.
- Commits `913cc0e`, `2dc00fa`, `0060333`, `297ca6d`, `c8b8c8d`, `1002d0f` are ancestors of HEAD.
- `git rev-list --count 455baaa..HEAD` was 6 before this summary, matching `commits: 6`.

---
*Phase: 03-typescript-module-and-mvp-eval*
*Completed: 2026-10-18*
