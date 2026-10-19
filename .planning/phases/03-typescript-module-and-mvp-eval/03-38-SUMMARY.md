---
phase: 03-typescript-module-and-mvp-eval
plan: 38
subsystem: eval
tags: [eval, preregistration, stage-a-revision, stage-b, skill-visibility, scored-gate]
status: complete

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-16 Stage A freeze, 03-32 bug command, 03-33 final skill and Stage B freezer, 03-30 build-perf work"
provides:
  - "atlas arm carries the Skill tool and only the registered skill (`--tools Bash,Read,Skill`, one allow rule, bundled skills designed out through `--settings`)"
  - "Stage A re-frozen as revision 1 under the user's explicit re-confirmation, first freeze kept in the document and in git"
  - "scored-gate atlas-commit check (T-03-334): registered commit must be HEAD or an ancestor with no build-input change"
  - "Stage B recorded: skill sha256 and atlas commit; `harness plan --scored` prints gate ok, 450 cells"
  - "docs/eval/skill-visibility.md: probes, ladder outcome, token overhead, smoke table"
affects: [03-34, 03-35, 03-36, 03-37]

actuals:
  tokens: 43000
  tasks: 7
  commits: 14
plan_head_before: 9a37b40
plan_head_after: a21ef8b

key-files:
  created:
    - docs/eval/skill-visibility.md
  modified:
    - scripts/eval/arms.ts
    - scripts/eval/claude-session.ts
    - scripts/eval/harness.ts
    - scripts/eval/prereg.ts
    - scripts/eval/freeze-prereg.ts
    - scripts/skills.test.ts
    - docs/eval/preregistration.md
    - docs/eval/pilot.md
    - .planning/phases/03-typescript-module-and-mvp-eval/03-DECISIONS.md

key-decisions:
  - "Bundled Claude Code skills are removed from the atlas arm by `--settings` (`disableBundledSkills` plus `skillOverrides` off for plugin-authoring, design, doctor); deny rules by name do not work on 2.1.302"
  - "The three wording choices left open by 03-33 were kept as built, decided before the smoke run; the skill was not edited (sha256 unchanged)"
  - "OQ4 re-confirmed by the user as point_estimate (explicit oq4= token)"
  - "Stage B recorded at the docs-only approval commit 37b12e3; the freeze commit a21ef8b changes only docs/eval/preregistration.md"

requirements-completed: [EVL-02, EVL-03, SKL-01]
---

# Phase 3 Plan 38: Reopen Stage A for the Skill, Re-freeze, Record Stage B Summary

The pre-registered eval now compares the atlas tools plus the visible `gsd-atlas` skill against the unchanged grep baseline; Stage A is frozen as revision 1 and Stage B binds the final skill hash and the atlas commit, so the scored gate accepts the registration (75 questions, 450 cells).

## What was done

1. Probes (8, live, 2.1.302): under the previously registered `--tools Bash,Read` the atlas model saw no skill although the init event listed it; with the Skill tool it quotes the description and loads the body without a permission error; the grep arm sees none. Ladder: deny rules by name failed, `disableBundledSkills` alone left `plugin-authoring`, `disableBundledSkills` plus `skillOverrides` "off" for the three leftovers leaves the registered skill alone (init and model view). `checkInit` now fails an atlas session listing any other skill.
2. Smoke run (6 unscored sessions, pilot questions p-001, p-003, p-004, both arms, one run): all init events matched their arm, no session contaminated, every atlas session made one atlas call, zero Skill calls.
3. Stage A reopened as Draft, Revision 1 section written, approvals recorded (reply `approve oq4=point_estimate`), re-frozen as revision 1. Only four run-configuration files changed hash; twelve are identical to the first freeze.
4. Stage B: user reply `freeze-b` recorded verbatim in the section `Stage B approval (plan 03-38)`; clean `npm ci --ignore-scripts && npm run build`; freezer run; verify-prereg ok; dry-run scored plan accepted.

## Hashes and records

- Skill (unchanged from 03-33, `ae7ac92`): `00ce2dc7ab33fe087a5ace67409a161c557c99a658f5c2a4527c7efc60bc48cb`
- Stage B `atlasCommit` (full HEAD at the freeze, the docs-only approval commit): `37b12e32bf84f9ca1a4052c7d574ebc1aa0fe207`
- Stage B status line: `Status: Frozen (Stage B, 2026-10-19, by Tom Boucher)`, committed in `a21ef8b`.
- Supersedes chain: Stage A revision 0 frozen at `8a1da047ad61aa6d2f41b69dae7de9206d654147` (2026-10-18) -> Stage A revision 1 frozen in `2861eaf3e8d27fc20ebfe5e6de955a032b887fe0` (approvals `dcf76e1`) -> Stage B `a21ef8b` (approval `37b12e3`).
- Run-configuration file hashes, revision 0 -> revision 1:
  - `scripts/eval/arms.ts` e33cc7066d5a3384580baef78d54db1433d98c1ca7b03022a92681a795fd4c31 -> 012853d454054530013bf02bc35b3417f92ff8bb8593b9901841a6dac108e2ed
  - `scripts/eval/claude-session.ts` e967fc6549ed2072160b35be3caf47f3f80e5f6fbcf020fbbb64fc23ca3c0ca6 -> 5614e97efc8bfea2f792563aa0f0fd91c582122ec2ede2790b994b24fbd1b0a1
  - `scripts/eval/harness.ts` c659db81e9d7cb3e3a61a8df9c13846ba23463990920b797794e6c8e58852870 -> ae00063ce1b19d129a175213ebaf15c13a0996a103004894760dd1cf9ee79d4b
  - `scripts/eval/prereg.ts` 2e6d86fe1ccc20171a9e8c41b9f1b827f5207113bbb5de62429cfe2f7bfbcc25 -> 3c56b620a930cac85efc8c192abadc384ffc161b311bb454af8790fb5f124d39

## Task 7 evidence

- `node scripts/eval/verify-prereg.ts`: ok, before and after the Stage B record and at the final HEAD.
- Mutation check: appending one byte to `skills/gsd-atlas/SKILL.md` made `verify-prereg` exit 1 ("changed file: skills/gsd-atlas/SKILL.md (registered 00ce2dc7ab33, now b5298b9d00fa)") and made `harness plan --scored` refuse ("scored gate: the skill file ... differs from the registered Stage B hash"); the file was restored with `git checkout -- skills/gsd-atlas/SKILL.md` and its hash re-verified.
- Dry-run `harness plan --scored` (prepared gsd-core corpus at the registered sha, `--arms atlas,grep --runs 3`, no session started), at the pre-commit tree and again at the freeze commit: `mode: scored`, `questions: 75`, `cells: 450` (atlas 225, grep 225), `seed: 20261017`, `concurrency: 2`, first cell `q-029|grep|2`, `gate: ok (preregistration Frozen, Stage B, registered files and skill unchanged, atlas build matches the Stage B commit)`.
- Gates at the final tree: `npm run typecheck`, `npm run lint`, `npm run build` clean; `npm test`: 4594 tests, 4592 pass, 0 fail, 2 skipped, 0 cancelled.

## Spend of the whole plan

Probes 0.1935 USD + smoke 0.2588 USD = 0.4523 USD. Task 7 ran no live sessions (0 USD new); total 0.4523 USD, under the plan's 2 USD probe cap and 2 USD smoke ceiling.

## For plan 03-35's analysis (recorded, not acted on)

- Smoke observation: in one unscored run of three pilot questions the atlas sessions used 161,145 billable tokens in total against 90,819 for grep (p-004 22,577 vs 19,168; p-001 24,936 vs 14,491; p-003 113,632 vs 57,160).
- The skill body was loaded 0 of 3 times (no `Skill` calls in any atlas session); the model routed from the description alone, so the scored run mostly pays for the description (about 977 input tokens per turn measured on a one-turn probe).
- p-003 was incorrect in both arms. Nothing was tuned on any of this (D-23).

## Running the freezer or harness with Claude Code 2.1.302

The installed `claude` on PATH was 2.1.303; the registered version is 2.1.302. Create a directory holding a `claude` symlink to `/Users/trekkie/.local/share/claude/versions/2.1.302` and prefix only `node` commands with `PATH="<that dir>:$PATH"` (for example `PATH="$DIR:$PATH" node scripts/eval/freeze-prereg.ts --stage B --by "Tom Boucher"` and `... node scripts/eval/harness.ts plan --scored ...`). Do not prefix `npm`, and do not touch the user's installation or settings. `npm test` passed without the override.

## Re-sequenced waves

Plan ids are not renumbered (commit `120e3ef`): 03-38 wave 14; 03-35 (scored run) and 03-34 (docs) wave 15, both depending on 03-38; 03-36 wave 16; 03-37 wave 17.

## Deviations from Plan

- None in Task 7. `commits` counts the commits whose subject names (03-38) between the plan commit `9a37b40` and `a21ef8b` (14); this summary commit follows.
- Tasks 1 to 6 are described in their own commits; the Task 6 blocking checkpoint was answered `freeze-b`.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- skills/gsd-atlas/SKILL.md sha256 00ce2dc7ab33fe087a5ace67409a161c557c99a658f5c2a4527c7efc60bc48cb: unchanged
- Commits 37b12e3 and a21ef8b exist in HEAD; `docs/eval/preregistration.md` holds `Status: Frozen (Stage B`, the 64-hex skillSha256 and atlasCommit 37b12e32bf84f9ca1a4052c7d574ebc1aa0fe207
