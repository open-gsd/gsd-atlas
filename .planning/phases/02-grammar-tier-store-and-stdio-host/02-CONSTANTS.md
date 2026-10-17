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

## Addendum 2026-10-17 (gap closure)

Addendum status: Proposed

This addendum belongs to plan 02-29 and adds rows only. No value in the Constants table above changes. Plans 02-38, 02-39 and 02-41 carry a precondition that the line above reads `Addendum status: Approved`; if it reads Proposed they halt. Plans 02-30 and 02-37 use only the two recorded existing thresholds, which are already in code, so they do not wait.

### New keys (need approval)

| Key | Proposed value | Consumed by plan | Basis |
|-----|----------------|------------------|-------|
| `pool.loadTimeoutMs` | 30000 | 02-39 | WR-09. A grammar load (WASM instantiate plus query compile) has no deadline today and a language module can come from the repository, so one hung load occupies a parser worker forever. The value is far above a normal cold load (tens to a few hundred milliseconds on macOS; hosted Windows runners were measured 5 to 10 times slower in 02-VERIFICATION) and still bounds a hang. |
| `pool.terminateGraceMs` | 2000 | 02-39 | IN-06. The pool's hard deadline becomes the approved `indexer.parseTimeoutMs` (5000, unchanged, the engine's cooperative cut-off) plus this grace, 7000 ms, so an ordinary slow parse ends in the engine's own `parse_timeout` and the worker, with its loaded grammars, survives; terminating the worker is only the backstop for a stuck one. |
| `host.idleEvictMs` | 1800000 | 02-41 | WR-10. The Host closes a tenant, and a history module host, that has had no request and has none in flight for this long, which releases the repository's writer lease, three SQLite connections and the watcher. 30 minutes is three times the 10-minute idle Reconcile interval (D-13), so a session that is actually working never loses its leader. |
| `runner.defaultTimeoutMs` | 60000 | 02-38 | WR-07. The CommandRunner applies this limit to a `run()` spec that sets no `timeoutMs`, so a git process (or any other child) started by a caller that forgot one can no longer hang for ever. The value equals the approved `git.timeoutMs`; the runner default is the very 60 s that Phase 1 held back for a human decision (01-09), which is why it is listed here and not assumed. It never applies to `stream()` (long-lived children such as an MCP server in a test have no deadline) and an explicit `timeoutMs` always wins. |

### Existing thresholds recorded as the idle loop's policy (values unchanged)

| Key | Value | Lives in today | Note |
|-----|-------|----------------|------|
| `compact.fullFreeFraction` | 0.25 (free pages times four above the page count) | `src/fact-store/lifecycle.ts` `worthVacuuming` | The rule of ADR 11 decision 5 ("free pages exceed 25 %"). |
| `compact.fullUnusedFraction` | one third (unused bytes inside b-tree pages above a third of the file, read from `dbstat`) | `src/fact-store/lifecycle.ts` `FRAGMENTED_FRACTION` | An internal bound of plan 02-18 chosen because a fresh build is about 26 percent empty inside; the margin is the hysteresis that keeps the idle loop from vacuuming every round. |

### Derived values (no free choice; in force without waiting for the reply)

| Key | Value | Derivation |
|-----|-------|------------|
| `compact.checkpointBusyTimeoutMs` | 0 | SQLite's busy timeout of 0 means "do not wait"; WR-04 requires exactly that for the truncating checkpoint, so it is a property, not a duration. The connection's previous value is restored afterwards. |
| `source.batchRecordAllowanceBytes` | 128 | One record of `git cat-file --batch` is `<oid> <type> <size>` plus a line feed, then the body, then one line feed: at most 64 hex characters (the SHA-256 object format, the longest), 1 space, 6 characters (`commit`, the longest type word), 1 space, 20 digits (a 64-bit size), 1 line feed and 1 trailing line feed, which is 94 bytes, rounded up to 128. Plan 02-38 sets the output cap of the object batch to the selected blob sizes plus this allowance per record. |
| `source.batchCheckLineBytes` | computed per request | The output cap of `git cat-file --batch-check` is, for each input line, the larger of 94 bytes (a found record) and the length of the echoed spec plus 12 bytes (` missing` or ` ambiguous` plus a line feed), summed over the request. It is derived from the request itself, so it has no number to approve. |
| `compact.afterChurnFallback` | a rule, not a number | On a SQLite build without the `dbstat` table the idle loop requests the VACUUM after any collect that deleted files, instead of past the in-page threshold it cannot measure (plan 02-30). Both drivers were checked on 2026-10-17 and both have `dbstat`, so this is a safety net. |

### Approved values reused without any change

- `git.timeoutMs` 60000, now applied to every Source Tree git spec (WR-07).
- `git.hashBatchTimeoutMs` 120000, for the batched object read.
- `gate.storeEditsRatio` 1.25, now asserted on the idle-only ratio (STO-05).
- `maintenance.sliceMs` 200, unchanged.
- `indexer.parseTimeoutMs` 5000, unchanged.

### Exception to maintenance.sliceMs

A full VACUUM is a single synchronous rewrite of the live data and cannot be sliced, so the idle loop's full compaction (STO-05, D-16) is a pause longer than 200 ms on a large store. It runs only after a completed collect, only when `compact.fullFreeFraction` or `compact.fullUnusedFraction` is crossed, and the size gate (plan 02-37) prints its measured length so the owner can judge it against a real store.

### Addendum approvals
