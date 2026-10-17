---
phase: 02-grammar-tier-store-and-stdio-host
plan: 35
subsystem: cli-init
tags: [init, host-config, lost-update, toml, cursor, codex, hint, gap-closure]
gap_closure: true
status: complete

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "gsd-atlas init and its three host targets (HST-04), the host config research note .planning/research/MCP-HOST-CONFIGS.md"
provides:
  - "writeUserFile compares the target with the digest (or absence) init read, before the backup and before the rename; a difference throws ConfigChangedError and init refuses the host with config_changed_during_init"
  - "tomlHeaderLines: a TOML-aware line scan (multi-line strings, array and inline-table depth, strings, comments) used by the Codex editor for every header decision"
  - "Cursor entry written with type stdio; init-targets.ts comment cites MCP-HOST-CONFIGS.md"
  - "Build hint that looks in the git common directory and no longer claims the repository has no index"
affects: [02-UAT real Cursor and Codex start check, phase 4 daemon host (nothing)]

actuals:
  tokens: 10200
  tasks: 3
  commits: 3
plan_head_before: 27ae4745b8b40d2ef56534198753f39e59ef3085
plan_head_after: 45b256cd199858bc4857540fdd81c894e68275ba

tech-stack:
  added: []
  patterns:
    - "Expected-state travel: the digest of the bytes read goes from the read to the write and is compared twice around the backup and temp file"
    - "Header decisions in a text edit come from one scan, never from a per-line prefix test"

key-files:
  created:
    - src/cli/init-toml.test.ts
  modified:
    - src/cli/init-files.ts
    - src/cli/init.ts
    - src/cli/init-targets.ts
    - src/cli/init.test.ts

key-decisions:
  - "A refusal at the second compare keeps the backup the call made (it is a copy of the file as init read it). Removing it was written first and failed under load: two racing inits, the loser creates the backup, the winner sees EEXIST, the loser refuses and deletes it, and no backup of the original remains. Keeping it is the safe side"
  - "tomlHeaderLines treats a line as a header only at bracket depth zero outside every string; header lines are consumed whole so their brackets never move the depth"
  - "ExpectedState is a required option of writeUserFile, so no caller can write without saying what it read"

requirements-completed: [HST-04]

duration: 40min
completed: 2026-10-17
---

# Phase 2 Plan 35: init lost-update guard, TOML-aware Codex editor, Cursor type, accurate hint

**`gsd-atlas init` now refuses to overwrite a host config that changed after it read it (content digest, compared twice), cuts Codex blocks only at real table headers, writes the Cursor `type: "stdio"` the docs list, and no longer claims a restart or a missing index.**

## Performance

- **Started:** 2026-10-17T17:33Z (approx.)
- **Completed:** 2026-10-17T18:13Z
- **Tasks:** 3
- **Files modified:** 5 (1 created)

## Accomplishments

- WR-12: `UserFile.digest` (sha256 of the raw bytes, BOM included) travels to `writeUserFile` as `expected` (`{ digest }` or `{ absent: true }`). `assertUnchanged` re-reads the target before the one-time backup and again after the temp file is written, immediately before the rename. On a difference the temp file is removed, nothing is renamed, and init reports `refused` with `config_changed_during_init: the file changed while init was running, so nothing was written; run init again` (exit 2). A first-compare refusal makes no backup. The residual window (last compare to rename) is stated in the module header. A dry run writes nothing and calls no hook.
- Coordinator item 2: `tomlHeaderLines` replaces the three `startsWith('[')` tests and the header search in `renderCodex`. A continuation line of a multi-line array, a line of a multi-line basic or literal string, and a string line equal to `[mcp_servers.gsd-atlas]` are no longer headers.
- Coordinator item 3: `CURSOR_ENTRY` is `{ type: "stdio", command, args }`; an entry written by an earlier init without `type` is `updated` and the backup keeps the original. The Codex entry has no `type` (asserted).
- Coordinator item 1: the stale "not checked against current host documentation (research assumption A3)" comment now cites `.planning/research/MCP-HOST-CONFIGS.md` (checked 2026-10-17) and names what stays unconfirmed: Windows paths of both files, unknown-key tolerance in Cursor, restart behaviour. 02-RESEARCH.md was not touched.
- Coordinator item 4: a test for `--agent claude`, `--agent cursor`, `--agent codex` and the default run pins that neither stderr nor stdout matches /restart|reload/i. Init never printed one; the test now keeps it that way.
- IN-04: `repoWithoutIndex` reads the worktree git directory's `commondir` file (relative or absolute, first line) and looks for `<common dir>/gsd-atlas`. The hint is `gsd-atlas: to index <repo>, run \`gsd-atlas build\` inside it`; `has no atlas index yet` is gone.

## Task Commits

1. **Task 1 (tracer): lost-update guard** - `1cf894e` (fix)
2. **Task 2: Codex block end** - `9e3282f` (fix)
3. **Task 3: Cursor type, citation, no-restart pin, hint** - `45b256c` (feat; also carries the follow-up to Task 1 described under Deviations)

## Failing-first evidence

Task 1, before any production change (6 of the new cases failed, 41 passed): `changed between read and write`, `changed after temp`, `new file raced`, `an existing file that the host deleted is not recreated by init`, `two inits racing: the second to reach its compare sees the first rename and refuses`, `a normal write still goes through with the hooks present, BOM kept` (hooks not yet called).

Task 2, before the fix (`init-toml.test.ts` failed to load: no `tomlHeaderLines` export; 6 Codex cases failed):

| Case | Red output |
|------|-----------|
| (a) `multi-line array in our table whose continuation lines start with [` | block cut at `  [1, 2],`: actual text kept the array tail after the new block |
| (b) `multi-line basic string in our table with a line [not a table]` | block cut at `[not a table]` |
| (c) `multi-line literal string in our table with a line [not a table]` | block cut at `[not a table]` |
| (d) `a string line equal to our header in another table is not our table` | the string line was taken as our header and the string was rewritten |
| (e) `a line that is just [ inside a multi-line array of another table is not refused` | `2 !== 0` (refused as an unclosed header) |
| CRLF block with a multi-line array | block cut inside the array |

Task 3, before the change: the hint cases, four `linked worktree hint` cases, and the three Cursor cases (`CURSOR_ENTRY` now has `type`) failed; the no-restart and Codex-no-type cases pin existing behaviour and passed from the start.

## Mutation check (acceptance criterion)

Replacing the second `assertUnchanged` call (before the rename) with a comment made exactly one test fail: `changed after temp`. Restored; all 47 init tests pass.

## Verification

- `node --test src/cli/init.test.ts src/cli/init-toml.test.ts src/cli/cli.test.ts scripts/cli-e2e.test.ts`: 116 tests, 0 failures.
- `npm run typecheck` and `npm run lint`: exit 0.
- `git grep -c MCP-HOST-CONFIGS -- src` gives `src/cli/init-targets.ts:1`.
- Whole suite `npm test`: 2279 tests; the one non-init failure was `src/indexer/parcel-source.test.ts` while the machine was under load (it passes alone, 18/18); it touches no file of this plan (see Deferred).
- Stress: 12 copies of `init.test.ts` run in parallel, 0 failures (this is how the backup-removal bug below was found, from a single full-suite run).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Backup removal on a second-compare refusal lost the original under a race**
- **Found during:** full-suite run after Task 3 (`concurrent inits` failed once under load)
- **Issue:** I had `writeUserFile` remove a backup it created when the second compare refused (to match the plan's "no backup" wording). With two racing inits the loser can be the one that created the backup; the winner then sees `EEXIST`, so deleting it leaves no backup of the original at all.
- **Fix:** the backup is kept on a second-compare refusal. It is a copy of the file as init read it (the first compare ran just before the copy). A first-compare refusal still makes no backup. The `changed after temp` test now asserts the temp file is gone, the host bytes stay, and the backup holds the original bytes.
- **Files modified:** src/cli/init-files.ts, src/cli/init.test.ts
- **Commit:** 45b256c

Otherwise the plan was executed as written. The plan's wording "same outcome" for `changed after temp` included "no backup"; that one point differs, for the reason above.

## Known Stubs

None.

## Threat Flags

None. The only new surface is the two TEST ONLY optional hooks on `InitEnvironment` (`beforeWrite`, `afterTemp`); the bin does not set them, and they run no program.

## For the owner (flagged, not changed)

- **Keys a user added inside `[mcp_servers.gsd-atlas]`** (for example `startup_timeout_sec`) are dropped when init re-runs. Existing, tested behaviour, outside the review and the coordinator's list (as the plan flagged).
- **A header spelled `[mcp_servers.gsd-atlas] # note` or `[ mcp_servers.gsd-atlas ]`** is not recognised as our table (the search is still trimmed equality with `[mcp_servers.gsd-atlas]`), so init would append a second, duplicate table. Only the quoted-key spelling is refused. Pre-existing; `tomlHeaderLines` now makes it easy to fix (header lines are known), but the plan did not ask for it.
- **Comment lines directly before the next header** (after our block, with no blank line between) are part of the replaced block and are removed. Pre-existing.
- **IN-04 residual:** a store kept in the cache directory is invisible to init, so the neutral build hint is printed even for an indexed repository (it no longer says otherwise). Unmitigated by design (the cli adapter may not import the Fact Store).
- **Not done (human item):** no test starts a real Cursor or Codex; that stays in 02-UAT.md.
- `.codegraph/` was created in the worktree by `codegraph init -y` (needed to read indexed files through the CodeGraph guard); it is untracked and was never staged.

## Deferred Issues

- `src/indexer/parcel-source.test.ts` failed once during the full run under CPU load and passes alone; not caused by this plan (no indexer file changed). Not investigated further.

## Self-Check: PASSED

- FOUND: src/cli/init-toml.test.ts, src/cli/init-files.ts, src/cli/init.ts, src/cli/init-targets.ts, src/cli/init.test.ts
- FOUND commits: 1cf894e, 9e3282f, 45b256c (all ancestors of HEAD; `git rev-list --count 27ae474..HEAD` is 3)
