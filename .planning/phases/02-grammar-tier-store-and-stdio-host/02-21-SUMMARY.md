---
phase: 02-grammar-tier-store-and-stdio-host
plan: 21
subsystem: cli
tags: [init, mcp-registration, claude-code, cursor, codex, atomic-write, toml-text-edit]

requires:
  - phase: 02-grammar-tier-store-and-stdio-host
    provides: "CLI adapter (runCli, CliIo, envelope output contract) from Phase 1 and plan 02-01 test kit"
provides:
  - "gsd-atlas init: user-scope MCP registration for Claude Code, Cursor and Codex"
  - "runInit(options, env) returning the gsd-atlas.init/1 envelope, exit code and stderr lines"
  - "Safe user-file writer: parse-first, atomic temp-and-rename, one-time backup, symlink write-through, BOM and EOL preservation"
  - "CliIo.init (InitEnvironment) injection point that plan 02-22's bin must supply"
affects: [02-22 bin wiring, phase 7 hooks registration, docs for gsd-atlas init]

actuals:
  tokens: 13500
  tasks: 2
  commits: 5

plan_head_before: 26aa7bc2ad153e3941b92638fd4030949451f28f
plan_head_after: bd166c059b892e8dd4038f0a3e7e48a1ae065d3d

tech-stack:
  added: []
  patterns:
    - "Target table: per-host file, detect, render(existing, launch) returning new text or a refusal"
    - "Config edits are text in, text out; only init-files.ts touches the disk"
    - "Everything environmental (home, cwd, platform, env, launch command) injected through CliIo.init"

key-files:
  created:
    - src/cli/init.ts
    - src/cli/init-files.ts
    - src/cli/init-targets.ts
    - src/cli/init.test.ts
  modified:
    - src/cli/index.ts

key-decisions:
  - "Existing gsd-atlas entry is replaced wholesale (not merged) so a stale key from an older registration cannot linger"
  - "A launch command or entry path that is not absolute is rejected before any host is touched (T-02-74)"
  - "Codex stays a text edit: only the gsd-atlas table is replaced; unbalanced headers, NUL bytes and a quoted-key spelling of our table are refused"
  - "Refused vs write failure share one action (refused) with a reason prefix, keeping the five-action vocabulary from the plan"

patterns-established:
  - "Refusal contract: unparseable or unexpected input yields action refused, a stderr reason and byte-identical files"
  - "Adapter tests drive runCli with an injected temp home and a host stub that throws if contacted"

requirements-completed: [HST-04]

coverage:
  - id: D1
    description: "init registers the stdio server at user scope for Claude Code, Cursor and Codex, with an absolute node path and entry path, writing nothing into the cwd or any repository"
    requirement: HST-04
    verification:
      - kind: unit
        ref: "src/cli/init.test.ts#gsd-atlas init for Claude Code, Cursor and Codex suites"
        status: pass
    human_judgment: false
  - id: D2
    description: "Existing user configuration is never damaged: parse-first refusal byte-identical, key preservation, atomic write, one backup, symlink write-through, BOM and EOL kept, idempotent second run"
    requirement: HST-04
    verification:
      - kind: unit
        ref: "src/cli/init.test.ts#refused / backup / symlink / BOM and CRLF / unchanged cases"
        status: pass
    human_judgment: false
  - id: D3
    description: "Detection, agent filter, dry-run, mixed-run exit codes, config_not_found manual command and the single gsd-atlas build suggestion"
    requirement: HST-04
    verification:
      - kind: unit
        ref: "src/cli/init.test.ts#gsd-atlas init host detection and the agent filter"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cursor and Codex file shapes match what each host currently reads"
    requirement: HST-04
    verification: []
    human_judgment: true
    rationale: "Shapes follow gsd-graph's installer and were not checked against current host documentation (research assumption A3); only a real host launch proves them."

duration: 6min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 21: gsd-atlas init Summary

**`gsd-atlas init` registers the stdio MCP server at user scope in Claude Code, Cursor and Codex configs, with parse-first refusal, atomic write, one-time backup and no repository writes.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-10-16T18:15:53Z
- **Completed:** 2026-10-16T18:22:07Z
- **Tasks:** 2 (1 tracer, 1 auto, both TDD)
- **Files modified:** 5

## Accomplishments

- Claude Code (`mcpServers` of `~/.claude.json`), Cursor (`~/.cursor/mcp.json`) and Codex (`[mcp_servers.gsd-atlas]` in `~/.codex/config.toml`) are registered with the injected node path and gsd-atlas-mcp entry path; hooks are left to Phase 7.
- The writer cannot damage user config: unparseable, array, NUL-byte, non-object `mcpServers`, unbalanced-TOML-header and quoted-key inputs are refused byte-identical with exit 2; writes are temp-file plus rename; the first change keeps `{file}.gsd-atlas-backup` (exclusive copy, never overwritten); symlinked files are written through; BOM, line endings, indent and permission bits are preserved.
- Idempotent (`unchanged`), `--dry-run`, `--agent` filter, `not_detected` / `config_not_found` skips (with the exact `claude mcp add --scope user gsd-atlas -- <command> <args>` line), mixed-run exit 2, and the D-11 single `gsd-atlas build` suggestion when cwd is in a git repo with no `{git dir}/gsd-atlas`.
- 53 tests in `init.test.ts` plus `cli.test.ts` pass; full suite 1079/1079; typecheck, lint and build clean. No `child_process`, no shell, no new dependency.

## TDD Gate Compliance

- **RED (Task 1):** `test(02-21)` 6c37c70. Target "updates ~/.claude.json: keeps every other key, adds the gsd-atlas server and keeps one backup" failed on `assert.equal(out.code, 0)` (1 !== 0) because `init` was an unknown command. Classifier: `RED_EVIDENCE_OK`. Semantic assessment: the file loads (type-only imports erased), 19 tests discovered, 15 fail on behavior assertions; the 4 passing are trivially-true negative cases and were not used as evidence.
- **RED (Task 2):** `test(02-21)` 2c1491a. Target "replaces only the existing gsd-atlas block ... (Codex replace-block)" failed on exit code 1 because `--agent codex` was an unknown agent. `RED_EVIDENCE_OK`; 17 of 39 failed. `config_not_found`, quoting and unknown-agent tests already passed from Task 1's general orchestration; noted, not used as evidence.
- **GREEN:** `feat(02-21)` d5263f0 (Claude Code, writer, orchestration, CLI wiring) and bb72fae (Cursor and Codex).
- **REFACTOR:** `refactor(02-21)` bd166c0 spelled the header and host paths literally to meet the plan's literal-text acceptance criteria; no behavior change.
- Evidence records: `.planning/red-evidence-02-21-t1.json`, `-t2.json` (left untracked per dispatch rules).
- Tracer gate: Task 1 `<verify>` (tests, typecheck, lint) re-run green end to end before expanding; no checkpoint (automated-only verify, end-of-phase mode).

## Task Commits

1. **Task 1: Tracer, Claude Code user config** - `6c37c70` (test), `d5263f0` (feat)
2. **Task 2: Cursor and Codex targets** - `2c1491a` (test), `bb72fae` (feat), `bd166c0` (refactor)

**Plan metadata:** docs commit follows this file.

## Files Created/Modified

- `src/cli/init.ts` - `runInit`, `InitEnvironment`, envelope and per-host orchestration, repo-without-index detection
- `src/cli/init-files.ts` - `readUserFile`, `writeUserFile`, `detectHomeFile`, backup and symlink handling
- `src/cli/init-targets.ts` - `TARGETS` (claude, cursor, codex), JSON merge, Codex text edit, TOML string escaping
- `src/cli/init.test.ts` - 39 tests using a temporary home and a host stub that throws if contacted
- `src/cli/index.ts` - `init` command, `--agent` / `--dry-run`, `io.init`, usage line, `INIT_SCHEMA` re-export

## Decisions Made

- The existing `gsd-atlas` entry is replaced as a whole rather than merged, so a stale `url` or `env` from an older registration cannot combine with the new command.
- Absolute-path validation of the launch command (and last argument) happens before any host is read, honouring T-02-74 for any caller, not just the future bin.
- Write failures are reported as `refused` with a `could not write the file` reason, keeping the plan's five-action vocabulary and exit 2.
- The suggestion line is skipped on `--dry-run`, when nothing was registered, and when any host was refused.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Launch command validation**
- **Found during:** Task 1 (threat T-02-74)
- **Issue:** Plan states the command is never a PATH lookup but gave no enforcement point inside `runInit`.
- **Fix:** `launchProblem` rejects a non-absolute command or entry (platform-aware via `path.win32` / `path.posix`) with `launch_command_invalid`, exit 2, before touching any host; test added.
- **Files modified:** src/cli/init.ts, src/cli/init.test.ts
- **Committed in:** d5263f0

**2. [Rule 2 - Missing critical] Quoted-key Codex table and dangling symlink refusal**
- **Found during:** Task 2 and Task 1
- **Issue:** `[mcp_servers."gsd-atlas"]` is the same TOML table, so appending ours would create a duplicate; a dangling symlink would have been silently replaced by a regular file.
- **Fix:** Codex render refuses the quoted-key spelling; `resolveTarget` throws on a dangling link (reported as refused).
- **Files modified:** src/cli/init-targets.ts, src/cli/init-files.ts
- **Committed in:** d5263f0, bb72fae

**3. [Rule 1 - Plan acceptance] Literal header text**
- **Found during:** Task 2 acceptance check
- **Issue:** The header was built from a constant, so the literal `[mcp_servers.gsd-atlas]` the criterion looks for was absent from the source.
- **Fix:** Spelled literally; host paths named in a comment. Commit bd166c0.

---

**Total deviations:** 3 auto-fixed (2 missing critical, 1 acceptance wording). **Impact on plan:** All within the stated mitigations; no scope creep.

## Issues Encountered

- The acceptance command `grep -c "child_process" src/cli/init*.ts` was denied by the repo's CodeGraph-first Bash guard ("Bash is targeting an indexed source file"). Not bypassed. The criterion is met by construction (no such import was written) and enforced by `npm run lint` (child_process banned outside command-runner), which passes.
- Between the Task 1 and Task 2 commits the usage text advertises `cursor|codex` before they existed (literal text required by the plan); only the intermediate commit is affected.

## Known Limits (not stubs)

- Codex text edit does not see a gsd-atlas entry written as dotted keys or an inline table under `[mcp_servers]`; it would append a table, which a strict TOML parser would reject as a duplicate. Rare; hosts that write the file use table headers.
- JSON round trip loses integer precision above 2^53 and non-two-space/tab indent styles are approximated by the first indented line.
- Cursor and Codex shapes are unverified against host docs (assumption A3, coverage D4).
- Windows (rights for symlinks, rename-over-existing semantics) is covered by tests that run on this macOS machine only; CI legs will exercise the Windows path.
- `InitEnvironment.env` is carried for the bin and is not read yet.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 02-22 must supply `io.init` in `src/bin/gsd-atlas.ts`: `home` from `os.homedir()`, `cwd`, `platform`, `env`, and `mcp` = `process.execPath` plus the absolute path of the `gsd-atlas-mcp` entry beside the running bin.
- Until then the real `gsd-atlas init` prints `init is not available in this build` and exits 2.

## Self-Check: PASSED

- Files exist: init.ts, init-files.ts, init-targets.ts, init.test.ts, index.ts, this SUMMARY.
- Commits present on HEAD: 6c37c70, d5263f0, 2c1491a, bb72fae, bd166c0.
- `node --test src/cli/init.test.ts src/cli/cli.test.ts`, `npm run typecheck`, `npm run lint`, `npm run build` all exit 0; `npm test` 1079 pass, 0 fail.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
