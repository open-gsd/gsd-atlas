# ADR: Languages are modules (data, not code)

- **Status:** Proposed
- **Issue:** to be opened (rename to `<issue#>-language-modules.md`)
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
\1\n   - All of it runs through the one CommandRunner ([draft-command-runner](draft-command-runner.md)).
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
