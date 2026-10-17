# ADR: Tenant composition, Source Tree, Indexer and Governor

- **Status:** Accepted
- **Issue:** [#9](https://github.com/open-gsd/gsd-atlas/issues/9)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A4, A5, A19, A20, A21, A22, A24, A25, A26, A28, A40, A43, A47, A49, A59–A62
- **Refines:** [draft-host-process-model](draft-host-process-model.md), [11-worktree-lifecycle](11-worktree-lifecycle.md)
- **Review findings addressed:** design-it-twice review, findings 3 and 4

## Context
Three groups of behaviour had no owner:
- **Git-derived facts** (blob-id hashing with clean filters, the source set, object existence, reading at a commit, repo identity) were touched in seven places (A4, A5, A19, A20, A43, A47, history replay).
- **Scheduling and budgets** were four decisions (A25, A28, A40, A49) describing one thing.
- **The path from file or git event to stored facts** (A24, A26) had no module, and read-your-writes spanned Query, the queue and the Fact Store.

## Decision
1. **Source Tree** owns everything git-derived. Interface: `snapshot(worktree) → Map<path, hash>` (tracked, modified and untracked, A19), `sourceSet` rules (A47), `hasObject(hash)`, `read(commit, path)` and `identity()` (root commit + store id, A43). Git is local-substitutable, so there is no port; tests use real temporary git repos. The store *location* (A4, synced-folder fallback) is host policy and stays out.
2. **Indexer** owns the (worktree, path) coalescing queue holding the latest hash (A24), file and git events, parsing through the Grammar Engine, commits to the Fact Store (it is the store's only writer client), and consuming Reconcile's re-index list. Interface: `submit(event)`, `ensureFresh(worktree, paths, waitMs) → { indexedThrough, timedOut }`, `reconcile()`, `status()`.
3. **Read-your-writes (A26)** is `Indexer.ensureFresh`, called by Query. The Fact Store only reports `stalePaths` in its watermark and never blocks.
4. **Governor** is one machine-wide module for scheduling and budgets (A25, A28, A40, A49). Interface: `run(job{ tenant, class, cost }, fn) → result | Busy{ retry_after }`. Inside it: per-tenant queues with weighted round-robin and a concurrency cap, the priority classes (interactive reads > fresh > indexing > maintenance), per-query time limits, the machine-wide memory budget, and the parser and compiler pools. The Governor owns pool slots and the budget; a PreciseResolver adapter owns its own compiler program. Tests use a fake clock.
5. **Host is the composition root** (A22). It owns transport, authentication and tenant routing. For each repo it builds one **Tenant**: Source Tree, Fact Store, Indexer, Query and Policy wired together. The Grammar Engine, CommandRunner, SDK providers and Governor are shared across tenants. Adapters (MCP, CLI, hooks, stdio shim) only call `host.handle(request)`. Unloading a tenant drops one composition.
6. **Naming:** "workspace" stays reserved for A42's user-declared set of repos queried together.

## Consequences
- Each of the three tangled groups has one place to change and a test surface at its interface.
- Tenant isolation (A22) gets a concrete shape: a tenant is exactly the set of modules that hold per-repo state.
- Fairness and memory budgets become testable without real compilers.
- The Indexer is the only writer client, which makes the Fact Store's single-writer lease structural.
- New moving parts: five more named modules to keep thin. The deletion test applies: if Source Tree or Indexer is deleted, complexity reappears in the Fact Store, daemon and CLI, so they are earning their keep.

## Alternatives considered
- **Leave git calls where they are:** seven call sites learn clean-filter and CRLF subtleties.
- **Governor admits only, pools elsewhere:** simpler Governor, but the memory budget then spans modules.
- **Adapters wire modules directly:** every transport re-implements tenant lookup and lifecycle.
- **Fact Store waits for pending commits:** the store cannot wait on work it does not know about without the Indexer registering paths with it.

## Open questions
- Does `Indexer.ensureFresh` take a `fresh` priority class slot from the Governor per call, or one per request?
- Where does the file watcher live: inside the Indexer (events are its input) or as a separate Source Tree feature? Leaning Indexer, with Source Tree supplying git events.
- A compiler program is per file set (A25): does the Governor's LRU key on (tenant, overlay) or on the file set?

## Amendment 2026-10-15: Open questions resolved

Sources: D-17 of the Phase 1 context; ARCHITECTURE.md Open Questions Q3, Q5 and Q6.

The three open questions above are answered here. The original bullets stand unedited as the record of what was asked.

- *Does `Indexer.ensureFresh` take a `fresh` priority class slot from the Governor per call, or one per request?* `Indexer.ensureFresh` takes one `fresh` priority slot from the Governor per request, not per call. Waiting consumes no slot, named paths are promoted to class `fresh` in the Indexer queue, and one deadline covers the whole request.
- *Where does the file watcher live?* The file watcher lives inside the Indexer, behind an `EventSource` port with two adapters: fs-watch for production and a manual source for tests. Source Tree supplies only git events.
- *A compiler program is per file set (A25): does the Governor's LRU key on (tenant, overlay) or on the file set?* The compiler-program LRU keys on the file set, not on (tenant, overlay), because a program is per file set (A25). The Governor lease key is therefore a tenant plus a file-set id, and eviction is by file-set id.

## Amendment 2026-10-17: Idle eviction, git timeouts and store identity

Sources: FND-12; 02-REVIEW WR-06, WR-07, WR-08, WR-10, IN-03; plans 02-38, 02-40 and 02-41; the 2026-10-17 addendum of 02-CONSTANTS.md (`host.idleEvictMs`, `runner.defaultTimeoutMs`, approved that day).

Gap closure found that the Host kept every tenant open for ever, that some Source Tree git calls had no deadline, that a batch read buffered blobs it then discarded, and that the store identity depended on the order git prints root commits. This amendment records the shipped composition rules. The decisions above and the amendment of 2026-10-15 stand unedited.

1. **Idle eviction (refines decision 5, "Unloading a tenant").** The Host closes a tenant, and the module host it keeps for `history`, after 30 minutes (`host.idleEvictMs`, 1,800,000 ms, three times the idle Reconcile interval) with no request and none in flight. Closing releases the repository's writer lease, its SQLite connections and its watcher. A request in flight defers the eviction, and a finished request restarts the idle period. The next request opens a fresh tenant; a request that arrives while the old tenant is still closing waits for the close, so it never starts as a follower of its own predecessor. A tenant whose reply is `store_unavailable` is evicted the same way once nothing runs on it. A tenant whose construction fails after its store opened closes the store, Metrics and module host before the error propagates, so a failed construction never leaves the lease held.
2. **A store that holds no index is not opened by a read request.** The Host decides this with the read-only probe described in [13-mcp-contract](13-mcp-contract.md), Amendment 2026-10-17; only `build` creates a store. The rules that decide where a store lives are one set shared by the tenant and the Host, and they create nothing.
3. **Every Source Tree git spec has a deadline (refines decision 1).** `hasObject`, `read`, both `identity` specs, the filter-driver enumeration and the others carry the approved `git.timeoutMs` (60 s). A test over a recording runner fails if a method is added without a timeout. The CommandRunner default of [4-command-runner](4-command-runner.md), Amendment 2026-10-17, is the backstop for any caller that forgets.
4. **Reads are size-checked before their bytes are read (refines decision 1, `read`).** `readMany` asks for object sizes first, keeps the blobs under the cap, and then reads only those, with an output cap computed from the sizes. `read(commit, path, { maxBytes })` defaults to 2 MiB and raises `source_too_large` for a larger blob.
5. **The store id no longer depends on print order (refines decision 1, `identity()`).** `storeId` is derived from the smallest of the root commit ids reachable from HEAD, so the order in which git prints them does not matter. The formula is unchanged, so a repository with one root commit (gsd-core) keeps its id. The id still changes when the set of roots changes: an unrelated history merged in, a branch with other roots, or the first commit of an unborn branch. A persisted id is a Phase 4 identity question (ROADMAP, Phase 4, success criterion 7); `--all` was considered and rejected.
6. **Known remainder.** The identity probe runs before the Governor admits a request, because the tenant key is unknown until it returns. It is bounded by the 60 s timeout, but a burst of requests naming many different hung repositories can start many git processes at once. The Phase 4 Governor owns that (HRD-05). An agent that touches many repositories inside one idle interval holds them all open.

## Amendment 2026-10-17: Source Tree ignore verdicts and attribute prefetch

Sources: .planning/debug/windows-freshness.md (options 1 and 2); plan 02-46; [4-command-runner](4-command-runner.md), Amendment 2026-10-17 (One pathspec-free ls-files listing for the ignore check).

Hosted Windows freshness figures were the debounce plus a number of sequential git starts times the cost of a start. This amendment records the two Source Tree changes that cut the number of starts per save. The decisions above and the earlier amendments stand unedited.

1. **`unignoredPaths(worktree, paths)` (refines decision 1).** It returns the requested names, by exact equality, that one pathspec-free `ls-files -z --cached --others --exclude-standard` listing names as tracked or as untracked and not ignored. A path that is not repo-relative (absolute, a `..` segment, NUL, empty) rejects with `invalid_argument` before git starts, an empty list starts no git, and a failed listing rejects with `git_failed`. The listing also names a gitlink and a nested repository (as `dir/`), so the caller still tests that the path is a regular file, which is how a gitlink is dropped. The Indexer's ignore check uses it instead of a snapshot: the oracle is no longer a snapshot, it hashes nothing, and a path that is a link or a directory is dropped without a git run. Verdicts are the old ones, including for a case-folding file system, where the index spelling is what counts.
2. **`pathAttributes(worktree, paths)` (refines decision 1, `sourceSet` rules).** One `check-attr` run over the paths that `hashPaths` would hash (the same vetting, so a deleted path starts no git), with an entry for every path asked, and `SourceSetOptions.attributes` lets `sourceSet` use that map instead of asking again (a path the map lacks is still asked for, so the result never depends on the map). `prepare` starts `pathAttributes` before it awaits `hashPaths`, so `config` and `check-attr` run together and `hash-object` follows. Errors surface in the old order: a failure of the filter enumeration is reported at once and the attribute query is abandoned with its rejection handled; an attribute failure is reported only when something was hashed.
3. **The filter list is still enumerated on every hash and never cached.** The order "enumerate filters, then hash" is unchanged, so a driver added between two batches is neutralised in the second.
4. **Counts.** An edit of a file the filter already knows costs 3 git starts in 2 sequential stages (was 3 in 3), and a new file 4 in 3 (was 7 in 7). The listing is O(tree) per batch of new files with no hashing; its hosted Windows cost is measured by the trace of plan 02-46, not claimed here. No bound, debounce, timeout or other constant changed.
