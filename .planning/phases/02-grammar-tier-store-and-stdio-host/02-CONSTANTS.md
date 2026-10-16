# Phase 2 Constants

Status: Approved (2026-10-16, by the user)

## Purpose

This file lists every timeout, queue bound and gate threshold that Phase 2 writes into code, each with the plan that consumes it and its basis. User decision 4 requires a human to confirm these before any Wave 2 plan writes one: a PreToolUse guard refused an agent writing such values in Phase 1 (01-09 held back the 60 s runner default, 01-10 the SQLite busy default; 01-VERIFICATION item 3 is still open). Several rows are locked by earlier decisions (D-12, D-13, D-16, D-17, QRY-02, STO-05) and are listed for the record, not reopened.

## How plans use this file

A consuming plan reads its value from the table below instead of inventing a number. Each consuming plan carries a precondition that this file says `Status: Approved`; if the Status line is still `Proposed`, that precondition is unmet and the plan halts.

## Constants

| Key | Proposed value | Consumed by plan | Basis |
|-----|----------------|------------------|-------|
| `git.timeoutMs` | 60000 | 02-05 | Phase 1 held back the 60 s runner default; applied per git spec by Source Tree |
| `git.hashBatchTimeoutMs` | 120000 | 02-05 | the one batched hash-object over a whole snapshot (3,948 gsd-core files hashed in 250 to 470 ms on a fast Mac; Windows spawn is far slower) |
| `sqlite.busyTimeoutMs` | 5000 | 02-06, 02-10 | Phase 1 held back the SQLite busy default (01-10 deviation 1) |
| `lease.retryMinMs` and `lease.retryMaxMs` | 10000 and 30000 | 02-12 | follower takeover retry, jittered (research Pattern 3) |
| `store.dirtyIdleMs` | 1000 | 02-12 | quiet time after the last write before the dirty sentinel file is removed (D-14: set before a batch, cleared on commit) |
| `indexer.debounceMs` | 100 | 02-15 | D-12, locked |
| `indexer.maxWaitMs` | 500 | 02-15 | D-12, locked |
| `indexer.ensureFreshWaitMs` | 2000 | 02-15, 02-16 | default wait before degraded fresh_timeout |
| `indexer.startupReconcileDeadlineMs` | 1500 | 02-28 | research assumption A7, D-02 |
| `indexer.idleReconcileIntervalMs` | 600000 | 02-17 | D-13, about 10 minutes |
| `indexer.parseTimeoutMs` | 5000 | 02-14 | per-file parse cut-off through the parse progress callback |
| `pool.size` | min(4, cpus minus 1), at least 1 | 02-14 | research Pattern 8 |
| `pool.recycleAfterFiles` | 2000 | 02-14 | worker recycle policy (LNG-07) |
| `gc.graceMs` | 86400000 | 02-18 | D-16, 24 hours, configurable |
| `maintenance.sliceMs` | 200 | 02-18, 02-20, 02-28 | DESIGN longest maintenance pause 200 ms |
| `maintenance.idleAfterMs` | 30000 | 02-28 | quiet time before the Host runs a maintenance slice |
| `governor.concurrency` | 4 | 02-09 | running jobs at once |
| `governor.maxQueue` | interactive 64, fresh 64, indexing 1024, maintenance 8 | 02-09 | bounded queues so busy can occur (research Pitfall 12) |
| `governor.busyRetryMs` | interactive 250, fresh 250, indexing 1000, maintenance 5000 | 02-09 | retry_after in milliseconds |
| `query.defaultBudgetTokens` | 2000 | 02-16 | QRY-02, locked |
| `query.hardCeilingTokens` | 8000 | 02-16 | below Claude Code's 10,000-token warning (research assumption A7) |
| `query.lineTextMaxChars` | 240 | 02-16 | fixed width for untrusted_text (D-10) |
| `query.defaultLimit` and `query.maxLimit` | 50 and 200 | 02-16 | result count bounds |
| `query.cursorMaxChars` | 1024 | 02-16 | reject oversized cursors |
| `query.resolveTimeoutMs` | 1500 | 02-19 | the Reader.refs bound named in the frozen interface |
| `impact.defaultDepth`, `impact.maxDepth`, `impact.rowCapPerHop` | 2, 5, 200 | 02-19 | code_impact bounds (user decision 3) |
| `history.maxFiles` | 2000 | 02-24 | symbol-form history file cap, reported as truncated (open question 7) |
| `metrics.queueMax` | 1000 | 02-10 | bounded in-memory event queue |
| `metrics.flushIntervalMs` | 5000 | 02-10 | batch write interval |
| `metrics.retentionDays` and `metrics.rollupAfterDays` | 30 and 7 | 02-10 | D-17, locked |
| `gate.freshnessPrCeilingMs` | 3000 | 02-26 | PR job bound for save-to-find (hosted CI timing is noisy) |
| `gate.freshnessNightlyP99Ms` | 1000 | 02-26 | the ROADMAP criterion, checked nightly and locally |
| `gate.storeMaxBytes` | 52428800 | 02-26 | DESIGN budget at gsd-core, 50 MB |
| `gate.storeEditsRatio` | 1.25 | 02-18, 02-26 | STO-05, locked |

## Package evidence

Registry queries run read-only on 2026-10-16 (no package was installed). `@parcel/watcher` is OK in the legitimacy audit; `@modelcontextprotocol/server` and its transitive `@modelcontextprotocol/core` are SUS only for age (under 90 days old).

### `npm view @modelcontextprotocol/server@2.3.1 version license repository.url dist.integrity time.modified`

```
version = '2.3.1'
license = 'Apache-2.0'
repository.url = 'git+https://github.com/modelcontextprotocol/typescript-sdk.git'
dist.integrity = 'sha512-e59MfWuSssj6DoQ96JCTqdW1AXT5/XtnTl0WWd6MU1Ka434fFUGGosCLJbGNySDhHGvxQWoRWK137FXYFkYNWw=='
time.modified = '2026-10-05T11:52:40.237Z'
```

### `npm view @modelcontextprotocol/server dist-tags`

```
{ latest: '2.3.1' }
```

### `npm view @parcel/watcher@2.6.0 version license dist.integrity`

```
version = '2.6.0'
license = 'MIT'
dist.integrity = 'sha512-7FNeNl8NCE7aINx7WXiKQrPYZWC/hvrTsmk6zmxbI7LTXE7hVek/n8AfVgpe2y82zl3w0HvCHN0bVKMBoJcC0w=='
```

### `npm view @modelcontextprotocol/server@2.3.1 dependencies peerDependencies`

```
{ zod: '^4.2.0', '@modelcontextprotocol/core': '2.3.1' }
```

(No `peerDependencies` are declared. `@modelcontextprotocol/node` and `hono` are not dependencies and are not installed in Phase 2.)

### Supplementary: transitive `npm view @modelcontextprotocol/core@2.3.1 version license dist.integrity`

```
version = '2.3.1'
license = 'Apache-2.0'
dist.integrity = 'sha512-laVmIhPGpWi7rG9q+0UigblRN0Hws/Yjlb6qLFtVqryXVLkc4h+yN8z731POD2LnAGQlFe7/tXhUm7Bi0YB91g=='
```

Audit note: @parcel/watcher is OK in the audit; @modelcontextprotocol/server and its transitive core are SUS only for age.

## Approvals

Both blocking-human checkpoints were answered by the user on 2026-10-16, each with the single word "approved", relayed by the orchestrator in the user's own session turn.

| Checkpoint | Date | User reply (verbatim) | Effect |
|------------|------|-----------------------|--------|
| Task 2: proposed constants | 2026-10-16 | "approved" | Every value in the Constants table accepted unchanged; no keys changed, no rows removed. Status set to Approved. |
| Task 3: `@modelcontextprotocol/server` 2.3.1 | 2026-10-16 | "approved" | Plan 02-23 may run `npm install --save-exact @modelcontextprotocol/server@2.3.1` (scripts disabled). Nothing was installed by plan 02-04. `@modelcontextprotocol/node` stays uninstalled in Phase 2. |
