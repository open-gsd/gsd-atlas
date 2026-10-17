---
phase: 02-grammar-tier-store-and-stdio-host
plan: 41
subsystem: host
tags: [read-only, store-probe, idle-eviction, writer-lease, containment, node-sqlite]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "plan 02-29 constants addendum (host.idleEvictMs), 02-34 isInside, 02-40 tenant messages (notIndexedNoStore), 02-30 leaseHolder status"
provides:
  - "decideStoreLocation (no mkdir) and findExistingStore, the one set of location rules for tenant and Host"
  - "probeStore: read-only classification of a store (indexed, newer_schema, empty, older_schema, unreadable)"
  - "Host that creates a store only for build, answers not_indexed without touching the file system otherwise, and never opens an empty, older-schema or corrupt store for a read"
  - "createIdleRegistry and idle eviction of tenants and history module hosts on the approved host.idleEvictMs"
  - "Host containment on the shared isInside; a tenant whose store closed itself is dropped"
affects: [phase-04-socket-host, adr-13-amendment-02-42, mcp-contract]

actuals:
  tokens: 24700
  tasks: 4
  commits: 4

plan_head_before: 29b7ef6003e57771d01b83ba78ada7d9e9974e5c
plan_head_after: 696681aa6be23d8b003942a98edc36a3472636ad
commits: 4

tech-stack:
  added: []
  patterns:
    - "Decide-then-create: decideStoreLocation is pure of mkdir, resolveStoreLocation = decide + mkdir"
    - "In-flight counting before lookup: idle registry begin/end around every repo and history request"
    - "A tenant being closed is awaited (closing map) before a new tenant opens the same store"

key-files:
  created:
    - src/fact-store/probe.ts
    - src/fact-store/probe.test.ts
    - src/host/defaults.ts
    - src/host/idle-registry.ts
    - src/host/idle-registry.test.ts
    - src/host/eviction.test.ts
    - src/host/read-only.test.ts
    - scripts/read-only-flow.test.ts
  modified:
    - src/fact-store/location.ts
    - src/fact-store/location.test.ts
    - src/fact-store/index.ts
    - src/fact-store/fact-store.test.ts
    - src/host/host.ts
    - src/host/types.ts
    - src/host/route.ts
    - src/host/history.ts
    - src/host/history.test.ts
    - src/host/host.test.ts
    - src/host/recording.test.ts
    - src/test-kit/fake-clock.ts

key-decisions:
  - "Only a build request may create a store; every other repo-scoped kind needs an open tenant or a store that holds a live overlay (WR-01)"
  - "atlas_status, status and maintain for a repository with no index answer not_indexed (they used to open a tenant and report an empty index); recorded for the ADR 13 amendment in plan 02-42"
  - "A store that exists but is empty, older-schema or unreadable is not opened by a read request; a busy or otherwise indeterminate probe counts as indexed (WR-02)"
  - "host.idleEvictMs = 1800000 read from the approved 02-CONSTANTS.md addendum; no other constant introduced (WR-10)"
  - "store_unavailable drops the tenant through the idle registry (evict), so the close waits for every request still running on it"

patterns-established:
  - "Test hooks on HostOptions: moduleHostFactory and tenantFactory, next to indexerFactory"
  - "Fingerprint tests (path, size, sha256) before and after to prove a request wrote nothing"

requirements-completed: [HST-02, QRY-06, STO-07, STO-08, STO-09, QRY-04]

duration: 95min
completed: 2026-10-17
status: complete
---

# Phase 2 Plan 41: Read-only tools, store probe, idle eviction, Host containment Summary

**A question about a repository nobody built now leaves it byte-for-byte untouched, a store with nothing to read never takes the writer lease (so `gsd-atlas build` works while the MCP server runs), idle tenants release their lease after the approved 30 minutes, and the Host's two broken containment tests are replaced.**

## Performance

- **Duration:** about 95 min
- **Tasks:** 4 (1 tracer, 3 auto, all TDD red-first)
- **Commits:** 4 task commits (measured: `git rev-list --count 29b7ef6..696681a`)
- **Files:** 8 created, 12 modified (20 in the diff)

## Accomplishments

- WR-01: `decideStoreLocation` and `findExistingStore` share the tenant's location rules; the Host answers `notIndexedNoStore()` for `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status`, `maintain` and `status` when no tenant is open and no `facts.db` exists. Fingerprints of the repository (including `.git`), the cache root and the user directory are identical before and after all seven kinds.
- WR-02: `probeStore` opens `facts.db` read-only with no busy wait, reads `meta.schema_version` and the live overlay count, closes. Only `indexed` and `newer_schema` reach a tenant. Real binaries: ask (not_indexed, nothing created), `gsd-atlas build` while the MCP server runs (exit 0), ask again (results with citations); a second build while the server leads exits 3 and the message carries the server's pid (read from `lease.json`); an older-schema store is not opened (no `lease.json`) and a CLI build rebuilds it.
- WR-10: `createIdleRegistry` (per-key timers on `Clock.after`, in-flight counts) drives eviction of tenants and history module hosts on `HOST_DEFAULTS.idleEvictMs` = 1800000, copied from the Approved addendum of 2026-10-17. `host.close()` leaves zero timers on the fake clock.
- IN-03: `route.ts` and `history.ts` use the facts `isInside(root, candidate)`. `<repo>/..cache/sub` now resolves; `<repo>/..tmp` is refused by `history` before anything is created.
- A tenant whose reply carries `store_unavailable` is evicted once nothing runs on it; the next request builds a fresh tenant.

## Task Commits

1. **Task 1: Tracer - unbuilt repository writes nothing (WR-01)** - `ce73bfd` (fix)
2. **Task 2: A store that holds no index is not opened (WR-02)** - `6f49eff` (fix)
3. **Task 3: Idle tenants and history module hosts are closed (WR-10)** - `262944c` (feat)
4. **Task 4: Host containment, drop a tenant that lost its store (IN-03)** - `696681a` (fix)

Red-first order was followed in each task: the location, Host, probe, registry and eviction tests were written before the code they exercise and were observed failing or not loading (missing module or export, wrong text, spurious `not_a_repo`).

## Mutation checks (acceptance criteria)

- Task 1: with the `findExistingStore` guard disabled in `repoRequest`, `unbuilt repository writes nothing` fails with `code_find: a store directory appeared in .git` (the tenant created `.git/gsd-atlas`).
- Task 2: with the probe result forced to `indexed`, `older schema is not opened` (real processes) and the three `not_indexed, no tenant, the lease stays free` Host cases fail.
- Task 3: with `begin` replaced by `touch` in `repoRequest`, `in flight defers` fails.

## Expectations of existing tests that changed

| Test | Change | Reason |
|------|--------|--------|
| `host.test.ts` "a code_find before any build answers not_indexed..." | `atlas_status` on an unbuilt repository expects `not_indexed` (was an ok empty index) | WR-01: no tenant is opened for a repository with no index |
| `host.test.ts` "fresh paths on a repository nobody built..." | same; "no Indexer created" now asserted through zero watcher subscriptions | same |
| `host.test.ts` "maintain refuses an unknown task..." | the closing `atlas_status` expects `not_indexed` and no `.git/gsd-atlas` | same |
| `recording.test.ts` "a code_find before any build is an answer with ok false" | uses an unbuilt linked worktree of a built repository, so a tenant exists to record the answer | the Host-level `not_indexed` is produced before any tenant or metrics handle exists, so there is nothing to record into |
| `history.test.ts` "works with no tenant..." | the closing `atlas_status` expects `not_indexed` and no store directory | same |
| `fact-store.test.ts` export list | adds `decideStoreLocation`, `findExistingStore`, `probeStore` | new public exports |

## Decisions Made

- Rejected an ok `atlas_status` with empty data for an unindexed repository (needs a nullable `store` in the published snapshot); the error already names the command. Dated amendment belongs to plan 02-42.
- `probeStore` takes its test seam as `options.kit` (an `OpenOptions`), not a `driver` option, because the fact-store boundary test forbids naming a driver option outside `open.ts`.
- `end()` of the idle registry restarts the idle period (a finished request is a use); `evict()` reports at once when idle or when the last request ends, never under a request.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A request for a store whose tenant is still closing would open as a follower**
- **Found during:** Task 3 (design of eviction)
- **Issue:** `closeTenant` forgot the tenant synchronously and closed it asynchronously; a request arriving in between created a new tenant that found the old one's writer lease still held and started as a follower of its own predecessor.
- **Fix:** the Host keeps a `closing` map and `serveRepo` awaits it before the has-tenant check. Covered by `reopens on demand` and the `store_unavailable drops the tenant` case.
- **Files modified:** `src/host/host.ts`
- **Commit:** `262944c`

**2. [Rule 3 - Blocking] Probe leaves `-shm` and an empty `-wal` beside a WAL database**
- **Found during:** Task 2 (`changes nothing` case)
- **Issue:** the plan expected only `facts.db-shm` to appear. A read-only node:sqlite connection to a WAL database also leaves a zero-byte `facts.db-wal`. Neither is written content; neither is a lease or a metrics file.
- **Fix:** the fingerprint helpers tolerate exactly `facts.db-shm` and an empty `facts.db-wal` (a log with bytes still shows as a write). Documented in `probe.test.ts` and `read-only.test.ts`. The probe itself is unchanged: the files are a property of the SQLite read path, which the plan's own safe-open policy accepts.
- **Files modified:** `src/fact-store/probe.test.ts`, `src/host/read-only.test.ts`
- **Commit:** `6f49eff`

**3. [Rule 2 - Missing critical functionality] Missing store file races and the driver's missing-file error**
- **Found during:** Task 2
- **Issue:** the driver reports a missing `facts.db` as a plain error without a result code, which the probe would have counted as `indexed` and so handed to a tenant that would create the store.
- **Fix:** `probeStore` returns `unreadable` when the file is gone before the open.
- **Files modified:** `src/fact-store/probe.ts`
- **Commit:** `6f49eff`

**4. [Rule 3 - Blocking] Three small additions outside the listed files**
- `src/test-kit/fake-clock.ts`: `pending()` so tests can assert no timer is left armed (the plan's own acceptance wants "zero active timers"); no existing behaviour changed.
- `src/fact-store/fact-store.test.ts`: the export-list assertion (see table).
- `src/host/types.ts`: besides `idleEvictMs` and `moduleHostFactory`, a `tenantFactory` TEST HOOK, the seam the plan's `store_unavailable` case allows ("through the Host's tenant factory seam"); none existed.
- `history.ts` now refuses a `tmpRoot` inside the repository before `mkdtemp` (nothing is created), and again after link resolution as before.

---

**Total deviations:** 4 (1 Rule 1, 1 Rule 2, 2 Rule 3). **Impact:** all necessary for correctness or to satisfy the plan's own acceptance criteria; no scope creep.

## Issues Encountered

- A Memtrace/CodeGraph guard hook routed reads of indexed source through `codegraph node`; used as instructed. The worktree had no `.codegraph` index, so results came from the parent checkout's index (stale warning printed); every file read was checked against the worktree by editing and by the test runs.
- Full `npm test` before the work (after Task 1): 2481 tests, one failure (fact-store export list), fixed. Final run: 2521 tests, 0 failures. Neither known flake (`src/indexer/parcel-source.test.ts`, `scripts/parity.test.ts` health case) failed in either run; not touched.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-125 (read tools creating state) and T-02-126 (unbounded tenants) are mitigated as planned; T-02-128 (planted `facts.db` opened by the probe) accepted as planned: two fixed queries through the kit's read-only defensive open.

## Unmitigated remainder (stated, not hidden)

- While an agent's MCP server leads an existing index, `gsd-atlas build` (a rebuild, or the first build of another worktree) and `maintain` still answer `lease_held` (exit 3), naming the holder; pinned by the `second build names the holder` real-process case. Home: ROADMAP.md Phase 4, success criterion 6.
- Between two evictions an agent that touches many repositories within the idle interval holds them all open.
- An agent still cannot read tiers or policy before the first build (`atlas_status` is `not_indexed`).

## Next Phase Readiness

Plan 02-42 can record the dated ADR 13 / QRY-03 amendment for `atlas_status`, `status` and `maintain` on an unindexed repository and the privilege model sentence (read tools write only inside a store that holds an index).

## Self-Check: PASSED

- Files: probe.ts, probe.test.ts, defaults.ts, idle-registry.ts, idle-registry.test.ts, eviction.test.ts, read-only.test.ts, scripts/read-only-flow.test.ts found.
- Commits `ce73bfd`, `6f49eff`, `262944c`, `696681a` are ancestors of HEAD.
- `npm run typecheck`, `npm run lint` exit 0; plan verify commands and full `npm test` (2521 tests) pass.
