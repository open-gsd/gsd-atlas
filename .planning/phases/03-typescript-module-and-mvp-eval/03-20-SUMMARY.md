---
phase: 03-typescript-module-and-mvp-eval
plan: 20
subsystem: fact-store-resolver-seam
tags: [fact-store, precise-resolver, resolver-port, symbol-lookup, project-context, negative-marker, tdd]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "ADR 7 amendment of 2026-10-18 (plan 03-08): resolver port scope, findIn, per-overlay context, negative markers"
  - phase: 03-typescript-module-and-mvp-eval
    provides: "kernel additions of plan 03-12 (fourteen degraded codes) and the frozen Stage A pre-registration (plan 03-16, untouched)"
provides:
  - "ResolveScope, ResolverPort, LocatedSymbol, ProjectContext, ProjectContextProvider, DEFAULT_PROJECT_CONTEXT and SymbolLookup.findIn in the facts kernel"
  - "PreciseResolver.resolve(overlay, context, sites, symbols?) and asStoreResolver(precise): ResolverPort"
  - "StoreOptions.projectContext (per-overlay, asynchronous, memoised per worktree and snapshot, race-safe); resolutionContext kept as a deprecated alias"
  - "resolved_asked derived table (the negative marker) with readAsked, writeAsked and one-pass pruning"
affects: [03-21, 03-22, 03-23, 03-24, 03-25, 03-27, 03-29]
actuals:
  tokens: 21700
  tasks: 3
  commits: 6
commits: 6
plan_head_before: a4a757a43f20c882ad3c398b4fac2b1c0df242df
plan_head_after: 44b08d71e15cb1cbc59e82a287811d3257958a00
tech-stack:
  added: []
  patterns:
    - "Additive seam growth: the new resolver argument is the fourth and optional, so a three-argument resolver is still a ResolverPort"
    - "Synchronous when it can be: a store with no provider reads the context without yielding, so Phase 2 timing contracts (timer registered before the call returns) hold"
    - "Derived cache tables created with IF NOT EXISTS: no schema-version bump, dropping them changes call counts only"
key-files:
  created:
    - src/precise-resolver/store-adapter.ts
  modified:
    - src/facts/resolution.ts
    - src/facts/index.ts
    - src/facts/facts.test.ts
    - src/precise-resolver/index.ts
    - src/precise-resolver/contract.ts
    - src/precise-resolver/precise-resolver.test.ts
    - src/fact-store/types.ts
    - src/fact-store/parts.ts
    - src/fact-store/open.ts
    - src/fact-store/snapshot.ts
    - src/fact-store/resolve.ts
    - src/fact-store/reader.ts
    - src/fact-store/cache.ts
    - src/fact-store/schema.ts
    - src/fact-store/contract.ts
    - src/fact-store/resolve.test.ts
key-decisions:
  - "ProjectContext carries only `context` here; the optional `emit` lookup is plan 03-22's to add"
  - "A provider given as StoreOptions.projectContext is memoised per (worktree, snapshot id) in a 16-entry least-recently-used map and failures are never remembered; the deprecated synchronous resolutionContext option is NOT memoised, because the Phase 2 contract changes it between calls and expects a cache miss"
  - "A store with no provider answers the context synchronously and readResolving returns a plain value (not a promise) in that case; reader.refs and callers only await when they got a promise. An always-async version made the Phase 2 resolver_timeout contract case hang (the fake-clock timer was registered after the test advanced the clock)"
  - "Asked markers are written for every site of a completed resolver call, including a background call that finished after a timeout; a timeout or failure writes none while it is pending or failed. A follower with edges to keep says cache_unavailable as before; a follower whose resolver yielded nothing says nothing, as before"
  - "findIn matches the simple name (symbol.name), in definition order, from the overlay's own file for the exact path; it never normalises the path"
requirements-completed: []
coverage:
  - id: G1
    description: "The resolver receives a scope (worktree, overlay id and path to hash map, project context) as a fourth argument; a three-argument resolver and a PreciseResolver without the symbols argument keep working"
    requirement: "TSM-01"
    verification:
      - kind: unit
        ref: "src/fact-store/resolve.test.ts#resolver receives scope / three-argument resolver still works (both SQLite drivers)"
        status: pass
      - kind: unit
        ref: "src/precise-resolver/precise-resolver.test.ts#asStoreResolver (4 cases) and the contract case 'resolves the same edges with and without the optional symbols argument'"
        status: pass
    human_judgment: false
  - id: G2
    description: "SymbolLookup.findIn(path, name) returns the overlay version's symbols with identity and span; empty for unknown path, unknown name, empty name and paths outside the overlay; identical bytes at two paths get their own identities"
    requirement: "TSM-01"
    verification:
      - kind: unit
        ref: "src/fact-store/resolve.test.ts#findIn returns spans / findIn empty for unknown / identical bytes at two paths (both drivers)"
        status: pass
    human_judgment: false
  - id: G4
    description: "Per-overlay asynchronous project context: provider context reaches the resolver and keys the cache, changed config hashes miss, one provider call per snapshot, a commit during the provider retries once, a provider that always loses or throws degrades to resolver_failed with no cached rows, the old resolutionContext option still works"
    requirement: "TSM-01"
    verification:
      - kind: unit
        ref: "src/fact-store/resolve.test.ts#per-overlay project context (7 cases, both drivers)"
        status: pass
    human_judgment: false
  - id: P6
    description: "Negative marker (Pitfall 6): a site asked with no edge is remembered under (snapshot, context), pruned with its snapshot, not written on timeout or failure or by a follower, droppable without changing an answer"
    requirement: "TSM-01"
    verification:
      - kind: unit
        ref: "src/fact-store/resolve.test.ts#negative marker for asked sites (6 cases, both drivers)"
        status: pass
      - kind: contract
        ref: "src/fact-store/contract.ts#refs negative marker: asking twice calls the resolver once for each distinct site (both drivers)"
        status: pass
    human_judgment: false
  - id: REG
    description: "Phase 2 behavior unchanged with the default provider and a resolver that yields nothing; schema version stays 1; Stage A freeze untouched"
    requirement: "TSM-01"
    verification:
      - kind: other
        ref: "npm test (3426 tests, 0 failures, 1 pre-existing skip); npm run typecheck; npm run lint; npm run build; node scripts/eval/verify-prereg.ts prints 'verify-prereg: ok'; schema.ts still has SCHEMA_VERSION = 1"
        status: pass
    human_judgment: false
duration: 24min
completed: 2026-10-18
status: complete
---

# Phase 3 Plan 20: Resolver seam for a compiler adapter Summary

**The frozen resolver seam grew, additively, what a real compiler adapter needs: a scope and a symbol lookup with spans (`findIn`), a per-overlay asynchronous project context that is memoised and race-safe, and a negative marker so a site that legitimately has no edge is never asked about twice; with the default provider every Phase 2 answer is identical.**

## Performance

- **Duration:** 24 min measured from the recorded start (the initial reading of the plan, decisions, constants and prior summaries came before it)
- **Completed:** 2026-10-18T14:37Z
- **Tasks:** 3 (one tracer, two auto), each as a RED `test(03-20)` commit followed by a GREEN `feat(03-20)` commit
- **Files:** 17 changed (1 created, 16 modified), 1446 insertions and 64 deletions

## Accomplishments

- **Scope and lookup (G1, G2).** `ResolverPort` is the kernel type of the store's resolver; its fourth, optional argument is a `ResolveScope` {worktree, overlay {id, pathToHash}, project}. `SymbolLookup.findIn(path, name)` reads the overlay's own file for that exact path and returns `LocatedSymbol` (identity plus span) in definition order. `PreciseResolver.resolve` takes an optional fourth `symbols` argument and `asStoreResolver(precise)` is the one adapter from the module-level interface to the port (no scope, no call, nothing yielded; the iterable passes through so cleanup runs once).
- **Project context (G4).** `StoreOptions.projectContext` replaces the synchronous option, which stays as a deprecated alias. `readResolving` computes the context before the read transaction for the snapshot a quick read sees, checks the snapshot did not move, and retries once; a provider that fails or loses twice gives `resolver_failed`, the grammar answer and no cache rows (T-03-202). The provider is called at most once per (worktree, snapshot id).
- **Negative marker (Pitfall 6).** `resolved_asked` holds one row per asked site under (snapshot, context), written in the same transaction as the edges, pruned with them, and read in phase 1 so a settled site is not asked again.

## Task Commits

1. **Task 1 (tracer): scope and symbol lookup with spans** - RED `3b4e76c` (test), GREEN `ab550e4` (feat)
2. **Task 2: per-overlay asynchronous project context** - RED `9af69f8` (test), GREEN `324250d` (feat)
3. **Task 3: negative marker for asked sites** - RED `ab81ded` (test), GREEN `44b08d7` (feat)

**Plan metadata:** the docs commit that adds this file.

Tracer feedback gate (interactive, `human_verify_mode` end-of-phase, automated-only verify): the Task 1 verify command (resolve, precise-resolver, facts, lease tests, typecheck, lint) was re-run green and the whole `src/fact-store` directory passed before Task 2 started. No `gate="blocking-human"` was set.

## TDD Gate Compliance

Plan type is `execute` with `tdd="true"` tasks and `tdd_mode` was on, so each task has a `test(03-20)` commit that precedes its `feat(03-20)` commit. Each RED commit carries compile-only scaffolding so the tests fail on their planned assertions instead of on a missing export: kernel types and a `findIn` that returns `[]` and an adapter that yields nothing (Task 1), nothing at runtime (Task 2), the `resolved_asked` table definition (Task 3). RED evidence went through `gsd_run check tdd-red-evidence` and returned `RED_EVIDENCE_OK` (`target_test_failed`) for one target per task; the evidence records were written to the git-ignored `.tmp/` and removed with the other scratch files before returning.

- **RED 1:** target `findIn returns spans: ...` (run with `--test-name-pattern=node:sqlite` because the test name repeats per driver and the first full-file run returned `INVALID_RED no_target_test_failure` for the ambiguous name). Semantic assessment: it executed and failed on a strict deep-equal, actual `[]` against the two `parse` identities of `src/a.ts`, because the scaffold `findIn` returns nothing. 9 of 111 tests failed, all on assertions (3 per driver in resolve.test.ts, 3 in precise-resolver.test.ts).
- **RED 2:** target `provider context reaches the resolver and keys the cache: a second read asks nothing`. Failed on a strict deep-equal, actual `{id: 'grammar', configHashes: []}` against `{id: 'ts:test', configHashes: ['aa']}`, because `projectContext` was ignored. 6 of 8 failed; `no provider is grammar` and `old resolutionContext option` already held and are characterization.
- **RED 3:** target `asked once: ...`. Failed with `0 !== 2` on the `resolved_asked` row count after the first read. 5 of 6 failed; `follower writes nothing` already held (today's behavior), and the contract case failed on the same count.
- **GREEN:** all three targets pass on both SQLite drivers; no REFACTOR commit.

## Files Created/Modified

- `src/facts/resolution.ts`, `src/facts/index.ts` - the new kernel types, `findIn` on `SymbolLookup`, `DEFAULT_PROJECT_CONTEXT` (frozen)
- `src/precise-resolver/index.ts`, `store-adapter.ts` - the optional `symbols` argument and `asStoreResolver`
- `src/fact-store/types.ts` - `Resolver` is the kernel `ResolverPort`; `StoreOptions.projectContext`, deprecated `resolutionContext`
- `src/fact-store/snapshot.ts` - `symbolsIn` behind `findIn`
- `src/fact-store/parts.ts`, `open.ts` - `ProjectContextSource`, `createProjectContextSource` (memo, validation, no failure memo)
- `src/fact-store/resolve.ts`, `reader.ts` - `readResolving`, scope construction, `unavailable` input, asked-aware `resolveSites` and `store`
- `src/fact-store/cache.ts`, `schema.ts` - `readAsked`, `writeAsked`, two-table pruning, `resolved_asked`
- Tests: `src/fact-store/resolve.test.ts` (new rig on a real store, both drivers; 5 + 7 + 6 cases), `src/fact-store/contract.ts` (one both-driver case), `src/precise-resolver/precise-resolver.test.ts` and `contract.ts`, `src/facts/facts.test.ts`

## Decisions Made

See `key-decisions` above. Two worth restating: the legacy `resolutionContext` option is deliberately not memoised (a Phase 2 contract case changes it between reads), and the no-provider path is synchronous so reads reach the resolver before they yield.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] First implementation of `readResolving` made every read yield, which hung the Phase 2 `resolver_timeout` contract case**
- **Found during:** Task 2, running `src/fact-store/store.test.ts` (it did not finish; the process was killed)
- **Issue:** The contract case calls `reader.refs(..., {timeoutMs: 50})` and advances the fake clock at once. With an `async` `readResolving` the timeout timer was registered one microtask after the test had already advanced the clock, so it never fired and the gated resolver was never released.
- **Fix:** `ProjectContextSource` returns a plain value when there is no provider (or only the deprecated option) and a promise only for a provider; `readResolving` returns a plain value or a promise accordingly, and `refs` and `callers` await only a promise. Stores with no provider behave exactly as in Phase 2, including timing.
- **Files modified:** `src/fact-store/parts.ts`, `src/fact-store/resolve.ts`, `src/fact-store/reader.ts`
- **Commit:** `324250d`

**2. [Test design, no code change] Task 2 cases first used a resolver that answered one of two sites**
- **Found during:** Task 2 RED
- **Issue:** with one site unanswered, a second read still asks about it (that is Pitfall 6, fixed by Task 3), so "a second read asks nothing" could not hold in Task 2.
- **Fix:** the Task 2 rig resolver binds both sites; the one-site resolver is used from Task 3 on.
- **Commit:** `9af69f8`

**3. [Environment, Rule 3] Worktree needed a node_modules link and a CodeGraph index**
- The worktree has no `node_modules`: the main checkout's was symlinked in and removed before returning. The repo's read guard denies plain `Read` of indexed `.ts` files until a `codegraph node` span for the worktree's own index precedes it, so `codegraph init -y` was run in the worktree; the generated `.codegraph/` directory was removed before returning. Neither is tracked.

**Total deviations:** 1 bug found and fixed in my own change before commit, 1 test-design note, 1 environment note. **Impact:** none on scope; no file outside the plan's list was touched except that `src/fact-store/index.ts` (listed in the plan) needed no change, and `scripts/` and `docs/` (the Stage A freeze set) are byte-identical to the base.

## Interpretations worth a second look

- The plan says a timeout "writes no asked rows (the sites will be asked again)". I read that as: while the call is pending, and for a call that failed. A background run that finishes after the timeout is a completed call, so it fills edges (the existing, tested behavior) and now also the markers. The test pins both halves (0 rows at the timeout, 2 asked rows and 1 edge row after the gate opens).
- `ProjectContext` has no `emit` field yet (declared by plan 03-22), so `ResolveScope.project` is `{context}` for now.
- The shared contract-suite helper `scripted()` in `src/fact-store/contract.ts` still builds its own fake overlay for `inner.resolve` instead of using `asStoreResolver`; it was left alone so the Phase 2 cases stay untouched. The new cases use the adapter.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None. The RED scaffolds (`findIn` returning `[]`, an adapter yielding nothing) were replaced in the GREEN commits; no TODO, FIXME or placeholder remains in `src/fact-store`, `src/facts` or `src/precise-resolver`.

## Threat Flags

None. `resolved_asked` is derived cache data planned in the threat model; T-03-201 to T-03-204 are mitigated as planned (unchanged `validate`, per-snapshot context with one retry and no caching on a lost race, bounded resolver call, `findIn` reading only the overlay's own file).

## Verification

- `npm run typecheck`: clean
- `npm run lint`: clean
- `npm run build`: clean
- `npm test`: 3426 tests, 3425 pass, 0 fail, 1 skipped (pre-existing)
- `node scripts/eval/verify-prereg.ts`: `verify-prereg: ok`; `git diff` of `scripts/` and `docs/eval/` against the base is empty
- Boundary test `MODULES.length` stays 22: no module was added
- `SCHEMA_VERSION = 1` in `src/fact-store/schema.ts` (acceptance criterion: count 1)

## Next Phase Readiness

Plan 03-22 can supply `projectContext` and add `emit` to `ProjectContext`; adapters (03-23 onward) implement `PreciseResolver.resolve(overlay, context, sites, symbols)` and are wired with `asStoreResolver`. REQUIREMENTS.md, STATE.md and ROADMAP.md were not touched (TSM-01 is shared with later plans; the orchestrator owns tracking).

## Self-Check: PASSED

- `src/precise-resolver/store-adapter.ts` and the 16 modified files exist on disk; `.codegraph/` and the `node_modules` link are removed.
- Commits `3b4e76c`, `ab550e4`, `9af69f8`, `324250d`, `ab81ded`, `44b08d7` are ancestors of HEAD; `git rev-list --count a4a757a..HEAD` was 6 before this SUMMARY commit.
