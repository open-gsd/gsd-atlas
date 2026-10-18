---
phase: 03-typescript-module-and-mvp-eval
plan: 15
subsystem: security
tags: [allow, permissions, sha256, mcp-origin, allow-build, user-config, needs-approval, providers]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-13 commandHash and exact-argv approvals enforced by decide; the strict user config schema with sha256"
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-12 needs_approval degraded code in the facts kernel"
provides:
  - "Host request kind allow: a dry run returns the canonical preview and its sha256, the confirmed call recomputes the hash from its own arguments and writes one entry"
  - "gsd-atlas allow [--repo] [--cwd] [--workdir] [--module] -- <executable> <args...>: terminal-only, shows argv, repository, working directory and hash, asks y/N, exit 2 without a terminal"
  - "addAllowEntry: the safe user-config writer (strict-schema validation of the existing file, 0600 temp file plus rename, 64 KiB cap, other keys kept, symlink followed, concurrent writer wins)"
  - "ComposeOptions.origin and allowBuild, makeRunner, parseMcpFlags; gsd-atlas-mcp --allow-build; the MCP-origin runner has no user permission list unless the flag is given"
  - "Host refuses allow from an MCP origin (allow_forbidden); permissionsFor, needsApprovalFrom exported for plan 03-29"
  - "providers.disabled in the strict user config, handed to the tenant factory as TenantDeps.providers for plan 03-23"
  - "lang_list reports an approved module command as command_approved (CLI, or MCP with --allow-build) and command_not_approved otherwise; ResolveOptions.approved on the registry"
affects: [03-23, 03-29, 03-34, 03-35]
actuals:
  tokens: 31700
  tasks: 3
  commits: 3
commits: 3
plan_head_before: 97d96c705f2bb9926254fba986045c84537a1cf6
plan_head_after: 65042df7a2b742af2e15d127673fc6b10c8afcfa
tech-stack:
  added: []
  patterns:
    - "Two-step approval bound by hash: the confirming call recomputes what the person saw from its own arguments"
    - "Origin decides the permission list at composition: one function (permissionsFor) shared by the Host and the runner factory"
    - "Registry stays free of user config: approvals reach it as an injected predicate (ResolveOptions.approved)"
    - "Fixed-text reasons and diagnostics for anything an agent can read; repository text only at the terminal prompt, escaped"
key-files:
  created:
    - src/host/allow.ts
    - src/host/allow.test.ts
    - src/cli/allow.ts
    - src/cli/allow.test.ts
    - src/cli/text.ts
    - scripts/mcp-allow-build.test.ts
  modified:
    - src/host/config.ts
    - src/host/config.test.ts
    - src/host/route.ts
    - src/host/host.ts
    - src/host/types.ts
    - src/host/index.ts
    - src/host/lang.ts
    - src/cli/tool-commands.ts
    - src/cli/index.ts
    - src/bin/compose.ts
    - src/bin/compose.test.ts
    - src/bin/gsd-atlas-mcp.ts
    - src/bin/gsd-atlas.ts
    - src/bin/cli-main.ts
    - src/lang/registry.ts
    - src/lang/registry.test.ts
    - src/lang/index.ts
    - src/tenant/types.ts
key-decisions:
  - "The dry-run reply is the one place a module's proposed argv travels: the terminal CLI needs it to show the person, an MCP-origin Host refuses allow, and the module is named only by the boolean fromModule. The confirmed reply, every error message and every diagnostic hold no argv element, module name or path."
  - "An existing config file that the loader would ignore is never appended to: the writer validates it with the loader's own strict schema and refuses with one sentence built from fixed words (zod's messages quote unknown keys, which are file content, so they are not used)."
  - "The dry run already checks that the config file can take an entry, so the person is not asked about something that cannot be recorded."
  - "lang_list shows an approved module command as reason command_approved by asking decide (the same rule the runner applies) and counting only a user approval, so the first-party git rule can never read as an approval."
  - "An invalid user config file exits 3 as the plan specifies, although 3 is documented as lease-held or busy; the stderr sentence says what happened."
requirements-completed: [SEC-02, SEC-01]
coverage:
  - id: D1
    description: "gsd-atlas allow previews the exact command, asks on a terminal, and writes one hash-bound entry; the runner then starts exactly that command and denies a changed one"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "src/host/allow.test.ts#dry run writes nothing and returns the canonical preview with its hash; confirm mismatch writes nothing; runner allows exactly the approved command; runner denies changed args"
        status: pass
      - kind: unit
        ref: "src/cli/allow.test.ts (preview then write, declined, no terminal, restart note, usage line)"
        status: pass
      - kind: integration
        ref: "src/bin/compose.test.ts#allow end to end: a person answering yes records an approval that only a later composition runs"
        status: pass
    human_judgment: false
  - id: D2
    description: "The user-config write is safe: invalid file untouched, 0600, temp file plus rename, failed rename or write leaves the original, 64 KiB cap, other keys preserved, concurrent writer wins, symlink kept"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "src/host/allow.test.ts#addAllowEntry (9 cases) and 'allow: the user configuration through the Host' (3 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "--workdir is normalised, kept inside the repository and bound into the hash; --module proposes the manifest argv for the terminal only and no argv, module name or manifest text reaches an envelope, diagnostic or reason"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/host/allow.test.ts#allow: --workdir (3 cases) and allow: --module (4 cases); src/lang/registry.test.ts#secret marker"
        status: pass
    human_judgment: false
  - id: D4
    description: "SEC-02 on the MCP path: no permission list unless --allow-build; allow refused from an MCP origin; denial maps to needs_approval with fixed text; new approvals are seen only by a new composition"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "src/bin/compose.test.ts#makeRunner (cli origin applies permissions, mcp origin without allow-build, mcp origin with allow-build) and 'new composition sees new entry'"
        status: pass
      - kind: unit
        ref: "src/host/allow.test.ts#allow_forbidden from mcp origin; needsApprovalFrom (2 cases)"
        status: pass
      - kind: integration
        ref: "scripts/mcp-allow-build.test.ts (real gsd-atlas-mcp process, with and without --allow-build)"
        status: pass
    human_judgment: false
  - id: D5
    description: "providers.disabled accepted by the strict user config (unknown ids allowed) and handed to the tenant factory"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "src/host/config.test.ts#providers.disabled (3 cases); src/host/allow.test.ts#providers.disabled reaches the tenant factory"
        status: pass
    human_judgment: false
duration: 2h 30m
completed: 2026-10-18
status: complete
---

# Phase 3 Plan 15: gsd-atlas allow and the MCP origin Summary

**A person at a terminal approves one exact command with `gsd-atlas allow` (preview, hash-bound confirmation, safe 0600 write to the user config), and an MCP server cannot run it, or record one, unless it was started with `--allow-build`.**

## Performance

- **Duration:** about 2.5 h (start time was not captured at spawn; estimated)
- **Completed:** 2026-10-18
- **Tasks:** 3 (Task 1 tracer, Tasks 2 and 3 auto)
- **Files:** 24 changed (6 created, 18 modified); +2344 / -81 lines

## Accomplishments

- **Hash-bound approval.** `host.handle({kind: 'allow'})` is a dry run (canonical repository, executable, args, cwd, `commandHash`) or, with `confirm`, a write. The confirmed call recomputes the hash from its own arguments and writes only on equality, so a changed argument, working directory or module manifest between the calls is `confirm_mismatch`. A real runner built from the written entry starts exactly the approved argv and denies `--other`, extra or missing arguments, and a different working directory.
- **`gsd-atlas allow`.** Needs a terminal on both standard input and standard error (exit 2 with `allow needs a terminal`, nothing sent); shows the values JSON-quoted with C0, C1 and line-separator characters escaped; `y` or `yes` only; prints one JSON envelope on stdout and the note that a running MCP server must be restarted. `--workdir` and `--module <name>` are supported; `--module` and a command after `--` are mutually exclusive.
- **Safe writer.** `addAllowEntry` reads through the loader's bounded reader and refuses any file the loader would ignore (not JSON, unknown key, malformed entry, over 64 KiB) with a sentence built from fixed words; keeps every other key; writes a 0600 temp file in the same directory, flushes, renames; removes the temp file on every failure; refuses a result over 64 KiB before writing; detects a concurrent writer and leaves its file; follows a symlinked config so a dotfile manager's link stays a link.
- **MCP path.** `makeRunner` and `permissionsFor` are the single place the origin rule lives: `cli` gets the user list, `mcp` gets none unless `--allow-build`. The Host refuses `allow` from an `mcp` origin before reading its arguments. `needsApprovalFrom` maps exactly `command_denied` to `needs_approval` plus a fixed diagnostic naming `gsd-atlas allow` and `--allow-build`. `gsd-atlas-mcp` parses its arguments (`--allow-build`, `--help`; anything else is refused with a usage line before anything is served).
- **Providers.** `providers.disabled` is in the strict schema and `UserConfig`; the Host passes `config.providers` to the tenant factory (`TenantDeps.providers`), nothing consumes it yet (plan 03-23).
- **Registry honesty.** `lang_list` now says `command_approved` when the person approved exactly that module command and the Host may use the list; an MCP server without the flag still says `command_not_approved`. The registry stays free of user config: approvals reach it as `ResolveOptions.approved`. The `precise_command_inactive` note is fixed text that names `gsd-atlas allow --module <name>`.

## Task Commits

1. **Task 1: Tracer - gsd-atlas allow previews, asks, writes an entry, and the runner then allows exactly that command** - `f3d789b` (feat)
2. **Task 2: The safe user-config writer, workdir and --module proposals** - `ce33b59` (feat)
3. **Task 3: MCP origin, --allow-build, the denial-to-needs_approval mapping and the restart behavior** - `65042df` (feat)

**Plan metadata:** the docs commit that adds this file.

## TDD record

The plan is `type: execute` with `tdd="true"` tasks and asks for one commit per task, so there is no separate `test(...)` commit. RED was observed on the planned assertions before each GREEN:

- Task 1: with the Host and CLI cases and no `allow` handling, 7 Host cases failed on `reply.ok === true` (the kind fell through to the repo read gate and answered `not_indexed`) and 17 CLI cases failed on the planned exit codes and requests.
- Task 2: 21 of 87 cases failed on the planned assertions (file overwritten or not validated, rename failure left a temp file, no size cap, `providers` rejected as an unknown key, registry note lacking `gsd-atlas allow`, module and workdir cases).
- Task 3: with the new exports stubbed to the wrong behavior (list always applied, `needsApprovalFrom` always null, flags always accepted), 6 Host cases and 9 composition cases failed on the planned assertions.

## Tracer gate

`workflow.human_verify_mode` is `end-of-phase`, auto mode off, and the tracer's `<verify>` is `<automated>` only, so it was re-run after the Task 1 commit: `node --test src/host/allow.test.ts src/cli/allow.test.ts src/command-runner/decide.test.ts` (186 pass) plus typecheck and lint, clean. Tracer verified end-to-end, expanding.

## Decisions Made

See `key-decisions`. No Rule 4 decision was needed.

## Deviations from Plan

### Interpretations of the plan text

**1. The module proposal travels in the dry-run reply.** The plan says the argv text appears "in the CLI's stderr preview only" and the test must find no argv element in "the envelope". The CLI imports only the host-client seam, so the only way the argv can reach its terminal prompt is the Host's dry-run reply. That reply is produced only for a CLI-origin Host (an MCP-origin Host refuses `allow`), and the CLI never prints it. The module is named only by `fromModule: true`; the confirmed reply, all error replies and all diagnostics are free of the argv, the module name and the path, and the tests assert exactly that (`module argv not in envelope`, two cases). If a stricter reading is wanted (no argv in any reply), the CLI would have to read the manifest itself, which breaks the adapter rule; that is a design change for the user.
**2. `lang_list` "approved-ready".** Task 3 asks that the CLI's `lang list` report the same tier as approved while an MCP server without the flag does not, but no approved state existed. I added reason `command_approved` and info diagnostic `precise_command_approved` (fixed text), computed by the Host through `decide` and passed to the registry as `ResolveOptions.approved`. Plans 03-26 and 03-29 may rely on `command_approved`.
**3. Exit code 3 for an invalid user config.** As specified, although `exit.ts` documents 3 as lease-held or busy. The stderr sentence is the fixed `the user configuration file is invalid and was not changed: <reason>`.

### Auto-fixed Issues

**1. [Rule 1 - Bug] A trailing slash in `--workdir` changed the hash**
- **Found during:** Task 2 (the `workdir is carried into the preview and the hash` case)
- **Issue:** `path.posix.normalize('sub/dir/')` keeps the trailing slash, so `sub/dir/` and `sub/dir` hashed differently and the preview showed `sub/dir/`.
- **Fix:** strip one trailing slash after normalising.
- **Files modified:** src/host/allow.ts
- **Committed in:** ce33b59

**2. [Rule 2 - Missing critical] Terminal escape sequences in the prompt**
- **Issue:** a manifest argv (or a pasted command) can hold ESC sequences that repaint the terminal and hide what is being approved.
- **Fix:** every value is printed JSON-quoted with C1 controls and U+2028 or U+2029 escaped as well; a test shows no raw ESC reaches stderr.
- **Files modified:** src/cli/allow.ts, src/cli/allow.test.ts
- **Committed in:** f3d789b

**3. [Rule 2 - Missing critical] Writer hardening beyond the plan list**
- A symlinked config is followed (the link stays a link); a concurrent writer wins (re-read before rename, `config_changed`); the dry run already reports an unusable config file so the person is not asked about something that cannot be recorded; an unrelated zod message is never used as a reason because zod quotes unknown keys (`fixedProblemOf`).
- **Files modified:** src/host/allow.ts, src/host/config.ts
- **Committed in:** ce33b59

### Files outside the plan's `files_modified` (Rule 3, all small)

- New: `src/cli/allow.ts` (the command, kept out of the 237-line `index.ts`), `src/cli/text.ts` (shared `oneLine` and `printEnvelope`, moved out of `index.ts`), `scripts/mcp-allow-build.test.ts` (real-process flag tests; `scripts/mcp-stdio.test.ts` is shared, so it was not edited).
- Modified: `src/bin/gsd-atlas.ts` (real readline prompt, terminal detection, `origin: 'cli'`), `src/host/lang.ts` and `src/lang/index.ts` (approval predicate and `ResolveOptions` export), `src/tenant/types.ts` (`TenantDeps.providers`, one optional field).
- `docs/reference/cli.md` was listed in a read_first but not changed: plan 03-34 owns the `allow` documentation.

**Total deviations:** 3 interpretations, 3 auto-fixed (1 bug, 2 missing critical). **Impact:** none on scope; the two behaviors a reader could not infer from the plan (1 and 2) are the ones to confirm.

## Issues Encountered

- The repo's read guard blocks plain `Read` and several shell forms on indexed `.ts` files until a `codegraph node --path <worktree root> -f <file>` span precedes them. A worktree index was built with `codegraph init -y` and refreshed with `codegraph sync`; the untracked `.codegraph/` directory was removed before return.
- The shell guard rejects commands that name git together with other tools in a heredoc; edits were made with the Edit tool or a script file in the scratchpad.

## Known Stubs

None. `TenantDeps.providers` has no consumer yet by design (plan 03-23).

## Threat Flags

None beyond the plan's own threat model (T-03-151 to T-03-155). The new surfaces are the `allow` request kind (refused for MCP origin, no tool), the terminal prompt, and the user-config write.

## Verification

- `node --test src/host/allow.test.ts src/cli/allow.test.ts src/command-runner/decide.test.ts`: 186 pass (Task 1).
- `node --test src/host/allow.test.ts src/host/config.test.ts src/cli/allow.test.ts src/lang/registry.test.ts`: 87 pass (Task 2).
- `node --test src/bin/compose.test.ts src/host/allow.test.ts scripts/mcp-stdio.test.ts scripts/cli-bin.test.ts`: 73 pass; `scripts/mcp-allow-build.test.ts`: 5 pass (Task 3).
- `npm run typecheck`, `npm run lint`, `npm run build`: clean.
- `npm test`: 3221 tests, 3220 pass, 0 fail, 1 skipped (pre-existing), including the SEC-01 hostile-repository test of plan 03-13.
- Acceptance criteria: route.ts lists `allow`; allow.ts exports `previewAllow`, `applyAllow`, `addAllowEntry`; all named test titles exist in `src/host/allow.test.ts`, `src/cli/allow.test.ts`, `src/bin/compose.test.ts`, `src/host/config.test.ts` and `src/lang/registry.test.ts`; compose.ts contains `allowBuild` and exports `makeRunner`; gsd-atlas-mcp.ts contains `--allow-build`.

## Next Phase Readiness

Plan 03-29 can import `needsApprovalFrom`, `permissionsFor` and `previewAllow` from `src/host/index.ts`, and `makeRunner` from `src/bin/compose.ts`; Plan 03-23 reads `TenantDeps.providers.disabled`. A running MCP server must be restarted to see a new approval (documented, tested by composing twice). STATE.md, ROADMAP.md and REQUIREMENTS.md were not touched (shared IDs SEC-01 and SEC-02 are declared by other plans; the orchestrator owns those updates).

## Self-Check: PASSED

- Created files present on disk: src/host/allow.ts, src/host/allow.test.ts, src/cli/allow.ts, src/cli/allow.test.ts, src/cli/text.ts, scripts/mcp-allow-build.test.ts.
- Commits f3d789b, ce33b59, 65042df are ancestors of HEAD; `git rev-list --count 97d96c7..HEAD` was 3 before this SUMMARY commit.
