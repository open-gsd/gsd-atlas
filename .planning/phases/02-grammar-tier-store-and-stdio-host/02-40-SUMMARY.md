---
phase: 02-grammar-tier-store-and-stdio-host
plan: 40
subsystem: tenant
tags: [idle-maintenance, vacuum, lease, messages, constructor-cleanup, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "plan 02-30: IDLE_MAINTENANCE, store.maintain(budget, options), StoreStatus.leaseHolder"
provides:
  - "Tenant idle round requests the full compaction (IDLE_MAINTENANCE) in both the store.maintain path and the WriterBusy fallback"
  - "src/tenant/messages.ts: notIndexedNoStore, notIndexedEnvelope(holder), leaseHeldEnvelope(holder), storeUnavailableEnvelope"
  - "createTenant closes module host, Metrics and store (lease) when a later construction step throws"
  - "StoreClosed from the store becomes a store_unavailable envelope from handle, build, maintain and statusEnvelope"
affects: [02-41 Host (uses notIndexedNoStore), 02-42 ADR amendment]
tech-stack:
  added: []
  patterns:
    - "abandon(error): one cleanup-and-rethrow path for every construction step after the store opened"
    - "message builders take the holder as {pid, version}; text carries no path"
key-files:
  created:
    - src/tenant/messages.ts
    - src/tenant/idle-compaction.test.ts
    - src/tenant/messages.test.ts
    - src/tenant/create-failure.test.ts
  modified:
    - src/tenant/create.ts
    - src/tenant/index.ts
key-decisions:
  - "The WriterBusy fallback sends the full request with compact only after a collect that reported complete, mirroring store.maintain"
  - "leaseHeld, notIndexed and failure became async because they read StoreStatus.leaseHolder; a failing status read yields the generic text, never a throw"
  - "The honest limit is in the text: until the socket Host (Phase 4, D-01) the only way to build while another process leads is to end that process"
requirements-completed: [STO-05, STO-10, STO-08, QRY-04, HST-02]
status: complete
commits: 2
plan_head_before: 7a3fbead7eaa8ecc28b579597aef5edf9fd3dae2
plan_head_after: 0e4995c3b4e08926385968af3337d932801d2846
actuals:
  tokens: 8500
  tasks: 2
  commits: 2
duration: ~1h
completed: 2026-10-17
---

# Phase 2 Plan 40: Tenant idle compaction, working messages, guarded constructor Summary

**The Tenant's idle loop now passes `IDLE_MAINTENANCE` so a long-lived leader vacuums a fragmented store once and a healthy one never; `not_indexed` and `lease_held` name the holder and the working sequence; a throwing construction releases its lease.**

## Tasks

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Tracer: idle round vacuums a fragmented store, leaves a healthy one alone | 40dfd94 | src/tenant/create.ts, src/tenant/idle-compaction.test.ts |
| 2 | Messages that work, constructor that does not leak, StoreClosed as store_unavailable | 0e4995c | src/tenant/create.ts, messages.ts, index.ts, messages.test.ts, create-failure.test.ts |

## Accomplishments

- `maintenanceSlice` calls `store.maintain(tuning.maintenanceSliceMs, IDLE_MAINTENANCE)`. In the `WriterBusy` fallback `compact` gets `IDLE_MAINTENANCE` only when the preceding `collect` reported complete; `check` still runs only when both finished. The request path (`runTask`, CLI `maintain compact`) is untouched, so `full` stays explicit there.
- End-to-end: a store seeded with 300 files and 1500 scattered edits (plan 02-18 shape, collected) is vacuumed exactly once by the leader's first idle round, ends smaller, and a second quiet period adds no VACUUM. A fresh 300-file store is never vacuumed. A follower runs no maintenance and no VACUUM. A request arriving mid-round stops it before the next slice (0 VACUUMs); the next quiet period vacuums.
- Messages: the leader's `not_indexed` names its pid and version, says a build in a terminal answers `lease_held` (exit 3), and gives the sequence (end the agent session, run `gsd-atlas build`, start the agent again). A follower's `lease_held` names the leader's pid and version (not its own). Unknown holder gives a general sentence. No text carries a path (checked against the repo and store directories). Codes are unchanged.
- Constructor: `abandon(error)` closes the follower module host, the Metrics instance and the store (releasing the lease) and rethrows the original error; applied around Metrics opening, follower overlay and Query construction, and the first `store.status()`.
- `StoreClosed` from `query.ask`, `isLeader`, `snapshot` becomes `store_unavailable`.

## Mutation checks

- Dropping `IDLE_MAINTENANCE` from the `store.maintain` call in `maintenanceSlice` fails three cases (`calls maintain with the idle policy`, `vacuums a fragmented store once`, `yield`).
- Removing `store.close()` from `abandon` fails both constructor-failure lease cases.

## Deviations from Plan

### Auto-fixed / adjusted

**1. [Rule 3 - Blocking] Deep import of the VACUUM test hook**
- **Found during:** Task 1 lint
- **Issue:** `lifecycleTestHooks.onVacuum` is exported only from `src/fact-store/lifecycle.ts`; the lint rule (D-12) forbids importing it from the tenant module.
- **Fix:** one `eslint-disable-next-line no-restricted-imports` with a justification comment at that import in `idle-compaction.test.ts`. The public Fact Store surface was not widened. Alternative for a reviewer to consider: export the hook helpers from a test-only subpath.
- **Files modified:** src/tenant/idle-compaction.test.ts
- **Commit:** 40dfd94

**2. [Plan wording] Constructor-failure test uses a throwing indexer settings getter**
- The plan suggested forcing `createQuery` to throw through a Metrics double, but `createQuery` does not take Metrics. The mid-construction throw is instead provoked with a getter on `deps.indexer` that throws when the follower-overlay settings are spread (after the store and Metrics are open). The first-`status()` case is as planned.

No existing test pinned the old message text, so no other test files were changed.

## Known Stubs

None.

## Threat Flags

None. T-02-123 mitigated (lease freed after a failed construction, proven by opening a second store as leader). T-02-124: texts carry pid and version only.

## Verification

- `node --test src/tenant/idle-compaction.test.ts src/tenant/idle.test.ts src/tenant/tenant.test.ts`: 27 pass.
- `node --test src/tenant/messages.test.ts src/tenant/create-failure.test.ts src/tenant/tenant.test.ts src/tenant/takeover.test.ts src/cli/cli.test.ts`: 47 pass.
- `node --test "src/tenant/*.test.ts" "src/host/*.test.ts"`: 128 pass.
- `npm run typecheck`, `npm run lint`: exit 0.
- `npm test`: 2406 of 2407 pass; the one failure was `src/indexer/parcel-source.test.ts` (known flake, not touched). It passed when run alone immediately afterwards.

## Notes

- The new end-to-end idle tests take several seconds each on a cold run (seeding 1800 commits through the real store).
- `.codegraph/` was created in the worktree by `codegraph init` and is intentionally not committed.

## Self-Check: PASSED

- FOUND: src/tenant/messages.ts, idle-compaction.test.ts, messages.test.ts, create-failure.test.ts
- FOUND commits: 40dfd94, 0e4995c
