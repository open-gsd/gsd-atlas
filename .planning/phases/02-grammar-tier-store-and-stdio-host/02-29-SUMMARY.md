---
phase: 02-grammar-tier-store-and-stdio-host
plan: 29
subsystem: planning-gate
tags: [constants, gate, gap-closure, timeouts]
requires: []
provides:
  - "Approved addendum in 02-CONSTANTS.md: pool.loadTimeoutMs, pool.terminateGraceMs, host.idleEvictMs, runner.defaultTimeoutMs"
  - "Recorded STO-05 policy thresholds compact.fullFreeFraction and compact.fullUnusedFraction"
affects: [02-38, 02-39, 02-41, 02-30, 02-37]
key-files:
  created: []
  modified:
    - .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md
decisions:
  - "pool.loadTimeoutMs 30000, pool.terminateGraceMs 2000, host.idleEvictMs 1800000, runner.defaultTimeoutMs 60000 approved unchanged by the user"
status: complete
commits: 2
plan_head_before: 27ae4745b8b40d2ef56534198753f39e59ef3085
plan_head_after: fb1abbdc0d6acc8cd97daf20a0b426a584009a31
actuals:
  tokens: 3200
  tasks: 2
  commits: 2
metrics:
  completed: 2026-10-17
---

# Phase 2 Plan 29: Gap-closure constants addendum Summary

Addendum 2026-10-17 added to 02-CONSTANTS.md, with four new timeout-shaped constants approved by the user in writing (status line reads `Approved (2026-10-17, by the user, relayed by the orchestrator)`), so plans 02-38, 02-39 and 02-41 can run unattended.

## What was done

- Task 1: appended `## Addendum 2026-10-17 (gap closure)` after the Approvals section: the four new keys with basis, the two existing thresholds recorded as the idle loop's policy, the derived-values table (checkpoint busy timeout 0, 128-byte per-record allowance, per-request batch-check bound, dbstat-less compaction fallback rule), the reused approved values, and the "Exception to maintenance.sliceMs" paragraph for the unsliceable full VACUUM. Commit c2ce099.
- Task 2 (blocking-human gate): the user answered "Approve all four (Recommended)" in the orchestrating session via AskUserQuestion. The status line was rewritten to Approved and the reply recorded verbatim under "Addendum approvals". Commit fb1abbd. The gate was not auto-approved.

## Approved values

| Key | Value |
|-----|-------|
| pool.loadTimeoutMs | 30000 |
| pool.terminateGraceMs | 2000 |
| host.idleEvictMs | 1800000 |
| runner.defaultTimeoutMs | 60000 |

No existing approved value changed. Text above the addendum heading is byte-identical to the original (verified with `cmp` against a copy taken before the edit).

## Deviations from Plan

None - plan executed as written. Task 1 and Task 2 were committed separately (propose, then approve) as the plan sequences them; the approval was supplied by the orchestrator from the user's session reply rather than returned as a checkpoint. The plan text says "three new keys" in places but lists four; all four were written. STATE.md and ROADMAP.md were not modified, per the orchestrator's instruction.

## Verification

Task 2 automated verify (status line matches `Addendum status: Approved (`) passes, as do the Task 1 key-presence and title checks (Task 1's literal `Addendum status: Proposed` check is superseded by the approval).

## Known Stubs

None.

## Threat Flags

None. No code or runtime surface touched.

## Self-Check: PASSED

- FOUND: .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md
- FOUND commit c2ce099, fb1abbd (ancestors of HEAD)
