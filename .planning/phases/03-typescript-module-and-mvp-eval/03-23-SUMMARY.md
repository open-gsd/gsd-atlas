---
phase: 03-typescript-module-and-mvp-eval
plan: 23
subsystem: precise-resolver-typescript
tags: [precise-tier, typescript-worker, command-runner-shape, identity-mapping, degraded-codes, providers-switch, tracer, mcp-e2e]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-18 ProjectModel (owners, compiler choice); 03-19 exact-shape compiler worker built-in, async stdin queue and minimal environment; 03-20 resolver seam (scope, findIn, per-overlay context, negative marker); 03-22 project context provider and emit lookup; 03-16 frozen Stage A (D-08 precondition, verify-prereg ok)"
provides:
  - "src/precise-resolver/typescript: protocol (zod, newline-delimited JSON), positions (grammar-tier line model), worker (createProgram per owner config), client (createTypeScriptResolver), identity (mapTarget, Stats), compiler (bundledCompilerDir, compilerForRequest, fixed fallback texts), tier (createTypeScriptTier, PreciseTier), worker-url"
  - "kernel: PreciseFacts and CompilerFacts on ProjectContext, ProjectContext.degraded, ResolverNotice, ResolverFailure, degradedCodeOf, NoticingResolverPort (facts/resolution.ts)"
  - "fact-store resolveSites: notices become degraded codes once per read, a typed failure answers with its own code, and the tier state (compiler_fallback, precise_unavailable) is derived from the project facts so the cache never hides it"
  - "src/host/tiers.ts BUILTIN_TIERS and createTier; Host options knownAdapters, precise (tuning), tierHook, resolverFactory; Tenant deps tiers, knownAdapters, resolverFactory"
  - "registry options knownAdapters and disabledAdapters (active, unknown precise adapter, provider_disabled); atlas_status and lang_list use them"
  - "modules/typescript names tiers grammar and precise and precise.adapter typescript; composeHost builds the runner with the compilerWorkerShape and knownAdapters ['typescript']"
  - "scripts/precise-gate.ts --trace --corpus gsd-core --dir <prepared checkout> [--config tsconfig.json]"
affects: [03-24, 03-25, 03-27, 03-29, 03-30, 03-31]
tech-stack:
  added: []
  patterns:
    - "The host never loads a compiler: the project's compiler location is data in the first stdin message; the worker is the only file that loads it"
    - "A fallback is a state, not an event: tier-state codes are derived from the project facts on every read, so a cached answer says what a fresh one would"
    - "Worker output is untrusted: schema-validated, size-capped, at most one edge per site asked, target paths checked, every target mapped to exactly one grammar symbol or dropped and counted"
key-files:
  created:
    - src/precise-resolver/typescript/protocol.ts
    - src/precise-resolver/typescript/protocol.test.ts
    - src/precise-resolver/typescript/positions.ts
    - src/precise-resolver/typescript/positions.test.ts
    - src/precise-resolver/typescript/worker.ts
    - src/precise-resolver/typescript/worker-url.ts
    - src/precise-resolver/typescript/client.ts
    - src/precise-resolver/typescript/identity.ts
    - src/precise-resolver/typescript/compiler.ts
    - src/precise-resolver/typescript/tier.ts
    - src/precise-resolver/typescript/index.ts
    - src/precise-resolver/typescript/resolver.test.ts
    - src/host/tiers.ts
    - scripts/precise-gate.ts
    - scripts/precise-e2e.test.ts
  modified:
    - src/precise-resolver/index.ts
    - src/facts/resolution.ts
    - src/facts/index.ts
    - src/fact-store/resolve.ts
    - src/fact-store/types.ts
    - src/fact-store/resolve.test.ts
    - src/host/host.ts
    - src/host/types.ts
    - src/host/index.ts
    - src/host/lang.ts
    - src/tenant/create.ts
    - src/tenant/types.ts
    - src/tenant/project.ts
    - src/tenant/project.test.ts
    - src/tenant/status-port.ts
    - src/lang/registry.ts
    - src/lang/registry.test.ts
    - src/bin/compose.ts
    - src/bin/compose.test.ts
    - modules/typescript/atlas-lang.json
key-decisions:
  - "Tier-state codes are derived in the store from ProjectContext (PreciseFacts.requiresOwner/ownerOf, compiler.source, ProjectContext.degraded), not only yielded as notices. A notice from a run is lost when the first read times out or the next read is served from the cache, which would hide a fallback; the plan's own prohibition (every fallback is a degraded code) needs the derived form. The notice channel is implemented as planned and used for the events of a run."
  - "The store accepts NoticingResolverPort (edges and notices); ResolverPort keeps its edge-only type so every existing resolver and test compiles unchanged. fact-store Resolver is the wider type."
  - "The tier reaches the Tenant through TenantDeps.tiers, a function the Host builds from its own table (src/host/tiers.ts) and runner. The tenant does not import host (host already imports tenant). The manifest id only picks from the table; an id the composition root does not list starts nothing."
  - "A repository with no tsconfig keeps the Phase 2 cache key and emit lookup (default context) and gains only PreciseFacts with no owner, so a TypeScript file in it is answered precise_unavailable on every read while a JavaScript file adds nothing."
  - "While the provider is switched off the context provider is wrapped: the context id gains '+typescript:off' (a 'nothing found' recorded while it was off is not believed after it is on) and ProjectContext.degraded carries precise_unavailable."
  - "Edges are yielded in request order after the worker answered the whole call, not streamed, so the order is deterministic (contract suite) and an abandoned iteration never leaves a request in flight. Kill-on-early-break is therefore never needed; the finally block still runs the cleanup hook exactly once."
  - "Identity: the innermost grammar symbol (tightest span) that contains the declaration's name token wins; two equally tight symbols are ambiguous and drop the declaration. Counts are per compiler declaration kind: asked, edges, dropped."
  - "Fixed-text diagnostics are added to an answer by the Tenant from the tier (explain) and carry severity info for compiler_fallback and precise_unavailable (states; the CLI prints only warnings and errors on stderr) and warning for memory_budget and resolver_failed."
  - "The worker's heap flag defaults to 25 percent of memory times 0.8 (03-CONSTANTS precise.memoryBudgetPercent and heapShareOfBudget) and at least 256 MB; the sampler, minBudgetMb and LRU are plan 03-27."
requirements-completed: [TSM-02, SEC-02]
status: complete
commits: 6
plan_head_before: 88bc167a5dc90bdd94dd5cc21690c4936b4e931c
plan_head_after: a243c5234d42bb66b4b57b745fa857e7944be6f8
actuals:
  tokens: 46300
  tasks: 3
  commits: 6
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 23: TypeScript precise tier tracer Summary

**A real TypeScript worker, started through the CommandRunner's exact built-in shape, turns a project's references into cached `EXTRACTED` edges that `code_refs` returns over the real stdio MCP server, with every compiler fallback, memory stop and missing tier flagged as a degraded code, switchable off by the user and verified on the pinned gsd-core.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 | Tracer: a real worker resolves a fixture project's references and the store returns them as EXTRACTED precise records | 352aafb | 74f317b |
| 2 | Compiler selection, typed failures and notices, memory-abort mapping, tier wiring, providers off, manifest | 0432714 | 8e8b981 |
| 3 | Real MCP end-to-end, the gsd-core trace on one tsconfig, identity coverage numbers | bca6712 | a243c52 |

## What was built

- **Worker** (`worker.ts`): reads protocol-validated lines on stdin; on `init` loads the compiler with `createRequire` from the directory the parent sent (the project's own TypeScript only when the parent chose it and it loads, otherwise the bundled 6.0.3); one `ts.Program` per owner config created lazily with `ts.createProgram`; each site is converted with `positions.ts` (LF-only rows, UTF-16 columns, BOM stripped, U+2028 not a line break) and resolved only when the identifier at the offset has the site's name; aliases are followed inside a guard; declarations in libraries, `node_modules` or outside the worktree are skipped; exits when stdin ends. No language service, tsserver or plugin loader (a test strips comments and checks the source).
- **Client** (`client.ts`): one worker per worktree, started lazily with `{executable: node, args: [--max-old-space-size=N, worker], builtinId: typescript-resolver, env: {GSD_ATLAS_WORKER: 1}, stdin: async queue}`; requests grouped by owner config in batches of `precise.sitesPerRequest`; response lines size-capped and validated; typed exits (`memory_budget` for a heap abort found by exit code, signal or stderr text; `resolver_failed` otherwise); the next call starts a fresh worker. A worker that sends more edges than sites asked, a malformed line, nothing at all, or a path outside the repository is stopped or ignored (tests with a scripted fake worker).
- **Identity** (`identity.ts`): `mapTarget` maps a declaration's name token to the one innermost grammar symbol whose span contains it, through the store's `findIn`.
- **Tier wiring**: `createTypeScriptTier` returns the store port, status, fixed-text `explain` and `close`; `src/host/tiers.ts` is the Host's table; `Tenant` builds the tier from the module manifest's `precise.adapter`, adds the tier's diagnostics to an answer that carries one of its codes, and closes the worker with the tenant. `providers.disabled: [typescript]` starts nothing and answers `precise_unavailable` with "the typescript provider is turned off in the user configuration".
- **Store**: `resolveSites` separates notices from edges (each code once per read), answers a typed failure with its own code, and derives the tier state from `ProjectContext` on every read.
- **Gate script**: `scripts/precise-gate.ts --trace` composes the real Host, builds the checkout, asks for `compareSemverCore` until a precise record exists and prints one JSON object.

## gsd-core trace (pinned `10ac3a7`, prepared per OQ8, macOS arm64, Node 26.11.1)

`node scripts/precise-gate.ts --trace --corpus gsd-core --dir <prepared checkout> --config tsconfig.json`, exit 0:

```json
{"corpus":"gsd-core","symbol":"compareSemverCore","file":"src/semver-compare.cts","config":"tsconfig.json","ownerConfig":"tsconfig.json","compiler":{"source":"project","version":"6.0.3"},"buildMs":6005,"firstPreciseMs":665,"reads":1,"degraded":[],"refs":{"total":11,"EXTRACTED":1,"INFERRED":10},"rssMb":92.8,"rssMbSampled":403.4,"stats":{"sites":{"asked":4,"answered":4},"edges":1,"dropped":{"PropertySignature":3},"byKind":{"PropertySignature":{"asked":3,"edges":0,"dropped":3},"FunctionDeclaration":{"asked":1,"edges":1,"dropped":0}}},"identity":{"asked":4,"edges":1,"ratio":0.25,"byKind":{"PropertySignature":0,"FunctionDeclaration":1}},"limits":{"firstPreciseMs":30000,"rssMb":1024},"withinLimits":true,"ok":true}
```

The project's own TypeScript 6.0.3 was used (no `compiler_fallback`); the first answer with a precise record came after 665 ms (limit 30 s); the worker's resident memory was 403 MB sampled after the program was built (92.8 MB at `ready`; limit 1 GB). Only the 4 reference sites inside the tsconfig's file set were asked: the 10 `.cjs` call sites are outside every config, so they stay `INFERRED` by design.

### Identity coverage on gsd-core

A one-off measurement (a scratch script, not committed) asked `code_refs` for all 1,238 exported names of `src/**/*.cts` through the same Host and read `tier.stats()`: 5,495 reference rows, 3,154 of them precise, 4,437 sites asked and answered, 98.1 seconds with one warm worker.

| Declaration kind | Asked | Edges | Dropped | Ratio |
|------------------|-------|-------|---------|-------|
| FunctionDeclaration | 2,133 | 2,133 | 0 | 100% |
| InterfaceDeclaration | 850 | 850 | 0 | 100% |
| TypeAliasDeclaration | 726 | 726 | 0 | 100% |
| VariableDeclaration | 648 | 648 | 0 | 100% |
| ClassDeclaration | 71 | 71 | 0 | 100% |
| PropertySignature | 31 | 5 | 26 | 16.1% |
| BindingElement | 26 | 0 | 26 | 0% |
| MethodSignature | 1 | 0 | 1 | 0% |
| **All** | **4,486** | **4,433** | **53** | **98.8%** |

Research baseline: 100% for function declarations (matched) and about 70% overall for project-internal declarations; this run starts from exported names, so the sites are references to exported declarations and the overall ratio is higher. The drops are the declarations the grammar tier has no symbol for (interface property and method signatures, destructured bindings), counted under their kind.

## Verification

`npm run typecheck`, `npm run lint`, `npm run build`, `npm run schema:check` clean. `npm test`: 3,850 tests, 3,848 pass, 0 fail, 2 skipped (both pre-existing, `npm ci --ignore-scripts installs the project TypeScript 6.x` and the literal reading of OQ3), including the SEC-01 hostile-repository test. `node scripts/eval/verify-prereg.ts`: ok (no Stage A file touched). About 89 new test cases: positions 7, protocol 10, resolver 42, store notices 16 (two drivers), registry 3, compose 3, project 1, end-to-end and trace 7. The built worker (`dist/.../worker.js`) was run directly and answers the same as the source worker.

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] Tier state is derived, not only yielded as notices**
- **Found during:** Task 2 design (the prohibition "MUST NOT hide a fallback")
- **Issue:** A notice yielded by a run is lost when the first read times out (the background run's notices have no caller) and on every read served from the cache, so a compiler fallback or a missing config would disappear from the second answer.
- **Fix:** `PreciseFacts.requiresOwner`, `ProjectContext.degraded` and a derivation in `resolveSites` (`compiler_fallback` while precise edges are used under the bundled compiler, `precise_unavailable` for a site that needs a config and has none). The notice channel is implemented as planned and is used for events.
- **Files:** src/facts/resolution.ts, src/fact-store/resolve.ts, src/tenant/project.ts, src/precise-resolver/typescript/client.ts. **Commits:** 74f317b, 8e8b981

**2. [Rule 3 - Blocking] `NoticingResolverPort` instead of widening `ResolverPort`**
- Widening the return type of `ResolverPort` made `facts.test.ts` fail to compile; a second type for the store (`Resolver = NoticingResolverPort`) keeps every existing resolver and test unchanged. **Commit:** 74f317b

**3. [Plan-list difference] The tenant gets the tier from the Host**
- `tenant/create.ts` cannot import `host/tiers.ts` (the Host imports the tenant). The Host builds the tier table closure and passes `TenantDeps.tiers`; `src/host/tiers.ts` is the table. Files touched outside `files_modified`: `src/facts/index.ts` (exports), `src/host/index.ts`, `src/host/lang.ts`, `src/tenant/status-port.ts` (known adapters for `lang_list` and `atlas_status`), `src/tenant/project.test.ts` (see 4), `src/bin/compose.test.ts`, `src/fact-store/resolve.test.ts`.

**4. [Rule 1] Existing test adapted: no-tsconfig context**
- `src/tenant/project.test.ts` asserted that a repository with no tsconfig gets exactly `DEFAULT_PROJECT_CONTEXT`. It still gets the Phase 2 cache key and no emit lookup; the added `precise` facts (no owner) make a configless TypeScript file answer `precise_unavailable`. The assertion now compares `context`, `emit` and the facts separately. **Commit:** 8e8b981

**5. [Rule 1] Diagnostic severity**
- `compiler_fallback` and `precise_unavailable` diagnostics are `info`: with `warning` the CLI printed them on stderr for every configless repository and `scripts/cli-e2e.test.ts` (stderr must be empty) failed. They remain in the envelope. **Commit:** 8e8b981

**6. [Rule 2] Untrusted worker hardening beyond the plan list**
- At most one edge per site asked per request, a repository-path check on every target before the store is asked, and tests with a scripted fake worker (flood, garbage line, silence, escaping path). **Commit:** a243c52

**7. [Process] Test-first order inside the plan**
- Each task has a RED commit (tests only, run against the previous commit and failing: 3 of 3 files in Task 1, 26 cases in Task 2) before its GREEN commit. Because the first GREEN commit already contained the client that yields notices, the store-side handling of notices, typed failures and tier state was left out of it (a stub that discards notices) and added with its own failing tests in Task 2. The Task 3 RED commit contains end-to-end cases that already passed (the behavior existed) plus the trace-script cases that failed until the script existed.

**8. [Detail] Protocol and other small additions**
- `ready` carries an optional `pid` (observation only; the parent never signals by it). The tracer's `maintain resolve` note says the tier resolves on demand while it is active (eager resolution is plan 03-29). The trace prints `rssMb` from `ready` as planned and also `rssMbSampled` (a `ps` sample after the program was built), because the `ready` value is taken before the compiler builds anything.

## Known Stubs

None. The worker heap default and the absence of an RSS sampler, idle exit and LRU are the scope of plans 03-27 and 03-29, not stubs.

## Threat Flags

None beyond the plan's register. The new process surface is exactly the one T-03-231 to T-03-235 describe. Evidence: the worker's environment is printed by a project compiler stand-in and holds no secret-looking name, no `NODE_OPTIONS`, no `PATH` and `GSD_ATLAS_WORKER=1` (T-03-231); a 7.x or unknown-layout project compiler is never loaded (marker file absent) and a tsconfig plugin is never loaded (T-03-231); worker output is validated, capped and mapped to exactly one grammar symbol, with fake-worker tests (T-03-232); heap abort, kill and silence map to `memory_budget` or `resolver_failed`, and the next read restarts the worker (T-03-233); every fallback diagnostic is fixed text (T-03-234); a manifest naming an unknown adapter starts nothing, and `providers.disabled` starts nothing (T-03-235). The residual risk of a hostile project TypeScript 6.x is the one ADR 4 and D-13 accept.

## Self-Check: PASSED

- Files present: all fifteen created files and the twenty modified files listed in the frontmatter exist in the worktree.
- Commits 352aafb, 74f317b, 0432714, 8e8b981, bca6712 and a243c52 are ancestors of HEAD.

## Follow-up fix 2026-10-18

**Defect (found by plan 03-31's full-population audit, 1 edge of 15,273).** `lockMod.withLedgerLock(cwd, fn)` at `src/refactor-trigger-command-router.cts:436` of gsd-core `10ac3a7` was stored as a precise, EXTRACTED reference to the module-local function `withLedgerLock`. The compiler resolves that member to the property signature of an inline type declared inside the function (line 419). Cause: `mapTarget` (the "innermost grammar symbol whose span contains the name token" rule recorded under Identity above) accepted any same-named symbol that merely held the token. The class is wider than the one edge: a parameter, a shorthand member, an object literal method, an enum member or a member of an inline type, each named like the function, class method or property that holds it, was stored as a reference to the holder.

**Fix (commits 56f44e3 RED, 267253d GREEN).** A grammar symbol now maps only when it IS the declaration the compiler resolved: (1) its kind is one the grammar tier records for the compiler declaration kind (a table in `src/precise-resolver/typescript/identity.ts`; a parameter, binding element, enum member, object literal member or expando assignment has no symbol and gives no edge); (2) it starts no earlier than the declaration node (a symbol that begins before the declaration is wider than it); (3) it ends on the declaration's last row within one column of its end (the `;` or `,` one tier counts and the other does not). To make this possible the worker now sends the declaration node's extent with each target (`startRow`, `startCol`, `endRow`, `endCol`, required in the protocol); the same function builds the ends of the relations of plan 03-25. No store, schema or reader file changed (`SCHEMA_VERSION` 2, 23 modules, Stage A untouched, `verify-prereg` ok). Existing tests whose scripted lookup claimed one symbol over the whole file now use the extent the grammar tier stores, since a symbol that is not the declaration no longer maps.

**Tests.** `src/precise-resolver/typescript/identity.test.ts`: 11 mapping cases (the inline-type property, a method signature, parameter, binding element, shorthand and object members, enum member, same-kind nesting, a nesting that ends one column short of its container, wrong kind; and the positives: exact extent, `export` wrapper, trailing separator, a recorded member inside a symbol of the same name, shadowing inner function, overloads, merged interfaces, every recorded kind pair) and 7 end-to-end cases over the real worker and grammar tier, one of them the shape of `src/refactor-trigger-command-router.cts` lines 417 to 437. The RED run failed 11 of 18 and the controls (overloads, merged interfaces, class members, a shadowing function, a property signature call) stayed green.

**Population on the pinned gsd-core `10ac3a7`** (prepared checkout, project TypeScript 6.0.3, `node scripts/precise-gate.ts --trace --corpus gsd-core --dir <prepared>`; the build's eager pass asks the compiler about every site): declarations asked 15,769 both times; edges 15,273 before, 15,272 after; ratio 0.9685 both (15,272/15,769 = 0.9685). By kind: FunctionDeclaration, InterfaceDeclaration, TypeAliasDeclaration, ModuleDeclaration, ClassDeclaration and MethodDeclaration 100% before and after; VariableDeclaration 0.9405 and MethodSignature 0.9234 unchanged; PropertySignature 0.5315 to 0.5270 (the one dropped declaration); Parameter, BindingElement, ShorthandPropertyAssignment and PropertyAssignment 0 as before. The 98.8% / 100%-FunctionDeclaration figures above are the plan's one-off measurement over exported names (4,486 declarations); this fix changes no function, interface, type alias, variable or class declaration, so FunctionDeclaration stays at 100%. With a temporary trace of every mapping, the set of 5,816 distinct mapped targets lost exactly one member, the property signature at `src/refactor-trigger-command-router.cts:419`, and no target changed identity or was added. No previously correct edge was dropped.

**The real edge.** After the fix `code_refs` for `withLedgerLock` in that file returns the two real calls (lines 462 and 521) as `precise` EXTRACTED and line 436 column 18 as `grammar` INFERRED: the grammar tier still lists the name, the compiler's answer (the inline type's property) has no symbol, so nothing is claimed.

**Other checks on the same checkout.** `node scripts/relations-check.ts --dir <prepared>`: 22 agree, 0 store-only, 0 oracle-only, OK (as before). `node scripts/precise-gate.ts --update`: ok, edit to precise answer 323 ms. `--nobreak` exits 1 (`unexplained`, one package, refs listed by the grammar tier only) identically before and after the fix, so it is not caused by it. `npm run typecheck`, `npm run lint`, `npm run build`, `npm run schema:check` clean; `npm test`: 4,190 tests, 4,188 pass, 0 fail, 2 skipped (both pre-existing), against 4,172 on the base commit (18 new, all in `identity.test.ts`), which includes `scripts/emit-e2e.test.ts` and `scripts/relations-check.test.ts`; no flake.

**Known limit, by design.** A declaration the grammar tier cannot name now never maps, even when its enclosing symbol is a fair stand-in: `const f = function f() { return f; }` resolves the inner `f` to the function expression, which has no symbol, so that reference stays `grammar` INFERRED instead of pointing at `f`. None occurs in the 15,769 declarations of gsd-core.

**For 03-35's pre-run audit.** Plans that read edges stored before this commit (including the population and the notes of `docs/eval/edge-sample.md` of plan 03-31, which record the wrong edge) must be re-run from a fresh build of atlas at or after 267253d: the edge at `src/refactor-trigger-command-router.cts:436` is no longer stored, so the population is 15,272 reference edges and the 03-31 audit of all facts should no longer flag it. The sampler needs no change.
