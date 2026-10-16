---
phase: 01-foundations-and-walking-skeleton
plan: 10
subsystem: storage
tags: [sqlite, node-sqlite, better-sqlite3, conformance-suite, fact-store, interface]
requires: [01-03, 01-04]
provides:
  - "src/sqlite: openDatabase, loadDriver, selfTest, Db/Statement/OpenOptions/DriverModule types, DbError, IntegerOutOfRangeError, DriverUnsupportedError, PRAGMA_ALLOWLIST"
  - "src/sqlite/contract.ts: defineDriverContract(label, driver), one 17-case suite run unchanged on node:sqlite and better-sqlite3 (test code, never exported from index.ts)"
  - "src/fact-store: frozen FactStore, Reader, Writer, StoreDeps, OpenStore, Resolver, record types, SchemaTooNew, WriterBusy, UnknownWorktree, StoreClosed (interface only)"
affects: [01-15, 01-16, phase-02-storage]
tech-stack:
  added: []
  patterns:
    - "Adapters supply a small RawConnection; one createDb wrapper owns pragma allowlist, BEGIN IMMEDIATE/SAVEPOINT, row and bigint normalisation, parameter checks and error mapping, so the two drivers cannot drift"
    - "Both drivers are told to read every INTEGER as a bigint; the wrapper converts per the bigints option, so 2^53 behaviour is identical"
    - "Contract suite is a single case list registered per driver, so case counts are equal by construction"
key-files:
  created:
    - src/sqlite/index.ts
    - src/sqlite/driver.ts
    - src/sqlite/errors.ts
    - src/sqlite/normalize.ts
    - src/sqlite/wrap.ts
    - src/sqlite/node-sqlite.ts
    - src/sqlite/better-sqlite3.ts
    - src/sqlite/better-sqlite3-shim.d.ts
    - src/sqlite/open.ts
    - src/sqlite/contract.ts
    - src/sqlite/node-sqlite.test.ts
    - src/sqlite/better-sqlite3.test.ts
    - src/sqlite/open.test.ts
    - src/fact-store/index.ts
    - src/fact-store/types.ts
    - src/fact-store/errors.ts
    - src/fact-store/fact-store.test.ts
  modified: []
key-decisions:
  - "openDatabase and loadDriver are async (dynamic import of the adapter keeps better-sqlite3 optional); selfTest and Db are synchronous"
  - "The default busy timeout is 0, not the planned 5000 (see Deviations); callers pass timeoutMs explicitly"
  - "wrap.ts is the shared helper the plan asked for ('move it into a common helper module'); it was not in files_modified"
  - "Parameters are validated by the kit: only null, number, bigint, string and Uint8Array bind; undefined, booleans and objects throw TypeError on both drivers (node:sqlite binds undefined and booleans silently, better-sqlite3 binds booleans silently)"
  - "Fact Store reads and writer methods are Promise-returning; writer() and release() are synchronous; CommitResult reports status committed | unchanged | rejected with diagnostics rather than throwing for invalid facts"
requirements-completed: [FND-05]
status: complete
duration: 55min
completed: 2026-10-16
commits: 3
plan_head_before: 8c9202eb4ca2e5b89d617f9ce2aa2a79b3d5b625
plan_head_after: ad82a9a9ed1990b9dceeb25b8ff3b0851c8f31bf
actuals:
  tokens: 16800
  tasks: 3
  commits: 3
---

# Phase 1 Plan 10: SQLite driver kit and frozen Fact Store interface Summary

**A thin driver layer over node:sqlite and better-sqlite3 with one 17-case conformance suite green on both, an open-time NUL round-trip self-test that refuses a truncating driver, and the Fact Store interface frozen with the D-16 and D-17 resolutions documented and no implementation or fake.**

BASE (HEAD at plan start, after `git merge --ff-only main`): `8c9202eb4ca2e5b89d617f9ce2aa2a79b3d5b625`. The `commits:` count is measured from it (`git rev-list --count`) and covers the three task commits; this SUMMARY is committed after.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Tracer: node:sqlite adapter, driver kit, NUL self-test, first contract cases | 2297a7d |
| 2 | better-sqlite3 adapter and the full conformance suite on both drivers | 6fe7b45 |
| 3 | Freeze the Fact Store interface, record types and errors | ad82a9a |

The tracer gate: Task 1 re-verified end to end (`node --test`, typecheck, lint, full `npm test`) before Task 2 began. The contingency split of Task 3 into a plan 01-18 was not needed; context stayed far below the 60 percent trigger.

## What was built

- **Driver kit (`src/sqlite`)**: `openDatabase(path, options)` (async) selects the driver (default node:sqlite, or a name, or an injected `DriverModule`), runs `selfTest` once per driver module per process, and applies the open policy: writable databases get `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`; read-only connections use the read-only flag and change no journal mode. `Db` has `exec`, `prepare`, `pragma`, `transaction`, `savepoint`, `close` and no `loadExtension`.
- **Self-test**: stores `ab\0cd`, reads it back, requires equality; a driver that cuts at NUL is refused with `DriverUnsupportedError('nul_truncation')` and `openDatabase` never returns a Db. Also records capabilities (FTS5 trigram, JSON). Other failure codes: `self_test_failed`, `not_installed` (better-sqlite3 loader fails), `unsupported_node` (Node below 24.16.0 or node:sqlite unloadable).
- **Conformance suite**: WAL/synchronous/foreign_keys policy and SQLite >= 3.34; NUL, empty and emoji TEXT; BLOB/REAL/NULL; plain-object rows; close idempotent then files deletable; 2^53 behaviour in number and bigint modes; TypeError on undefined, boolean, object parameters; run results and `all()`; transaction commit, rollback, nested refusal; savepoint rolls back only inner work; injection refusal for pragma names, pragma values and savepoint names; busy (second connection, timeoutMs 0); readonly; constraint; FTS5 trigram (substring found, two-character query returns no rows and no error); no `loadExtension` and `load_extension()` fails with `DbError`. The suite runs 17 cases per driver (41 tests across `src/sqlite`).
- **Fact Store (`src/fact-store`)**: `types.ts` holds the interface from the ADR (reader `at(worktree)`, single `writer()`, typed maintenance, `status`, injected `StoreDeps {resolver, clock, gitHas}`, `OpenStore` as a type only). JSDoc documents: no `warm`, first-call resolver latency bounded by `timeoutMs` with `degraded: ['resolver_timeout']` (D-17); cache fills by the writer-lease holder and `degraded: ['cache_unavailable']` for lease-less readers (D-16); reads never throw for missing data; `commitFile` idempotent on (worktree, path, hash), validated with `validateFileFacts`, monotonic watermark. The directory holds exactly `index.ts`, `types.ts`, `errors.ts`, `fact-store.test.ts`, and the test asserts that.

## Driver quirks found (for Phase 2)

- node:sqlite `setReadBigInts(true)` makes every INTEGER (including ids) a bigint; the wrapper converts back to numbers in number mode. Without it node:sqlite throws a native `RangeError ERR_OUT_OF_RANGE` on a value beyond 2^53, which the kit avoids relying on.
- node:sqlite binds `undefined` and booleans silently; better-sqlite3 binds booleans silently and rejects `undefined`. The kit's `checkParam` makes both throw `TypeError`.
- node:sqlite returns blobs as `Uint8Array`, better-sqlite3 as `Buffer`; the kit normalises to a plain `Uint8Array` so `deepStrictEqual` agrees.
- better-sqlite3 refuses `run()` on a statement that returns data and `get()`/`all()` on one that does not (for example a pragma set); the adapter emulates node:sqlite's lenient behaviour.
- node:sqlite `close()` throws `ERR_INVALID_STATE` on a second call; the kit's `close` is idempotent.
- node:sqlite error code is `ERR_SQLITE_ERROR` with extended `errcode` (primary = low byte); better-sqlite3 uses string codes such as `SQLITE_CONSTRAINT_PRIMARYKEY`. Both map to the same `DbError` codes.
- Observed SQLite 3.54.0 under node:sqlite (Node 26.11.1) and 3.53.4 under better-sqlite3 13.0.3.

## Deviations from Plan

### Item needing a human decision

**1. [Blocked by guard hook] Default busy timeout of 5000 ms not set**
- **Found during:** Task 1, writing `src/sqlite/open.ts`
- **Issue:** The plan says `timeoutMs` defaults to 5000. A PreToolUse hook refused the write because it sets a timeout-shaped constant to 5000, and requires the human (not an agent) to type a specific confirmation phrase (the hook's refusal message names it). An agent may not self-issue that, and renaming the constant to slip past the hook would be circumvention.
- **Fix:** `openDatabase` defaults `timeoutMs` to 0 (fail at once), which is also the node:sqlite default; documented in `driver.ts` and a comment in `open.ts`. Nothing in this plan depends on the default (every busy test passes `timeoutMs: 0` explicitly; Phase 2 sets its own).
- **To finish:** after the human gives the confirmation, change `options.timeoutMs ?? 0` in `src/sqlite/open.ts` to the planned default of 5000 and update the doc comment in `src/sqlite/driver.ts`. One line.
- **Commit:** 2297a7d

### Auto-fixed Issues

**2. [Rule 3 - Blocking] Dynamic-import loader for better-sqlite3 stubbed for one commit**
- **Found during:** Task 1 (the better-sqlite3 adapter belongs to Task 2, but `open.ts` must typecheck in the Task 1 commit)
- **Fix:** the Task 1 commit had a rejecting placeholder loader; Task 2 replaced it with the real dynamic import. No behaviour left behind.
- **Commits:** 2297a7d, 6fe7b45

**3. [Rule 3 - Blocking] Worktree has no CodeGraph index, and a guard hook routes indexed-source reads through it**
- **Fix:** ran `codegraph init -y` in the worktree (per the user's global CLAUDE.md) and read source through `codegraph node`. `.codegraph/` is untracked and was not committed.

Otherwise the plan was executed as written. Added file beyond `files_modified`: `src/sqlite/wrap.ts` (the shared helper the plan requires).

## Known Stubs

None. `OpenStore` is intentionally a type with no value (the plan forbids an implementation and a fake); Phase 2 (STO-01 to STO-10) supplies it.

## Threat Flags

None beyond the plan's register. T-01-24 (NUL truncation) mitigated by the self-test plus the contract case on both drivers; T-01-25 (extension loading) by never enabling `allowExtension`, exposing no `loadExtension`, and the contract case; T-01-26 (injection) by the pragma allowlist, value and savepoint-name validation and bound parameters, with a contract case.

## Verification

- `node --test "src/sqlite/**/*.test.ts" src/fact-store/fact-store.test.ts`: pass.
- `npm test`: 389 tests, all pass. `npm run typecheck`, `npm run lint`: clean. A build to a scratch directory confirmed `contract.ts` and tests are excluded from emit.
- Not run here: Node 24.16.0 (only Node 26.11.1 is installed locally); plan 01-15 proves the floor lane in CI.

## Self-Check: PASSED

- Files: all 17 listed under key-files.created exist.
- Commits 2297a7d, 6fe7b45, ad82a9a are ancestors of HEAD.
