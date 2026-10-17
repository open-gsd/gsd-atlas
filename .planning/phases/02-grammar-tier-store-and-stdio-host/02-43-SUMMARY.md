---
phase: 02-grammar-tier-store-and-stdio-host
plan: 43
subsystem: verification
tags: [gates, size-gate, STO-05, uat, trace, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "gap-closure plans 02-29 to 02-42 and 02-44, and the macOS parcel-source SIGTRAP fix (a0d46f5)"
provides:
  - "Full gate set re-run from a clean tree after the gap-closure work, with real output"
  - "STO-05 / ROADMAP criterion 4 re-verified with the idle-only ratio on both drivers"
  - "24-finding trace plus follow-up trace with proof by test case, and the SIGTRAP execution finding"
  - "02-UAT.md: tests 1 and 5 passed with evidence, test 2 annotated, tests 2, 3 and 4 still pending"
affects: [phase-2-verification, orchestrator push of ci/phase-2]
key-files:
  created: []
  modified:
    - .planning/phases/02-grammar-tier-store-and-stdio-host/02-UAT.md
key-decisions:
  - "No source file was edited and no gate failed, so no checkpoint was needed"
  - "STO-05 reading adopted (the user's decision): the idle loop alone meets the 1.25x bound; no override recorded"
requirements-completed: [STO-05, STO-10, STO-06, STO-08, HST-02, QRY-04, FND-12]
status: complete
actuals:
  tokens: 14000
  tasks: 3
  commits: 2
plan_head_before: 374a62bde668c46c3f89d7923d025ee6e6756875
plan_head_after: see the final docs commit (the SUMMARY commit follows this one)
completed: 2026-10-17
---

# Phase 2 Plan 43: Final gate set and trace Summary

**Every gate is green on a clean tree after all gap-closure plans (2,590 of 2,590 tests, typecheck, lint, build, schema:check, grammar:verify, ci-config), the size gate reads idleRatio 1.0000 on both drivers (bound 1.25, old policy 1.3938), all 24 review findings and the follow-ups trace to a passing test case or a deferral row, and UAT items 1 and 5 are closed with evidence.**

## Setup

- Worktree fast-forwarded to `374a62bde668c46c3f89d7923d025ee6e6756875` (`git merge --ff-only`), tree clean (`git status --short` empty), `node_modules` was missing so `npm ci --ignore-scripts` ran (0 vulnerabilities). Node v26.11.1, macOS arm64.
- The macOS SIGTRAP fix (`a0d46f5` fix, `10c038f` debug record) is in the base.
- Started 2026-10-17T19:36Z (about 25 minutes of wall clock for the gate runs, trace and write-up).

## Task 1: full gate set (real output, last lines)

| Command | Exit | Tail of the output |
|---|---|---|
| `npm run typecheck` | 0 | `> tsc -p tsconfig.json` (no diagnostics) |
| `npm run lint` | 0 | `> eslint src` (no diagnostics) |
| `npm run build` | 0 | `> tsc -p tsconfig.build.json` (no diagnostics; `dist/` is untracked-ignored, `git status` stayed clean) |
| `npm test` | 0 | `ℹ tests 2590` `ℹ suites 421` `ℹ pass 2590` `ℹ fail 0` `ℹ cancelled 0` `ℹ skipped 0` `ℹ todo 0` `ℹ duration_ms 38870.42575` |
| `npm run schema:check` | 0 | `schemas/atlas-lang.schema.json is current.` |
| `npm run grammar:verify` | 0 | `javascript: verified darwin-arm64 rebuild sha256 7ccbce5b...cbfe; committed grammar.wasm sha256 7ccbce5b...cbfe (abi 15, cli 0.27.1)`; `typescript: verified ... d2439218...a87f (abi 14, cli 0.27.1)`; `atlas_toy: verified ... ffe6c2ed...9a (abi 15, cli 0.27.1)` (the pinned tree-sitter 0.27.1 CLI binary was downloaded by the script, as designed) |
| `node --test scripts/ci-config.test.ts` | 0 | `ℹ tests 29` `ℹ pass 29` `ℹ fail 0` `ℹ skipped 0` |
| 16 simultaneous `node --test --test-name-pattern=health scripts/parity.test.ts` (plan 02-44 stress) | 16 x exit 0 | each log: `✔ health: identical JSON once both surfaces are settled, except the one clock field lastReconcileAt, which is masked by name and asserted to be a time (~2.9 s)`, `ℹ pass 1` `ℹ fail 0` |

- Suite counts: **2,590 pass, 0 fail, 0 skipped, 0 todo** (421 suites, 38.9 s). This exceeds the 2,240 recorded in 02-VERIFICATION.md by 350 tests. There was no Windows-only skip because this is macOS.
- No gate failed on the first run, so no re-run to separate environmental from real failures was needed and no checkpoint is returned. No elapsed-milliseconds assertion failed (IN-01 kind): none.
- No source file was edited by this plan.

### Execution finding: macOS `parcel-source` SIGTRAP (not in the plan's trace)

Added to the trace as required. Evidence is in `.planning/debug/parcel-source-sigtrap.md` (status resolved) and was re-checked here.

| Item | Detail |
|---|---|
| Symptom | `node --test src/indexer/parcel-source.test.ts` died intermittently with `SIGTRAP` on macOS arm64 (about 1 in 16 to 20 parallel runs, 1 in about 4 full `npm test` runs); it surfaced in the 02-35, 02-39, 02-40 and 02-44 verification as "parcel-source flake, passes alone". |
| Root cause (from the debug record) | Native defect in `@parcel/watcher` 2.6.0, FSEvents backend: when a watched directory is deleted, `FSEventsCallback` (run loop thread) releases the stream itself while `FSEventsBackend::unsubscribe` (libuv worker) releases it too; unsynchronised, so the FSEventStream is released twice and the heap is corrupted (found with `MallocScribble` and a native reproduction using @parcel/watcher alone). Plan 02-26 raised the rate about sixfold with a second subscription on `.git/worktrees` (a directory git deletes) and a test teardown that deleted the repository before `stop()`. Upstream 2.6.0 is the latest release, so there is no upstream fix. |
| Fix | `a0d46f5`: `src/indexer/parcel-source.ts` no longer opens or renews the `worktrees/` subscription on macOS (FSEvents is recursive; Linux, Windows and others keep it, so the 02-26 linked-worktree HEAD fix is intact); `src/indexer/parcel-source.test.ts` stops the watch before deleting the repository and has two new scripted cases stating the platform decision. |
| Debug-record evidence | 0 of 240 SIGTRAP at 40 parallel (HEAD before the fix: 25 of 160); 0 of 80 at 20 parallel; attribution runs 0 of 240 and 0 of 160; `npm test` 12 of 12 green (2,394 tests each). |
| Evidence re-run by this plan | `node --test --test-reporter=tap src/indexer/parcel-source.test.ts`, 2 rounds of 40 started at once (80 runs) on the clean base: **80 of 80 exit 0, 0 SIGTRAP/SIGSEGV/SIGBUS lines, `# pass 20` `# fail 0` per file**; and the file passed inside the full `npm test` above. |
| Residual | The root cause stays in the native dependency; the product no longer triggers it on macOS. A watched directory must be unsubscribed before it is deleted (comment in `parcel-source.ts`). One unexplained truncated log (1 in 480 runs, no signal) is recorded in the debug file; none was seen in the 80 runs here. |

## Task 2: STO-05 / ROADMAP criterion 4

Real output (clean tree, `node scripts/size-gate.ts`, files 300, edits 20,000, maintain every 200):

```
size-gate: files 300 symbols 8 edits 20000 maintain-every 200 freshBytes 655360 idleBytes 655360 idleRatio 1.0000 max 1.25 settledBytes 655360 settledRatio 1.0000 vacuums 100 longestMaintainMs 13.9 dbstat present maintainRuns 101 seconds 5.8 OK        (exit 0)
--driver better-sqlite3:
size-gate: files 300 symbols 8 edits 20000 maintain-every 200 freshBytes 655360 idleBytes 655360 idleRatio 1.0000 max 1.25 settledBytes 655360 settledRatio 1.0000 vacuums 100 longestMaintainMs 207.5 dbstat present maintainRuns 101 seconds 14.8 OK   (exit 0)
--edits 0:
size-gate: files 300 symbols 8 edits 0 maintain-every 200 freshBytes 630784 idleBytes 630784 idleRatio 1.0000 max 1.25 settledBytes 630784 settledRatio 1.0000 vacuums 0 longestMaintainMs 2.8 dbstat present maintainRuns 1 seconds 0.1 OK   (exit 0)
--maintain-every 0:
size-gate: files 300 symbols 8 edits 20000 maintain-every 0 freshBytes 655360 idleBytes 25079808 idleRatio 38.2687 max 1.25 settledBytes 25088000 settledRatio 38.2813 vacuums 0 longestMaintainMs 0.0 dbstat present maintainRuns 0 seconds 6.5 OVER   (exit 1)
```

`node --test src/tenant/idle-compaction.test.ts src/fact-store/maintain.test.ts scripts/size-gate.test.ts`: `ℹ tests 75` `ℹ pass 75` `ℹ fail 0` `ℹ skipped 0` (cases include "vacuums a fragmented store once", "healthy store is left alone", "maintain request: compact vacuums only when full is asked for", "idle policy passes: the idle-only size is within 1.25 times a fresh build", "old policy is over: ... whatever the final compaction does", "maintenance off is over").

Code reading of `scripts/size-gate.ts`: the header (lines 6-12) states the asserted figure is the idle-only size, measured before any explicit full compaction; the idle loop calls `edited.maintain(MAINTAIN_BUDGET_MS, idle)` with `idle = options.idle ?? IDLE_MAINTENANCE` (lines 209, 234, settle loop at 256); `idleBytes` is read at line 263 ("measured before the explicit full compaction below can hide the idle loop's gap"), the vacuum count is snapshotted at 264, and only then `settledSize(edited)` runs the explicit `compact({ full: true })` (lines 179-181, 265). The result is `ratio = idleBytes / freshBytes` and `ok: ratio <= maxRatio` (lines 275-276); `editedBytes` and `settledRatio` are informational only (63, 74). The command line prints `idleRatio ... OK|OVER` from `result.ok` and returns 0 or 1 (329-334). The explicit path stays explicit: the CLI `maintain compact` request vacuums only when `full` is asked for (Tenant case "maintain request: compact vacuums only when full is asked for").

### Criterion 4 (ROADMAP Phase 2, success criterion 4)

> "The store survives abuse and tends itself: a SIGKILL during writes is detected and the store rebuilt automatically; after 20,000 edits it is at most 1.25x a fresh build; reconcile, resolve, refresh, collect, compact and check run in idle time and as `maintain` commands; the store lives in the git common dir with a cache-dir fallback and `store.dir` override; and a second session on the same repo does not collide on the writer lease, reading as `degraded: ['follower']`."

| Clause | Evidence |
|---|---|
| SIGKILL during writes detected, store rebuilt | `src/fact-store/durability.test.ts` (40 of 40 pass here) and the recovery cases of `src/fact-store/recovery-failure.test.ts` (02-31: a failed takeover or rebuild leaves an honest store) |
| After 20,000 edits at most 1.25x a fresh build | the size gate above: **idleRatio 1.0000 on `node:sqlite` and on `better-sqlite3`** (old policy: 1.3938, mutation case "old policy is over"). Reading adopted (the user's decision): **the idle loop alone meets the bound**, measured before any explicit full compaction; no override is recorded |
| reconcile, resolve, refresh, collect, compact, check in idle time and as `maintain` commands | Tenant idle loop (`src/tenant/idle-compaction.test.ts`, 7 cases) and `maintain` cases in `src/fact-store/maintain.test.ts` (54 of 54) |
| store location (git common dir, cache fallback, `store.dir` override) | `src/host/read-only.test.ts` case "store.dir and cache stores are found", `src/host/index-state.test.ts` cases "store.dir store is found" and "cache store is found" |
| second session is a follower, no lease collision | `src/fact-store/lease-holder.test.ts` ("follower: reports the leader from lease.json ..."), `scripts/read-only-flow.test.ts` ("second build names the holder"), `src/tenant/takeover.test.ts` (in the full suite) |

`longestMaintainMs`: 13.9 ms (`node:sqlite`) and 207.5 ms (`better-sqlite3`) on this machine against the 200 ms single-slice bound. The `better-sqlite3` figure is a full VACUUM, the one unsliced pause; this is the documented exception recorded in the 02-CONSTANTS.md addendum (02-29) and ADR 11 (02-42), and the gate reports the figure without asserting it (earlier runs: 21.2 and 221.0 ms in 02-37). It is not a failure.

**Evidence limit.** These figures come from one machine (macOS arm64). The roadmap's "three OSes" evidence for the new idle ratio comes from the CI `gates` job, which runs the unchanged `node scripts/size-gate.ts` on Linux, macOS and Windows. The next hosted CI run is that observation; this SUMMARY does not claim it.

## Task 3: trace

### Review findings (WR-01 to WR-13, IN-01 to IN-11)

Every test case below was run by this plan (files run whole on the clean base; all green) and the case titles were read from the spec reporter output.

| Finding | Closed by | Test file: case title (exact) |
|---|---|---|
| WR-01 read-only call creates files and takes a lease | 02-41 T1 (ADR 13 amendment: 02-42) | `src/host/read-only.test.ts`: "unbuilt repository writes nothing"; "build creates the store"; "build races a find". Real binaries, `scripts/read-only-flow.test.ts`: "unbuilt repository writes nothing" |
| WR-02 not_indexed message leads to a failing build | 02-30 T3, 02-40 T2, 02-41 T1-T2; CLI-to-leader routing deferred (see below) | `src/fact-store/probe.test.ts`: "older schema: nothing to read, with or without an overlay", "a store whose lease is held by a leader that is open and writing still gives indexed, without waiting"; `src/host/read-only.test.ts`: "created and never built: not_indexed, no tenant, the lease stays free and the store is untouched", "older schema: not_indexed, no tenant, ..."; `scripts/read-only-flow.test.ts`: "build works while the server runs", "second build names the holder", "older schema is not opened"; `src/tenant/messages.test.ts`: "leader holds the lease", "follower with a known holder", "unknown holder", "no paths"; `src/fact-store/lease-holder.test.ts`: "leader: reports this process ...", "follower: reports the leader from lease.json ..." |
| WR-03 failed takeover or rebuild leaves closed handles | 02-31 | `src/fact-store/recovery-failure.test.ts`: "replace fails: the follower stays a follower with working reads, the lease is free, and it did not report leadership", "retry: the re-armed takeover succeeds and onLeaseChange(true) fires exactly once", "restore also fails: the store is closed, the lease is free and leadership was never reported", "close during recovery: ...", "check rebuild fails: the problems end with a rebuild failed line, and the restored store is usable" (both drivers) |
| WR-04 blocking TRUNCATE checkpoint | 02-30 T2 | `src/fact-store/maintain.test.ts`: "checkpoint: a finished run asks for TRUNCATE with a zero busy timeout, an unfinished run for PASSIVE, and the timeout is restored", "checkpoint: the busy timeout is restored when the checkpoint step throws", "checkpoint: a reader holding a snapshot does not hold the compaction, the log drains once it ends" |
| WR-05 rowid reset collides with empty name; no name validation | 02-30 T2 (part a), 02-32 T1 (part b) | `src/fact-store/lifecycle.test.ts`: "empty name: a live fact named with the empty string does not make collect fail after it deleted rows (WR-05)" (both drivers); `src/facts/names.test.ts`: "empty name: symbol, reference site and export", "non-string name: ...", "a NUL character in a name"; `src/fact-store/collected-state.test.ts`, suite "fact text validation at commit": "tracer: a non-string, empty or NUL name is rejected, not thrown, and nothing is written" (both drivers; the store-level proof) |
| WR-06 store identity depends on root print order | 02-38 T3 (smallest root); persisted id deferred to Phase 4 criterion 7 | `src/source-tree/identity.test.ts`: "permutations: the same set in every order gives the smallest id", "permutations: the printed order of several roots changes neither rootCommit nor storeId", "single root unchanged: ...", "two roots: ...", "unborn: ..." |
| WR-07 git calls without timeout | 02-29, 02-38 T1 | `src/source-tree/timeouts.test.ts`: "every method has a timeout", "hung git rejects"; `src/command-runner/real.test.ts`: "default timeout applies to run", "explicit timeout wins", "stream has no default" |
| WR-08 blobs buffered before the cap | 02-38 T2 (needs 02-33 `--batch-check`) | `src/source-tree/capped-reads.test.ts`: "at the cap: ...", "two runs: a size check, then a batch of only the allowed blobs whose output cap follows their sizes", "all oversize: only the size check starts", "empty list: no git starts at all", "unknown commit: ...", "read over the cap throws source_too_large; ..."; allowlist side in `src/command-runner/git-allowlist.test.ts`: "the allowed cat-file --batch-check runs against the same repository and reports a size for HEAD" |
| WR-09 grammar load has no deadline | 02-39 T1 | `src/grammar-engine/pool/pool.test.ts`: "silent load: rejects with engine_init_failed saying the load timed out, ends the worker and frees the slot", "queue continues: ...", "lazy load before a run: ...", "dispose during load: ..." |
| WR-10 tenants and history hosts never freed | 02-41 T3 | `src/host/eviction.test.ts`: "in flight defers: a request running at the deadline keeps its tenant until it ends", "reopens on demand: ..."; `src/host/idle-registry.test.ts`: "in flight defers: a timer that fires with work in flight re-arms and does not call onIdle", "evict reports an idle key at once, ..." |
| WR-11 exact-token option denylist | 02-33 T1 | `src/command-runner/git-allowlist.test.ts`: "no object written: a denied hash-object -w spelling starts nothing and the loose-object count is unchanged" (the option matrix is in `src/command-runner/decide.test.ts`) |
| WR-12 unguarded read-modify-write in init | 02-35 T1 | `src/cli/init.test.ts`: "changed between read and write: refused, the host bytes stay, no backup and no temp file", "changed after temp: refused, the temp file is removed, the host bytes stay, the backup holds the file as init read it", "new file raced: ...", "two inits racing: ...", "concurrent inits: the file always parses with one gsd-atlas entry and no result is a silent loss" |
| WR-13 Indexer.stop can leak the writer slot | 02-34 T1 | `src/indexer/stop.test.ts`: "legacy unsubscribe fails: stop resolves, the module host is disposed and the writer slot is free", "active job: ...", "concurrent stops: ...", "lease regained: ..." |
| IN-01 wall-clock slice assertion | 02-30 T2 | `src/fact-store/maintain.test.ts`: "slice limits: free pages are returned in bounded, growing slices, the WAL is truncated and the file shrinks" (structural, over `COMPACT_SLICE_LIMITS`) |
| IN-02 dead `collected` state | 02-32 T2 | `src/fact-store/collected-state.test.ts`: "CHECK: the files table accepts only live and retired", "re-commit after collect: a new files.id, facts readable, then unchanged", "link of a collected hash answers hash_unknown", "setOverlay of a collected hash stores a pending path" |
| IN-03 six `isInside` copies, `..name` bug | 02-34 T2, 02-38 T3, 02-41 T3, 02-44 T4 | `src/facts/inside.test.ts`: "sibling prefix: /a/bc is not inside /a/b", "dot-dot name: a directory called ..cache below the root is inside", "windows drive: ...", "windows case: ..."; `src/host/read-only.test.ts`: "dot-dot directory name resolves: a directory called ..cache inside the worktree is a child, not a parent" |
| IN-04 wrong init hint location | 02-35 T3 (cache-directory residual closed by 02-44 T3) | `src/cli/init.test.ts`: "the hint names the repository and does not claim the repository has no index", "linked worktree hint: no hint when the common directory (relative commondir) holds gsd-atlas" and the four sibling cases |
| IN-05 environment denylist | Partial: denylist widened in 02-33 T2; allowlist deferred to Phase 4 criterion 8 | `src/command-runner/env.test.ts`: "removed names: cloud, ssh-agent and database credentials the first pattern missed (IN-05)", "kept names: ...", "overlay wins: ..." |
| IN-06 pool deadline equals parse deadline | 02-39 T2 | `src/grammar-engine/pool/pool.test.ts`: "default limits: cut-off 5000, pool deadline 7000, load deadline from the approved addendum", "only runTimeoutMs: the engine cut-off follows it, as before", "a parse over the cut-off ends in parse_timeout and the worker survives with its grammar" |
| IN-07 no signal handlers | 02-36 T1 | `scripts/bin-lifecycle.test.ts`: "SIGTERM releases the lease", "SIGINT also exits cleanly with 130"; `src/bin/shutdown.test.ts`: "first SIGTERM disposes once, then exits 143", "second signal forces exit at once ...", "dispose rejects: ..." |
| IN-08 mutable test hooks | Partial: reset helpers and `afterEach` (02-30 T3); injection through deps not done, no leak found, residual stated | "test hygiene (IN-08)" suites in `src/fact-store/lifecycle.test.ts`, `durability.test.ts` and `maintain.test.ts` |
| IN-09 CLI composes Host before parsing | 02-36 T2 | `scripts/bin-lifecycle.test.ts`: "help does not compose: --help, --version, a usage error and init print no configuration warning", "SIGTERM to the CLI exits 143 after disposing, with no dirty sentinel left"; `src/bin/cli-main.test.ts`: "composed once across several requests, and disposed once", "compose failure is internal_error: ..." |
| IN-10 createTenant leaks store and lease | 02-40 T2 | `src/tenant/create-failure.test.ts`: "store closed when status throws", "closes the store when a step in the middle of construction throws", "store unavailable" |
| IN-11 Governor frees slot on timeout | 02-34 T3 (contract documented and pinned; keep-slot option rejected) | `src/governor/governor.test.ts`: "timeout honours the signal: the signal is aborted, the slot is released once and the next job starts", "timeout ignores the signal: the result is timeout and the slot is freed at once, so the function runs on outside the cap" |
| VERIFICATION item 1: STO-05 idle-only 1.396x | 02-30, 02-37, 02-40, 02-43 | `scripts/size-gate.test.ts`: "idle policy passes: the idle-only size is within 1.25 times a fresh build", "old policy is over: ..."; `src/tenant/idle-compaction.test.ts`: "vacuums a fragmented store once", "healthy store is left alone"; gate lines above |
| VERIFICATION item 5: flaky wall-clock test | 02-30 (= IN-01) | see IN-01 |
| Execution finding: parcel-source SIGTRAP on macOS | `a0d46f5` (debug session `.planning/debug/parcel-source-sigtrap.md`) | `src/indexer/parcel-source.test.ts` (20 of 20), including the two platform cases added by the fix; 80 of 80 parallel runs without a signal, see above |

Deferral rows (findings or parts not mitigated in Phase 2), each stated with what remains unmitigated in the owning plan's Review Dispositions Ledger and the summaries read above:

| Deferred part | Home in ROADMAP.md (read, not edited) | What remains unmitigated |
|---|---|---|
| WR-02: CLI `build`/`maintain` handed to the running leader | Phase 4 criterion 6: "The CLI hands `build` and `maintain` to the process that holds a repository's writer instead of answering `lease_held`: with an agent's MCP server running, `gsd-atlas build` in an unbuilt worktree of an indexed repository, or a rebuild of a built one, succeeds ..." | While an MCP server leads an existing index, a rebuild or a first build of another worktree still answers `lease_held` (exit 3), now naming the holder's pid and version (02-40, 02-41; pinned by "second build names the holder") |
| WR-06: persisted store identity | Phase 4 criterion 7: "A store keeps one identity when its repository's root commits change: the store id is persisted with the store and no longer recomputed from the roots reachable from HEAD ..." | `storeId` still changes when the set of roots reachable from HEAD changes (02-38 SUMMARY); the identity probe runs before Governor admission (HRD-05) |
| IN-05: environment allowlist | Phase 4 criterion 8: "A child process started for a user-allowed executable receives an allowlisted environment ... not the inherited environment minus a denylist ..." | Variables outside the widened denylist still pass to children (02-33 SUMMARY, `env.ts` header) |
| IN-08: hooks injected through deps | no ROADMAP home (partial, residual stated in 02-30) | Test hooks stay a module-level mutable object; reset helpers and `afterEach` guards remove the leak risk |

ROADMAP.md Phase 4 criteria 6, 7 and 8 are present (read at lines 172-189; verbatim starts quoted above). No file under `.planning/ROADMAP.md` or `.planning/STATE.md` was edited by this plan.

### Plan 02-44 follow-ups

| Follow-up | Plan task | Test file: case title (exact), confirmed by running | Before / after |
|---|---|---|---|
| `health` parity flake: the helper `untilSettled` | 02-44 T1 | `scripts/settle.test.ts`: "first settled: a probe that is settled at once is asked once and never sleeps", "retries until settled: ...", "exhausted attempts quote the last observation: ...", "a throwing probe is not retried: ...", "sleep between attempts only: ..." | n/a |
| `health` parity flake: the settled-snapshot case | 02-44 T1 | `scripts/parity.test.ts`: "health: identical JSON once both surfaces are settled, except the one clock field lastReconcileAt, which is masked by name and asserted to be a time" (12 of 12 in the file) | |
| `health` parity flake: 48-run stress | 02-44 T1 | 16 simultaneous copies of the `health` case | 02-44 recorded 11 of 48 failures before and 0 of 48 after (no product change; the only Reconcile triggers found were the legitimate start-up and attach ones in 64 instrumented runs). Re-run here: **16 of 16 pass** |
| Init quirk (a): header spellings create a duplicate table | 02-44 T2 | `src/cli/init.test.ts`: "header with a comment: [mcp_servers.gsd-atlas] # note is updated in place, no second table is appended, ...", "header with spaces: ...", "header with spaces around the dot: ...", "quoted key header: ...", "quoted key header (literal string): ..." | |
| Init quirk (b): comment above the next header removed | 02-44 T2 | `src/cli/init.test.ts`: "comment above the next header: the comment lines directly above a header, with no blank line, stay in place" | |
| Init quirk (c): user keys dropped | 02-44 T2 | `src/cli/init.test.ts`: "user keys are preserved: keys, comments, blank lines and sub-tables stay byte for byte and in order, only command and args change", "multi-line args replaced whole: ...", "url conflict is refused: ...", "inline table is refused: ...", "dotted keys are refused: ...", "crlf insertions: ..."; parser units in `src/cli/init-toml.test.ts` ("a multi-line array, inline table or string is one statement, ...") | |
| Init quirk (d): cache-directory store invisible to the hint, through the Host's `index_state` | 02-44 T3 | `src/host/index-state.test.ts`: "empty store: ...", "older schema: ...", "store.dir store is found: ...", "cache store is found: ...", "not a repository: not_a_repo", "writes nothing: no tenant, no lease, no watcher, and the repository, the cache and the user directory are byte for byte unchanged"; `src/cli/init.test.ts`: "indexed: when the Host says the repository has an index there is no hint, even if the git directory holds no gsd-atlas folder (a store in the cache directory)", "not indexed: the hint names the repository root the Host reported", "the linked worktree probe still decides when the Host cannot answer"; real binaries `scripts/cli-e2e.test.ts`: "init sees a store under store.dir: no hint after a build into GSD_ATLAS_STORE_DIR, and the hint exactly once before" | |
| Last `isInside` copies: lang | 02-44 T4 | `src/lang/module-files.test.ts`: "dot-dot directory name: a directory called ..assets inside the folder is a child, not a parent" | |
| Last `isInside` copies: corpus-gates | 02-44 T4 | `scripts/corpus-gates.test.ts`: "a work area beside the repository whose name shares the repository name as a prefix is not inside it (shared isInside)" | |
| Last `isInside` copies: recall | 02-44 T4 | `scripts/recall.test.ts`: "a temp root beside the repository whose name shares the repository name as a prefix is not inside it (shared isInside)" | |
| `Parser pool deadlines` amendment of `language-modules` | 02-44 T5 | `docs/adr/5-language-modules.md` line 92 `## Amendment 2026-10-17: Parser pool deadlines`, README amendment-log line 80; `scripts/adr.test.ts`: "amendments are appended and dated", "extra amendments match the recorded Task 1 selection", "the amendment log in the README lists every amendment" (39 of 39 in the file in 02-42/02-44; green in the full suite here) | |

## UAT file

`02-UAT.md` (committed `9c2a33b`): test 1 `result: pass` with the size-gate lines and plan ids; test 5 `result: pass` with the structural assertions and mutation check; `updated` and the Summary counts set (total 5, passed 2, pending 3). Tests 2, 3 and 4 are still `result: [pending]` and untouched; test 2 gained one note that the Cursor and Codex shapes were confirmed on 2026-10-17 in `.planning/research/MCP-HOST-CONFIGS.md` and applied by 02-35 and 02-44, while the real-install start check remains the human step. Items 3 (nightly.yml first remote run) and 4 (ADR editorial repairs) are human-only and stay open.

## Hygiene

- `git status --short` after all runs: only `02-UAT.md` modified (committed). `git diff --stat 374a62b...` was empty before the UAT commit, so no file outside the plan's list changed; after it the diff against the base is the UAT file and this SUMMARY only. `dist/` from `npm run build` is ignored.
- No scratch repository or store is left in `$TMPDIR` by these runs (the only matches there, `gsd-worktree-*` entries, belong to the orchestrator's worktree handling). Run logs went to the session scratchpad.
- `.planning/STATE.md` and `.planning/ROADMAP.md` were not touched, as instructed. No push was made.

## Deviations from Plan

None - the plan executed as written. Notes:

- The persisted per-plan commit ledger was not written (the worktree guard refuses git-dir writes, as in earlier gap-closure plans); `plan_head_before` is the fast-forward base `374a62b`, and `commits: 2` (the UAT commit `9c2a33b` and the SUMMARY commit) is counted from it.
- Per the orchestrator, the macOS SIGTRAP fix was added to the trace as an execution finding with its evidence (above); the plan text did not list it.
- STATE.md/ROADMAP.md updates and `requirements mark-complete` were not run (the orchestrator owns them).

## Known Stubs

None.

## Threat Flags

None. No code or runtime surface was touched; only the UAT file and this SUMMARY.

## Self-Check: PASSED

- 02-UAT.md and 02-43-SUMMARY.md exist; UAT verify command from the plan prints `ok pass pass`; tests 2, 3 and 4 read `[pending]`.
- Commit `9c2a33b` is an ancestor of HEAD.
- The finding table has 24 review-finding rows (WR-01 to WR-13, IN-01 to IN-11) plus the two verification-item rows and the SIGTRAP row, each with a passing test case or a deferral row; the follow-up table covers the parity flake (helper, settled case, stress), init quirks (a) to (d), the three `isInside` copies and the pool amendment.
