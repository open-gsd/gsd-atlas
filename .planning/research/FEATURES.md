# Feature Research

**Domain:** Local code-intelligence + platform-SDK-facts server for coding agents (MCP, CLI, Agent Skill)
**Researched:** 2026-10-15
**Confidence:** MEDIUM for the table-stakes / differentiator / anti-feature classification (several independent sources converge). LOW for every individual number. The research-plan seam classifies every web provider used here (`websearch`, `webfetch`) as LOW, even cross-checked; vendor benchmark figures are vendor-run and unverified. Source type is tagged per claim: [P] first-party doc or repo README fetched directly, [V] vendor-reported number, [T] third-party blog or directory, [S] small preliminary study.

Scope note: PRD v0.1.0 (M0-M6, 21 criteria) is not redesigned. Where research suggests a PRD adjustment it is listed under "Findings that touch PRD decisions".

---

## Competitor Landscape (seeds PRD 1.1)

| Category | Representative tools | What they actually offer (2026) | Gap gsd-atlas fills |
|----------|---------------------|---------------------------------|---------------------|
| **Host-native LSP** | Claude Code `LSP` tool + code-intelligence plugins [P]: definition, references, type info, document symbols, workspace symbol search, plus automatic type-error/warning report after every edit. Plugins exist for C/C++, C#, Go, Java, Kotlin, Lua, PHP, Python, Ruby, Rust, Swift (sourcekit-lsp), TS/JS. Inactive until user installs plugin AND the server binary; inactive in cloud sessions. | Free, precise, zero new tool for the user on Claude Code. This is the main free alternative and it is already shipping. | Persistent shared index (a language server is per-session, cold start ~15 s in a study [S], memory grows while it indexes [P]); worktree sharing; SDK availability facts; ADR links; works headless on Linux CI; same answers on every agent host, not only Claude Code. |
| **MCP servers that wrap LSP** | Serena [P] (40+ languages, find_symbol, find_referencing_symbols, symbol overview, rename, replace_symbol_body, insert before/after, persistent memories; paid JetBrains backend for type hierarchy, move/inline, debugging); mcp-language-server (isaacphi) [P] (definition, references, diagnostics, hover, rename_symbol, edit_file; beta, 5 languages tested); lsp-mcp-server, symbols-mcp, beruang/lsp-mcp (59 tools, default 200-reference cap) [T] | Precise per-language navigation and refactoring wherever a server exists. Serena adds edit-by-symbol and memory. | Freshness across many worktrees (LSP servers see one working tree), shared index across agents (one server process per agent session), SDK facts, ADR citations, enforcement hooks, citation spans with confidence labels, honest metrics. Serena's LSP backend cannot resolve declarations in external dependencies [P], which is exactly where SDK facts matter. |
| **Agent-internal repo maps** | Aider repo map [P] (tree-sitter tags, graph ranking, `--map-tokens` default 1k, resizes dynamically, includes only most-referenced identifiers, rebuilt per session); Claude Code (no index; agentic grep/glob search plus Explore subagent) [P][T]; Cursor [P] (local "Instant Grep" index, says it does not store embeddings of the codebase, uploads no paths or code for the index; worktree-dependent features disabled in multi-root workspaces) | Compact per-session orientation; fast lexical search. | Persistence and sharing across sessions and agents; cited facts with spans and confidence; resolved (precise) edges; SDK facts; usable by hosts that have no map. |
| **Free OSS code-graph MCP** | codegraph (colbymchenry, MIT) [P]: Rust/tree-sitter, 34 languages incl. Swift, SQLite+FTS5, default single tool `codegraph_explore` (verbatim source + call paths + blast radius), 7 optional tools, watcher with 2 s debounce and staleness banner, one live MCP writer per project, docs silent on worktrees. GitNexus [T] (graph, impact, detect_changes, rename; reported PolyForm-NC license, i.e. not OSI open source). | A free local graph already exists and is good. | Not "a local graph" (already solved). Atlas must win on: SDK facts, precise tier with provenance, ADR citations, worktree-shared store, multi-tenant host, enforcement, honest value metrics, bring-your-own-language data modules. |
| **Paid or proprietary code-memory services** | Memtrace [P README]: proprietary EULA, closed indexer and MemDB, 25+ MCP tools, bi-temporal history, Louvain communities, centrality, dead code, complexity, API topology, `execute_cypher`, hybrid BM25+vector+rerank, 17 skills; claims "free for individual developers" during beta and after GA, private beta/waitlist, Community license on sign-in, Team tier (self-hosted MemDB, fleet coordination); 8 GB RAM minimum for first index; telemetry opt-out by default (aggregate counts, logs, crash reports) | Broad graph analytics and temporal memory. | Auditable open source (MIT), no telemetry, no sign-in, no waitlist, small footprint. Note the PRD premise "paid" is only partly right (see Findings). Atlas does not need to match its analytics breadth. |
| **Sourcegraph / SCIP** | Sourcegraph MCP [P]: default endpoint curated to 8 tools (read_file, list_files, keyword_search, nls_search, list_repos, commit_search, diff_search, deepsearch_read) "to reduce tool-list noise"; go_to_definition and find_references only on `/.api/mcp/all`; Enterprise plans. SCIP [P] is the precise-index format (scip-typescript GA); precise nav needs per-repo index upload, falls back to search-based nav (false positives and negatives) | Cross-repo, server-hosted, commit-indexed precision. | Local, free, zero server, per-worktree overlays; atlas consumes SCIP (PRD M5) rather than competing with it. Sourcegraph's own decision to hide navigation tools from the default list is evidence for keeping atlas's default tool list small. |
| **Apple / SDK-aware tools** | Xcode 26.3+ `xcrun mcpbridge` [T mostly]: ~20 IDE tools (BuildProject, GetBuildLog, RunSomeTests, XcodeGrep, XcodeRead/Write, RenderPreview, DocumentationSearch, issue-navigator tools); needs a running Xcode with an open project; Xcode 27 reportedly adds an "Allow external agents" gate [T]. Third-party Apple-docs MCPs (kimsungwhee/apple-docs-mcp, apple-doc-mcp, erdncyz) fetch developer.apple.com over the network [T]; agent skills (Paul Hudson SwiftUI skill, Apple Skills) steer toward current APIs via prompt text [T]; SwiftLens on sourcekit-lsp (needs index store; stale ~10 months [T]); XcodeBuildMCP for build/test loop | Docs lookup, build/test/preview. Skills as prose to avoid deprecated SwiftUI. | No tool found that answers "is this symbol in the installed SDK, and is it newer than my deployment target without an `#available` guard" from on-disk symbol graphs, offline, headless, with `sdk_diff` between SDK versions. Docs search is semantic and network- or Xcode-bound; atlas is declarative, cited, checkable, and exportable as a pack for Linux CI. |

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing these and agents revert to grep and Read. Evidence: every surveyed tool ships them.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Definition lookup by name/kind (`code_find`) | Serena find_symbol, codegraph search, Memtrace find_symbol, Claude Code LSP workspace-symbol, Sourcegraph go_to_definition | LOW | Cheapest tool; must return signature + `path:line` not just a location |
| References / callers with spans (`code_refs`) | Every surveyed tool. Agents use it heavily on reference-completeness tasks (45-57% of calls with free choice [S]) | MEDIUM | Return the matched source line inline (see evidence below). Label `INFERRED` vs `EXTRACTED` |
| Symbol context in one call (`code_context`) | codegraph_explore (verbatim source + call paths), Memtrace get_symbol_context, GitNexus context | MEDIUM | Competitors return unbounded source [P]; atlas's `budget_tokens` is the improvement. ADR cites and tests are additive |
| Impact / blast radius (`code_impact`) | codegraph_impact, Memtrace get_impact/detect_changes, GitNexus impact | MEDIUM | PRD choice to expand only `EXTRACTED` edges by default is the precision-first stance; keep |
| Incremental freshness (watcher, debounce, catch-up on reconnect) | codegraph: 2 s debounce, staleness banner on pending files, mtime+hash reconcile on reconnect [P]; Memtrace watch_directory | MEDIUM | Staleness must be visible in the response (watermark, `degraded`), not silent |
| Local-only, no account, no network by default | Claude Code abandoned a vector DB partly for privacy and staleness [T]; Cursor states local index [P] | LOW | Memtrace's sign-in + telemetry opt-out is a negative to avoid |
| Multi-language via tree-sitter grammar tier | codegraph 34 langs, Memtrace 17+, GitNexus 8 deep | MEDIUM | Atlas ships TS + Swift then data-only modules; breadth is not a launch goal |
| Works with major hosts via MCP stdio + install helper | Serena, codegraph, Memtrace all ship client-specific setup | LOW | `gsd-atlas init` registering MCP + hooks covers it |
| Compact default output with a size control | Aider `--map-tokens` 1k; Claude Code warns at 10k tokens; Sourcegraph and codegraph trim tool lists | LOW | PRD `budget_tokens` default 2,000 plus `more` cursor is already above the field |
| Agent instruction file / skill saying when to use the tool | Memtrace 17 skills; codegraph injects server instructions into the system prompt; Serena contexts | LOW | Needed because tool adoption is not automatic (see evidence) |
| Post-edit diagnostics | Claude Code LSP reports type errors after each edit [P] | MEDIUM | For TS/Swift on Claude Code this overlaps the host. Atlas R3 must add what the host cannot: SDK and language-level checks |

### Differentiators (Competitive Advantage)

Aligned with Core Value: correct, cited, current answers about the code and platform.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Installed-SDK availability facts** (`platform_card`, `sdk_lookup`, `sdk_check`, `sdk_diff`) | Agents propose deprecated or invented Apple APIs (`foregroundColor`, `NavigationView`, invented `.cardStyle()`) and the community fix is prose skills [T]. No surveyed tool checks symbols against the installed SDK and the deployment target | HIGH | Strongest unique feature. Depends on symbol-graph extraction (Apple provider), per-axis availability table, SDK packs |
| **SDK packs for Linux/CI** (`sdk export/import`) | Xcode MCP needs a running Xcode with a project open; atlas gives headless checks | MEDIUM | Also unique; supports criterion 6 on Linux |
| **Language-level `syntax_check`** | Flags syntax newer than the project's `requires-python`/`--release`/`LangVersion`. Host LSP only reports what the installed compiler rejects | MEDIUM | No competitor seen. Defer breadth past TS/Swift |
| **ADR citation links** (`cites_adr`, `code_context` includes ADRs, bridge export) | No surveyed tool links code to decision records | LOW-MEDIUM | Cheap comment scan; high value inside open-gsd, lower for outside users. Pattern must be configurable |
| **Worktree-shared store with correct per-branch resolution** | Swarms of agents in worktrees are the 2026 norm [T]. codegraph docs are silent on worktrees, "one live MCP writer per project"; Cursor disables worktree features in multi-root [P]; LSP servers are per working tree | HIGH | Two-layer fact model (local facts by blob id, resolved edges by overlay) is the enabling design; criterion 7 is the proof |
| **Confidence-labelled provenance on every fact** (`EXTRACTED`/`INFERRED`, span, extractor, hash) and `explain` | LSP study: grep precision 0.76 vs LSP 1.00, recall unchanged 0.66 [S]. Agents benefit from knowing which answers are complete | MEDIUM | Competitors return answers without a trust label; `explain` answers "why did atlas say this" |
| **Precise tier from the project's own compiler** (TS 6/7 adapters, SCIP import, IndexStoreDB) shared across agents | Gets LSP-grade precision without a per-agent language-server process | HIGH | TS7 `unstable/sync` risk is in PRD; SCIP import lets Python/Java/Go/Rust arrive without new code |
| **Enforcement hooks R0-R4 with advise default and fail-open** + `atlas-scout` subagent + pre-commit backstop | Adoption problem is real: free-choice agents used semantic tools 0-6% on localization [S]. Existing practice is prompt-level steering (codegraph server instructions) or advisory-only hooks (Gortex Codex hook, enrich not deny) [T]. No Claude Code Grep-redirect deny hook found | HIGH | Novel and risky. Evidence favours advise first, strict only for exact complete answers (as PRD R1 already says) |
| **Local value dashboard with labelled measured/estimated/A-B figures** and `gsd-atlas eval` | Every competitor number is vendor-run: codegraph "62% fewer tokens, 88% fewer tool calls" (own benchmark, 1 question per repo) [V], GitNexus "51% cheaper" [V], Memtrace "3.9x" [V]. Honest local numbers are a trust differentiator | MEDIUM | Goodhart risk handled by PRD honesty rules; keep value stats out of agent context |
| **Bring-your-own language as data** (manifest + wasm + queries, no release) | Serena needs a language server per language; codegraph and Memtrace are closed to user extension | MEDIUM | Python example module proves it (criterion 3) |
| **One host, many tenants, shared SDK stores, version-skew handling** | Memtrace Team "fleet" is paid; codegraph is one writer per project | HIGH | M2.5; correct to defer from MVP |
| **Self-maintaining store** (reconcile, compaction, `history --at` from git) | Memtrace keeps bi-temporal history inside a closed DB; atlas rebuilds from git and keeps the store near fresh-build size | MEDIUM | Differentiates on durability and size; competitors list "database is locked" and corruption-class issues [P codegraph] |
| **User-controlled diagnostics, ratings, `gsd-atlas bug`** | Memtrace telemetry is opt-out; atlas is off by default with per-type consent | MEDIUM | Trust differentiator; low priority for agent value |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Edit, rename, replace-symbol-body, insert-after tools (Serena, mcp-language-server, GitNexus rename) | "IDE-grade refactoring for agents" | Host already has Edit; LSP rename is symbols only, misses comments and strings: location-only LSP rename pass@1 0.67 vs grep 1.00 [S]. Write tools break the read-only trust model | Stay read-only. `code_impact` before edit, `code_refs` with line text, R3 check after edit |
| Embeddings / vector / hybrid semantic search for 1.0 | Fuzzy "find code that does X"; Memtrace and GitNexus ship it | Cursor says it stores no codebase embeddings [P]; Claude Code dropped a vector DB for agentic search, citing staleness and privacy [T]; needs a model and breaks the determinism claim | PRD A15 (post-1.0, opt-in, local) stands |
| Raw query-language tool (`execute_cypher`) | Power users | Agents write bad queries, burn tokens, widen injection surface, bypass budgets and citations | Fixed, budgeted tools; CLI for humans |
| Graph analytics suite: communities, centrality, dead code, complexity, bridge symbols | Memtrace and GitNexus marketing | Does not serve "correct cited answer"; no evidence agents use it; adds tool-list weight | Defer; export through `bridge export` if wanted |
| Large default tool list | "Complete" feel | Tool definitions cost context (estimates 300-600 tokens per tool [T]); Cursor loads all upfront while Claude Code defers behind tool search [T]; Sourcegraph curated its default list to 8 and moved navigation tools out "to avoid spending context window budget on lower-frequency tools" [P]; codegraph defaults to 1 tool | Keep `atlas_build`, `lang_list`, `atlas_status`, `sdk_diff`, `explain` off the always-loaded set or behind a profile; lean on the skill routing table |
| Forced semantic-first routing ("never grep") | Raise tool adoption | Forcing semantic-first dropped success 100% to 89% on localization [S]; text/log/string/config searches are not symbol facts | Keep PRD R1 rule: deny only when atlas has an exact, complete answer |
| Unbounded verbatim source dumps (codegraph_explore style) | One-call convenience | No response cap documented; codegraph itself reports about 80% more retrieval context resident at session end [V]; large MCP outputs get saved to a file by Claude Code | Always `budget_tokens`, ranked results, `more` cursor |
| Persistent agent memory / notes store (Serena memories, Memtrace skills memory) | Cross-session continuity | Overlaps AGENTS.md, gsd-graph and work journals; stale-prose risk; outside "code and platform facts" | Facts only; ADR links via bridge |
| Fetching Apple docs from the network (apple-docs-mcp family) | Richer prose | Network and privacy stance; docs prose is sparse where it matters (declaration + availability are the value) | On-disk symbol graphs only (PRD scope) |
| Build, test, preview, simulator control (XcodeBuildMCP, mcpbridge) | Complete iOS loop | Different product; require running Xcode; maintained by others | Interoperate: `sdk_check` complements `BuildProject` |
| Bi-temporal history stored in the index (Memtrace) | "Time travel" | Store growth and complexity | Rebuild from git on request (`history --at`, U10) |
| Cross-repo HTTP/API topology | Microservice shops | Different engine, needs framework scanners | Post-1.0 via SCIP/workspaces if demanded |
| Telemetry or sign-in | Product analytics | Contradicts privacy constraint; Memtrace's opt-out telemetry and sign-in are cited friction | User-approved diagnostics only |
| LSP bridge as a launch tier | "Reuse servers" | Per-session processes and cold starts (~15 s [S]), memory growth [P], defeats shared index | PRD out-of-scope stands; SCIP import covers the precise tier |

---

## Agent-Usage Evidence per MCP Tool (token budgets and output limits)

Host limits that bound every tool:

- Claude Code [P, code.claude.com/docs/en/mcp]: warns when an MCP result exceeds 10,000 tokens (fixed); default max 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`); text results over 50,000 characters are saved to a file in the session's `tool-results` directory and the model gets a path (unless the tool sets `anthropic/maxResultSizeChars`); error results over about 11,000 characters keep only first and last 5,000; HTTP/SSE responses over 16 MiB fail. Tool search defers MCP schemas by default.
- Codex CLI [T]: global `tool_output_token_limit` (blog suggestion 12,000; built-in default not confirmed); v0.152.0 (reported Sept 2026) adds per-tool `output_token_limit` under an MCP server; low limits can hide needed detail and force re-calls.
- Cursor [T]: loads tool definitions upfront each request; a 40-tool cap is reported by one blog only and is unverified.
- Aider [P]: map budget 1k tokens, resizes upward when no files are in chat.
- Anthropic tool-writing guidance [T, secondary]: offer concise vs detailed response formats, pagination, filtering, truncation with hints on how to narrow.

| Tool | Closest competitor behaviour | Evidence on agent use and size | Recommendation (no PRD redesign) |
|------|-----------------------------|-------------------------------|----------------------------------|
| `code_find` | Serena find_symbol (`include_body`, `depth`; ~1,000 tokens/result per one comparison [T]); beruang/lsp-mcp default cap 200 results [T] | Agents choose grep for localization 94-100% of the time even when a semantic tool exists; forcing semantic-first hurt [S]. Distinctive names favour grep | Keep tiny (signature + `path:line`, 10-20 hits then `more`). Position for ambiguous/overloaded names. Do not deny grep for string-ish queries |
| `code_refs` | LSP location-only vs text-enriched | Most-used semantic call (45-57% on reference tasks [S]). Location-only results forced about 15 file reads per episode; adding about 2 lines of source around each hit cut reads to 3.2 and raised rename pass@1 0.67 to 0.83 [S]. Precision 1.00 but recall stayed about 0.66: LSP is not complete | Always include the matched line (and optionally +/-1) with `path:line` and `EXTRACTED/INFERRED`; report an explicit "complete for tier X, may miss comments/strings/dynamic" marker so agents know when to also grep. Page by file, not by raw hit |
| `code_context` | codegraph_explore verbatim source + call paths, no documented cap | Adoption is the risk, not size; verbatim dumps inflate resident context [V]. Aider shows 1k tokens is a workable orientation unit | Default 2,000 tokens is right; hard ceiling well under 10,000 even when caller asks for more; rank callers by confidence then proximity; ADR and test pointers as ids, not bodies |
| `code_impact` | Memtrace get_impact, codegraph_impact, GitNexus impact | Transitive closure explodes fast; graph tools report static-analysis blind spots (dynamic dispatch, DI) [P] | Summarise by module with counts, expand only `EXTRACTED` by default (PRD), cursor for the rest; always state which edge classes were excluded |
| `platform_card` | Memtrace onboarding, codegraph server instructions injected into the system prompt | Always-on text is charged every turn; Claude Code shows plugin "Every turn" token cost to users [P], so atlas's fixed cost is visible and comparable | Target about 100 tokens (PRD sample is about 60). It is the R0 brief; never grow it with value statistics |
| `sdk_lookup` | Xcode DocumentationSearch (semantic, needs Xcode), apple-docs MCPs (network) | No usage data found. Doc comments are often absent, declarations plus availability are the payload | Single symbol: declaration, availability per axis, SDK id. Fixed small size; "not found in SDK X, nearest matches" beats a long list |
| `sdk_check` | None found (closest: build errors via BuildProject/GetBuildLog) | No competitor data. Output scales with findings, not input size | Group by file, cap findings per call with `more`, give a one-line fix hint (guard or replacement), distinguish missing / above-target-unguarded / deprecated |
| `sdk_diff` | None found | Largest unbounded risk: iOS 26 vs 27 differences span thousands of symbols | Default to frameworks the project imports, summarise counts per framework, then page; never return a full-SDK diff by default |
| `syntax_check` | Host LSP diagnostics cover compiler-rejected syntax only | No data. Findings are sparse | Return only syntax newer than the project language level, with the minimum level required |
| `explain` | None found | No data; rarely called by agents, mostly by humans and `gsd-atlas bug` | Keep out of the always-loaded set; return debug handle resolution, not prose |
| (all tools) | Claude Code 10k warn / 25k max / 50k-char file spill | A spilled result is read back from a file, costing a tool round trip and often the whole payload | Enforce a server-side ceiling (suggest at most about 8k tokens) irrespective of requested `budget_tokens`, return `more` cursors, and consider declaring a per-tool result-size hint where hosts support it (verify `anthropic/maxResultSizeChars` semantics in the MCP-contract ADR; Claude Code doc excerpt was truncated) |

Cross-cutting findings: (1) tool adoption is task-shaped, so the skill routing table and R0 brief carry more weight than tool count; (2) include context the next decision needs (line text), not bare locations; (3) warm the index before the first query, since a cold server returned only definitions [S]; (4) report completeness so agents keep a native fallback.

---

## Feature Dependencies

```
Fact Store + Source Tree + Grammar Engine (M0)
    └──requires──> Indexer (watcher, Reconcile, ensureFresh) (M1)
                       └──requires──> Query + response envelope (watermark, degraded, citations, budget_tokens, more cursor)
                                          ├──requires──> code_find / code_refs / code_context / code_impact
                                          ├──requires──> explain
                                          └──requires──> CLI parity (criterion 10)

Precise tier (TS 6/7 adapters, SCIP import, IndexStoreDB)
    └──requires──> Two-layer fact model (local facts by blob id + overlay edges)
                       └──enables──> Worktree-shared store and per-branch resolution (criterion 7)

code_context ADR citations ──requires──> cites_adr comment scan ──enhances──> bridge export

Apple provider (symbol-graph extract) ──requires──> CommandRunner + user-level permissions
    └──requires──> SDK store (per SDK id, availability per axis)
           ├──requires──> platform_card, sdk_lookup, sdk_diff
           ├──requires──> Swift module (project model: deployment targets, #available facts) ──> sdk_check
           └──enhances──> SDK packs (Linux CI)

syntax_check ──requires──> language-level reader per project (+ module grammar)

Policy module / hooks R0-R4 ──requires──> Query + sdk_check/syntax_check (R3, R4) + host session ids
    └──enhances──> eval A/B panel ──requires──> Metrics module (M1) + `gsd-atlas eval`
Pre-commit `check --staged` ──requires──> sdk_check + syntax_check + reference integrity

Metrics module ──requires──> Query instrumentation (must exist from M1, not bolted on)

Forced-semantic-first routing ──conflicts──> advise-by-default hooks and fail-open guarantee
Embedding search ──conflicts──> deterministic eval claims and offline/no-model constraint (post-1.0 only)
Write tools (rename/edit) ──conflicts──> read-only trust model and privilege table
```

### Dependency Notes

- **Response envelope before tools:** every tool inherits citations, watermark, `degraded`, budget and cursor. Building tools first and the envelope later forces rework of all ten tool contracts.
- **Metrics before hooks:** the PRD tunes over-enforcement from local metrics (risk table); gates without measurement cannot be tuned.
- **sdk_check needs the Swift project model and the SDK store:** it compares uses, deployment target and `#available` guards, so M3 availability facts precede M4 checks (matches PRD roadmap).
- **Skill and R0 brief are cheap and early-valuable:** given weak organic adoption, ship the skill with M2 (PRD already does) and measure tool-call rate in the 50-question eval before building R1/R2 gates.

---

## MVP Definition

Mapped to PRD milestones; no redesign.

### Launch With (v1 = M0-M2, gsd-core MVP)

- [ ] Query envelope with citations, `budget_tokens`, `more` cursor, `degraded`, watermark; `code_find`, `code_refs` (with line text), `code_context`, `code_impact`, `explain` — table stakes, and the eval depends on them
- [ ] Grammar tier + watcher + Reconcile + `ensureFresh` for TS/`.cts`; TS precise adapters; emit mapping — correct answers on the validation corpus
- [ ] ADR citations in `code_context` — cheapest unique differentiator, visible in the gsd-core eval
- [ ] Skill + routing table; Metrics recording from M1 — adoption and honest baseline for the 50-question eval
- [ ] CLI parity and install helper
- [ ] Record the free-alternatives baseline (this document, extended with a run of codegraph, Claude Code LSP+typescript-lsp and grep on the gsd-core question set) before the M2 eval, as PRD 1.1 requires

### Add After Validation (v1.x = M2.5-M4)

- [ ] Multi-tenant host, shared SDK stores — trigger: swarm/multi-repo budgets (criteria 14, 16)
- [ ] Swift module + Apple provider + `platform_card`, `sdk_lookup`, `sdk_check`, `sdk_diff`, `syntax_check` — strongest differentiator; trigger: Swift app corpus chosen
- [ ] Hooks R0-R4 advise then enforce, `atlas-scout`, pre-commit — trigger: eval shows tools are under-used or invented-API commits reach the repo
- [ ] Dashboard + `gsd-atlas eval` A/B panel

### Future Consideration (v2+ / M5-M6 and post-1.0)

- [ ] SCIP importer, IndexStoreDB helper, Python example, bridge export (M5)
- [ ] More SDK providers (Python, Go, Java, Rust, C#, C/C++) per PRD 7.4 order
- [ ] OKF export; opt-in local embeddings; network sharing after privacy review

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Response envelope + budget/cursor | HIGH | MEDIUM | P1 |
| `code_refs` with inline line text and tier/completeness labels | HIGH | MEDIUM | P1 |
| `code_context` (ADR cites, budgeted) | HIGH | MEDIUM | P1 |
| `code_find`, `code_impact` | MEDIUM | LOW-MEDIUM | P1 |
| Freshness (watcher, Reconcile, ensureFresh, staleness signal) | HIGH | MEDIUM | P1 |
| TS precise tier + emit mapping | HIGH | HIGH | P1 |
| Skill + R0 brief | HIGH | LOW | P1 |
| Metrics (measured/estimated labelling) | MEDIUM | MEDIUM | P1 (data), P2 (dashboard) |
| Worktree-shared store | HIGH | HIGH | P1 (core design) |
| `platform_card`, `sdk_lookup`, `sdk_check` | HIGH | HIGH | P1 for 1.0 (headline differentiator) |
| `sdk_diff` | MEDIUM | MEDIUM | P2 |
| `syntax_check` | MEDIUM | MEDIUM | P2 |
| Hooks advise (R0, R1 attach, R3) | MEDIUM | MEDIUM | P2 |
| Hooks enforce/strict (R1 deny, R2, R4) | MEDIUM | HIGH | P2 (gate on eval) |
| `explain` | LOW-MEDIUM | LOW | P2 |
| SDK packs | MEDIUM | MEDIUM | P2 |
| SCIP import / IndexStoreDB | MEDIUM | HIGH | P2 |
| Bring-your-own language proof | MEDIUM | MEDIUM | P2 |
| Multi-tenant host hardening | MEDIUM | HIGH | P2 |
| bridge export | LOW-MEDIUM | LOW | P3 |
| Diagnostics/ratings/`bug` | LOW (for agents) | MEDIUM | P3 |

**Priority key:** P1 must have for launch of its milestone; P2 should have; P3 nice to have.

---

## Competitor Feature Analysis

| Feature | Claude Code LSP | Serena (LSP) | codegraph (MIT) | Memtrace (proprietary) | Sourcegraph MCP | Xcode mcpbridge | Aider map | gsd-atlas plan |
|---------|----------------|--------------|-----------------|------------------------|-----------------|-----------------|-----------|----------------|
| Definitions / symbol search | Yes | Yes | Yes | Yes | Yes | XcodeGrep only | Map only | `code_find` |
| References / callers | Yes | Yes | Yes | Yes | Yes (`/all`) | No | No | `code_refs` with line text |
| Impact analysis | No | No | Yes | Yes | No | No | No | `code_impact` (EXTRACTED default) |
| One-call context bundle | No | Symbol body + overview | Yes (`explore`) | Yes | read_file | No | Map | `code_context` with token budget |
| Response token budget | Host limits | `max_answer_chars` style knob [T] | Not documented | Not documented | Not documented | n/a | `--map-tokens` | `budget_tokens` default 2,000 + cursor |
| Persistent shared index | No (per session) | No (per project server) | Yes (one writer) | Yes | Yes (server) | n/a | No | Yes, many agents/worktrees |
| Worktree-aware | No | No | Not documented | Not documented | Commit-indexed | n/a | n/a | Yes (criterion 7) |
| Freshness signalling | Live | Server state | Staleness banner | watch_directory | Index lag | Live | Per run | Watermark + `degraded` + `fresh` |
| Provenance / confidence labels | No | No | No (coverage per language) | Not documented | Compiler-accurate claim | n/a | No | Span, extractor, hash, EXTRACTED/INFERRED, `explain` |
| Precise tier | LSP | LSP | Tree-sitter (static) | Tree-sitter resolve | SCIP | Compiler | No | Compiler adapters + SCIP |
| SDK availability facts | No | No | No | No | No | Docs search | No | Yes |
| ADR / decision links | No | No | No | "decision governance" (Team) | No | No | No | Yes (`cites_adr`) |
| Edit / rename tools | Host tools | Yes | No | No | No | XcodeWrite/Update | No | No (read-only) |
| Enforcement hooks | Host feature | No | Prompt instructions | Skills | No | n/a | n/a | R0-R4 advise/enforce |
| Value metrics | No | No | Vendor benchmark | Vendor benchmark | No | No | No | Local, labelled, intervals |
| Licence / cost | Free in host | OSS (MIT per repo; JetBrains backend paid) | MIT | Proprietary, free individual | Enterprise plans | Free with Xcode | Apache-2.0 | MIT |

(Cells "Not documented" mean not stated in the pages fetched, not that the feature is absent.)

---

## Findings that Touch PRD Decisions

1. **PRD 1.1 premise needs a softer statement.** Memtrace is proprietary and closed, but its README says free for individuals during beta and after GA; the "cost" gap is mainly team use, and the real gaps are closed source, 8 GB RAM minimum, waitlist/sign-in and opt-out telemetry. Store size and corruption "seen in practice" were not verifiable from public sources; keep it as "to verify" or remove.
2. **A free MIT local graph (codegraph) and a first-party LSP tool in Claude Code already exist.** The justification for atlas is not "local graph" but SDK facts, precision-with-provenance, worktree/swarm correctness, and enforcement plus honest measurement. The free-alternatives baseline should include codegraph and Claude Code LSP.
3. **Organic tool adoption is weak for localization** (0-6% semantic use [S]), strong for reference tasks. This supports the hooks and skill, and argues the 50-question eval should log tool-call rate, not only accuracy. Studies are small and preliminary (6 SWE-bench-Lite issues, few repos); treat as direction, not proof.
4. **Result shape matters more than result size:** inline line text beat location-only on tokens (about 19% fewer on renames) and correctness [S]. Make this an acceptance detail of `code_refs`/`code_context` (criterion 2 currently checks span containment only).
5. **Tool-count discipline:** Sourcegraph curated its default MCP list to 8 and codegraph defaults to 1 tool. Atlas lists 13 MCP tools in PRD 8.1. Suggest a default profile (about 6: `code_context`, `code_refs`, `code_find`, `code_impact`, `platform_card`, `sdk_check`) with the rest deferred or opt-in, verified by the dashboard's own-cost panel.
6. **Claude Code's native post-edit LSP diagnostics overlap R3 for TS and Swift;** atlas R3 should position as additive (SDK availability, language level, unresolved references against atlas facts), otherwise duplicates cost tokens.
7. **No prior art found for a deny-style Grep hook on Claude Code;** the nearest (Gortex on Codex) is advisory-only. Keep strict mode behind eval evidence (criterion 15) and keep fail-open.
8. **Xcode 26.3+ mcpbridge needs a running Xcode;** that makes headless/CI SDK checks (SDK packs) a durable differentiator, but Apple could add availability tooling; re-check at M6.

---

## Sources

- Claude Code MCP output limits and behaviour [P]: https://code.claude.com/docs/en/mcp (page read to 100,000 of 122,928 characters; tool-search and `maxResultSizeChars` sections not seen)
- Claude Code tools reference, LSP tool behaviour [P]: https://code.claude.com/docs/en/tools-reference
- Claude Code code-intelligence plugins [P]: https://code.claude.com/docs/en/plugins/code-intelligence
- Serena [P]: https://github.com/oraios/serena
- mcp-language-server [P]: https://github.com/isaacphi/mcp-language-server
- codegraph (colbymchenry) [P]: https://github.com/colbymchenry/codegraph
- Memtrace [P README, V claims]: https://github.com/syncable-dev/memtrace-public ; https://memtrace.io (plans page not retrievable)
- Aider repo map [P]: https://aider.chat/docs/repomap.html
- Cursor indexing [P]: https://cursor.com/docs/context/codebase-indexing
- Sourcegraph MCP curated tools [P]: https://sourcegraph.com/changelog/mcp-curated-default-tools ; SCIP: https://sourcegraph.com/blog/announcing-scip
- "Does a Language Server Save Tokens for Coding Agents?" preliminary study [S]: https://arxiv.org/html/2608.13568 ; write-up: https://www.agentconnect.md/blog/grep-beat-lsp-harness/
- "How Much Static Structure Do Code Agents Need?" [S, body not readable]: https://arxiv.org/pdf/2606.26979
- Xcode 26.3 agentic coding and mcpbridge tool list [T]: https://sdtimes.com/ai/xcode-26-3-adds-agentic-coding-support/ ; https://infoq.com/news/2026/02/xcode-26-3-agentic-coding ; https://tessl.io/registry/skills/github/CharlesWiltgen/Axiom/axiom-xcode-mcp
- Apple docs MCPs and Swift agent skills [T]: https://dev.classmethod.jp/en/articles/apple-doc-mcp-ai-search/ ; https://github.com/twostraws/swiftui-agent-skill ; https://github.com/vabole/apple-skills (extraction method not confirmed)
- GitNexus [T, licence unverified]: https://blog.pebblous.ai/blog/gitnexus-code-knowledge-graph-2026/en/ ; survey: https://wal.sh/research/2026-code-graph-mcp-survey/
- Codex per-tool MCP output limit [T]: https://codex.danielvaughan.com/2026/09/01/codex-cli-v0152-stable-per-tool-mcp-output-limits-app-server-timeouts-compaction-fixes/
- MCP tool-definition overhead [T]: https://getunblocked.com/blog/mcp-tool-overload/
- Anthropic "Writing effective tools for agents" (secondary summaries only) [T]: https://howaiworks.ai/blog/anthropic-writing-tools-for-agents
- Hook patterns [T]: https://www.agentpatterns.ai/tool-engineering/hooks-invoking-mcp-tools/

---
*Feature research for: local code-intelligence + SDK-facts server for coding agents*
*Researched: 2026-10-15*
