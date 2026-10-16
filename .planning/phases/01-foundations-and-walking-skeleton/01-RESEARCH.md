# Phase 1: Foundations and Walking Skeleton - Research

**Researched:** 2026-10-15
**Domain:** TypeScript/Node 24+ single-package repo bootstrap: 3-OS CI, ESLint boundary enforcement, tree-sitter WASM grammar build, Zod manifest schema, process-spawning seam (CommandRunner), SQLite driver layer, ADR ratification
**Confidence:** MEDIUM-HIGH (everything below marked VERIFIED was run on macOS arm64 this session; Windows and Linux behaviour is unverified and can only be checked by the first CI run)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Fixture module and `lang test`**
- **D-01:** The fixture module uses a **tiny purpose-built toy grammar** that we own, not a real upstream grammar. It is deterministic, builds fast on all 3 OSes, and has no upstream licence or ERROR noise. Phase 2's "second, non-TypeScript fixture language" Grammar Engine test (Success Criterion 2.1) should reuse it. Real grammars (TypeScript, JS, Python, Swift) arrive in later phases.
- **D-02:** `gsd-atlas lang test` validates the manifest, loads the WASM, compiles and runs the queries over fixture files, and **compares produced spans/captures to checked-in golden files**. Fixtures must include UTF-16 column cases (emoji), CRLF and BOM. Mismatch gives a non-zero exit and a diagnostic. The parse-quality number is **not** part of `lang test` output in Phase 1; it is measured by the CI budget job (see D-06).
- **D-03:** Source resolution (repo > user > npm > built-in) is proven by a test harness that **places the same fixture module in all 4 locations on disk** and asserts precedence, that `lang list` shows each module's source and active tiers (including shadowed copies), and that a module with an invalid manifest is **skipped with a diagnostic, never a crash**.

**Manifest schema**
- **D-04:** The manifest Zod schema is **complete for v1 and versioned**: `name`, `schemaVersion`, `extensions`, `grammar` (wasm file + `grammar.lock` ref), `queries`, `tiers`, `parseBudget`, optional `precise` (command). Unknown fields are rejected. Changes after Phase 1 require a `schemaVersion` bump. — **Reversibility:** costly — third-party and user modules (Phase 9 bring-your-own proof) will depend on the shape.
- **D-05:** The JSON Schema generated via `z.toJSONSchema(schema, {target: 'draft-2020-12'})` is **committed under `schemas/`**; CI regenerates and fails on drift. An Ajv (2020) dev-only conformance test asserts the Zod parser and the JSON Schema accept/reject the same manifest fixtures.

**Grammar build and parse budget**
- **D-06:** Parse quality = **bytes inside ERROR nodes**, declared **per module in the manifest** (`parseBudget`, default 0.5% of source bytes per STACK A48). A CI job measures over the module's fixtures and fails when exceeded. Swift later declares its own measured number (Phase 5) rather than an exception to a global threshold.
- **D-07:** **Built grammar WASM is committed** next to the module, with its sha256 pinned. A CI job on **all three OSes** rebuilds from pinned source with the pinned `tree-sitter-cli` (0.27.1, must equal `web-tree-sitter` 0.27.1) and fails if the hash differs. Installs and normal tests never need wasi-sdk. Cache `~/.cache/tree-sitter` only in the grammar job.
- **D-08:** Grammar pins live in a **per-module `grammar.lock`** inside the module folder: upstream source URL, pinned tag/commit, patch list, licence id, expected wasm sha256. One shared build script reads it. This keeps modules self-describing ("languages are data") so user/npm modules can use the same mechanism.

**Seam interfaces, doubles and conformance**
- **D-09:** **Fact Store:** ship the frozen TypeScript interface, a thin **driver layer over `node:sqlite` and `better-sqlite3`** (supplying what `node:sqlite` lacks: pragma helper, transactions via `BEGIN IMMEDIATE`/`SAVEPOINT`, null-prototype row normalisation, bigint handling), and the **driver conformance suite green on both drivers in 3-OS CI**. **No fake FactStore** (per fact-store-interface ADR); tests use real SQLite in a temp dir with a fake clock and fake `gitHas`. Fact tables, writer lease and maintenance are Phase 2 (STO-*). — **Reversibility:** costly — the interface is the external seam every later module codes against.
- **D-10:** **Other seams** (Source Tree, Grammar Engine, PreciseResolver, Governor): each gets a frozen interface, a fake, and **one shared contract test file run against both the fake and the real implementation where one exists**, so fakes cannot drift. The Grammar Engine is real in Phase 1 (it powers `lang test`); PreciseResolver and Governor are fake/no-op only. CommandRunner gets the recording fake required by its ADR.
- **D-11:** **CommandRunner full surface now:** `CommandSpec` as an argv array (never a shell), timeout and kill, streaming stdout, **batched stdin** (one `git hash-object --stdin-paths` over a whole snapshot), output caps, and real-executable resolution on Windows (no `.cmd`/`.bat` spawns, no npm shims). The hostile-repo test uses the recording fake to assert zero starts outside the runner, and exercises real `git` only through the runner. — **Reversibility:** costly — every child-process call site in later phases depends on the spec shape.

**Lint, CI and layout**
- **D-12:** Boundary rules are enforced with **ESLint only** (`no-restricted-imports`/`no-restricted-syntax` plus import path patterns in `eslint.config`). Rules: `child_process` only in the CommandRunner; `sqlite/` only for the Fact Store, Metrics and SDK stores; cross-module imports only via `index.ts`; Policy imports only `facts/`; adapters import only `HostClient`. A **fixture test per rule** proves a deliberate violation fails lint. No dependency-cruiser.
- **D-13:** CI matrix: **ubuntu, macos, windows x Node 24.15.0 (floor) + Node 26 latest.** Lint and typecheck run once on Linux. The grammar rebuild-hash job runs on all 3 OSes. The `xcode-27` lane is deferred to Phase 6. Actions pinned to commit SHAs with a version comment (as gsd-core does).
- **D-14:** Layout: **`src/<seam>/index.ts`** per seam (`fact-store`, `source-tree`, `command-runner`, `grammar-engine`, `precise-resolver`, `governor`), exporting only through `index.ts`; `src/cli` and `src/mcp-shim` as adapters; **`modules/<lang>/`** for language modules; tests colocated as `*.test.ts`. npm scripts: `build`, `typecheck`, `lint`, `test`, `grammar:build`, `grammar:verify`. Follow STACK.md rules (native type stripping, `.ts` import extensions, `erasableSyntaxOnly`, `verbatimModuleSyntax`, tsc emit to `dist/`, no bundler).

**ADR ratification (FND-09, FND-10)**
- **D-15:** The GitHub repo/remote does not exist yet. A plan task has the user create or confirm the remote, then **opens one issue per ADR with `gh`** (outward-facing: confirm with the user before each batch), renames each `draft-<slug>.md` to `<issue#>-<slug>.md`, moves Proposed to Accepted, and applies the five research-gap amendments as **dated amendment sections** (ADRs are append-only per `docs/adr/README.md`). Phase 1 ADRs: product-boundary, trust-boundaries, command-runner, language-modules, fact-model, fact-store-interface, sqlite-store, tenant-composition. Update the README table links and statuses in the same change.
- **D-16:** Amendments to apply: ProjectModel seam (language-modules); read-triggered cache write and SQLite-access wording (fact-store-interface, sqlite-store). Writer contention (worktree-lifecycle) and metrics migrations (value-dashboard) belong to Phase 2's ratification.
- **D-17:** Open questions resolved as part of ratification:
  - **Fact Store `warm()`:** no `warm(worktree)`. First-call resolver latency is bounded by `timeoutMs` and returns `degraded: ['resolver_timeout']` on overrun; the interface documents the cost.
  - **File watcher location:** inside the **Indexer** (events are its input); Source Tree only supplies git events.
  - **Governor / `ensureFresh`:** takes **one `fresh` priority slot per request**, not per call; the compiler-program LRU keys on the **file set**, not (tenant, overlay) (compiler programs are per file set, A25).

### Claude's Discretion
- Exact toy-grammar design, fixture file contents beyond the required CRLF/BOM/emoji cases, internal naming inside each seam, and CI workflow file organisation, provided D-01..D-17 hold.

### Deferred Ideas (OUT OF SCOPE)
- `xcode-27` CI lane: Phase 6 (SDK facts).
- Real fact tables, writer lease, maintenance, `warm()` if ever measured as needed: Phase 2+.
- Writer-contention and metrics-migration ADR amendments: Phase 2 ratification.
- Real-grammar parse budgets (TypeScript, JavaScript, Swift): Phases 2, 3 and 5.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-01 | CI builds and tests every PR on macOS, Linux and Windows | CI shape, SHA pins, Windows checkout and CRLF pitfalls (Architecture Patterns, Pitfalls 4-6) |
| FND-02 | One npm package `@opengsd/gsd-atlas` (Node >= 24.15, tsc emit) with bins `gsd-atlas`, `gsd-atlas-mcp` | package.json/tsconfig recipe verified; **Node floor conflict (NUL bug), see Open Question 1** |
| FND-03 | Manifest validated against JSON Schema generated from Zod; invalid module skipped with diagnostic | Zod 4 `io:'input'` + `strictObject` + Ajv parity verified (Code Examples 2) |
| FND-04 | Grammar WASM built reproducibly from pinned upstream with pinned CLI on all three OSes | toolchain internals, determinism result on macOS, cross-OS risk and spike (Pitfall 1) |
| FND-05 | Each seam has fixed interface and test double or conformance suite | Seam inventory, contract-suite pattern, minimal HostClient (Architecture Patterns) |
| FND-06 | Every child process starts through the CommandRunner, enforced by lint, streaming and batch | git hardening recipe verified (filter driver and fsmonitor execution proven), batch hashing verified |
| FND-07 | Module-boundary lint rules from day one | Working ESLint 10 config generator verified with 18 probe cases (Code Examples 1) |
| FND-08 | Each eval corpus pinned to a commit SHA in a corpus manifest | Corpus manifest shape and current SHAs (Standard Stack, Open Question 7) |
| FND-09 | Each ADR ratified (issue, rename, Proposed to Accepted) | `gh` flow, link-rewrite scope, corrupted `\1` text found in three Phase 1 ADRs (Pitfall 9) |
| FND-10 | Research-gap ADR amendments applied | Amendment scope per D-16 plus recommended extras needing user OK (Open Question 5) |
| FND-11 | `gsd-atlas lang test` runs a fixture module end to end on three OSes | web-tree-sitter flow verified end to end on toy grammar (Code Examples 3) |
| LNG-01 | Module folder resolved repo > user > npm > built-in; `lang list` shows source and tiers | Resolution roots as injected parameters; manifest field reconciliation (Open Question 3) |
| LNG-06 | Parse quality as bytes inside ERROR nodes per module with CI budget | ERROR-byte measurement verified, UTF-16 to byte conversion (Code Examples 3) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Source: `/Users/trekkie/projects/gsd-atlas/.claude/CLAUDE.md` (treated as locked, same authority as CONTEXT.md).

- Tech stack: TypeScript, Node >= 24, SQLite via `node:sqlite` with `better-sqlite3` kept working as fallback.
- One npm package `@opengsd/gsd-atlas` with bins `gsd-atlas` and `gsd-atlas-mcp`; language modules under `modules/`.
- macOS, Linux and Windows are 1.0 platforms, in every budget's CI run from M1.
- No network by default, no telemetry; permissions only from user-level config (`~/.config/gsd-atlas/`); repo text fenced as untrusted.
- No dependency on gsd-core, gsd-graph or `.planning/`; gsd-core is a validation corpus only.
- MIT licence; vet licences of pinned upstream grammars before use.
- Pin each eval corpus to a commit SHA.
- STACK rules: native type stripping, `.ts` import extensions, `import type`, no `enum`/`namespace`/parameter properties/decorators, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, `module: nodenext`, `tsc` emit with no bundler, `@types/node` 24 (not 26), ESLint 10.12.0 + typescript-eslint 8.71.2 (pins TypeScript to `~6.0.3`), `node:test` + `c8`, runtime deps must work with install scripts disabled, Zod as schema source.
- GSD workflow enforcement: file edits happen through a GSD command (plan execution), not ad hoc.

## Summary

Phase 1 is a greenfield bootstrap with one real piece of engineering (the tree-sitter grammar engine behind `lang test`) and a lot of frozen-interface and CI plumbing. The design is already decided in depth (CONTEXT.md D-01..D-17, 8 ADRs, STACK/ARCHITECTURE research); this research verified the risky mechanics hands-on and found **four things that change or sharpen plans**:

1. **The locked Node floor 24.15.0 has a verified data-corruption bug.** `node:sqlite` on v24.15.0 truncates TEXT at an embedded NUL (`"ab\0cd"` reads back as `"ab"`); v24.16.0 and v26.11.1 round-trip correctly. The driver conformance suite (D-09) will fail on the floor lane unless the floor moves to 24.16.0 or the lane is made a "refusal is detected" lane. This conflicts with D-13 and FND-02 wording and needs a user decision before planning is final.
2. **git runs repo-controlled code.** Verified: `git hash-object --stdin-paths` executes a `filter.<name>.clean` command from `.git/config`; `git ls-files -o` executes `core.fsmonitor`; both are neutralised by `-c` overrides. The "hostile repo" test (SC4) and the git CommandSpec must encode this, and the command-runner/trust ADRs deserve a dated amendment.
3. **`tree-sitter-cli` needs its install script to get a binary**, and the CI matrix mixes npm versions (24.15/24.16 ship npm 11.12/11.13; 26 ships 11.20 which blocks dependency scripts by default). Every job should use `npm ci --ignore-scripts` and an explicit `scripts/` step that fetches the CLI binary; verified that `--ignore-scripts` leaves no binary.
4. **The GitHub repo already exists** (`open-gsd/gsd-atlas`, private, issues enabled, zero issues; PR #1 merged), so D-15's "create or confirm the remote" reduces to confirmation. Three Phase 1 ADRs (fact-model, language-modules, trust-boundaries) contain a literal corrupted `\1` where text was lost and need an editorial repair during ratification.

**Primary recommendation:** Build in this order: (0) repo skeleton + lint + 3-OS CI + a throwaway grammar-hash-parity spike on all three OSes (the one unverifiable assumption behind D-07), in parallel with ADR ratification; (1) parallel lanes for facts kernel/test kit, CommandRunner, sqlite driver layer, manifest/registry, grammar pipeline, corpus manifest; (2) Grammar Engine + `lang test` + parse budget + boundary-fixture tests + hostile-repo test; (3) package smoke, docs/schedule, final 3-OS green.

## Architectural Responsibility Map

This phase has no browser/SSR/CDN tiers; "tiers" are the project's module layers (ARCHITECTURE.md). Mapping of Phase 1 capabilities:

| Capability | Primary Owner | Secondary | Rationale |
|------------|---------------|-----------|-----------|
| Starting any child process (git, later compilers) | `command-runner` | none | ADR command-runner decision 1; lint-enforced |
| Permission decision for a spec | `command-runner` (`decide`) | user-level config (Phase 3 SEC-*) | Repo config/modules can never grant (trust-boundaries) |
| Git-derived snapshot (path to blob id) | `source-tree` (minimal real `snapshot`) | `command-runner` | Source Tree owns git; it runs git via the runner |
| Manifest schema, validation, module resolution | `lang` (registry) | `schemas/` (generated JSON Schema) | Languages are data (language-modules ADR) |
| Loading WASM, running queries, normalising to spans | `grammar-engine` | `lang` (supplies validated manifests) | Single shared engine, zero language special-casing |
| Parse-quality measurement | `grammar-engine` (measure fn) | CI job script | Metric is bytes in ERROR nodes (D-06) |
| Grammar build and hash verification | `scripts/` (build pipeline) | `grammar.lock` per module | D-07/D-08; not shipped at runtime |
| SQLite access (driver layer only) | `sqlite/` kit | `fact-store` (interface only this phase) | Only fact-store, metrics, sdk may import `sqlite/` |
| Fact Store contract | `fact-store` (interface + docs) | `facts/` kernel types | No fake store (ADR) |
| Cross-seam shared types (FileFacts, Answer, spans, degraded codes) | `facts/` | none | Leaf kernel so producers/consumers build in parallel |
| Scheduling and budgets | `governor` (interface + no-op) | none | Real implementation is Phase 2 |
| Adapter to host calls | `host-client` (interface + minimal in-process impl) | `cli`, `mcp-shim` | Adapters import only HostClient (FND-07) |
| ADR lifecycle | `docs/adr/` + `gh` | tests that check links/status | Process requirement, not runtime |

## Standard Stack

### Core (runtime)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| web-tree-sitter | 0.27.1 exact | WASM parser runtime for Grammar Engine | Pinned by STACK; must equal CLI. `[VERIFIED: npm registry, latest 0.27.1; loaded ABI 15 toy grammar this session]` |
| zod | 4.6.7 | Manifest schema (source of truth), JSON Schema export | `z.toJSONSchema` `[VERIFIED: ran, Code Examples 2]` |
| better-sqlite3 | 13.0.3 exact, optional peer + dev dep | Fallback SQLite driver | No install script, N-API prebuilds; `[VERIFIED: opened :memory: db with --ignore-scripts install on Node 26.11.1]` |
| `node:sqlite` | built in | Primary SQLite driver | Behaviour on 24.15.0 / 24.16.0 / 26.11.1 `[VERIFIED]`, see Pitfall 2 |

### Development
| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| tree-sitter-cli | 0.27.1 exact, dev | Grammar generate/build | `install` script downloads binary from GitHub releases `[VERIFIED: install.js read]`; pins wasi-sdk 34.0 and binaryen version_132 `[VERIFIED: crates/loader/wasi-sdk-version = 34.0, binaryen-version = 132 at tag v0.27.1]` |
| typescript | `~6.0.3` (6.0.3) | Typecheck + emit | `latest` on npm is 7.0.2: do not use `^`/`latest` `[VERIFIED: npm dist-tags]` |
| @types/node | `^24.19` (24.19.2) | Types | `npm view @types/node@24 version` = 24.19.2; `latest` is 26.x, do not use `[VERIFIED]` |
| eslint | 10.12.0 | Lint + boundary rules | engines `^20.19.0 \|\| ^22.13.0 \|\| >=24` `[VERIFIED]` |
| typescript-eslint | 8.71.2 | TS parser/rules | peer `typescript >=4.8.4 <6.1.0` `[VERIFIED]` |
| c8 | 12.0.0 | Coverage on `node:test` | Works on type-stripped `.ts` `[VERIFIED: ran, 100% report on .ts files]` |
| ajv + ajv-formats | 8.20.0 / 3.0.1 | Dev-only JSON Schema parity test (`ajv/dist/2020`) | `[VERIFIED: parity on 4 manifest cases]`. eslint 10 depends on ajv ^6 internally; npm nests it, no action needed. |
| `node:test`, `node:assert`, `node:util` `parseArgs` | built in | Test runner, assertions, CLI parsing | Zero-dependency choices from STACK |

### Not needed in Phase 1 (do not install)
`@modelcontextprotocol/*` (the `gsd-atlas-mcp` bin is a stub that must run and exit cleanly; the SDK arrives in Phase 2), `semver`, `@parcel/watcher`, `@bufbuild/protobuf`, `typescript-7` alias, `tree-sitter-typescript`/`-swift`/`-python` (real grammars are later phases).

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `eslint.config.js` (plain ESM) | `eslint.config.ts` | ESLint does not load TS configs natively without `jiti` or an experimental flag `[CITED: eslint.org/docs/latest/use/configure/configuration-files]`. Use plain `.js` with JSDoc. |
| ESLint `no-restricted-imports` regex patterns | dependency-cruiser / eslint-plugin-boundaries | D-12 locks ESLint-only; verified sufficient. |
| `Language.load(path)` | `Language.load(Uint8Array)` after sha256 check | Bytes avoid Windows path quirks and let the loader verify the lock hash `[VERIFIED: Uint8Array load works, abi 15]`. |

**Installation (exact pins; `--ignore-scripts` everywhere):**
```bash
npm install --save-exact --ignore-scripts web-tree-sitter@0.27.1 zod@4.6.7
npm install --save-dev --save-exact --ignore-scripts tree-sitter-cli@0.27.1 typescript@6.0.3 eslint@10.12.0 typescript-eslint@8.71.2 c8@12.0.0 ajv@8.20.0 ajv-formats@3.0.1 better-sqlite3@13.0.3
npm install --save-dev --ignore-scripts @types/node@^24.19
# package.json: peerDependencies.better-sqlite3 "13.0.3" + peerDependenciesMeta.better-sqlite3.optional = true
# package.json: allowScripts { "tree-sitter-cli": true }  (npm >= 11.14-ish only; older npm ignores it)
```
**Version verification:** all versions above were confirmed with `npm view` on 2026-10-15 (see Sources). `time.created`: web-tree-sitter 2019-05, tree-sitter-cli 2016-10, zod 2020-03, eslint 2013-07, typescript-eslint 2019-08, c8 2013-09, ajv 2015-05.

## Package Legitimacy Audit

Run via `gsd-tools query package-legitimacy check --ecosystem npm` on 2026-10-15.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| web-tree-sitter | npm | 7 yrs | 8.2M/wk | github.com/tree-sitter/tree-sitter | SUS (`too-new`: latest release 2026-10-08) | Flagged, see note |
| tree-sitter-cli | npm | 10 yrs | 362K/wk | github.com/tree-sitter/tree-sitter | SUS (`too-new`) | Flagged. **Has an `install` script that downloads a binary from github.com/tree-sitter releases** `[VERIFIED: install.js]` |
| zod | npm | 6 yrs | 347M/wk | github.com/colinhacks/zod | SUS (`too-new`: 2026-10-12) | Flagged, see note |
| typescript-eslint | npm | 7 yrs | 90M/wk | typescript-eslint repo | SUS (`too-new`) | Flagged, see note |
| eslint | npm | 13 yrs | 159M/wk | github.com/eslint/eslint | SUS (`too-new`) | Flagged, see note |
| @types/node | npm | n/a | 461M/wk | DefinitelyTyped | SUS (`too-new`) | Flagged, see note |
| better-sqlite3 | npm | n/a | 11.5M/wk | github.com/WiseLibs/better-sqlite3 | OK | Approved (no install script) |
| typescript | npm | n/a | 307M/wk | github.com/microsoft/TypeScript | OK | Approved |
| c8 | npm | 13 yrs | 4.2M/wk | github.com/bcoe/c8 | OK | Approved |
| ajv / ajv-formats | npm | 11 yrs / n/a | 392M / 144M per wk | github.com/ajv-validator | OK | Approved |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** web-tree-sitter, tree-sitter-cli, zod, typescript-eslint, eslint, @types/node.
**Note for the planner:** every SUS reason is `too-new` meaning the *latest release* is under two weeks old; the packages themselves are years old with enormous download counts and official source repos, and none has a `postinstall`/`preinstall` script (checked with `npm view <pkg>@<ver> scripts.*`). Because of this, do **not** create six separate checkpoints. Add **one** `checkpoint:human-verify` task at the first `npm install` that (a) shows the lockfile diff, (b) runs `npm install-scripts ls`, and (c) confirms the single deliberate script exception (`tree-sitter-cli` binary fetch). All versions are exact pins, so a later `too-new` re-flag cannot silently float.
*Package names above all come from the project's own STACK.md and CONTEXT.md (authoritative, user-reviewed) and were re-confirmed against the registry; none was discovered via web search.*

## Architecture Patterns

### System Architecture Diagram (Phase 1 slice)

```
 developer / CI                                       repo on disk (untrusted)
      │                                                       │
      ▼                                                       │
 bin/gsd-atlas ──argv──▶ cli (adapter) ──Request──▶ HostClient (in-process, Phase 1 minimal)
 bin/gsd-atlas-mcp ──▶ mcp-shim (stub: "MCP server arrives in Phase 2" on stderr, exit 1)       │
                                                      │ handle({kind:'lang_list'|'lang_test'})
                                                      ▼
                         ┌───────────────────── composition root (src/bin) ─────────────────────┐
                         │ Module registry (lang/)                Grammar Engine (real)          │
                         │  resolve roots: repo > user > npm       load wasm bytes ─▶ sha256 vs  │
                         │  > builtin (injected paths)             grammar.lock ─▶ Language.load │
                         │  validate manifest (Zod strict)         compile .scm queries          │
                         │  invalid ─▶ diagnostic + skip           parse fixtures ─▶ captures    │
                         │                                         ─▶ spans (UTF-16) ─▶ golden   │
                         │                                         ─▶ ERROR-byte measure         │
                         └───────────────────────────────────────────────────────────────────────┘
 seams frozen this phase (interface + double + contract suite):
   facts/ kernel ── fact-store (iface) ──▶ sqlite/ driver layer ──▶ node:sqlite | better-sqlite3
   source-tree (iface + fake + minimal real snapshot) ──▶ command-runner ──▶ git (hardened argv)
   command-runner (real + recording fake + decide())      governor (iface + no-op/fake clock)
   precise-resolver (iface + scripted stub)               host-client (iface)

 build-time only:  grammar.js ─generate─▶ parser.c ─wasi-sdk 34 clang + binaryen 132─▶ grammar.wasm
                   scripts/grammar-build.ts reads grammar.lock; grammar:verify rebuilds and compares sha256
 CI: lint+typecheck+schema drift (ubuntu) | test matrix (3 OS x Node floor,26) | grammar-verify (3 OS)
```

### Recommended Project Structure
```
src/
├── facts/              # leaf kernel: Span, FileFacts, Answer<T>, Watermark, degraded-code union, Request/Envelope types
├── sqlite/             # INTERNAL driver kit: node:sqlite + better-sqlite3 adapters, open policy, conformance suite
├── command-runner/     # index.ts, real.ts, fake.ts, decide.ts (built-in table), exec-resolve.ts, git-spec.ts, contract.ts
├── source-tree/        # index.ts, fake.ts, real.ts (minimal snapshot), contract.ts
├── fact-store/         # index.ts (interface + docs ONLY this phase; no fake)
├── grammar-engine/     # index.ts, load.ts, query.ts, normalize.ts, measure.ts, contract.ts, fake.ts
├── precise-resolver/   # index.ts, stub.ts, contract.ts
├── governor/           # index.ts, noop.ts / fake.ts, contract.ts, clock.ts
├── lang/               # manifest.ts (Zod), registry.ts (resolution), diagnostics.ts, test-runner.ts (lang test)
├── host-client/        # index.ts: HostClient interface + minimal in-process impl for lang_list/lang_test
├── cli/                # adapter: parseArgs -> HostClient only
├── mcp-shim/           # adapter stub (no SDK in Phase 1)
├── test-kit/           # FakeClock, temp-git-repo builder, tmpdir helper with Windows-safe cleanup (never published)
└── bin/                # composition root: gsd-atlas.ts, gsd-atlas-mcp.ts
modules/toy/            # atlas-lang.json, grammar.lock, grammar/ (grammar.js + tree-sitter.json), grammar.wasm, queries/, fixtures/
schemas/                # atlas-lang.schema.json (generated, committed), corpora.schema.json optional
scripts/                # grammar-build.ts, grammar-verify.ts, grammar-budget.ts, ensure-tree-sitter.ts, schema-build.ts, corpus-check.ts
corpora/corpora.json    # FND-08
eslint.config.js        # plain ESM JS; boundary generator exported for the fixture tests
docs/adr/               # ratified ADRs + README schedule
.github/workflows/      # ci.yml (+ grammar.yml optional)
```
Notes: `src/lang/` is not one of D-14's six seam folders but is required by ARCHITECTURE ("Module registry") and FND-07's `index.ts` rule applies to it. Keep the fixture module under `modules/toy/` **or** `test/fixtures/modules/toy/`: if under `modules/` it ships in the tarball as a (harmless) built-in; if under `test/` the built-in tier of the resolution harness uses an injected path anyway. Recommend `test/fixtures/` (not shipped) plus injected roots, and ship **no** built-in language in Phase 1 (decision for planner; see Open Question 8).

### Pattern 1: Resolution roots are injected parameters, not environment magic
**What:** `resolveModules({ repoRoot, userDir, builtinDir, npmRoots })` takes absolute paths; the composition root derives them from `os.homedir()`/cwd; tests pass temp dirs. D-03's four-location harness becomes trivial and Windows-safe.
**When to use:** all registry code and tests.

### Pattern 2: Contract suite per seam, parameterised by adapter factory
**What:** `contract.ts` exports `defineXContract(label, makeAdapter)` that registers `node:test` `describe/it` blocks; `fake.test.ts` and `real.test.ts` each call it. File name `contract.ts` (not `*.test.ts`) so the glob does not run it alone. Same for the sqlite driver suite called with `node:sqlite` and `better-sqlite3` factories (D-09, D-10).
**Example (shape only):**
```typescript
// src/sqlite/contract.ts
export function defineDriverContract(label: string, open: () => Promise<DriverHandle>): void {
  describe(label, () => { it('round-trips TEXT containing NUL', async () => { /* ... */ }); /* ... */ });
}
```

### Pattern 3: One `withTree` wrapper owns every WASM object
**What:** Grammar Engine exposes only `parseWith(text, fn)` that creates Parser/Tree/Query matches and calls `.delete()` in `finally` (PITFALLS B1). Lint-ban `parser.parse` outside it (`no-restricted-syntax` on `.parse(` member calls in `grammar-engine/` except `load.ts`, optional but cheap now and costly to retrofit).

### Pattern 4: Minimal in-process HostClient so the adapter lint rule is real
**What:** ARCHITECTURE seam 7 (`Request`/`Envelope`/`HostClient.handle`) must exist first. Phase 1 gives `HostClient` an in-process implementation that serves only `lang_list` and `lang_test`; `src/bin/*` is the composition root (exempt from adapter rule, allowed to import everything); `src/cli` imports only `host-client/index.ts`. `[ASSUMED: recommendation, not stated in CONTEXT.md]` — alternative is letting `cli` import `lang/` directly, which would contradict the FND-07 rule being tested.

### Pattern 5: Spans are 0-based line and 0-based UTF-16 column internally
**What:** web-tree-sitter `startPosition`/`endPosition` and the TypeScript compiler are both 0-based with UTF-16 columns `[VERIFIED: toy parse, string "a😀b" at column 6..12, i.e. 6 UTF-16 units]`. Store that; convert to 1-based line at the citation edge (Query, Phase 2). Document in `facts/` and in the golden-file header so the two conventions cannot be mixed `[ASSUMED: recommendation]`.

### Anti-Patterns to Avoid
- **Two `no-restricted-imports` blocks matching one file:** flat config does not merge rule options, the later block replaces the earlier. Generate one block per module that carries the complete pattern list (Code Examples 1). `[VERIFIED: design chosen after reasoning about flat-config semantics; generator passes 18 probes]`
- **Spawning `npm`, `npx`, `tsc` shims from tests or scripts on Windows:** `.cmd` spawns fail without a shell. Use `process.execPath` + script path (e.g. `node node_modules/typescript/bin/tsc`).
- **Using `node --test` with no pattern:** discovery also matches `test/**`, `*-test.*`, `test.*` names, so fixture files named `test.ts` or compiled `dist` tests can run unintentionally. Use `node --test "src/**/*.test.ts"` with **double quotes** (works in cmd.exe, PowerShell and bash; single quotes break on Windows) `[VERIFIED: pattern works on macOS; Windows quoting rule is CITED knowledge, confirm in CI]`.
- **Committing `parser.c` for the toy grammar in addition to `grammar.js`:** pick one source of truth. Generate in the build script; `parser.c` was byte-identical across two build directories `[VERIFIED]`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON Schema for manifests | Hand-written schema | `z.toJSONSchema(schema, {target:'draft-2020-12', io:'input'})` | Single source; Ajv parity test catches drift `[VERIFIED]` |
| WASM grammar compile | Own emscripten/docker pipeline | `tree-sitter build --wasm` (downloads pinned wasi-sdk 34.0 + binaryen 132) | Toolchain pinned by the CLI version itself `[VERIFIED: loader source + cache contents]` |
| CLI arg parsing | Custom parser | `node:util` `parseArgs` | Built in, STACK decision |
| Glob/test discovery | Custom runner | `node --test "<glob>"` | Node 24 expands the glob itself, portable |
| Boundary lint | dependency-cruiser or custom AST walker | ESLint core `no-restricted-imports` (regex patterns) + `no-restricted-syntax` | Locked by D-12; verified |
| Coverage | istanbul instrumentation | `c8` | Works with type stripping `[VERIFIED]` |
| Process spawning with timeouts/caps | Ad-hoc `child_process` calls | The CommandRunner (this phase's deliverable) | The whole point of FND-06 |
| SQL row/BigInt differences | Per-caller handling | The `sqlite/` driver layer | Null-prototype rows and bigint throw on `node:sqlite` `[VERIFIED]` |
| Semver parsing | `semver` package | Not needed in Phase 1 (`schemaVersion` is an integer; module `version` can be a regex-validated string) | Avoid a dependency |

**Key insight:** every item in this phase is either a thin wrapper that removes a platform difference (driver layer, runner, path/tmp helpers) or a pinned external tool; the value is in the frozen seams and the CI proof, not in clever code.

## Common Pitfalls

### Pitfall 1: Grammar WASM hash differs between OSes (D-07 assumption)
**What goes wrong:** the CI job "rebuild on all three OSes and compare to the committed sha256" fails on one OS because clang/binaryen host binaries or CRLF checkouts change the output.
**Evidence:** On macOS arm64, two builds from different directory paths produced identical sha256 (`6f99a017…ae440`) and identical `parser.c`, with no path strings embedded in the wasm `[VERIFIED]`. The CLI pins wasi-sdk 34.0 and binaryen version_132 and downloads per-host tarballs (`arm64-macos`, `x86_64-linux`, `arm64-linux`, `x86_64-windows`, `arm64-windows`, `x86_64-macos`) `[VERIFIED: crates/loader/src/loader.rs]`. Cross-OS identity is **not verified**: no Linux/Windows host, no Docker daemon, no Rosetta available here `[ASSUMED]`.
**How to avoid:**
- Make the **first CI push include a throwaway hash-parity spike** (workflow_dispatch, builds the toy grammar on ubuntu/macos/windows and prints sha256). If hashes diverge, D-07 cannot hold as written: escalate to the user with the options (canonical Linux hash + other OSes verify by load-and-golden-equivalence, or per-platform hash map in `grammar.lock`).
- `.gitattributes`: `* text=auto eol=lf`, `*.wasm binary`, and `fixtures/**` files that must keep CRLF/BOM marked `-text`. The Windows runner otherwise checks out CRLF `grammar.js`/golden files.
- Pass `--abi 15` explicitly to `tree-sitter generate` in the build script (do not rely on the default), and assert `tree-sitter --version` equals the `web-tree-sitter` version and `grammar.lock.cli`.
- Cache wasi-sdk/binaryen keyed on `${runner.os}-wasi34-binaryen132`. Cache dir is `etcetera::choose_base_strategy().cache_dir()/tree-sitter` i.e. `~/.cache/tree-sitter` on Linux/macOS and the Windows local-app-data equivalent `[CITED: loader.rs lines 1640-1650; Windows path ASSUMED]`; or set `TREE_SITTER_WASI_SDK_PATH` / `TREE_SITTER_BINARYEN_PATH` `[VERIFIED: env names in loader.rs]` to a path you control.
- Windows extraction shells out to `tar -xzf … --strip-components=1`; Windows runners have `tar.exe` `[ASSUMED]`.
**Warning signs:** hash mismatch on exactly one OS; `tar` errors on Windows; download timeouts (GitHub release assets of ~180 MB for wasi-sdk).

### Pitfall 2: Node 24.15.0 `node:sqlite` truncates TEXT at NUL (conflicts with D-13 floor)
**What goes wrong:** the driver conformance suite's "TEXT round-trips with embedded NUL" test fails on the floor lane; source-derived text stored later is silently cut.
**Evidence:** `[VERIFIED]` using the official binaries downloaded to the scratchpad: v24.15.0 returns `"ab"` (length 2) for stored `"ab\0cd"`, hex shows all 5 bytes stored; v24.16.0 and v26.11.1 return `"ab\0cd"`. PITFALLS B3 reported this from a secondary source; now confirmed directly.
**How to avoid:** either raise the floor to **24.16.0** (`engines.node ">=24.16.0"`, CI lane 24.16.0) or keep a 24.15.0 lane whose job is to assert the open-time self-test refuses `node:sqlite` there. Include the NUL round-trip as a driver-open self-test regardless (cheap, protects 22.x/25.x/26.0 users too). **Needs a user decision (Open Question 1).**
**Other floor facts:** at v24.15.0, SQLite is 3.51.3, FTS5 trigram works, `readOnly` works, no warning is printed for TS type stripping or `node:sqlite` `[VERIFIED]`. Do not use `db.serialize`/`deserialize` (needs >= 24.16 per STACK) or `createModule` (26.11+).

### Pitfall 3: git runs repo-controlled commands
**What goes wrong:** indexing a repo directory that carries a poisoned `.git/config` (archive, copied directory, anything not made by `git clone`) executes code during Source Tree's git calls.
**Evidence `[VERIFIED]`, git 2.54.0:**
- `printf 'a.txt\n' | git hash-object --stdin-paths` with `filter.evil.clean` set and `* filter=evil` in `.gitattributes` **ran the clean command** (marker file created). Adding `-c filter.evil.clean=` prevented it.
- `git ls-files -o --exclude-standard` **ran `core.fsmonitor`** (marker created); `-c core.fsmonitor=false` prevented it.
- `git status` ran the clean filter even with `core.fsmonitor=false`.
**How to avoid:** the built-in git `CommandSpec` must prepend `-c core.fsmonitor=false -c core.hooksPath=<empty/null device> -c core.quotepath=off` and env `GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0` `[CITED: PITFALLS B6 recipe, plus VERIFIED effect]`, and neutralise filter drivers: enumerate names with `git config --name-only --get-regexp '^filter\.'` (reads config, does not execute) and pass `-c filter.<name>.clean= -c filter.<name>.process= -c filter.<name>.smudge=` for non-allowlisted names (allowlist `lfs` only, and LFS files are skipped anyway). A diagnostic names each neutralised filter (command-runner ADR decision 6: denials are reported). The hostile-repo test fixture must include a poisoned `.git/config` (filter + fsmonitor + hooksPath) and assert the marker files do not exist after running the real runner against it.
**Not covered by D-16:** record this as a dated amendment to command-runner/trust-boundaries (Open Question 5).

### Pitfall 4: `tree-sitter-cli` has no binary under `--ignore-scripts`; matrix npm versions differ
**What goes wrong:** `npm ci --ignore-scripts` (or npm 11.20 on Node 26 which blocks dependency scripts by default) leaves `tree-sitter-cli` without its executable; `grammar:*` fails with an unhandled `ENOENT` stream error.
**Evidence:** `[VERIFIED]` `npm i tree-sitter-cli@0.27.1 --ignore-scripts` installed `cli.js`, `install.js`, no `tree-sitter` binary; `./node_modules/.bin/tree-sitter --version` crashed with an unhandled `error` event. Running `node node_modules/tree-sitter-cli/install.js` fetched `tree-sitter-macos-arm64.gz` and `--version` printed `tree-sitter 0.27.1`. Bundled npm: Node 24.15.0 = 11.12.1, 24.16.0 = 11.13.0, 26.11.1/26.12.0 = 11.20.0 `[VERIFIED: nodejs.org/dist/index.json and local binaries]`.
**How to avoid:** `scripts/ensure-tree-sitter.ts` runs `install.js` only if the binary is missing; every `grammar:*` npm script calls it first. Use `npm ci --ignore-scripts` uniformly in all CI jobs so behaviour is identical across npm versions. Run the grammar job on one Node major (24.x) per OS.

### Pitfall 5: Windows CI traps (no local Windows hardware)
- **CRLF and git config:** GitHub Windows runners can have `core.autocrlf=true` in system config `[ASSUMED]`. The temp-git-repo builder must isolate config (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointing at an empty file, or `GIT_CONFIG_NOSYSTEM=1`, plus per-repo `core.autocrlf=false`) or the batched-hash expectations differ per OS. `git hash-object --stdin-paths` applies clean filters, so a CRLF file under `* text=auto` hashes to the LF blob `[VERIFIED: crlf.txt and lf.txt both hash to 422c2b7ab3b3c668038da977e4e93a5fc623169c]`.
- **`hash-object` has no `-z`:** `git hash-object --stdin-paths -z` fails with "unknown switch `z'" `[VERIFIED]`; newline-separated stdin cannot represent paths containing `\n`. Skip such paths with a diagnostic. Paths with spaces and non-ASCII hash correctly `[VERIFIED]`. `ls-files` needs `-z` (quotes non-ASCII otherwise: `"\303\251.txt"` `[VERIFIED]`).
- **File locks:** close DB handles before deleting temp dirs (EBUSY); the test-kit tmpdir helper uses `fs.rmSync(dir, {recursive:true, force:true, maxRetries:5, retryDelay:100})`.
- **Path identity:** compare with `fs.realpathSync.native`; runner temp dirs can be 8.3 short names (`RUNNER~1`). Keep internal paths repo-relative POSIX (ARCHITECTURE day-one invariant 8).
- **Executable resolution:** Node rejects `.cmd`/`.bat` spawns without a shell `[CITED: STACK.md "What NOT to Use" row]`. Resolver must search `PATH` for `.exe`/`.com` only and run Node scripts via `process.execPath`.
- **Env scrubbing:** replacing the whole child env on Windows can break process start (needs `SystemRoot`, `PATH`, `TEMP`); inherit the parent env minus a denylist, then overlay spec env `[ASSUMED]`.
- **actions/checkout on Windows:** gsd-core pins checkout v5.0.1 for Windows because v6 `includeIf.gitdir:` auth was flaky on Windows with git 2.54 (comment in gsd-core `test.yml`, line ~353). The upstream PR (#2425) describing the case-sensitivity cause says GitHub-hosted runners are unaffected and is still open; v7.0.1 is current `[VERIFIED: gh api]`. Use v7.0.1 with `persist-credentials: false`; keep v5.0.1 SHA as the documented fallback if a Windows checkout flakes.
- **Shell:** set `defaults.run.shell: bash` so `run:` steps behave the same on all three OSes.

### Pitfall 6: TypeScript 6 defaults will not find Node types
**What goes wrong:** `tsc` fails with TS2591 "Cannot find name 'node:fs'" and TS5097 on `.ts` import extensions.
**Evidence:** `[VERIFIED]` with TypeScript 6.0.3: a tsconfig lacking `types` could not resolve `node:*`; `types: []` is the default. Needs `"types": ["node"]`, `allowImportingTsExtensions` is implied by `rewriteRelativeImportExtensions` + `noEmit` setup shown below.

### Pitfall 7: Flat-config option replacement and lint blind spots
- Rule options from a later matching config block **replace** (not merge) earlier options. Build one block per module (Code Examples 1).
- Policy `*.test.ts` files must be excluded from the "no bare imports" rule (they need `node:test`), but give them a second block that still bans `child_process` rather than leaving them rule-free.
- `no-restricted-imports` catches `import`, `export … from` and `import type`; it does **not** catch `import()` or `require()`. Use `no-restricted-syntax` selectors `ImportExpression[source.value=/…/]` and `CallExpression[callee.name='require'][arguments.0.value=/…/]` `[VERIFIED: both fire]`.
- Also ban `node:sqlite` and `better-sqlite3` outside `src/sqlite/` (not required by FND-07 text but it is the real enforcement of "SQLite access only through the kit").

### Pitfall 8: Parse-quality and BOM/CRLF conventions silently diverge
- Tree-sitter reports UTF-16 offsets for string input, so "bytes inside ERROR nodes" needs `Buffer.byteLength(src.slice(start, end))`; sum only outermost ERROR nodes (do not descend into one) and count MISSING nodes separately (zero width) `[VERIFIED: toy run, errBytes 7 of 85 total]`.
- A leading U+FEFF was absorbed by the toy grammar's `/\s/` extra; a real grammar may emit an ERROR for it. Decide once: strip a leading BOM before parsing and record `hadBom` (columns on line 0 then match what editors show) `[ASSUMED: recommendation, Open Question 4]`. CRLF is left in place (rows count `\n` only) `[VERIFIED]`.
- The negative parse-budget test needs a deliberately broken fixture kept **outside** the module's measured fixture set (e.g. `fixtures-negative/`), otherwise the real budget job fails.

### Pitfall 9: ADR ratification touches more files than the ADRs
- Renaming 8 `draft-*.md` files breaks ~50 relative links (README 28, other drafts, `docs/PRD.md` x2, `docs/DASHBOARD-METRICS.md` x2, `.planning/PROJECT.md` x1) `[VERIFIED: grep counts]`. Add a markdown-link-check test and update all references in the same commit.
- Literal `\1` corruption (lost text) exists at `docs/adr/draft-fact-model.md:17` (after "logical enum" sentence), `docs/adr/draft-language-modules.md:36` (`\1\n   - All of it runs…`) and `docs/adr/draft-trust-boundaries.md:24` (`\1 All of them start through one CommandRunner…`), plus `docs/PRD.md:193` and `docs/SDK-PROVIDERS.md:123` `[VERIFIED: grep -F '\1']`. The intended text cannot be recovered mechanically; the user should confirm the repaired wording (it is editorial, not an amendment).
- GitHub issue numbers share a sequence with PRs; PR #1 exists, so the first ADR issue will likely be #2. Do not hard-code numbers; the plan reads the number returned by `gh issue create`.
- ADRs are append-only: amendments are *added* sections titled with the date; status line changes from `Proposed` to `Accepted` and the `Issue:` line is filled in.

### Pitfall 10: The leftover root `package.json`/`node_modules` are not ours
`git status` shows untracked `package.json` (a single dependency `@opengsd/gsd-core ^1.17.0`), `package-lock.json` and `node_modules/` (express, MCP SDK, fallow…). They look like a gsd-core install. The project constraint forbids a gsd-core dependency. First plan task: confirm with the user, remove them, write the real `package.json`, add `.gitignore` (none exists: `node_modules/`, `dist/`, `coverage/`, `*.tgz`, `.tmp/`).

### Pitfall 11: Query predicates can run JS regexes
`#match?` predicates compile fine for catastrophic patterns (`(a+)+$` compiled without error) `[VERIFIED: compiled; runtime hang NOT tested]`. A hostile repo module's `.scm` could therefore stall a parse. Cap query file size and run parses under a time limit (`progressCallback`, Phase 2 worker). In Phase 1 only cap sizes (wasm, `.scm`, fixture file) and note the risk `[ASSUMED]`.

## Code Examples

### 1. Boundary lint generator (verified with 18 probe cases)
```javascript
// eslint.config.js  (plain ESM; export `patternsFor` for the fixture tests)
// Source: lab verified 2026-10-15, ESLint 10.12.0 + typescript-eslint 8.71.2
import tseslint from 'typescript-eslint';
export const MODULES = ['facts','sqlite','command-runner','source-tree','fact-store','grammar-engine',
  'precise-resolver','governor','lang','host-client','policy','cli','mcp-shim','test-kit'];
const SQLITE_OWNERS = ['fact-store','metrics','sdk','sqlite'];
const ADAPTERS = ['cli','mcp-shim'];
const CP = '(?:node:)?child_process';
const deepImport = (m) => ({ regex: `(^|/)${m}/(?!index\\.ts$).+`, message: `Import ${m} only through ${m}/index.ts.` });
const forbid = (m, message) => ({ regex: `(^|/)${m}(/|$)`, message });
export function patternsFor(mod) {
  const p = [];
  if (mod !== 'command-runner') p.push({ regex: `^${CP}$`, message: 'child_process only in src/command-runner.' });
  if (mod !== 'sqlite') p.push({ regex: '^(?:node:sqlite|better-sqlite3)$', message: 'SQLite drivers only in src/sqlite.' });
  for (const m of MODULES) if (m !== mod) p.push(deepImport(m));
  if (!SQLITE_OWNERS.includes(mod)) p.push(forbid('sqlite', 'src/sqlite is private to fact-store, metrics, sdk.'));
  if (ADAPTERS.includes(mod)) for (const m of MODULES) if (m !== mod && m !== 'host-client') p.push(forbid(m, 'Adapters import only host-client.'));
  if (mod === 'policy') { for (const m of MODULES) if (m !== mod && m !== 'facts') p.push(forbid(m, 'policy imports only facts/.')); p.push({ regex: '^(?!\\.)', message: 'policy is pure.' }); }
  return p;
}
const syntaxFor = (mod) => mod === 'command-runner' ? [] : [
  { selector: `ImportExpression[source.value=/^${CP}$/]`, message: 'child_process only in src/command-runner.' },
  { selector: `CallExpression[callee.name='require'][arguments.0.value=/^${CP}$/]`, message: 'child_process only in src/command-runner.' },
];
export default tseslint.config(
  { files: ['src/**/*.ts'], languageOptions: { parser: tseslint.parser } },
  ...[...MODULES, 'metrics', 'sdk'].map((mod) => ({
    files: [`src/${mod}/**/*.ts`],
    rules: { 'no-restricted-imports': ['error', { patterns: patternsFor(mod) }], 'no-restricted-syntax': ['error', ...syntaxFor(mod)] },
  })),
);
```
Fixture test shape (one per rule, plus positive controls), using the ESLint Node API with a virtual path (no file needs to exist):
```typescript
const [r] = await new ESLint({ cwd: root }).lintText(`import { spawn } from 'node:child_process';`,
  { filePath: path.join(root, 'src/fact-store/x.ts') });
assert.ok(r.messages.some((m) => m.ruleId === 'no-restricted-imports'));
```
Probe results (all PASS): child_process in fact-store fails, in command-runner passes; `node:sqlite` outside `src/sqlite` fails; `../sqlite/index.ts` from source-tree fails, from fact-store passes; deep import `../fact-store/writer/commit.ts` fails, `../fact-store/index.ts` passes; own-module relative import passes; policy importing fact-store or `node:fs` fails, facts passes; cli importing grammar-engine fails, host-client passes; dynamic `import('child_process')` fails.

### 2. Manifest schema to committed JSON Schema (verified)
```typescript
// Source: lab verified, zod 4.6.7 + ajv 8.20.0 (ajv/dist/2020)
import { z } from 'zod';
export const Manifest = z.strictObject({ schemaVersion: z.literal(1), name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  extensions: z.array(z.string().regex(/^\.[A-Za-z0-9]+$/)).min(1),
  parseBudget: z.number().min(0).max(1).default(0.005),
  precise: z.strictObject({ command: z.array(z.string()).min(1) }).optional(),
  tiers: z.array(z.enum(['grammar','precise','platform'])).default(['grammar']) });
// Publish the INPUT shape (what authors write). 'output' marks defaulted fields as required.
const schema = z.toJSONSchema(Manifest, { target: 'draft-2020-12', io: 'input' });
// io:'input' -> required ["schemaVersion","name","extensions"], additionalProperties:false
// io:'output' -> required also lists parseBudget and tiers  (wrong for authors)
```
Write with `JSON.stringify(schema, null, 2) + '\n'`, LF endings (`.gitattributes`), then `git diff --exit-code schemas/` in CI for the drift check.

### 3. Load, query, spans and ERROR bytes (verified end to end)
```typescript
// Source: lab verified, web-tree-sitter 0.27.1 on toy ABI-15 grammar
import { Parser, Language, Query } from 'web-tree-sitter';
await Parser.init();
const bytes = new Uint8Array(await fs.readFile(wasmPath));   // sha256 this against grammar.lock first
const lang = await Language.load(bytes);                      // lang.abiVersion === 15, lang.name === 'atlas_toy'
const parser = new Parser(); parser.setLanguage(lang);
const tree = parser.parse(text)!;                             // text: BOM-stripped JS string
try {
  const q = new Query(lang, scm);                             // throws QueryError {message:"Bad field name 'nme'"...}: surface as module diagnostic
  for (const c of q.captures(tree.rootNode)) { c.name; c.node.startPosition /* {row,column} 0-based, UTF-16 */; }
  let errBytes = 0;
  (function walk(n) { if (n.type === 'ERROR') { errBytes += Buffer.byteLength(text.slice(n.startIndex, n.endIndex)); return; }
                      for (const ch of n.children) walk(ch); })(tree.rootNode);
  q.delete();
} finally { tree.delete(); parser.delete(); }                 // every WASM object needs .delete()
```
Observed: CRLF file rows count `\n` only; `"a😀b"` at column 6..12; invalid wasm bytes throw `Error: need to see wasm magic number`; toy `.wasm` is 17,586 bytes; generate ~0.1 s, wasm build ~0.3 s warm.

### 4. Hardened, batched git hashing through the runner (verified pieces)
```typescript
// spec the Source Tree hands to the CommandRunner (argv array, never a shell)
const spec = { executable: 'git', builtinId: 'git',
  args: ['-C', worktree, '-c','core.fsmonitor=false', '-c','core.hooksPath=' + NULL_DEVICE, '-c','core.quotepath=off',
         ...neutralisedFilterArgs, 'hash-object', '--stdin-paths'],
  env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  stdin: lines(paths.filter(noNewline)), /* one path per line, '\n' separators */
  maxStdoutBytes: 64 * 1024 * 1024, timeoutMs: 120_000 };
// output: exactly one 40-hex (or 64-hex for sha256 repos) id per input line, in order
```
Tracked-clean files can use `git ls-files -s -z` instead of hashing; Phase 1 only needs the batched path for SC4.

### 5. tsconfig pair (verified with TypeScript 6.0.3)
```jsonc
// tsconfig.json (typecheck, includes tests)
{ "compilerOptions": { "target": "es2023", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true,
    "erasableSyntaxOnly": true, "verbatimModuleSyntax": true, "rewriteRelativeImportExtensions": true, "skipLibCheck": true, "types": ["node"] },
  "include": ["src", "scripts"] }
// tsconfig.build.json
{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src", "declaration": true },
  "include": ["src"], "exclude": ["src/**/*.test.ts", "src/**/contract.ts", "src/test-kit/**"] }
```
Verified: emit rewrites `../b/index.ts` to `../b/index.js`; `enum` fails with TS1294 under `erasableSyntaxOnly`; `node --test "src/**/*.test.ts"` runs the `.ts` tests with no loader on 24.15.0, 24.16.0 and 26.11.1. Note `scripts/` runs from `.ts` via type stripping and is not emitted.

### 6. CI skeleton (UNVERIFIED shape; SHAs verified)
Pinned actions (resolved 2026-10-15 with `gh api`): `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`, `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0`, `actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2`, `actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2`.
Jobs: `static` (ubuntu, Node 24.16.0: `npm ci --ignore-scripts`, lint, typecheck, `schema:build` + `git diff --exit-code schemas/`); `test` matrix `{ubuntu-latest, macos-latest, windows-latest} x {floor, 26}` (`npm ci --ignore-scripts`, build, test incl. driver conformance on both drivers and `lang test`, parse-budget script, `npm pack` + install tarball into temp dir + run both bins); `grammar` matrix 3 OS on Node 24 (`ensure-tree-sitter`, cache wasi/binaryen, `grammar:verify`). Top-level `permissions: contents: read`, `concurrency` with `cancel-in-progress`, trigger `pull_request` (never `pull_request_target`). The repo is private: macOS minutes bill ~10x and Windows ~2x `[CITED: PITFALLS C3; confirm against the org's plan]`, so cache npm and cancel superseded runs.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `eslint.config.ts` loaded by jiti | plain `eslint.config.js` | ESLint 9/10 | no extra dependency |
| Docker/emscripten for grammar WASM | `tree-sitter build --wasm` with auto-downloaded wasi-sdk | CLI 0.26+ (0.27.1 uses wasi-sdk 34.0) | no Docker, pinned toolchain via CLI version |
| `typescript@latest` is 6.x | `latest` is 7.0.2 with no supported API | 2026-07-08 | pin `~6.0.3`, never `^`/`latest` |
| npm runs dependency install scripts | npm 11.20 blocks by default (`allowScripts`) | npm 11.20 | CLI fetch must be explicit |
| MCP protocol sessions | stateless (spec 2026-07-28) | 2026-07-28 | not used in Phase 1 (stub only) |

**Deprecated/outdated:** `tree-sitter-wasms` third-party bundles (excluded by A48), `google-protobuf` (not needed now), `child_process.spawn` of npm shims on Windows.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Grammar WASM built on ubuntu/windows hosts is byte-identical to the macOS build for the same inputs | Pitfall 1 | D-07's 3-OS hash gate fails; needs a per-platform hash or canonical-OS design |
| A2 | Windows runners include `tar.exe` supporting `--strip-components` and the tree-sitter cache lives under the local-app-data directory | Pitfall 1 | wasi-sdk extraction fails on Windows; mitigate with pre-fetched `TREE_SITTER_*_PATH` |
| A3 | Windows runner system git config may set `core.autocrlf=true` | Pitfall 5 | CRLF hash expectations differ if not isolated; isolation is cheap either way |
| A4 | Replacing a child env wholesale breaks Windows process start | Pitfall 5 | runner env policy must inherit-then-overlay |
| A5 | `node --test` glob quoting with double quotes behaves identically in cmd.exe/PowerShell | Anti-Patterns | test script fails on Windows; fix is a small `scripts/test.ts` runner |
| A6 | Recommended: minimal in-process HostClient serving `lang_list`/`lang_test`, with `src/bin` as composition root | Pattern 4 | if rejected, `cli` imports `lang/` directly and the adapter lint rule is exercised only by fixtures |
| A7 | Recommended span convention: 0-based line + 0-based UTF-16 column internally | Pattern 5 | mixing conventions later breaks citations; low cost to fix now |
| A8 | Recommended BOM policy: strip leading U+FEFF before parse and record `hadBom` | Pitfall 8 | goldens would encode BOM columns differently; decide before writing goldens |
| A9 | Hostile `.scm` `#match?` regex can stall a parse (ReDoS) | Pitfall 11 | Phase 2 time limits already planned; only matters if Phase 1 runs untrusted queries unbounded |
| A10 | User-level config dir is `~/.config/gsd-atlas` on every OS including Windows (no `%APPDATA%`) | Open Question 6 | docs only say `~/.config/gsd-atlas/`; Windows convention could differ |
| A11 | GitHub private-repo minute multipliers (macOS 10x, Windows 2x) apply to this org | Code Examples 6 | CI cost; no technical impact |
| A12 | Upstream grammar licences (typescript, javascript, python, swift) are MIT | Security | only relevant when real grammars land (Phases 2/3/5); `grammar.lock.license` field enforces the check |

## Open Questions (RESOLVED)

All nine questions below carry a disposition and an owner. Dispositions were checked against the Phase 1 plans on 2026-10-15 (revision pass); "gate" means the plan contains a blocking checkpoint or CI evidence step that produces the answer at execution time, and the question is resolved because ownership and the decision rule are fixed, not because the evidence already exists.

1. **Node floor 24.15.0 vs the verified NUL-truncation bug (conflicts with locked D-13 / FND-02 wording).**
   - Known: v24.15.0 truncates TEXT at NUL; v24.16.0 fixed `[VERIFIED]`. Driver conformance (D-09) will fail on the floor lane.
   - Unclear: whether the user prefers raising the floor (recommended: `>=24.16.0`, lanes 24.16.0 + 26) or keeping 24.15.0 with a refusal self-test lane.
   - Recommendation: ask the user before plan sign-off; either way add the NUL round-trip self-test to the driver layer.
   - RESOLVED (user decision, 2026-10-15): the floor is Node 24.16.0 and the CI lanes are 24.16.0 and 26. Owners: plan 01-01 (`engines.node >=24.16.0`), plan 01-03 (CI matrix), plan 01-10 (open-time NUL round-trip self-test, `DriverUnsupportedError` code `nul_truncation`, contract case on both drivers), plan 01-08 Task 4 (D-13 amendment block in 01-CONTEXT.md, REQUIREMENTS.md FND-02 wording, PROJECT.md constraint and Key Decisions row).
2. **Cross-OS WASM hash parity (D-07).** Unverifiable locally. Plan a throwaway spike on the first CI push and a decision gate (see Pitfall 1). If hashes diverge, D-07 needs a user decision.
   - RESOLVED (gate): plan 01-07 builds the throwaway `grammar-hash-parity` workflow and the 3-OS `grammar:verify` job; plan 01-15 pushes (after human approval), compares the per-OS sha256 values with `grammar.lock`, records assumption A1 as confirmed, or escalates a divergence to the user with the three options (per-platform hash map, canonical-OS hash, investigate); plan 01-16 removes the throwaway workflow once the result is recorded.
3. **Manifest field list: D-04 vs PRD/ADR.** D-04 lists `name, schemaVersion, extensions, grammar, queries, tiers, parseBudget, precise`. PRD §4.2 uses `id, version, extensions, grammar.wasm/source, queries.{tags,refs,imports}, project.markers, precise`; the language-modules ADR also requires `features.json`, test globs and `replace` (extension collisions "fail loudly unless `replace`"). Because unknown fields are rejected and later changes need a `schemaVersion` bump, the v1 field set must be settled in Phase 1. Recommendation: keep D-04's names, add `version`, `testGlobs`, `project.markers`, `replace`, `features` (path), `queries` as an object `{tags, refs?, imports?}`, and decide whether `name` equals the folder / `gsd-atlas-lang-<name>` package suffix.
   - RESOLVED (gate): plan 01-06 Task 1 is a blocking human decision between option-a (D-04 names exactly) and option-b (D-04 plus the additive optional fields above, recommended); it has no auto-selected default. Tasks 2 and 3 implement exactly the chosen list. `name` must equal the module folder name, enforced by plan 01-17 (`name_mismatch` diagnostic).
4. **BOM and CRLF text policy** for goldens (Pitfall 8, A8). Recommend strip BOM, keep CRLF, columns UTF-16, document in `facts/`.
   - RESOLVED (adopted as recommended): the policy is documented in the `Span` JSDoc in `src/facts` (plan 01-04); the Grammar Engine strips a leading U+FEFF before parsing and reports `hadBom` while leaving CRLF in place (plan 01-12); fixtures keep exact CRLF and BOM bytes through `.gitattributes` `test/fixtures/** -text` (plan 01-01) and byte-exact generation (plan 01-07); goldens carry hand-verified numbers (plan 01-14).
5. **Additional ADR amendments beyond D-16 that research recommends** (each needs the user's OK because D-16 names exactly three): (a) command-runner/trust-boundaries: git filter-driver and fsmonitor hardening (Pitfall 3); (b) language-modules decision 6 says the budget is "≤ 0.5 % of files" while D-06 measures bytes in ERROR nodes, so the ADR text must change; (c) sqlite-store: Node floor and the startup NUL self-test; (d) editorial repair of the `\1` corruption (Pitfall 9, not an amendment).
   - RESOLVED (gate for a to c, adopted for d): plan 01-08 Task 1 is a blocking human decision (core-only or core-plus-recommended, or a named subset of a, b, c) and Task 4 applies exactly the selection as dated amendments; items (a) to (c) are implemented in code by plans 01-13, 01-12 and 01-10 regardless. Item (d) is an editorial repair, not an amendment, done in plan 01-02 Task 3 with an end-of-phase human review. The two amendments D-16 assigns to Phase 2 (writer contention, metrics migrations) are tracked as FND-12.
6. **User config directory on Windows.** Docs say `~/.config/gsd-atlas/` only. Recommend `os.homedir()/.config/gsd-atlas` everywhere, overridable by an injected path for tests.
   - RESOLVED (adopted as recommended): plan 01-17 makes the composition root (`src/bin`) derive the user directory as `GSD_ATLAS_USER_DIR` or `<os.homedir()>/.config/gsd-atlas` on every OS including Windows (assumption A10 stands until CI shows otherwise); the registry itself receives plain absolute roots and never reads `os.homedir`, so tests inject temp directories. Plan 01-09 only names the `permissions.commands` key and path in denial messages; reading that file is Phase 3 (SEC-01, SEC-02).
7. **Corpus manifest contents.** Pin gsd-core (default branch `next`), gsd-pi (`main`), gsd-path (`main`); candidate SHAs on 2026-10-15: gsd-core `10ac3a7a947903ba50f538a907af036744d759d5`, gsd-pi `bb86b6ca2d3d047899092d845d574beeb5a21965`, gsd-path `73bf62e34f1adb8e9d86ae43378c8dd1200539bc` (also gsd-graph `b105e4deb1fc3aaafba2cb65f4dfa6405597f799` for the PRD criterion-16 reference set) `[VERIFIED: gh api repos/open-gsd/<r>/commits/<branch>]`. The Swift reference app is not chosen until Phase 5 (SWF-05): allow a schema entry with `status: "unselected"` and no SHA, or the manifest cannot be "pinned" for it now. The earlier research measurements used unrecorded SHAs, so numbers must be re-measured at the pinned SHAs in Phase 2/3.
   - RESOLVED (adopted as recommended): plan 01-05 commits `corpora/corpora.json` with those four pins plus a `swift-reference-app` entry with `status` `unselected` and null repo, ref and sha (rejected by the validator if it carries a SHA), and its README tells Phases 2 and 3 to re-measure at the pinned SHAs.
8. **Where the fixture module lives and whether any built-in ships in Phase 1.** Recommend `test/fixtures/` plus injected roots, no shipped built-in (nothing real to ship yet). `lang list` then reports an empty built-in tier on a clean install, which is correct.
   - RESOLVED (adopted as recommended): the toy module lives at `test/fixtures/modules/toy/` (plan 01-07); the registry takes injected roots and the default built-in directory is `<package root>/modules` only when it exists, which in Phase 1 it does not (plan 01-17); plan 01-16 asserts that `lang list` on empty roots reports no modules from the installed tarball.
9. **`gsd-atlas-mcp` stub behaviour.** Must run; recommend printing a one-line "MCP server arrives in Phase 2" to stderr and exiting 1 (K22: 1 = usage/unknown). Exit-code vocabulary borrowed from gsd-graph: `GraphError build_locked → 3`, other `GraphError → 2`, usage/unknown → 1 `[CITED: gsd-graph src/cli.ts:83-93 via gh api]`.
   - RESOLVED (adopted as recommended, vocabulary narrowed to what exists): plan 01-01 Task 4 makes `gsd-atlas-mcp` write the one-line Phase 2 notice to stderr and exit 1; plan 01-14 fixes the CLI exit codes at 0 ok, 1 usage error or unknown target, 2 any other failure. The `build_locked` code 3 is not used because Phase 1 has no build; Phase 2 adds it when the build lock exists.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | yes | 26.11.1 (local); 24.15.0 and 24.16.0 binaries downloaded to scratchpad for testing | CI provides floor lane |
| npm | install | yes | 11.20.0 | `--ignore-scripts` uniformly |
| git | Source Tree, tests, ADR rename | yes | 2.54.0 (Apple Git) | none needed |
| gh CLI | ADR issues (D-15), SHAs | yes | authenticated as `trek-e`; repo `open-gsd/gsd-atlas` private, issues enabled, 0 issues | none |
| wasi-sdk 34.0 + binaryen 132 | grammar build | yes (macOS cache `~/.cache/tree-sitter`) | 34.0 / 132 | CLI downloads per host on CI |
| Docker daemon | cross-OS repro experiments | no (CLI installed, daemon not running) | n/a | CI spike |
| Linux and Windows hosts | platform verification | no | n/a | three-OS CI is the only check (STATE blocker) |
| Rosetta | x64 experiments | no | n/a | none |
| GitHub Actions on `open-gsd/gsd-atlas` | FND-01 | assumed enabled | n/a | confirm in first plan task |

**Missing with no fallback:** none blocking planning. Linux/Windows facts are deferred to the first CI run.
**Missing with fallback:** Docker/Rosetta (use CI spike).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` (built in) + `c8` 12.0.0 for coverage; ESLint API used inside tests |
| Config file | none (Wave 0 creates `package.json` scripts, `tsconfig.json`, `eslint.config.js`) |
| Quick run command | `node --test "src/<module>/**/*.test.ts"` |
| Full suite command | `npm test` (= `node --test "src/**/*.test.ts" "scripts/**/*.test.ts"`) |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FND-01 | workflow runs lint/test on 3 OS, SHAs pinned | static + CI | `node --test scripts/ci-config.test.ts` (regex: every `uses:` is 40-hex + comment; matrix lists the three runners) and `gh run list` on the PR | Wave 0 |
| FND-02 | package name, bins, engines, `files`; tarball runs | unit + smoke | `node --test scripts/package.test.ts` (parses `npm pack --dry-run --json`, then installs tarball in temp dir and runs both bins) | Wave 0 |
| FND-03 | strict manifest, invalid module skipped, schema parity and drift | unit | `node --test src/lang/manifest.test.ts src/lang/schema-parity.test.ts`; `npm run schema:build && git diff --exit-code schemas/` | Wave 0 |
| FND-04 | grammar rebuild reproduces pinned hash | integration (needs wasi-sdk) | `npm run grammar:verify` (CI grammar job x3 OS; not in `npm test`) | Wave 0 |
| FND-05 | each seam: interface + double/conformance | contract | `node --test "src/{fact-store,source-tree,command-runner,grammar-engine,precise-resolver,governor,sqlite}/**/*.test.ts"` | Wave 0 |
| FND-06 | no spawn outside runner; batch hash; hostile repo | unit + integration | `node --test src/command-runner/hostile-repo.test.ts` (recording fake asserts zero foreign spawns; real git run asserts marker files absent; one batched `hash-object --stdin-paths` over a snapshot) | Wave 0 |
| FND-07 | each of 5 rules fails a deliberate violation; positive controls pass | unit | `node --test src/lint/boundaries.test.ts` (ESLint `lintText`, one case per rule) | Wave 0 |
| FND-08 | corpus manifest valid, SHAs 40/64 hex, unique ids | unit | `node --test scripts/corpus.test.ts` (+ optional online `gh api` check script, not in default suite) | Wave 0 |
| FND-09 | 8 ADRs renamed `<n>-<slug>.md`, Accepted, links resolve, schedule present | unit | `node --test scripts/adr.test.ts` (+ manual `gh issue view` confirmation) | Wave 0 |
| FND-10 | dated amendment sections present in the named ADRs | unit | `node --test scripts/adr.test.ts` | Wave 0 |
| FND-11 | `lang test` e2e on fixture module, goldens match, mismatch exits non-zero | e2e | `node --test src/lang/lang-test.e2e.test.ts` (spawns built or stripped CLI via `process.execPath`) | Wave 0 |
| LNG-01 | precedence across 4 locations, shadowed copies listed, collisions loud, invalid skipped | integration | `node --test src/lang/registry.test.ts` | Wave 0 |
| LNG-06 | ERROR bytes measured; budget exceeded fails; clean fixtures within budget | unit + script | `node --test src/grammar-engine/measure.test.ts`; `npm run grammar:budget` | Wave 0 |

### Sampling Rate
- **Per task commit:** the quick command for the touched module (target < 30 s; each module suite is small).
- **Per wave merge:** `npm run lint && npm run typecheck && npm test`.
- **Phase gate:** full suite green locally, then a green CI run on ubuntu/macos/windows x floor/26, green `grammar:verify` on all three OSes, before `/gsd-verify-work`.

### Wave 0 Gaps
Everything is a gap (greenfield): `package.json`, `tsconfig*.json`, `eslint.config.js`, `.gitignore`, `.gitattributes`, `.github/workflows/ci.yml`, `src/test-kit/` (FakeClock, temp-git-repo builder with config isolation, Windows-safe tmpdir cleanup), every `contract.ts`/`*.test.ts` above, `scripts/*.ts`, and the throwaway grammar-hash-parity workflow. Framework install: `npm ci --ignore-scripts`.

## Security Domain

`security_enforcement` is enabled (absent = enabled), ASVS level 1, block on high (`.planning/config.json`).

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | no network surface in Phase 1 |
| V3 Session Management | no | stateless; no sessions |
| V4 Access Control | yes (permission model) | CommandRunner `decide()`: only exact built-in specs run; repo config/modules can never grant; denials produce diagnostics |
| V5 Input Validation | yes | Zod strict manifest; path confinement of manifest-referenced files (reject absolute paths, `..`, symlink escape via `realpath` containment); size caps on wasm, `.scm`, fixtures |
| V6 Cryptography | yes (integrity only) | `node:crypto` sha256 for wasm vs `grammar.lock`; never hand-roll |
| V10 Malicious code / V14 Config | yes | exact-pin deps, committed lockfile, `--ignore-scripts`, Actions pinned to SHAs, `permissions: contents: read`, no `pull_request_target`, `persist-credentials: false` |
| V12 Files | yes | module folders are untrusted data; WASM runs sandboxed; never execute anything from a module |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Hostile repo config enabling commands / module `precise.command` | Elevation | `decide()` ignores repo config; `lang list` shows `precise` inactive "command not approved"; hostile-repo test (SEC-01 is Phase 3, but the Phase 1 test establishes the mechanism) |
| Poisoned `.git/config` (filter driver, fsmonitor, hooksPath) executes code during git calls | Elevation | `-c` overrides and filter neutralisation in the git spec (Pitfall 3) |
| Manifest path traversal (`grammar.wasm: "../../x"`, symlinks) | Tampering / Info disclosure | resolve against module dir, `realpath` containment check, reject otherwise |
| Oversized or malformed WASM / queries | DoS | file size caps, `QueryError`/`Language.load` errors become diagnostics, never crash; ReDoS-prone `#match?` noted for Phase 2 limits |
| Supply chain (npm, binary download by `tree-sitter-cli`, GitHub Actions) | Tampering | exact pins + lockfile, single human-verify install gate, Actions by SHA; consider verifying the downloaded CLI binary sha256 in `ensure-tree-sitter` `[ASSUMED]` |
| Shell injection via argv | Tampering | argv arrays only, `shell: false`, no `.cmd`/`.bat`, executable resolved to absolute path |
| Token/secret leakage in CI logs | Info disclosure | no secrets used in Phase 1 workflows |

## Sources

### Primary (HIGH confidence)
- Local labs, 2026-10-15 (scratchpad `…/7cdf2a29-0c44-4393-86ba-74ce658475a5/scratchpad/{lab1,lab2,toyA,a,g1,g2,node24}`): tree-sitter CLI install/build/determinism, web-tree-sitter load/query/ERROR measure, node:sqlite on 24.15.0/24.16.0/26.11.1, better-sqlite3 13.0.3 with `--ignore-scripts`, TypeScript 6.0.3 tsconfig, ESLint 10.12.0 boundary generator, Zod/Ajv parity, c8, git hash-object/ls-files/status behaviours.
- `https://raw.githubusercontent.com/tree-sitter/tree-sitter/v0.27.1/crates/loader/src/loader.rs`, `wasi-sdk-version` (34.0), `binaryen-version` (132): toolchain pins, platform matrix, env override names, build command lines.
- `npm view` registry data (versions, engines, peers, scripts, `time.created`) and `https://nodejs.org/dist/index.json` (Node/npm bundles).
- `gh api` for action release tags/SHAs, repo state (`open-gsd/gsd-atlas`), corpus repo head SHAs, `actions/checkout` PR #2425 and v7.0.1 notes.
- `npm help install-scripts` (npm 11.20) for `allowScripts` semantics.
- Project docs read this session: CONTEXT.md, REQUIREMENTS.md, STATE.md, ROADMAP.md (Phase 1 + schedule), ARCHITECTURE.md, PITFALLS.md (B1-B8, C2-C3), SUMMARY.md, STACK.md (via `.claude/CLAUDE.md`), docs/PRD.md §4, docs/adr/{command-runner,language-modules,fact-store-interface,tenant-composition,product-boundary,trust-boundaries,fact-model,sqlite-store}.md, docs/adr/README.md.

### Secondary (MEDIUM confidence)
- `https://eslint.org/docs/latest/use/configure/configuration-files` (TS config loading needs jiti or experimental flag).
- gsd-graph `src/cli.ts:83-93` and `src/errors.ts` via `gh api` (exit-code mapping, reason-code style).
- gsd-core `.github/workflows/test.yml` (Windows checkout pin comment, SHA-pin style).

### Tertiary (LOW confidence)
- Windows/Linux runner behaviours listed in the Assumptions Log (A1-A5, A11): unverified until the first CI run.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, all versions registry-verified and exercised locally on macOS arm64.
- Architecture: MEDIUM-HIGH, derived from ADRs/ARCHITECTURE.md; the minimal HostClient and fixture location are recommendations.
- Pitfalls: HIGH for items marked VERIFIED (Node 24.15 NUL, git code execution, CLI binary, TS 6 types, flat-config behaviour); MEDIUM for Windows items until CI runs.

**Research date:** 2026-10-15
**Valid until:** 2026-10-22 for npm/GitHub facts (fast-moving: TypeScript 7.1, Node 24.x patch releases, action versions); design-level findings stable for 30 days.
