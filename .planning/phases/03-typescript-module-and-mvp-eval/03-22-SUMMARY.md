---
phase: 03-typescript-module-and-mvp-eval
plan: 22
subsystem: project-model-emit
tags: [emit-map, specifier-rule, project-context-provider, output-filter, emittedAs, differential-test, cts-cjs]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-18 compiler-free ProjectModel (describe, matches, configs, context); 03-20 ProjectContextProvider seam on the store (ProjectContext carried only `context`, `emit` left for this plan); 03-08 ADR 6 and ADR 7 amendments; 03-16 frozen Stage A (D-08 precondition)"
provides:
  - "EmitLookup (outputToSource, sourceToOutputs, isOutput) and ProjectContext.emit in the facts kernel"
  - "src/project-model/emit.ts buildEmitMap and ProjectDescription.emit / configFiles / configProbe, createProjectModel(id)"
  - "resolveSpecifier(importer, specifier, files, emit?): an emit output of an included source names that source (EXTRACTED when alone, INFERRED beside a tracked file at the output path)"
  - "Reader.emittedAs(path); importers, refs and callers read the emit lookup of the snapshot's project context"
  - "src/tenant/project.ts createProjectContextProvider (memoised per worktree), createOutputFilter, modelIdsByExtension, createTenantProjectProvider; modules/typescript declares project.model"
  - "IndexerDeps.outputFilter: Reconcile, build, event and fresh paths keep emit outputs out of the overlay (OQ3, default reading)"
  - "code_context data.file.emittedAs"
  - "scripts/project-model-differential.ts --emit"
affects: [03-23, 03-24, 03-27, 03-29, 03-30, 03-31]
tech-stack:
  added: []
  patterns:
    - "Lookup, not a file hash: the emit map is a pure function of configs, overlay paths and matches, exposed through one kernel interface that the specifier rule, the Indexer filter and emittedAs all share"
    - "Fail open: a project that cannot be described drops nothing and links nothing extra"
    - "Memoise by what was read: a description is reused while the path set and the text of every config it read are unchanged, so an edit of a source file costs one small read per config and no describe"
key-files:
  created:
    - src/project-model/emit.ts
    - src/project-model/emit.test.ts
    - src/tenant/project.ts
    - src/tenant/project.test.ts
    - src/fact-store/specifier.test.ts
    - scripts/emit-e2e.test.ts
  modified:
    - src/facts/resolution.ts
    - src/facts/index.ts
    - src/project-model/types.ts
    - src/project-model/tsconfig.ts
    - src/project-model/typescript.ts
    - src/project-model/index.ts
    - src/fact-store/specifier.ts
    - src/fact-store/snapshot.ts
    - src/fact-store/parts.ts
    - src/fact-store/resolve.ts
    - src/fact-store/reader.ts
    - src/fact-store/types.ts
    - src/fact-store/resolve.test.ts
    - src/fact-store/fact-store.test.ts
    - src/indexer/types.ts
    - src/indexer/index.ts
    - src/indexer/indexer.ts
    - src/indexer/process.ts
    - src/indexer/reconcile.ts
    - src/indexer/indexer.test.ts
    - src/tenant/create.ts
    - src/tenant/follower-overlay.ts
    - src/query/context.ts
    - src/query/context.test.ts
    - src/query/harness.test.ts
    - src/query/fresh.test.ts
    - modules/typescript/atlas-lang.json
    - scripts/project-model-differential.ts
    - scripts/project-model-differential.test.ts
    - docs/reference/cli.md
    - docs/reference/mcp.md
key-decisions:
  - "TypeScript 6 roots the output tree at the config's directory when rootDir is unset (measured against 6.0.3 with ts.getOutputFileNames); the plan's 'common source directory' is the TypeScript 5 rule. The model follows the compiler, as the plan's differential requires."
  - "ts.getOutputFileNames ignores noEmit. gsd-core's tsconfig.build.json (the emitting config) is referenced by nothing, so directory discovery finds only tsconfig.json, which is noEmit and extends it. A noEmit config therefore places outputs by its (inherited) outDir; a noEmit config with no outDir maps nothing."
  - "Output arithmetic ignores source maps and build info; sourceToOutputs is in code-unit order and outputsOf lists code before declarations."
  - "An output that is also a source of some config (overlap) stays a source: isOutput false, outputToSource undefined, sourceToOutputs unchanged, diagnostic emit_overlaps_source. Ambiguity: isOutput true, outputToSource undefined, diagnostic emit_ambiguous naming up to four sources."
  - "The provider re-describes when the overlay path set changes or the text of a config file it read changes; a config that appears or goes away is noticed at the next exclude (Reconcile or build), which also probes for new configs, not at store-read time."
  - "The Indexer asks the filter once per run over the whole source set; the event and fresh paths ask isOutput synchronously from the memo the last exclude or store read built, and treat an output like an unclaimed path (leaves the overlay only if it held it)."
  - "code_context adds data.file only when emittedAs is non-empty, so every Phase 2 answer is byte-identical."
requirements-completed: [TSM-03]
status: complete
commits: 6
plan_head_before: c2af17d03fb4b9c104b815fe1229916f6d36b6b2
plan_head_after: 7977f364613f7b53a9845146e2831ef57d02d9f4
actuals:
  tokens: 39500
  tasks: 3
  commits: 6
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 22: Emit mapping from compiled output to source Summary

**A `.cjs` file that requires a built module is now a user of the `.cts` source it was compiled from, the build output itself never enters the index, and `code_context` says what a source compiles to; on the pinned gsd-core the references to `compareSemverCore` rise from 4 to 11.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 | Tracer: a .cjs requirer of the built output is a user of the .cts function | 7f0bd37 | 287ddb5 |
| 2 | Complete emit rules, ambiguity, inherited directories, compiler differential | 453022a | c3c2c1f |
| 3 | Outputs get no facts, hand-written files keep theirs, emittedAs, end to end | ccd3b5d | 7977f36 |

Tracer feedback gate (interactive, `human_verify_mode` end-of-phase, automated-only verify, no `gate="blocking-human"`): the Task 1 verify command (157 tests across the end-to-end, emit, specifier and tenant files, typecheck, lint, `schema:check`) was re-run green before Task 2 started.

## What was built

- **Kernel and project model.** `EmitLookup` and `ProjectContext.emit`. `buildEmitMap(configs, overlayPaths, matches)` restates `ts.getOutputFileNames` over repo-relative POSIX paths: the extension map (`.ts`/`.tsx`/`.js`/`.jsx`, `.cts`/`.cjs`, `.mts`/`.mjs`, `jsx: preserve`), `rootDir`/`outDir`/`declarationDir`, declaration outputs (`declaration`, `composite`, `emitDeclarationOnly`), declaration files that never emit, `allowJs` inputs, `outFile` (no per-file output). `ConfigInfo` gained `noEmit`, `declaration`, `emitDeclarationOnly`, `outFile` and `emitEscapes`; `ProjectDescription` gained a lazily built `emit`, the `configFiles` it read (path to normalised hash) and the `configProbe` (candidates probed and found).
- **Specifier rule and store.** `resolveSpecifier` consults `emit.outputToSource` and offers only a source the overlay holds. `Snapshot.emit` is threaded from the project context of the snapshot a read sees (`readResolving` for refs and callers, `emitLookupFor` for importers and `emittedAs`); a store with no provider takes the old synchronous path and never reads the context.
- **Tenant.** `createTenantProjectProvider` reads `project.model` from the winning manifest of each module (so a user copy without the block wins and removes the model), builds a memoised provider, passes it to the store and its filter to the Indexer. No manifest names a model: no provider, Phase 2 as it was.
- **Indexer.** `OutputFilter` on `IndexerDeps`. Reconcile/build take the source set, ask `exclude` once under the `indexing` job, drop the answer from the truth before `store.reconcile`, and leave an aggregated `emit_output_not_indexed` note (a count, never a path). `prepare` treats an `isOutput` path as unclaimed.
- **Query.** `code_context` reads `reader.emittedAs` for the defining file and adds `data.file = { path, emittedAs }` when non-empty; the follower overlay reader delegates `emittedAs` to its base reader.
- **Differential.** `scripts/project-model-differential.ts --emit` compares the model with `ts.getOutputFileNames` over every config and reports, per output directory, how many tracked files are not outputs.

## Measured on the pinned corpora (macOS arm64, `10ac3a7` and `bb86b6c`)

| Check | Result |
|-------|--------|
| `--emit` gsd-core | 274 sources compared (268 with an output, 6 declaration files), 0 disagreements, 0 crashes |
| `--emit` gsd-core, output directory | `gsd-core/bin/lib`: 17 tracked, 0 outputs, 17 not an output (they keep their facts) |
| `--emit` gsd-pi (information) | 3,026 sources, 0 disagreements, 0 crashes; 14 output directories, none tracked |
| `refs compareSemverCore --path src/semver-compare.cts` | before (control, no project model): 4 references in 3 files; after: 11 references in 5 files, adding `scripts/changeset/cli.cjs` and `tests/semver-compare.test.cjs` |
| `impact compareSemverCore` | the `.cjs` requirers `gsd-core/bin/lib/capability-command-router.cjs`, `hooks/gsd-check-update-worker.js`, `hooks/gsd-statusline.js`, `scripts/changeset/cli.cjs` appear as EXTRACTED importers (results are cut by the default budget) |
| `context compareSemverCore` | `data.file = { path: "src/semver-compare.cts", emittedAs: ["gsd-core/bin/lib/semver-compare.cjs"] }` |
| indexed files | 1,689 with and without the project model (gsd-core tracks no build output) |
| `build` wall time | 5.7 s with, 6.2 s without (one run each, not a gate measurement) |

## Verification

`npm run typecheck`, `npm run lint`, `npm run build`, `npm run schema:check` clean. `npm test`: 3,761 tests, 3,759 pass, 0 fail, 2 skipped (the pre-existing skip and the OQ3 literal-reading case, skipped with its stated reason). `node scripts/eval/verify-prereg.ts`: `verify-prereg: ok`; `git diff` of the base against HEAD touches nothing under `scripts/eval` or `docs/eval`. New or extended: `emit.test.ts` 21, `specifier.test.ts` 5, `project.test.ts` (tenant) 15 plus one skipped, `resolve.test.ts` +10 (five cases on both drivers), `indexer.test.ts` +8, `context.test.ts` +2, `emit-e2e.test.ts` 6 (real CLI and stdio MCP bins), `project-model-differential.test.ts` +3.

## TDD Gate Compliance

Plan type is `execute` with `tdd="true"` tasks and `tdd_mode` on, so each task has a `test(03-22)` commit before its `feat(03-22)` commit. Each RED commit carries compile-only scaffolding (types, a `buildEmitMap` that maps nothing, a provider that answers the grammar context, `Reader.emittedAs` returning `[]`, an Indexer that ignores the filter) so the tests fail on their planned assertions, not on a missing export. Semantic RED assessment: Task 1 had 18 of 25 unit cases and 2 of 3 end-to-end cases failing on assertions; Task 2 had 11 of 29 failing (the new table, escape, ambiguity and `--emit` cases; ts-to-js, cts, mts, default rootDir and the inherited cases already held on the tracer subset); Task 3 had 9 of 55 failing (the filter, watcher, reconcile, fresh, `emittedAs` and tracked-output cases). The shell has no `gsd_run`, so the formal `tdd-red-evidence` check was not run; the failing counts above are from the `node --test` output of each RED commit. No REFACTOR commit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug in the plan's premise] Default `rootDir` is the config directory, not the common source directory**
- **Found during:** Task 1 (a probe of `ts.getOutputFileNames` on 6.0.3 with sources in `src/a` and `src/b`)
- **Issue:** the plan's behavior section says an unset `rootDir` uses the common source directory of the inputs (`src` for two directories, `src/a` for one). That is the TypeScript 5 rule; 6.0.3 (the bundled compiler, and what 03-18 pinned) roots at the config's directory, so `src/a/x.ts` with `outDir: out` gives `out/src/a/x.js`.
- **Fix:** the model follows the compiler (the plan's differential is the requirement); the `default rootDir` case checks both shapes against the compiler.
- **Files modified:** src/project-model/emit.ts, src/project-model/emit.test.ts
- **Commit:** 287ddb5, c3c2c1f

**2. [Rule 1/2] A noEmit typecheck config that extends the build config is the only way gsd-core's outDir is found**
- **Found during:** Task 1 (the gsd-core pair as a fixture)
- **Issue:** directory discovery finds `tsconfig.json` and `jsconfig.json` only; gsd-core's emitting config `tsconfig.build.json` is referenced by nothing, and `tsconfig.json` is `noEmit` and extends it. Skipping `noEmit` configs would map nothing on the primary corpus, while `ts.getOutputFileNames` ignores `noEmit`.
- **Fix:** a `noEmit` config places outputs by its (inherited) `outDir`; a `noEmit` config with no `outDir` maps nothing (it never writes the `.js` beside its sources). The `--emit` script mirrors that rule.
- **Files modified:** src/project-model/emit.ts, scripts/project-model-differential.ts
- **Commit:** 287ddb5, c3c2c1f

**3. [Rule 1] Wildcard includes cannot produce the plan's `.ts`/`.tsx` same-stem ambiguity**
- **Found during:** Task 2 RED
- **Issue:** a wildcard include keeps only the higher-priority `a.ts`, so `a.ts` and `a.tsx` never reach the same output that way.
- **Fix:** the `ambiguous output` case names both as literal `files`; a second case uses two configs emitting to one directory.
- **Commit:** c3c2c1f

**4. [Rule 2] T-03-223 needed an escape flag, because the path helper drops `..` above the root**
- **Issue:** `resolveRepoPath('', '../elsewhere')` returns `elsewhere`, so an `outDir` leaving the repository would have been mapped inside it.
- **Fix:** `ConfigInfo.emitEscapes` (absolute or climbing above the root, read against the declaring config); such a config maps nothing and reports `emit_outside_repo`.
- **Commit:** c3c2c1f

**5. [Rule 3] Files outside the plan's list**
- `src/tenant/follower-overlay.ts` (the follower's Reader must implement `emittedAs`), `src/fact-store/fact-store.test.ts`, `src/query/fresh.test.ts`, `src/query/harness.test.ts` (Reader fakes and a `projectContext` harness option), `src/fact-store/resolve.test.ts` (store-level emit cases; `store.test.ts` is a five-line contract runner), `src/indexer/index.ts` (exports `OutputFilter`), and `docs/reference/cli.md` / `mcp.md` (the new `data.file`). Plan-listed files left untouched: `src/tenant/types.ts`, `src/fact-store/store.test.ts`.

**6. [Convention] `emit_ambiguous` names the sources in its message**
- 03-18 keeps repository text out of messages. The plan requires the diagnostic to name both sources, so the message carries up to four repo-relative source paths (sorted) and the subject is the output path. Paths only, no file content.

**Total deviations:** 2 plan-premise corrections, 2 additions for correctness and security, 2 scope notes. **Impact:** none on scope.

## Interpretations and known limits worth a second look

- **Only configs the model can see produce outputs.** A repository whose emitting config is neither `tsconfig.json`/`jsconfig.json` in an ancestor directory, nor referenced, nor extended by one, is not mapped. gsd-core and gsd-pi are covered; a standalone `tsconfig.build.json` that nothing extends is not. The model accepts `extraConfigs` (the differential supplies them); the Tenant does not, because the overlay holds no JSON paths. A follow-up would pass tracked `tsconfig*.json` paths from the snapshot to `exclude`.
- **New configs are noticed late on the read path.** The store-time provider re-checks the text of the configs it already read (one small read each). A config that is created appears at the next `exclude` (Reconcile, build), which also probes for new configs, or when the path set changes.
- **The follower overlay's own specifier resolution (`candidatePaths`) is not emit-aware.** Importers, refs and callers over the stored overlay are (the follower reads the same provider); a patched path the follower parses in memory is linked by the plain rule only.
- **`isOutput` is false before the first `exclude` or store read of a worktree in this process.** An event for an output arriving before any Reconcile would index it once; the next Reconcile removes it. The Tenant's start-up Reconcile makes this a start-up window only.
- **`outputToSource` does not look at extensionless specifiers** (`require('./out/lib')`); only a specifier that spells the output.
- **OQ3 default reading** (03-DECISIONS.md, Confirmed): hand-written files under `outDir` that match no source keep their facts. The literal-reading variant is written as a skipped case with the reason.

## Threat mitigations (plan register)

- **T-03-221:** a path that is a source of any config is never an output (`emit_overlaps_source`); tests in `emit.test.ts` and `tenant/project.test.ts`.
- **T-03-222:** ambiguity returns no mapping and a diagnostic; the plain rule applies (`emit.test.ts`, `specifier.test.ts`).
- **T-03-223:** an escaping `rootDir`/`outDir`/`declarationDir` drops that config's outputs with `emit_outside_repo`; `emittedAs` is cleaned like every repository string; the specifier hook offers only overlay paths (hostile-lookup case).
- **T-03-224:** the provider counts: ten overlay snapshots of one path set describe once, and each later call reads only the config text (`tenant/project.test.ts`).

## Known Stubs

None.

## Threat Flags

None. The Tenant now reads module manifests with the existing confined `readManifest` and reads config files through `SourceTree.readText` (confined, size capped) at query time; no new network, auth or process start.

## Self-Check: PASSED

- Files present: src/project-model/emit.ts, emit.test.ts, src/tenant/project.ts, project.test.ts, src/fact-store/specifier.test.ts, scripts/emit-e2e.test.ts.
- Commits 7f0bd37, 287ddb5, 453022a, c3c2c1f, ccd3b5d and 7977f36 are ancestors of HEAD; the `node_modules` link and the `.codegraph` index of the worktree and the scratch checkout are removed.
