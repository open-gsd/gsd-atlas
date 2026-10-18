# ADR: Languages are modules (data, not code)

- **Status:** Accepted
- **Issue:** [#5](https://github.com/open-gsd/gsd-atlas/issues/5)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A6, A7, A9, A25, A47, A48
- **Review findings addressed:** LM‑1, LM‑2, LM‑3, LM‑4, LM‑5, SDK‑1, S‑1 (module side)

> Pre-release note: this record is not yet ratified; ratification is planned for the end of Phase 3, and every ADR will have a number by the MVP release; its Accepted status and issue number do not mean it is ratified (see docs/adr/README.md).

## Context
Users should be able to bring a language without anyone "adding support for it" in gsd‑atlas. The MVP language is TypeScript, for gsd‑core development (`.cts` compiled to `.cjs`). Swift follows, then community languages. gsd‑graph's EXT‑01 extractor registry is synchronous and per‑file, which can't load WebAssembly grammars or run project‑wide compilers.

The design review measured grammar drift: the third‑party `tree-sitter-wasms` TypeScript grammar failed to parse 8 of 285 gsd‑core files and 36 of 3,982 gsd‑pi files. In gsd‑core the failures were regex literals containing `<!--` and `import('./x.cjs').Type` type queries. It also found that a repo could ship a module whose command atlas would run.

## Decision
1. **A language is a module folder:**
   - `atlas-lang.json` manifest (JSON Schema validated);
   - `grammar.wasm` (tree‑sitter compiled to WebAssembly);
   - `queries/` (`tags.scm`, `refs.scm`, `imports.scm`);
   - `features.json` (syntax feature → minimum language level);
   - test globs (for `tested_by`);
   - `fixtures/`.

   Built‑ins use the same format.
2. **Three tiers:**
   - **Grammar** (required): always on, no build, every branch; produces local facts and `INFERRED` name resolution.
   - **Precise** (optional): any SCIP index, or a built‑in compiler adapter; produces `EXTRACTED` resolved edges.
   - **Platform** (optional): an SDK provider, registered by id and selected by project targets rather than by language.
3. **Runtime interface:**
   - A language module is data. The shared **Grammar Engine** loads its grammar, runs its queries, normalizes captures and does name‑matched (`INFERRED`) resolution from module data (import‑path rules, project markers). A data‑only module (such as Python) needs no code.
   - The only code a module may add is an optional `PreciseResolver` (`resolve(overlay, context, sites)` → `EXTRACTED` edges). Adapters: SCIP import, TypeScript 6 and 7 compilers, IndexStoreDB.
   - The Fact Store's injected resolver runs the Grammar Engine, then precise edges, which supersede at the same span.
   - SDK providers are not part of a module; see SDK‑PROVIDERS.
4. **Resolution order:** repo `.gsd-atlas/languages/` → user `~/.config/gsd-atlas/languages/` → npm `gsd-atlas-lang-*` / `@opengsd/atlas-lang-*` → built‑ins. Extension collisions fail loudly unless `replace`.
5. **Who may run commands** (with the trust‑boundaries ADR):
   - Grammars (sandboxed WebAssembly) and queries (data) are always allowed.
   - Built‑in first‑party providers with fixed command lines run by default and can be turned off. Examples: the TypeScript adapter loading the project's `typescript` package; `git`; on macOS, `xcrun` and `swift symbolgraph-extract`.
   - Any other command (a module's `precise.command`, a third‑party SCIP indexer) runs only when allowed in user‑level config (`~/.config/gsd-atlas/`), per repo and per command. Repo‑committed config and repo or npm modules can never grant it, and it never runs through MCP unless the host was started with `--allow-build`.
   - All of it runs through the one CommandRunner ([4-command-runner](4-command-runner.md)).
6. **Grammar supply:**
   - Grammars are built by gsd‑atlas's own build from pinned upstream tree‑sitter releases, never taken from third‑party WASM bundles.
   - Each module has a parse‑error budget (≤ 0.5 % of files) checked in CI on the reference corpora.
   - Files with parse errors are reported in `status` and use the precise tier where it exists.
7. **What counts as source:** `git ls-files` plus untracked, non‑ignored files; honour `linguist-generated` and `linguist-vendored`; skip binaries and LFS pointers; per‑repo excludes in user config.
8. **TypeScript module (MVP):**
   - Uses the project's own `typescript` package, loaded in a worker with no network, ignoring tsconfig `plugins`, only from the repo's installed `node_modules` (command‑runner ADR).
   - One adapter for 6.x (classic API) and one for 7.x (native `unstable/sync` API).
   - tsconfig‑driven emit mapping (`.cts` → `.cjs`), generic and not specific to any project.
   - ADR citations.
   - Precise resolution runs for a bounded number of active overlays under the memory budget, most recent first. One gsd‑core program is about 357 MB, and programs can't be shared across different file sets. Other overlays get grammar facts plus their base commit's precise edges, marked as such.
9. **Swift module (after the MVP):**
   - tree‑sitter‑swift plus atlas's own `refs.scm`; SwiftPM and Xcode project models.
   - **Quality target:** grammar‑tier resolved references ≥ 85 % precision on a reference app, measured, before launch.
   - **Precise tier:** a small first‑party macOS helper over IndexStoreDB (spike) instead of depending on a community SCIP indexer.

## Evidence (2026‑10‑15)
- web‑tree‑sitter loaded tree‑sitter‑swift WebAssembly in Node. Upstream `tags.scm` returned definitions but no call references, hence atlas's own `refs.scm`.
- TypeScript 6.0.3 indexed gsd‑core's 274 `.cts` files in 5.4 s: 28,071 call sites resolved, 59 distinct ADR ids found.
- tree‑sitter parsed 304 TypeScript files/s single‑threaded on gsd‑pi; the `tree-sitter-wasms` 0.1.13 grammar had parse errors in 0.9 % of gsd‑pi and 2.8 % of gsd‑core files.
- TypeScript 7.0.2 (published 2026‑07‑08) exposes `typescript/unstable/sync|async` and ships 108 `lib.*.d.ts` files in its platform package.

## Consequences
- New languages need no gsd‑atlas release. Python ships as an example module to prove it, validated on gsd‑path.
- Owning the grammar build adds CI work, but parse quality becomes measurable and fixable.
- Precise resolution is visibly bounded rather than silently memory‑bound.
- The TypeScript 7 API is marked unstable, so its adapter is pinned and tested per minor release.

## Alternatives considered
- **Code plugins per language:** every language needs a TypeScript author and a release.
- **LSP as the base tier:** needs a running language server per language and project; candidate later tier.
- **SCIP only:** requires a build and an indexer per language; no freshness on save.
- **Third‑party WASM grammar bundles:** already mis‑parse current TypeScript.

## Amendment 2026-10-15: ProjectModel seam

Sources: ARCHITECTURE.md Gap 1 (FND-10); D-16 of the Phase 1 context; DESIGN.md A2, A44, A55; PRD section 4.5.

Decision 3 says the only code a module may add is an optional `PreciseResolver`. It does not say where a project's configuration (tsconfig, `Package.swift`) is read, and the Grammar Engine must stay language-agnostic. This amendment adds one seam and refines decision 3 without replacing it.

1. A `ProjectModel` is a built-in, compiler-free seam registered by id. A language module names one through the optional `project.model` field of its manifest (a kebab-case id, next to `project.markers`, exactly as `src/lang/manifest.ts` commits it). The manifest holds only the id, never code.
2. A `ProjectModel` supplies the config-file set that defines the resolution context (A2); the project file sets (`include` and `exclude`); the emit mapping behind `emitted_as` (`.cts` to `.cjs`, `rootDir` and `outDir`); the targets and deployment targets; and the language level.
3. It works with no compiler installed, so the grammar tier, Linux CI and Windows get project structure without TypeScript or Xcode.
4. Repo or npm modules may name a `ProjectModel` by id but can never supply one (A44, A55). The only code a module may add therefore remains a `PreciseResolver` adapter, which is a refinement of decision 3.
5. The Grammar Engine never reads tsconfig or `Package.swift`. Precise adapters take their file sets and context from the `ProjectModel`.
6. Phase 3 (TSM-07) builds the TypeScript `ProjectModel` and Phase 5 builds the Swift one.

## Amendment 2026-10-15: Parse-error budget unit

Sources: D-06 of the Phase 1 context; DESIGN.md A48; 01-RESEARCH.md Open Question 5.

Decision 6 states the parse-error budget as at most 0.5 % of files. The budget is instead the fraction of source bytes inside outermost ERROR nodes, so one large mis-parsed file weighs more than a small one and a single stray error in a big file does not fail a whole module. Each module declares its budget as `parseBudget` in its manifest (default 0.005, that is 0.5 %), and CI measures it over the module's fixtures and fails when it is exceeded. A module whose grammar cannot meet the default, such as Swift, declares its own measured number rather than an exception to a global threshold. For new work this unit replaces the file-count wording of decision 6. Files with parse errors are still reported in `status` and still use the precise tier where it exists.

## Amendment 2026-10-17: Parser pool deadlines

Sources: 02-REVIEW WR-09 and IN-06; plans 02-29 and 02-39 of Phase 2; the 2026-10-17 gap-closure addendum of 02-CONSTANTS.md (Status: Approved); DESIGN.md A6, A40, A55 and A61.

Decision 3 names the shared Grammar Engine; its parser pool is how that engine runs grammars off the main thread (the Governor of A61 schedules the work and owns the budget, and does not own these deadlines). Decision 4 puts repository modules at the highest precedence, so the grammar a pool worker loads can come from repository content. Two deadlines make that safe, and this amendment records them. The decisions above stand unedited.

1. **A grammar load has a deadline.** `pool.loadTimeoutMs` is 30,000 ms (WASM instantiate plus query compile; far above a normal cold load of tens to a few hundred milliseconds, and still a bound on a hang). When it expires the parser worker is terminated and replaced, and the load rejects with `engine_init_failed`. A run that needed that lazy load fails with `parse_failed`, carrying the load error, and the queue behind it goes on. A hung load therefore costs one worker and one request, and cannot occupy a worker for good.
2. **The pool's hard deadline sits above the engine's own cut-off.** The cooperative per-file cut-off stays the approved `indexer.parseTimeoutMs` (5,000 ms, unchanged). The pool's hard deadline is that value plus `pool.terminateGraceMs` (2,000 ms), 7,000 ms. An ordinary slow parse therefore ends in the engine's own `parse_timeout` and the worker keeps its loaded grammars; terminating the worker is only the backstop for a stuck parse that never reaches the cut-off.
3. **Callers that set one value keep their behaviour.** A caller that sets only `runTimeoutMs` keeps the earlier equal behaviour (the cut-off follows it, so the engine and the pool agree). A caller that sets only the engine's `parseTimeoutMs` gets that value plus the grace as the pool deadline. A caller that sets both gets both as given. A value that is not a positive finite number is a `RangeError` at construction.
4. **The effective values are reported.** `poolStatus().limits` returns `parseTimeoutMs`, `runTimeoutMs` and `loadTimeoutMs` as they apply, so `status` and the tests read the numbers in force rather than the defaults.

## Amendment 2026-10-18: TypeScript project model, adapter ids and manifest version 2

Sources: 03-CONTEXT.md D-12, D-13, D-14, D-19 and D-20; 03-RESEARCH.md Patterns 3, 4 and 5 and Seam Gap G12; the ProjectModel seam amendment of 2026-10-15 above; [3-trust-boundaries](3-trust-boundaries.md), amendment of the same date.

Phase 3 builds the TypeScript module's project model and its precise adapter, and gives the manifest one new optional field. The decisions above and the earlier amendments stand unedited; where this section is more specific, it governs.

1. **Built-in project model id `typescript`.** The seam of 2026-10-15 lets a manifest name a built-in ProjectModel through `project.model`. The TypeScript module names the id `typescript`. That model is compiler-free: it reads tsconfig files through Source Tree's confined reader and never loads the TypeScript package. It follows `extends` (a string or an array) with a depth limit and cycle detection, and computes for each config its effective file set, `rootDir`, `outDir`, `declarationDir`, `allowJs`, `jsx` and `references`. From those it supplies the config hashes of the resolution context, the owner config of each file, the emit map behind `emitted_as`, and the version and `exports` keys of the project's installed `typescript`. Where several configs cover one file the owner is chosen deterministically (the nearest config directory, then non-test and non-build names, then lexical order), and one compiler program is later run per owner config, never per config. A differential test keeps the model equal to the compiler's own file list.
2. **Precise adapter id `typescript`.** The manifest's `precise.adapter` names a built-in resolver adapter by id, as data. The code is registered by the host and a repository module can never supply it. In Phase 3 the id `typescript` names the 6.x adapter only. This refines decision 8, which names one adapter for 6.x and one for 7.x: for 7.x Phase 3 ships detection and fallback and no resolver (D-12). The model reads the project's `node_modules/typescript/package.json` without loading it and distinguishes a 6.x copy (used as is, D-13), a 7.x copy with the `./unstable/sync` subpath, a 7.x copy with the `./sync` subpath, a 7.x copy with neither, another major, and no copy. Every case except the 6.x copy selects the bundled 6.0.3 and marks the answer `compiler_fallback` with the case named. A working 7.x resolver waits for a stable 7.1 API.
3. **Manifest `schemaVersion` 2 and `project.adrDirs`.** The manifest header requires a `schemaVersion` bump for any field added after Phase 1, so the schema now accepts versions 1 and 2. `project.adrDirs` is an optional list of at most eight relative paths, under the same relative-path rule as every other manifest path (no drive letter, backslash, NUL or `..` segment), and it exists only from version 2: version 1 manifests stay valid and unchanged, and a version 1 manifest that carries it is rejected like any unknown field. The TypeScript module's convention list is `docs/adr`, `docs/adrs`, `doc/adr` and `adr` (D-20). The built-in TypeScript module moves to version 2 in plan 03-28. The generated JSON Schema stays one document and describes both versions, and the parity test covers both.
4. **The repo-level config file `.gsd-atlas/config.json`.** A repository may carry this file for non-privileged settings only. In Phase 3 it honours one key, `adrDirs`, a list of relative paths under the same rule, which replaces the manifest's list for that repository. Every other key is ignored with a fixed diagnostic, whatever it claims, and a file that is oversized or not valid JSON is ignored whole. The file is untrusted data read through the confined reader; it can never grant a permission ([3-trust-boundaries](3-trust-boundaries.md), amendment of the same date).
5. **Only names are read.** Finding ADR files lists the directory's file names through Source Tree. ADR file contents are not read, indexed or returned by this mechanism.
