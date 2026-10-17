# Phase 2 gap-closure plans 02-29 to 02-43: index, dispositions, source audit

Sources: 02-VERIFICATION.md (criterion 4 / STO-05, human item 5), 02-REVIEW.md (WR-01..WR-13, IN-01..IN-11), the user's decisions of this planning request, the coordinator's addendum on `src/cli/init*` (`.planning/research/MCP-HOST-CONFIGS.md`). There is no REVIEWS.md; every plan's Review Dispositions Ledger uses `Round 1 - ece310d` (the commit that wrote 02-REVIEW.md).

## Plans

| Plan | Wave | Depends on | Files (summary) | Requirements | Fixes |
|------|------|------------|-----------------|--------------|-------|
| 02-29 | 1 | - | 02-CONSTANTS.md | LNG-07, HST-02, STO-05 | Constants addendum + blocking human approval (3 new keys, 2 recorded thresholds, VACUUM pause exception). `autonomous: false` |
| 02-30 | 1 | - | fact-store lifecycle, maintain, store, types, index, recovery + tests | STO-05, STO-10, STO-08 | STO-05 store side (`maintain(budget, IDLE_MAINTENANCE)`, second-chance threshold), WR-04, WR-05a, IN-01, IN-08 (partial), `StoreStatus.leaseHolder` |
| 02-31 | 1 | - | fact-store open.ts + new test | STO-06, STO-08 | WR-03 |
| 02-32 | 1 | - | facts/file-facts.ts, fact-store writer.ts, schema.ts + tests | LNG-04, STO-05 | WR-05b, IN-02 |
| 02-33 | 1 | - | command-runner decide.ts, env.ts + tests | STO-09, LNG-05 | WR-11, IN-05 (partial) |
| 02-34 | 1 | - | indexer.ts, governor types, facts/inside.ts, indexer paths + git-dir, scripts/corpus-fetch.ts | STO-08, IDX-03, HST-03, STO-09 | WR-13, IN-11, IN-03 (helper + indexer/script copies) |
| 02-35 | 1 | - | cli init.ts, init-files.ts, init-targets.ts + tests | HST-04 | WR-12, IN-04, coordinator items 1-4 (research comment, Codex TOML block end, Cursor `type: "stdio"`, no restart claim) |
| 02-36 | 1 | - | bin shutdown.ts, cli-main.ts, both bins + tests | HST-01, STO-06, QRY-04 | IN-07, IN-09 |
| 02-37 | 2 | 02-30 | scripts/size-gate.ts + test | STO-05, STO-10 | Gate asserts idle-only `idleRatio` <= 1.25 (no final explicit compaction in the assertion) |
| 02-38 | 2 | 02-33, 02-34 | source-tree real/types/fake/contract/identity/read-text, command-runner git-spec | LNG-05, STO-09, STO-07, HST-03 | WR-06, WR-07, WR-08, IN-03 (read-text) |
| 02-39 | 2 | 02-29 | grammar-engine/pool/pool.ts + fixtures | LNG-07 | WR-09, IN-06 |
| 02-40 | 2 | 02-30 | tenant create.ts, messages.ts, index.ts + tests | STO-05, STO-10, STO-08, QRY-04, HST-02 | STO-05 Tenant wiring, WR-02 messages, IN-10, StoreClosed mapping |
| 02-41 | 3 | 02-29, 02-34, 02-40 | fact-store location.ts, host host/route/history/defaults/idle-registry + tests, scripts/read-only-flow.test.ts | HST-02, QRY-06, STO-07, STO-08, STO-09, QRY-04 | WR-01, WR-02 (no-store half), WR-10, IN-03 (route, history) |
| 02-42 | 4 | 02-30, 02-33, 02-38, 02-40, 02-41 | docs/adr 4, 7, 9, 11, 13, README, DESIGN.md, scripts/adr.test.ts | FND-12, STO-05, QRY-06, STO-09 | Five dated ADR amendments for every changed ratified contract |
| 02-43 | 5 | all | 02-UAT.md | STO-05, STO-10, STO-06, STO-08, HST-02, QRY-04, FND-12 | Full gate set (typecheck, lint, npm test, size gate idleRatio on both drivers, schema:check, grammar:verify, build), STO-05 re-verification, 24-finding trace, UAT items 1 and 5 |

Same-wave plans have no file overlap (checked by script). Plans 02-39 and 02-41 wait for the human approval in 02-29.

## Decisions taken in the plans (the user asked for these to be chosen and documented)

- **STO-05**: the idle loop passes `IDLE_MAINTENANCE` (`{ full: true }`) to `store.maintain` (and to `compact` in the WriterBusy fallback). The compact step vacuums only after a completed collect and only past the existing thresholds (free pages above 25 percent, or in-page empty space above one third), evaluated again after the free pages are returned so one call converges. The size gate runs the same constant, asserts the idle-only ratio, and fails on the old policy (mutation case). The full VACUUM is an unsliced pause: recorded as an exception to `maintenance.sliceMs` in 02-CONSTANTS.md (02-29), ADR 11 (02-42) and reported by the gate (`vacuums`, `longestMaintainMs`).
- **WR-01**: only `build` may create a store. Every other repo-scoped request needs an open tenant or an existing `facts.db` found by the same location rules (`decideStoreLocation` without mkdir, `findExistingStore`), else `not_indexed` from the Host with nothing opened. This includes `atlas_status`, `maintain` and `status`, which used to open a tenant on an unbuilt repository (an observable ADR 13 / QRY-03 change, amended in 02-42; the alternative of an ok-but-empty `atlas_status` was rejected).
- **WR-02**: with WR-01 an unbuilt repository never gets a lease, so the recommended `gsd-atlas build` works while the MCP server runs (real-process test in 02-41). Where a lease is held (store exists, worktree unbuilt, or a second `build`), `lease_held` and `not_indexed` name the holder's pid and version (new additive `StoreStatus.leaseHolder`) and say to stop that process first. CLI and MCP render the same envelope. Handing a CLI build to the leader is Phase 4 (D-01).
- **New constants** (need the 02-29 approval): `pool.loadTimeoutMs` 30000, `pool.terminateGraceMs` 2000 (the parse cut-off stays the approved 5000; the pool deadline becomes 7000), `host.idleEvictMs` 1800000. Existing thresholds recorded: `compact.fullFreeFraction` 0.25, `compact.fullUnusedFraction` 1/3. No approved value changes. WR-07 reuses the approved `git.timeoutMs`.
- **Rejected review suggestions, with reasons**: the `meta` sentinel for the rowid reset (a WITHOUT ROWID table does not move last-insert rowid; a random NUL-prefixed sentinel in `names` is used); "open the replacement first" for WR-03 (Windows cannot move an open database file; restore-or-close is used); a runner-level default timeout for WR-07 (the 60 s default is the value Phase 1 held back; per-spec timeouts plus a structural test are used); `--all` roots for WR-06 (walks every ref per request).

## Disposition of every review finding

| Finding | Disposition | Plan |
|---------|-------------|------|
| WR-01 read-only call creates files and takes a lease | Addressed | 02-41 T1 (+ ADR 02-42) |
| WR-02 not_indexed message leads to a failing build | Addressed; leader-routed CLI build deferred to Phase 4 (dependency) | 02-30 T3, 02-40 T2, 02-41 T1 |
| WR-03 failed takeover or rebuild leaves closed handles | Addressed | 02-31 |
| WR-04 blocking TRUNCATE checkpoint | Addressed | 02-30 T2 |
| WR-05 rowid reset collides with empty name; no name validation | Addressed (two halves) | 02-30 T2, 02-32 T1 |
| WR-06 store identity depends on root print order | Addressed (smallest root; id still changes with the root set, persisted id is Phase 4) | 02-38 T3 |
| WR-07 git calls without timeout | Addressed; runner default and Governor admission of the probe deferred with reasons | 02-38 T1 |
| WR-08 blobs buffered before the cap | Addressed | 02-38 T2 |
| WR-09 grammar load has no deadline | Addressed (constant via 02-29) | 02-39 T1 |
| WR-10 tenants and history hosts never freed | Addressed (constant via 02-29) | 02-41 T2 |
| WR-11 exact-token option denylist | Addressed (allowlist) | 02-33 T1 |
| WR-12 unguarded read-modify-write in init | Addressed (content digest) | 02-35 T1 |
| WR-13 Indexer.stop can leak the writer slot | Addressed | 02-34 T1 |
| IN-01 wall-clock slice assertion | Addressed (structural) | 02-30 T2 |
| IN-02 dead `collected` state | Addressed (removed) | 02-32 T2 |
| IN-03 six `isInside` copies, `..name` bug | Addressed in four plans | 02-34 T2, 02-38 T3, 02-41 T3 |
| IN-04 wrong init hint location | Addressed | 02-35 T3 |
| IN-05 environment denylist | Partial: denylist extended; allowlist deferred (executables not yet defined, Windows git needs a broader set) | 02-33 T2 |
| IN-06 pool deadline equals parse deadline | Addressed (cut-off 5000, deadline 7000) | 02-39 T2 |
| IN-07 no signal handlers | Addressed | 02-36 T1, T2 |
| IN-08 mutable test hooks | Partial: reset helpers + afterEach; injection through deps deferred (no leak found, seams used across three files) | 02-30 T3 |
| IN-09 CLI composes Host before parsing | Addressed | 02-36 T2 |
| IN-10 createTenant leaks store and lease | Addressed | 02-40 T2 |
| IN-11 Governor frees slot on timeout | Addressed by documenting and pinning the contract; keep-slot option rejected (starvation) | 02-34 T3 |
| STO-05 idle-only 1.396x (VERIFICATION human item 1) | Addressed | 02-30, 02-37, 02-40, 02-43 |
| Flaky wall-clock test (VERIFICATION human item 5) | Addressed (= IN-01) | 02-30 T2 |

Not touched, as instructed: real Cursor/Codex start check (human item 2; shapes confirmed by research and applied in 02-35), `nightly.yml` first remote run (item 3), ADR editorial repairs (item 4).

## Multi-source coverage audit

| Source | Item | Covered by |
|--------|------|------------|
| GOAL | Criterion 4: store tends itself, <= 1.25x after 20,000 edits | 02-30, 02-37, 02-40, 02-43 |
| GOAL | Criterion 5: CLI and MCP identical JSON | 02-40 (shared messages), 02-41 (flow), unchanged parity tests in 02-43 |
| GOAL | Criteria 1, 2, 3, 6 | regression only: 02-43 runs the full suite and gates |
| REQ | STO-05, STO-10, STO-06, STO-08, STO-07, STO-09 | 02-30, 02-31, 02-37, 02-38, 02-40, 02-41 |
| REQ | HST-01, HST-02, HST-03, HST-04, QRY-04, QRY-06, LNG-04, LNG-05, LNG-07, IDX-03, FND-12 | 02-36, 02-41, 02-34, 02-35, 02-40, 02-32, 02-38, 02-39, 02-42 |
| RESEARCH | MCP-HOST-CONFIGS.md: comment, Codex block end, Cursor type, restart | 02-35 |
| RESEARCH | Package legitimacy | no package installed by any plan (T-02-SC accept in each) |
| CONTEXT | D-01 first opener leads | 02-41 (unbuilt repo never leads), 02-40 messages |
| CONTEXT | D-11 not_indexed names the command, no auto-build | 02-40, 02-41 (no auto-build introduced) |
| CONTEXT | D-14 crash detection and rebuild | 02-31 |
| CONTEXT | D-16 GC and 1.25x gate | 02-30, 02-37 |
| CONTEXT | D-18/D-19 ADR amendments | 02-42 |
| CONTEXT deferred ideas | socket Host, leader messaging, auto-build on first query | not planned (WR-02's CLI-to-leader routing recorded as a Phase 4 deferral) |

## Points to confirm when executing

- Existing tests whose expectation changes (each is listed in the owning SUMMARY): `src/host/host.test.ts` (pre-build `atlas_status`), `src/host/recording.test.ts` (pre-build answer counted), tests that pin the old `lease_held` and `not_indexed` texts, `src/cli/init.test.ts` (`CURSOR_ENTRY`, the hint cases), `scripts/size-gate.test.ts`.
- `dbstat` must be present on `better-sqlite3`'s bundled SQLite for the idle-only ratio to hold on that driver (02-37 records the measurement and returns a checkpoint if not).
- 02-35 leaves one existing behaviour as is and flags it: re-running init drops extra keys a user added inside `[mcp_servers.gsd-atlas]`.
- Three-OS evidence for the new idle ratio comes from the next hosted CI run of the unchanged `node scripts/size-gate.ts` step; 02-43 records local figures only.
