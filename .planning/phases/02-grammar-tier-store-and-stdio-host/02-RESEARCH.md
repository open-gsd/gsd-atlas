# Phase 2: Grammar Tier, Store and stdio Host - Research

**Researched:** 2026-10-16
**Domain:** Local code-fact index in TypeScript on Node >= 24.16 (SQLite store, tree-sitter WASM extraction, file watching, stateless stdio MCP, CLI parity)
**Confidence:** MEDIUM-HIGH. Everything that could be run on this macOS arm64 machine was run (parse, queries, watcher, lease, MCP stdio, FTS5, store sizing). Linux and Windows behaviour is unverified and is called out as `[ASSUMED]`; three-OS CI is the only check.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Host shape**
- **D-01:** Phase 2 builds an **in-process Host per process**. `gsd-atlas-mcp` and each CLI call compose the Host (Tenant per repo: Source Tree, Fact Store, Indexer, Query) in-process. The Indexer and watcher live only while the process lives. A second session on the same repo is a **follower** via the writer lease (STO-08). No Unix socket, named pipe, token, Host/Origin checks, lock election or supervisor in this phase. Phase 4 swaps the HostClient implementation to a socket client without changing adapters. — **Reversibility:** costly — adapters, Tenant composition and lease behaviour are built against this shape; Phase 4 must preserve the HostClient contract.
- **D-02:** On start, the Indexer runs a **Reconcile catch-up** (git status + hash check; `@parcel/watcher` `getEventsSince` where a snapshot exists) so a restarted stdio server answers fresh. If it exceeds a short deadline the answer is returned with `degraded: ['reconciling']`. This satisfies HST-01 (restart between two tool calls).
- **D-03:** **Follower `fresh` paths:** a follower never writes. It parses the `fresh` path(s) into an **in-memory overlay for that request only**, merges over store facts, and reports `degraded: ['follower']`. No cross-process messaging in Phase 2.

**Grammars and extraction**
- **D-04:** Ship **two built-in modules**: `typescript` (`.ts .cts .mts .tsx`, tree-sitter-typescript 0.23.2) and `javascript` (`.js .cjs .mjs .jsx`, tree-sitter-javascript 0.25.0), each with its own `grammar.lock`, committed WASM and `parseBudget`. gsd-core is mixed `.cts`/`.cjs`. Python and Swift stay in later phases; the Phase 1 toy grammar remains the second-language Grammar Engine fixture (LNG-08).
- **D-05:** The 90% per-construct recall gate (LNG-02) covers: function, class, interface, type alias, enum, const/var, method and property definitions; containment; ES `import`/`export`; CJS `require`/`module.exports`. Ground truth is **hand-curated fixture truth** plus a pinned sample of gsd-core files at the corpus SHA; for the sample the TypeScript compiler is a **dev-only oracle script**. Recall is reported per construct, never pooled.
- **D-06:** **References** are identifier uses whose name matches a definition, **scoped by import edges and same-file scope**. Always `INFERRED`. Ambiguity is returned as multiple candidates, never guessed. Definitions and imports are `EXTRACTED` (LNG-03).

**Query surface**
- **D-07:** Default MCP profile is exactly six tools: `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status`, `lang_list`. Nothing else is registered by default (QRY-06).
- **D-08:** **Ranking** is a deterministic tiered score: exact name > case-insensitive > prefix > substring/trigram; then definitions over references, EXTRACTED over INFERRED, exported over local, same-directory or shorter path relative to a request `cwd` hint; ties broken by path then line. Output is stable and identical across CLI and MCP. No usage-count boost.
- **D-09:** **Pagination:** `more` is an opaque keyset cursor (last sort key, query hash, store watermark). If the store changed between pages, continue and report `degraded: ['watermark_moved']`. `budget_tokens` (default 2,000) is estimated as chars/4 over the serialized result; items are cut whole, never mid-citation; a separate server-side hard output ceiling applies regardless of the requested budget.
- **D-10:** **Line text:** each citation carries `file:line:col` span plus a `text_ref`. Matched line text lives only in `untrusted_text` entries fenced with a **random per-response nonce**, control characters / bidi / ANSI normalized, truncated at a fixed width (QRY-05). Agents read structure from citations and text from the fenced field.

**Index lifecycle and freshness**
- **D-11:** **First run:** explicit `gsd-atlas build`. Queries on an unindexed repo return a clear `not_indexed` error naming the exact command. No auto-build. `gsd-atlas init` may offer to run build.
- **D-12:** **Debounce:** per-(worktree, path) latest-hash queue with a **100 ms trailing debounce and 500 ms max-wait**, tunable in config, leaving headroom for parse and write under the 1 s freshness budget (IDX-01/02).
- **D-13:** **Reconcile triggers:** on start, on any watcher error or overflow, on HEAD change (branch switch), and periodically while idle (about every 10 minutes). Start and overflow run at indexing priority; the periodic pass runs at maintenance priority (IDX-03).

**Store layout and recovery**
- **D-14:** **Crash detection:** the writer sets a `dirty` marker before a batch and clears it on commit; open checks the marker and runs `PRAGMA quick_check`. On failure, quarantine the file, rebuild automatically from the working tree, and report `degraded: ['rebuilding']`. WAL + `synchronous=NORMAL` otherwise (STO-06).
- **D-15:** **Schema changes:** the fact store is derived data, so **rebuild on schema-version bump** (older code + newer store = refuse with a clear message; newer code + older store = drop and rebuild). **Real forward-only numbered migrations only for the Metrics database.** — **Reversibility:** costly — adding fact migrations later means retrofitting version history that was never kept.
- **D-16:** **GC:** a retired file version is collected once its blob id exists in git, or after a **24 h grace period** (configurable). `maintain compact` runs incremental vacuum / VACUUM at idle. Must pass the 1.25x-after-20,000-edits gate (STO-05).

**Metrics**
- **D-17:** Metrics records **counters and histograms only**, 30-day rolling: per tool calls, latency buckets, result count, estimated tokens returned, degraded reasons, freshness lag, index health. Daily rollups after 7 days; hashed ids at most; no source text, paths, symbols or prompts. `gsd-atlas status` panels: Answers, Freshness, Index health, Tokens served, honestly labelled as estimates. A metrics write failure is swallowed and counted, never blocking an answer (MET-01/02).

**ADR ratification**
- **D-18:** **The first plan (Wave 1) ratifies all four ADRs** (worktree-lifecycle, query-and-policy, mcp-contract, value-dashboard): open issues, rename to `<issue#>-<slug>.md`, apply the D-16 (Phase 1) dated amendments (writer contention and leader/follower in worktree-lifecycle; metrics migrations in value-dashboard), set Accepted, update the README table. Later plans code against Accepted text; code-driven changes are dated amendments.
- **D-19:** Decisions D-01..D-17 above that differ from or add detail to the drafts (in-process Host, rebuild-on-bump, nonce-fenced `untrusted_text`, six-tool profile) are recorded as **dated amendments** to query-and-policy and mcp-contract where they conflict. `draft-host-process-model.md` stays Proposed for Phase 4. The planner diffs and amends only where needed.

### Claude's Discretion
- Internal table layout and index design inside the Fact Store, provided D-14..D-16 and STO-02..STO-04 hold.
- Exact deadline for the start-up Reconcile before `degraded: ['reconciling']`, exact fixture contents, naming inside each module, CI workflow organisation.

### Deferred Ideas (OUT OF SCOPE)
- Socket/named-pipe Host, token auth, supervisor, lock election, shared `sdk.db`/`pkg.db`: Phase 4.
- Usage-count ranking boost and compiler-resolved edges: Phase 3.
- Auto-build on first query, `atlas_maintain` MCP tool, Python built-in module: not scheduled; revisit if Phase 3 eval shows need.
- Cross-process leader messaging for follower `fresh`: Phase 4.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-12 | Amend worktree-lifecycle (writer contention, leader/follower) and value-dashboard (metrics migrations) as ratified | "ADR ratification mechanics" and "Existing artifacts that must change" (adr scripts and tests hard-code Phase 1 slugs); Patterns 3 and 9 give the amendment text content |
| STO-01 | node:sqlite primary, better-sqlite3 fallback, one conformance suite | Pattern 1 (schema), Pitfall 3 (kit allowlist), Validation: contract.ts run over both drivers |
| STO-02 | Facts keyed by git blob id with clean filters; CRLF and BOM spans | Source Tree `hashPaths` (Pattern 5); engine already strips BOM and keeps CRLF; fixtures with `.gitattributes` |
| STO-03 | Overlay per worktree; shared local facts; branch switch re-parses only changed | Pattern 1 (overlay table, integer file ids), Pattern 6 (snapshot diff) |
| STO-04 | Resolved edges keyed by snapshot + context | Pattern 2 (read-time join plus resolved_edges table exercised with a scripted Resolver) |
| STO-05 | Retired versions collected; <= 1.25x after 20,000 edits | Pattern 4; measured sizing; Pitfall on CI time of the 20k-edit gate |
| STO-06 | SIGKILL / corruption detected and rebuilt | Pattern 4; Pitfall 5 (SIGKILL alone does not corrupt WAL: test both kill and injected corruption) |
| STO-07 | Store in git common dir, cache fallback, `store.dir` override | Pattern 4; Security (symlink and repo-supplied override) |
| STO-08 | Writer lease; followers read with `degraded: ['follower']` | Pattern 3 (verified SQLite EXCLUSIVE-lock lease; survives SIGKILL) |
| STO-09 | `history --at <commit>` from git without writing | Pattern 7 (`ls-tree` + one `cat-file --batch`, throwaway store); CommandRunner allowlist amendment |
| STO-10 | Maintenance tasks idle and as `maintain` commands | Pattern 4; Governor `maintenance` class |
| LNG-02 | Per-construct recall >= 90% | Pattern 5 capture vocabulary; verified query counts against the TypeScript compiler oracle; recall harness design |
| LNG-03 | Refs INFERRED, defs/imports EXTRACTED | Pattern 2; Pattern 5 |
| LNG-04 | Every fact carries provenance fields | `Provenance` in fact-store types (verified); FileFacts extension (Pattern 5) |
| LNG-05 | Source set: tracked + untracked non-ignored, linguist attrs, binaries, LFS | Source Tree additions (Pattern 6); `check-attr` already allowlisted |
| LNG-07 | Parser objects released; workers recycled | Verified plateau at ~227 MB RSS over 4 rounds; worker pool (Pattern 8); engine changes |
| LNG-08 | Second non-TS fixture language through the engine | Toy module through the new extractor; Pitfall on TS-shaped core |
| IDX-01 | Save to updated facts < 1 s | Pattern 6 timing budget; verified watcher latency (~16 ms mac), snapshot cost |
| IDX-02 | Coalesce to one job per (worktree, path) | D-12; Pattern 6 |
| IDX-03 | Reconcile repairs missed events and overflow | Pattern 6; `getEventsSince` is not reliable on macOS (verified lag) so Reconcile is authoritative |
| IDX-04 | `fresh` paths indexed first | Pattern 6 (`ensureFresh`), D-03 follower overlay |
| QRY-01 | Full envelope on every response | Pattern 9 (additive Envelope fields in `facts/`) |
| QRY-02 | Four code tools: ranked, cited, budget, cursor, ceiling | Pattern 9; `code_impact` semantics with INFERRED-only edges |
| QRY-03 | `atlas_status`, `lang_list` | Pattern 9; policy mode is static `off` until Phase 7 |
| QRY-04 | CLI and MCP identical JSON; exit codes 0/1/2/3 | Shared tool definitions via host-client; exit 3 = lease held (gsd-graph K22 precedent) |
| QRY-05 | Nonce fencing and normalization | Pattern 9; verified Unicode regex |
| QRY-06 | Default profile ~6 tools | D-07; verified `registerTool` + `serveStdio` |
| HST-01 | Stateless stdio MCP survives restart | Verified server over stdio; Pitfall 8 (stdout hygiene, lazy tenant) |
| HST-02 | Tenant per repo; two-tenant smoke test | Pattern 10 |
| HST-03 | Governor priority classes, `busy` + `retry_after` | Pattern 11 (real Governor against the existing contract suite) |
| HST-04 | `gsd-atlas init` registers MCP at user scope | Pattern 12 (user-scope only; gsd-graph precedent and its flaws) |
| MET-01 | Metrics module with own DB and real migrations | Pattern 13 |
| MET-02 | `status` panels; write failure never blocks | Pattern 13 |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Source: `/Users/trekkie/projects/gsd-atlas/.claude/CLAUDE.md` (treated as locked) and `~/.claude/CLAUDE.md` (CodeGraph first, GSD workflow enforcement).

- TypeScript, Node, SQLite via `node:sqlite` with `better-sqlite3` kept working; single npm package `@opengsd/gsd-atlas`, bins `gsd-atlas` and `gsd-atlas-mcp`; language modules under `modules/`.
- macOS, Linux, Windows in every budget's CI run from M1. No network by default, no telemetry; permissions only from user-level config (`~/.config/gsd-atlas/`); repo text fenced as untrusted.
- No dependency on gsd-core, gsd-graph or `.planning/`. Pin each eval corpus to a commit SHA.
- Stack rules: MCP SDK v2 only (no sessions, no Roots); `web-tree-sitter` 0.27.1 exact with `.delete()` on everything that holds WASM memory; no prebuilt third-party WASM; no `piscina`; no bundler; no `console.log` in the protocol path; `child_process` only in the CommandRunner; no `.cmd`/`.bat` spawns.
- Native type stripping: `.ts` import extensions, `import type`, no `enum`/`namespace`/parameter properties/decorators.
- Before any file edit, work must start through a GSD command (executor concern, not planner).
- Use CodeGraph (`codegraph node`, `codegraph explore`) before grep/Read for indexed source. A PreToolUse guard enforces this for indexed files.

**Contradictions between CLAUDE.md and Phase 2 that the planner must resolve (flagged, not silently chosen):**

| CLAUDE.md statement | Phase 2 reality | Resolution recommended |
|---|---|---|
| "`engines: >=24.15.0`", CI floor 24.15 (Technology Stack table) | `package.json` engines is `>=24.16.0`; sqlite-store ADR amendment sets 24.16.0 because 24.15.0 truncates TEXT at NUL | 24.16.0 wins (already shipped in Phase 1). Edit CLAUDE.md Stack text in a docs task |
| "The shim must not load SQLite, grammars or the compiler (A27)" | D-01 composes the whole Host in the `gsd-atlas-mcp` process | Acceptable for Phase 2 only. Build the Tenant lazily on the first tool call so `initialize` and `tools/list` answer immediately; Phase 4 removes the heavy load |
| mcp-contract ADR decision 8: worktree identity "from MCP roots" | Roots are deprecated in spec 2026-07-28 (CLAUDE.md Finding 1) | Dated amendment: explicit `repo`/`cwd` tool argument, then `worktree`, then process cwd |
| STACK.md lists `@modelcontextprotocol/node` | Not needed for stdio; it pulls `hono` | Install only `@modelcontextprotocol/server` in Phase 2 |

## Summary

Phase 2 is the heaviest phase (33 requirements) but every seam it needs already exists behind a frozen interface from Phase 1. The new work is: (a) real Fact Store tables, lease and lifecycle behind the existing `FactStore` types; (b) two built-in grammar modules plus a capture-to-`FileFacts` extractor; (c) a new Indexer, Query, Tenant/Host, Metrics and a real Governor; (d) CLI and MCP adapters over one `HostClient`. Nothing here needs a new architectural idea; the risk is in the number of small mismatches between the frozen Phase 1 types and what D-05..D-10 require.

The research found eleven such mismatches that change plans (listed in "Existing artifacts that must change"). The most consequential: **`FileFacts` is too thin** (no `exported`, no reference kind, no enclosing symbol, no import bindings), so D-06 scoping and D-08 ranking cannot be built without an additive kernel change; **`scripts/adr-ratify.ts` and its tests are hard-wired to the eight Phase 1 slugs and to "exactly 6 drafts"**, so ratifying four more ADRs breaks tests unless they change in the same plan; **the committed CommandRunner allowlist has no `ls-tree` or `worktree`**, which `history --at` and worktree discovery need (an ADR 4 amendment); and **the `typescript` grammar cannot be built by the Phase 1 pipeline** because the pipeline always runs `tree-sitter generate`, which needs `tree-sitter-javascript` on disk (verified failure), while the npm tarball ships a prebuilt ABI 14 `parser.c` that builds fine.

Measured on this Mac (Node 26.11.1, not CI): parse of all 1,618 gsd-core `.cts`/`.cjs` files takes 2.6 s on one thread, 1.4 s on two workers, 0.8 s on four; queries add ~0.8 s; a naive per-fact schema keyed by the 40-character blob id produces a 72 MB store for gsd-core-scale rows, while keying by an integer file id produces 23 MB and halves build time. Those two numbers decide the schema.

**Primary recommendation:** Build bottom-up in dependency waves (kernel and ADRs, then Source Tree / Fact Store / Grammar extraction / Governor in parallel, then Indexer, then Query and Metrics, then Tenant/Host/CLI/MCP, then gates), key every per-fact row by an integer file id, resolve grammar-tier references with a read-time join (no cache write), take the writer lease with a dedicated SQLite `BEGIN EXCLUSIVE` lock file, and gate on measured numbers (recall per construct, store size, build time, 20,000-edit ratio) on all three OSes.

## Architectural Responsibility Map

This is a CLI/library with no browser tier. Tiers are the project's own modules.

| Capability | Primary Owner | Secondary | Rationale |
|------------|---------------|-----------|-----------|
| Git-derived data (hashes, source set, worktrees, tree listing, blob reads) | Source Tree | CommandRunner | tenant-composition ADR decision 1; only git caller |
| Parse and capture-to-FileFacts | Grammar Engine (+ extractor) | Parser worker pool | FileFacts is the only value crossing to the store (ARCHITECTURE "Key data flows") |
| Fact persistence, overlays, lifecycle, lease, integrity | Fact Store | `sqlite/` kit | fact-store-interface ADR decision 1 |
| Event to stored facts, coalescing, Reconcile, `ensureFresh` | Indexer | Governor, Source Tree, Grammar Engine | ADR 9 decision 2; Indexer is the only writer client |
| Ranking, budget, cursor, citations, fencing, envelope | Query | Fact Store Reader, Indexer, Source Tree (line text) | query-and-policy ADR decisions 1-5 (needs amendment for line text) |
| Scheduling, priority, `busy` | Governor | | ADR 9 decision 4 |
| Counters, histograms, panels | Metrics (own `metrics.db`) | | value-dashboard ADR; non-derivable state |
| Tenant wiring, request routing | Host / Tenant | | ADR 9 decision 5 |
| Argument parsing, exit codes, stdout JSON | CLI adapter | HostClient | adapter rule (lint) |
| MCP framing, tool registration | MCP adapter | HostClient, shared tool definitions | adapter rule (lint) |
| Agent-host registration | `init` command | user config files only | trust-boundaries ADR; never repo config |

## Standard Stack

### Core (new in Phase 2)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/server` | 2.3.1 exact | MCP server over stdio (`McpServer`, `serveStdio`) | Official SDK v2; **verified** a server registered with `registerTool` + zod answered `initialize`, `tools/list`, `tools/call` over stdio in 117 ms and exited on stdin EOF |
| `@parcel/watcher` | 2.6.0 exact | File and git-dir watching | **Verified** on macOS: ~16 ms event latency, `ignore` globs, installs and runs with `--ignore-scripts` (prebuilt optional package `@parcel/watcher-darwin-arm64`) |
| `web-tree-sitter` | 0.27.1 exact (already installed) | WASM parser | Verified in workers; `Query.matches()` groups captures; predicates `#eq?`, `#any-of?` work |
| `zod` | 4.6.7 (already installed) | Tool input schemas, request args, config | Single validation library; the MCP SDK takes zod schemas directly |
| `typescript` | 6.0.3 (already a devDependency) | Dev-only recall oracle script | `ts.createSourceFile` oracle matched query counts (see Pattern 5) |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `better-sqlite3` | 13.0.3 (already optional peer) | Fallback driver, conformance only | The Fact Store contract suite must run on both drivers |
| `node:sqlite`, `node:worker_threads`, `node:crypto`, `node:util` `parseArgs`, `node:fs` | built in | Driver, parser pool, nonce, CLI | Nonce: `crypto.randomBytes(16)` |
| tree-sitter grammar sources (not installed) | `tree-sitter-typescript-0.23.2.tgz` sha256 `0fdf63c35930a75885145d75ee63cb879da2d49db9bfe454bd8e60b08ba778a1`; `tree-sitter-javascript-0.25.0.tgz` sha256 `6214ce23d03aba525ba8edd6ca7caf365c969f2c2dbfc353e376ca54507ffb92` | Archive inputs for `grammar.lock` (`source.type: "upstream"`) | Fetched only by the grammar CI job; both MIT [VERIFIED: npm registry] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@parcel/watcher` | chokidar 5 | No `getEventsSince`; slower; STACK.md already chose parcel |
| `@modelcontextprotocol/node` + HTTP | n/a | Phase 4 only |
| SQLite exclusive-lock lease | pid file with heartbeat | Pid files need stale detection and timers; the SQLite lock is released by the OS on SIGKILL (verified) |
| Per-fact rows keyed by blob-id text | integer `file_id` | Verified 3.2x larger and 2.2x slower with text keys |

**Installation:**
```bash
npm install --save-exact @modelcontextprotocol/server@2.3.1 @parcel/watcher@2.6.0
```
Do not install `@modelcontextprotocol/node`, `hono`, `semver` or `chokidar` in this phase.

**Version verification (run this session):**
```bash
npm view @parcel/watcher version                 # 2.6.0  (license MIT, scripts.install = node scripts/build-from-source.js)
npm view @modelcontextprotocol/server version    # 2.3.1  (Apache-2.0, engines node >=20; 2.3.1 published 2026-10-05)
npm view tree-sitter-typescript version          # 0.23.2 (MIT, last published 2024-11-11)
npm view tree-sitter-javascript version          # 0.25.0 (MIT)
```

## Package Legitimacy Audit

Run with `gsd-tools query package-legitimacy check --ecosystem npm ...` this session.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| @parcel/watcher | npm | years (2.6.0 published 2026-07-20) | 41M/wk | github.com/parcel-bundler/watcher | OK | Approved. Has an `install` script that only compiles when no prebuilt optional package matches; harmless under `--ignore-scripts` where a prebuild exists (verified on darwin-arm64) |
| @modelcontextprotocol/server | npm | 2.0.0 on 2026-07-27; 2.3.1 on 2026-10-05 | 11.7M/wk | github.com/modelcontextprotocol/typescript-sdk | SUS (`too-new`) | Flagged. Official org and 11.7M weekly downloads, pinned by STACK.md. **Planner must add a `checkpoint:human-verify` task before the install** |
| @modelcontextprotocol/core | npm | transitive of the above | 15M/wk | same repo | SUS (`too-new`) | Transitive; covered by the same checkpoint |
| tree-sitter-typescript | npm | 0.23.2 published 2024-11-11 | 849K/wk | github.com/tree-sitter/tree-sitter-typescript | OK | Approved as a pinned source archive only (not installed; `install` script `node-gyp-build` never runs) |
| tree-sitter-javascript | npm | 0.25.0 | 1.08M/wk | github.com/tree-sitter/tree-sitter-javascript | OK | Approved as a pinned source archive only |
| semver | npm | years | 873M/wk | github.com/npm/node-semver | OK | Not needed in Phase 2 (SDK ids are Phase 6) |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** `@modelcontextprotocol/server` (and transitive `@modelcontextprotocol/core`): planner inserts `checkpoint:human-verify` before install.

## Architecture Patterns

### System Architecture Diagram

```
 agent / developer
   |                          |
   | MCP tools/call (stdio)   | gsd-atlas <cmd> (argv)
   v                          v
 src/mcp-shim  ----+----  src/cli                 (adapters: translate only, import host-client only)
                   |                              shared TOOLS definitions (zod) re-exported by host-client
                   v
            HostClient.handle(Request{protocol,kind,args,worktree,tenantHint,budget_tokens,fresh})
                   |
                   v
   src/host (composition root, in-process, lazy)  -- tenant registry keyed by SourceTree.identity().storeId
        |  shared deps: GrammarEngine(+parser worker pool), CommandRunner, Governor, Clock
        v
   Tenant(repo)  =  SourceTree + FactStore + Indexer + Query + Metrics
        |
        |  Query.ask --(fresh?)--> Indexer.ensureFresh(worktree, paths, waitMs)   [Governor class fresh]
        |        |                      |
        |        |                      +-- queue[(worktree,path)] = latest hash (100 ms trailing / 500 ms max-wait)
        |        |                      |      ^ events: EventSource port = @parcel/watcher (worktree dirs + git dirs) | ManualEventSource (tests)
        |        |                      |      ^ Reconcile: SourceTree.snapshot() vs store overlay (start, overflow/error, HEAD change, ~10 min idle)
        |        |                      v
        |        |                SourceTree.hashPaths -> read bytes -> source-set filters (binary, LFS, size cap)
        |        |                      -> parser worker (GrammarEngine.run) -> extractor -> FileFacts
        |        |                      -> Writer.commitFile (one txn/file)   [only if this process holds the lease]
        |        v
        |   Reader = store.at(worktree)  find / symbol / fileFacts / refs / callers  -> Answer<T>{data, watermark, degraded?}
        |        |   (grammar-tier refs = read-time SQL join over overlay; no cache write)
        |        v
        |   rank -> budget/cursor -> citations + debug handles -> line text via SourceTree.readText
        |        -> normalize + nonce-fence -> Envelope  ->  Metrics.record (best effort, never throws)
        v
   Envelope JSON  (CLI prints it on stdout; MCP returns it as the tool result text) -- identical bytes

 Lease: <storeDir>/lease.db  BEGIN EXCLUSIVE held for process lifetime (OS releases on SIGKILL)
        holder = leader (watcher + Indexer + Writer, all worktrees of the repo); others = followers (read-only,
        degraded:['follower'], fresh paths parsed into a per-request in-memory overlay, D-03)
```

### Recommended Project Structure

```
src/
  facts/            # additive: FileFacts v2 fields, new DegradedCode members, Envelope fields (zod NOT allowed here: closed leaf)
  sqlite/           # additive: PRAGMA allowlist (incremental_vacuum, wal_checkpoint, journal_size_limit)
  command-runner/   # additive: allowlist `ls-tree`, `worktree list --porcelain -z` (ADR 4 amendment)
  source-tree/      # additive: hashPaths, sourceSet, worktrees, listTree, readMany, readText
  fact-store/       # NEW impl: schema.ts, open.ts, lease.ts, writer.ts, reader.ts, lifecycle.ts, location.ts, contract.ts (test)
  grammar-engine/   # additive: matches grouping, capture-text cap, extract.ts (captures -> FileFacts), pool/ (worker host)
  governor/         # NEW impl: createGovernor (priority classes, busy), existing contract.ts must pass
  indexer/          # NEW: queue.ts, event-source.ts (port), parcel-source.ts, manual-source.ts, reconcile.ts, ensure-fresh.ts, build.ts
  query/            # NEW: tools.ts (zod defs), ranking.ts, budget.ts, cursor.ts, fence.ts, envelope.ts, kinds/{find,refs,context,impact,status,lang-list}.ts
  metrics/          # NEW: record.ts, migrations/, rollups.ts, report.ts, adapters {sqlite,noop}
  tenant/           # NEW: createTenant(deps)
  host/             # NEW: createHost, tenant registry, request routing, lang_* handlers moved out of host-client
  host-client/      # in-process.ts becomes a thin wrapper over host; re-exports TOOLS
  cli/              # commands: build find refs context impact status maintain history init lang
  mcp-shim/         # real server
  bin/              # composition roots (lazy imports)
modules/
  typescript/       # atlas-lang.json, grammar.wasm, grammar.lock, queries/{tags,refs,imports}.scm, fixtures/
  javascript/       # same
scripts/            # recall oracle (dev only), size/perf gates
```

`eslint.config.js` `MODULES` (lines 10-28, verbatim: `'facts','sqlite','command-runner','source-tree','fact-store','grammar-engine','precise-resolver','governor','lang','host-client','policy','cli','mcp-shim','test-kit','metrics','sdk','bin'`) has no `indexer`, `query`, `tenant` or `host`. **Add them in the first code plan**, or the new directories escape the boundary rules. `metrics` is already listed and already allowed to import `sqlite/` (`SQLITE_OWNERS`, line 31).

### Pattern 1: Fact Store schema keyed by integer file id (VERIFIED by benchmark)

**What:** One `files` row per distinct blob (`id INTEGER PRIMARY KEY`, `hash TEXT UNIQUE`); every fact row keys on `file_id`, never on the 40-hex blob id; names are interned in a `names` table; overlay rows map `(worktree, path) -> file_id`.
**Why:** Same 495,000 reference rows (1,650 files x 40 symbols x 300 refs, with a name index): text hash keys gave **71.9 MB, 3.8 s**; integer file id gave **22.7 MB, 1.8 s** (scratchpad `bench.mjs` vs `bench2.mjs`, Node 26.11.1 macOS arm64, WAL, `synchronous=NORMAL`, one transaction per file, no FTS, no overlay tables). The gsd-core budget is 50 MB and 3 s (DESIGN.md "Budgets").
**Tables (discretion area, recommended):** `meta(schema_version, dirty, created_by)`, `names(id, name UNIQUE)`, `files(id, hash UNIQUE, module, grammar_version, nsym, nref, error_bytes, total_bytes, state, retired_at, first_seen, last_seen)`, `symbols(file_id, ord, name_id, kind, span, parent, exported)` PK `(file_id, ord)` WITHOUT ROWID plus index on `name_id`, `refs(file_id, ord, name_id, kind, span, enclosing)` same shape, `imports`, `exports`, `overlays(worktree, ref, seq, snapshot_id)`, `overlay_files(worktree, path, file_id)`, `resolution_contexts`, `resolved_edges(snapshot_id, context_id, site..., target...)`, and `names_fts` (below). `source_path` in `Provenance` is derived from the overlay at read time, so identical content at two paths is stored once (gsd-path: 553 files, 230 contents).
**Create-time pragmas:** `auto_vacuum=INCREMENTAL` must be set **before the first table exists** (DESIGN.md A18/A21); the kit's `openDatabase` sets only WAL/NORMAL/foreign_keys, so set it on first creation through `db.pragma('auto_vacuum','INCREMENTAL')`.
**Fuzzy names:** contentless FTS5 over the interned `names` table: `CREATE VIRTUAL TABLE names_fts USING fts5(name, content='', contentless_delete=1, tokenize='trigram', detail=full)`. **Verified:** `detail=none|column` fails with "phrase queries are not supported", so `detail=full` is required for substring `MATCH '"onfig"'`; matching is case-insensitive; a 2-character query matches nothing, so `find` needs an exact/prefix path on a plain index for names under 3 characters (PITFALLS B3).

### Pattern 2: Grammar-tier resolution is a read-time join; the resolved layer is exercised with a scripted Resolver

**What:** `Reader.refs` for the grammar tier joins `refs` -> `overlay_files` -> `imports`/`exports`/`symbols` at query time and returns `tier: 'grammar'`, `confidence: INFERRED`; ambiguity returns every candidate (D-06). The `resolved_edges` table, the `(snapshot_id, context_id)` cache key and the injected `Resolver` exist in schema v1 and are exercised by the contract suite with a scripted resolver so STO-04 is proven now, even though no precise resolver ships until Phase 3.
**Why:** fact-store-interface ADR amendment 2026-10-15 says "Phase 2's grammar-tier name resolution is a read-time join over local facts and needs no cache write". Because the join runs over the *overlay*, a file whose `import './b'` points at `b1.cts` on one branch and `b2.cts` on another gives each branch its own target without any cache (PRD criterion 7).
**Specifier to path:** use a language-neutral rule (no tsconfig, no TS-shaped table in the core): resolve a relative specifier against the importing file's directory, strip any extension a loaded module claims, and match against extension-stripped overlay paths and `<dir>/index`. A specifier `./foo.cjs` can then match both `foo.cts` and `foo.cjs`; return both candidates (that is the D-06 behaviour, and Phase 3's ProjectModel replaces it). Do not add a field to the manifest (schemaVersion 1 is a `z.strictObject`, `src/lang/manifest.ts:43`); a new field would need a schemaVersion bump.
**Read-time scope filter at extraction (volume control):** record a reference site only if its name is (a) defined at module top level in the same file, (b) an import/require binding in the file, (c) an export name, or (d) the property of a member *call* (kept with kind `member`, low rank). Measured on gsd-core `.cjs` (1,338 files): 782,832 identifier nodes in total, **281,621** after the (a)+(b) filter, plus 214,012 member-call properties; 89% of all identifier volume is under `tests/` (697k of 783k). Without the filter, an unfiltered store would be roughly 4x larger than the benchmark above.

### Pattern 3: Writer lease = a dedicated SQLite `BEGIN EXCLUSIVE` lock (VERIFIED on macOS)

**What:** `<storeDir>/lease.db` (rollback journal, not WAL) opened with `timeout: 0`; the leader runs `BEGIN EXCLUSIVE` and never commits; followers attempt the same and get `ERR_SQLITE_ERROR`, `errcode 5`, `database is locked`. Diagnostics (pid, start time, version) go in a separate `lease.json` written by rename, because the lock blocks reads of `lease.db`.
**Verified (scratchpad `lease/`):** leader printed `held`; a second process got `BUSY ERR_SQLITE_ERROR 5 database is locked`; after `kill -9` on the leader the next attempt printed `ACQUIRED`. The OS releases the lock when the process dies, so no stale-lease logic is needed.
**Follower behaviour (D-03):** retry acquisition on a timer (10-30 s, jittered) for takeover; a follower never opens a writer; `fresh` paths are parsed into a per-request in-memory `Map` and merged over `Reader` results with `degraded: ['follower']`.
**Leader scope:** the leader's watcher and Indexer cover **every worktree of the repo** (`git worktree list --porcelain -z`), not only its cwd, because all worktrees share one store (ARCHITECTURE Q7).
**Windows, Linux:** `[ASSUMED]` equivalent (win32 VFS uses `LockFileEx`); a CI test that starts two real processes through the CommandRunner and SIGKILLs the leader is the proof.
**ADR content for FND-12 (worktree-lifecycle amendment):** the lease mechanism, leader owns all worktrees, follower semantics, takeover, `build`/`maintain` CLI exit code 3 when the lease is held.

### Pattern 4: Store lifecycle, recovery, location

- **Open sequence:** take an advisory lock for first-time init (PITFALLS B4: Windows `SQLITE_BUSY` on the WAL conversion is not retried by the busy handler); retry `journal_mode=WAL` with jittered backoff; then check `meta.schema_version` (older code + newer store: `SchemaTooNew`; older store: drop and rebuild, D-15); then `dirty` marker; then `PRAGMA quick_check`.
- **Dirty marker (D-14):** a sentinel file next to the DB, created before a batch and removed after commit, so it still works when the DB is unreadable.
- **Honest test design for STO-06:** SQLite WAL does not corrupt on process kill (ADR 8 evidence: "Writer killed with SIGKILL mid-write: `integrity_check` ok"). So the test must do both: (1) SIGKILL a child writer at random points (child started **through the CommandRunner** with `allowAll`, because the boundary lint bans `child_process` in `fact-store` tests; `stream().kill()` is SIGKILL) and assert all-or-none per file and a monotonic watermark; (2) inject real corruption (overwrite pages) and assert quarantine to `*.corrupt-<time>`, automatic rebuild and `degraded: ['rebuilding']`.
- **Collection (D-16):** a retired file row is collected when `SourceTree.hasObject(hash)` is true (`gitHas`) or past the grace period. Compaction: `incremental_vacuum(N)` in 200 ms slices, `PRAGMA optimize`, `wal_checkpoint(TRUNCATE)`, full `VACUUM` when free pages exceed 25%.
- **The kit blocks these pragmas today.** `src/sqlite/driver.ts:39-55` allowlist (verbatim): `'journal_mode','synchronous','foreign_keys','user_version','busy_timeout','wal_autocheckpoint','auto_vacuum','quick_check','integrity_check','page_size','mmap_size','cache_size','temp_store','secure_delete','optimize'`. `incremental_vacuum`, `wal_checkpoint` and `journal_size_limit` are absent; add them (both drivers, conformance test) rather than bypassing with raw `exec`.
- **Location (STO-07):** `git rev-parse --git-common-dir` + `/gsd-atlas/`; fall back to `${XDG_CACHE_HOME:-~/.cache}/gsd-atlas/<storeId>` for non-git, read-only, or synced-folder paths (ADR 8 decision 3). `storeId` comes from `SourceTree.identity()` (verified: `{ rootCommit, storeId: '8d9153397a368aae' }` for gsd-core). `store.dir` override is **user-level config or env only**, never repo config (see Security).
- **20,000-edit gate cost:** the ADR prototype took 11.8 ms per re-index on a 10,000-file store, so 20,000 edits is minutes. Run the PR gate on a synthetic store of a few hundred files with the same edit count and the same ratio assertion, and the 10,000-file version nightly or manual `[ASSUMED]`.

### Pattern 5: Extraction contract (capture vocabulary) and the `FileFacts` extension

**Verified feasibility.** Built `typescript.wasm` (1,415,400 bytes) and `javascript.wasm` (413,064 bytes) with the repo's `tree-sitter-cli` 0.27.1 from the npm tarballs; wrote a `tags` query; compared against the TypeScript compiler (`ts.createSourceFile`) on all 280 gsd-core `.cts` files:

| Construct | Query count | Compiler oracle | Note |
|-----------|-------------|-----------------|------|
| class | 49 | 49 | exact |
| interface | 1,022 | 1,022 | exact |
| type alias | 427 | 427 | exact |
| function (incl. `const f = () =>`) | 3,099 | 3,099 | exact |
| property (class field + interface member) | 7,387 | 7,387 | exact |
| method | 565 | 529 | query also counts `method_signature`; align definitions in the oracle |
| top-level const/let/var | 1,183 | 1,172 | `let` classification differs |

Query time for all 280 files: 160 ms. CJS query (`require` bindings, `module.exports =`, `exports.x =`) over 1,338 `.cjs`: 5,850 `const x = require()`, 5,819 destructured, 14 member, 247 `module.exports =` (the AST count is also 247), 16 named `exports.*`; 638 ms. **Predicates `#eq?` and `#any-of?` work and `Query.matches()` returns grouped captures.** Note the 24 AST `exports.x`/`module.exports.x` forms vs 16 matched: the `module.exports.x` branch needs its own pattern.

**What the frozen types cannot express (verified by reading them).** `src/facts/file-facts.ts:35-55`:
```
export interface LocalSymbol { readonly name: string; readonly kind: string; readonly qualifiedName?: string; readonly span: Span; readonly parent?: number; }
export interface RefSite { readonly name: string; readonly span: Span; readonly importPath?: string; }
export interface ImportSite { readonly path: string; readonly span: Span; }
```
D-06 needs import bindings (to scope names), D-08 needs `exported`, `code_impact` and `calls` need the enclosing symbol, ranking needs a reference kind. **Add, all optional so Phase 1 stays green:** `LocalSymbol.exported?: boolean`, `RefSite.kind?: 'call'|'new'|'read'|'type'|'heritage'|'member'`, `RefSite.enclosing?: number` (index into `symbols`), `ImportSite.style?: 'es'|'cjs'|'side-effect'|'reexport'`, `ImportSite.bindings?: readonly {imported: string; local: string}[]`, plus `exports?: readonly {name; local?; span; from?}[]`. Extend `validateFileFacts` for them.

**Engine changes (verified by reading `src/grammar-engine`).**
1. `collectCaptures` uses `query.captures(root)` (flat). Grouping a `@name` with its `@definition.*` by span nesting is brittle for nested definitions. Add a `matches` path (or a `match` index on `Capture`); additive, but the toy goldens in `test/fixtures/modules/toy/fixtures/*.golden.json` must be regenerated deliberately.
2. `toCapture` (`src/grammar-engine/normalize.ts:37`, verbatim `text: source.slice(node.startIndex, node.endIndex),`) copies the text of **every** capture, including a whole `@definition.function` node (function bodies, up to 1 MB files). Over a worker boundary that is a structured-clone of megabytes. Cap capture text (for example, only `@name`/`@import.path`-class captures carry text, others carry none or at most 256 characters).
3. `GRAMMAR_LIMITS.sourceBytes` is 2 MiB (`limits.ts`). Largest tracked gsd-core source is 1,005,064 bytes; none exceed the cap (measured), so oversize files are `source_too_large` diagnostics, not a recall risk.
4. Add `matchLimit` and a parse `progressCallback` (both exist in the 0.27.1 typings: `ParseOptions.progressCallback`, `QueryOptions.matchLimit`/`progressCallback`) so a pathological file cannot hang a worker. How a callback cancels is `[ASSUMED]` until tried.
5. The extractor (captures -> `FileFacts`) belongs in `src/grammar-engine/extract.ts` (ARCHITECTURE puts normalize and name-resolve there). It must be module-agnostic: the **capture-name vocabulary** is the contract (`@definition.<kind>` + `@name`, `@export`, `@import.path`/`@import.local`/`@import.bindings`, `@reference.<kind>`), documented once and exercised by the toy module (LNG-08) and both built-ins.

**Recall harness (D-05).** Fixture truth files in `modules/*/fixtures/` (the `lang test` goldens already compare spans) plus a script `scripts/recall.ts` that runs the extractor over a pinned sample and the TypeScript compiler oracle over the same files and prints a per-construct table. The sample must come from the **corpus SHA** (`corpora/corpora.json`: gsd-core `10ac3a7a947903ba50f538a907af036744d759d5`); the local `~/projects/gsd-core` is at `25e8e62` with staged deletions, so numbers above are indicative only. Fetch the pinned tree with `git archive`/shallow fetch into a temp dir; never touch the user's checkout.

### Pattern 6: Indexer, Source Tree and the freshness budget

**Source Tree additions.** `SourceTree` today exposes `snapshot(worktree)`, `hasObject`, `read(commit, path)`, `identity()` (`src/source-tree/types.ts:60-68`). Add: `hashPaths(worktree, paths)` (one `hash-object --stdin-paths` for a coalesced batch; `snapshot` hashes everything, ~250-470 ms for 3,948 gsd-core files, measured), `sourceSet` filtering with `git check-attr -z --stdin linguist-generated linguist-vendored` (subcommand already allowlisted), `worktrees()` (`git worktree list --porcelain -z`), `listTree(commit)` (`ls-tree -r -z`), `readMany(commit, paths)` (**one** `cat-file --batch` run; `CommandRunner` feeds stdin in full then closes, so duplex request/response is not available), and `readText(worktree, path)` (confined, size-capped, no symlink escape) for line text.
**Allowlist gap (verified).** `src/command-runner/decide.ts:24-31` (verbatim): `'ls-files','hash-object','cat-file','rev-parse','rev-list','check-attr'`. `ls-tree` and `worktree` are absent and `status` is deliberately not needed: Reconcile = `snapshot()` compared with the stored overlay. Amend ADR 4 (dated section) and add exactly `ls-tree` and `worktree list --porcelain -z` with argument validation, plus decide tests.
**Event sources.** Watch each worktree root with `ignore: ['.git','node_modules','**/node_modules']`; separately watch each worktree's git dir with `ignore: ['objects','logs','*.lock','hooks','info']`. **Verified:** `checkout -b` produced `HEAD`, `index`, `refs/heads/<name>`; `worktree add` produced `worktrees/<name>/...`. Treat every event as "hash this path" and ignore the event `type` (verified: a modification of an existing file arrived as `create`; an atomic tmp+rename save arrived as `delete:a.tmp | create:a.txt`; 50 rapid writes arrived as one event).
**`getEventsSince` is not a startup catch-up (verified).** After `writeSnapshot`, an offline change returned `[]` immediately and the real event only after ~1.5 s on the default fs-events backend; the `brute-force` backend returned it at once. D-02's "where a snapshot exists" must stay an optional hint; **Reconcile via `snapshot()` is authoritative**, and the start-up deadline before `degraded: ['reconciling']` must allow for ~0.3-0.5 s of snapshot on a gsd-core-sized repo (recommend 1,500 ms `[ASSUMED]`).
**Timing budget for IDX-01 (< 1 s):** watcher ~16 ms (mac) + 100 ms trailing debounce + `hashPaths` (one git process; `[ASSUMED]` 30-150 ms, more on Windows) + read + parse/extract (~10 ms typical file) + commit (~1-9 ms measured, 25 ms budget) = roughly 200-350 ms; the 500 ms max-wait bounds continuous bursts to ~0.8 s. The constants 100/500 ms are timeout-shaped values; see Pitfall 11 about the guard hook.
**Hash/parse race (ARCHITECTURE Gap 6).** `stat` before and after the read; if they differ, re-queue. `commitFile` is idempotent on `(worktree, path, hash)`.
**Source set (LNG-05).** Only extensions claimed by loaded modules are parsed (gsd-core: 280 `.cts`, 1,338 `.cjs`, 42 `.js`, 2 `.mjs`, 0 `.ts`, no `.tsx`). Skip binaries (NUL in the first 8 KB) and LFS pointers (content begins `version https://git-lfs.github.com/spec/v1`) with a diagnostic.

### Pattern 7: `history --at <commit>` without writing (STO-09)

`listTree(commit)` -> filter by claimed extensions and requested paths -> `readMany` (one `cat-file --batch` run) -> parse/extract in the pool -> load into a **throwaway** Fact Store (temp dir or `:memory:`; the kit opens `:memory:` already, see `selfTest`) -> answer through the same Query code -> discard. Acceptance test: hash every file in the main store directory before and after and assert equality (DESIGN.md "Lifecycle budgets": one file in gsd-core <= 2 s). Never fetch: a missing object in a shallow clone returns a diagnostic naming the commit (`GIT_NO_LAZY_FETCH=1` is already pinned by `gitSpec`; `history.allow_fetch` is out of scope).

### Pattern 8: Parser worker pool and LNG-07

**Verified:** `web-tree-sitter` loads and parses inside `worker_threads` with `Parser.init()` costing ~4 ms per worker; parsing all 1,618 gsd-core `.cts`/`.cjs` files (no queries): 1 worker 2,603 ms, 2 workers 1,384 ms, 4 workers 808 ms. **Verified bounded memory:** parsing 1,338 `.cjs` files with `tree.delete()` four rounds in one process held RSS at **227 MB** every round (no growth). So LNG-07 is about discipline (the lint rule that confines `.parse` to `with-tree.ts` already exists, `eslint.config.js:113-116`) plus a recycle policy as defense (recycle a worker after N files or when RSS exceeds a threshold) and a test that parses a long synthetic run and asserts RSS stays under a bound.
Keep the pool behind the existing async `GrammarEngine.run`, sized `min(4, cpus-1)` with a minimum of 1 `[ASSUMED]`; the worker file needs a `resolveWorkerUrl()` helper that works from `src/*.ts` (tests) and `dist/*.js` (published) (CLAUDE.md "Packaging"). Run the main-thread SQLite writer and Query reads on the main thread (D-01); parsing in workers keeps `initialize`, queries and the event loop responsive during a build.
`measure.ts` already counts `errorBytes`/`totalBytes`; `FileFacts.parse` carries them per file; the CI budget (`npm run grammar:budget`) must be extended from the toy to the two real modules at the corpus SHA.

### Pattern 9: Query, envelope, ranking, fencing (and what the ADR text gets wrong for Phase 2)

- **Envelope:** `Envelope` today is `{schema, ok, data, diagnostics, degraded?}` (`src/facts/request.ts:23-29`). Add optional `citations`, `watermark`, `untrusted_text`, `truncated`, `more`, `hints` there (additive) so adapters stay agnostic and `facts/` stays dependency-free. **`facts/` is a closed leaf (no npm packages, `CLOSED_IMPORTS`), so zod schemas cannot live there.** Put the tool definitions (name, description, zod input schema, `readOnlyHint`) in `src/query/tools.ts` and re-export them from `src/host-client/index.ts`; the CLI and MCP adapters both read them from the HostClient seam. That makes parity structural.
- **New `DegradedCode` members** (union is additive, `src/facts/degraded.ts:8-17`, current eight codes verbatim: `'resolver_failed','resolver_timeout','fresh_timeout','precise_base_commit','precise_unavailable','stale','follower','cache_unavailable'`): add `'reconciling'`, `'rebuilding'`, `'watermark_moved'`. `not_indexed` is an error diagnostic, not a degraded code (D-11).
- **Ranking (D-08):** implement as a pure comparator over a sort-key tuple so the cursor can store the last key: `(matchTier, kindRank, confidenceRank, exportedRank, dirDistance(cwd), path, line, col)`. Test determinism by running the same request 100 times and through CLI and MCP.
- **Cursor (D-09):** base64url of a zod-validated JSON `{lastKey, queryHash, watermarkSeq}`; reject malformed or oversized cursors with a tiny error. Use keyset re-query, never a held read transaction (PITFALLS B4 checkpoint starvation).
- **Budget:** `ceil(JSON.stringify(result).length / 4)` over the whole envelope (PITFALLS B10 suggests bytes/3 as conservative; pick one, label it an estimate in `atlas_status`/metrics). Choose a hard ceiling below Claude Code's 10,000-token warning (mcp-contract ADR context); 8,000 estimated tokens is a sound default `[ASSUMED]`. The "too large, narrow the query" error must itself be tiny.
- **Line text:** the store holds no source text (ADR 8 decision 6), so Query reads the matched line from disk through `SourceTree.readText`. This **contradicts** query-and-policy decision 5 ("Source Tree for nothing"); record it as a dated amendment. If the file is in the watermark's `stalePaths` or shorter than the span, omit the text and set `degraded: ['stale']`. Strip a leading BOM on line 0 (the engine strips it before parsing, so columns already exclude it) and the trailing `\r`.
- **Fencing and normalization (QRY-05), verified:** `s.toWellFormed().replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')` removed zero-width, bidi, tag characters, U+0085, U+2028 and ESC and replaced a lone surrogate with U+FFFD. Strip full ANSI CSI sequences (`\x1b\[[0-9;]*[A-Za-z]`) **before** this, otherwise `[31m` remains. Nonce: `crypto.randomBytes(16).toString('hex')` per response; reject or escape text containing the nonce; apply the same normalization to **every repo-derived string in every field** (symbol names, paths in messages, diagnostics), not only `untrusted_text` (PITFALLS B11).
- **`code_impact` with only INFERRED edges.** mcp-contract decision 5: "`code_impact` follows `EXTRACTED` edges transitively; `INFERRED` hops are listed but not expanded unless asked." In Phase 2 every reference is INFERRED, so a literal implementation expands nothing. Define Phase 2 semantics and amend the ADR: transitive over **EXTRACTED import edges** (file-level importers, depth-limited and capped) plus **direct** INFERRED referrers listed unexpanded, with an explicit `expand_inferred` argument (hop and row caps) to go further.
- **`code_context`:** definition span, kind, parent/children (containment), the file's imports/exports, direct references. Callees, `cites_adr` and `tested_by` are Phase 3.
- **`atlas_status`:** watermark, `stalePaths` count, store status (size, schema version, lease held, rebuilt-after-corruption), Governor status, watch mode (`native|poll|reconcile-only`), last Reconcile outcome, active tiers, and `policy: 'off'` (Policy does not exist until Phase 7). No value statistics (value-dashboard decision 10).
- **CLI exit codes (QRY-04):** `src/cli/index.ts:17-19` defines 0, 1 (usage), 2 (failure). Add 3 = writer lease held / host busy. [CITED: gsd-graph `src/cli.ts` `mapCliError`: build_locked -> 3, other operational -> 2, usage -> 1]. `not_indexed` -> 2 by the same mapping.

### Pattern 10: Tenant, Host, HostClient

`createTenant(repoRef, shared)` wires `SourceTree`, `FactStore` (open with `StoreDeps {resolver, clock, gitHas: tree.hasObject}`; note `OpenStore = (dir, deps) => Promise<FactStore>` at `src/fact-store/types.ts:294`), `Indexer`, `Query`, `Metrics`. `createHost` keeps a `Map<storeId, Tenant>`; the in-process HostClient (`src/host-client/in-process.ts`, today only `lang_test`/`lang_list`) becomes a thin wrapper. **No module-level singletons**: the two-tenant smoke test (HST-02) opens two temp repos in one process and asserts separate store dirs, watchers, watermarks and results, and that closing one leaves the other serving. Request routing: `args.repo`/`cwd` string -> realpath -> `SourceTree.identity()` -> tenant; unknown or non-git path -> `not_a_repo` diagnostic (exit 2). Create tenants lazily on the first code request so `lang_list` and `tools/list` never pay store open or Reconcile cost.

### Pattern 11: Governor (HST-03)

Implement `createGovernor` against the **existing** contract suite (`src/governor/contract.ts`, interface `src/governor/types.ts`: `JobClass = 'interactive' | 'fresh' | 'indexing' | 'maintenance'`, `run(job, fn)`, `lease`, `status`). Phase 2 scope: a priority queue per class (FIFO within class), a concurrency cap, per-job `timeoutMs` with `AbortSignal`, `busy` with `retry_after` in milliseconds when the queue exceeds its bound, one `fresh` slot per `requestId`. Weighted round-robin across tenants and the machine memory budget are Phase 4 (HRD-05). Do not build a worker-pool library; the parser pool is separate and owned by the engine host.

### Pattern 12: `gsd-atlas init` (HST-04)

User scope only, never repo files (PITFALLS B11; MCPoison class). Targets: Claude Code user-scope MCP servers live in `~/.claude.json` under `mcpServers` [CITED: code.claude.com/docs/en/settings]; Codex `~/.codex/config.toml` `[mcp_servers.<name>]` with `command` and `args`; Cursor `~/.cursor/mcp.json` `mcpServers` [ASSUMED: shapes taken from gsd-graph `src/cli/mcp-install.ts`, not checked against current host docs]. Register an absolute path to the installed bin. **Do not copy gsd-graph's approach wholesale:** it spawns `claude mcp add` with `shell: true` (forbidden here by FND-06; the CommandRunner would deny `claude`), falls back to writing `~/.claude/settings.json` `mcpServers` (not the documented user-scope location), writes a repo `.mcp.json` (forbidden by HST-04), and on an unparseable config silently "starts fresh", which would **destroy a user's corrupt-but-recoverable `~/.claude.json`**. Atlas must refuse to touch a file it cannot parse, write atomically (temp + rename, keep one backup), preserve all other keys, and take the home directory as an injected parameter so tests never touch the real one. Hooks are Phase 7; Phase 2 registers MCP only (ROADMAP criterion 5).

### Pattern 13: Metrics module (MET-01, MET-02) and the FND-12 amendment

`src/metrics/` owns `<storeDir>/metrics.db` (beside, not inside, the fact store, so a rebuild or corruption move-aside never loses it). Forward-only numbered migrations keyed by `PRAGMA user_version` (allowlisted), each in a transaction; a db newer than the code disables recording (never fails an answer). Interface from the ADR: `record(event)`, `report(range)`, `reset()`; `record` uses a bounded in-memory queue, never blocks, never throws, counts drops in `dropped_events`. Events are allow-listed (an explicit TypeScript union plus a runtime check) so a path or symbol cannot be recorded by accident. D-17 differs from the ADR's provisional retention ("events 30 days or 50,000 rows, rollups 13 months"): D-17 says 30-day rolling with daily rollups after 7 days; record that as part of the value-dashboard amendment. Token counts are `chars/4` estimates and are labelled as such. The `status` panels (Answers, Freshness, Index health, Tokens served) read only `report()`.

### Pattern 14: Wave decomposition suggested for the planner

| Wave | Plans (parallel within wave) | Requirements |
|------|------------------------------|--------------|
| 1 | (a) ADR ratification + amendments + `scripts/adr*` changes; (b) kernel/seam additions: FileFacts v2, DegradedCode, Envelope fields, sqlite pragma allowlist, CommandRunner allowlist; eslint `MODULES`; new deps behind the `checkpoint:human-verify` | FND-12, enabling work |
| 2 | (c) Source Tree additions; (d) Fact Store schema + Reader + Writer + contract suite on both drivers; (e) grammar modules: lock/pipeline change, queries, fixtures, WASM, CI job; (f) engine: `matches`, text cap, extractor, worker pool; (g) real Governor | STO-01..04, LNG-02..05,07,08, HST-03 |
| 3 | (h) store lifecycle: lease, recovery, collect/compact/check/maintain, location; (i) Indexer: queue, event sources, Reconcile, `ensureFresh`, build | STO-05..08,10, IDX-01..04 |
| 4 | (j) Query + tool definitions; (k) Metrics | QRY-01..03,05, MET-01,02 |
| 5 | (l) Tenant/Host + HostClient; (m) CLI adapter (+ `history`, `maintain`, `init`); (n) MCP adapter | HST-01,02,04, STO-09, QRY-04,06 |
| 6 | (o) gates: recall on corpus SHA, size/perf/20k-edit, SIGKILL/corruption, parity, restart, two-tenant, three-OS CI | all success criteria |

**Tension to resolve:** ROADMAP Planning Notes say to open with a walking-skeleton extension (build then find over a 3-file temp repo through the real Indexer, store, Query, CLI); D-18 says Wave 1's first plan ratifies ADRs. Both fit: ADR plan is docs/scripts only and parallel with kernel work; schedule the thin e2e ("3-file temp repo, build, find, on all three OSes") as the capstone test of Wave 5 and run a reduced version at the end of Wave 3 once Indexer and Reader exist. Do not write throwaway interfaces to get an earlier skeleton.

### Anti-Patterns to Avoid

- **Per-fact rows keyed by the blob-id text** (3.2x store size, 2.2x slower; Pattern 1).
- **Recording every identifier as a reference** (Pattern 2; 783k identifier nodes in `.cjs` alone).
- **`getEventsSince` as the correctness mechanism** (verified lag).
- **A fake Fact Store or table-level tests** (ADR 7 decision 8): tests use real SQLite in a short temp dir with `FakeClock` and a fake `gitHas`.
- **A migration framework for the Fact Store** (D-15): version number, refusal, drop-and-rebuild only.
- **Letting TypeScript shape the core** (ARCHITECTURE Anti-pattern 5): no `.js`->`.ts` substitution table in the engine, Indexer or Query; keep it in module data or Phase 3's ProjectModel.
- **Tool handlers that call the store directly** (ARCHITECTURE Anti-pattern 1): every adapter calls `HostClient.handle`.
- **`console.log` anywhere in the MCP process.** stdout is the protocol.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP framing, `initialize`, `tools/list`, schema advertisement | A JSON-RPC loop | `@modelcontextprotocol/server` `serveStdio` + `registerTool` | Verified; v2 serves legacy `initialize` over stdio and stays stateless |
| File watching across 3 OSes | `fs.watch` recursion | `@parcel/watcher` | Native backends, `ignore`, `writeSnapshot`; raw `fs.watch` recursion is per-directory on Linux and drops events |
| Cross-process writer exclusion | pid file + heartbeat | SQLite `BEGIN EXCLUSIVE` on `lease.db` | OS-released on SIGKILL (verified) |
| Git object hashing with clean filters | Re-implementing `sha1("blob ...")` | `git hash-object --stdin-paths` through `SourceTree` | CRLF/autocrlf/filters change the blob id (STO-02) |
| Fuzzy substring search | LIKE scans | FTS5 trigram, `detail=full` (verified) + plain index for < 3 chars | Budget p95 <= 20 ms |
| Unicode sanitising | Hand-rolled control-character lists | `String.prototype.toWellFormed` + `\p{Cc}\p{Cf}\p{Zl}\p{Zp}` + ANSI CSI strip (verified) | Property escapes cover bidi, zero-width, tags |
| CLI parsing | A parser | `node:util` `parseArgs` (already used, `strict: true`) | Zero dependencies |
| Tool input validation | Manual checks | zod 4 (already a dependency); same schemas feed MCP `inputSchema` | One definition for CLI and MCP |
| JSON config merge for `init` | String splicing | Parse -> merge -> atomic write; refuse on parse failure | Avoid clobbering user config |
| Recall ground truth | Hand counting | TypeScript compiler API in a dev-only script | Verified to match query counts for declarations |

**Key insight:** every hard problem in this phase already has a verified, boring answer; the work is plumbing them together under the existing boundary lint, not inventing anything.

## Common Pitfalls

### Pitfall 1: Planning around the `FileFacts` that exists
**What goes wrong:** Query ranking by "exported over local", reference scoping by import bindings, and `code_impact` callers are all designed in CONTEXT, then the extractor cannot emit them.
**Why:** `LocalSymbol`/`RefSite`/`ImportSite` (`src/facts/file-facts.ts:35-55`) carry only names and spans.
**Avoid:** Wave 1 kernel plan adds the optional fields and `validateFileFacts` checks before any extractor or store plan starts.
**Warning signs:** Plans mention `exported` or `enclosing` with no kernel task.

### Pitfall 2: ADR ratification breaks the existing tests and script
**What goes wrong:** `node scripts/adr-ratify.ts --slug query-and-policy ...` exits "must be one of PHASE1_SLUGS"; `scripts/adr.test.ts` asserts the remaining drafts stay Proposed and that exactly six `draft-` files exist (line 265: `names.filter((n) => n.startsWith('draft-')).length, 6`).
**Avoid:** the ratification plan changes `scripts/adr.ts`, `scripts/adr-ratify.ts` and `scripts/adr.test.ts` (REMAINING map, draft count 6 -> 2, `PHASE1_SLUGS` test) in the same commit as the renames, and updates `docs/adr/README.md` (table, ratification log, schedule) and link references. Issues #10-#13 are the next numbers (issues #2-#9 exist, verified with `gh issue list`).
**Amendments to write** (each a dated section, original text untouched): worktree-lifecycle (lease, leader owns all worktrees, follower, Reconcile interval 10 min vs the drafted 5 min); value-dashboard (forward-only migrations, D-17 retention); query-and-policy (line text via Source Tree, six-tool profile, in-process Host); mcp-contract (worktree identity without Roots, `code_impact` semantics in a grammar-only world, six-tool default, exit code 3); command-runner (`ls-tree`, `worktree list`); sqlite-store (pragma allowlist additions).

### Pitfall 3: The `typescript` grammar does not build with the Phase 1 pipeline
**What goes wrong:** `buildWasm` always runs `tree-sitter generate --abi 15` then `build --wasm` (`scripts/grammar-build.ts:249-251`). **Verified failure:** `generate` in the extracted 0.23.2 `typescript/` directory dies with `Cannot find module 'tree-sitter-javascript/grammar'` (the package depends on `tree-sitter-javascript ^0.23.1`). `build --wasm` alone worked in ~0.8 s using the tarball's prebuilt `src/parser.c` (`LANGUAGE_VERSION 14`; the JavaScript 0.25.0 tarball ships ABI 15).
**Avoid:** extend `GrammarLockSchema` (`src/lang/grammar-lock.ts:99-115`, a `z.strictObject` with `lockVersion: z.literal(2)`) with an optional field that selects "use the packaged `parser.c`, do not run `generate`", and teach `prepareSource`/`buildModule` to honour it; record the `tsx` build needs the whole package (it includes `../common`). No grammar patches are needed in Phase 2 (patches are applied before `generate`, which is where this breaks).
**ABI note:** `abi` in the lock is then 14 for typescript; the engine already loads ABI 14 and 15 (STACK.md, verified there).

### Pitfall 4: `.tsx` cannot ride on the `typescript` module
D-04 lists `.tsx` under `typescript`, but a module has one `grammar.wasm`. The `typescript` grammar does not parse JSX; the `tsx` grammar does not parse `<T>expr` casts in `.ts`. gsd-core has no `.tsx`. See Open Question 1.

### Pitfall 5: Treating SIGKILL as the corruption test
SQLite WAL survives process kill. A test that only kills the writer proves atomicity but never exercises quarantine and rebuild. Do both (Pattern 4).

### Pitfall 6: Hidden writes while "reading"
`history --at`, follower `fresh`, and resolver cache fills must not write. History uses a throwaway store; followers use an in-memory overlay; a reader without the lease returns uncached with `degraded: ['cache_unavailable']` (ADR 7 amendment). Test with a before/after hash of the store directory.

### Pitfall 7: Windows
Close every DB handle before deleting temp dirs (EBUSY); compare paths with `fs.realpathSync.native`; pin `.gitattributes` in fixtures for CRLF/BOM; Windows spawn is 10-50x slower than Linux so never hash per file; `ReadDirectoryChangesW` can overflow silently (Reconcile on every watcher error and on a timer); first-open WAL conversion can return `SQLITE_BUSY` without calling the busy handler (retry under an advisory lock); keep temp dirs short. None of this can be verified locally; the three-OS CI is the check and must run the lease, watcher-storm and SIGKILL tests on all three.

### Pitfall 8: MCP stdout hygiene and startup
A stray `console.log`, a deprecation warning, or a library banner on stdout breaks framing only on rare paths. Install a guard at the very top of `src/bin/gsd-atlas-mcp.ts` (redirect `console.*` to stderr), add an ESLint `no-console` rule for `src/` (the CLI writes through its injected `io.stdout`), and add a test that spawns the real bin through the CommandRunner, runs a scripted session and asserts every stdout line parses as JSON-RPC, including with `NODE_OPTIONS=--trace-warnings`. Answer `initialize` and `tools/list` before opening any store. Exit on stdin EOF (verified for the SDK server).

### Pitfall 9: Over-large capture text and worker structured clone
See Pattern 5 point 2. A 1 MB `.cjs` with a `@definition.function` capture copies kilobytes per capture.

### Pitfall 10: `FakeClock` vs real timers in the Indexer
The debounce and max-wait logic must take the injected `Clock` (`src/facts/clock.ts`: `now()`, `sleep(ms)`); tests with the `ManualEventSource` and `FakeClock` prove coalescing deterministically. A test that depends on real 100 ms timing flakes on Windows CI.

### Pitfall 11: Timeout-shaped constants may be blocked for agents
Phase 1 held back two defaults because a PreToolUse guard refused an agent writing a timeout-shaped constant and demanded human confirmation: the CommandRunner 60 s default (`01-09-SUMMARY.md` "Held back: the 60 s default timeout") and the SQLite 5000 ms busy default (`01-10-SUMMARY.md` deviation 1; `01-VERIFICATION.md` item 3 is still open). `openDatabase` currently defaults `timeoutMs` to 0. Phase 2 needs explicit values: store open (busy timeout), every git spec (`timeoutMs`), debounce 100/500 ms, `ensureFresh` wait, start-up Reconcile deadline, lease retry. Executors may hit the same guard. **Resolve before Wave 2:** a `checkpoint:human-action` to confirm the constants, or load them from a typed config object with documented defaults that a human approves once.

### Pitfall 12: Governor `busy` without a shed point
`busy` needs a bounded queue to mean anything. Define queue bounds per class and test saturation with the fake clock; an unbounded queue never answers `busy`.

## Code Examples

### Writer lease (verified on macOS, Node 26.11.1)
```js
// Source: scratchpad lease/leader.mjs and follower.mjs (run this session)
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('lease.db', { timeout: 0 });
db.exec('PRAGMA journal_mode=DELETE');
db.exec('CREATE TABLE IF NOT EXISTS lease (x)');
try { db.exec('BEGIN EXCLUSIVE'); /* leader: never COMMIT; hold the connection open */ }
catch (e) { /* e.code === 'ERR_SQLITE_ERROR', e.errcode === 5, e.errstr === 'database is locked' -> follower */ }
```
In the real code go through `src/sqlite` (`openDatabase`), not `node:sqlite` directly (lint).

### Watcher subscription (verified)
```js
// Source: scratchpad w/watch.cjs, gitwatch.cjs
const sub = await watcher.subscribe(worktreeDir, (err, events) => { /* err => Reconcile; each event => submit(path) */ },
  { ignore: ['.git', 'node_modules', '**/node_modules'] });
const gitSub = await watcher.subscribe(gitDir, cb, { ignore: ['objects', 'logs', '*.lock', 'hooks', 'info'] });
```

### MCP server over stdio (verified)
```js
// Source: scratchpad mcp/srv.mjs (answered initialize, tools/list, tools/call in 117 ms total)
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
serveStdio(() => {
  const server = new McpServer({ name: 'gsd-atlas', version }, { capabilities: { tools: {} }, instructions });
  server.registerTool('code_find',
    { description, inputSchema: z.object({ name: z.string(), repo: z.string().optional(), budget_tokens: z.number().optional() }),
      annotations: { readOnlyHint: true } },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await client.handle(toRequest(args))) }] }));
  return server;
});
```
The tool result text must be byte-identical to what the CLI prints for the same request (QRY-04).

### Grouped captures with predicates (verified)
```scheme
; Source: scratchpad q/js-cjs.scm (web-tree-sitter 0.27.1)
(variable_declarator
  name: (object_pattern) @import.bindings
  value: (call_expression function: (identifier) @_r
          arguments: (arguments . (string (string_fragment) @import.path)))
  (#eq? @_r "require")) @import.cjs.destructure
(assignment_expression
  left: (member_expression object: (identifier) @_m property: (property_identifier) @_e)
  right: (_) @export.value
  (#eq? @_m "module") (#eq? @_e "exports")) @export.cjs.default
```
```js
const matches = query.matches(tree.rootNode); // [{patternIndex, captures:[{name,node}]}] grouped per match
```

### Trigram table (verified on SQLite 3.54.0, Node 26.11.1)
```sql
CREATE VIRTUAL TABLE names_fts USING fts5(name, content='', contentless_delete=1, tokenize='trigram', detail=full);
INSERT INTO names_fts(rowid, name) VALUES (?, ?);
SELECT rowid FROM names_fts WHERE names_fts MATCH '"onfig"';   -- case-insensitive substring, >= 3 characters
```

### Normalization (verified)
```js
const NORMALISE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const clean = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').toWellFormed().replace(NORMALISE, '');
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| MCP sessions, `Mcp-Session-Id`, Roots | Stateless protocol, explicit args | spec 2026-07-28; SDK v2.0.0 on 2026-07-27 | Repo arrives as a tool argument; stdio `serveStdio` still answers a 2025-era `initialize` (verified) |
| `tree-sitter-wasms` bundles | Self-built WASM from pinned tarballs | Phase 1 decision | Hash-pinned per platform in `grammar.lock` |
| Native `tree-sitter` bindings | `web-tree-sitter` 0.27.1 | STACK.md | No install scripts; works in workers |
| `fs.watch` recursion | `@parcel/watcher` | STACK.md | Native backends |

**Deprecated/outdated:** MCP Roots, Sampling, Logging (deprecated in 2026-07-28); `SSEServerTransport`; `google-protobuf` (irrelevant here).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | SQLite exclusive-lock lease behaves as on macOS on Linux and Windows (including release on kill) | Pattern 3 | Lease design fails on a platform; fallback is a pid-file lease. CI proves it |
| A2 | `@parcel/watcher` event latency, overflow signalling and `ignore` semantics on Linux (inotify) and Windows are acceptable | Pattern 6 | IDX-01 misses on those OSes; Reconcile timer is the backstop |
| A3 | Codex (`~/.codex/config.toml`) and Cursor (`~/.cursor/mcp.json`) registration shapes are as gsd-graph implements them | Pattern 12 | `init` writes a config the host ignores |
| A4 | Single-path `git hash-object` costs 30-150 ms (more on Windows) | Pattern 6 | 1 s freshness budget tighter on Windows; batch more aggressively |
| A5 | Recall >= 90% is reachable for CJS `module.exports`/`require` and ES import/export, not only declarations | Pattern 5 | LNG-02 gate fails for one construct; only declarations were compared with the oracle, CJS counts were compared with an AST count |
| A6 | Parser pool size `min(4, cpus-1)` and recycling thresholds are sensible | Pattern 8 | Memory or speed off; tunable |
| A7 | Start-up Reconcile deadline 1,500 ms; hard output ceiling 8,000 estimated tokens | Patterns 6, 9 | Behavioural defaults, easy to change |
| A8 | `getEventsSince` lag (~1.5 s) is general to the fs-events backend and similar elsewhere | Pattern 6 | Only affects an optimisation |
| A9 | Cache fallback is `~/.cache/gsd-atlas/<storeId>` on all OSes (ADR 8, SKELETON) | Pattern 4 | Windows users may expect `%LOCALAPPDATA%` |
| A10 | `git worktree list --porcelain -z` needs git >= 2.36 | Pattern 6 | Older git fails; add a version check and fall back to newline output |
| A11 | Node 24.16.0's bundled SQLite supports `contentless_delete` and trigram FTS5 (verified on Node 26.11.1 with SQLite 3.54.0; the floor was not run) | Pattern 1 | The kit's open-time `selfTest` already probes `fts5Trigram`; add `contentless_delete` to it |
| A12 | The 20,000-edit gate on a few hundred files has the same ratio behaviour as the 10,000-file ADR prototype | Pattern 4 | Gate gives false comfort; keep the full version nightly |
| A13 | Local gsd-core (`25e8e62`, dirty) is representative of the pinned SHA `10ac3a7` for all counts in this document | Patterns 2, 5, 6 | Numbers shift; re-measure at the pinned SHA before fixing budgets |
| A14 | All timings/sizes here come from one dev Mac, not CI runners (PITFALLS C3: hosted CI timing is noisy) | all | Use count and relative checks as PR gates, wall-clock nightly |
| A15 | Progress-callback cancellation semantics in web-tree-sitter 0.27.1 | Pattern 5 | Pathological files may not be cancellable; fall back to worker termination |

## Open Questions

1. **`.tsx` under D-04.** One WASM per module cannot serve both `.ts` and `.tsx`. Options: (a) `typescript` module = `.ts .cts .mts`, add a data-only `tsx` module (1.4 MB WASM, same archive, `subdir: tsx`); (b) drop `.tsx` for Phase 2. gsd-core has no `.tsx`. **Recommendation: (a) if the user wants D-04's extension list honoured literally; otherwise (b). Needs a user decision because D-04 says "two built-in modules".**
2. **Ref-density policy.** Pattern 2 recommends filtering references at extraction. This changes what `code_refs` can find (a call to an unimported global function is not recorded). It follows D-06's wording but should be confirmed, with the store-size gate as the arbiter on the pinned corpus.
3. **`code_impact` semantics** under INFERRED-only edges (Pattern 9). Needs an ADR amendment and an acceptance example.
4. **Constants approval** (Pitfall 11): who confirms the timeout values and when.
5. **Ratification issue creation.** Issues are opened in GitHub (`open-gsd/gsd-atlas`); the executor needs `gh` auth. Verified `gh issue list` works here.
6. **Shared test/CI budget.** The CI matrix is 3 OSes x Node 24.16.0 and 26. Add the grammar rebuild job for two more modules (TS/JS) and a separate gate job for corpus-SHA measurements (clone cost). Decide where recall/size gates run (PR vs nightly).
7. **`history --at <commit> <symbol>` scope.** Whole-tree symbol search at a commit parses every source file (gsd-core ~1,650 files, 1-3 s with the pool). The budget in DESIGN.md is for one file. Recommend: path form fully supported, symbol form bounded by a file cap with `truncated`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | yes | 26.11.1 (floor 24.16.0 not installed locally) | CI runs 24.16.0 and 26 |
| git | Source Tree, tests | yes | 2.54.0 (Apple Git-157) | none (hard dependency) |
| `@parcel/watcher` prebuild | watcher | yes (`@parcel/watcher-darwin-arm64`) | 2.6.0 | linux/windows prebuilds are optional packages [ASSUMED]; `brute-force` backend |
| `tree-sitter-cli` + wasi-sdk cache | grammar CI job | yes (`~/.cache/tree-sitter/wasi-sdk`, `binaryen`) | 0.27.1 | CI downloads |
| gsd-core checkout | recall/size gates | yes at `~/projects/gsd-core` but **not at the pinned SHA** and dirty | HEAD 25e8e62 | fetch the pinned SHA into a temp dir |
| `gh` | ADR issues | yes | authenticated (issues #2-#9 listed) | manual issue creation |
| Windows, Linux hosts | CI-only verification | no (CI only) | n/a | none: three-OS CI is the check |
| `claude`, `codex`, `cursor` CLIs | `init` testing | `claude` present; others absent | | `init` must be testable with an injected home directory |

**Missing dependencies with no fallback:** none for planning. Windows/Linux verification is CI-only.
**Missing dependencies with fallback:** pinned-SHA gsd-core (fetch to temp dir).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` with native type stripping, coverage via `c8` 12.0.0 |
| Config file | none (scripts in `package.json`): `"test": "node --test \"src/**/*.test.ts\" \"scripts/**/*.test.ts\""` |
| Quick run command | `node --test "src/fact-store/*.test.ts"` (per module) |
| Full suite command | `npm test` (plus `npm run lint`, `npm run typecheck`, `npm run build`, `npm run grammar:budget`) |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FND-12 | ADR files renamed, Accepted, amendments present, README table | unit/doc | `node --test scripts/adr.test.ts` | exists, must be updated |
| STO-01 | Fact Store contract on both drivers | contract | `node --test src/fact-store/*.test.ts` | Wave 0: `src/fact-store/contract.ts` |
| STO-02 | CRLF/BOM/autocrlf spans and blob ids | integration | `node --test src/indexer/*.test.ts` | Wave 0 |
| STO-03 | Two worktrees share facts; branch switch re-parses only changed | integration | `node --test src/indexer/worktree.test.ts` | Wave 0 |
| STO-04 | Same file, two branches, two targets (scripted Resolver and read-time join) | contract | `node --test src/fact-store/*.test.ts` | Wave 0 |
| STO-05 | 20,000 edits <= 1.25x | gate | `node scripts/size-gate.ts` | Wave 0 |
| STO-06 | SIGKILL child + injected corruption rebuild | integration | `node --test src/fact-store/durability.test.ts` | Wave 0 |
| STO-07 | git common dir, synced-path fallback, override | unit | `node --test src/fact-store/location.test.ts` | Wave 0 |
| STO-08 | Two processes: leader/follower, takeover after SIGKILL | integration | `node --test src/fact-store/lease.test.ts` | Wave 0 |
| STO-09 | `history --at` leaves the store byte-identical | integration | `node --test src/cli/history.test.ts` | Wave 0 |
| STO-10 | `maintain <task>` and idle loop | integration | `node --test src/fact-store/maintain.test.ts` | Wave 0 |
| LNG-02 | Per-construct recall >= 90% (fixture truth + oracle sample) | gate | `node scripts/recall.ts --corpus gsd-core` | Wave 0 |
| LNG-03/04 | Confidence tiers, provenance fields on every fact | unit | `node --test src/grammar-engine/extract.test.ts` | Wave 0 |
| LNG-05 | Source set, linguist attrs, binary, LFS | integration | `node --test src/source-tree/*.test.ts` | extend existing |
| LNG-07 | RSS plateau over long run; worker recycle | integration | `node --test src/grammar-engine/pool.test.ts` | Wave 0 |
| LNG-08 | Toy module through extractor | unit | `node --test src/grammar-engine/*.test.ts` | extend existing |
| IDX-01 | Save to find < 1 s (real watcher) | integration | `node --test src/indexer/freshness.test.ts` | Wave 0 (count/relative on PR, wall-clock nightly) |
| IDX-02 | Burst coalesces to one job | unit | `node --test src/indexer/queue.test.ts` | Wave 0 (FakeClock, ManualEventSource) |
| IDX-03 | Missed event and overflow repaired by Reconcile | integration | `node --test src/indexer/reconcile.test.ts` | Wave 0 |
| IDX-04 | `fresh` paths indexed before answer | integration | `node --test src/query/fresh.test.ts` | Wave 0 |
| QRY-01/02 | Envelope shape, ranking determinism, budget, cursor, ceiling | unit/golden | `node --test src/query/*.test.ts` | Wave 0 |
| QRY-03 | `atlas_status`, `lang_list` | unit | same | Wave 0 |
| QRY-04 | CLI and MCP produce identical JSON; exit codes | e2e | `node --test src/cli/parity.test.ts` | Wave 0 |
| QRY-05 | Injection fixture returns fenced; fence-close attempt rejected | unit | `node --test src/query/fence.test.ts` | Wave 0 |
| QRY-06 | `tools/list` returns exactly six tools | e2e | `node --test src/mcp-shim/*.test.ts` | Wave 0 |
| HST-01 | Kill and restart between two tool calls; every stdout line valid JSON-RPC | e2e | `node --test src/mcp-shim/restart.test.ts` | Wave 0 |
| HST-02 | Two-tenant smoke | integration | `node --test src/host/*.test.ts` | Wave 0 |
| HST-03 | Governor contract; `busy` + `retry_after` under saturation | contract | `node --test src/governor/*.test.ts` | exists; add real impl |
| HST-04 | `init` writes user-scope only, atomic, refuses unparsable config | unit | `node --test src/cli/init.test.ts` | Wave 0 |
| MET-01/02 | Migrations, no forbidden fields, write failure swallowed | unit | `node --test src/metrics/*.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** the module's own `node --test` glob plus `npm run lint`.
- **Per wave merge:** `npm test`, `npm run typecheck`, `npm run build`.
- **Phase gate:** full suite green on all three OSes and both Node versions, plus recall, size and perf gates, before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `src/fact-store/contract.ts` and driver wiring tests (both drivers)
- [ ] `src/governor` real implementation against the existing contract
- [ ] Indexer test harness: `ManualEventSource`, temp repos with worktrees via `createTempGitRepo`
- [ ] Child-process helpers for kill/lease tests using `createRealRunner({ decide: allowAll })` (the lint bans `child_process` outside `command-runner`)
- [ ] Fixtures: CRLF, BOM, emoji, LFS pointer, binary, `linguist-generated`, injection comment, two-branch resolution
- [ ] `scripts/recall.ts` (oracle) and size/perf gate scripts; pinned-SHA corpus fetch helper
- [ ] ESLint `MODULES` additions and a boundary fixture test for each new module

## Security Domain

`security_enforcement` is enabled (`security_asvs_level: 1`).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (no socket or token until Phase 4) | n/a |
| V3 Session Management | no (stateless MCP) | n/a |
| V4 Access Control | partial | Repo routing by realpath + `SourceTree.identity()`; reject non-git paths; no cross-repo reads |
| V5 Input Validation | yes | zod schemas on every tool arg, cursor, request `args`; path confinement for `fresh`, `repo`, `cwd` |
| V6 Cryptography | yes (nonce only) | `crypto.randomBytes`, never `Math.random` |
| V7 Error handling and logging | yes | stderr only; no repo text in error messages or tool descriptions |
| V12 Files and resources | yes | `readText` confined to the worktree, no symlink escape, size cap; store dir symlink check |
| V14 Configuration | yes | `init` user scope only; `store.dir` and permissions from user config only |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection in doc comments, symbol names, paths | Tampering / EoP | Random per-response nonce fence, reject text containing the nonce, normalize every repo-derived field, state that fencing reduces but does not prevent |
| Path traversal via `fresh` / `repo` / `cwd` | Info disclosure | Resolve against the worktree root, reject `..`, absolute paths outside the repo, NUL; canonicalize with `realpath.native` |
| Symlink escape on line-text reads | Info disclosure | `lstat` + realpath prefix check; never follow links out of the worktree (Source Tree already skips symlinks in `snapshot`) |
| Repo-controlled store location (`.git/gsd-atlas` symlink, repo-supplied `store.dir`) | Tampering | `lstat` the store dir; refuse symlinks; `store.dir` only from user config or env |
| Repo-controlled git config / filter drivers | EoP | Already mitigated by Phase 1 `gitSpec`/`decide`; new git subcommands (`ls-tree`, `worktree list`) must carry the same pinned `-c` and env, and `decide` tests must cover them |
| Malicious repo-local language module / WASM | EoP | WASM is hash-checked against `grammar.lock` before instantiation (`compileGrammar`); module size caps (`GRAMMAR_LIMITS`); queries are data |
| Pathological input DoS (huge file, regex-like query blowup) | DoS | 2 MiB source cap, `matchLimit`, parse progress callback, worker termination, hard output ceiling |
| SQL injection | Tampering | Prepared statements only; the kit's pragma allowlist |
| Config clobbering by `init` | Tampering | Parse -> merge -> atomic rename; refuse unparsable files; keep a backup |
| Metrics leaking source text | Info disclosure | Allow-listed event union; test that no path/symbol appears in `metrics.db` |
| MCP stdout pollution used to inject protocol frames | Tampering | Guarded stdout, lint `no-console`, framing test |

## Sources

### Primary (HIGH confidence)
- In-repo, read this session: `src/facts/{degraded,file-facts,request,answer,resolution,span,clock}.ts`, `src/fact-store/{types,errors,index}.ts`, `src/grammar-engine/{types,engine,load,normalize,query,limits,with-tree}.ts`, `src/source-tree/{types,real}.ts`, `src/command-runner/{decide,spec,index,real}.ts`, `src/sqlite/{driver,open,index}.ts`, `src/governor/{types,index}.ts`, `src/lang/{manifest,grammar-lock,index}.ts`, `src/host-client/{index,in-process}.ts`, `src/cli/index.ts`, `src/mcp-shim/index.ts`, `src/bin/*.ts`, `src/test-kit/{index,git-repo}.ts`, `eslint.config.js`, `scripts/{grammar-build,adr-ratify}.ts`, `scripts/adr.test.ts` (grep), `package.json`, `.github/workflows/ci.yml`, `test/fixtures/modules/toy/*`.
- `docs/adr/` (2-9 Accepted; draft-worktree-lifecycle, -query-and-policy, -mcp-contract, -value-dashboard), `docs/DESIGN.md` (lines 116-233), `docs/PRD.md` (sections 10-11, M1), `.planning/research/{ARCHITECTURE,PITFALLS,STACK}.md`, Phase 1 `SKELETON.md`, summaries 01-09 and 01-10, `01-VERIFICATION.md` item 3.
- Experiments run this session in the scratchpad (`/private/tmp/claude-501/-Users-trekkie-projects-gsd-atlas/e25c4f32-3462-4760-a1d0-502dc5b9da09/scratchpad/`): `probe1..7.mjs`, `q/ts-tags.scm`, `q/js-cjs.scm`, `lease/`, `w/watch.cjs`, `w/since.cjs`, `w/gitwatch.cjs`, `mcp/srv.mjs`, `fts.mjs`, `bench.mjs`, `bench2.mjs`, `wk.mjs`, `snap.mts`.
- npm registry (`npm view`, 2026-10-16) and `gsd-tools query package-legitimacy check`.

### Secondary (MEDIUM confidence)
- code.claude.com/docs/en/settings (via search result): user-scope MCP servers live in `~/.claude.json`.
- gsd-graph at commit `b105e4d`: `src/cli/mcp-install.ts`, `src/cli.ts` (`mapCliError`), `src/errors.ts` (read via `gh api`).

### Tertiary (LOW confidence)
- Linux and Windows behaviour of every item tagged `[ASSUMED]`.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH. Every new dependency was run; versions confirmed in the registry; two are SUS-flagged for age only.
- Architecture: MEDIUM-HIGH. Matches the Accepted ADRs and the frozen types; eleven mismatches are enumerated and each has a recommended resolution.
- Pitfalls: MEDIUM-HIGH. Most verified by running; Windows/Linux items are `[ASSUMED]`.
- Performance numbers: MEDIUM. Single dev Mac, not CI; synthetic schema.

**Research date:** 2026-10-16
**Valid until:** 2026-11-15 (MCP SDK v2 and TypeScript 7 are fast-moving; re-check `@modelcontextprotocol/server` and `@parcel/watcher` versions before the install task).

## Existing artifacts that must change (checklist for the planner)

| Artifact | Change | Why |
|----------|--------|-----|
| `src/facts/file-facts.ts` | additive optional fields + `validateFileFacts` | Pitfall 1 |
| `src/facts/degraded.ts` | add `reconciling`, `rebuilding`, `watermark_moved` | D-02, D-09, D-14 |
| `src/facts/request.ts` | additive Envelope fields (`citations`, `watermark`, `untrusted_text`, `truncated`, `more`, `hints`) | QRY-01 |
| `src/sqlite/driver.ts` PRAGMA allowlist | add `incremental_vacuum`, `wal_checkpoint`, `journal_size_limit` (+ conformance) | Pattern 4 |
| `src/command-runner/decide.ts` | allow `ls-tree`, `worktree list --porcelain -z`; ADR 4 amendment | Pattern 6 |
| `src/source-tree/*` | `hashPaths`, source-set, `worktrees`, `listTree`, `readMany`, `readText` + contract + fake | Pattern 6 |
| `src/grammar-engine/*` | `matches`, text cap, `extract.ts`, pool, `matchLimit`; regenerate toy goldens | Pattern 5, 8 |
| `src/lang/grammar-lock.ts`, `scripts/grammar-build.ts` | packaged-parser mode (skip `generate`) | Pitfall 3 |
| `modules/typescript`, `modules/javascript` | new data modules | D-04 |
| `eslint.config.js` | add `indexer`, `query`, `tenant`, `host` to `MODULES`; `no-console` | boundary lint |
| `scripts/adr.ts`, `adr-ratify.ts`, `adr.test.ts`, `docs/adr/README.md` | Phase 2 slugs, draft count, tables | Pitfall 2 |
| `src/host-client/in-process.ts` | thin wrapper over `host`; re-export `TOOLS` | Pattern 9, 10 |
| `src/cli/index.ts` | commands, exit code 3 | QRY-04 |
| `src/mcp-shim/index.ts`, `src/bin/*` | real server, lazy composition, stdout guard | HST-01 |
| `package.json` | two exact dependencies (after the human-verify checkpoint) | Standard Stack |
| `.github/workflows/ci.yml` | grammar job covers TS/JS modules; gate jobs; lease/watcher/kill tests on all OSes | FND-01 carry-over |
| `.claude/CLAUDE.md` | Node floor 24.15 -> 24.16 text | contradiction table |
