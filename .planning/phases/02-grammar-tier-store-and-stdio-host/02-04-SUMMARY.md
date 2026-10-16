---
phase: 02-grammar-tier-store-and-stdio-host
plan: 04
subsystem: infra
tags: [constants, governance, package-legitimacy, mcp-sdk, human-gate]

requires:
  - phase: 01-foundations-and-walking-skeleton
    provides: held-back timeout defaults (01-09 runner 60 s, 01-10 SQLite busy) that this plan resolves
provides:
  - "02-CONSTANTS.md with Status Approved: every Phase 2 timeout, queue bound and gate threshold, user-approved unchanged"
  - "User approval of @modelcontextprotocol/server 2.3.1 for install by plan 02-23 only"
affects: [02-05, 02-06, 02-09, 02-10, 02-12, 02-14, 02-15, 02-16, 02-17, 02-18, 02-19, 02-20, 02-23, 02-24, 02-26, 02-28]

actuals:
  tokens: 6500
  tasks: 3
  commits: 2

plan_head_before: c29ef7bfdd957ccdc27c26c915bf72643ba0ffd3
plan_head_after: 1be50a8517e308419b6431463c4678ba054e95f9

tech-stack:
  added: []
  patterns:
    - "Constants gate: consuming plans read values from 02-CONSTANTS.md and halt at a precondition unless Status is Approved"

key-files:
  created:
    - .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md
  modified: []

key-decisions:
  - "User approved all proposed Phase 2 constants unchanged on 2026-10-16 (no keys changed, no rows removed)"
  - "User approved @modelcontextprotocol/server 2.3.1 (exact pin) for install by plan 02-23 only; @modelcontextprotocol/node stays uninstalled in Phase 2"

requirements-completed: [IDX-01, IDX-02, HST-01, HST-03, STO-05, STO-08]

duration: 12min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 04: Constants and MCP SDK Package Approval Summary

**Human-approved Phase 2 constants table (git, SQLite busy, indexer, governor, query, gate values) plus legitimacy sign-off for the too-new @modelcontextprotocol/server 2.3.1, with nothing installed.**

## Performance

- **Duration:** about 12 min across the proposal and the continuation
- **Completed:** 2026-10-16
- **Tasks:** 3 (1 auto, 2 blocking-human checkpoints)
- **Files modified:** 1

## Accomplishments
- 02-CONSTANTS.md lists every timeout, queue bound and gate threshold Phase 2 writes into code, each with consumer plan and basis, and now reads `Status: Approved (2026-10-16, by the user)`.
- Registry evidence (version, licence, repository, integrity string, dependency list) for @modelcontextprotocol/server 2.3.1 and @parcel/watcher 2.6.0 is recorded.
- The Approvals section records both user replies verbatim ("approved" for the constants, "approved" for the package) with the date, unblocking plans 02-05 onward and plan 02-23's install precondition.

## Task Commits

1. **Task 1: Write 02-CONSTANTS.md as Proposed and gather package evidence** - `e9ab2be` (docs)
2. **Task 2: Human approval of the constants** - checkpoint answered "approved"; recorded in `1be50a8` (docs)
3. **Task 3: Human verification of @modelcontextprotocol/server 2.3.1** - checkpoint answered "approved"; recorded in `1be50a8` (docs)

**Plan metadata:** committed separately as `docs(02-04): complete constants and package approval plan`.

## Files Created/Modified
- `.planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md` - approved constants table, package evidence, approval record

## Decisions Made
- Constants accepted unchanged, including those locked by earlier decisions (D-12, D-13, D-16, D-17, QRY-02, STO-05).
- @modelcontextprotocol/server 2.3.1 approved for `npm install --save-exact` by plan 02-23 only, scripts disabled; no other plan installs it.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The two blocking-human checkpoints were never auto-approved; the user's replies were relayed by the orchestrator in the user's own session turn.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None.

## Threat Flags

None. No source, dependency or workflow change; T-02-09 and T-02-10 mitigations (human review before install, human-approved constants) are satisfied.

## Next Phase Readiness
- Wave 2 plans may read their values from 02-CONSTANTS.md (Status Approved).
- Plan 02-23 precondition (package approval) is satisfied; it performs the only install.
- Requirements are marked complete in REQUIREMENTS.md only where the ready-ids check allows; sibling plans for IDX-01, IDX-02, HST-01, HST-03, STO-05 and STO-08 may remain open.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*

## Self-Check: PASSED

- FOUND: .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (`Status: Approved`, `## Approvals` present)
- FOUND commits: e9ab2be, 1be50a8
