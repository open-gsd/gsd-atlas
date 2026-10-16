---
gsd_state_version: "1.0"
current_phase: 02
current_phase_name: Grammar Tier, Store and stdio Host
status: executing
stopped_at: Completed 02-05-PLAN.md
last_updated: "2026-10-16T18:52:35.905Z"
last_activity: 2026-10-16
last_activity_desc: Completed 02-04 user approval of constants and MCP SDK package
state_head: b219e715a6488e8d21e658ff5edf4589ce6b3416
progress:
  total_phases: 9
  completed_phases: 1
  total_plans: 48
  completed_plans: 27
  percent: 11
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-15)

**Core value:** Agents get correct, cited, current answers about the code and the platform they are building against, instead of guessing from stale training data or sweeping the repo with grep.
**Current focus:** Phase 02 — Grammar Tier, Store and stdio Host

## Current Position

Phase: 02 (Grammar Tier, Store and stdio Host) — EXECUTING
Plan: 7 of 28 complete (plans 02-01, 02-02, 02-03, 02-04, 02-05, 02-08 and 02-21 complete; they ran out of order, next is the lowest-numbered incomplete plan, 02-06)
Status: Ready to execute
Last activity: 2026-10-16 — Completed 02-05 (Source Tree additions: hashPaths, sourceSet, worktrees, readText)

Progress: [█░░░░░░░░░] 11%

## Performance Metrics

**Velocity:**
- Total plans completed: 27
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 20 | - | - |
| 02 | 7 of 28 | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 02 P02 | 9 min | 3 tasks | 8 files |
| Phase 02 P03 | 8 min | 3 tasks | 9 files |
| Phase 02 P01 | 45 min | 3 tasks | 15 files |
| Phase 02 P08 | 7 min | 3 tasks | 20 files |
| Phase 02 P21 | 6 min | 2 tasks | 5 files |
| Phase 02 P04 | 12min | 3 tasks | 1 files |
| Phase 02 P05 | 55min | 3 tasks | 10 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Nine phases for full PRD 1.0 (M0-M6); M4 split into SDK facts (Phase 6), agent integration (Phase 7), dashboard and eval (Phase 8); M5 and M6 folded into Phase 9 to avoid a thin release phase.
- [Roadmap]: Walking skeleton first. Phase 1 ends with `gsd-atlas lang test` on a fixture module on all three OSes; Phase 2 opens by extending it to build-then-find through the real Indexer, store, Query and CLI.
- [Roadmap]: ADRs are ratified just before the first phase that needs them (schedule in ROADMAP.md Planning Notes); research gap amendments ride along with the ADR they touch.
- [Roadmap]: TypeScript 6.x adapter is the MVP; 7.x subpaths are feature-detected at runtime; `typescript@6.0.3` is bundled as a degraded fallback.
- [Roadmap]: Host is stateless; the stdio shim is the default client path. Tenant and a two-tenant smoke test exist from Phase 2 so Phase 4 is additive.
- [Roadmap]: "Beats grep" means fewer tokens at non-inferior accuracy; the free-alternatives scan precedes the Phase 3 eval; the eval design is pre-registered.
- [Roadmap]: Phases 4 and 5 are independent and may run in parallel; Phase 7 waits on Phase 6 only for hook rule R3.
- [Phase 02]: Citation carries structure only (debug is a string handle, optional text_ref); repo text may appear only in Envelope.untrusted_text — QRY-01 prohibition: keep source text out of every other envelope field
- [Phase 02]: worktree git read shape is exactly list --porcelain -z; worktree is not in GIT_READ_SUBCOMMANDS — Plan 02-03: add/remove/prune/lock write to the repository; only the exact read form is reachable (T-02-06)
- [Phase 02]: SQLite kit drives incremental_vacuum(N) itself; a fresh store needs auto_vacuum=INCREMENTAL plus VACUUM after the WAL open — Plan 02-03: better-sqlite3 steps a no-column statement once; the WAL open writes the header so the pragma alone is ignored
- [Phase 02]: Plan 02-01: four Phase 2 ADRs Accepted as issues 11 to 14; amendments dated 2026-10-16 record the in-process Host, six-tool profile, nonce-fenced untrusted_text, watermark_moved cursor and code_impact chain_confidence before code lands
- [Phase 02]: Plan 02-01: writer contention is lease.db BEGIN EXCLUSIVE with a read-only degraded follower; build and maintain exit 3 when the lease is held; Reconcile idle interval about 10 minutes
- [Phase 02]: Plan 02-08: upstream lock sources take optional generate:false to build from the archive's shipped parser.c; built-in typescript (ABI 14) and javascript (ABI 15) modules are pinned by npm tarball sha256; no module claims .tsx in Phase 2; linux-x64 hashes are recorded by the artifact-platform rule and await CI confirmation
- [Phase 02]: 02-21: gsd-atlas init replaces an existing gsd-atlas entry wholesale and rejects non-absolute launch commands before touching any host — A merged stale key could combine with a new command; a PATH lookup must never be registered (T-02-74).
- [Phase 02]: User approved all proposed Phase 2 constants unchanged (02-CONSTANTS.md Status Approved, 2026-10-16)
- [Phase 02]: User approved @modelcontextprotocol/server 2.3.1 for install by plan 02-23 only; @modelcontextprotocol/node not installed in Phase 2
- [Phase 02]: Plan 02-05: hashPaths hashes what it is asked and does not consult ignore rules; the Indexer (02-15) must drop ignored watcher paths first (T-02-14 holds for snapshot only)
- [Phase 02]: Plan 02-05: readText answers escape/missing/not_file/too_large instead of throwing and refuses final-component links; sourceSet and unhashable-name rules are shared by fake and real

### Pending Todos

None yet.

### Blockers/Concerns

- Windows and Linux behaviour is unverified (watchers, WAL first-open race, named pipes, Defender); no Windows hardware, so three-OS CI is the only check and must exist from Phase 1.
- TypeScript 7.0.x has no supported programmatic API and 7.1 will change it; keep the 7.x adapter feature-detected and degradable (Phase 3).
- Swift grammar misses the 0.5% parse-error budget on current upstream releases; upstream `main` needs a `scanner.c` patch. Measure bytes inside ERROR nodes, not file-level `hasError` (Phase 5).
- Eval power: at N=50, 80% accuracy needs about 46/50 to clear the lower bound; pooled, pre-registered non-inferiority design is mandatory (Phase 3).
- Phase 2 carries 32 requirements; plan it in dependency waves and be ready to split.
- PRD M5 gate (pooled eval on gsd-core, gsd-pi, gsd-path and the Swift app) has no requirement of its own; anchored on REL-04 in Phase 9 (consider adding EVL-04).
- Unconfirmed: Memtrace licensing status, a reported `node:sqlite` NUL-truncation bug (Node floor 24.15), Apple licensing of SDK packs.
- Criteria 6 and 15 need Xcode 27; use the `xcode-27` runner if available, else local self-attested gates.

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-10-16T18:52:35.823Z
Stopped at: Completed 02-05-PLAN.md
Resume file: None
