---
phase: 03-typescript-module-and-mvp-eval
plan: 21
subsystem: diagnostics
tags: [diagnostics, consent, privacy, catalog, cli, host, skl-03]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-01 the diagnostics ADR text (left as a draft by the user), 03-12 the diagnostics module boundary in the lint config, 03-17 the flight recorder and ratings that the collectors and `disable` read"
provides:
  - "diagnostics/catalog.v1.json: catalog version 1, ten data types with fields, examples, how-it-helps and cannot-reveal text (shipped in the package)"
  - "src/diagnostics: strict catalog schema, per-type versioned consent (loadConsent, saveConsent, reapprovalNeeded), fixed buckets, scrubNote, collectType for all ten types, deterministic renderReport, local saved reports"
  - "Host request kind `diagnostics` with actions status, types, set, preview, save, disable, history; refused for an MCP-origin Host"
  - "gsd-atlas diagnostics enable|types|preview [--note] [--rating] [--feature] [--save]|disable|history"
  - "HostOptions.stateDir (set only by the composition root) and defaultStateDir"
affects: [03-32, 03-35]
requirements-completed: [SKL-03]
status: complete
# commits is measured from plan_head_before to plan_head_after; it excludes this SUMMARY's own commit.
commits: 3
plan_head_before: a4a757a43f20c882ad3c398b4fac2b1c0df242df
plan_head_after: d2a537d
actuals:
  tokens: 57600
  tasks: 3
  commits: 3
metrics:
  completed: 2026-10-18
key-decisions:
  - "The ADR precondition was waived by the user: the user-controlled-diagnostics ADR stays an unratified draft (status Proposed); nothing in the code or docs of this plan says it is ratified or Accepted."
  - "Consent is the user's file only: `<userDir>/diagnostics.json`, read by a loader whose only inputs are that folder and the shipped catalog. A repository file, an environment variable or an MCP request cannot enable a type."
  - "A type is on only while its saved field list equals the catalog's current list; a changed type reverts to denied and is listed for review, a type the saved file does not mention is denied."
  - "Values the machine cannot supply are `null` and are listed under `No data yet` in the report body; nothing is invented."
---

# Phase 3 Plan 21: User-controlled diagnostics up to a reviewed, local report Summary

**Diagnostics are off by default; `gsd-atlas diagnostics enable` walks through the ten data types of catalog v1 with the real values from the machine, the choices are versioned and saved in the user's folder only, `preview` renders the exact report byte for byte from approved types, and `--save` keeps it on this machine. Nothing is submitted and no network call exists.**

## Precondition waiver (user decision)

Plan 03-21 carried the precondition "docs/adr has an Accepted user-controlled-diagnostics ADR (ratified by plan 03-01)". It was not met: on 2026-10-18 the user decided that nothing is ratified before the MVP is done (see 03-01-SUMMARY.md and "Diagnostics ADR ratification" in 03-DECISIONS.md), so `docs/adr/draft-user-controlled-diagnostics.md` is a draft with status Proposed. The orchestrator surfaced this and asked. The user's reply, recorded as given: `1`, meaning: run 03-21 with the ADR left as a draft, the precondition waived and noted in this SUMMARY.

What that means in practice: the plan was implemented against the draft ADR's text (decisions 1 to 8 and `docs/DIAGNOSTICS.md` sections 1 to 5, 7 and 8). The ADR was not ratified, renamed, edited or given an issue. Code comments and docs here call it "the draft user-controlled-diagnostics ADR". SKL-03 is implemented but, as 03-01 already noted, ROADMAP row 3 ("ADR ratified before Phase 3 diagnostics code") is not satisfied by design.

## What was built

1. **Task 1 (tracer, `9b133e3`)**: `diagnostics/catalog.v1.json` (all ten types, text from DIAGNOSTICS.md section 3), the strict catalog schema, the consent file (validated whole, bounded read of 64 KiB, ignored whole with one warning when wrong, written through a temporary file with mode 0600, never overwritten when it fails validation), `renderReport`, the Host kind `diagnostics` (`status`, `preview`) and `gsd-atlas diagnostics preview`. The tracer gate ran: the verify command was re-run end to end and passed before Tasks 2 and 3 started.
2. **Task 2 (`edcfcc8`)**: the fixed bucket edge lists, `scrubNote`, `collectType` for every type, note and rating handling in `renderReport`, and the Host assembling platform facts, the module registry (built-in modules only, read from the user's roots, never the repository) and the repository facts (index gauges, metrics report, flight-recorder outcome codes). The privacy fixture (acceptance test 4) indexes a repository whose file names, symbols, doc comments, branch, remote, commit message and committed config carry five markers and asserts none reaches the title, labels, body or JSON.
3. **Task 3 (`d2a537d`)**: Host actions `set`, `save`, `disable`, `history`; the `enable` and `types` walkthroughs; `preview --note --rating --feature --save`; saved reports under `<state dir>/diagnostics/reports` (0600, never overwritten); the `stateDir` option and its default from the environment; packaging (`files` gains `diagnostics`, the tarball test checks the catalog is the only file under it and that the installed bin finds it).

## Acceptance tests (DIAGNOSTICS.md section 8)

| # | Test | Where |
|---|------|-------|
| 1 | A fresh install writes nothing: find, build, status, health and `diagnostics preview` create no `diagnostics.json` and no state folder | `src/host/diagnostics.test.ts` (fresh install writes nothing), `src/cli/diagnostics.test.ts` (same title) |
| 2 | Header only gives a report with exactly `atlas_version` and `catalog_version`; only `diagnostics.json` exists after enabling | `src/diagnostics/diagnostics.test.ts` (header only report, nothing written by preview), `src/cli/diagnostics.test.ts` |
| 3 | A catalog v2 fixture with a changed type and a new type: the changed type is denied until re-approved, the new type is absent until approved | `src/diagnostics/diagnostics.test.ts` (catalog v2 reverts changed type, new type absent until approved) |
| 4 | The privacy fixture contains none of the five markers, the note included after scrubbing | `src/diagnostics/diagnostics.test.ts` (privacy fixture contains no marker) |
| 5 | A committed config naming `diagnostics.enabled`, `autoSubmit` and `permissions` has no effect, and a read-recording file system shows no repository path was opened | `src/host/diagnostics.test.ts`, `src/cli/diagnostics.test.ts` (committed config has no effect) |

Test 6 (the intake bot) is Phase 4. A test also replaces `fetch`, `node:http`, `node:https` and `node:net` with throwing stubs and runs every sub-command (`no network`).

## Test results

- `npm test`: 3516 tests, 3515 pass, 0 fail, 1 skipped (the same skip as before this plan). The plan added about 136 tests across `src/diagnostics/diagnostics.test.ts` (60), `src/diagnostics/reports.test.ts` (7), `src/host/diagnostics.test.ts` (35) and `src/cli/diagnostics.test.ts` (34), plus assertions in `scripts/package.test.ts`.
- `npm run typecheck`, `npm run lint` and `npm run build` pass. The boundary test is unchanged: `MODULES.length` is still 22, and `eslint.config.js` was not touched (the `diagnostics` module block from plan 03-12 already covers every new file).
- The tarball test ran against the registry as it always does and passed, including the new installed-bin check.

## Deviations from Plan

### User-decided waiver

**1. [User decision] ADR precondition waived** (see above). No code or doc deviates from the draft ADR's text.

### Auto-fixed Issues

**2. [Rule 3 - Blocking] An existing test forbade `--note` anywhere in the usage text**
- **Found during:** Task 1 (`src/cli/rate.test.ts`, plan 03-17)
- **Issue:** `rate` has no note, and its test asserted the whole usage text never contains `--note`. `diagnostics preview --note` (required by this plan) makes that assertion false.
- **Fix:** the assertion now looks at the `rate` usage line only, which is what it was protecting.
- **Files modified:** `src/cli/rate.test.ts`
- **Commit:** 9b133e3

**3. [Rule 3 - Blocking] Files outside the plan's list were needed**
- `src/cli/diagnostics.ts` (new): the sub-commands need their own file (like `allow.ts`); the plan's list only names `tool-commands.ts` and `index.ts`.
- `src/bin/compose.ts` (two lines): the plan says `stateDir` is "set only by the composition root", but the root was not on the list. Without it `--save` would answer `state_dir_unavailable` in the real bin.
- New files in `src/diagnostics/` (`bucket.ts`, `io.ts`, `reports.ts`, `reports.test.ts`) and `src/host/diagnostics.test.ts`: the plan lists `scrub.ts`, `collect.ts` and `preview.ts` but the bucket functions it names, the file-system seam acceptance test 5 needs and the saved-report store had to live somewhere in the module.
- **Commits:** 9b133e3, edcfcc8, d2a537d

**4. [Rule 1 - Bug] The first design nested two Governor slots**
- **Found during:** final review of Task 3
- **Issue:** the `diagnostics` kind ran inside one Governor slot and, when a report needed repository facts, asked for a second slot inside it. Under load that could starve.
- **Fix:** the kind is not wrapped in an outer slot; the repository part takes the repository's slot itself, the rest is a few small reads and writes in the user's own folders.
- **Commit:** d2a537d

### Data the plan names but the code base cannot supply yet (reported as `null`, listed under "No data yet")

These are not stubs that hide a missing wire in this plan: the source does not exist in Phases 1 to 3, and the plan's own edge case says "never invents numbers".

- `agent_behavior` (`gate_stats`, `atlas_vs_grep`): no hooks yet (as the plan says).
- `crash_signature`: nothing captures a crash.
- `hook_latency`, `budget_breaches`: no hook latency and no budget evaluation exist.
- `build_time_bucket`: no build duration is recorded.
- `repo_count_bucket`, `repo_size_bucket` (lines of code), `agent_concurrency_bucket`: a one-shot CLI process knows none of them; only `worktree_count_bucket` is real.
- **Plan said** "p50 and p95 per tool from the metrics histograms" and "`parse_error_rate` per module". **What the code base has:** the Metrics report merges the tools into one latency histogram and the index-health gauges are for the whole index. So both are reported under one key, `all` (`query_latency: {all: {p50_ms, p95_ms}}`, `parse_error_rate: {all: 0.004}`), as bucket upper bounds and a three-decimal rate.
- **Plan said** "`ratings` gives entries from the ratings table". The Metrics module has no reader for its `ratings` table and `src/metrics` is outside this plan's files. The collector accepts stored ratings (tested), but the Host supplies only the rating the person gives with `--rating`. Reading the table is a small follow-up in `src/metrics`.
- `error_codes` come from the outcome codes in the flight recorder (the first diagnostic code of each refused answer), filtered to the code shape; there is no separate error counter.

### Constants not in 03-CONSTANTS.md (planner-style values, for the user to confirm)

The bucket edge lists (counts 1/2/6/21 and 1/2/6/21/51/201, bytes 1 MB to 5 GB, milliseconds 1 s to 15 min, lines 1K to 5M) are read off the examples in the catalog and extended in the same style; the note cap is 500 characters (the plan says 500); the consent file cap is 64 KiB (the same bound as `config.json`); the metrics window of a report is 30 days (the metrics retention); the catalog file cap is 256 KiB; `history` lists at most 200 reports; the scan of a note reads at most 20,000 characters; a list in a report holds at most 20 entries. None of these is a security limit that was loosened.

## TDD Gate Compliance

`tdd_mode` is on and the three tasks are marked `tdd="true"`. In each task the tests were written before the code they test. RED was actually observed only for Task 1, where the test file failed to load (module not found). For Tasks 2 and 3 the test files were written first but were not run until the implementation was in place, so no RED run exists for them. The tests were committed with the implementation, one `feat(03-21)` commit per task, as the plan's commit instructions say and as plan 03-17 did; there is no separate `test(03-21)` RED commit, and the Task 1 load failure is not the assertion failure `gsd_run check tdd-red-evidence` would accept as RED. The plan's type is `execute`, not `tdd`. Treat the gate as not strictly met for this plan.

## Authentication Gates

None.

## Known Stubs

None in the sense of unfinished wiring. The fields listed under "Data the plan names but the code base cannot supply yet" are `null` by design and are labelled "No data yet" in every report that includes them. The broken-windows ledger (`.planning/WINDOWS.md`) was not touched, because the other plans of this wave may append to it and the orchestrator owns the tracking files; the list above is the record.

## Threat Flags

None new beyond the plan's register. Notes for the verifier:

- T-03-211 (identifying data in a report): mitigated and tested by the privacy fixture; modules are named only when built in, OS and agent host come from closed lists, counts and sizes are bucketed, the note is scrubbed before the cut and again at render time.
- T-03-212 (a repository enabling diagnostics): mitigated; the read-recording test shows no repository path is opened by the diagnostics module, and the Host's module scan for a report uses a root that is never a repository.
- T-03-213 (corrupting the consent file): mitigated as planned; the unit tests cover the temporary file, mode 0600, the size cap and refusing to overwrite an invalid file.
- T-03-214 (collecting an unapproved type): mitigated; `renderReport` includes approved types at the current field list only, and the Host gathers repository facts only when an approved type needs them.
- T-03-215 (network): no code path; tested with throwing stubs.
- A report that needs index facts opens the repository's Tenant if the repository already has an index (the same as `gsd-atlas status`); it never creates a store.

## Self-Check: PASSED

- `diagnostics/catalog.v1.json`, `src/diagnostics/{catalog,collect,consent,bucket,scrub,preview,io,reports,index}.ts`, `src/host/diagnostics.ts`, `src/cli/diagnostics.ts` and their tests exist.
- Commits 9b133e3, edcfcc8 and d2a537d are ancestors of HEAD.
- `docs/adr/draft-user-controlled-diagnostics.md` is unchanged and `docs/adr/15-user-controlled-diagnostics.md` does not exist.
