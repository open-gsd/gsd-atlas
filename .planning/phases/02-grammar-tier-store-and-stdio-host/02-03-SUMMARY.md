---
phase: 02-grammar-tier-store-and-stdio-host
plan: 03
subsystem: infra
tags: [git-allowlist, sqlite-kit, pragma, eslint-boundaries, no-console, tdd]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: command-runner ADR amendment 2026-10-16 (plan 02-01) naming the two new git read shapes
provides:
  - "git built-in allowlist gains ls-tree and the single shape worktree list --porcelain -z"
  - "SQLite kit pragma allowlist gains incremental_vacuum, wal_checkpoint, journal_size_limit, page_count, freelist_count on both drivers"
  - "Capabilities.contentlessDelete recorded by the open-time self-test"
  - "lint boundaries for indexer, query, tenant, host from their first file; no-console is an error across src"
affects: [fact-store, source-tree, indexer, query, tenant, host, cli, mcp-shim]

actuals:
  tokens: 6500
  tasks: 3
  commits: 6
plan_head_before: fabcbf815b957727085d7b711652a821af73fac4
plan_head_after: bd1e01e43e3673fa10f7625467dd7af96f8aa723

tech-stack:
  added: []
  patterns:
    - "incremental_vacuum is driven by the kit (loop until N pages freed) so both drivers free the same pages"
    - "auto_vacuum=INCREMENTAL on a fresh WAL database needs pragma plus VACUUM, not the pragma alone"

key-files:
  created:
    - src/command-runner/git-read.test.ts
  modified:
    - src/command-runner/decide.ts
    - src/command-runner/decide.test.ts
    - src/sqlite/driver.ts
    - src/sqlite/open.ts
    - src/sqlite/wrap.ts
    - src/sqlite/contract.ts
    - eslint.config.js
    - src/lint/boundaries.test.ts

key-decisions:
  - "worktree is accepted by matchGit only as exactly list --porcelain -z, in that order, and is deliberately not added to GIT_READ_SUBCOMMANDS"
  - "Db.pragma runs the statement to completion (all) and the kit, not the driver, implements incremental_vacuum(N) so node:sqlite and better-sqlite3 agree"
  - "no-console lives in its own eslint block (files src/**/*.ts) so it cannot replace any module's boundary options"

patterns-established:
  - "Fixture-driven lint: every new MODULES entry gets deep-import fail, index.ts pass, no-SQLite and no-child_process cases"

requirements-completed: [STO-01, STO-03, STO-09, HST-01]

coverage:
  - id: D1
    description: "Production git rule runs ls-tree and worktree list --porcelain -z in a real repo and refuses worktree add/remove, bare worktree, inexact list forms and status"
    requirement: "STO-09"
    verification:
      - kind: integration
        ref: "src/command-runner/git-read.test.ts#lists a repository tree and its worktrees in one run, and refuses worktree add"
        status: pass
      - kind: unit
        ref: "src/command-runner/decide.test.ts#decide: git denials"
        status: pass
    human_judgment: false
  - id: D2
    description: "SQLite kit pragmas incremental_vacuum, wal_checkpoint, journal_size_limit, page_count, freelist_count behave identically on node:sqlite and better-sqlite3, each run twice on one open database"
    requirement: "STO-01"
    verification:
      - kind: unit
        ref: "src/sqlite/node-sqlite.test.ts and src/sqlite/better-sqlite3.test.ts via defineDriverContract"
        status: pass
    human_judgment: false
  - id: D3
    description: "Open-time self-test reports a cached contentlessDelete capability"
    requirement: "STO-03"
    verification:
      - kind: unit
        ref: "src/sqlite/contract.ts#contentlessDelete is reported true on a SQLite that has contentless_delete (3.43 and newer)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Lint boundaries cover indexer, query, tenant, host and no-console is an error for all of src"
    requirement: "HST-01"
    verification:
      - kind: unit
        ref: "src/lint/boundaries.test.ts"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 03: Allowlists and lint boundaries Summary

**Opened the three guarded doors Phase 2 needs: git `ls-tree` and `worktree list --porcelain -z`, five more SQLite kit pragmas with a `contentlessDelete` probe, and lint boundaries plus a `no-console` error for indexer, query, tenant and host.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-10-16T17:49Z
- **Completed:** 2026-10-16T17:57Z
- **Tasks:** 3 (one tracer, two auto), each as RED then GREEN
- **Files modified:** 9 (1 created)

## Accomplishments

- `decide.ts`: `ls-tree` joined the generic read subcommands; `worktree` matches only `list --porcelain -z`. Both still need the three pinned `-c` overrides and the pinned environment. 126 decide and real-runner tests pass, including denial of `worktree add|remove|prune|lock`, bare `worktree`, `list` without `--porcelain`/`-z`, reordered flags, an extra argument, and `status`.
- `git-read.test.ts`: a real production-rule runner lists a temp repo's two files via `ls-tree` and its two worktrees via `worktree list`, then is denied for `worktree add` with nothing started.
- SQLite kit: five pragmas added to `PRAGMA_ALLOWLIST`; five new shared conformance cases (each running its pragma twice on one open database) pass on both drivers. `selfTest` now records `contentlessDelete` beside `fts5Trigram`, cached per driver.
- eslint: `MODULES` gains `indexer`, `query`, `tenant`, `host` (neither SQLite owners nor adapters); a separate `no-console` block covers `src/**/*.ts`. 28 new fixture cases plus an extended exports test; `npm run lint` is clean over the existing tree, so no existing file needed changing.
- Full suite: 1018 tests pass, typecheck and lint clean.

## TDD Gate Compliance

| Task | RED commit | GREEN commit |
|------|-----------|--------------|
| 1 | 1c245f2 `test(02-03)` | cd08fee `feat(02-03)` |
| 2 | 595eba9 `test(02-03)` | 93a84fe `feat(02-03)` |
| 3 | 286f81f `test(02-03)` | bd1e01e `feat(02-03)` |

RED evidence for each task was validated with `check tdd-red-evidence` (`RED_EVIDENCE_OK`): task 1 target "allows ls-tree with its ordinary read arguments" failed with `allowed:false command_denied`; task 2 target "incremental_vacuum returns freed pages..." failed on the pragma allowlist `TypeError`; task 3 target "console: console.log in query fails" failed with no violation reported (20 new cases red, controls already green). No REFACTOR commit was needed. The task 2 RED commit does not typecheck on its own (it references the not-yet-added `PragmaName`s and `contentlessDelete`); the GREEN commit restores a clean typecheck.

## Task Commits

1. Task 1 (tracer): `1c245f2` test, `cd08fee` feat - git read shapes
2. Task 2: `595eba9` test, `93a84fe` feat - SQLite pragmas and capability
3. Task 3: `286f81f` test, `bd1e01e` feat - lint boundaries and no-console

Tracer gate: `workflow.human_verify_mode` default (end-of-phase) with an automated-only `<verify>`; the verify was re-run after the GREEN commit and passed, so expansion continued.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Db.pragma ran its statement a single step, so incremental_vacuum freed one page**
- **Found during:** Task 2
- **Issue:** `incremental_vacuum(N)` frees one page per step. `pragma()` used `get`, which steps once, so `incremental_vacuum(10)` freed 1 page. Draining with `all` fixed node:sqlite, but better-sqlite3 treats the statement as returning no data and `run` also steps once.
- **Fix:** `pragma()` now reads via `all`; for `incremental_vacuum` with an integer or no value the kit loops (ask for the remaining pages, read `freelist_count`, repeat until N freed, the freelist is empty, or no progress) so both drivers free exactly the same pages.
- **Files modified:** `src/sqlite/wrap.ts` (not in the plan's `files_modified`)
- **Verification:** `incremental_vacuum(10)` frees exactly ten pages and `incremental_vacuum(100000)` empties the freelist on both drivers, twice per open database.
- **Commit:** 93a84fe

**2. [Rule 1 - Bug in the plan's assumption] auto_vacuum=INCREMENTAL is ignored after the WAL open**
- **Found during:** Task 2
- **Issue:** The plan said INCREMENTAL can be set "before the first table". `openDatabase` switches to WAL first, which writes the header, so `PRAGMA auto_vacuum = INCREMENTAL` alone left `auto_vacuum = 0` on both drivers.
- **Fix:** The conformance cases use `pragma('auto_vacuum','INCREMENTAL')` followed by `exec('VACUUM')` on the empty database, which makes it take effect (verified on both drivers). No change to the open policy.
- **Files modified:** `src/sqlite/contract.ts`
- **Commit:** 93a84fe

**Total deviations:** 2 auto-fixed (both Rule 1). **Impact:** one extra file touched (`wrap.ts`); no scope change. Both are findings the Fact Store plan must honour (see below).

## Next-Phase Notes (for the Fact Store plans)

- When the store creates its file it must run `pragma('auto_vacuum','INCREMENTAL')` then `exec('VACUUM')` once, before any table, or compaction's `incremental_vacuum` will do nothing.
- `db.pragma('incremental_vacuum', n)` now returns `undefined` and is safe to call with an `n` larger than the freelist.
- `selfTest(driver).contentlessDelete` is the switch for the fuzzy-name path (research A11); it is true on SQLite 3.43 and newer (both drivers bundle 3.53).

## Issues Encountered

None beyond the deviations above. The memtrace-first read guard required reading source through `codegraph node` before `Read`; it never denied a legitimate action.

## Known Stubs

None.

## Threat Flags

None. T-02-06 (new git shapes), T-02-07 (pragma injection: the existing word-or-integer value rule is untouched and re-tested) and T-02-08 (stdout pollution) are mitigated as planned.

## Self-Check: PASSED

- Created and modified files exist (`src/command-runner/git-read.test.ts`, `decide.ts`, `decide.test.ts`, `src/sqlite/{driver,open,wrap,contract}.ts`, `eslint.config.js`, `src/lint/boundaries.test.ts`).
- Commits 1c245f2, cd08fee, 595eba9, 93a84fe, 286f81f, bd1e01e are ancestors of HEAD; `git rev-list --count fabcbf8..HEAD` = 6.
- `npm test` 1018/1018, `npm run typecheck` and `npm run lint` exit 0.
