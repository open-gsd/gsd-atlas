# Project Research Summary

**Project:** gsd-atlas
**Domain:** Local code-intelligence and platform-SDK-facts server for coding agents (MCP, CLI, Agent Skill)
**Researched:** 2026-10-15
**Confidence:** MEDIUM (all hands-on evidence is macOS arm64; Windows and Linux behaviour is from docs only)

> Orchestrator note: the synthesizer subagent could not write this file (the Write tool refuses subagents), so it was assembled by the orchestrator from the four researcher reports. Detail lives in STACK.md, FEATURES.md, ARCHITECTURE.md and PITFALLS.md.

## Executive Summary

The design in `docs/` is decided in depth; research verified and sharpened it rather than replacing it. Three outside facts challenge specific PRD assumptions: TypeScript 7 has no supported programmatic API, the MCP spec dated 2026-07-28 removed protocol sessions, and the "beats grep" eval as written is statistically and methodologically weak. User clarification (2026-10-15): "beats grep" means consumes fewer tokens, not speed.

The competitive gap is narrower than the PRD says. A free MIT local code graph (colbymchenry/codegraph) and Claude Code's native LSP tool already exist. Atlas's differentiators are SDK availability facts (no competitor found), ADR links, worktree-shared correctness, provenance and confidence, enforcement hooks, and honest local metrics.

## Key Findings

### Recommended Stack

- **Runtime:** TypeScript, Node >= 24.15 (floor raised; add a startup FTS5 probe). `node:sqlite` is release-candidate with no flag or warning on 24.22 and 26.12; WAL, read-only connections, `allowExtension`, backup and FTS5 trigram work. `better-sqlite3` 13.0.3 stays as fallback (prebuilds, no install script).
- **Grammars:** `web-tree-sitter` 0.27.1 with `tree-sitter-cli` 0.27.1, built from pinned upstream (byte-identical across builds). Offsets are UTF-16 units.
- **MCP:** official SDK v2 (`@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1, zod ^4.2). Stateless; Host must validate Host/Origin itself.
- **TypeScript compiler:** bundle `typescript@6.0.3` as the fallback; the 6.x classic adapter is the MVP.
- **Other:** `node:test` + c8, tsc emit without a bundler, Zod as schema source (export JSON Schema), `@parcel/watcher` 2.6.0, `@bufbuild/protobuf` 2.16.0 generated from `scip.proto` v0.10.0, `@types/node` 24. npm 11.20 blocks dependency install scripts by default, so runtime deps must not need them.
- **CI:** `runs-on: xcode-27` public-preview runner exists, which could make Mac-only criteria 6 and 15 CI-runnable. Unix socket paths are limited to 104 chars (macOS) and 108 (Linux).

### Expected Features

- **Table stakes:** definitions/references/callers with spans and inline matched line text (returning line text beat location-only: 19% fewer tokens, better rename pass@1), freshness after edits, watcher with staleness signal.
- **Differentiators:** SDK availability facts (`sdk_check`, `platform_card`), ADR citation links, correct sharing across worktrees, provenance and confidence on every fact, enforcement hooks, honest value dashboard.
- **Anti-features:** edit/rename tools, `execute_cypher`, graph analytics, stored embeddings, agent memory stores, network doc fetch, build/test tools, telemetry, LSP bridge, forced semantic-first routing.
- **Tool surface:** suggested default profile of about 6 tools (`code_context`, `code_refs`, `code_find`, `code_impact`, `platform_card`, `sdk_check`) versus the PRD's 13; server-side output ceiling near 8k tokens; `sdk_diff` is the highest overflow risk.
- **Agent behaviour:** agents under-use semantic tools for localization (0-6% of calls with free choice), so the skill and R0 brief matter; R1 deny should stay limited to exact, complete answers.

### Architecture Approach

Build order: Wave 0 (M0, parallel) shared `facts/` kernel, CommandRunner plus recording fake, internal `sqlite/` kit with Fact Store conformance suite, manifest schema and grammar build pipeline, Governor/`record`/HostClient interfaces, and the test kit. M1 starts with a walking skeleton on all three OSes, then Source Tree / Fact Store / Grammar Engine / Governor in parallel, then Indexer, then Query and Metrics, then Tenant/Host/CLI/MCP. M1 must already ship Host -> Tenant and a two-tenant smoke test, or M2.5 becomes a rewrite. Critical path to MVP: FileFacts contract -> (Fact Store || Grammar Engine) -> Indexer -> Query -> Host/MCP -> Project model -> resolved layer -> TS 6.x adapter -> explain -> eval.

ADR gaps needing amendments: (1) stdio-per-agent servers contend for the single writer lease (suggested leader/follower); (2) a compiler-free `ProjectModel` seam is missing; (3) resolved-edge cache fill is a write triggered by a read; (4) `metrics.db` is the only non-derivable state and needs real migrations; (5) "no other module touches SQLite" conflicts with `metrics.db` and `sdk.db`.

Recommended resolutions of ADR open questions: no public `warm()` (add `timeoutMs` and a `resolver_timeout` degraded code at M0 freeze); watcher inside the Indexer behind an `EventSource` port; fresh waits take no Governor slot; Governor LRU key (tenant, worktree, tsconfig project) matters from M2; ledger eviction gets a `status` field in M4.

### Critical Pitfalls

1. **TypeScript 7:** 7.0.x ships with no supported API; 7.1 promises a "new (and different)" one and the `unstable/sync` subpath is already renamed in dev builds.
2. **MCP sessions removed:** DESIGN A23, A27, A37 and drain-and-replace upgrades assume sessions; Claude Code's HTTP client repeatedly fails to re-initialize after a host restart.
3. **Eval design:** at N=50, 80% needs about 46/50 to clear the lower bound; grammar-tier ground truth is circular; a tree-sitter MCP study reportedly scored 0.83 vs 0.92 for grep at about 10x fewer tokens.
4. **Hook loops:** block caps live in an evictable in-memory ledger, so a restart resets them.
5. **Stack traps:** web-tree-sitter needs manual `.delete()` and the WASM heap never shrinks; `node:sqlite` is synchronous; WAL first-open race on Windows; watchers drop events silently (Reconcile on every overflow); batch git hashing with `GIT_OPTIONAL_LOCKS=0` and `-z`; fixed-port loopback fallback risks leaking the bearer token; register MCP at user scope only.
6. **Scope:** M0 bundles 7 seams, 14 ADR issues and 3-OS CI with no running slice; M4 is far too large.

## Implications for Roadmap

Suggested phases (the synthesizer proposed 9; final structure is the roadmapper's call after the decisions below):

1. Foundations, walking skeleton and 3-OS CI (M0)
2. Grammar tier, store, Indexer, Query, stdio Host (M1)
3. TypeScript MVP and eval (M2)
4. Host hardening (M2.5)
5. Swift module (M3)
6. SDK facts (M4a)
7. Agent integration, hooks, dashboard (M4b/c)
8. SCIP, BYO proof, bridge (M5)
9. 1.0 (M6)

### Decisions Needed (research conflicts with PRD or with itself; deliberately unresolved)

- **D1 TypeScript 7:** gate M2 on 6.x only (bundle 6.0.3, no `unstable` import) vs feature-detect 7.x subpaths. Also "never bundled by default" (ARCHITECTURE) vs "always bundle 6.0.3" (STACK).
- **D2 MCP sessions:** make the Host stateless and the stdio shim the default with reconnect; reword A23/A27/A37; choose which spec revisions to support.
- **D3 Eval:** adopt a pooled, pre-registered non-inferiority design with an independent oracle (accuracy floor, token reduction as the win, consistent with the user's clarification); and whether the free-alternatives scan (include codegraph and Claude Code LSP) moves to a 1-2 day task before M1 (currently before the M2 eval).
- **D4 M0 shape:** ratify all 14 ADRs in Phase 1 (current decision) vs a roughly 2-week vertical slice first with lazy ratification; Wave 0 seam freezes.
- **D5 Scope:** split M4 in three; define 1.0 as a subset; move M2.5 diagnostics, `bug` and dashboard after a public 0.x; use the `xcode-27` runner for criteria 6 and 15; adopt the 6-tool default MCP profile.
- **D6 Swift grammar:** A48's 0.5% parse-error budget is unmet. npm 0.7.1 is stale; 0.7.3 fails 11.8% and 6.9% on two real codebases; upstream `main` @ 9e3b87f fails 2.4% and 1.8% but needs a `scanner.c` patch. Measure bytes inside ERROR nodes instead of file-level `hasError`.
- **D7 Smaller conflicts:** Node floor 24.15 vs a reported (unverified) NUL-truncation bug; span encoding (UTF-16 vs UTF-8 bytes); TS compiler isolation (Worker vs child process); watcher adapter; the "<1 s freshness" claim; leader/follower in M1 (in no ADR).

### Phase Ordering Rationale

Seams and test doubles first, then a walking skeleton on all three OSes (no Windows hardware locally), then vertical slices that each leave a runnable system. Host -> Tenant must exist in M1.

### Research Flags

Phases needing deeper research: 1 (tree-sitter to WASM build on 3 OSes), 2 (fs.watch per OS; `node:sqlite` across worker threads), 3 (TS compiler process model, tsconfig/project model), 4 (cross-platform lock election, named pipes), 5 (Swift `refs.scm`), 8 (SCIP, IndexStoreDB helper). Phases 6, 7, 9 use standard patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Versions from `npm view` 2026-10-15; behaviour from official docs plus macOS arm64 runs; Context7 unreachable |
| Features | MEDIUM | Classification MEDIUM, individual numbers LOW; vendor benchmarks are vendor-run |
| Architecture | MEDIUM-HIGH | Graph from the ADRs; resolutions and tooling remarks MEDIUM |
| Pitfalls | MEDIUM | TS 7 and MCP spec facts HIGH; issue-tracker evidence MEDIUM |

### Gaps to Address

- Windows and Linux behaviour unverified (watchers, WAL, named pipes, Defender).
- TS 7 process model, fs.watch per-OS behaviour and the WASM toolchain not verified.
- Memtrace's "paid" status and the PRD's "store size and corruption" claim are unconfirmed (its README says proprietary, private beta, free for individuals).
- `scip-typescript` 0.4.0 untested against TS 6 projects; TS 7.1 API exists only as a dev build.
- Items tagged `[UNVERIFIED]` in PITFALLS.md need spikes: Defender/watcher/SQLite interaction, macOS TCC for detached daemons, Unix-socket path limits, Apple licensing of SDK packs.

## Sources

### Primary (HIGH confidence)
- Microsoft TypeScript 7.0 devblog; Claude Code documentation; MCP SDK v2 and 2026-07-28 spec; `npm view` registry data; local scratch-lab runs.

### Secondary (MEDIUM confidence)
- Claude Code GitHub issues (#27142, #60949, #62008, #75976, #55754, #54360); third-party coverage of the MCP spec change; Memtrace and colbymchenry/codegraph READMEs.

### Tertiary (LOW confidence)
- arXiv 2608.13568 (n=6 SWE-bench-Lite issues); a tree-sitter MCP graph study seen only as a search summary; a single-source Cursor tool-cap claim; a single secondary source on the `node:sqlite` NUL bug.

---
*Research completed: 2026-10-15*
*Ready for roadmap: yes, after the decisions above*
