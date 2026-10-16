# Phase 2: Grammar Tier, Store and stdio Host - Context

**Gathered:** 2026-10-16
**Status:** Ready for planning

<domain>
## Phase Boundary

A developer can build a local fact index of gsd-core on macOS, Linux or Windows and ask cited, fresh, worktree-correct questions (`code_find`, `code_refs`, `code_context`, `code_impact`) through the CLI or a stateless stdio MCP server. Covers the real Fact Store tables, writer lease and maintenance, grammar-tier extraction for TypeScript and JavaScript, Indexer (watcher, coalescing, Reconcile, `fresh`), Query, the in-process Host with Tenant composition, Metrics, and ratification of four ADRs.

Requirements: FND-12, STO-01..STO-10, LNG-02..LNG-05, LNG-07, LNG-08, IDX-01..IDX-04, QRY-01..QRY-06, HST-01..HST-04, MET-01, MET-02.

Out of scope: compiler-precise TypeScript resolution, `explain`, skill, diagnostics, eval (Phase 3); socket Host, token auth, supervisor, full Governor (Phase 4); Swift (Phase 5); SDK facts (Phase 6).

</domain>

<decisions>
## Implementation Decisions

### Host shape
- **D-01:** Phase 2 builds an **in-process Host per process**. `gsd-atlas-mcp` and each CLI call compose the Host (Tenant per repo: Source Tree, Fact Store, Indexer, Query) in-process. The Indexer and watcher live only while the process lives. A second session on the same repo is a **follower** via the writer lease (STO-08). No Unix socket, named pipe, token, Host/Origin checks, lock election or supervisor in this phase. Phase 4 swaps the HostClient implementation to a socket client without changing adapters. — **Reversibility:** costly — adapters, Tenant composition and lease behaviour are built against this shape; Phase 4 must preserve the HostClient contract.
- **D-02:** On start, the Indexer runs a **Reconcile catch-up** (git status + hash check; `@parcel/watcher` `getEventsSince` where a snapshot exists) so a restarted stdio server answers fresh. If it exceeds a short deadline the answer is returned with `degraded: ['reconciling']`. This satisfies HST-01 (restart between two tool calls).
- **D-03:** **Follower `fresh` paths:** a follower never writes. It parses the `fresh` path(s) into an **in-memory overlay for that request only**, merges over store facts, and reports `degraded: ['follower']`. No cross-process messaging in Phase 2.

### Grammars and extraction
- **D-04:** Ship **two built-in modules**: `typescript` (`.ts .cts .mts .tsx`, tree-sitter-typescript 0.23.2) and `javascript` (`.js .cjs .mjs .jsx`, tree-sitter-javascript 0.25.0), each with its own `grammar.lock`, committed WASM and `parseBudget`. gsd-core is mixed `.cts`/`.cjs`. Python and Swift stay in later phases; the Phase 1 toy grammar remains the second-language Grammar Engine fixture (LNG-08).
- **D-05:** The 90% per-construct recall gate (LNG-02) covers: function, class, interface, type alias, enum, const/var, method and property definitions; containment; ES `import`/`export`; CJS `require`/`module.exports`. Ground truth is **hand-curated fixture truth** plus a pinned sample of gsd-core files at the corpus SHA; for the sample the TypeScript compiler is a **dev-only oracle script**. Recall is reported per construct, never pooled.
- **D-06:** **References** are identifier uses whose name matches a definition, **scoped by import edges and same-file scope**. Always `INFERRED`. Ambiguity is returned as multiple candidates, never guessed. Definitions and imports are `EXTRACTED` (LNG-03).

### Query surface
- **D-07:** Default MCP profile is exactly six tools: `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status`, `lang_list`. Nothing else is registered by default (QRY-06).
- **D-08:** **Ranking** is a deterministic tiered score: exact name > case-insensitive > prefix > substring/trigram; then definitions over references, EXTRACTED over INFERRED, exported over local, same-directory or shorter path relative to a request `cwd` hint; ties broken by path then line. Output is stable and identical across CLI and MCP. No usage-count boost.
- **D-09:** **Pagination:** `more` is an opaque keyset cursor (last sort key, query hash, store watermark). If the store changed between pages, continue and report `degraded: ['watermark_moved']`. `budget_tokens` (default 2,000) is estimated as chars/4 over the serialized result; items are cut whole, never mid-citation; a separate server-side hard output ceiling applies regardless of the requested budget.
- **D-10:** **Line text:** each citation carries `file:line:col` span plus a `text_ref`. Matched line text lives only in `untrusted_text` entries fenced with a **random per-response nonce**, control characters / bidi / ANSI normalized, truncated at a fixed width (QRY-05). Agents read structure from citations and text from the fenced field.

### Index lifecycle and freshness
- **D-11:** **First run:** explicit `gsd-atlas build`. Queries on an unindexed repo return a clear `not_indexed` error naming the exact command. No auto-build. `gsd-atlas init` may offer to run build.
- **D-12:** **Debounce:** per-(worktree, path) latest-hash queue with a **100 ms trailing debounce and 500 ms max-wait**, tunable in config, leaving headroom for parse and write under the 1 s freshness budget (IDX-01/02).
- **D-13:** **Reconcile triggers:** on start, on any watcher error or overflow, on HEAD change (branch switch), and periodically while idle (about every 10 minutes). Start and overflow run at indexing priority; the periodic pass runs at maintenance priority (IDX-03).

### Store layout and recovery
- **D-14:** **Crash detection:** the writer sets a `dirty` marker before a batch and clears it on commit; open checks the marker and runs `PRAGMA quick_check`. On failure, quarantine the file, rebuild automatically from the working tree, and report `degraded: ['rebuilding']`. WAL + `synchronous=NORMAL` otherwise (STO-06).
- **D-15:** **Schema changes:** the fact store is derived data, so **rebuild on schema-version bump** (older code + newer store = refuse with a clear message; newer code + older store = drop and rebuild). **Real forward-only numbered migrations only for the Metrics database.** — **Reversibility:** costly — adding fact migrations later means retrofitting version history that was never kept.
- **D-16:** **GC:** a retired file version is collected once its blob id exists in git, or after a **24 h grace period** (configurable). `maintain compact` runs incremental vacuum / VACUUM at idle. Must pass the 1.25x-after-20,000-edits gate (STO-05).

### Metrics
- **D-17:** Metrics records **counters and histograms only**, 30-day rolling: per tool calls, latency buckets, result count, estimated tokens returned, degraded reasons, freshness lag, index health. Daily rollups after 7 days; hashed ids at most; no source text, paths, symbols or prompts. `gsd-atlas status` panels: Answers, Freshness, Index health, Tokens served, honestly labelled as estimates. A metrics write failure is swallowed and counted, never blocking an answer (MET-01/02).

### ADR ratification
- **D-18:** **The first plan (Wave 1) ratifies all four ADRs** (worktree-lifecycle, query-and-policy, mcp-contract, value-dashboard): open issues, rename to `<issue#>-<slug>.md`, apply the D-16 (Phase 1) dated amendments (writer contention and leader/follower in worktree-lifecycle; metrics migrations in value-dashboard), set Accepted, update the README table. Later plans code against Accepted text; code-driven changes are dated amendments.
- **D-19:** Decisions D-01..D-17 above that differ from or add detail to the drafts (in-process Host, rebuild-on-bump, nonce-fenced `untrusted_text`, six-tool profile) are recorded as **dated amendments** to query-and-policy and mcp-contract where they conflict. `draft-host-process-model.md` stays Proposed for Phase 4. The planner diffs and amends only where needed.

### Claude's Discretion
- Internal table layout and index design inside the Fact Store, provided D-14..D-16 and STO-02..STO-04 hold.
- Exact deadline for the start-up Reconcile before `degraded: ['reconciling']`, exact fixture contents, naming inside each module, CI workflow organisation.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project-level
- `.planning/PROJECT.md` — constraints (Node >= 24.16, three OSes, privacy, no host coupling)
- `.planning/REQUIREMENTS.md` — Phase 2 requirement list (FND-12, STO, LNG, IDX, QRY, HST, MET)
- `.planning/ROADMAP.md` — Phase 2 goal and six success criteria
- `.planning/STATE.md` — blockers
- `.planning/research/STACK.md` — grammar pins, `@parcel/watcher`, `node:sqlite` caveats, MCP SDK v2, platform gotchas
- `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md`
- `.planning/phases/01-foundations-and-walking-skeleton/01-CONTEXT.md` — D-01..D-17 carried forward
- `.planning/phases/01-foundations-and-walking-skeleton/SKELETON.md` — architectural decisions and layout

### Design docs
- `docs/PRD.md` (M1 acceptance), `docs/DESIGN.md` (A1..A63), `docs/DESIGN-REVIEW.md`, `GLOSSARY.md`, `docs/adr/README.md`

### Accepted ADRs (binding)
- `docs/adr/6-fact-model.md`, `docs/adr/7-fact-store-interface.md`, `docs/adr/8-sqlite-store.md`, `docs/adr/9-tenant-composition.md`, `docs/adr/5-language-modules.md`, `docs/adr/4-command-runner.md`, `docs/adr/3-trust-boundaries.md`, `docs/adr/2-product-boundary.md`

### ADRs to ratify in this phase
- `docs/adr/draft-worktree-lifecycle.md` — plus writer-contention / leader-follower amendment
- `docs/adr/draft-query-and-policy.md`
- `docs/adr/draft-mcp-contract.md`
- `docs/adr/draft-value-dashboard.md` — plus metrics-migrations amendment

### Reference only (Phase 4)
- `docs/adr/draft-host-process-model.md` — stays Proposed; defines the later socket Host that replaces D-01

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/command-runner/` — only place child processes start; git calls (`ls-files`, `hash-object --stdin-paths`, `cat-file --batch`) go through it.
- `src/sqlite/` driver layer + conformance suite on `node:sqlite` and `better-sqlite3`; only fact-store, metrics and sdk modules may import it.
- `src/fact-store/` frozen interface (no tables yet); `src/facts/` shared kernel (spans, answer envelope, degraded, request, clock).
- `src/grammar-engine/` + `src/lang/` — real engine, manifest schema, `lang test`, module registry; toy module under `test/fixtures/modules/`.
- `src/governor/`, `src/source-tree/`, `src/precise-resolver/` — interfaces with fakes/no-ops.
- `src/host-client/`, `src/cli/`, `src/mcp-shim/`, `src/bin/` — adapters call HostClient only.
- `src/test-kit/` — fake clock and test helpers (never published).
- `corpora/` — corpus manifest pinning gsd-core to a commit SHA.

### Established Patterns
- ESM, native type stripping, `tsc` emit, `node:test` + `c8`; boundary lint with one fixture test per rule; contract suites beside each seam as `contract.ts`.
- Spans: 0-based line, 0-based UTF-16 column, end exclusive; BOM stripped and recorded; CRLF left in place.
- CLI contract: JSON envelope on stdout, reasons on stderr, exit 0/1/2/3 (QRY-04 extends Phase 1's 0/1/2).
- No fake Fact Store: tests use real SQLite in a short temp dir with fake clock and fake `gitHas`; close DB handles before deleting temp dirs on Windows.

### Integration Points
- Host composition root in `src/bin/` builds Tenant(s) and hands `host.handle(request)` to the CLI and MCP adapters via HostClient.
- `@modelcontextprotocol/server` 2.3.1 stdio (`serveStdio`) for the shim; repo/cwd arrives as an explicit tool argument, not MCP roots.

</code_context>

<specifics>
## Specific Ideas

- Keep temp dirs short in tests (Unix socket and Windows path limits, EBUSY on open handles).
- Pin `.gitattributes` in fixtures for CRLF/BOM cases; compare paths with `fs.realpathSync.native`.
- Every grammar-tier answer must remain honest about confidence: EXTRACTED vs INFERRED, `degraded` reasons spelled out.

</specifics>

<deferred>
## Deferred Ideas

- Socket/named-pipe Host, token auth, supervisor, lock election, shared `sdk.db`/`pkg.db`: Phase 4.
- Usage-count ranking boost and compiler-resolved edges: Phase 3.
- Auto-build on first query, `atlas_maintain` MCP tool, Python built-in module: not scheduled; revisit if Phase 3 eval shows need.
- Cross-process leader messaging for follower `fresh`: Phase 4.

None of the above came from todos (no pending todo matched this phase).

</deferred>

---

*Phase: 2-Grammar Tier, Store and stdio Host*
*Context gathered: 2026-10-16*
