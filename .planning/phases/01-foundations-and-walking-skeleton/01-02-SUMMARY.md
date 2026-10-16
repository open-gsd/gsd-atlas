---
phase: 01-foundations-and-walking-skeleton
plan: 02
subsystem: docs
tags: [adr, ratification, github-issues, link-check]
requires: []
provides:
  - Eight Phase 1 ADRs Accepted as docs/adr/<issue#>-<slug>.md with GitHub issues #2 to #9
  - scripts/adr.ts helpers, scripts/adr-ratify.ts CLI and scripts/adr.test.ts
  - docs/adr/README.md Ratification log and Ratification schedule
affects: [01-08 (ADR amendments), Phase 2 first plan (ratifies four ADRs), Phase 3, Phase 4]
tech-stack:
  added: []
  patterns: [node:test over real docs tree, ratify via git mv plus header-only rewrite]
key-files:
  created:
    - scripts/adr.ts
    - scripts/adr-ratify.ts
    - scripts/adr.test.ts
  modified:
    - docs/adr/README.md
    - docs/PRD.md
    - docs/DASHBOARD-METRICS.md
    - docs/adr/draft-host-process-model.md
    - docs/adr/draft-value-dashboard.md
    - docs/adr/draft-worktree-lifecycle.md
  renamed:
    - docs/adr/2-product-boundary.md
    - docs/adr/3-trust-boundaries.md
    - docs/adr/4-command-runner.md
    - docs/adr/5-language-modules.md
    - docs/adr/6-fact-model.md
    - docs/adr/7-fact-store-interface.md
    - docs/adr/8-sqlite-store.md
    - docs/adr/9-tenant-composition.md
key-decisions:
  - "open-all: open one GitHub issue per Phase 1 ADR in the private repo open-gsd/gsd-atlas (Task 1 checkpoint, resolved by the user before this run)"
requirements-completed: [FND-09]
status: complete
duration: 4min
completed: 2026-10-15
plan_head_before: 3576e2be5e8316f004c08d89af3cb14531124e98
plan_head_after: 004bef9858b6b1317dcc341b50a32a30f30c31ce
commits: 4
actuals:
  tokens: 6500
  tasks: 3
  commits: 4
---

# Phase 1 Plan 02: Ratify the eight Phase 1 ADRs Summary

Eight Phase 1 ADRs are Accepted with GitHub issues #2 to #9, renamed to `<issue#>-<slug>.md`, with a Ratification log and a schedule for the six remaining ADRs, backed by a 32-test `node --test` file that also checks every relative markdown link.

BASE (HEAD at plan start): `3576e2be5e8316f004c08d89af3cb14531124e98`.

## Decisions

- **Task 1 (checkpoint:decision): `open-all`.** The user approved opening one issue per Phase 1 ADR (eight, one batch) in the private repo open-gsd/gsd-atlas before this run. Verified before acting: `gh` logged in as trek-e, repo visibility PRIVATE, issues enabled, no existing issues.
- Issue numbers came from `gh issue create` output and are recorded only in the ADR headers, README log and this summary.

## What was built

| Slug | Issue | File |
|------|-------|------|
| product-boundary | #2 | docs/adr/2-product-boundary.md |
| trust-boundaries | #3 | docs/adr/3-trust-boundaries.md |
| command-runner | #4 | docs/adr/4-command-runner.md |
| language-modules | #5 | docs/adr/5-language-modules.md |
| fact-model | #6 | docs/adr/6-fact-model.md |
| fact-store-interface | #7 | docs/adr/7-fact-store-interface.md |
| sqlite-store | #8 | docs/adr/8-sqlite-store.md |
| tenant-composition | #9 | docs/adr/9-tenant-composition.md |

- Issue titles are `ADR: <H1>` with U+2011 replaced by a plain hyphen. Each body is the single approved paragraph, with no ADR text, code or paths beyond it. All eight issues are OPEN. Nothing else was opened, closed or deleted.
- `scripts/adr.ts` exports `PHASE1_SLUGS`, `ratifyText`, `rewriteReferences`, `findAdrFile`, `collectLinkFiles`, `checkRelativeLinks` (plus `REPO_URL`, `BrokenLink`). Node built-ins only.
- `scripts/adr-ratify.ts`: `--slug`, `--issue`, `--date` (default local date), `--dry-run`; `git mv` through `execFileSync` with an argument array, no shell.
- Header-only edits: `ratifyText` changes the Status and Issue lines and inserts a Ratified line, all within the header before the first `## ` heading. `numstat` for each renamed ADR shows 3 to 8 lines touched, so decision text is untouched.
- README: Accepted for eight rows, Proposed for six; Ratification log (8 rows); Ratification schedule (6 rows: worktree-lifecycle, query-and-policy, mcp-contract, value-dashboard in Phase 2; user-controlled-diagnostics in Phase 3; host-process-model in Phase 4); a Naming sentence recording the 2026-10-15 ratification; a note listing the editorial repairs.
- Links in the three still-draft ADRs (host-process-model, value-dashboard, worktree-lifecycle), `docs/PRD.md` and `docs/DASHBOARD-METRICS.md` now point to the new file names. The six non-Phase-1 ADRs keep their draft names and Proposed status.

## TDD record

- RED (`d409f1e`, `8951914`): tests fail on behavior. First run: `adr.ts` stubs throw, so unit and integration tests fail; second run: 17 of 32 fail on the new ratified/log/schedule/repair assertions while the 15 earlier tests pass.
- GREEN (`da27104`, `004bef9`): `node --test scripts/adr.test.ts` reports 32 tests, 32 pass, 0 fail, 0 skipped.
- Baseline link check over the scoped files was clean before any rename, so there were no pre-existing broken links.

## Deviations from Plan

### Auto-fixed Issues

None in code. Two environment-driven adjustments:

**1. [Rule 3 - Blocking] `.planning/PROJECT.md` is not in this worktree.**
- **Found during:** Task 2 (step 5) and Task 3.
- **Issue:** The worktree base (remote default branch) has no `.planning/` directory, so the rewrite step could not update `.planning/PROJECT.md`. Plan docs may only be read, never written, in the main checkout.
- **Fix:** `collectLinkFiles` skips scoped files that do not exist. The integration test asserts "no `draft-<slug>` in `.planning/PROJECT.md`" only when that file exists. The Task 2 acceptance line "PROJECT.md contains no `draft-product-boundary`" is therefore NOT satisfied by this branch and needs the orchestrator step below.
- **Orchestrator action (main checkout):** in `.planning/PROJECT.md` line 16, change `docs/adr/draft-product-boundary.md` to `docs/adr/2-product-boundary.md`. Line 55 (`14 docs/adr/draft-*.md (all Proposed)`) is a glob in prose, not a link; update its count wording (8 Accepted, 6 Proposed) at your discretion. Until line 16 is changed, `node --test scripts/adr.test.ts` run in the main checkout fails the product-boundary integration test.
- **Files modified:** none in this branch.

**2. [Process] Issue-creation hook override.**
- **Found during:** Task 2 step 4.
- **Issue:** The `no-defer-guard` hook blocks `gh issue create` by default, since it targets filing a self-found defect.
- **Fix:** These are the planned FND-09 roadmap issues the user approved at Task 1, which the hook explicitly exempts, so each of the eight calls ran with `GSD_ISSUE_TRIAGE_OK=1`. No other issues were created.

The tracer gate (Task 2): the `<verify>` command re-ran green (15/15 at the time) before expansion.

## Editorial repairs (pending human review, T-01-05)

A lost-text token (backslash plus digit one) was repaired from `docs/PRD.md` section 4.6 and `docs/DESIGN.md` A9:

1. `docs/adr/3-trust-boundaries.md` decision 2: restored `2. **Commands.**` with three rules (grammars and queries always allowed; built-in first-party providers run by default and can be turned off; any other command needs user approval per repo and per command and never runs through MCP unless the host was started with `--allow-build`), then the existing "All of them start through one CommandRunner..." sentence as a fourth bullet.
2. `docs/adr/5-language-modules.md` decision 5: new bullet that any other command (a module's `precise.command`, a third-party SCIP indexer) runs only when allowed in user-level config per repo and per command, that repo-committed config and repo or npm modules can never grant it, and that it never runs through MCP unless started with `--allow-build`; the "All of it runs through the one CommandRunner" bullet follows unchanged.
3. `docs/adr/6-fact-model.md` decision 2 and `docs/PRD.md` line 193: removed the token and the following space; the next sentence is self-contained.

The test suite asserts no backslash-digit token remains in the eight ADRs or `docs/PRD.md`.

## Flagged for the user

- `docs/SDK-PROVIDERS.md` line 123 ends mid-sentence ("... with introduced, deprecated and removed; and" then the corrupted token). The lost clause cannot be recovered from any source, so the file is unchanged by this plan (`git diff --numstat BASE HEAD -- docs/SDK-PROVIDERS.md` prints nothing). Please supply the missing clause or confirm it can be dropped.
- Review the four repaired passages above at end-of-phase (the plan's human-check).
- The README "Naming" paragraph still says "The repo has no issues yet"; it was left as written and only a sentence was appended.

## Known Stubs

None.

## Threat Flags

None. Mitigations applied: T-01-03 (approval first, bodies title paragraph only, repo confirmed private), T-01-04 (header-only rewrite, link check, snapshot folders excluded), T-01-05 (repairs sourced and logged).

## Verification

- `node --test scripts/adr.test.ts`: 32 pass, 0 fail.
- `gh issue list -R open-gsd/gsd-atlas --state all`: eight issues, #2 to #9, all titles start `ADR: `, all OPEN.
- `git ls-files docs/adr`: eight numbered ADRs, six `draft-*.md`.
- `docs/SDK-PROVIDERS.md` unchanged against BASE.

## Self-Check: PASSED

- Files present: scripts/adr.ts, scripts/adr-ratify.ts, scripts/adr.test.ts, docs/adr/2..9 files.
- Commits present: d409f1e, da27104, 8951914, 004bef9.
