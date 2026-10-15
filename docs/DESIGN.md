# gsd‑atlas — Design

**Status:** Draft · 2026‑10‑15 · companion to `PRD.md`

gsd‑atlas keeps a live, local map of a codebase and the platform SDKs it targets, and serves it to coding agents over MCP, a CLI and an Agent Skill. This document records the frozen decisions (the A‑table), the architecture and what is borrowed from gsd‑graph.

---

## Decisions (A‑table)

| Id | Decision | Why |
|----|----------|-----|
| **A1 — Product** | Code and platform intelligence for agents: code facts plus installed‑SDK facts. Not a general knowledge graph (that is gsd‑graph). | Clear boundary with gsd‑graph; one job done well. |
| **A2 — Fact model: two layers** | **Local facts** come from one file alone (definitions, containment, imports as written, reference sites with the name and import path as written) and are keyed by the file's content hash. **Resolved edges** (a reference bound to its target definition) depend on the rest of the project and are keyed by (overlay snapshot, resolution context hash: the module's config files plus the dependency lockfile). Both carry gsd‑graph's provenance shape; `span` is mandatory on every code fact. | The same file content can resolve to different targets on different branches; sharing resolved edges by file hash would cite wrong code (review F‑1). |
| **A3 — Store** | SQLite via `node:sqlite`, WAL mode, behind a small driver interface (`better-sqlite3` as fallback). The store is derived and rebuildable from source; source is the truth. | Sub‑second incremental updates and queries; zero‑ops embedded DB; no review gates needed for derived facts. |
| **A4 — Location** | `$(git rev-parse --git-common-dir)/gsd-atlas/` by default. Falls back automatically to `${XDG_CACHE_HOME:-~/.cache}/gsd-atlas/<repo-id>` (one notice, never a refusal) for non‑git roots, a read‑only `.git`, or a repo inside a synced or network folder (A17); `store.dir` overrides. | Every worktree finds the same index; never committed; no gitignore edits; works for repos kept in synced folders. |
| **A5 — Branches & worktrees** | Each worktree or branch is an overlay mapping paths to content hashes. Local facts are shared by hash across every overlay. Resolved edges are computed per overlay snapshot, lazily at query time and cached; overlays with identical resolution inputs share them. | Branch switch re‑indexes only changed files, and resolved answers are always correct for the overlay asked about. |
| **A6 — Languages are modules** | A language is a manifest + WebAssembly tree‑sitter grammar + query files (+ optional precise and platform tiers). Built‑ins use the same format. | Bring‑your‑own language with no core change or release. |
| **A7 — Tiers** | Grammar (required, always on), Precise (optional: SCIP import or compiler adapter), Platform (optional: SDK provider). Precise facts supersede grammar references at the same span. | Works everywhere with no build; precision where available. |
| **A8 — Confidence** | Grammar definitions/imports `EXTRACTED`; name‑matched references `INFERRED`; precise and platform facts `EXTRACTED`. Same tier names and rank order as gsd‑graph. | Honest about name‑matching; filterable. |
| **A9 — Who may run commands** | Grammars are sandboxed WebAssembly and queries are data, always allowed. **Built‑in first‑party providers** (shipped with gsd‑atlas, fixed command lines such as `xcrun`, `swift symbolgraph-extract`, `git`) run by default and can be turned off. **Any other command** (a module's `precise.command`, a third‑party SCIP indexer) runs only when allowed in **user‑level** config (`~/.config/gsd-atlas/`), per repo and per command; repo‑committed config and repo modules can never grant it (A44). | Headline features work out of the box; cloning a hostile repo can't execute code (review S‑1, SDK‑1). |
| **A10 — SDK facts are local** | Extracted from SDKs installed on disk, stored per SDK id = platform + SDK version + SDK build + variant (e.g. `ios-27.0-27A266a-device`, `…-simulator`, `…-maccatalyst`), versions kept side by side; never fetched from the web. SDK packs move facts to machines without the SDK. | Ground truth for what compiles; betas and variants don't collide (review SDK‑2). |
| **A11 — MCP** | Read tools on by default; `atlas_build` and anything that runs commands need `--allow-build`. Local only: loopback HTTP or a stdio shim (A27). | Same footgun stance as gsd‑graph K14. |
| **A12 — CLI contract** | JSON on stdout, reasons on stderr, exits 0/1/2/3 (gsd‑graph K22). | Agent‑friendly, consistent across GSD tools. |
| **A13 — Runtime and platforms** | TypeScript, Node ≥ 24; the `node:sqlite` driver is tested on every supported Node minor in CI, with `better-sqlite3` kept working. macOS, Linux and Windows are 1.0 platforms, each in every budget's CI run from M1. | `node:sqlite` with extension loading runs without an experimental warning on Node 24; GSD users run all three OSes (review ST‑4, O‑1). |
| **A14 — Host coupling** | No dependency on gsd‑graph, gsd‑core or `.planning/`. gsd‑core is a validation corpus only. | Standalone install; open‑gsd boundary rules. |
| **A15 — Vectors** | Post‑1.0, opt‑in: `sqlite-vec` in the same store, local embedding models only when accelerated hardware is present. | Semantic recall without a second database or a cloud call. |
| **A16 — Privacy** | No network by default; no telemetry. The only data that ever leaves the machine is a diagnostics report the user enables, approves per data type, previews and submits (A52). | Local‑first, same as gsd‑graph. |
| **A17 — Durability** | One writer per store; WAL with `synchronous=NORMAL`; a store under a synced or network path moves to the cache location (A4); copies only through SQLite's backup path; check on open and rebuild on failure; schema changes rebuild lazily per repo at low priority while serving still‑valid facts marked stale. | SQLite's documented corruption causes are usage patterns; the store is derived, so rebuild is always safe (see Performance & durability). |
| **A18 — Size discipline** | No source text, no history, content‑hash dedupe across branches; embeddings (A15) quantized. | Keeps the store in the hundreds of MB at 1M LOC instead of GB. |
| **A19 — Content hash = git blob id** | A file's content hash is its git blob id computed with the same clean filters git applies (`git hash-object --path`), for tracked, modified and untracked files alike, with the line‑ending mode recorded so spans line up. Git LFS pointer files are skipped with a diagnostic. | Facts line up with git objects, so any version can be rebuilt from git; `git ls-files -s` gives a cheap drift check; LFS and CRLF don't corrupt spans (review F‑3). |
| **A20 — Retire, then collect** | Local facts for a file version are live while any overlay points at its hash. When none does, the version is retired and collected when **either** its content exists as a git object (git can rebuild it) **or** the grace period has expired (default 24 h). Resolved‑edge caches for a dropped overlay snapshot are discarded immediately. Git is the history: past versions are replayed from git objects, never kept in the store. | The store holds what agents need now; uncommitted churn can't accumulate (review L‑1). |
| **A21 — Self‑maintenance** | The daemon runs reconciliation, garbage collection, compaction and health checks in idle time, within a time budget, and reports them in `status`. Every task is also a CLI command. | The store stays current and compact without anyone running cleanup. |
| **A22 — One host per user and major version, repos as tenants** | A single `gsd-atlas` host per user and major version serves every repo. Each repo is an isolated tenant: its own store, writer, lock, queues, policy and watchdog; a stuck tenant is unloaded without affecting others. A small supervisor restarts the host on crash. The first client starts it (lock election); idle repos unload after 10 minutes; the host exits when nothing is active. | Expensive runtime state exists once per machine; one bad repo or one crash doesn't take atlas away from every session (review H‑4). |
| **A23 — Small, bounded cost per agent; no caps** | Requests are stateless. Per‑agent cost is an open connection, an MCP session and a bounded ledger entry (A37): zero extra processes on hosts with HTTP MCP and HTTP hooks; one thin process per agent for stdio‑only clients, and one per tool call for hosts without HTTP hooks. No per‑agent index, cache or compiler, and no hard‑coded limit on agents or connections; limits are configurable back‑pressure, never caps. | Adding agents adds queries, not state; capacity is bounded by the machine, not the design (review H‑2 restates the claim honestly). |
| **A24 — Work scales with change, not agents** | The index queue is keyed by (worktree, path) holding only the latest hash; repeated events coalesce. Facts are content‑addressed, so a file version is indexed once however many agents or worktrees see it. Writes are group‑committed. | A hundred agents saving the same file cost one index job. |
| **A25 — Bounded heavy resources** | Compiler services (e.g. a TypeScript program, ~360 MB for gsd‑core) live in an LRU pool under one machine‑wide memory budget (default 25 % of RAM). A compiler program is per file set, so precise resolution runs for a bounded number of overlays, most recently active first; other overlays get grammar facts plus precise edges from their base commit, marked as such. | Memory stays flat as agents and worktrees grow; precision degrades visibly instead of memory blowing up (review LM‑3). |
| **A26 — Read your own writes** | Every response carries the index watermark for its worktree. A request may ask for `fresh` paths: the daemon indexes those first and waits up to a timeout before answering. | An agent that just edited a file never reasons from its old version. |
| **A27 — Transport and endpoint security** | The host listens on a Unix domain socket (macOS, Linux) or named pipe (Windows) where the client supports it, and on 127.0.0.1 at a fixed, configurable per‑user port otherwise. Every route, including hooks and health, requires the token from a `0600` file; `Host` and `Origin` are validated and browser‑style requests rejected. Hook configs read the token from an allowed environment variable or the token file. A stdio shim (`gsd-atlas-mcp`) proxies for stdio‑only clients and loads no database, grammar or compiler. | No per‑agent process on capable hosts; web pages can't reach the host; static hook settings can find it (review S‑2, H‑3). |
| **A28 — Overload behaviour** | Priority queues: interactive reads > `fresh` requests > change indexing > maintenance. Round‑robin across connections; each query has a time limit (SQLite interrupt). When saturated, answer `busy` with `retry_after` instead of slowing everyone. | Under any load, latency stays predictable and nothing falls over. |
| **A29 — SDK sources, in order** | Installed toolchain files first; command‑assisted extraction only when allowed (A9); imported SDK packs (hash‑pinned, read‑only SQLite) for machines without the SDK. One normalized shape for every provider, with availability on one or more axes. See `SDK-PROVIDERS.md`. | Every major open toolchain already ships versioned API data on disk. |
| **A30 — Facts by default, prose only from local sources** | Providers store names, signatures and availability. Doc prose comes only from what is installed locally; third‑party doc archives are user‑imported packs, never bundled. | Keeps licensing clean (BCD CC0, typeshed Apache‑2.0) and avoids redistributing docs. |
| **A31 — Language level is a fact** | Each project's language level is read from its build files, and each module ships `features.json` (feature → minimum level + tree‑sitter query) so `syntax_check` can flag syntax above that level. The TypeScript module carries two compiler adapters (6.x classic API, 7.x native API). | Agents stop writing syntax the project's compiler rejects; TypeScript 7 doesn't break the adapter. |
| **A32 — Atlas must be the cheaper path** | MCP tools return ranked, cited answers within a token budget (default 2,000), with a freshness watermark; `code_context` and `code_impact` replace multi‑file reading. | Agents choose atlas because it costs less than grep, not only because they're told to. |
| **A33 — Skill routes, hooks enforce** | One auto‑invoked `gsd-atlas` skill carries routing and rules; behaviour is enforced only by hooks and the git pre‑commit check, never by skill text alone. | Instructions get ignored; hooks see what actually happens. |
| **A34 — Answer, then gate** | Hooks first answer for the agent (attach atlas results to its search or edit). Gates only demand one cheap atlas call, open whenever atlas can't answer or facts are stale, and a search is only ever denied when atlas has an exact, complete answer for that query (a definition or reference match on an indexed symbol); text, string, log and config searches always pass. | Enforcement that never dead‑ends, and never blocks searches atlas can't answer (review M‑1). |
| **A35 — Policy modes** | Per‑repo `off` / `advise` (default) / `enforce` / `strict`, per rule; overrides come from the user, never the agent. | Teams tighten gradually; swarms can run strict. |
| **A36 — Hooks fail open, run in the daemon** | HTTP hooks to the daemon (thin forwarder where HTTP hooks aren't available); p99 ≤ 20 ms; every hook declares fail‑open. | Hook cost stays flat at hundreds of agents; atlas being down never stops work. |
| **A37 — Bounded session ledger** | Per (session, agent): consulted symbols, edited files, findings, gate counters; in memory, expiring, evictable, never required for correctness. | Gates need memory of what the agent did; A23 still holds. |
| **A38 — Runtime‑agnostic backstop** | `gsd-atlas check --staged` as a git pre‑commit hook and CI step, on the portable event floor shared with gsd‑core for agent hosts. | Every agent and human gets the same final check, whatever the host supports. |
| **A39 — Shared stores for public shared facts** | SDK facts (`sdk.db`, by SDK id) and public package facts (`pkg.db`, keyed by ecosystem + name + lockfile integrity hash) live once per machine under `${XDG_CACHE_HOME:-~/.cache}/gsd-atlas/shared/`, reference‑counted by the repos that use them. Only packages resolved from a public registry are shared; private, scoped‑private, git, workspace and patched packages stay in the repo's own store. | Shared content stored once without leaking one repo's private packages to another's agents (review SDK‑3). |
| **A40 — Fair, global resource governor** | One memory budget, one parser pool and one compiler pool for the machine, scheduled fairly across repos and then across agents (A28) by recent activity. Interactive work in any repo outranks background work in all repos. | A busy swarm in one repo can't starve agents in another; 10 repos don't mean 10 × 25 % of RAM. |
| **A41 — Workstation size budget** | A machine‑wide disk budget (default 2 GB, configurable) on top of per‑repo budgets. Over budget, the host first collects and compacts (A20–A21), then drops stores of repos untouched for 30 days (rebuilt on next use, since stores are derived); shared facts no repo references are collected the same way. | Total size is bounded and reported; nothing grows silently. |
| **A42 — Repos are isolated by default** | An agent in one repo sees only that repo's facts plus shared SDK/package facts. Cross‑repo queries only within a workspace the user declares (`~/.config/gsd-atlas/workspaces.json`), answered by fan‑out across repo stores, never by `ATTACH` (capped at 10 databases). | Client or private repos never leak into another repo's agents; cross‑repo has no built‑in cap. |
| **A43 — Repo identity** | Repo id = root commit hash + a random store id written on first index. The path is only a lookup key; submodules of a repo join its workspace automatically (A42). | Moving a repo keeps its id and store; independent clones don't collide; parent repos can see their submodules (review L‑3, L‑4). |
| **A44 — Trust boundaries** | Repo content, package content and SDK prose are untrusted data. Permissions (commands, network, workspaces, policy overrides) come only from user‑level config. Every prose field returned to agents or injected by hooks is fenced as untrusted data, length‑capped and passed through gsd‑graph's redaction and gsd‑core's injection‑scanner patterns. | A cloned repo or a dependency can't steer the agent or the host (review S‑1, S‑3, S‑4). |
| **A45 — Stable symbol identity** | Symbol identity = (repo, path, qualified name, kind, overload discriminator); the content hash is the symbol's version, not part of its identity. Edges and ledger entries point at identities; renames and moves are detected as remove + add with a `renamed_from` hint when signatures match. | Editing one line doesn't break every reference to the file's symbols (review F‑2). |
| **A46 — Versioned host protocol** | Clients and host exchange a protocol version on connect; one host per major version (`~/.cache/gsd-atlas/host-<major>/`); stores record their schema version and an older host refuses a newer store with a clear message. | Repos pinned to different gsd‑atlas versions keep working side by side (review H‑1). |
| **A47 — What counts as source** | Index `git ls-files` plus untracked, non‑ignored files only; honour `linguist-generated` and `linguist-vendored`; skip binaries and LFS pointers; per‑repo excludes live in user config. | Generated trees, vendored code and committed databases don't flood the index (review LM‑5). |
| **A48 — Grammar supply** | Grammars are built from pinned upstream tree‑sitter releases into WebAssembly by gsd‑atlas's own build, never taken from third‑party WASM bundles. Each module carries a parse‑error budget checked in CI on the reference corpora; files with parse errors are reported in `status` and fall back to the precise tier where it exists. | The third‑party TypeScript WASM bundle already mis‑parsed 8 gsd‑core and 36 gsd‑pi files (review LM‑1). |
| **A49 — Scheduling** | Per‑tenant queues with weighted round‑robin across tenants, a per‑tenant concurrency cap derived from the governor (A40), then priority classes (A28) within a tenant. | A 500‑agent swarm in one repo keeps other repos within 2× their idle latency (review H‑5). |
| **A50 — Evidence standard** | Budgets are gated on real corpora (gsd‑core, gsd‑pi, gsd‑path) with the real MCP SDK, on macOS, Linux and Windows. Answer quality: ≥ 50 pre‑written questions per corpus (including ones atlas should abstain on), ≥ 3 runs per configuration, results with intervals. Precision: a hand‑verified sample of `EXTRACTED` edges ≥ 98 % per corpus. | Synthetic prototypes showed feasibility, not the budgets (review E‑1, E‑2, E‑3). |
| **A51 — Explainability** | Every citation carries a `debug` handle; `gsd-atlas explain <fact>` shows extractor, tier, grammar version, resolution context and overlay. | When an answer is wrong, a user can see why (review O‑2). |
| **A52 — User‑controlled diagnostics** | Disabled by default. When enabled, the user approves each data type after reading its fields, real values, how it helps and what it can't reveal. Reports go to the gsd‑atlas repo as GitHub issues under the user's own account, by manual submit or a separate auto‑submit opt‑in. Ratings ↑ worked / ↔ meh / ↓ didn't work come only from the user. A repo GitHub Action validates reports against the published catalog, redacts anything else, records, routes and rolls them up. See `DIAGNOSTICS.md`. | Real‑world feedback with explicit consent for every kind of data, and no server to trust. |
| **A53 — Defect forensics** | A capped, local‑only flight recorder per tenant; `gsd-atlas bug` turns it, the problem statement, versions, config, store and host health, the failing answer with `explain`, and an optional repro into a GitHub issue. Each forensic data type is approved by the user, with names and paths hashed by default; security issues go to private vulnerability reporting; the repo intake deduplicates and routes but never auto‑closes defects. See `DIAGNOSTICS.md` §9. | Defects arrive reproducible on the first report, under the same consent rules as diagnostics. |
---

## Architecture

```
            ┌──────────── modules (data) ────────────┐
 files ─▶ resolver ─▶ grammar tier (WASM + queries) ─┐
            │        precise tier (SCIP / compiler) ─┼─▶ normalizer ─▶ SQLite store ─▶ MCP / CLI / Skill
            │        platform tier (SDK provider) ───┘     (A2)          (A3–A5)
 watcher ───┘                                                                    └─▶ bridge export ─▶ gsd‑graph
```

- **Resolver:** maps a path to a module by extension and project markers (PRD §4.4).
- **Watcher:** file events plus git events (checkout, worktree add) feed changed paths; content hashes skip unchanged files.
- **Normalizer:** maps module captures onto the fixed vocabulary (PRD §4.7), assigns ids, attaches provenance.
- **Store tables (initial):**
  - Overlays: `overlays(id, worktree, ref, snapshot_hash)`, `overlay_files(overlay_id, path, content_hash)`.
  - Local layer (A2, keyed by content hash): `file_versions(content_hash, module, grammar_version, parse_errors)`, `local_symbols(symbol_identity, content_hash, kind, name, span)`, `ref_sites(content_hash, span, name, import_path, kind)`, `local_facts(content_hash, s, p, o, confidence, span)`.
  - Resolved layer (A2, keyed by snapshot + context): `resolution_contexts(id, config_hash, lockfile_hash)`, `resolved_edges(snapshot_hash, context_id, ref_site, target_identity, confidence)`.
  - Identity (A45): `symbols(identity, repo, path, qualified_name, kind, discriminator)`.
  - Shared stores: `sdks(id, platform, version, build, variant, path)`, `sdk_symbols(sdk_id, usr, kind, decl, introduced, deprecated, obsoleted, doc)`, `targets(id, platform, min_version)`.

---

## Performance & durability

SQLite is sized for this workload: one writer, many readers, one‑ or two‑hop lookups. The budgets below are release gates, checked by a benchmark suite in CI (`npm run bench`) on gsd‑core, gsd‑pi and gsd‑path with the real MCP SDK on macOS, Linux and Windows (A50); the synthetic 1M‑LOC fixture stays as a scale check. The measured numbers below are prototype evidence, not proof of the budgets.

### Measured baseline (2026‑10‑15)
Node 24, `node:sqlite`, WAL, in a 2‑core cloud container (slower than a developer laptop). Synthetic store: 10,000 files, 300K symbols, 1.5M references (roughly 1M LOC).

| Operation | Measured |
|-----------|----------|
| Full build (one transaction) | 9.4 s |
| Store size | 116 MB |
| Re‑index one changed file | 11.8 ms |
| Symbol by name | 0.01 ms |
| All references to a symbol | 0.7 ms |
| Callers two levels deep | 5 ms |
| Reads during continuous writes (1.9M reads in 5 s) | worst read 8.9 ms |
| Writer killed with SIGKILL mid‑write | `integrity_check` ok |

Real corpus: gsd‑core `src/` is 167K lines of `.cts`; the TypeScript compiler pass took 5.4 s and produced about 50K declarations, imports and resolved call sites. tree‑sitter parsed 304 TypeScript files/s single‑threaded over gsd‑pi (3,982 files, 44 MB, 13.1 s). Parsing, not storage, dominates build time. `node:sqlite` supports FTS5 with the trigram tokenizer for fuzzy names.

### Budgets (release gates)
| Metric | Budget at 1M LOC | Budget at gsd‑core |
|--------|------------------|--------------------|
| Store size (no embeddings) | ≤ 250 MB | ≤ 50 MB |
| Full build, storage time only | ≤ 20 s | ≤ 3 s |
| Re‑index one file, storage time | ≤ 25 ms | ≤ 25 ms |
| `code_find` p95 | ≤ 5 ms | ≤ 5 ms |
| `code_refs` p95 | ≤ 10 ms | ≤ 10 ms |
| Two‑hop callers p95 | ≤ 50 ms | ≤ 50 ms |
| `code_find` fuzzy (FTS5 trigram) p95 | ≤ 20 ms | ≤ 20 ms |
| Grammar‑tier full build with the parser pool | gsd‑pi ≤ 15 s | ≤ 5 s |
| Files with grammar parse errors | ≤ 0.5 % per module (A48) | ≤ 0.5 % |
| Hand‑verified precision of `EXTRACTED` edges | ≥ 98 % | ≥ 98 % |
| Worst read while writing | ≤ 50 ms | ≤ 50 ms |
| Store growth per extra branch with ≤ 5 % of files changed | ≤ 10 % | ≤ 10 % |

### Durability rules (A17)
| Risk | Rule | Test |
|------|------|------|
| Several writers | Only the daemon's writer (A22) writes, holding the build lock; every query connection opens read‑only. | Second writer gets a clear lock error, not a corrupt store. |
| Synced or network folder | A store that would land under iCloud Drive, Dropbox, OneDrive, Google Drive or a network mount moves to the cache location (A4), with one notice. | Repo on a fake synced path gets its store in the cache location. |
| Copying a live file | SDK packs, exports and backups use `VACUUM INTO` / the backup API, never a file copy. | Pack made during writes passes `integrity_check`. |
| Unsafe settings | `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout` set; `synchronous=OFF` never used. | Settings asserted on open. |
| Crash or power loss | Every file's facts change in one transaction. | SIGKILL during writes → `integrity_check` ok and no half‑indexed file. |
| Corruption anyway | `quick_check` on open; on failure move the file to `*.corrupt-<time>` and rebuild, reporting it in `status`. | Corrupted fixture rebuilds without user action. |
| Schema change | A new schema version rebuilds each repo's store lazily at low priority on first use, serving still‑valid facts marked stale meanwhile; an older host refuses a newer store (A46). | Version bump rebuilds one repo at a time; older host gives a clear refusal. |

### Size rules (A18)
- Store spans, never source text or chunks.
- Facts keyed by content hash; branches and worktrees share every unchanged file.
- No history; git is the history.
- Embeddings post‑1.0 only, opt‑in, quantized (int8 or binary), one vector per symbol rather than per chunk.
- `VACUUM` after a full rebuild; `status` reports store size against the budget.

---

## Lifecycle, compaction & self‑healing

The store holds the current state of every live branch and worktree, plus a short tail of recently retired versions. Everything older comes back from git on demand.

### Fact lifecycle (A20)
```
 indexed ─▶ live ─(no overlay points at the hash)─▶ retired ─(grace expires)─▶ collected
              ▲                                        │
              └────────(hash becomes current again)────┘   (revert, branch switch back)
```

| Event | Effect |
|-------|--------|
| File saved with new content | New hash's local facts indexed and made live for that worktree; old hash retired if no other overlay uses it; that overlay's resolved‑edge cache invalidated for files that import the changed one. |
| Branch switch | Overlay remapped; hashes no longer used anywhere are retired. Switching back revives them without re‑indexing while in grace. |
| Branch deleted, worktree removed (`git worktree prune`) | Its overlay is dropped; hashes unique to it are retired. |
| Module, grammar or compiler version changes | That language's facts are marked stale and re‑indexed in the background; old facts are served until the new ones land. |
| SDK uninstalled and no target uses it | SDK facts retired; the latest previous SDK of each platform is kept for `sdk_diff`. |

**Collection rule:** a retired version is collected when **either** its content exists as a git object **or** the grace period has expired (default 24 hours, `lifecycle.grace`). Committed content goes right away, since git can rebuild it. Overwritten uncommitted content is kept for the grace period so "what did the agent change this session" can still be answered, then collected.

### Replaying history from git
`gsd-atlas history <path|symbol> --at <commit|ref>` indexes the requested version's **local facts** from local git objects (`git show <commit>:<path>`) into a temporary in‑memory store, answers, and discards it. Resolved edges at a past commit need the whole project at that commit, so they are computed only with `--precise`, with the cost stated up front. A short‑lived cache (default 1 hour) avoids repeating work. Nothing from history is written to the main store.

A full clone already has every commit locally, so no network is used. In a shallow or partial clone, a missing commit is fetched from the remote (GitHub) only when `history.allow_fetch` is on; otherwise the command says which commit is missing.

### Maintenance tasks (A21)
Run by the daemon in idle time: never during a build, each run limited to 200 ms per slice, and backing off while the machine is busy. Each task is also a CLI command (`gsd-atlas maintain <task>`).

| Task | When | What it does |
|------|------|--------------|
| **Reconcile** | Every 5 min, on git events, on start | Compares the store's path→hash map with `git ls-files -s` plus untracked files; re‑indexes anything the watcher missed; drops paths that no longer exist. Self‑heals missed or dropped file events. |
| **Resolve** | After re‑indexing | Re‑resolves references that point at retired or missing symbols; marks the rest `unresolved` instead of leaving them dangling. |
| **Refresh stale** | After a module, compiler or SDK change | Re‑indexes stale facts in the background. |
| **Collect** | Every 15 min | Deletes retired versions whose grace has expired, in small transactions. |
| **Compact** | After Collect | `PRAGMA incremental_vacuum` (store created with `auto_vacuum=INCREMENTAL`), `PRAGMA optimize`, and a WAL checkpoint (`TRUNCATE`). A full `VACUUM` runs only when free pages exceed 25 % and the machine is idle. |
| **Check** | On start, then daily | `quick_check`; on failure, move the file aside and rebuild (A17). |
| **Report** | Always | `status` shows live versus retired facts, free pages, store size against budget, last run and outcome of each task, and anything healed. |

### Measured churn (2026‑10‑15)
Same container and schema as the baseline: 10,000 files indexed, then 20,000 edits to random files.

| Policy | Fresh store | After 20,000 edits |
|--------|-------------|--------------------|
| Keep old versions | 69 MB | 212 MB (3× rows) |
| Collect retired versions | 69 MB | 90 MB |
| Collect + incremental vacuum + optimize | 69 MB | 80 MB, longest maintenance pause 65 ms |

Without collection the store grows with every save. With collection and compaction it stays near the size of a fresh build.

### Lifecycle budgets (release gates)
| Metric | Budget |
|--------|--------|
| Store size after 20,000 edits vs a fresh build of the same tree | ≤ 1.25× |
| Retired facts as a share of the store, steady state | ≤ 10 % |
| Free pages after Compact | ≤ 10 % |
| Longest maintenance pause | ≤ 200 ms |
| Missed file event repaired by Reconcile | Within one Reconcile interval |
| Deleted branch's unique facts gone | Within grace + one Collect interval |
| `history --at <commit>` for one file in gsd‑core | ≤ 2 s |

---

## Concurrency & scale: an uncapped number of agents

Agentic tools can start hundreds of short‑lived agents at once, often each in its own worktree. gsd‑atlas has no designed agent limit: per‑agent cost is constant and small (A23), shared work is done once (A22, A24), heavy resources are budgeted (A25), and overload produces `busy`, not failure (A28). Each release states the level it was tested at; that is a tested level, not a cap.

### Shape
```
 agents (any number, short-lived)
   │ HTTP MCP (127.0.0.1)          │ stdio shim (thin proxy)
   └──────────────┬────────────────┘
                  ▼
   atlas host, one per user (A22): repo tenants
   ┌────────────────────────────────────────────────────────────┐
   │ router ─▶ priority queues (A28)                            │
   │   reads ─▶ read pool (threads ≈ cores, read-only SQLite)   │
   │   fresh/changes ─▶ index queue (coalesced, A24)            │
   │        ─▶ parser pool (WASM grammars) ─▶ single writer     │
   │        ─▶ compiler pool (LRU, memory budget, A25)          │
   │   maintenance (idle only, A21)                             │
   └────────────────────────────────────────────────────────────┘
                  ▼
     SQLite store (WAL: unlimited readers, one writer)
```

### Why per‑agent processes don't scale
Measured 2026‑10‑15: a process that only opens the store read‑only uses 44 MB; a TypeScript program for gsd‑core uses 357 MB. Per‑agent servers at 500 agents would need about 22 GB for readers alone, or about 178 GB with a compiler each. The daemon serves 1,000 agents in 134 MB (below).

### Worktree churn
- A new worktree at a known commit has its local facts immediately: its overlay is built from `git ls-tree` blob ids (A19), which are already indexed. Only its dirty files are parsed. Resolved edges come from the cache when another overlay has the same snapshot and resolution context, otherwise they are computed lazily on first query.
- Overlays are dropped when a worktree is pruned or its directory disappears (Reconcile, A21); facts only it used are retired (A20).
- Compiler programs are per file set, so precise resolution runs for a bounded number of active overlays (A25); the rest use grammar facts plus their base commit's precise edges, marked as such.

### Failure and restart
- A host crash loses no data (A17). The supervisor restarts it; clients reconnect; if the supervisor is gone, the next client re‑elects a host via the lock.
- A stuck tenant (writer or compiler hang) is unloaded by its watchdog without affecting other repos (A22).
- `status` and the SessionStart brief say when atlas is down or degraded, so agents aren't silently working without it.
- Upgrades within a major version: the new host takes the lock after the old one drains in‑flight requests. A new major version runs as a separate host (A46).
- An agent that disappears mid‑request leaves nothing to clean up (stateless, A23).

### Measured load (2026‑10‑15)
Prototype daemon (feasibility evidence, not the MCP SDK; A50 re‑measures with it): Unix socket, JSON‑lines requests, 2 read threads, one writer thread re‑indexing 20 files every 50 ms throughout. Store: 10,000 files, 1.5M references. Each agent connects, runs 50 reference queries in sequence, then disconnects. The load generator shared the container's 2 cores with the daemon, so latencies are pessimistic.

| Concurrent agents | Queries | Errors | Throughput | p50 | p99 | Daemon memory |
|-------------------|---------|--------|------------|-----|-----|---------------|
| 10 | 500 | 0 | 4,627/s | 1.3 ms | 8.5 ms | 98 MB |
| 100 | 5,000 | 0 | 8,730/s | 8.5 ms | 40 ms | 107 MB |
| 500 | 25,000 | 0 | 34,240/s | 11.3 ms | 34 ms | 119 MB |
| 1,000 | 50,000 | 0 | 30,865/s | 25.8 ms | 97 ms | 134 MB |

Memory grows about 0.04 MB per open connection; writes continued throughout. Past CPU saturation, latency rises by queueing; A28 turns that into `busy` responses rather than unbounded waits.

### Scale budgets (release gates)
| Metric | Budget |
|--------|--------|
| Errors at 1,000 concurrent short‑lived agents | 0 (excluding deliberate `busy`) |
| Read p99 at 1,000 concurrent agents, laptop | ≤ 100 ms |
| Daemon memory per extra open connection | ≤ 0.1 MB |
| Extra processes per agent, HTTP MCP + HTTP hooks | 0 (stdio‑only clients: one thin shim) |
| Connect to first answer | ≤ 50 ms |
| New worktree at an indexed commit, live | ≤ 1 s, independent of repo size |
| 500 worktrees × 10 dirty files: grammar facts fresh | ≤ 1 s per saved file |
| Compiler pool memory | ≤ configured budget at any agent or worktree count |
| `fresh` request for one changed file | answered with that file's new facts ≤ 2 s |

### Test levels
- **CI:** 100 and 1,000 concurrent short‑lived agents, plus 500 worktrees, on every release candidate.
- **Nightly soak:** 1 hour of continuous connect/query/disconnect churn at 5,000 total connections with edits running; memory must return to baseline after the churn stops.
- Release notes state the levels tested. Higher levels are expected to work, bounded by hardware.

---

## Multi‑repo workstation

A developer may have several repos open at once, each with its own sessions and swarms. gsd‑atlas must grow with the work, not multiply with it.

### Approaches compared
| Approach | Disk | Memory | Isolation | Verdict |
|----------|------|--------|-----------|---------|
| **A. Process and store per repo** (the earlier A22) | Shared SDK and package facts copied into every repo | One full runtime per repo; compiler budgets add up (10 × 25 % of RAM) | Strong | Rejected: memory scales with repo count; shared facts duplicate |
| **B. One store for everything** | Best deduplication | One runtime | Weak: one corruption or lock affects every repo; deleting a repo means surgery; one writer for all repos | Rejected |
| **C. One host, per‑repo stores, shared SDK/package stores** | Each repo's own code once; shared facts once per machine | One runtime, one budget | Per‑repo store, writer, lock, policy | **Chosen** (A22, A39–A43) |

### Measured (2026‑10‑15)
Same container as the other benchmarks. Each runtime: two read threads and one writer thread over 30,000‑symbol stores, all repos queried continuously.

| Repos | Process per repo | One host | Saving |
|-------|-----------------|----------|--------|
| 3 | 254 MB (3 processes) | 86 MB | 66 % |
| 10 | 848 MB (10 processes) | 89 MB | 90 % |

Per‑repo processes grow by about 85 MB per repo before any compiler loads; the host grows by under 1 MB per extra store. SQLite also refused an 11th `ATTACH` (`too many attached databases - max 10`), which is why cross‑repo queries fan out instead (A42).

### Layout
```
~/.cache/gsd-atlas/
  host-<major>/host.lock          # host election, one host per major version (A46)
  host-<major>/host.sock          # Unix socket (named pipe on Windows); token file (0600)
  shared/sdk.db                   # SDK facts by SDK id incl. build + variant (A10, A39)
  shared/pkg.db                   # public package facts by integrity hash (A39)
<repo>/.git/gsd-atlas/            # per-repo code facts (A4), one tenant each
~/.config/gsd-atlas/                  # user-level config only: workspaces, command permissions, policy (A44)
```

### How sessions and agents find their repo
- Every MCP request and hook carries the agent's working directory or MCP roots; the host maps it to a repo tenant (A43) and a worktree overlay (A5).
- A session in one repo and a swarm in another share the host but never each other's facts, queues or ledgers.
- `platform_card` is per repo: two iOS apps each see their own deployment targets against the same shared iOS SDK facts.

### Size guarantees
Disk total = Σ each repo's unique code facts + each SDK and package version used, once + the per‑repo grace tail of retired versions (A20).

- Repo count multiplies nothing shared.
- Sessions and agents add no disk (ledgers live in memory, A37).
- Worktrees add only their dirty files (A5).
- `gsd-atlas status --all` reports per‑repo and shared sizes against the per‑repo (A18) and workstation (A41) budgets.

### Multi‑repo budgets (release gates)
| Metric | Budget |
|--------|--------|
| Host memory with 10 active repos, before compilers | ≤ 200 MB |
| Extra host memory per idle (unloaded) repo | ≈ 0 |
| Shared SDK or package version stored | once per machine |
| Disk for 10 repos vs the sum of 10 single‑repo installs | ≤ the sum minus duplicated shared facts |
| Read p99 in repo A while repo B runs a 500‑agent swarm | ≤ 2× its idle p99 |
| Cross‑repo query across a 20‑repo workspace | answered, no attach limit |

### Escape hatch
The storage layer sits behind a driver interface (A3). If a budget can't be met on a real corpus, swap the engine behind it without changing modules, MCP tools or the CLI.

---

## Borrowed from gsd‑graph

Copied (not depended on), with attribution in file headers:

| gsd‑graph source | Use in gsd‑atlas |
|------------------|------------------|
| `src/types.ts` (provenance, confidence tiers) | Fact and provenance shapes (A2, A8) |
| `src/pipeline/ids.ts` | Stable ids for facts |
| `src/io/paths.ts` | realpath + prefix confinement |
| `src/io/lock.ts` | Build lock for writers |
| `src/sources/redact.ts` | Secret redaction in labels and doc text |
| `src/sources/fingerprint.ts` | Content hashing |
| `src/errors.ts` | Reason codes and exit codes (A12) |
| `src/mcp/server.ts`, `src/cli/mcp-install.ts` | MCP server scaffold and installer |
| `src/pipeline/extractors.ts` (EXT‑01) | Registry pattern for modules (collision rules) |
| `skills/gsd-graph/SKILL.md` | Skill structure |

---

## Validation corpora

| Corpus | Purpose |
|--------|---------|
All open‑gsd repos, so every benchmark and eval is reproducible in public CI. Profiled 2026‑10‑15 from shallow clones.

| Corpus | Shape | What it tests |
|--------|-------|---------------|
| **gsd‑core** | 284 `.cts` → gitignored `.cjs` (ADR‑457); 1,359 hand‑written `.cjs`; 167K lines in `src/`; ~100 ADRs; Node ≥ 24, TypeScript 6.0.3 | TypeScript precise tier, emit mapping, ADR citations |
| **gsd‑pi** | pnpm monorepo, 12 packages, 14 tsconfigs; ~3,900 `.ts`, 96 `.tsx`, 129 `.mjs`; a 2,381‑file TypeScript extension tree under `src/resources`; Rust (`native`, 32 files), Python integrations (40), 3 Swift files; 19 committed `.db` files; Node ≥ 22.18 | Monorepos and multiple tsconfigs, scale (5,787 files), mixed languages in one repo, skipping binaries |
| **gsd‑path** | Python daemon plus skills: 553 `.py` files but only 230 distinct contents (skills carry copies of the same scripts); TS/TSX (66), Swift (9); ADRs in `docs/adr` | Python bring‑your‑own module, content‑hash dedupe (58 % of Python files are duplicates), mixed languages |
| **gsd‑graph** | TypeScript, Node ≥ 22; markdown corpus | Bridge export and import round trip |
| **An iOS/macOS app repo** | Swift app with SwiftPM/Xcode targets | Swift grammar tier, project model, SDK facts |
| **gsd‑atlas itself** | TypeScript | Dogfood from M1 |

**Multi‑repo set:** gsd‑core, gsd‑pi, gsd‑path, gsd‑graph and gsd‑atlas active together, each with its own sessions and a swarm in one of them, is the reference workload for the *Multi‑repo workstation* budgets.
