---
phase: 03-typescript-module-and-mvp-eval
plan: 35
subsystem: eval
status: in-progress
note: "Task 1 done; stopped at the Task 2 blocking-human checkpoint. No scored session has started."
tags: [eval, scored-run, projection, checkpoint]
---

# Phase 3 Plan 35: Scored Eval Run (in progress, Task 1 recorded)

This file records Task 1 (pre-run integrity checks and the projection). Tasks 2 and 3 are not done: the plan is paused at the blocking-human checkpoint, and no session that reaches the model has been started.

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

## Task 2 (checkpoint)

Reply: not yet given.
