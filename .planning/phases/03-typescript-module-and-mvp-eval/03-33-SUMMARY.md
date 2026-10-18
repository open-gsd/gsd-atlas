---
phase: 03-typescript-module-and-mvp-eval
plan: 33
subsystem: skills
tags: [skills, routing, preregistration, stage-b, eval]

requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "plan 03-11 skill v0, 03-16 Stage A freeze, 03-26/03-28/03-29 final tool set"
provides:
  - "final `gsd-atlas` routing skill (57 body lines of 80; description 884 of 1,536 characters)"
  - "`gsd-atlas-module-author` skill (94 body lines of 200)"
  - "scripts/skills.test.ts: per-skill limits, degraded-code membership, capture-vocabulary and required-topic checks"
  - "`freeze-prereg.ts --stage B` (skill sha256 + atlas commit, five refusals), tested on a temporary repository"
  - "the checkpoint reply and the skill-visibility finding, recorded in 03-33-CHECKPOINT.md"
affects: [03-34, 03-36, 03-38]

actuals:
  tokens: 19400
  tasks: 2
  commits: 7
plan_head_before: 5b032e4
plan_head_after: 5f9fca39f905b9ccb365fd1d01b39b8615d699b0

key-files:
  created:
    - skills/gsd-atlas-module-author/SKILL.md
    - .planning/phases/03-typescript-module-and-mvp-eval/03-33-CHECKPOINT.md
  modified:
    - skills/gsd-atlas/SKILL.md
    - scripts/skills.test.ts
    - scripts/eval/freeze-prereg.ts
    - scripts/eval/freeze-prereg.test.ts

key-decisions:
  - "Checkpoint reply `reopen-stage-a`: Stage A is reopened to add the Skill tool to the atlas arm; plan 03-38 owns the Stage A revision, the smoke run and the Stage B freeze"
  - "Task 3's smoke run and Stage B freeze are moved to plan 03-38; nothing is frozen by this plan"
  - "The user accepts the built skills as the skill to run with; no wording change was made in this continuation"

requirements-completed: [SKL-01]

coverage:
  - id: D1
    description: "Final gsd-atlas routing skill within its 80-line and 1,536-character limits, naming the seven tools and only real degraded codes"
    requirement: SKL-01
    verification:
      - kind: unit
        ref: "scripts/skills.test.ts (gsd-atlas limits and topics, degraded codes are real)"
        status: pass
    human_judgment: false
  - id: D2
    description: "gsd-atlas-module-author skill covering manifest, three queries, capture vocabulary, golden tests, grammar lock, parse budget, and a provisional precise-tier section"
    requirement: SKL-01
    verification:
      - kind: unit
        ref: "scripts/skills.test.ts (author skill topics, capture vocabulary covered)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Stage B freezer (`freeze-prereg.ts --stage B`) with its five refusals and success path"
    requirement: SKL-01
    verification:
      - kind: unit
        ref: "scripts/eval/freeze-prereg.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Stage B record in docs/eval/preregistration.md and the live smoke run (moved to plan 03-38)"
    verification: []
    human_judgment: true
    rationale: "Not done here. The human chose to reopen Stage A, so the skill hash must be recorded after plan 03-38 revises Stage A."

duration: continuation
completed: 2026-10-18
status: complete
---

# Phase 3 Plan 33: Final skills and the Stage B freezer Summary

**Final `gsd-atlas` routing skill, the `gsd-atlas-module-author` skill, tests that tie both to the shipped tool set, and a tested `--stage B` freezer; the smoke run and the Stage B record move to plan 03-38 because the human reopened Stage A.**

## Status

Tasks 1 and 2 are complete. Task 2 (blocking-human checkpoint) was answered with `reopen-stage-a`. Task 3 is split: the freezer code and its tests are done here (commits 33b7ea0, 19f0705); the smoke run and the Stage B record are NOT done and are moved to plan 03-38 (reason below). Nothing is frozen by this plan. Stage A is unchanged: `node scripts/eval/verify-prereg.ts` prints ok.

## Accomplishments

- `skills/gsd-atlas/SKILL.md` rewritten for the final seven tools: the whole routing sits in the description (the only part a model sees where a `Skill` tool exists), plus when-to-use and when-not-to, the tool table, reading an answer (`EXTRACTED`/`INFERRED`, `edge`, all fourteen degraded-code families, watermark, `fresh`), citing as `file:line`, and `untrusted_text` as data.
- `skills/gsd-atlas-module-author/SKILL.md` covers the manifest and `schemaVersion`, the three query files and the capture vocabulary, golden tests and `gsd-atlas lang test`, the grammar lock and parse budget, the TypeScript module as the worked example, and a precise-tier section marked provisional.
- `scripts/skills.test.ts` reads tool names from `src/query/tools.ts`, degraded codes from `src/facts/degraded.ts` and the capture families from the extractor, so the skills cannot drift from the code.
- `freeze-prereg.ts --stage B --by <name>` refuses `stage_a_not_frozen`, `skill_dirty`, `skill_missing`, `build_failed` and `already_frozen_b`, and records `stageB.skillSha256` and `stageB.atlasCommit` on success. Tested on a temporary repository.

## Checkpoint record (Task 2)

Reply, verbatim: "re-open stage a and run with the skill now that it's built"

Read as the grammar's `reopen-stage-a`. "now that it's built" is recorded as the user accepting the built skills (as of ae7ac92) as the skill to run with. It is not an `approve` reply, not option (a), and not a registered approval; the skill hash is registered by plan 03-38. The full record is in `03-33-CHECKPOINT.md` under "Resolution". It is deliberately not written to `docs/eval/preregistration.md`, a Stage A document that plan 03-38 will revise.

## Key finding: the skill is inert under the registered tool set

Under `--tools Bash,Read` (both arms, `scripts/eval/arms.ts` `BUILTIN_TOOLS`), the init event lists `gsd-atlas-eval:gsd-atlas` in `skills` (so `checkInit` passes) but the model sees neither the description nor the body: asked to quote the description it said it could see no skill list and has no `Skill` tool. With `--tools Bash,Read,Skill` it sees the full description and can load the body. Two live probes, 0.035 USD in total, `claude` 2.1.302, nothing committed. The 03-14 pilot's remark that the atlas arm's extra tokens came from "carrying the skill description" is wrong for the registered configuration; the scored run as registered would have measured the atlas tools plus server instructions, not the skill.

## What changed because of the pilot, and what was left alone

Changed: the description carries the whole routing; a one-line rule prefers atlas over grep for named-symbol questions; `code_impact` once instead of several greps; ADR questions route to `kind: adr`; an empty atlas answer is reported as "found nothing" and checked with one grep; every degraded code that can explain a weak answer is covered, including `compiler_fallback`, `memory_budget` and `resolver_timeout`. Left alone: the "when not to use atlas" rule, the citation rule, the untrusted-text rule and the read-only stance. No repository fact, file name or symbol from the question set appears in the skill.

## Why Task 3's smoke run and freeze move to plan 03-38

A smoke run or a Stage B record made now would be of a configuration the human has decided not to score (skill invisible to the model). Reopening Stage A changes the atlas arm's tools, `checkInit`, the allowed-tools list and probably the harness, all registered files, so the smoke run must follow the Stage A revision and the Stage B freeze must come after both. This continuation edited no Stage A file and ran neither.

## For plan 03-38

- Add `Skill` to the atlas arm only (`arms.ts` built-ins, `checkInit`, `allowedToolsFor` with `Skill(gsd-atlas-eval:gsd-atlas)`), design out the roughly 19 bundled Claude Code skills that would become visible in the atlas arm, re-freeze Stage A as a new registered version with approvals, then smoke run (needs at least one `mcp__gsd-atlas__` call; also record whether the skill was invoked, now possible), then `freeze-prereg.ts --stage B` on the final tree.
- T-03-334 gap: `scripts/eval/harness.ts` never compares the Stage B `atlasCommit` with the binary it runs, and the scored gate checks only the skill hash. A check that nothing under `src/`, `modules/`, `package.json` or `package-lock.json` differs between `atlasCommit` and HEAD (in `verify-prereg.ts` or the harness gate) would close it. Both are Stage A files.
- The three optional review points (unchanged, user accepted the text): (1) the `code_context` row's "what a TypeScript file compiles to" overlaps the emit question category (answer-key risk, T-03-332); (2) "confirm with one grep" after an empty atlas answer can add a tool call to atlas sessions; (3) the `code_impact` nudge toward a tool the pilot's atlas arm never called. Decide each once the description is actually in the model's context, since the token effect changes.

## Deviations from Plan

None in code. The plan's Task 3 is not completed as written; this is a human-directed change of scope (reply `reopen-stage-a`), not an executor deviation. The single-repo commit ledger of the first executor was not preserved across the continuation; `plan_head_before` is the first executor's base (5b032e4) and `commits` counts this plan's own commits: d1f642d, ae7ac92, 33b7ea0, 19f0705, 838a81a, 5f9fca3 and the SUMMARY commit.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build`: clean.
- `npm test`: 4428 tests, 4426 pass, 0 fail, 2 skipped (both pre-existing skips), no flakes seen.
- `node scripts/eval/verify-prereg.ts`: ok (Stage A unchanged).

## Known Stubs

None.

## Self-Check: PASSED

Checked: both skill files, `scripts/skills.test.ts`, the freezer and its test, the checkpoint record and commits d1f642d, ae7ac92, 33b7ea0, 19f0705, 838a81a, 5f9fca3 are ancestors of HEAD.
