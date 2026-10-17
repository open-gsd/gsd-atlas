---
phase: 02-grammar-tier-store-and-stdio-host
reviewed: 2026-10-17T00:00:00Z
depth: standard
files_reviewed: 62
files_reviewed_list:
  - src/fact-store/store.ts
  - src/fact-store/maintain.ts
  - src/fact-store/lifecycle.ts
  - src/fact-store/open.ts
  - src/fact-store/lease.ts
  - src/fact-store/recovery.ts
  - src/fact-store/writer.ts
  - src/fact-store/cache.ts
  - src/fact-store/location.ts
  - src/fact-store/schema.ts
  - src/facts/file-facts.ts
  - src/sqlite/open.ts
  - src/sqlite/wrap.ts
  - src/host/host.ts
  - src/host/history.ts
  - src/host/route.ts
  - src/host/config.ts
  - src/host/lang.ts
  - src/host-client/in-process.ts
  - src/mcp-shim/server.ts
  - src/mcp-shim/index.ts
  - src/mcp-shim/stdout-guard.ts
  - src/bin/compose.ts
  - src/bin/gsd-atlas.ts
  - src/bin/gsd-atlas-mcp.ts
  - src/tenant/create.ts
  - src/tenant/idle.ts
  - src/tenant/follower-overlay.ts
  - src/indexer/indexer.ts
  - src/indexer/process.ts
  - src/indexer/parcel-source.ts
  - src/indexer/worktrees.ts
  - src/indexer/git-dir.ts
  - src/indexer/paths.ts
  - src/indexer/ignore.ts
  - src/indexer/modules.ts
  - src/source-tree/real.ts
  - src/source-tree/validate.ts
  - src/source-tree/read-text.ts
  - src/command-runner/real.ts
  - src/command-runner/env.ts
  - src/command-runner/git-spec.ts
  - src/command-runner/exec-resolve.ts
  - src/command-runner/decide.ts
  - src/governor/real.ts
  - src/grammar-engine/engine.ts
  - src/grammar-engine/with-tree.ts
  - src/grammar-engine/pool/pool.ts
  - src/query/fence.ts
  - src/query/cursor.ts
  - src/query/tools.ts
  - src/cli/index.ts
  - src/cli/tool-commands.ts
  - src/cli/init.ts
  - src/cli/init-files.ts
  - src/cli/init-targets.ts
  - src/metrics/store.ts
  - scripts/corpus-fetch.ts
  - scripts/freshness-gate.ts
  - scripts/grammar-build.ts
  - .github/workflows/ci.yml
  - .github/workflows/nightly.yml
findings:
  critical: 0
  warning: 13
  info: 11
  total: 24
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-10-17
**Depth:** standard
**Files Reviewed:** 62 (the security and data-integrity subset of the 189-file phase scope; test files, fixtures and docs were not reviewed except where noted)
**Status:** issues_found

## Summary

Scope came from `check evaluation-scope --phase 02` (status `resolved`, 189 files). I prioritised the files the dispatch named and read them in full. Not every file in the phase was read; the remaining `src/query/*` ranking and paging modules, `src/metrics/*` besides `store.ts`, `src/lang/*`, the grammar-engine query and extract helpers, and the remaining `scripts/*` were only sampled by grep.

The code is in good shape on the points the dispatch asked about:

- **No network at runtime.** Nothing under `src/` imports `http`, `https`, `net` or calls `fetch`. The only `fetch` is in the dev-time `scripts/grammar-build.ts`, and the only network git call is in `scripts/corpus-fetch.ts`. No telemetry code exists.
- **No shell spawning.** `node:child_process` is imported only in `src/command-runner/real.ts` (plus dev scripts), always with `shell: false` and an argument array. Windows `.cmd`/`.bat` shims are rejected by name.
- **Hostile-repository git execution.** Filter drivers, fsmonitor, hooks, lazy fetch and transports are all neutralised in `gitSpec` and re-checked in `decide`.
- **Untrusted repo text** is normalised and nonce-fenced in `src/query/fence.ts`. Path arguments are confined in `read-text.ts` and `paths.ts`.
- **WASM trees and queries** are deleted in `finally` (`with-tree.ts`, `engine.ts`).
- **GitHub workflows** use minimal permissions, `persist-credentials: false` and SHA-pinned actions.

No critical (exploit, data-loss) defects were found. The 13 warnings are lifecycle and robustness defects. The most important ones:

- A read-only tool call can create state and take a writer lease in any repository the agent names (WR-01).
- The first MCP query in an un-indexed repository takes the lease and makes the `gsd-atlas build` that the `not_indexed` message tells the user to run fail with exit 3 (WR-02).
- A failed lease takeover or rebuild still reports leadership while the database handles are closed (WR-03).
- A synchronous `wal_checkpoint(TRUNCATE)` can freeze the event loop for the whole busy timeout (WR-04).

## Warnings

### WR-01: A "read-only" tool call creates files and takes a writer lease in any repository the agent names

**File:** `src/host/host.ts:71-100` (`tenantFor`), `src/tenant/create.ts:101-113`, `src/fact-store/location.ts:158-164`
**Issue:** `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status` and `lang_list` are registered with `readOnlyHint: true`. `repo` and `cwd` are free strings from the agent (`src/query/tools.ts:29-30`, `src/host/route.ts:147-159`). `resolveRepository` accepts any directory that is inside a git repository. `repoRequest` then calls `tenantFor` before any "is this repository indexed" check. `createTenant` calls `openFactStore(..., { lease: 'acquire' })`, and that:

- creates `<git common dir>/gsd-atlas/` with mode 0700;
- creates `facts.db`, `lease.db`, `lease.json` and `metrics.db` (`src/tenant/create.ts:118`);
- takes the repository's writer lease for the life of the process.

A prompt-injected agent can therefore make the server write into the `.git` directory of any repository the user can read. There is no allow-list of repositories, and the server keeps no record of which repositories the user meant to expose.

**Fix:** Do not open a store for a repository nobody built. Probe first and answer `not_indexed` without writing. For example, in `repoRequest`, before `tenantFor`:

```ts
// location.ts: add a read-only probe that never creates anything
export function findExistingStore(input: ResolveStoreLocationInput): string | undefined { /* lstat only */ }
```

Alternatively, add a user-config allow-list (`repos.allow`) that `resolveRepository` checks, and refuse other repositories with `not_a_repo`.

### WR-02: The first MCP query in an un-indexed repository takes the lease, so the `build` it recommends then fails

**File:** `src/tenant/create.ts:173-175,522-523`, `src/fact-store/open.ts:301-310`, `src/bin/gsd-atlas-mcp.ts:20-25`
**Issue:** The `not_indexed` message says "Run gsd-atlas build in it, then ask again." Opening the tenant (WR-01) takes the lease, and `build` is not an MCP tool. The user runs `gsd-atlas build` in a terminal. That process opens the store as a follower, and `build` returns `lease_held` (`if (!(await isLeader())) return leaseHeld()`, exit 3), for as long as the agent's MCP server process is alive. The only way out is to stop the agent. The design records "the leader is whichever process opened the store first" (D-01), but the combination with a message that points to the failing command is a dead end in the primary `init` then MCP flow. The takeover timer (10 to 30 s) only helps when the leader exits.

**Fix:** Minimal: make `leaseHeld()` and `notIndexed()` say which process holds the lease (`lease.info()` already carries pid and version). Better: do not acquire the lease when the repository has no overlay. A tenant for an un-indexed repository can open read-only and acquire the lease only on the first `build`/`maintain` request, or when `opening.worktrees.length > 0`.

### WR-03: A failed takeover or rebuild leaves closed database handles while the tenant still reports itself the leader

**File:** `src/fact-store/open.ts:366-383,390-406,413-422`
**Issue:**

- `recoverAfterTakeover` closes `conns.readDb` and `conns.writeDb`, then calls `openWithRecovery`. If that throws, `finally` resets `recovering`, but both handles stay closed.
- The caller swallows the error (`catch { /* ... keeps serving ... */ }`) and then calls `options.onLeaseChange?.(true)`. The comment "keeps serving what it can" is wrong: every later read goes through the closed `Db` and throws `DbError('database is closed')`.
- `onLeaseChange(true)` makes the tenant start an Indexer that writes into closed handles.
- `lifecycle.rebuild` (used by `check`) has the same shape: it closes the connections before it knows the replacement will open, then clears `recovering`.

**Fix:** Open the replacement first, then swap and close the old handles. For example, in `rebuild`, call `quarantine`, then `attemptOpen`, and only then `conns.readDb.close()` / `conns.writeDb.close()` the old ones. In `recoverAfterTakeover`, release the lease (`await lease.release()`) and skip `onLeaseChange(true)` when recovery throws, so the process is honestly a follower again and the takeover timer re-arms.

### WR-04: `wal_checkpoint(TRUNCATE)` runs synchronously and can block the whole process for the busy timeout

**File:** `src/fact-store/lifecycle.ts:272-273`
**Issue:** `compactStore` ends a finished run with `db.pragma('wal_checkpoint', 'TRUNCATE')`. `TRUNCATE` invokes the busy handler until every reader is reading only from the database file. The connection was opened with `busyTimeoutMs = 5000` (`open.ts:26`). Followers in other processes hold WAL read snapshots whenever they answer a query. Because `node:sqlite` is synchronous, a follower that is mid-read can stall the leader's whole event loop for up to 5 s. That stall includes request handling and the Governor. This contradicts the 200 ms `maintenance.sliceMs` pause guarantee that the rest of `compactStore` is built around (the slices are sized to it). It runs from the idle round and from `maintain compact`.

**Fix:** Use `PASSIVE` from the idle path, which never waits. Reserve `TRUNCATE` for an explicit `maintain compact --full`. Alternatively set `PRAGMA busy_timeout = 0` around the call:

```ts
db.pragma('busy_timeout', 0);
try { db.pragma('wal_checkpoint', options.full === true && complete ? 'TRUNCATE' : 'PASSIVE'); }
finally { db.pragma('busy_timeout', parts.settings.busyTimeoutMs); }
```

### WR-05: `resetLastInsertRowid` collides with a real empty-string name, and fact validation never checks names

**File:** `src/fact-store/lifecycle.ts:112-114`, `src/facts/file-facts.ts:179-250`, `src/fact-store/writer.ts:74-88`
**Issue:**

- `resetLastInsertRowid` runs `INSERT INTO names (name) VALUES ('')`. `names.name` is `UNIQUE` (`schema.ts:36`). If any live fact uses the name `''`, the insert raises a constraint error, so `collect` throws after it has already deleted rows. If `''` is currently unused, the insert and the delete race with nothing, so the happy path works.
- `validateFileFacts` requires non-empty names only for exports and bindings. It does not check `symbol.name`, `refSite.name`, `kind`, `qualifiedName`, `module`, `grammarVersion` or `contentHash` types.
- The extractor currently filters empty names (`extract.ts:183`), so this is latent. Any other fact producer, or a future module change, can write `''`, and a non-string name makes `commitFile` throw a bind error instead of returning `rejected`.

**Fix:** Validate names in `validateFileFacts`: every `symbol.name`, `refSite.name`, `qualifiedName` and `kind` must be a non-empty string, with a `facts_invalid` diagnostic otherwise. In `resetLastInsertRowid`, use a sentinel row that cannot collide, or touch a different table:

```ts
db.exec("INSERT INTO meta (name, value) VALUES ('_reset', '') ON CONFLICT (name) DO NOTHING; DELETE FROM meta WHERE name = '_reset'");
```

### WR-06: Store identity depends on which root commit `rev-list` prints first

**File:** `src/source-tree/real.ts:417-422`
**Issue:** `identity()` hashes `rev-list --max-parents=0 HEAD`'s first line. A repository with several root commits (subtree merges, `--allow-unrelated-histories`, a merged-in project) lists roots newest first. The first line therefore changes when HEAD moves between branches with different root sets, or when an unrelated history is merged. `storeId` is the tenant registry key and the store directory name in the cache location (`location.ts:151`). A different id means a different, empty store, and the old index is silently abandoned (never collected). A repository with an unborn branch also gets a different id once the first commit exists.

**Fix:** Make the root choice order-independent, for example the lexicographically smallest root over all roots reachable from `--all`. If store identity must not depend on HEAD, hash the sorted set of `--max-parents=0 --all` roots:

```ts
const roots = decoder.decode(stdout).split('\n').filter(Boolean).sort();
const rootCommit = roots[0] ?? null;
```

### WR-07: Several git invocations have no timeout, and the identity probe runs before the Governor

**File:** `src/source-tree/real.ts:296-309` (`hasObject`, `read`), `src/source-tree/real.ts:415-423` (`identity`), `src/host/route.ts:164`, `src/command-runner/real.ts:262-271`
**Issue:** `spec(['cat-file', '-e', hash], repoDir)`, `spec(['cat-file','blob', ...])`, `rev-list --max-parents=0 HEAD` and `rev-parse --git-common-dir` are built without `timeoutMs`. `real.ts` only arms a timer when `spec.timeoutMs` is set. So a git process that hangs (index lock held by a crashed editor on some setups, a repository on a stalled network share, a very large history) never returns. The `resolveRepository` probe runs `identity()` and `worktrees()` on every repo request, before `held()`/`admitted()`, so the Governor's queue bound does not protect against it. One hung repository then wedges every request that names it. `hasObject` is also what `collect` awaits per row.

**Fix:** Give every spec built in `createSourceTree` a timeout (`GIT_TIMEOUT_MS` already exists), and make the runner refuse specs with no timeout by applying a default (for example 60 s) in `start`:

```ts
const limit = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
```

### WR-08: `readMany` and `read` buffer entire blobs before the size cap is applied

**File:** `src/source-tree/real.ts:302-309,380-411`, `src/host/history.ts:174-182`
**Issue:** `cat-file --batch` prints every requested blob in full, and the `maxBlobBytes` cap is applied only after the runner has collected all stdout (`BIG_OUTPUT_BYTES` = 512 MiB). History asks for up to `maxFiles` (2000) paths, so a commit with a few large `.ts` or `.js` blobs makes the Host allocate their total size (up to 512 MiB, then the stream is cut and the request fails) before skipping them. The same holds for `read()`, which has no size cap at all. A repository the agent points `history` at can therefore force large allocations.

**Fix:** Do a `cat-file --batch-check` first to get sizes, then request only blobs at or under the cap:

```ts
// 1. git cat-file --batch-check  -> "<oid> <type> <size>" per path
// 2. git cat-file --batch for the paths whose size <= cap
```

For `read()`, enforce a `maxBytes` parameter the same way and lower `maxStdoutBytes` to it plus one.

### WR-09: Grammar load in the worker pool has no deadline

**File:** `src/grammar-engine/pool/pool.ts:280-292,340-341`
**Issue:** `runOn` arms `runTimeoutMs` and terminates a stuck worker. `loadInto` does not: `request(slot, ...)` for a `load` waits indefinitely. `execute` sets `slot.busy = true` before the load and clears it only in `finally`. A grammar whose WASM instantiation or query compilation hangs or runs very long occupies that slot forever. Language modules can come from the repository itself (`.gsd-atlas/languages/*`, highest precedence, `src/lang/registry.ts:25`), so this is reachable with repository content. With `size` workers (default up to 4) a few such files stall all parsing, and the Indexer's Governor jobs queue behind them.

**Fix:** Apply the same timer to loads and terminate the worker on expiry:

```ts
async function loadInto(slot, grammar) {
  const worker = slot.worker;
  const answer = request(slot, ...);
  const timer = setTimeout(() => { if (slot.worker === worker) detach(slot, new GrammarLoadError('engine_init_failed', 'grammar load timed out')); }, LOAD_TIMEOUT_MS);
  timer.unref();
  try { reply = await answer; } finally { clearTimeout(timer); }
```

### WR-10: Host keeps every Tenant and every history module host for the life of the process

**File:** `src/host/host.ts:44,171-181`
**Issue:** `tenants` and `historyModules` only grow. A tenant holds three SQLite connections, the lease connection (a held `BEGIN EXCLUSIVE`), a metrics database, an Indexer, a watcher and a follower module host. A history module host holds loaded grammars in pool workers. A long-lived MCP server that an agent points at many repositories (`repo` is agent-controlled, WR-01) accumulates all of them, and each tenant holds its repository's writer lease until the process ends (this also makes WR-02 persist). `closeTenant` exists but nothing calls it except `close`.

**Fix:** Add an idle eviction. When a tenant has had no request for N minutes (the Tenant already has an idle maintainer), `closeTenant(storeId)`. Dispose a history module host after its request, or share one host across repositories (modules are resolved per `repoRoot`, so key the cache but cap it with LRU).

### WR-11: The git permission gate denies options by exact token, so bundled short options pass

**File:** `src/command-runner/decide.ts:52,201-202`
**Issue:** `GIT_DENIED_OPTIONS = {'--help','--textconv','--filters','-w'}` is matched with `rest.some((r) => GIT_DENIED_OPTIONS.has(r))`. `git hash-object -wt blob ...` bundles `-w` and `-t` in one token and is not denied, so a `hash-object` spec could write objects into the repository. The header says the gate "must not trust the builder" (WR-01 in the file). Today every spec comes from `gitSpec` with fixed subcommand arguments, so this is not exploitable through a reachable path, but the gate is the last line of defence, and its stated purpose is to stand without the builder.

**Fix:** Replace the denylist with a per-subcommand allowlist of exact argument shapes, or at least reject any bundled short option:

```ts
const isDeniedOption = (r: string): boolean =>
  GIT_DENIED_OPTIONS.has(r) || (/^-[A-Za-z]{2,}$/.test(r) && /[w]/.test(r));
```

### WR-12: `init` rewrites the host config with an unguarded read-modify-write

**File:** `src/cli/init.ts:104-129`, `src/cli/init-files.ts:112-151`
**Issue:** `init` reads `~/.claude.json` (or the Cursor/Codex file), renders the new text, and later renames a temp file over it. Claude Code rewrites `~/.claude.json` itself while it runs (the code notes this at `init-targets.ts:133`). A write by the host between the read and the rename is silently lost; the atomic rename protects against torn writes, not lost updates. The one-time backup is made only from the file as it is at write time, not as it was read. The file also commonly holds account state, so a lost update is user-visible.

**Fix:** Record `mtimeMs` and `size` at read time and compare them just before the rename; refuse with `config_changed_during_init` when they differ.

```ts
const before = await stat(target);
// ... write temp ...
const after = await stat(target);
if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error('the file changed while init was running');
```

### WR-13: `Indexer.stop()` can abort halfway and leak the writer slot

**File:** `src/indexer/indexer.ts:698`
**Issue:** The loop `for (const unsubscribe of unsubscribes.splice(0)) await unsubscribe();` has no `try/catch`, unlike the git and per-worktree unsubscribes below it. If a legacy `attach(source, roots)` subscription fails to stop, `stop()` rejects before `host.dispose()` and `writer?.release()`. `stopping` then holds the rejected promise, so a second `stop()` returns the same rejection and the writer slot (`parts.state.writerTaken`) stays taken. `Tenant.applyLease(false)` calls `running.stop().catch(ignore)`, so a lease lost and regained later finds `store.writer()` throwing `WriterBusy` for a leader.

**Fix:** Use the same guarded call as the other unsubscribes (`await closeLate(unsubscribe)`), or wrap the whole teardown in `try/finally` that always runs `host.dispose()` and `writer?.release()`.

## Info

### IN-01: Wall-clock assertion in the compaction slice test (previously flagged)

**File:** `src/fact-store/maintain.test.ts:156`
**Issue:** `assert.ok(slice.ms < 200 * 5, ...)` asserts a real elapsed time (1000 ms, five times the approved 200 ms) taken with `performance.now()` inside `compactStore`. It does not use the fake clock, so a loaded or throttled CI runner (the Windows lane in particular) can fail it without any code change. The factor of five already shows the author knew it was loose.
**Fix:** Assert the structure instead of the time: that more than one slice ran, that page counts grew by at most `MAX_SLICE_GROWTH`, that `nextSlicePages` stays within `MAX_SLICE_PAGES`. Keep the time bound only in the measured-gate scripts, where a failure is meant to be a measurement.

### IN-02: The `collected` file state is dead

**File:** `src/fact-store/schema.ts:10,48`, `src/fact-store/writer.ts:310,330,390`
**Issue:** `deleteRetired` (`lifecycle.ts:47-63`) deletes the `files` row, so nothing ever sets `state = 'collected'`. The `existing.state === 'collected'` branches in `commitFile`, `link` and `setOverlay`, the `CHECK` value and the `rewriteFile` comment ("a collected file whose rows are gone") describe a state that cannot occur. They hide the real behaviour, that a collected hash is re-inserted with a new `files.id`.
**Fix:** Remove the state and the branches, or keep the row and set the state if overlay ids are meant to survive collection.

### IN-03: `isInside` is written six times, and two copies mis-handle a directory called `..name`

**File:** `src/host/route.ts:136-140`, `src/host/history.ts:105-109`, plus `src/indexer/paths.ts:15`, `src/indexer/git-dir.ts:28`, `src/source-tree/read-text.ts:25`, `scripts/corpus-fetch.ts:112`
**Issue:** The `route.ts` and `history.ts` copies test `!rel.startsWith('..')`. A worktree or sibling directory named `..cache` yields a relative path `..cache/x`, which is treated as outside. The result is a spurious `not_a_repo` or `history_unavailable`. The other copies use a separator-aware test.
**Fix:** One shared helper in a leaf module, using `rel === '..' || rel.startsWith('..' + path.sep)` as `parcel-source.ts` does.

### IN-04: `init`'s "no index yet" hint looks in the wrong place

**File:** `src/cli/init.ts:141-171`
**Issue:** `repoWithoutIndex` checks for `<gitDir>/gsd-atlas`, where `gitDir` is the `.git` directory or the linked worktree's `.git/worktrees/NAME`. The store lives in `<git common dir>/gsd-atlas`, or in the cache root (synced folder, network mount, `store.dir`), see `location.ts`. In a linked worktree, or when the store is in the cache, the hint says "has no atlas index yet" for a repository that has one.
**Fix:** Drop the filesystem guess, or resolve through `resolveStoreLocation`'s inputs without creating directories.

### IN-05: Environment scrubbing is a denylist of name patterns

**File:** `src/command-runner/env.ts:22-27`
**Issue:** `SECRET_LOOKING = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i` leaves `AWS_ACCESS_KEY_ID`, `SSH_AUTH_SOCK`, `DATABASE_URL`, `*_PASSWD`, `NPM_CONFIG__AUTH` and similar in the child environment. The only child today is `git` with transports disabled, so the exposure is small. The header says the policy is inherit-then-remove because Windows needs `SystemRoot`.
**Fix:** If more executables are ever allowed through user permissions, switch to an allowlist (`PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `LANG`, `LC_*`, `GIT_*` that are intended).

### IN-06: Pool deadline equals the parse deadline, so the cooperative cancel can never win

**File:** `src/grammar-engine/pool/pool.ts:32,181-182`
**Issue:** `runTimeoutMs` (5000) is also passed as `parseTimeoutMs` to the engine in the worker. The pool terminates the worker at the same instant the progress callback would cancel the parse. The comment accepts this ("the pool deadline normally fires first"), but it means every slow parse costs a worker restart, which discards that worker's loaded grammars and forces a reload on the next job.
**Fix:** Set the engine's `parseTimeoutMs` below the pool deadline (for example `runTimeoutMs - 1000`), so the worker survives an ordinary slow parse and the terminate path is the backstop for a stuck one.

### IN-07: The MCP and CLI bins install no signal handlers

**File:** `src/bin/gsd-atlas-mcp.ts:27-40`, `src/bin/gsd-atlas.ts:25-46`
**Issue:** Shutdown relies on stdin ending (`runMcpShim` resolves) and the `finally` that calls `composed.dispose()`. An MCP client that sends SIGTERM or SIGINT without closing stdin ends the process without `store.close()`, `engine.dispose()` or watcher teardown. The OS drops the lease, but the `dirty` sentinel can survive and the next open pays a `quick_check`, and the WAL is left unchecked.
**Fix:** `process.once('SIGTERM'|'SIGINT', ...)` that closes stdin's transport and awaits `composed.dispose()`, then exits.

### IN-08: Test hooks are mutable exports of production modules

**File:** `src/fact-store/lifecycle.ts:19-28`, `src/fact-store/recovery.ts:31`
**Issue:** `lifecycleTestHooks` and `recoveryCounters` are module-level mutable state, shared by every store in the process and set to `undefined` by tests. A leaked hook (a test that fails before cleanup) alters later stores. `onSelected` can also be awaited inside `collectRetired`.
**Fix:** Inject the hooks through `StoreParts.deps` or a store option, or at least freeze the production object and expose a setter only from a `*.test-support.ts` module.

### IN-09: `gsd-atlas` composes the Host before parsing arguments

**File:** `src/bin/gsd-atlas.ts:25`
**Issue:** `composeHost` runs at module top level, outside the `try`. It reads `package.json` and the user config and creates the pooled engine even for `--help`, `--version` or a usage error. If it throws (a missing `package.json`, a bad install), the failure is an unhandled top-level rejection with a stack trace instead of the CLI's `error internal_error` line and exit code 2.
**Fix:** Move `composeHost` into the `try`, and create it lazily the way `gsd-atlas-mcp.ts` does.

### IN-10: `createTenant` leaks the store and its lease if a later step throws

**File:** `src/tenant/create.ts:101-118,431`
**Issue:** After `openFactStore` succeeds, `await openMetrics(...)` (which does not throw), `createQuery`, `createFollowerFresh` and the `await store.status()` at line 431 can still reject. Nothing closes `store`, so the writer lease stays held by an object nobody references. The Host forgets the failed creation (`host.ts:96-98`), so the next request opens the store again and finds itself a follower of its own leaked handle.
**Fix:** Wrap everything after `openFactStore` in `try { ... } catch (e) { await store.close(); throw e; }`.

### IN-11: Governor frees a slot on timeout while the job is still running

**File:** `src/governor/real.ts:168-176`
**Issue:** On `timeoutMs` the Governor aborts the signal and calls `finish`, which releases the slot, while `fn` may keep running if it ignores the signal. The concurrency cap can then be exceeded by orphaned jobs. The Host and Indexer never pass `timeoutMs` today, and `held()` ignores the signal, so this is latent.
**Fix:** Document that jobs must honour the `AbortSignal`, or keep the slot until `fn` settles and report `timeout` to the caller only.

---

_Reviewed: 2026-10-17_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
