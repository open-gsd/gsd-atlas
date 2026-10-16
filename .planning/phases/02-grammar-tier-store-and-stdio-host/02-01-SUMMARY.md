---
phase: 02-grammar-tier-store-and-stdio-host
plan: 01
subsystem: docs
tags: [adr, ratification, amendments, adr-ratify, fnd-12]
requires:
  - phase: 01-foundation
    provides: ADR machinery (scripts/adr.ts, adr-ratify.ts, adr.test.ts) and the eight Phase 1 Accepted ADRs
provides:
  - four Phase 2 ADRs Accepted under issues 11 to 14 (worktree-lifecycle, query-and-policy, mcp-contract, value-dashboard)
  - six dated 2026-10-16 amendments (worktree-lifecycle, value-dashboard, query-and-policy, mcp-contract, command-runner, sqlite-store)
  - PHASE2_SLUGS and RATIFIED_SLUGS exports gating adr-ratify
affects: [02-02, 02-03, 02-19, all Phase 2 code plans, phase 3 and 4 ADR ratification]
actuals:
  tokens: 15000
  tasks: 3
  commits: 5
  note: "commits counts the plan's own commits (git log --grep 02-01). plan_head_before/plan_head_after are not a clean range because plans 02-02 and 02-03 committed on the same branch in between (21 commits in the raw range)."
plan_head_before: 9474a40854e4d836ea48289d4e64c1e97aca536f
plan_head_after: 2034958a4368fc189eba91a64fe741b77f1268a8
tech-stack:
  added: []
  patterns: ["test-first ADR amendments: AMENDED table entry (>=5 verbatim preserved sentences) added before the amendment text"]
key-files:
  created:
    - docs/adr/11-worktree-lifecycle.md
    - docs/adr/12-query-and-policy.md
    - docs/adr/13-mcp-contract.md
    - docs/adr/14-value-dashboard.md
  modified:
    - scripts/adr.ts
    - scripts/adr-ratify.ts
    - scripts/adr.test.ts
    - docs/adr/README.md
    - docs/adr/4-command-runner.md
    - docs/adr/8-sqlite-store.md
    - docs/adr/7-fact-store-interface.md
    - docs/adr/9-tenant-composition.md
    - docs/PRD.md
    - docs/DASHBOARD-METRICS.md
    - .claude/CLAUDE.md
key-decisions:
  - "Phase 2 ADR amendments record the in-process Host, six-tool default profile, nonce-fenced untrusted_text, keyset cursor with watermark_moved, and code_impact with chain_confidence before the code lands"
  - "lease.db BEGIN EXCLUSIVE leader/follower model recorded as a worktree-lifecycle amendment; build and maintain exit 3 when the lease is held"
requirements-completed: [FND-12]
coverage:
  - id: D1
    description: "Four Phase 2 ADRs ratified (numbered, Accepted, README table, ratification log, schedule trimmed to the two remaining drafts)"
    requirement: FND-12
    verification:
      - kind: unit
        ref: "scripts/adr.test.ts#Phase 1 ADR set (integration over the real docs/adr)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Six dated amendments with Sources lines, keywords, preserved original text and amendment-log lines"
    requirement: FND-12
    verification:
      - kind: unit
        ref: "scripts/adr.test.ts#ADR amendments (FND-10, D-16, D-17)"
        status: pass
    human_judgment: false
  - id: D3
    description: "adr-ratify accepts all twelve ratifiable slugs and refuses to ratify an already-numbered slug twice without changing any file"
    requirement: FND-12
    verification:
      - kind: unit
        ref: "scripts/adr.test.ts#adr-ratify slug sets (FND-12, D-18)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Substance of the amendments (code_impact semantics, leader/follower model, retention) is a design judgment"
    verification: []
    human_judgment: true
    rationale: "Tests check structure and keywords, not whether the decisions are right; the design owner reviews the amendment prose"
duration: ~45 min active (wall time longer: paused for issue numbers and for plan 02-03 to release the shared index)
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 01: ADR ratification and Phase 2 amendments Summary

**Four Phase 2 ADRs (worktree-lifecycle, query-and-policy, mcp-contract, value-dashboard) ratified as issues 11 to 14, with six dated amendments recording the lease.db leader/follower model, the six-tool in-process contract, code_impact chain confidence with a worked acceptance example, and the Metrics migration and retention policy.**

## Performance

- **Tasks:** 3 (Task 1 tracer, Tasks 2 and 3 auto, all with `tdd="true"`)
- **Files modified:** 15 (4 renamed or created ADRs, 3 scripts, 7 docs and instructions files)
- **Completed:** 2026-10-16

## Accomplishments
- `scripts/adr.ts` exports `PHASE2_SLUGS` and `RATIFIED_SLUGS` (twelve distinct slugs); `adr-ratify` gates `--slug` on `RATIFIED_SLUGS`; `PHASE1_SLUGS` is unchanged with its eight values.
- `scripts/adr.test.ts` derives its counts from `RATIFIED` and `REMAINING`, drops the obsolete "Phase 2 amendments are not applied" case, and adds a case that a second ratify run exits 1 with "refusing to ratify twice" and changes no file.
- Twelve numbered Accepted ADR files and exactly two drafts (`user-controlled-diagnostics` for Phase 3, `host-process-model` for Phase 4) remain in `docs/adr`.
- Amendments: worktree-lifecycle "Writer contention and leader/follower"; value-dashboard "Metrics migrations and retention"; query-and-policy "Phase 2 shape" (includes the a/b/c code_impact example plan 02-19 reproduces); mcp-contract "Phase 2 contract changes"; command-runner "Source Tree git subcommands"; sqlite-store "Phase 2 store policy".
- `.claude/CLAUDE.md` Node floor text corrected from 24.15 to 24.16 on the three Technology Stack lines that state the floor.

## Task Commits

1. **Task 1 (tracer): scripts and worktree-lifecycle** - `6789839` (test, RED), `5446153` (docs, GREEN)
2. **Task 2: query-and-policy, mcp-contract, value-dashboard** - `3d8813f` (query-and-policy), `2034958` (mcp-contract and value-dashboard)
3. **Task 3: worktree-lifecycle, command-runner, sqlite-store amendments, Node floor** - `fabcbf8`

Task 2 was split across two commits because the mcp-contract and value-dashboard issue numbers were created later than query-and-policy's.

## TDD Gate Compliance
- RED: `6789839` changes `scripts/adr.test.ts` so the target test "PHASE2_SLUGS is exactly the four Phase 2 ADRs and RATIFIED_SLUGS is Phase 1 then Phase 2" fails on its deepEqual (`PHASE2_SLUGS` undefined). `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (TAP, 39 tests, 5 failing). Semantic assessment: the file loaded, the target ran and failed on the planned assertion, 34 other tests passed.
- GREEN: `5446153` implements the exports, performs the worktree-lifecycle ratification and passes the suite.
- Tasks 2 and 3 are doc-only (no source file), so the MVP/TDD gate was inactive; their AMENDED test entries were still added first and seen to fail.

## Decisions Made
- Amendment dates use the ratification day 2026-10-16, which is never earlier than any ADR's Ratified date.
- The README schedule and Naming rewrite was done once, at the end, because the README tests pin the schedule row count to the REMAINING set at every step.

## Deviations from Plan

### Auto-fixed / process deviations

**1. [Rule 3 - Blocking] Issue creation delegated to the orchestrator**
- **Found during:** Task 1 step 4
- **Issue:** A no-defer PreToolUse guard denied `gh issue create`; the dispatch forbade bypassing guards.
- **Fix:** The orchestrator created issues 11 to 14 at the user's direction; the plan then ran with `--issue 11`, `12`, `13`, `14`.
- **Committed in:** n/a (no code change)

**2. [Process] Shared git index with plans 02-02 and 02-03**
- **Found during:** Task 1 commit
- **Issue:** Plan 02-02 ran concurrently in the same worktree; its commit `26227b7` swept in my staged `git mv` of `draft-worktree-lifecycle.md` to `11-worktree-lifecycle.md`. The rename is therefore recorded under that commit, not under `5446153`.
- **Fix:** None needed; the tree state is correct. After that, files were staged by explicit path and `git diff --cached --name-only` was checked before each commit.

**3. [Process] Branch allow-list**
- `worktree-phase-02-execute` does not match the per-agent branch pattern of the worktree commit guard; the orchestrator accepted the deviation.

**Total deviations:** 3 process deviations, no code deviations.
**Impact on plan:** None on content. Task 2 and the README schedule rewrite were sequenced differently from the plan because of the issue timing.

## Issues Encountered
- The `adr.test.ts` RED for a missing named export would have been a load failure (INVALID_RED); the RED commit used a namespace import so the file loaded and the target failed on an assertion, then GREEN switched back to named imports.
- The concurrency edge (two simultaneous ratifications of one slug) is covered only by the existing final-name-exists check and `git mv` failing; no dedicated test (backstop verification, as the plan states).

## Known Stubs
None.

## Threat Flags
None. The plan touches documentation and scripts only; T-02-01 is mitigated by the existing `rewriteReferences` boundary tests plus a review of every rewritten file (PRD.md, DASHBOARD-METRICS.md, and the Refines and cross-reference lines in ADRs 7, 9 and 12).

## User Setup Required
None.

## Next Phase Readiness
- Later Phase 2 plans code against Accepted text. Plan 02-19 reproduces the query-and-policy worked example as a golden test.
- The two remaining drafts (`user-controlled-diagnostics` for Phase 3, `host-process-model` for Phase 4) stay Proposed.

## Self-Check: PASSED
- Files exist: docs/adr/11-worktree-lifecycle.md, 12-query-and-policy.md, 13-mcp-contract.md, 14-value-dashboard.md.
- Commits present: 6789839, 5446153, 3d8813f, fabcbf8, 2034958.
- `node --test scripts/adr.test.ts` passes (39/39); `node --test scripts/package.test.ts` passes (9/9).

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
