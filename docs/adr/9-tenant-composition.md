# ADR: Tenant composition, Source Tree, Indexer and Governor

- **Status:** Accepted
- **Issue:** [#9](https://github.com/open-gsd/gsd-atlas/issues/9)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A4, A5, A19, A20, A21, A22, A24, A25, A26, A28, A40, A43, A47, A49, A59–A62
- **Refines:** [draft-host-process-model](draft-host-process-model.md), [draft-worktree-lifecycle](draft-worktree-lifecycle.md)
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
