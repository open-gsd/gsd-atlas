---
phase: 02-grammar-tier-store-and-stdio-host
plan: 42
subsystem: docs
tags: [adr, amendments, gap-closure, fnd-12]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "plans 02-30, 02-31, 02-33, 02-37, 02-38, 02-40, 02-41 (the shipped behaviour the amendments record)"
provides:
  - "Five dated 2026-10-17 amendments: ADR 11, ADR 7, ADR 13, ADR 4, ADR 9"
  - "Five Amendment log lines in docs/adr/README.md"
  - "DESIGN.md cross-references on the Compact row and the longest-pause budget row"
  - "scripts/adr.test.ts enumerates the new amendments with keywords"
affects: [adr-readers, phase-04-host]
tech-stack:
  added: []
  patterns:
    - "append-only amendment: Sources line, short paragraph, numbered points, 'Unchanged' point"
key-files:
  created: []
  modified:
    - docs/adr/11-worktree-lifecycle.md
    - docs/adr/7-fact-store-interface.md
    - docs/adr/13-mcp-contract.md
    - docs/adr/4-command-runner.md
    - docs/adr/9-tenant-composition.md
    - docs/adr/README.md
    - docs/DESIGN.md
    - scripts/adr.test.ts
key-decisions:
  - "Amendments follow the shipped code and the plan SUMMARYs, not the plan's expectation (for example the dbstat in-page rule, the exact option sets, a 60 s default that also treats a non-positive timeout as none)"
  - "ADR 11 also records the 02-31 rule that leadership is reported only after the store can write (refines point 4 of the 2026-10-16 amendment); the plan did not list it but it changes a ratified contract"
  - "ADR 13 names the files a read tool still writes inside a built repository's store (lease.db, lease.json, WAL files, metrics.db) and the probe's -shm and empty -wal, as the plan required"
requirements-completed: [FND-12, STO-05, QRY-06, STO-09]
status: complete
completed: 2026-10-17
commits: 2
plan_head_before: 25d78faa9421397694c245f224250b2869b42cde
plan_head_after: 7f9a3e97714cfb0aed2670e1578bdb78d130bb11
actuals:
  tokens: 6700
  tasks: 2
  commits: 2
---

# Phase 2 Plan 42: Dated ADR amendments for the gap-closure contract changes Summary

**Five append-only 2026-10-17 amendments (ADRs 11, 7, 13, 4, 9) record the idle full compaction and its pause exception, the maintain options and lease holder, the unbuilt-repository rule, the git option allowlist and the Host's eviction, timeout and identity rules, each sourced and tied to what the code now does.**

## Accomplishments

- ADR 11, "Idle full compaction and lease messages": idle round requests a full compaction that vacuums only after a completed collect and past a quarter free pages or a third empty space inside pages (evaluated again after the slices, `dbstat` rule with an after-churn fallback); the pause exception stated plainly (single synchronous rewrite, longer than 200 ms on a large store; size gate ratio 1.0000 against 1.3938 for the old policy, longest call 21 ms and 221 ms on the 300-file gate store, reported not asserted); non-blocking checkpoint (busy timeout 0); leadership only once the store can write; `lease_held` and `not_indexed` name the holder and the honest limit.
- ADR 7, "Maintenance options and lease holder": `maintain(budgetMs, options?)`, `StoreMaintainOptions`, frozen `IDLE_MAINTENANCE`, additive `StoreStatus.leaseHolder`, the existing `StoreClosed` after a failed connection replacement (decision 10's list does not change).
- ADR 13, "Unbuilt repositories": only `build` creates a store; `not_indexed` before any tenant, lease, file or watcher, including `atlas_status`, `maintain`, `status`; newer schema still reaches a tenant (`schema_too_new`); `lang_list` and `history` unchanged; the by-design writes of a read tool in a built repository; one envelope for CLI and MCP; why an empty `atlas_status` was rejected.
- ADR 4, "Git option allowlist": the per-subcommand exact-token table from 02-33, `cat-file --batch-check`, the 60 s `run()` default (never `stream()`), the wider environment denylist, the deferred allowlist switch.
- ADR 9, "Idle eviction, git timeouts and store identity": 30 minute eviction with in-flight counting and the closing wait, tenant construction cleanup, timeouts on every Source Tree git spec, size-first reads and the `maxBytes` cap, `storeId` from the smallest root commit, the known remainder.
- README Amendment log: five lines (one per amendment, each tagged with the gap-closure plans). `docs/DESIGN.md`: the Compact row and the 'Longest maintenance pause' row gain `(see ADR 11, Amendment 2026-10-17)`; no number rewritten.
- `scripts/adr.test.ts`: the five amendments added to `AMENDED` with keyword checks; every other assertion kept.

## Task Commits

1. **Task 1: ADR 11, ADR 7, ADR 13 amendments and DESIGN cross-references** - `ecd623a` (docs)
2. **Task 2: ADR 4 and ADR 9 amendments, README log, ADR test** - `7f9a3e9` (docs)

## Verification

- `node --test scripts/adr.test.ts`: 39 of 39 pass (the amendment-log test finds a README line for each new amendment).
- `npm run typecheck` and `npm run lint`: exit 0.
- `git diff --numstat` against the plan base: the five ADR files show only added lines (0 deleted), so the original text and every heading, status line and issue link of the ratified ADRs are unchanged; DESIGN.md changes exactly two lines (2 added, 2 removed, the two rows).
- `grep -c '^- Amendment 2026-10-17:' docs/adr/README.md` = 5; `grep -c metrics.db docs/adr/13-mcp-contract.md` is above 1.
- Not touched: the editorial items of ADRs 3, 5, 6, `docs/SDK-PROVIDERS.md`, `PRD.md` 4.7, `.github/workflows/nightly.yml`, STATE.md, ROADMAP.md.

## Deviations from Plan

**1. [Rule 2 - correctness] ADR 11 also records 02-31's leadership rule**
- The plan's list for ADR 11 did not include plan 02-31, but a follower that reports leadership only after its store can write refines point 4 of the 2026-10-16 amendment. It is point 4 of the new section, sourced to WR-03 and 02-31. No decision was changed.

**2. Titles**
- The plan's artifact line names ADR 13's amendment "Unbuilt repositories and lease messages"; its action names it "Unbuilt repositories". The action's title is used (the lease texts are covered in point 6 of that section and in ADR 11).

**3. Process note: plan ledger file**
- The per-plan commit ledger could not be written (the worktree guard refuses git-dir writes), as in earlier gap-closure plans. `commits: 2` is measured with `git rev-list --count` from the fast-forward base `25d78fa`.

Otherwise the plan was executed as written.

## Facts that differ from the plan's wording (shipped behaviour wins)

- The idle vacuum rule has two thresholds (free pages above a quarter, or in-page empty space above a third from `dbstat`), re-evaluated after the slices; the plan named the same pair but not the fallback rule or the re-evaluation.
- The environment denylist is pattern-based (`PASSWD`, `ACCESS_KEY`, `PRIVATE_KEY`, trailing `_AUTH`) plus two exact names; there is no separate "AWS key id" entry, `ACCESS_KEY` covers it.
- `atlas_status` and `status` and `maintain` on an unindexed repository answer `not_indexed`; read tools in a built repository still write lease, WAL and `metrics.db` files by design.
- Runner default timeout is 60000 ms and also applies when a spec carries a non-positive or non-finite timeout; `createRealRunner` throws `RangeError` for an invalid default.
- The parser pool's load timeout and terminate grace (plan 02-39) are not in the five amendments the plan names and were not added to any ADR.

## Known Stubs

None.

## Threat Flags

None. Documentation only; T-02-127 is mitigated (one dated, sourced amendment and a README log line per changed ADR, the ADR tests keep the ratified text intact).

## Self-Check: PASSED

- FOUND: docs/adr/11-worktree-lifecycle.md, 7-fact-store-interface.md, 13-mcp-contract.md, 4-command-runner.md, 9-tenant-composition.md each end with a `## Amendment 2026-10-17:` section
- FOUND commits `ecd623a`, `7f9a3e9` (ancestors of HEAD)
