---
phase: 02-grammar-tier-store-and-stdio-host
plan: 44
subsystem: cli-init-host-tests-adr
tags: [parity-flake, codex-init, index-state, is-inside, adr-amendment, gap-closure]
requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "02-34 shared isInside, 02-35 init, 02-39 pool deadlines, 02-41 read gate, 02-42 amendment log"
provides:
  - "The health parity case compares two settled snapshots; flake rate 11 of 48 (unfixed) to 0 of 48"
  - "A Codex editor that recognises every spelling of the gsd-atlas table and manages only command and args"
  - "An internal index_state request answered by the read gate's own predicate; the init hint uses it"
  - "One containment helper (isInside) in lang, the gate scripts, the test kit and query"
  - "Amendment 2026-10-17: Parser pool deadlines in the language-modules ADR"
affects: [init, host, parity-gate, adr]
tech-stack:
  added: []
  patterns: ["settle-then-compare for two-process snapshot tests", "managed-statement-only text edit of a user TOML file", "one predicate (hasIndex) shared by the read gate and an internal state request"]
key-files:
  created:
    - scripts/test-helpers/settle.ts
    - scripts/settle.test.ts
    - src/host/index-state.test.ts
  modified:
    - scripts/parity.test.ts
    - src/cli/init-targets.ts
    - src/cli/init-toml.test.ts
    - src/cli/init.ts
    - src/cli/index.ts
    - src/cli/init.test.ts
    - src/host/route.ts
    - src/host/host.ts
    - src/host/index.ts
    - src/host-client/index.ts
    - scripts/cli-e2e.test.ts
    - src/lang/module-files.ts
    - src/lang/module-files.test.ts
    - scripts/corpus-gates.ts
    - scripts/corpus-gates.test.ts
    - scripts/recall.ts
    - scripts/recall.test.ts
    - scripts/freshness-gate.ts
    - scripts/corpus-fetch.test.ts
    - src/test-kit/git-repo.ts
    - src/query/ranking.ts
    - docs/adr/5-language-modules.md
    - docs/adr/README.md
    - scripts/adr.test.ts
key-decisions:
  - "Task 1: the settle step alone is the fix. No Reconcile trigger other than the start-up one was found in 64 instrumented runs, so no product change was made."
  - "Task 2: PRESERVE. Only the command and args statements of the gsd-atlas Codex table are managed; a url key, a managed key written twice or dotted, and every unsafe way of defining the table are refused with the line and 'edit it by hand'."
  - "Task 3: index_state is a REPO_KINDS entry with a strict selection-only schema; hasIndex() in host.ts is the one predicate of the read gate and of index_state."
  - "Task 5: the pool deadlines are amended into 5-language-modules (decision 3, the Grammar Engine), not tenant-composition."
requirements-completed: [QRY-04, HST-04, HST-02, STO-07, LNG-07, FND-12]
status: complete
commits: 5
plan_head_before: 585ea1fd3beabcef39e86ecfb16b998cd67e7246
plan_head_after: 27ac948147a772797e712aa150e4779b8eb0cc51
actuals:
  tokens: 18000
  tasks: 5
  commits: 5
---

# Phase 2 Plan 44: Parity flake, Codex init quirks, index_state hint, isInside copies and the pool ADR amendment Summary

The `health` parity case now waits for both surfaces to report a settled product before it compares them strictly, `init` edits only the `command` and `args` of the gsd-atlas Codex table in whatever spelling the user wrote it, the `gsd-atlas build` hint asks the Host (which applies the shared store-location rules) instead of looking beside the git directory, the last private containment copies are gone, and the parser pool's deadlines have their dated amendment.

## What was built

### Task 1 (tracer) - the health parity case, commit 1cf4097

**Before (red evidence).** `node --test --test-name-pattern=health scripts/parity.test.ts`, 16 copies started at once on this development machine (18 cores, load average above 100 from other agents): 3 rounds of 16 gave 1, 10 and 0 failures, 11 of 48. Two further rounds of 40 gave 29 and 0 failures. (My first counting script grepped for a TAP line the spec reporter does not print and reported 0; the numbers above were recounted from the logs by `AssertionError` and are the real ones.)

**Which trigger started each Reconcile.** Temporary instrumentation (not committed) logged the caller of every `requestReconcile` in 64 runs (192 Reconciles): every one was a start-up Reconcile (`Indexer.start`, 119 plus 9 via a nested async frame) or an `attach` (64, the MCP server). None came from a `head` event, a watcher problem, the idle timer or `syncNow`; `trailing` was never true. The failing runs are therefore the honest D-02 path: a process answered while its start-up Reconcile was still in flight, or before it had ever finished. To prove the mechanism, a temporary random 2.5 s delay of the start-up Reconcile (also not committed) reproduced both signatures exactly: (a) one surface `reconciling` true, `health` degraded, `reasons` [reconciling] against `false`, ok, none on the other; (b) `lastReconcileAt` null on both. All instrumentation was reverted (`git checkout`) before the commit.

**Decision.** Every trigger is legitimate, so the settle step alone is the fix and `src/indexer/indexer.ts` and `indexer.test.ts` are untouched.

**The fix.** `scripts/test-helpers/settle.ts` exports `untilSettled(probe, isSettled, { attempts, delayMs, sleep })`. `scripts/settle.test.ts` (written first, red on the missing module) covers `first settled`, `retries until settled`, `exhausted attempts quote the last observation`, `a throwing probe is not retried` and `sleep between attempts only`, all with an injected sleep. The health case asks the CLI (`health`, a fresh process per attempt) and then the MCP server (`atlas_status` poll) until `health` is `ok`, `reconciling` false, `queued` 0, `running` 0 and `lastReconcileAt` a number (40 attempts, 250 ms apart; never settling fails with the last observation). The comparison is then the same strict string equality; only `lastReconcileAt` is masked, still by name and asserted numeric, and `governor.running` is compared unmasked. The file header comment says so.

**After.** The same stress run, 3 rounds of 16: 0 of 48 failures. One round of 40: 0 of 40.

**Other tests that compare two status snapshots.** `grep -n "reconciling\|atlas_status\|'health'" scripts/*.test.ts` (other than parity): `product-e2e.test.ts` has its own settle poll (`untilSettled`, a local helper over `pollFor`) before the freshness case and compares `find` answers, not status snapshots; `cli-e2e.test.ts` and `read-only-flow.test.ts` assert fields of one snapshot, not two. No other test needed the pattern.

### Task 2 - the Codex editor, commit 6d21aaa

Red first: 28 of the new and changed cases failed before the code (the four spelling cases among them: `header with a comment`, `header with spaces`, `header with spaces around the dot`, `quoted key header`; plus `tomlHeaderKey` and `tomlStatements` failed to import).

- `tomlHeaderKey(line)` parses a header's key path (spaces around dots, bare, basic and literal quoted parts, escapes decoded, trailing comment, `[[array]]` flagged) and `tomlStatements(lines, from, to)` returns the key statements of a table body with their full line spans (multi-line arrays, inline tables and strings are one statement). The scan that `tomlHeaderLines` used is now the shared `scanLine`.
- A table is ours when its header's key path is `mcp_servers.gsd-atlas`; its header line is never rewritten. `command` and `args` are replaced in place (a multi-line `args = [` ... `]` as a whole), a missing one is inserted directly after the header or after the other managed key, and every other line is kept byte for byte (user keys, comments, blank lines, comment lines directly above the next header, sub-tables such as `[mcp_servers.gsd-atlas.env]`). CRLF files get CRLF on inserted lines and no bare LF; a file with no final newline stays without one.
- Refused with the line number and `edit it by hand`, file untouched: `gsd-atlas = { ... }` or `gsd-atlas.command = ...` inside `[mcp_servers]`, root dotted keys `mcp_servers.gsd-atlas.command = ...`, a root `mcp_servers = { ... }`, the table defined twice, an array of tables, a `url` key (Codex rejects a server with both a command and a url), `command` or `args` written twice or as a dotted key.
- Cases listed in the plan: `header with a comment`, `header with spaces`, `quoted key header`, `inline table is refused`, `dotted keys are refused`, `comment above the next header`, `user keys are preserved`, `multi-line args replaced whole`, `url conflict is refused`, `crlf insertions`, and the five shapes (empty table, only `args`, `command` after `args`, last in the file with no final newline, a file that is only the table).
- Expectations that encoded the old whole-table replacement and were updated: the `refusals` entry "the table written with a quoted key" (now an update), and the four "block end is the next real table header" cases (a user's `notes` or `doc` key inside our table is now kept, and a missing `args` is inserted after `command`).

### Task 3 - the hint asks the Host, commit 3e395be

- `index_state` is in `REPO_KINDS` with a strict selection-only schema (`repo`, `cwd`), class `interactive`; it is not an MCP tool and not a CLI command (`TOOL_NAMES` still has six entries, asserted). `hasIndex(resolved)` in `src/host/host.ts` is the one predicate: a tenant is registered under the store id, or `findExistingStore` finds the file and `probeStore` says `indexed` or `newer_schema`. The read gate and `index_state` both call it; `index_state` answers `gsd-atlas.index-state/1` with `{ repo, indexed }` before any tenant exists.
- `src/host/index-state.test.ts` (red on the unknown kind, 11 of 12 failing): `built`, `unbuilt`, `empty store`, `older schema`, `store.dir store is found`, `cache store is found`, `not a repository`, `writes nothing` (fingerprints of the repository, cache and user directory, no `lease.json`, no watcher, a following build still leads), plus the equal-to-the-read-gate case, the strict-argument case and the six-tools case.
- `runCli` gives `init` an `indexState(cwd)` built on its HostClient (`askIndexState`); an error envelope, a rejected call or an unexpected reply is `unknown`, and `init` then uses the old common-directory probe, as it does when no function is supplied. The Host is asked only after `init` registered something, outside a dry run, and when a `.git` entry exists above the working directory (checked in `init.test.ts`: no call on a dry run, a refusal, nothing registered, no repository, `--help` or a usage error). The hint sentence is unchanged (D-11).
- `scripts/cli-e2e.test.ts` case `init sees a store under store.dir` runs the real `gsd-atlas` bin with `GSD_ATLAS_STORE_DIR`: the hint appears once before `build`, and not after.
- The one predicate is `hasIndex` in `src/host/host.ts`. `src/cli/init.ts` still imports only `node:` built-ins and host-client types.

### Task 4 - isInside, commit 9aa2a63

`src/lang/module-files.ts`, `scripts/corpus-gates.ts` and `scripts/recall.ts` import `isInside` from the facts index and declare no function of that name (arguments swapped at every call that took `(child, parent)`). Pinned across the change (passing before and after): a directory named `..assets` inside a module folder is read, a link out of the folder and the folder itself are `path_escape`, and a work area beside the repository whose name shares the repository name as a prefix is not "inside the repository" in either gate script.

Search of `src` and `scripts` for hand-written containment tests (a `startsWith` on a path plus a separator, or a `path.relative` compared with `..`):

| Hit | Disposition |
|-----|-------------|
| `src/lang/module-files.ts` `isInside` | replaced |
| `scripts/corpus-gates.ts` `isInside` | replaced |
| `scripts/recall.ts` `isInside` | replaced |
| `scripts/freshness-gate.ts` `tmpRoot.startsWith(repoRoot + path.sep)` | replaced (same meaning) |
| `src/test-kit/git-repo.ts` `abs()` `full.startsWith(dir + path.sep)` | replaced (test-kit may import facts) |
| `src/query/ranking.ts` `cwdHintDir` absolute branch | replaced; the relative-hint branch (`normal.startsWith('../')` on a POSIX-normalised string) is a different thing and stays |
| `scripts/corpus-fetch.test.ts`, `scripts/recall.test.ts` (two assertions "is under the temp root") | replaced |
| `src/indexer/parcel-source.ts` `relativeUnder` | not touched: another agent owns that file; its meaning differs (returns the POSIX relative path, and null for the root itself) |
| `src/fact-store/specifier.ts` (`joined.startsWith('../')`) | different meaning: POSIX module specifiers, not file-system paths |
| `src/source-tree/validate.ts`, `src/host/history.ts`, `src/indexer/paths.ts`, `src/lang/grammar-lock.ts` | different meaning: shape checks that reject absolute, drive-letter or `./` strings |
| `src/host/two-tenant.test.ts`, `src/host/host.test.ts`, `src/indexer/parcel-source.test.ts`, `scripts/package.test.ts` | assertions on where a path was built or on a package file list, not containment decisions |

### Task 5 - the ADR amendment, commit 27ac948

Confirmed by reading `docs/adr/5-language-modules.md` (decision 3 names the shared Grammar Engine), `docs/DESIGN.md` (A6, A55) and the other ADRs: `9-tenant-composition` and the draft host-process-model say only that the Governor owns "the parser and compiler pools" (scheduling and budget), and specify no deadlines, so `5-language-modules` is the owner. `## Amendment 2026-10-17: Parser pool deadlines` is appended with a `Sources:` line and states `pool.loadTimeoutMs` 30,000 ms (worker terminated and replaced, the load rejects `engine_init_failed`, a run that needed it fails `parse_failed`, reachable by repository content because repository modules rank first), `pool.terminateGraceMs` 2,000 ms, the 7,000 ms hard deadline (the approved `indexer.parseTimeoutMs` 5,000 plus the grace, so `parse_timeout` fires first and the worker keeps its grammars), the `runTimeoutMs`-only compatibility rule and `poolStatus().limits`. The text above it is unchanged (diff has no removed lines); the README gained the log line; `scripts/adr.test.ts` has the entry (red before the amendment existed).

## Verification

- `npm run typecheck` and `npm run lint`: exit 0 after every task and at the end.
- Plan verification list (`settle`, `parity`, `init-toml`, `init`, `index-state`, `module-files`, `adr`): 205 tests, 205 pass. Each task's own verify command passed (Task 1: 54; Task 2: 141; Task 3: 204; Task 4: 140; Task 5: 39 in `adr.test.ts`).
- Full `npm test`: 2588 tests, 2587 pass, 1 fail. The one failure is `src/indexer/parcel-source.test.ts` at file level (`'test failed'`, no assertion), the crash the other agent is fixing; the file passes alone (18 of 18). Not touched here.
- Stress (Task 1 acceptance): 16-way health case, 3 rounds, 0 of 48 failures after the change (11 of 48 before).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing safety] Two more unsafe forms refused**
- **Found during:** Task 2
- **Issue:** A root `mcp_servers = { ... }` statement or a `[[mcp_servers.gsd-atlas]]` array of tables would make an appended or edited table invalid or duplicate; the plan listed only the inline-table, dotted-key and defined-twice forms.
- **Fix:** both are refused with the line number and `edit it by hand`, with test cases.
- **Files modified:** `src/cli/init-targets.ts`, `src/cli/init.test.ts`
- **Commit:** 6d21aaa

**2. [Rule 1 - Scope of the search] More containment copies replaced than the three named**
- **Found during:** Task 4 (the plan's own search step)
- **Issue:** the search found four more production hits (`freshness-gate.ts`, `test-kit/git-repo.ts`, `query/ranking.ts`) and two test assertions with the same meaning.
- **Fix:** replaced; the others are justified in the table above.
- **Commit:** 9aa2a63

**3. [Test update] Old whole-table expectations changed** (named under Task 2 above; they asserted the behaviour the plan replaces).

No product change in Task 1 (see above). No constant was invented: the deadlines in the amendment are the Approved values of `02-CONSTANTS.md`.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-02-129 (Codex table damage) is covered by byte-identity assertions on everything outside `command` and `args`; T-02-130 (`index_state` opening state) by the fingerprint, no-lease and six-tool cases; T-02-131 (random gate) by the settle step and the before and after counts.

## Self-Check: PASSED

- Files exist: `scripts/test-helpers/settle.ts`, `scripts/settle.test.ts`, `src/host/index-state.test.ts`.
- Commits exist: 1cf4097, 6d21aaa, 3e395be, 9aa2a63, 27ac948.
