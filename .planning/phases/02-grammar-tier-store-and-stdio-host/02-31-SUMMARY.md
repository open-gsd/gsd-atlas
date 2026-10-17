---
phase: 02-grammar-tier-store-and-stdio-host
plan: 31
subsystem: fact-store
tags: [sqlite, recovery, lease, takeover, rebuild, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "plan 02-12 lease, takeover and recovery; plan 02-18 check and rebuild; plan 02-30 maintain and lease holder"
provides:
  - "replaceConnections in open.ts: one routine for takeover recovery and check's rebuild, restore-or-close on failure"
  - "armTakeover: the takeover retry loop can be started again after a failed recovery"
  - "TEST ONLY StoreOpenOptions.beforeReplaceOpen(stage) failure-injection hook"
  - "check resolves { ok: false, problems } with a final 'rebuild failed:' line when the rebuild fails"
affects: [02-40 Tenant maps StoreClosed to store_unavailable, 02-41 Host drops such a tenant]
tech-stack:
  added: []
  patterns:
    - "restore-or-close after a failed replacement of database connections (the quarantine needs them closed first)"
    - "leadership is reported only after the store can write; a failed takeover gives the lease back and re-arms"
key-files:
  created:
    - src/fact-store/recovery-failure.test.ts
  modified:
    - src/fact-store/open.ts
    - src/fact-store/lifecycle.ts
key-decisions:
  - "The test hook fires after the damaged file has been moved aside and before the fresh store is created, so the 'moved-aside file survives the failure' case is real"
  - "The restore is a non-authority open (attemptOpen(env, false)): it must not run the sentinel check on the file that just failed to be replaced"
  - "A leader whose rebuild fails twice is closed and told onLeaseChange(false) because it had reported leadership; a follower whose takeover recovery fails twice is closed without any call, because it never reported leadership"
  - "A recovery step that throws for another reason (a busy quick_check) now also counts as a failed takeover: the lease is given back and the takeover re-armed instead of reporting leadership"
requirements-completed: [STO-06, STO-08]
status: complete
actuals:
  tokens: 10000
  tasks: 2
  commits: 2
plan_head_before: 7a3fbead7eaa8ecc28b579597aef5edf9fd3dae2
plan_head_after: 1d61192cb6989decff869d33e48f3d56c445a875
completed: 2026-10-17
---

# Phase 2 Plan 31: Failed recovery leaves an honest store Summary

**A takeover recovery or a `check` rebuild that fails while replacing the database connections now ends in a usable store (restored files, honest follower or leader) or a closed one (`StoreClosed`, lease released); a process that cannot write never reports leadership (WR-03, D-14).**

## Performance

- **Duration:** about 40 minutes (2026-10-17)
- **Tasks:** 2 of 2
- **Commits:** 2 (measured with `git rev-list --count` from the plan base 7a3fbea; the per-plan ledger file could not be written inside the worktree guard, so the base is the fast-forward commit named in the task)

## Accomplishments

- `open.ts`: `replaceConnections(open)` closes the old connections (the quarantine rename needs that on Windows), runs the open step, and on failure reopens the old files with a non-authority `attemptOpen`, writing the same rebuilding note a successful rebuild writes when the corrupt file was already moved aside. When the restore fails too, `closeAfterFailedRecovery` marks the store closed exactly as `close()` does and releases the lease.
- A follower that wins the lease and then fails to put a damaged store right no longer calls `onLeaseChange(true)`: it releases the lease, restores (or closes) the connections and re-arms the takeover through `armTakeover()`. When the retry works, `onLeaseChange(true)` fires once.
- A `close()` that arrives during recovery wins: nothing is restored, no timer is re-armed, no leadership is reported, connections opened meanwhile are closed.
- `checkStore` (the one coordinated edit in `lifecycle.ts`) catches the rejection of `rebuild` and adds the `rebuild failed:` line; `check` resolves `{ ok: false, problems }`.
- No new error class: the closed store reuses `StoreClosed`.

## Task Commits

1. **Task 1 (tracer): a takeover whose recovery fails stays a follower, then succeeds on the next try** - `1f4c2b2` (fix)
2. **Task 2: check's rebuild fails honestly** - `1d61192` (fix)

## Verification

- `node --test src/fact-store/recovery-failure.test.ts src/fact-store/lease.test.ts src/fact-store/durability.test.ts` : 67 of 67 pass (Task 1 gate).
- `node --test src/fact-store/recovery-failure.test.ts src/fact-store/maintain.test.ts src/fact-store/durability.test.ts` : 106 of 106 pass (Task 2 gate); the existing `check corrupt` case passes unchanged.
- `npm run typecheck` and `npm run lint` exit 0.
- Full `npm test`: 2404 tests, 2403 pass, 1 fail: `scripts/parity.test.ts` "health: identical JSON except ... lastReconcileAt" saw `reconciling: true` on the MCP side and `false` on the CLI side (a timing race in the status snapshot, not in a recovery path). The same file passes 12 of 12 when run alone. No SIGTRAP from `parcel-source.test.ts` occurred in this run.
- Tracer gate (`<verify>` re-run end to end) passed before Task 2 started.

### Mutation check (acceptance criterion)

Calling `options.onLeaseChange?.(true)` in the failed-recovery branch of `onTakeover` made 4 tests fail (`replace fails` and `retry`, on both drivers). Reverted before the commit.

## Deviations from Plan

### Auto-fixed Issues

None needed beyond the plan, with these notes on judgment calls inside its scope:

**1. [Rule 2 - hardening] Failures other than a failed open also count as a failed takeover**
- `recoverAfterTakeover` may throw from `runQuickCheck` (for example a busy error) and not only from the replacement. The old code swallowed that and reported leadership on a store it had not verified. The new `onTakeover` treats any rejection the same way: lease released, takeover re-armed, no `onLeaseChange(true)`.
- **Files modified:** `src/fact-store/open.ts`

**2. [Rule 2 - hardening] `noteRebuild` failure no longer leaks fresh connections**
- In both the takeover path and `check`'s rebuild, a throw from `noteRebuild` after the fresh store opened now closes those connections before rethrowing.
- **Files modified:** `src/fact-store/open.ts`

**3. Test hook placement**
- The plan says stage `replace` is "before the recovery open". It fires after the quarantine rename and before the recreating open (inside `openWithRecovery` and the rebuild), because a hook before the rename could not exercise the case "a corrupt file that was already moved aside is not lost".

**4. Test scope**
- All takeover and check cases run on both `node:sqlite` and `better-sqlite3` (the plan required only the two outcome cases on the second driver); the close-during-recovery and healthy-check cases run on `node:sqlite` only.

## Issues Encountered

- The worktree guard refused writing the per-plan ledger file inside the shared git directory, so `plan_head_before` is the known fast-forward base `7a3fbea`.
- The Memtrace/CodeGraph read guard blocked direct reads of indexed sources until a CodeGraph read of the file was made; CodeGraph's worktree-local index does not exist here, so line numbers were taken from the main checkout's index and confirmed against the worktree files with `Read`.

## Known Stubs

None.

## Threat Flags

None. T-02-108 (a leader with closed connections after a failed recovery) is mitigated and proven by the replace-fails, restore-also-fails, retry and close-during-recovery cases.

## Self-Check: PASSED

- `src/fact-store/recovery-failure.test.ts`: FOUND
- `src/fact-store/open.ts` defines `armTakeover` and `replaceConnections`: FOUND
- `1f4c2b2`: FOUND in HEAD history
- `1d61192`: FOUND in HEAD history
