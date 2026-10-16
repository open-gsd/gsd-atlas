---
gsd_state_version: "1.0"
current_phase: 02
current_phase_name: Grammar Tier, Store and stdio Host
status: executing
stopped_at: Completed 02-17-PLAN.md
last_updated: "2026-10-16T22:57:41.952Z"
last_activity: 2026-10-16
last_activity_desc: Completed 02-17 Reconcile, worktrees and the native watcher
state_head: 92f2204ebbdc53f0a2254823d15ff023626f3a02
progress:
  total_phases: 9
  completed_phases: 1
  total_plans: 48
  completed_plans: 38
  percent: 11
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-15)

**Core value:** Agents get correct, cited, current answers about the code and the platform they are building against, instead of guessing from stale training data or sweeping the repo with grep.
**Current focus:** Phase 02 — Grammar Tier, Store and stdio Host

## Current Position

Phase: 02 (Grammar Tier, Store and stdio Host) — EXECUTING
Plan: 18 of 28 complete (plans 02-01 to 02-17 and 02-21 complete; they ran out of order, next is the lowest-numbered incomplete plan, 02-18)
Status: Ready to execute
Last activity: 2026-10-16 — Completed 02-17 (Reconcile on start, problems, HEAD changes and the idle timer; one leader over every worktree with confined git-directory watching; branch switches that parse only changed files; the @parcel/watcher event source, a save reaching find in about 150 ms; src/indexer)

Progress: [█░░░░░░░░░] 11%

## Performance Metrics

**Velocity:**
- Total plans completed: 35
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 20 | - | - |
| 02 | 17 of 28 | - | - |

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
| Phase 02 P06 | 22 min | 3 tasks | 11 files |
| Phase 02 P07 | 20 min | 3 tasks | 21 files |
| Phase 02 P09 | 25min | 2 tasks | 5 files |
| Phase 02 P10 | 9 min | 3 tasks | 9 files |
| Phase 02 P11 | 18 min | 3 tasks | 12 files |
| Phase 02 P12 | 17 min | 3 tasks | 14 files |
| Phase 02 P13 | 35 min | 3 tasks | 30 files |
| Phase 02 P14 | 16 min | 3 tasks | 9 files |
| Phase 02 P15 | 22 min | 3 tasks | 13 files |
| Phase 02 P16 | 15 min | 3 tasks | 19 files |
| Phase 02 P17 | 21 min | 3 tasks | 19 files |

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
- [Phase 02]: Fact Store: StoreOptions (engine-independent) lives in types.ts; the driver choice is OpenFactStoreOptions in open.ts so types.ts and index.ts stay free of engine vocabulary
- [Phase 02]: Fact Store: overlays keep a dropped flag so a worktree's watermark seq stays monotonic across drop and re-creation; commits and markStale advance seq of other worktrees whose stalePaths changed
- [Phase 02]: Fact Store: grammar-tier edges (refs, callers, importers) are INFERRED and match on bare symbol names; reconcile also reports pending and stale paths; facts are keyed by blob hash alone (first module to commit wins for identical bytes)
- [Phase 02]: Plan 02-07: the 0.27.1 parse progress callback cancels a parse when it returns true; withTree resets the parser afterwards because a cancelled parse otherwise resumes on the next call — Verified at run time (1.7 MB source cancelled in about 1 ms); without reset the next parse of a different source returned the old document's tree
- [Phase 02]: Plan 02-07: extractFileFacts derives parent, qualifiedName and enclosing from spans only; equal spans are siblings; exports mark only top-level non-re-exported symbols; reference sites are scope-filtered at extraction — A hostile or sloppy module cannot produce inconsistent FileFacts (T-02-20); the member-call rule is the first thing dropped if the 02-26 store-size gate fails
- [Phase 02]: Plan 02-07: matchLimit bounds new capture-list allocation only (web-tree-sitter reuses lists allocated earlier in the process), so every engine of one process must use the same limit — Observed: a limit lower than an earlier unlimited run had no effect; documented on GrammarEngineOptions
- [Phase 02]: 02-09: Governor queue bounds are per class and must be finite non-negative integers; Infinity is rejected so no configuration can make a queue unbounded
- [Phase 02]: 02-09: A lease that cannot be granted answers busy with the interactive class retry delay (leases serve reads; the interface has no lease class)
- [Phase 02]: [02-10] A failed metrics batch is requeued ahead of newer events (bounded by metrics.queueMax, overflow dropped and counted) and the flush timer re-arms, so an outage loses nothing within the bound.
- [Phase 02]: [02-10] Report percentiles that fall in the overflow bucket report the largest finite edge with overflow: true (a lower bound); Infinity was rejected because JSON turns it into null. report() flushes first and returns the all-zero report on a database error. Plan 02-22 must render both honestly.
- [Phase 02]: [02-10] Metrics events accept no caller-supplied time or free text: an 'at' key is an unknown key and rejects the event; openMetrics never throws and returns a noop instance with a fixed reason (open_failed, newer_schema, invalid_migrations, invalid_options). Plan 02-28 owns calling rollup() from the idle loop.
- [Phase 02]: [02-11] refs scopes sites by file, import binding and export alias; a site that can reach several definitions is given to each with RefRecord.candidates (set only above one); named bindings skip member sites, namespace bindings match member sites; re-exports are not followed before Phase 3
- [Phase 02]: [02-11] Resolver reads run in three phases (sync grammar read, bounded resolver call, merge); a precise edge supersedes or removes a grammar edge, a timed-out resolver keeps running and fills the cache, and callers prune through removed edges. A site with no cached edge is re-asked (no negative marker): Phase 3 should add one before a real compiler resolver ships
- [Phase 02]: [02-11] names_fts is a contentless trigram table filled once per interned name; meta.fuzzy_path records the last session that kept it in step and a switch rebuilds it. Fuzzy find under three characters stays empty. resolved_edges are keyed by overlay snapshot id plus context and superseded snapshots are pruned on write
- [Phase 02]: [02-12] Only the process with write authority (the lease leader, or any process without a lease) runs the sentinel check, moves files aside, rebuilds or touches an existing schema; a follower skips the open-time bootstrap transaction, reads meta.fuzzy_path, and leaves the dirty sentinel to its owner — STO-08: a follower never writes, and a live leader's sentinel must not be mistaken for a crash
- [Phase 02]: [02-12] The rebuild is recorded in the database (meta rebuild_pending, rebuilt_moved_to, rebuilt_at): rebuilding ends at the first completed setOverlay for every process, and status().rebuiltAfterCorruption survives a reopen; a valid SQLite file without fact-store meta is moved aside, not an error. Plan 02-18 check should reuse noteRebuild and quarantine — D-14: derived data is rebuilt, evidence is kept (newest two moved-aside files)
- [Phase 02]: [02-12] lease.db uses the kit's WAL default with BEGIN EXCLUSIVE held for the leader's life; busy opens retry four times with 20 to 80 ms jitter on real timers; a killed leader's lock is free at once (SIGKILL test). Linux and Windows are unverified until three-OS CI runs the lease, SIGKILL and concurrent-start tests — research assumption A1; ADR 11 amendment
- [Phase 02]: [02-12] The store.dir override comes only from the resolveStoreLocation parameter or GSD_ATLAS_STORE_DIR (absolute path, storeId appended); location.ts reads no file in the repository, treats a symlinked gsd-atlas folder as unsafe, and the cache fallback is {XDG_CACHE_HOME or ~/.cache}/gsd-atlas/{storeId} — T-02-36
- [Phase 02]: 02-13: a const, let or var bound to require() (also behind 'as T') is an import binding, not a const definition; constructors are not method definitions — Keeps find results to navigable definitions; the import is recorded as a CJS require site with its binding
- [Phase 02]: 02-13: module.exports = {a, b: c} yields one export site per property, any other right side yields the name module.exports; the typescript module reads CommonJS forms too — .cts files use them; the harness tells ES from CJS exports by the first token of the site span
- [Phase 02]: 02-13: recall compares queries with hand-curated fixture truth and a TypeScript-compiler oracle (createSourceFile only) over 574 pinned gsd-core files; oracle lines count line feeds only — Independent implementation avoids circular proof (T-02-41); the compiler line map also breaks at U+2028 and lone CR, the engine does not
- [Phase 02]: 02-14: the pool shares matchLimit GRAMMAR_LIMITS.matchLimitMax (65536, as the 02-13 recall engine) and defaults both its hard per-run deadline and the in-worker parse deadline to indexer.parseTimeoutMs (5000) — 02-CONSTANTS.md has no matchLimit row; at equal values the pool deadline usually wins (terminate and lazy reload), both give parse_timeout
- [Phase 02]: 02-14: every way a pool worker ends (deadline, exit, error, recycle, dispose) goes through one detach() that fails in-flight requests and terminates in the background; workers load a grammar lazily on first run, and an invalid engine option comes back from the worker as a coded load error, not a dead worker
- [Phase 02]: 02-14: RSS with two workers recycling every 400 runs climbs through warm-up (about 222, 307, 348 MiB over 1,200 files) and levels at about 397 MiB over 24 rounds; the test bound is relative; Linux and Windows unverified until three-OS CI
- [Phase 02]: 02-15: a worktree is named by its root directory as SourceTree.worktrees() reports it; that string is the store worktree id, the Source Tree argument and the worktree of every notice — The plan wrote build('main') as a placeholder; Query tests already use the root path
- [Phase 02]: 02-15: ignored watcher paths are dropped before hashPaths by snapshot membership (one snapshot per batch for new existing paths, verdicts remembered, a .gitignore event clears them) — hashPaths does not consult ignore rules and check-ignore is outside the CommandRunner allowlist; Reconcile (02-17) repairs paths whose status a rule change flips
- [Phase 02]: 02-15: STO-02 race check: the lstat stamp taken before hashing must equal the stamp before the link and right after the read, else nothing is committed, a requeued notice is sent and the path is hashed again up to maxRaceRetries, then it fails as unstable keeping its earlier facts — Per-path locks stop an older hash being committed after a newer one; a build hashes the paths that need work a second time on purpose
- [Phase 02]: 02-15: queue.flushNow hands the pending entries back instead of delivering them, so ensureFresh runs them as one fresh-class Governor request; two internal bounds are not in 02-CONSTANTS.md: 8 paths in flight and 100000 remembered ignored paths per worktree — Neither is a timeout, a Governor queue bound or a gate threshold; record them if the constants file is reopened
- [Phase 02]: 02-16: a symbol name is the last segment of its qualified name, and only a symbol the exact read returned is the exact tier; any other hit is tier 1 or worse — Stops a CommonJS name such as module.exports from ranking as an exact match for exports; the Reader's exact read is the only proof of an exact name
- [Phase 02]: 02-16: a cursor longer than query.cursorMaxChars (a path over about 330 characters) is not issued; the response is truncated with a static hint and no more cursor. The cursor query hash includes the worktree — Never issue a cursor Query would later refuse as oversized; a cursor must not be replayable against another repository
- [Phase 02]: 02-16: when the Indexer could not finish a fresh path its line text is dropped and the result degrades stale; the Query clock dependency is reserved and unread, the fresh wait lives in the Indexer — The file on disk is newer than the facts, so the old span would point at the wrong line; Plan 02-19 reuses FindContext, cutToBudget, createLineReader and the cursor for the other tools
- [Phase 02]: 02-17: a Reconcile run never undoes a concurrent commit: paths committed by file events or ensureFresh during a run are remembered and the whole-overlay write takes the store's current hash for them — setOverlay replaces the whole overlay, so a commit between the snapshot and the write would be reverted (mutation-checked by the during reconcile test)
- [Phase 02]: 02-17: a HEAD change or watcher problem that arrives while a Reconcile runs gets one follow-up run that begins after it; plain reconcile calls share the run in progress — the run in progress may have taken its snapshot before the change; sharing it would answer with a stale tree
- [Phase 02]: 02-17: a worktree whose .git does not lead to common/worktrees/NAME (or the common dir itself) is neither watched, mapped nor indexed; start with named worktrees covers only those and attach(worktree) adds one (D-11) — T-02-56: a repository file only names evidence; the watched git directory is always Source Tree identity().commonDir
- [Phase 02]: 02-17: Reconcile does not re-extract a stale file because processBatch tries Writer.link first and the store still holds facts for that hash; a grammar upgrade needs a forced re-extract path (note for 02-18) — store.reconcile lists stale paths in reindex but link attaches the known hash; the stale marker is not cleared by a Reconcile
- [Phase 02]: 02-17: @parcel/watcher 2.6.0 installed exact with scripts disabled (prebuilt darwin-arm64 package loads); a save reaches find in about 150 ms against the 3000 ms ceiling on macOS; Linux and Windows watcher behaviour rests on three-OS CI and the Reconcile backstop — assumption A2; internal RECONCILE_CHUNK 256 is not in 02-CONSTANTS.md

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

Last session: 2026-10-16T22:57:41.887Z
Stopped at: Completed 02-17-PLAN.md
Resume file: None
