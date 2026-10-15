# Product Requirements Document (PRD) – gsd‑atlas

**Version:** 0.1.0
**Owner:** Open GSD team
**Date:** 2026‑10‑15
**Status:** Draft – under review
**Package:** `@opengsd/gsd-atlas` · CLI `gsd-atlas` · MCP `gsd-atlas-mcp`
**License:** MIT (planned, matching gsd‑graph)

| Version | Date | Change |
|---------|------|--------|
| 0.1.0 | 2026‑10‑15 | Founding PRD. Carries over the code‑support‑modules work drafted as gsd‑graph PRD 0.2.0, which is withdrawn from gsd‑graph. gsd‑graph keeps a small bridge (see *gsd‑graph PRD: Atlas bridge*). |

---

## 1. Overview
**gsd‑atlas** is a local map of a codebase and the platform it targets, built for coding agents. It answers two questions agents currently guess at:

1. **What is in this code?** Definitions, references, imports, inheritance, and which decisions (ADRs) the code cites, on every branch and worktree, kept current as files change.
2. **What does the platform actually offer?** The APIs in the SDKs installed on this machine, with the OS version each was introduced or deprecated in, so agents use iOS 27 when iOS 27 is what builds the app, not iOS 18 from training data.

It ships as:

- **Code support modules.** A language is data (a manifest, a grammar and query files), so anyone can add one without changing gsd‑atlas.
- **Two launch modules:** TypeScript (including `.cts`, as GSD's own projects use) and Swift (iOS, iPadOS, macOS, watchOS, tvOS, visionOS).
- **Platform SDK providers:** Apple (Xcode SDKs) and Node.
- **An MCP server and an Agent Skill** for any agent client.

**MVP: working with gsd‑core development.** The first usable release indexes gsd‑core (TypeScript `.cts` → `.cjs`, its ADRs) and serves the agents working on it: local and resolved facts, the store, a single‑tenant host, the MCP read tools and the skill (milestones M0–M2). Swift, SDK facts, multi‑repo and swarm hardening and enforcement hooks follow on the same design.

**Platforms:** macOS, Linux and Windows, tested in CI from the MVP.

gsd‑atlas is a sibling of **gsd‑graph**, not a part of it. gsd‑graph stays the knowledge graph for docs, planning and decisions; gsd‑atlas exports the code‑to‑decision links gsd‑graph needs through a bridge (§9). It borrows gsd‑graph's provenance shape, CLI contract and safety code (DESIGN.md §Borrowed).

### 1.1 Why build it
The motivation is replacing paid code‑memory and code‑graph tools (Memtrace and others) with a free, local, open tool. Before 1.0 the team evaluates the free alternatives and records the gap each leaves:

| Category | What it covers | Gap gsd‑atlas fills (to verify) |
|----------|----------------|---------------------------------|
| MCP servers that wrap language servers (LSP) | Definitions and references per language, precise where a server exists | Freshness across many worktrees, SDK facts, ADR links, multi‑repo, enforcement hooks, one host for many agents |
| Repo‑map features inside coding agents | Compact symbol summaries for one session | Persistent, shared, cited facts across sessions and agents |
| Paid code‑memory and code‑graph services | Varies | Cost, privacy (local only), store size and corruption seen in practice |

---

## 2. Goals & Non‑Functional Requirements
| Goal | Success Metric |
|------|----------------|
| **Accurate code facts** | Per‑construct recall ≥ 90 % for functions, types (classes/structs/protocols/interfaces), methods and imports, against a tree‑sitter ground truth (grammar tier) and the compiler's symbol table (precise tier). |
| **Provenance on every fact** | Each fact carries `source_path`, `span` (start/end line, mandatory), `extractor`, `content_hash`, `first_seen`, `last_seen`, `confidence`, in gsd‑graph's provenance shape. |
| **Answers with citations** | On ≥ 50 pre‑written questions per corpus (gsd‑core first; then gsd‑pi, gsd‑path and one Swift app), including questions atlas should abstain on, run ≥ 3 times per configuration: agents using gsd‑atlas answer correctly with a verifiable file:line citation ≥ 80 % of the time and beat a grep‑only baseline on the same model and token budget, with the difference outside the run‑to‑run interval. |
| **Precision** | A hand‑verified sample of `EXTRACTED` edges is ≥ 98 % correct per corpus; Swift grammar‑tier resolved references ≥ 85 % precise on a reference app. |
| **Bring‑your‑own language** | A new language reaches the grammar tier by adding a module folder; zero changes to gsd‑atlas source, no release. |
| **Platform currency** | SDK answers name the installed SDK version. On a 50‑use fixture, `sdk_check` flags 100 % of symbols missing from the installed SDK and of uses above the deployment target with no availability guard. |
| **Freshness** | File save → grammar‑tier facts updated < 1 s; precise‑tier facts for one changed file in gsd‑core < 5 s. |
| **Branch & worktree aware** | Every worktree of a repo reads one shared index; switching branches re‑indexes only changed files. |
| **Performance** | Full build of gsd‑core (274 `.cts` files in its tsconfig) < 30 s on a modern laptop; queries < 2 s on a warm index. |
| **Uncapped agents** | No designed limit on concurrent agents. Constant, small cost per agent (no per‑agent process over HTTP MCP); 1,000 concurrent short‑lived agents with zero errors and read p99 ≤ 100 ms on a laptop; heavy resources held to a memory budget at any agent or worktree count (DESIGN.md *Concurrency & scale*). |
| **Multi‑repo** | Many repos active at once, each with its own sessions and swarms, on one host: disk grows with each repo's unique code plus each shared SDK/package version once; memory doesn't grow with repo count (10 repos ≤ 200 MB before compilers); repos isolated unless grouped in a workspace (DESIGN.md *Multi‑repo workstation*). |
| **Privacy** | No network by default, no telemetry; the only outbound data is a user‑approved diagnostics report (§11.2). SDK facts come from SDKs on disk. External commands run only when allowed (§4.6). |

---

## 3. Scope
### In‑Scope (1.0)
- Code support module system: manifest, resolution, three tiers, runtime interface.
- TypeScript launch module with tsconfig‑driven emit mapping and ADR citations.
- Swift launch module with SwiftPM/Xcode project model and availability facts.
- Apple and Node SDK providers; SDK packs for machines without the SDK.
- SQLite fact store shared across worktrees; file watcher.
- MCP server, CLI, Agent Skill, `atlas-scout` subagent, enforcement hooks and pre‑commit check.
- Python example module (proof of bring‑your‑own), validated on gsd‑path.
- Bridge export to gsd‑graph.
- Local value dashboard (`gsd-atlas status` panels, `gsd-atlas dashboard`, `gsd-atlas eval`): honest, labeled metrics of what atlas delivers and costs; nothing leaves the machine (§8.4).

### Out‑of‑Scope (1.0)
- Data‑flow, taint or type inference beyond what compilers and indexers provide.
- An LSP bridge (candidate later tier).
- Fetching documentation from the web.
- Embedding/vector search (planned post‑1.0, opt‑in, local models; see DESIGN.md A15).
- Network sharing (pending privacy review).
- GUI. (The dashboard's generated, static, read-only HTML report is not a GUI.)

### Post‑1.0
- **Open Knowledge Format (OKF) export:** `gsd-atlas export --format okf` writes a readable bundle per repo at module level: one markdown concept per module with a summary, the ADRs it implements, its dependencies and platform targets, linked to each other. OKF is a v0.1 spec (June 2026) from Google Cloud's Data Cloud team: markdown files with YAML frontmatter where only `type` is required, and plain links forming the graph. It can't carry typed edges, spans, confidence or availability, so it stays an export, never the store. Before building: confirm the spec's license is compatible with MIT and re‑check maturity (v1, governance).

---

## 4. Code Support Modules
### 4.1 Principle
gsd‑atlas is a language‑neutral engine. A module says which files it claims, how to parse them, how to find definitions, references and imports, and optionally how to get compiler‑precise facts and SDK facts. Built‑in modules use the same format as community ones.

### 4.2 Module layout
```
<module>/
  atlas-lang.json        # manifest (JSON Schema validated)
  grammar.wasm           # tree-sitter grammar compiled to WebAssembly
  queries/
    tags.scm             # definitions
    refs.scm             # references and calls
    imports.scm          # imports / requires
  fixtures/              # sample files + expected facts (`gsd-atlas lang test`)
```

Example (Python, the bring‑your‑own proof):
```json
{
  "id": "python",
  "version": "0.1.0",
  "extensions": [".py", ".pyi"],
  "grammar": { "wasm": "grammar.wasm", "source": "tree-sitter-python@<pinned>" },
  "queries": { "tags": "queries/tags.scm", "refs": "queries/refs.scm", "imports": "queries/imports.scm" },
  "project": { "markers": ["pyproject.toml", "setup.cfg"] },
  "precise": { "scip": { "command": ["scip-python", "index", "."], "output": "index.scip" } }
}
```

| Field | Required | Purpose |
|-------|----------|---------|
| `id`, `version`, `extensions` | yes | Identity and claimed extensions; a collision fails loudly unless `replace`. |
| `grammar.wasm`, `queries.tags` | yes | Grammar tier. |
| `queries.refs`, `queries.imports` | no | References and module edges. |
| `project.markers` | no | Files that mark a project root. |
| `precise` | no | A SCIP file, a command that makes one, or a built‑in adapter (`"adapter": "typescript"`). |

### 4.3 Tiers
| Tier | Contributor supplies | Facts | Confidence | Runs |
|------|---------------------|-------|-----------|------|
| **Grammar** (required) | `.wasm` + queries | Definitions, containment, imports; name‑matched references | Definitions/imports `EXTRACTED`; name‑matched references `INFERRED` | Every save, every branch; no build |
| **Precise** (optional) | SCIP indexer or compiler adapter | Resolved references, overrides, implementations, types | `EXTRACTED` | On demand or after a build; supersedes grammar references at the same span |
| **Platform** (optional) | SDK provider | SDK symbols with availability; project target versions | `EXTRACTED` | When the installed SDK changes |

Any SCIP index works for the precise tier, so scip‑typescript, scip‑python, scip‑java (Java/Kotlin/Scala), scip‑go, scip‑clang and rust‑analyzer need no new code.

### 4.4 Resolution
First match per `id` wins:
1. Repo: `.gsd-atlas/languages/<id>/`
2. User: `~/.config/gsd-atlas/languages/<id>/`
3. npm: `gsd-atlas-lang-<id>` or `@opengsd/atlas-lang-<id>`
4. Built‑ins

`gsd-atlas lang list` shows modules, source and active tiers; `gsd-atlas lang test <id>` runs fixtures.

### 4.5 Runtime interface
```ts
// A language module is data (manifest, grammar, queries, fixtures). The shared Grammar Engine
// runs it: parsing, queries, normalizing and name-matched (INFERRED) resolution.
interface LanguageModule {
  manifest: LanguageManifest;     // includes import-path and project-marker rules used by the Grammar Engine
  testGlobs?: string[];           // for tested_by
  precise?: PreciseResolver;      // optional; the only code a language module may add
}

interface PreciseResolver {       // adapters: SCIP import, TypeScript 6 / 7 compiler, IndexStoreDB
  resolve(overlay: OverlaySnapshot, context: ResolutionContext, sites: RefSite[]): AsyncIterable<ResolvedEdge>;
                                  // EXTRACTED; supersedes name-matched edges at the same span
}

// SDK providers are registered by id and selected by project targets, not by language.
interface SdkProvider {
  id: string;                     // "apple" | "node" | ...
  detect(root: string): Promise<PlatformTarget[]>;     // installed SDKs + project targets
  extract(target: PlatformTarget, symbols: string[]): AsyncIterable<SdkFact>;  // keyed by a provider-native symbol_key
}

// Every external program starts through the CommandRunner (command-runner ADR).
interface CommandSpec { executable: string; args: string[]; builtinId?: string }
```

### 4.6 Safety
Full model: trust‑boundaries ADR.
- Grammars run as WebAssembly with no file or network access; queries are data. Grammars are built from pinned upstream releases by gsd‑atlas's own build, with a parse‑error budget per module in CI.
- Manifests are schema‑validated; invalid modules are skipped with a diagnostic.
- **Permissions come only from user‑level config** (`~/.config/gsd-atlas/`). Repo‑committed config and repo or npm modules can never enable commands or network.
- **Built‑in first‑party providers** with fixed command lines (`git`, the TypeScript adapter, `xcrun` and `swift symbolgraph-extract` on macOS) run by default and can be turned off. Any other command needs user approval per repo and per command, and never runs through MCP unless the host was started with `--allow-build`.
- Only `git ls-files` plus untracked, non‑ignored files are indexed; `linguist-generated` and `linguist-vendored` are honoured; binaries and LFS pointers are skipped.
- Path safety, per‑file size cap and secret redaction are borrowed from gsd‑graph.

### 4.7 Fact vocabulary
| Predicate | Subject → Object | Tier |
|-----------|------------------|------|
| `defines`, `contains` | File/Symbol → Symbol | Grammar |
| `imports` | File → Package/File | Grammar |
| `calls`, `references` | Symbol → Symbol | Grammar (`INFERRED`), Precise (`EXTRACTED`) |
| `reexports` | File → Package/File | Grammar |
| `extends`, `extension_of`, `implements`, `conforms_to`, `overrides` | Symbol → Symbol | Grammar / Precise |
| `tested_by` | Symbol → Test file/Symbol | Module test globs + references (`INFERRED`) |
| `emitted_as` | Source file → Emitted file | TypeScript adapter |
| `cites_adr` | Symbol/File → ADR id | Comment scan (pattern configurable, default `ADR-\d+`) |
| `uses_sdk_symbol` | Symbol → SdkSymbol | Precise / Platform |
| `targets_platform` | Target → Platform version | Platform |

Entity kinds: `File`, `Package`, `Symbol` (with `kind`), `SdkSymbol`, `Sdk` (e.g. `sdk:ios-27.0-27A266a-device`), `Target`. \1 Availability (introduced, deprecated, obsoleted, renamed, per axis) is data on SDK symbols, not predicates; storage is typed tables.

**Two layers (fact‑model ADR):** *local facts* (definitions, containment, imports and reference sites as written) are keyed by file content and shared across branches; *resolved edges* (a reference bound to its target) depend on the rest of the project and are keyed by the overlay snapshot plus the resolution context (config files and lockfile). Symbol identity is (repo, path, qualified name, kind, overload discriminator), so edits don't break references. ADR ids resolve against the repo's ADR directory; ambiguous ids point at every candidate as `INFERRED`.

---

## 5. Launch Module: TypeScript
**Goal:** compiler‑precise facts for GSD's TypeScript projects, including `.cts`.

- **Precise tier:** the project's own `typescript` package over its tsconfig(s) (fallback: bundled); incremental on save. TypeScript 6.x through the classic LanguageService API; TypeScript 7.x through its native `unstable/sync` API (see Risks). A compiler program is per file set (~357 MB for gsd‑core), so precise resolution runs for a bounded number of active worktrees under the memory budget; others get grammar facts plus their base commit's precise edges, flagged `degraded`.
- **Files:** `.ts`, `.tsx`, `.mts`, `.cts`, declarations; `.js`/`.cjs`/`.mjs` via `allowJs` for `require`/`import` edges.
- **Emit mapping:** `rootDir`, `outDir` and extension rules (`.cts` → `.cjs`, `.mts` → `.mjs`, `.ts` → `.js`) produce `emitted_as` edges; emitted files are not indexed; `require`s of emitted paths resolve to source. Driven by tsconfig only, with no project‑specific code.
- **ADR citations:** ADR ids in comments become `cites_adr` facts.
- **Fallback:** tree‑sitter TypeScript/TSX when there is no tsconfig or the compiler fails.
- **Platform:** Node provider (§7.3).

**Monorepo corpus, gsd‑pi:** a pnpm workspace with 12 packages and 14 tsconfigs, ~3,900 `.ts` files and a 2,381‑file extension tree; tests per‑package tsconfig discovery, project references and scale.

**Validation corpus, gsd‑core:** 284 `.cts` sources in `src/` (274 in tsconfig `include`) compiled to gitignored `.cjs` in `gsd-core/bin/lib` (ADR‑457), 1,359 hand‑written `.cjs`, `module: nodenext`, TypeScript 6.0.3, Node ≥ 24.

**Spike (2026‑10‑15):** TypeScript 6.0.3 over those 274 files, cold, in a cloud container: 5.4 s; 21,342 declarations, 804 imports, 28,071 call sites resolved to declarations, 59 distinct ADR ids in comments.

---

## 6. Launch Module: Swift / iOS / macOS
**Goal:** useful facts anywhere with no build; compiler precision on a Mac when a build exists.

- **Grammar tier:** tree‑sitter‑swift as WebAssembly. Upstream `tags.scm` captures definitions but no call references (spike, 2026‑10‑15), so the module ships its own `refs.scm`. Grammar and queries are pinned together (upstream npm 0.7.1, June 2025); fixtures cover Swift 6.x syntax (macros, typed throws, noncopyable types).
- **Project model:** SwiftPM `Package.swift` (targets, products, `platforms:`); Xcode build settings per target/configuration (`IPHONEOS_DEPLOYMENT_TARGET`, `MACOSX_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `SDKROOT`) from `project.pbxproj` on any OS, or `xcodebuild -showBuildSettings -json` on a Mac when commands are allowed.
- **Availability:** `@available` / `#available` in user code become availability facts checked against the deployment target; `import <Framework>` links to the SDK module.
- **Precise tier (optional, macOS after a build):** a small first‑party helper over IndexStoreDB (spike first), or import any SCIP index made from Xcode's index store. No hard dependency on a community indexer.
- **Quality target:** grammar‑tier resolved references ≥ 85 % precise on a reference app, measured before Swift launches.
- **Platform:** Apple provider (§7.2).

**Validation:** an iOS/macOS app repo indexes at the grammar tier on Linux CI with no Xcode; on a Mac it adds SDK facts.

---

## 7. Platform SDK Facts
### 7.1 Problem
Models default to SDKs from their training data. Xcode 27 (iOS 27, macOS 27, Swift 6.4) shipped on 2026‑09‑14, yet agents still propose iOS 18 APIs, miss deprecations and invent symbols. The installed SDK is the ground truth for what compiles, and it is already on disk.

### 7.2 Apple provider
Built‑in first‑party provider: **on by default on macOS**, no configuration needed (trust‑boundaries ADR).

1. **Detect:** `xcode-select -p`, `xcrun --sdk <iphoneos|iphonesimulator|macosx|…> --show-sdk-version` / `--show-sdk-path` / `--show-sdk-build-version`, `swift --version`. SDK id = platform + version + build + variant (`ios-27.0-27A266a-device`), so betas, releases, simulator and Mac Catalyst don't collide.
2. **Extract:** `swift symbolgraph-extract -module-name <Framework> -target <arch>-apple-<os><version> -sdk <path> -minimum-access-level public`, for frameworks the project imports (all with `--all-frameworks`).
3. **Store:** per SDK id, each symbol's kind, declaration, availability (introduced, deprecated, obsoleted, renamed) and doc comment when present (often absent; declarations and availability are the core).
4. **Refresh:** re‑extract when the SDK version or Xcode path changes; keep earlier versions so `sdk_diff ios-26.x ios-27.0` works.

### 7.3 Node provider
Node version from `engines`, `.nvmrc` or the running binary; APIs from the repo's `@types/node` and the TypeScript `lib` for the tsconfig `target`.

### 7.4 Open toolchains and language levels
Every major open toolchain already ships versioned API data on disk, so the same provider interface covers them without the network (full research: `SDK-PROVIDERS.md`):

| Language | "Since" data on disk |
|----------|----------------------|
| JavaScript (browsers, Node, Deno) | MDN browser‑compat‑data (CC0) + TypeScript lib files |
| C / C++ | glibc symbol versions; C++ `<version>` feature‑test macros; headers via clang |
| C# / .NET | Reference packs with XML docs, diffed across target frameworks |
| Java | JDK `lib/ct.sym` (signatures for every past release) |
| Python | typeshed `stdlib/VERSIONS` + `sys.version_info` guards |
| Go | `$GOROOT/api/go1.N.txt` |
| Rust | `#[stable(since = …)]` attributes in `rust-src` |

Each project's **language level** (`requires-python`, `-std=`, `LangVersion`, `--release`, go.mod `go`, `rust-version`, `browserslist`) is read too, and `syntax_check` flags syntax newer than that level. The same mechanism reads **installed third‑party package** APIs from lockfiles and local caches. Order after 1.0: Python and Go, then Java and Rust, then C#, C and C++, then package facts.

### 7.5 Machines without the SDK
`gsd-atlas sdk export` writes a read‑only SQLite pack on a Mac; `gsd-atlas sdk import` loads it on Linux or CI. Nothing is downloaded.

### 7.6 Agent surfaces
- **`platform_card`** at session start:
  ```
  Platform: iOS SDK 27.0 (Xcode 27.0, Swift 6.4)
  Project target: iOS 17.0 (app), iOS 17.0 (widget)
  Latest installed SDK is 27.0. Guard APIs introduced after 17.0 with #available.
  ```
- **`sdk_lookup(symbol)`**: declaration, availability, SDK id.
- **`sdk_check(files | diff)`**: symbols missing from the SDK, uses above the deployment target without a guard, deprecated APIs.

---

## 8. Interfaces
### 8.1 MCP tools
| Tool | Privilege | Purpose |
|------|-----------|---------|
| `atlas_build` | Privileged (`--allow-build`) | Build or refresh facts. |
| `code_find` | Read | Definitions by name or kind. |
| `code_refs` | Read | Callers and references with spans. |
| `code_context` | Read | A symbol with its definition, callers, callees, cited ADRs and tests, in a token budget. |
| `code_impact` | Read | What a change to a symbol or file reaches: transitive callers, dependent modules, tests. |
| `atlas_status` | Read | Freshness, health, policy mode, local usage metrics. |
| `lang_list` | Read | Modules, sources, active tiers. |
| `platform_card`, `sdk_lookup`, `sdk_check`, `sdk_diff` | Read | SDK facts (§7.6). |
| `syntax_check` | Read | Syntax newer than the project's language level (§7.4). |
| `explain` | Read | Why atlas said something: extractor, tier, grammar version, resolution context, overlay. |

All tools are served by one gsd‑atlas host per user and major version, with each repository an isolated tenant (own store, writer, policy, watchdog); public SDK and package facts are stored once per machine. Clients connect over a Unix socket or named pipe where supported, otherwise loopback HTTP at a fixed port; every route needs the token and browser‑style requests are rejected. Stdio‑only clients use the thin shim `gsd-atlas-mcp`.

Every response carries `schema`, citations with `debug` handles, a watermark, a `degraded` flag and an `untrusted_text` field that fences repo and package prose. A `fresh` option makes the host index named files first; under saturation it answers `busy` with `retry_after`. Ranking per tool is defined in the MCP‑contract ADR; `code_impact` expands only `EXTRACTED` edges by default.

### 8.2 CLI
Same machine contract as gsd‑graph: JSON on stdout, reasons on stderr, exit codes 0/1/2/3. Commands: `init`, `build`, `watch`, `status`, `find`, `refs`, `context`, `history`, `maintain <reconcile|resolve|refresh|collect|compact|check>`, `lang list|test`, `sdk detect|extract|export|import|diff|check`, `bridge export`, `dashboard [--since 7d] [--html]`, `eval`.

Every tool takes `budget_tokens` (default 2,000) and returns ranked, cited results with a `more` cursor, so atlas answers stay far below hosts' tool‑output limits and cost less than reading files.

### 8.3 Skill, subagent and enforcement hooks
Full design: `AGENT-INTEGRATION.md`.
- **Skill `gsd-atlas`** (auto‑invoked): routing table and three rules — `code_context` before editing a symbol, `sdk_check` and `syntax_check` before proposing a diff, `fresh` after your own edits. `gsd-atlas-module-author` is a user‑invoked skill for writing language modules.
- **Subagent `atlas-scout`:** read‑only explorer (atlas tools plus Read) for swarms, so exploration costs atlas queries, not repo sweeps.
- **Hooks** (served by the daemon over HTTP hooks; thin forwarder elsewhere; all fail open):

| Rule | When | advise (default) | enforce / strict |
|------|------|------------------|------------------|
| R0 Brief | Session/subagent start | Inject platform card, status, routing | Same |
| R1 Search assist | Before grep/glob/find | Attach the atlas answer | strict: deny only when atlas has an exact, complete answer (an indexed symbol's definition or references); text, string, log and config searches always pass |
| R2 Edit gate | Before an edit that changes a signature or removes a symbol with callers above a threshold | Attach callers and ADRs | Deny until context is delivered (one retry passes) |
| R3 Check after edit | After an edit | Run `sdk_check` + `syntax_check` on changed lines | Same; findings recorded |
| R4 Done gate | Agent tries to stop | Summarise open findings | Block while findings or broken references remain (max 3 blocks) |

- Gates only ever demand one cheap atlas call, open whenever atlas can't answer or facts are stale, and can be overridden only by the user. On hosts that don't provide session and agent ids, gates run in advise mode only.
- Hook and session context fences repo‑derived text as untrusted data.
- **Backstop for every host and for humans:** `gsd-atlas check --staged` as a git pre‑commit hook and CI step.

### 8.4 Value dashboard
Full design: [draft-value-dashboard](adr/draft-value-dashboard.md); research: `DASHBOARD-METRICS.md`.
- **Surfaces:** `gsd-atlas status` (always; basic panels) and `gsd-atlas dashboard [--since 7d] [--html]`. The HTML output is a generated, static, self-contained file; the Host serves no dashboard route.
- **Headline panels:** answers and tokens delivered; atlas vs raw search share; context kept out; problems caught before commit (raised / fixed / overridden / open at commit); gate behaviour; freshness; atlas's own cost; index health and answer quality. An optional A/B panel shows the last `gsd-atlas eval` result (hooks off / advise / enforce).
- **Honesty rules:** every figure is labeled `measured`, `estimated`, or `A/B` with its method, denominator and interval; the low bound is the headline; no single score; atlas's own cost sits beside its savings; no value statistics reach agent context.
- **Local only:** a per‑Tenant Metrics module with its own database file; no source text, paths, symbol names or prompts; nothing is uploaded except a diagnostics report the user approves (§11.2).

---

## 9. Interop with gsd‑graph
gsd‑atlas does not write into gsd‑graph's store. `gsd-atlas bridge export` writes the code‑to‑decision links (which modules and symbols cite which ADRs, which modules depend on which) in a format gsd‑graph ingests. The gsd‑graph side is specified in *gsd‑graph PRD: Atlas bridge*. Neither package depends on the other at install time.

---

## 10. User Stories
| ID | User Story |
|----|------------|
| **U1** | As a developer I run `gsd-atlas init && gsd-atlas watch` once and my agent always has current code facts on every worktree. |
| **U2** | As an agent user I ask "what calls `parseDecisions` and which ADRs govern it?" and get callers with file:line and the cited ADRs. |
| **U3** | As a developer using a language gsd‑atlas doesn't ship, I drop a module into `.gsd-atlas/languages/` and get definitions and references with no release. |
| **U4** | As an iOS developer my agent uses the iOS 27 SDK installed on my Mac and my app's deployment target, not iOS 18 from memory. |
| **U5** | As a gsd‑core maintainer I get facts from `src/*.cts`, with emitted `.cjs` mapped back to source, so agents edit source, not build output. |
| **U6** | As a reviewer, `sdk_check` flags invented or deprecated APIs before the agent proposes a diff. |
| **U7** | As a Linux CI job I import an SDK pack built on a Mac and run `sdk_check` without Xcode. |
| **U8** | As a gsd‑graph user I see which code implements which ADR in my decision graph. |
| **U9** | As a developer I never run cleanup: old file versions are retired and collected, missed changes are repaired, and the store stays near the size of a fresh build. |
| **U10** | As an agent user I ask what a function looked like at a past commit and get an answer rebuilt from git, without the store keeping that history. |
| **U11** | As a developer running an agent swarm, hundreds of short‑lived agents in their own worktrees all query gsd‑atlas at once, and each gets current answers in milliseconds without the machine running out of memory. |
| **U12** | As a maintainer, agents that try to grep or edit around atlas get the atlas answer handed to them, and can't finish with stale APIs or broken callers. |
| **U13** | As a developer working in several repos at once, each with its own sessions and agents, one atlas host serves them all, the iOS SDK facts are stored once, and no repo's facts leak into another's agents unless I group them. |

---

## 11. Acceptance Criteria
1. **Build:** on gsd‑core, per‑construct recall ≥ 90 % against the compiler symbol table; every fact has `span`; files with grammar parse errors ≤ 0.5 %; a hand‑verified sample of `EXTRACTED` edges ≥ 98 % correct.
2. **Citations:** `code_refs` and `code_context` results carry file, line and fact id; each line lies inside the fact's `span`.
3. **Bring‑your‑own:** the Python example module passes its fixtures and indexes gsd‑path with no change to gsd‑atlas source; gsd‑path's 553 Python files are stored as their 230 distinct contents.
4. **Emit mapping:** no gsd‑core fact points under its `outDir`; `require`s of emitted paths resolve to `.cts` sources.
5. **Swift without a build:** a Swift app repo yields definitions, references and deployment targets on Linux with no Xcode; grammar‑tier resolved references ≥ 85 % precise on the reference app.
6. **Platform currency:** with Xcode 27, `platform_card` reports iOS SDK 27.0 and the project's deployment target; `sdk_check` meets the §2 fixture target.
7. **Worktrees:** two worktrees of one repo share local facts; a branch switch re‑parses only changed files; on a fixture where the same file resolves to different targets on two branches, each branch gets its own correct target.
8. **Offline:** build plus SDK extraction completes with networking disabled.
9. **Interop:** gsd‑graph ingests `bridge export` output and answers "which code implements ADR‑457?" with citations.
10. **Parity:** MCP tools and CLI return identical JSON for the same request.
11. **Performance budgets:** the benchmark suite meets every budget in DESIGN.md *Performance & durability* at 1M LOC and on gsd‑core.
12. **Durability:** every durability test in DESIGN.md passes, including SIGKILL during writes and automatic rebuild of a corrupted store.
13. **Lifecycle:** every budget in DESIGN.md *Lifecycle, compaction & self‑healing* is met: after 20,000 edits the store is ≤ 1.25× a fresh build; a missed file event is repaired by the next Reconcile; `history --at` answers from git without writing to the store.
14. **Scale:** every budget in DESIGN.md *Concurrency & scale* is met in CI at 100 and 1,000 concurrent short‑lived agents and 500 worktrees; the nightly soak returns to baseline memory.
15. **Enforcement:** in `enforce` mode on the eval tasks, broken‑caller edits, stale or invented API uses and syntax‑level violations reaching a commit drop versus hooks off, with total tokens no higher; hook p99 ≤ 20 ms at 1,000 agents; no gate ever blocks when the daemon is down.
16. **Multi‑repo:** every budget in DESIGN.md *Multi‑repo workstation* is met with 10 active repos, including the open‑gsd reference set (gsd‑core, gsd‑pi, gsd‑path, gsd‑graph, gsd‑atlas); a repo outside a declared workspace returns no facts to another repo's agents.
17. **Security:** a fixture repo with committed config enabling commands and a module with `precise.command` runs no command; a browser‑style request to the host is rejected; injection text in a doc comment comes back fenced in `untrusted_text`.
18. **Version skew:** two repos pinned to different gsd‑atlas majors run side by side; an older host refuses a newer store with a clear message.
19. **Platforms:** criteria 1, 2, 4, 7, 10 and 12 pass on macOS, Linux and Windows.
20. **Diagnostics and forensics:** every acceptance test in `DIAGNOSTICS.md` §8 and §9.6 passes: nothing collected or sent by default, per‑type consent enforced, new types off until approved, fixture secrets and names never appear in a report, repo config can't enable it, the intake bot validates and redacts.
21. **Dashboard:** `gsd-atlas dashboard` on the eval fixtures labels every figure `measured`, `estimated` or `A/B`; no total adds values of different classes; an estimate always shows its range and denominator; a fixture agent that makes needless calls does not raise the context‑kept‑out headline; no value statistic appears in `atlas_status`, hook briefs or MCP output; the report contains no fixture secret, path, symbol name or prompt; a metrics write failure never blocks an answer or a gate; deleting a Tenant deletes its metrics.

---

## 11.1 Install and upgrade
- **Install:** `npm i -g @opengsd/gsd-atlas` (or per repo as a devDependency); `gsd-atlas init` registers MCP and hooks for the detected agent hosts, the same way gsd‑graph's `mcp-install` does.
- **Host:** started on demand by the first client; one per major version (A46).
- **Upgrade:** a minor or patch upgrade replaces the running host after it drains requests; a major upgrade starts a new host beside the old one, and repos move when their pinned version does.
- **Uninstall:** `gsd-atlas uninstall` removes registrations; stores are derived and can be deleted at any time.

## 11.2 User‑controlled diagnostics and ratings
Full design: `DIAGNOSTICS.md`.
- **Off by default; no telemetry.** Turning it on walks through each **data type**, showing its fields, the real values from this machine, how it helps and what it can't reveal. Every type starts denied and is approved individually.
- **Data types:** Report header, Platform, Agent setup, Languages and index quality, Scale profile, Performance, Reliability, Agent behaviour, Ratings, Notes. Never sent: code, paths, names, repos, branches, commits, doc text, prompts, environment, user or host identity.
- **Ratings:** ↑ worked · ↔ meh (worked but not impressed) · ↓ didn't work, for a session, a feature or the last answer; user only.
- **Submission:** the user previews the exact issue and submits it with their own `gh` CLI or a pre‑filled issue page; automatic weekly or monthly submission is a separate opt‑in that never includes notes.
- **Repo intake:** a GitHub Action validates each report against the published catalog, redacts anything else, records it without author or issue number, routes budget breaches, crashes and ↓ ratings, posts a weekly roll‑up and closes the issue.
- **Defect forensics:** `gsd-atlas bug` captures everything a maintainer needs for one failure.
  - **Sources:** a local flight recorder of recent events, the problem statement, versions and effective config, store and host health, the failing answer with `explain`, and an optional minimal repro.
  - **Approval:** each data type is approved, with names and paths hashed by default.
  - **Destination:** a public bug issue, a private security report, or a local bundle.
  - **Intake:** the workflow deduplicates and routes defects but never closes them automatically.

---

## 12. Risks & Open Questions
- **Grammar drift** (Swift ships yearly): pin grammar + queries, fixtures per language version, file‑level fallback on parse errors.
- **Compiler mismatch:** load the project's own `typescript`; report it in `lang_list`.
- **TypeScript 7 API change:** TypeScript 7.0 (native, July 2026) replaces the classic `ts.createProgram` API with `typescript/unstable/sync|async` over IPC. The TypeScript module ships two adapters (6.x classic, 7.x native) chosen by the project's installed version; the 7.x API is marked unstable, so it is pinned and tested per minor release.
- **Swift precision needs a Mac and a build:** grammar tier and project model work everywhere; precise is additive.
- **SDK extraction cost:** imported frameworks only by default; cache per SDK id.
- **Sparse SDK doc comments:** declarations + availability are the core value.
- **Untrusted repos and modules:** permissions only from user config; WebAssembly sandbox; repo text fenced as untrusted (trust‑boundaries ADR).
- **Grammar drift is already measurable:** the third‑party TypeScript WASM bundle mis‑parsed 2.8 % of gsd‑core files; grammars are built from pinned upstream with a parse‑error budget.
- **Precise tier memory:** compiler programs don't share across worktrees; precise resolution is bounded and flagged `degraded` elsewhere.
- **Single host:** a crash affects every repo; mitigated by a supervisor, per‑tenant watchdogs and fail‑open hooks, and reported in `status`.
- **Scope:** the full design is large; the MVP is deliberately gsd‑core only, single tenant, stdio.
- **Dynamic `require` / `eval`:** grammar‑tier pattern fallback, `INFERRED`.
- **Over‑enforcement:** gates that annoy or loop make agents worse. Mitigation: advise by default, gates demand one cheap call, one retry passes, Stop blocks capped at 3, local metrics to tune.
- **Host hook differences:** hosts expose different events and outputs. Mitigation: build on gsd‑core's portable event floor, degrade to rule text, and keep the git pre‑commit backstop.
- **Open:** results of the free‑alternatives evaluation (§1.1); IndexStoreDB helper spike for Swift; whether ADR ids should resolve to gsd‑graph `Decision` or `Document` nodes (bridge PRD); network sharing after privacy review.

---

## 13. Success Metrics
- Per‑construct recall by language and tier.
- Answer accuracy with valid citations versus a grep‑only baseline.
- Freshness lag from save to updated facts.
- SDK catch rate on the fixture set.
- Ratings ↑ ↔ ↓ per feature and budget breaches per release, from user‑submitted diagnostics (§11.2).
- Community modules published (npm `gsd-atlas-lang-*`). No telemetry; public download counts only.

---

## 14. Roadmap
| Milestone | Scope | Gate |
|-----------|-------|------|
| **M0** – Repo & seams | Repo, borrowed gsd‑graph modules, ADRs ratified, manifest schema, grammar build pipeline, module resolution, trust model. Module interfaces fixed with their test doubles: Fact Store (fact‑level seam; one conformance suite over both SQL drivers), Source Tree (real temp git repos), CommandRunner (real and recording fake; Source Tree runs git through it), Grammar Engine, PreciseResolver seam, Governor interface | `lang test` runs a fixture module end to end on all three OSes; Fact Store and CommandRunner interface tests green |
| **M1** – Grammar tier + store + host (MVP part 1) | Metrics module recording answers, tokens, freshness and index health, with `status` panels; Grammar Engine with self‑built grammars, Source Tree, Indexer (watcher, coalescing queue, Reconcile, `ensureFresh`), Fact Store (local facts, overlays, lifecycle, maintenance), Query with the full response envelope and the read tools, CLI as an adapter over Query, single‑tenant Host over stdio MCP, Governor with priority classes and `busy` | gsd‑core local facts on all three OSes; criteria 2, 10, 12 |
| **M2** – TypeScript module (**MVP: gsd‑core development**) | PreciseResolver adapters for TypeScript 6.x and 7.x (sandboxed, started through the CommandRunner), resolved edges, emit mapping, ADR citations, `explain`, skill, ↑ ↔ ↓ ratings, manual diagnostics reports, flight recorder and `gsd-atlas bug` | gsd‑core build < 30 s; criteria 1, 4, 7, 17; 50‑question gsd‑core eval beats grep‑only |
| **M2.5** – Host hardening | Diagnostics auto‑submit and the repo intake workflow; Host composing a Tenant per repo, versioned protocol, socket/HTTP transport with endpoint security, supervisor and watchdogs; full Governor (weighted round‑robin across tenants, memory budget, parser and compiler pools); shared public SDK/package stores | Criteria 14, 16, 18, 20 |
| **M3** – Swift module | Swift language module (data for the Grammar Engine, including `refs.scm`), SwiftPM/Xcode project model, availability facts | Criterion 5 met on Linux CI |
| **M4** – Platform SDK facts + agent integration | Apple SDK provider (registered by id, per‑axis availability table), SDK packs, `platform_card`, `sdk_lookup`, `sdk_check`, `sdk_diff`, `syntax_check`; Policy module with skill, `atlas-scout`, hooks R0–R4 (advise + enforce), pre‑commit check; dashboard (gate and findings panels, static HTML report), `gsd-atlas eval` and the A/B panel | Criteria 6 and 15 met with Xcode 27 |
| **M5** – Precise imports, BYO proof, bridge | SCIP importer and the Swift IndexStoreDB helper (both PreciseResolver adapters), Python example module, authoring guide, `bridge export` | Criteria 3 and 9 met; eval beats grep‑only on gsd‑core, gsd‑pi, gsd‑path and the Swift app |
| **M6** – 1.0 | Docs, install and upgrade guide, performance pass, free‑alternatives re‑check | All criteria green |

---

*End of PRD*
