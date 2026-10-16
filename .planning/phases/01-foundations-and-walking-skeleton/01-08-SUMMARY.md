---
phase: 01-foundations-and-walking-skeleton
plan: 08
subsystem: docs
tags: [adr, amendments, append-only, node-floor, d-16, d-17]
requires: [01-02, 01-06]
provides:
  - Dated amendment sections in six Accepted ADRs (language-modules x2, fact-store-interface x2, sqlite-store x2, tenant-composition, command-runner, trust-boundaries)
  - docs/adr/README.md Amendment log (ten lines)
  - Amendment-structure, append-only and D-17 tests in scripts/adr.test.ts
  - Node 24.16.0 floor recorded in 01-CONTEXT.md, REQUIREMENTS.md and PROJECT.md
affects: [01-09 to 01-14 (build what the amendments describe), Phase 2 first plan (FND-12 amendments), Phase 3 (TSM-07), Phase 5]
tech-stack:
  added: []
  patterns: [append-only ADR amendments guarded by a verbatim-sentence table, README amendment log checked by test]
key-files:
  created: []
  modified:
    - docs/adr/3-trust-boundaries.md
    - docs/adr/4-command-runner.md
    - docs/adr/5-language-modules.md
    - docs/adr/7-fact-store-interface.md
    - docs/adr/8-sqlite-store.md
    - docs/adr/9-tenant-composition.md
    - docs/adr/README.md
    - scripts/adr.test.ts
    - .planning/phases/01-foundations-and-walking-skeleton/01-CONTEXT.md
    - .planning/REQUIREMENTS.md
    - .planning/PROJECT.md
key-decisions:
  - "core-plus-recommended: apply D-16, D-17 and extras (a) git runs repo-controlled code, (b) parse budget in bytes inside ERROR nodes, (c) Node 24.16.0 floor with NUL self-test (Task 1 checkpoint, resolved by the user before this run)"
requirements-completed: [FND-10]
status: complete
duration: 25min
completed: 2026-10-15
plan_head_before: 8c9202eb4ca2e5b89d617f9ce2aa2a79b3d5b625
plan_head_after: d0a970820344ee3f555417aeda9b678f460dfaeb
commits: 4
actuals:
  tokens: 12000
  tasks: 3
  commits: 4
---

# Phase 1 Plan 08: Apply the Phase 1 ADR amendments Summary

Ten dated amendment sections are appended to six Accepted ADRs (the three D-16 amendments, the D-17 resolutions and the three approved extras) without deleting a single original line, backed by a 38-test `node --test` file and a README amendment log; the Node 24.16.0 floor is recorded in the planning artifacts this phase owns.

BASE (HEAD at plan start): `8c9202eb4ca2e5b89d617f9ce2aa2a79b3d5b625`. `git diff --numstat BASE HEAD -- docs/adr` shows 0 deleted lines in every file.

## Decisions

- **Task 1 (checkpoint:decision): `core-plus-recommended`.** The user chose, before this run, to apply D-16, D-17 and all three extras: (a) git runs repo-controlled code, (b) parse budget as bytes inside ERROR nodes rather than files, (c) Node 24.16.0 floor with an open-time NUL self-test. `SELECTED_EXTRAS` in `scripts/adr.test.ts` records the selection; a test asserts each extra is present exactly when selected (a `core-only` selection would assert they are absent).
- **Amendments reflect committed code.** The ProjectModel amendment names the manifest field exactly as `src/lang/manifest.ts` commits it: the optional `project.model` kebab-case id, next to `project.markers`. The parse-budget amendment names `parseBudget` (default 0.005), which the same file already carries.
- **README amendment log** is a `### Amendment log` subsection of the Ratification log, written as bullets (not table rows) so the existing "eight rows" assertion on the log table is untouched.
- **The two Phase 2 amendments are not applied**, per D-16 and FND-12: writer contention (worktree-lifecycle) and metrics migrations (value-dashboard). A test asserts neither draft carries an `## Amendment` section.
- **Requirement bookkeeping left to the orchestrator.** FND-10 is satisfied by this plan; REQUIREMENTS.md checkboxes, STATE.md and ROADMAP.md were deliberately not touched beyond the FND-02 wording edit the plan asks for.

## What was built

| Amendment (all dated 2026-10-15) | ADR | Source |
|----------------------------------|-----|--------|
| ProjectModel seam | 5-language-modules | FND-10, D-16 |
| Read-triggered cache write and SQLite-access wording | 7-fact-store-interface | FND-10, D-16 |
| Open questions resolved (no warm, `resolver_timeout`) | 7-fact-store-interface | D-17 |
| SQLite-access wording | 8-sqlite-store | FND-10, D-16 |
| Open questions resolved (watcher in Indexer, one fresh slot per request, file-set LRU) | 9-tenant-composition | D-17 |
| git runs repo-controlled code | 4-command-runner | extra (a) |
| git runs repo-controlled code | 3-trust-boundaries | extra (a) |
| Parse-error budget unit | 5-language-modules | extra (b) |
| Node floor and open-time self-test | 8-sqlite-store | extra (c) |

Planning artifacts: 01-CONTEXT.md gains a `### Amendments` block with `D-13 amended 2026-10-15` (original D-13 line unchanged); REQUIREMENTS.md FND-02 now says `Node >= 24.16, tsc emit`; PROJECT.md says `Node >= 24.16` and has a Key Decisions row for the floor. The FND-10 and FND-12 lines and the traceability rows are unchanged.

Tests added to `scripts/adr.test.ts` (6, in `ADR amendments (FND-10, D-16, D-17)`): `amendments are appended and dated` (heading format, real date, not before ratification, after the last original section, nothing original after an amendment, a `Sources:` line, keywords), `original decision text is preserved` (a verbatim-fragment table of 5 to 12 fragments per ADR, six ADRs), `D-17 resolutions are recorded`, `extra amendments match the recorded Task 1 selection`, `the amendment log in the README lists every amendment` and `the Phase 2 amendments are not applied here`.

## Verification

- `npm test`: 345 pass, 0 fail. `npm run lint` and `npm run typecheck`: clean.
- `git diff --numstat BASE HEAD -- docs/adr`: additions only (README 13, 3-trust-boundaries 6, 4-command-runner 13, 5-language-modules 19, 7-fact-store-interface 18, 8-sqlite-store 12, 9-tenant-composition 10), 0 deletions.
- `git diff --numstat BASE HEAD -- .claude .planning/STATE.md .planning/research docs/DESIGN.md docs/PRD.md .planning/ROADMAP.md`: empty.

## Deviations from Plan

None in substance. Two process notes:

1. The test file was built up in step with each task so every task commit is green (language-modules only at Task 2, plus the three D-16/D-17 ADRs at Task 3, plus the extras at Task 4); an earlier all-at-once red commit was folded away with a soft reset of my own unpushed commit before the first task commit. No file content was lost.
2. A backslash-digit sequence (such as an escaped NUL) in the sqlite-store amendment would trip the existing lost-text-token test, so the NUL evidence is worded in prose instead.

## Known Stubs

None.

## Flagged for the user

Mentions this plan was told not to edit. `.claude/CLAUDE.md` is generated from the research STACK document and will be rewritten when regenerated, so fix STACK.md first.

**Node 24.15 floor (stale after the 2026-10-15 decision):**
- `.claude/CLAUDE.md:41` (finding 8: "Declare a floor of Node 24.15"), `:51` (core technologies row: `engines: ">=24.15.0"`, CI 24.15.0), `:175` (version compatibility row: "Node >=24.15 (RC)")
- `.planning/research/STACK.md:22`, `:32`, `:73` (CI matrix recommendation with 24.15.0), `:123` (`"engines": {"node": ">=24.15.0"}`), `:183`
- `.planning/research/SUMMARY.md:20` ("Node >= 24.15"), `:74` (floor 24.15 vs unverified NUL bug; now verified)
- `.planning/research/PITFALLS.md:100` and `:452` (NUL bug marked UNVERIFIED; 01-RESEARCH.md Pitfall 2 has since verified it directly)
- `.planning/STATE.md:83` (lists the NUL-truncation bug as unconfirmed and the floor as 24.15)
- Historical records, left as written and not worth editing: `.planning/phases/01-foundations-and-walking-skeleton/01-RESEARCH.md` (D-13 copy at :33, FND-02 row at :60, Pitfall 2 and Open Question 1) and `01-DISCUSSION-LOG.md:84-85`.

**File-count parse budget (superseded by the Parse-error budget unit amendment):**
- `docs/DESIGN.md:60` (A48: "parse-error budget checked in CI" with no unit, compatible) and `docs/DESIGN.md:147` (table row: "Files with grammar parse errors | ≤ 0.5 % per module (A48)")
- `docs/PRD.md:352` (acceptance criterion 1: "files with grammar parse errors ≤ 0.5 %")
- The grep pattern for `0.5 %` matched because the documents use a non-breaking space; the hits above are those lines.

## Self-Check: PASSED

- All eleven modified files exist; all four commits (`e8f9ae2`, `bdd823a`, `598deb6`, `d0a9708`) are ancestors of HEAD.
- `node --test scripts/adr.test.ts`: 38 pass, 0 fail.
- `.codegraph/` (created for navigation in the worktree) was never staged.
