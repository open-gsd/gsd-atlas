# ADR: Languages are modules (data, not code)

- **Status:** Accepted
- **Issue:** [#5](https://github.com/open-gsd/gsd-atlas/issues/5)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A6, A7, A9, A25, A47, A48
- **Review findings addressed:** LM‑1, LM‑2, LM‑3, LM‑4, LM‑5, SDK‑1, S‑1 (module side)

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
