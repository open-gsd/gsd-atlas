<!-- GSD:project-start source:PROJECT.md -->

## Project

**gsd-atlas**

gsd-atlas is a local, MIT-licensed map of a codebase and the platform SDKs it targets, built for coding agents. It serves cited, current code facts (definitions, references, imports, inheritance, ADR citations) and installed-SDK facts (APIs with the OS version each was introduced or deprecated) over MCP, a CLI and an Agent Skill. It is a sibling of gsd-graph, not part of it. Package `@opengsd/gsd-atlas`, CLI `gsd-atlas`, MCP shim `gsd-atlas-mcp`.

**Core Value:** Agents get correct, cited, current answers about the code and the platform they are building against, instead of guessing from stale training data or sweeping the repo with grep.

### Constraints

- **Tech stack**: TypeScript, Node >= 24, SQLite via `node:sqlite` with `better-sqlite3` kept working as fallback — A13, A3
- **Repo layout**: Single npm package `@opengsd/gsd-atlas` with bins `gsd-atlas` and `gsd-atlas-mcp`; language modules under `modules/` and publishable later — chosen for MVP simplicity
- **Platforms**: macOS, Linux and Windows are 1.0 platforms, in every budget's CI run from M1 — GSD users run all three, and gsd-core's Windows CI is a known pain point
- **Privacy**: No network by default, no telemetry; permissions only from user-level config (`~/.config/gsd-atlas/`); repo text fenced as untrusted — trust-boundaries ADR
- **Host coupling**: No dependency on gsd-core, gsd-graph or `.planning/`; gsd-core is a validation corpus only — A14
- **Licensing**: MIT; vet licenses of pinned upstream grammars and any OKF spec before use
- **Determinism of measurement**: Pin each eval corpus to a commit SHA so accuracy and eval numbers are comparable across runs
- **Mac-only gates**: Criteria 6 and 15 need Xcode 27; GitHub macOS runners may lack it, so these are local/self-attested gates, with SDK packs (U7) covering Linux CI
- **Unstable dependencies**: TypeScript 7 `unstable/sync` API and `node:sqlite` are pinned and tested per minor release
- **Capacity**: Solo builder plus agents; phases kept fine-grained

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Findings that change plans (read first)

| # | Finding | Impact |
|---|---------|--------|
| 1 | **MCP TypeScript SDK v2 is stable (2.3.1, released 2026-07-27) and implements spec 2026-07-28, which removes protocol sessions and `initialize`; Roots are deprecated.** v1.32.1 (`@modelcontextprotocol/sdk`) is only in security-fix mode. **[verified]** a v2 server on a Unix socket served a 2025-06-18 `initialize` + `tools/list` statelessly, with no session id. | Build on v2. Reword A27/A37 wherever they assume "MCP session" or "MCP roots": the agent's repo/cwd must arrive as an explicit tool argument, hook payload field or `_meta`, and the session ledger key must come from hook payloads, not `Mcp-Session-Id`. A23 "stateless requests" now matches the protocol. |
| 2 | **v2's HTTP handler does NOT validate `Host`/`Origin`.** **[verified]** (`Host: evil.example` was served.) Validators are separate: `localhostHostValidation()`, `localhostOriginValidation()` in `@modelcontextprotocol/node`. | A27's token + Host/Origin checks must be implemented in Host, not assumed from the SDK. |
| 3 | **TypeScript 7.0.2 is `latest` on npm and ships NO supported API.** The package exports `typescript/unstable/sync|async` (works, **[verified]**), but Microsoft's announcement says "it does not ship with an API" and that 7.1 ships "a new (and different) API". **[verified]** `typescript@next` (7.1.0-dev.20261015.1) has already renamed the subpath to `typescript/sync` and refactored internals. Also `npm i typescript` in a user's repo now gives 7.x with no classic `createProgram`/`createLanguageService`. | The classic 6.x adapter is the MVP; the 7.x adapter must feature-detect subpaths (`unstable/sync` then `sync`), be pinned per minor, and be treated as a late, replaceable adapter. Ship our own `typescript` 6.0.3 as the fallback. |
| 4 | **tree-sitter-swift is the weakest link.** Release 0.7.3 (GitHub tarball; npm is stuck on 0.7.1 from 2025-06) failed to parse **11.8% (80/680)** and **6.9% (15/217)** of two real local Swift 6 codebases. Upstream `main` @ 9e3b87f (2026-10-13) drops that to **2.4% / 1.8%**, but its `scanner.c` calls `fprintf(stderr, ...)`, which makes the WASM fail to load in web-tree-sitter ("bad export type for 'stderr'") until patched. **[verified]** | The A48 budget (<= 0.5% parse-error files per module) is not achievable for Swift today without a patch queue. M3 needs a pinned upstream commit + our own patches + an upstream contribution plan, and a Swift-specific measured budget. |
| 5 | **tree-sitter-typescript 0.23.2 is the final upstream release (Nov 2024) and lacks newer syntax.** **[verified]** parse failures: `accessor` fields, `export type * from`, `interface I<in out T>`, `import defer`/`import source`, `for (using x of xs)`. Real corpora: gsd-core `src/` 0/270 files, gsd-pi 13/3,886 (0.33%), gsd-core tracked `.cjs` 6/1,338 (0.45%, same for the JavaScript grammar). | A48 is right to build from pinned upstream; add a grammar patch queue (patches applied over the pinned tarball before `tree-sitter generate`/`build`). Budget is tight but met on today's corpora. |
| 6 | **A GitHub-hosted Xcode 27 runner exists (`runs-on: xcode-27`, arm64, public preview)** with iOS 27.0/27.1/27.2 SDKs. | PROJECT.md's "Mac-only gates are local/self-attested" can become CI-run (criteria 6 and 15), at least as an allowed-to-fail preview lane. |
| 7 | **npm 11.20 blocks dependency install scripts by default** (`allowScripts` in package.json; `npm install -g` needs `--allow-scripts`). In this run `@parcel/watcher` and `tree-sitter-cli` printed the "not covered by allowScripts" warning yet still worked. | Runtime dependencies must work with scripts disabled. better-sqlite3 13 and web-tree-sitter qualify (no install script). `@parcel/watcher` works because its binaries are optional-dependency packages. Add `allowScripts` for the dev-only `tree-sitter-cli`. |
| 8 | **Node 26 becomes LTS on 2026-10-28; Node 24 goes to maintenance on 2026-10-20; Node 22 ends 2027-04-30.** `node:sqlite` is Stability 1.2 (release candidate) since v25.7.0, backported to 24.15; **no ExperimentalWarning and no flag** on 24.22.0 and 26.12.0. **[verified]** | A13 holds. Declare a floor of Node 24.16 (see below) and test 24 and 26. |
| 9 | **Unix socket paths have a hard length limit.** **[verified]** a 130-char path under `$TMPDIR` failed (`curl: Unix socket path too long`); macOS limit is 104, Linux 108. | `~/.cache/gsd-atlas/host-<major>/host.sock` is fine, but tests and `store.dir` overrides under long temp dirs will break; Host must check the length and fall back to a short hashed path. |
| 10 | web-tree-sitter offsets are **UTF-16 code units**, not bytes. **[verified]** (`startIndex` 17 vs UTF-8 byte offset 20 for text with an emoji.) | Store spans as (line, column in UTF-16 units) like TypeScript's compiler; convert when importing SCIP (`Document.position_encoding`) and when mapping to blob byte offsets (A19). |

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| Node.js | `engines: ">=24.16.0"`; CI 24.16.0 (floor), 24 latest (24.22.0 today), 26 latest (26.12.0) | Runtime | 24.15 is where `node:sqlite` reached release-candidate status. Type stripping is stable (24.12+), so dev and tests run `.ts` directly. Node 26 is LTS from 2026-10-28; this machine runs 26.11.1. | HIGH |
| TypeScript | `~6.0.3` (repo compiler and linter peer), plus alias dev dep `typescript-7: npm:typescript@7.0.2` for adapter tests | Type check + emit | 6.0.3 is the last classic-API release and is what gsd-core uses. typescript-eslint 8.71.2 requires `typescript <6.1.0`, so the repo cannot move to 7 for lint yet. | HIGH |
| `node:sqlite` | built in (SQLite 3.53.4 on Node 24.22, 3.54.0 on 26.12) | Fact Store driver (A3) | **[verified]** on 24.22 and 26.12: WAL + `synchronous=NORMAL`, `readOnly` connections, `allowExtension: true` + `loadExtension` (throws `ERR_LOAD_SQLITE_EXTENSION`), `timeout` (busy), `defensive` on by default, `limits`, `backup()`, `serialize`, `FTS5` with `tokenize='trigram'`, JSON, math, RTREE, SESSION compiled in. | HIGH |
| `better-sqlite3` | 13.0.3 (exact in CI), optional peer | Fallback driver (A3, A13) | MIT, `engines node >=22`. v13 ships N-API prebuilds for win32/darwin/linux x64+arm64 and musl inside the tarball, `gypfile: false`, no install script, SQLite 3.53.4. Runs the same Fact Store contract suite in CI. | HIGH |
| web-tree-sitter | **0.27.1 exact** | WASM parser runtime (A6, A48) | ESM + CJS, loads ABI 14 and 15 grammars **[verified]**. API: `await Parser.init()`, `Language.load(pathOrBytes)`, `parser.parse(str, oldTree, {progressCallback})` (replaces the old timeout), `Query` with `matches/captures` and `matchLimit`. Everything holding WASM memory needs `.delete()` (Parser, Tree, Query, TreeCursor). | HIGH |
| tree-sitter-cli | **0.27.1 exact, dev only** (must equal web-tree-sitter) | Grammar build (A48) | `tree-sitter build --wasm` downloads wasi-sdk + binaryen itself; no Docker, no emscripten. **[verified]** TS grammar builds in ~8 s (1.4 MB), Swift in ~5 s (3.7 MB), and two builds are byte-identical (same sha256). | HIGH |
| `@modelcontextprotocol/server` | 2.3.1 | MCP server (stdio + Streamable HTTP) | See Finding 1. Exports `McpServer`, `createMcpHandler(buildServer, {legacy})`, `isLegacyRequest`, `legacyStatelessFallback`; `/stdio` subpath exports `serveStdio`, `StdioServerTransport`. Node 20+, ESM-first with CJS build. | HIGH |
| `@modelcontextprotocol/node` | 2.1.1 | Node `http` adapter | `toNodeHandler(handler)` plugs into `http.createServer(...).listen(socketPath)`. **[verified]** works on a Unix domain socket. Also `localhostHostValidation`, `localhostOriginValidation`. Pulls in `hono` + `@hono/node-server` (about 3 MB). | HIGH |
| zod | 4.6.7 | Schemas for MCP tools (required, >=4.2), manifest, config | Already a hard dependency of the v2 SDK, so a single validation library. `z.toJSONSchema(schema, {target: 'draft-2020-12'})` **[verified]** emits the published JSON Schemas. | HIGH |
| `@parcel/watcher` | 2.6.0 | File watcher (Indexer) | Native FSEvents / inotify / ReadDirectoryChangesW, prebuilt as optional-dependency packages (darwin, win32, linux glibc+musl, arm64). **[verified]** live events and `writeSnapshot` + `getEventsSince`, which lets the Indexer replay what changed while the host was down (feeds Reconcile, A21). | MEDIUM-HIGH |
| `@bufbuild/protobuf` | 2.16.0 | SCIP index decoding (M5) | Maintained, typed, ESM; replaces `google-protobuf`, which the official SCIP bindings use. | MEDIUM-HIGH |
| `node:worker_threads` | built in | Parser pool, read pool, compiler pool | The Governor (A61) owns scheduling, so use raw workers, not a pool library. Each worker opens its own `DatabaseSync` and calls `Parser.init()` once. | HIGH |

### Grammar pins (A48, built by our pipeline, never third-party WASM)

| Grammar | Pin | Source of pin | Parse-error evidence **[verified]** | Notes |
|---------|-----|---------------|-------------------------------------|-------|
| tree-sitter-typescript (`typescript`, `tsx`) | 0.23.2 (tag `v0.23.2`) | npm tarball includes generated `src/parser.c` | gsd-core `src/` 0/270; gsd-pi `.ts` 13/3,886 (0.33%) | Upstream idle since Jan 2025. Known gaps in Finding 5. To build `tsx` copy the whole package (it includes `../common`), not just `tsx/`. |
| tree-sitter-javascript | 0.25.0 | npm tarball | gsd-core tracked `.cjs` 6/1,338 (0.45%); same count as the TS grammar | Use for `.js/.cjs/.mjs/.jsx` so JS stays JS. |
| tree-sitter-python | 0.25.0 | npm tarball (ships `parser.c`) | 0 errors on 13,341 local `.py` files | Needed for the M5 bring-your-own proof. |
| tree-sitter-swift (alex-pinkus) | **do not use npm 0.7.1.** Pin a git commit of `main` (tested: 9e3b87f, 2026-10-13); release 0.7.3 (2026-06-01) only as a floor | GitHub. `main` has no committed `parser.c`; run `tree-sitter generate` (fast, about 1 s) and then patch `scanner.c` to remove `fprintf(stderr, ...)` | 0.7.3: 11.8% / 6.9% error files. main + scanner patch: 2.4% / 1.8% | Remaining failures: `nonisolated(unsafe) let`, attributes like `@Model`/`@_silgen_name` on some statements, regex literals, `override ?? default` forms. Plan a patch queue and upstream PRs. Upstream is active (commits within days). |

### Database

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| SQLite via `node:sqlite` | bundled | Per-repo store, shared `sdk.db`/`pkg.db`, metrics db | See above. Write a thin Fact Store driver layer over both drivers that supplies what `node:sqlite` lacks: no `.pragma()` helper, no `.transaction()` (use `BEGIN IMMEDIATE`/`SAVEPOINT`), rows are null-prototype objects (normalise before `deepStrictEqual`), and integers beyond 2^53 throw unless `readBigInts`. |
| `sqlite-vec` | 0.1.9 (post-1.0 only, A15) | Vectors | Loaded through `allowExtension: true` + `loadExtension`; do not enable extension loading in 1.0 builds. |

### Infrastructure (CI, release)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| GitHub Actions runners | `ubuntu-latest` (24.04), `macos-latest` (macOS 26 arm64), `windows-latest` (Windows Server 2025); optional `ubuntu-24.04-arm`, `windows-11-arm`; Xcode lane `xcode-27` (public preview, arm64) | Three-OS matrix from M1 (A13) | Runner images preinstall Node 24.20 to 24.21; use `setup-node` to get the exact floor and Node 26. macOS 14 is being retired (unsupported by 2026-11-02): do not use. |
| `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/cache` v6.1.0, `actions/upload-artifact` v7.0.2, `actions/download-artifact` v8.0.2 | as listed | Workflow steps | Pin to commit SHAs with a version comment, as gsd-core does. |
| npm publish with provenance | npm 11.x | Release | Single package, two bins. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `typescript` (our fallback, aliased e.g. `typescript-6: npm:typescript@6.0.3`) | 6.0.3 | Classic adapter fallback when the project has no usable `typescript` | Always bundled (PRD: "fallback: bundled"). Do not use `@typescript/typescript6` for this: it stops at 6.0.2. |
| typescript 7 native API (project's own `typescript@7.x`) | 7.0.2 today | 7.x adapter | Probe order: `typescript/unstable/sync` (7.0.x) then `typescript/sync` (7.1+). **[verified]** 7.0.2: `new API({cwd})`, `updateSnapshot({openProject})`, `checker.getSymbolAtPosition(file,pos)`, `getReferencedSymbolsForNode`, `getReferencesToSymbolInFile`. It spawns a platform-native binary (`@typescript/typescript-<os>-<arch>` optional deps), one process per API instance, which counts against A25's memory budget. |
| `@modelcontextprotocol/client` | 2.3.1 | Tests, eval harness | Dev only. Client for in-process and socket tests. |
| `@bufbuild/protoc-gen-es` + `@bufbuild/buf` | 2.16.0 / 1.74.0 | Generate SCIP TS types | Dev only. Pin `scip.proto` at tag v0.10.0 (Apache-2.0, keep header/NOTICE), run `buf generate`, and commit the generated file. Never generate at install time. Decode the `Index` stream document by document (top-level `documents` field) to bound memory on large indexes. |
| `@sourcegraph/scip-typescript` | 0.4.0 (npm, Oct 2025; repo active, last commit 2026-10-08) | Test oracle for the SCIP importer | Dev only, run as an external command. It bundles TypeScript ^5.6.2, so do not assume it handles TS-6-only configs. Primary SCIP fixtures should come from `scip-python` 0.6.6 and checked-in `.scip` files. |
| `ajv` + `ajv-formats` | 8.20.0 / 3.0.1 (`ajv/dist/2020`) | Conformance test only | Dev only: validates that the JSON Schema exported from Zod accepts/rejects the same manifest fixtures as the runtime parser. Not a runtime dependency. |
| `semver` | 7.8.5 | Version/range comparison for SDK ids, compiler versions | Runtime; small, no install scripts. |
| `node:util` `parseArgs`, `node:crypto`, `node:child_process`, `node:test`, `node:assert` | built in | CLI parsing, hashing (git blob id = sha1 over `blob <len>\0` + bytes when no clean filter applies), process spawn, tests | Zero dependencies, deliberately. |

### Development Tools

| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| `node:test` + `c8` | built in / c8 12.0.0 | Test runner + coverage | Same runner as gsd-core (`node --test`, `c8`, Stryker). Tests run the real Node: worker_threads, `node:sqlite`, WASM loading, SIGKILL durability tests, Unix sockets. Mutation testing with `@stryker-mutator/core` 10.0.0 is optional, later. Vitest 5.0.5 is fine software (needs `vite ^6.4 || ^7 || ^8` peer) but adds a bundler layer that gives nothing this project needs. |
| Native type stripping | Node 24.12+ stable | Run `.ts` in dev/tests with no loader | Rules: `.ts` extensions in imports, `import type` for types, no `enum`/`namespace`/parameter properties/decorators (`--experimental-transform-types` was removed in Node 26). Enforce with tsconfig `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, `module: nodenext`, `noEmit` for typecheck. Node refuses `.ts` under `node_modules`, so the published package ships compiled JS. |
| `tsc` 6.0.3 | 6.0.3 | Build (emit `dist/` JS + `.d.ts`) and typecheck | Plain emit, no bundler. Same approach as gsd-core (`tsc -p tsconfig.build.json`). |
| ESLint 10.12.0 + typescript-eslint 8.71.2 | as listed | Lint | Type-aware rules (`no-floating-promises`, `no-misused-promises`) matter for a daemon full of async code. Pins the repo to TS `<6.1`. |
| `@types/node` | `^24.19` | Types | Use 24, not 26, so we cannot accidentally call APIs missing from the Node 24 floor. |
| `module.enableCompileCache()` | built in | Faster cold start for the bins | **[verified]** present on Node 26; call at the top of both bin entry files (guard with a typeof check). |

### Packaging and bundling

- One package, ESM (`"type": "module"`), `bin: { "gsd-atlas": "dist/cli/main.js", "gsd-atlas-mcp": "dist/mcp-shim/main.js" }`, `exports` map, `files` whitelist (`dist`, `grammars/*.wasm`, `modules`, `schemas`, `skills`).
- **No bundler for 1.0.** WASM, worker files and the project-local `typescript` load all depend on real file layout (`new Worker(new URL('./parser-worker.js', import.meta.url))`, `import.meta.dirname` for assets). tsdown (0.23.1, pre-1.0, rolldown-based) and tsup (9.0.0) add risk for no benefit here. If shim cold start misses budget, bundle only the shim with esbuild 0.28.2.
- Shim startup **[verified]**: bare `node` is about 75 ms on this machine; importing `@modelcontextprotocol/server` + `/stdio` adds about 30 ms, with the Node adapter about 40 ms. The shim must not load SQLite, grammars or the compiler (A27); consider a dependency-free relay (stdio JSON-RPC lines to the host) if the stdio path needs to be faster than that.
- Worker entry files are looked up differently when running from `src/*.ts` (dev/tests) and `dist/*.js` (published); wrap in one `resolveWorkerUrl()` helper.

## Installation

# Runtime

# Optional fallback SQLite driver (peerDependenciesMeta.optional, not a hard dependency)

# Dev

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| MCP SDK v2 (`@modelcontextprotocol/server` 2.3.1) | v1.32.1 `@modelcontextprotocol/sdk` | Only if a required client breaks against v2's legacy-stateless path. v1 gets fixes for about 6 months after 2026-07-27, so it is a bridge, not a base. |
| `@parcel/watcher` 2.6.0 | chokidar 5.0.0 (ESM only, Node >=20.19, built on `fs.watch` + readdirp) | If a platform lacks a parcel prebuild (e.g. FreeBSD, rare ARCH). Chokidar has no equivalent of `getEventsSince`. Either way Reconcile (A21) is the correctness backstop, since network/synced/WSL mounts deliver no events. |
| `@parcel/watcher` | raw `fs.watch({recursive:true})` | Not for the Indexer: on Linux recursive mode is emulated with one watcher per directory, drops events silently under load, and has no ignore support. Fine for a single known file such as the token file. |
| `node:test` + `c8` | Vitest 5.0.5 | If the team later wants snapshot/watch-mode ergonomics. Not now: consistency with gsd-core and real-Node semantics win. |
| Zod 4 as source, exported JSON Schema | Hand-written JSON Schema + Ajv at runtime | If third-party language-module authors need a schema that is the source of truth rather than generated. Then Ajv 2020 becomes a runtime dependency (the MCP SDK also ships an Ajv validator option). |
| `@bufbuild/protobuf` generated from `scip.proto` | Official `@sourcegraph/scip`-style `google-protobuf` bindings | The official TS bindings are not published to npm (404 for `@sourcegraph/scip`), are CJS, and rely on a pinned old `protoc-gen-ts`. |
| tsc emit | tsdown / tsup / esbuild bundle | See "Packaging and bundling". |
| Our bundled `typescript@6.0.3` fallback | `@typescript/typescript6` 6.0.2 | Only when the project already aliases it; probe the project's installed `typescript` first (A54), then fall back to ours. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `tree-sitter-wasms` (or any prebuilt third-party WASM bundle) | Already measured at 2.8% / 0.9% parse-error files (design review LM-1). | Grammars built by our pipeline from pinned upstream (A48). |
| npm `tree-sitter-swift@0.7.1` | Stale (2025-06), depends on `tree-sitter-cli ^0.23`, and is behind 0.7.3 and `main`. | A pinned git commit of alex-pinkus/tree-sitter-swift plus our patches. |
| Native `tree-sitter` Node bindings | Install scripts and prebuilds per grammar, contradicts A48's sandboxed-WASM stance, and peer-pinned per grammar (`tree-sitter ^0.21/0.22/0.25`). | `web-tree-sitter`. |
| `@modelcontextprotocol/server-legacy` (`SSEServerTransport`) | HTTP+SSE is removed in v2 and deprecated in the spec. | Streamable HTTP (`createMcpHandler`). |
| MCP Roots, Sampling, Logging features | Deprecated by SEP-2577 in 2026-07-28. | Explicit `cwd`/`repo` argument, own LLM-free design, stderr logging. |
| MCP protocol sessions (`Mcp-Session-Id`, resumability, `Last-Event-ID`) | Removed by SEP-2567/2575. | Stateless handlers; Policy keeps its own bounded ledger keyed by hook payload session/agent ids (A37). |
| `piscina` / any worker-pool library | The Governor (A61) must own admission, fairness and memory budgets. | Raw `worker_threads` behind the Governor. |
| `ts.createProgram` / `ts.createLanguageService` against an unprobed `typescript` | With TS 7 as `latest`, the project's `typescript` may have no classic API. | Probe capabilities first (see adapter selection). |
| `typescript@7` as the repo's own compiler today | typescript-eslint caps at `<6.1.0`, and the 7.x API is unstable. | `typescript@~6.0.3`; use 7 only as an alias for adapter tests. |
| `tsx`, `ts-node`, `tsup` in the dev loop | Node 24+ strips types natively; extra loaders hide the erasable-syntax rule the published JS depends on. | `node file.ts`, `node --test`. |
| `child_process.spawn('npx' \| 'tsc' \| any .cmd/.bat, ...)` without a shell on Windows | Node rejects `.cmd`/`.bat` spawns without `shell: true` (EINVAL since the 2024 hardening). A shell breaks A54's "argument arrays, never a shell". | Resolve real executables (`node bin.js`, `git.exe`) in CommandRunner; never route through npm shims. |
| `google-protobuf` | Legacy CJS runtime. | `@bufbuild/protobuf`. |
| Reading `Mcp-Session-Id`-style state from the SDK | None exists in 2026-07-28. | Explicit handles passed as tool arguments if cross-call state is ever needed. |

## Stack Patterns by Variant

## Platform gotchas that need tests from M1

- **Windows:** `node:sqlite`/better-sqlite3 files stay locked while a connection is open (close DBs before deleting temp dirs, EBUSY); runner temp paths can be 8.3 short names (`RUNNER~1`), so compare with `fs.realpathSync.native`; CRLF and `core.autocrlf` interact with A19 hashing (pin `.gitattributes` in fixtures); named pipe names are `\\.\pipe\...`; FS events can be dropped on ReadDirectoryChangesW buffer overflow (Reconcile covers it).
- **macOS/Windows:** case-insensitive file systems; path identity must be normalised once in Source Tree.
- **All:** `git` is a hard external dependency (clean-filter hashing via `git hash-object --path`, `ls-files -s`); long-lived `git cat-file --batch` is the fast read path. SHA-256 object-format repos exist; do not assume 40-hex ids.
- **Linux CI:** `~/.cache/tree-sitter` holds wasi-sdk (606 MB on disk); cache it only in the grammar job.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| web-tree-sitter 0.27.1 | tree-sitter-cli 0.27.1 | Keep them identical. **[verified]** loads ABI 14 (typescript) and ABI 15 (swift) wasm built by 0.27.1. |
| `@modelcontextprotocol/server` 2.3.1 | `@modelcontextprotocol/node` ^2.3 peer (2.1.1 installed), zod ^4.2 | Zod 3 is unsupported. Node 20+. |
| `@modelcontextprotocol/server` 2.x | clients on 2025-era protocol | Default `legacy: 'stateless'` over HTTP, `legacy: 'serve'` over stdio. **[verified]** over a Unix socket. Modern requests need `MCP-Protocol-Version` and `Mcp-Method`/`Mcp-Name` headers. |
| typescript-eslint 8.71.2 | typescript >=4.8.4 <6.1.0, eslint 8.57 / 9 / 10 | Keeps the repo on TS 6.0.x. |
| `node:sqlite` | Node >=24.16 (RC); `serialize/deserialize` need >=24.16; `createModule` is 26.11+ only | Do not use features newer than the floor. |
| better-sqlite3 13.0.3 | Node >=22 | Prebuilds inside the package; no install script. |
| `@parcel/watcher` 2.6.0 | Node >=10 (N-API) | Works on Node 26.11.1 **[verified]**. Has an `install` script that only compiles from source when no prebuilt optional package matches; with scripts blocked it is harmless where a prebuild exists. |
| typescript 7.0.2 | exports `./unstable/sync|async|ast|proto|fs` | 7.1.0-dev: `./sync|async|ast|proto|fs|path`, `unstable/` prefix gone. Pin per minor. |
| tree-sitter-swift `main` | tree-sitter-cli 0.27.1 | Generates ABI 15 `parser.c` (about 23 MB, not committed upstream). |
| `@types/node` 24 | Node 24 floor | Avoid 26 types. |

## Sources

- npm registry (`npm view`, 2026-10-15): all version numbers, dist-tags, engines, dependency lists, publish dates. HIGH.
- Node.js docs: nodejs.org/docs/latest-v24.x/api/sqlite.html and /latest/api/sqlite.html (stability 1.2 RC, history table, options); /api/typescript.html (v24 and v26: type stripping stable, limits); github.com/nodejs/Release schedule.json (LTS dates). HIGH.
- MCP: ts.sdk.modelcontextprotocol.io/v2 (migration, serving/http, legacy-clients, sessions-state-scaling); modelcontextprotocol.io/specification/2026-07-28/changelog; raw README of modelcontextprotocol/typescript-sdk `main`. HIGH.
- TypeScript: devblogs.microsoft.com/typescript/announcing-typescript-7-0 (no API in 7.0, API in 7.1, `@typescript/typescript6` alias advice); unpacked `typescript@7.0.2` and `typescript@next` tarballs (exports, `.d.ts` surface). HIGH for 7.0.2, MEDIUM for 7.1 (dev build).
- tree-sitter: unpacked `web-tree-sitter@0.27.1` (README, `.d.ts`), grammar tarballs, `gh api` for upstream releases/commits/trees (tree-sitter/tree-sitter, tree-sitter-typescript, alex-pinkus/tree-sitter-swift, tree-sitter-python). HIGH.
- SCIP: `gh api` sourcegraph/scip (v0.10.0 2026-09-03, Apache-2.0, bindings layout, `scip.proto`), sourcegraph/scip-typescript (0.4.0, active repo). MEDIUM (TS 6 behaviour of scip-typescript not tested).
- GitHub Actions: actions/runner-images README and `images/macos/xcode-27-arm64-Readme.md`; `gh api` latest releases of the official actions. HIGH.
- npm `install-scripts` man page (npm 11.20). HIGH on the documented default, MEDIUM on observed behaviour (scripts appeared to run in this install).
- Hands-on labs (session scratchpad): tree-sitter WASM builds and parse runs over gsd-core, gsd-pi (shallow clone), local Swift and Python code; node:sqlite probes on Node 24.22.0 and 26.x; MCP v2 server over a Unix socket with curl; TS 7.0.2 sync API; @parcel/watcher snapshot test. Single-machine (macOS arm64) evidence. HIGH for what ran, not generalisable to Windows/Linux without CI.

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-fast` for a trivial task inline, with no subagents and no PLAN.md
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
