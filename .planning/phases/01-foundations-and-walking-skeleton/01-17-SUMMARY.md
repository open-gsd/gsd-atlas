---
phase: 01-foundations-and-walking-skeleton
plan: 17
subsystem: lang-registry
tags: [registry, precedence, lang-list, lang-test, host-client, cli, trust-boundary, e2e]
status: complete

requires:
  - phase: 01-14
    provides: runLangTest, in-process HostClient, runCli, composition root
  - phase: 01-12
    provides: confined module reader, toy module
  - phase: 01-06
    provides: parseManifest and the Manifest type (replace, tiers, precise)
provides:
  - "resolveModules(roots) and resolveModule(roots, name): four-location precedence repo > user > npm > built-in, with shadowed copies"
  - "gsd-atlas lang list; gsd-atlas lang test <folder-or-id>; root flags --repo-root, --user-dir, --builtin-dir, --npm-root (repeatable)"
  - "lang_list host request (schema gsd-atlas.lang-list/1) and per-request args.roots overrides on lang_list and lang_test"
  - "Diagnostics name_mismatch, grammar_tier_missing, extension_collision, extension_replaced, precise_command_inactive"
  - "readManifest in the confined module reader"
affects: [01-16, phase-02]

plan_head_before: 7407cece7521de26143451224c7e47964037cc02
plan_head_after: 11f64cc38e8cc3a2f9bc39d17144a6ec9bf38d7d

actuals:
  tokens: 19000   # chars/4 over the diff of the 13 files changed (1,511 insertions, 65 deletions)
  tasks: 2
  commits: 2      # MEASURED: git rev-list --count 7407cec..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "Registry takes plain absolute Roots and never reads the home or working directory; the composition root builds the defaults"
    - "Relative root flags are resolved by the CLI (the process that owns the cwd) before the host sees them; the host rejects relative overrides"
    - "Tier status, collisions and the inert precise tier are computed from manifest data alone; nothing a manifest names is spawned, resolved or imported"

key-files:
  created:
    - src/lang/registry.ts
    - src/lang/registry.test.ts
  modified:
    - src/lang/module-files.ts
    - src/lang/test-runner.ts
    - src/lang/test-runner.test.ts
    - src/lang/index.ts
    - src/host-client/in-process.ts
    - src/host-client/index.ts
    - src/host-client/host-client.test.ts
    - src/cli/index.ts
    - src/cli/cli.test.ts
    - src/bin/gsd-atlas.ts
    - src/lang/lang-test.e2e.test.ts

key-decisions:
  - "A module's name is the folder name (npm: the package-name suffix); the same name in several locations is one module with one active copy and the rest listed as shadowed"
  - "ModuleEntry.extensions is every declared extension; inactiveExtensions is the subset another module owns"
  - "Module precedence for collisions is source rank, then module name, so a tie inside one source is deterministic; extensions compare without case"
  - "extension_collision is an error diagnostic but the lang_list envelope stays ok (the listing itself worked); exit 0"
  - "Declaring precise.command or precise.adapter lists the precise tier even if tiers omits it; a precise tier with nothing declared is precise_not_declared"
  - "resolveModule scans only folders claiming that name, so it does not weigh other modules' extension claims"
  - "A bare id is anything without a path separator that is not an existing directory and matches the manifest name rule; a directory always wins over an id"

requirements-completed: [LNG-01, FND-03]

duration: about 50 min
completed: 2026-10-15
---

# Phase 1 Plan 17: Module registry, lang list and lang test by id Summary

Four-location module registry (repo, user, npm, built-in) with shadowed copies, `gsd-atlas lang list`, `lang test <id>`, skip-with-diagnostic for unusable modules, extension collisions, and precise commands proven inert by a marker-file process test.

## What was built

- `src/lang/registry.ts`: `resolveModules`, `resolveModule`, types `Roots`, `ModuleEntry`, `TierStatus`, `ModuleSource`. Search layout as planned (`<repo>/.gsd-atlas/languages/<name>`, `<user>/languages/<name>`, `<npm>/node_modules/gsd-atlas-lang-<name>` and `@opengsd/atlas-lang-<name>`, `<builtin>/<name>`). Missing directories are empty tiers. Candidates are deduplicated by realpath.
- `readManifest` in `src/lang/module-files.ts`; `readModuleInputs` now shares the same two helpers (behaviour unchanged, its existing tests pass).
- `runLangTest({ target, roots, engine })`: an existing directory is a folder; a bare id goes to `resolveModule`; otherwise `module_not_found`. Registry warnings about skipped copies ride along in the report diagnostics but never decide pass or fail.
- `createInProcessHostClient({ roots, engine })` serving `lang_list` and `lang_test`, merging validated `args.roots` over the defaults (`invalid_args` for relative, mistyped or unknown fields).
- CLI: `lang list`, root flags on both lang commands, usage text updated. Composition root builds defaults (cwd, `GSD_ATLAS_USER_DIR` or `~/.config/gsd-atlas`, `<package root>/modules` if present, npm roots `[cwd]`).

## Verification

- `npm test` 812 pass, 0 fail; `npm run lint`, `npm run typecheck`, `npm run build` clean.
- `node src/bin/gsd-atlas.ts lang list --repo-root test/fixtures/no-such-dir --user-dir test/fixtures/no-such-dir` prints an ok envelope with no modules, exit 0. The built `dist/bin/gsd-atlas.js` also resolves the package root correctly.
- Four-location precedence test removes the repo, user, npm and builtin copies in turn and asserts the active source and shadowed list at each step.
- Process-level e2e (real bin through the real CommandRunner): `lang list` and `lang test toy` with root flags exit 0; `lang test nosuch` exits 1; invalid repo copy gives a `manifest_invalid` warning and exit 0; a manifest whose `precise.command` would write a marker file lists and tests fine and the marker never exists.

## Deviations from Plan

None to the plan's behaviour. Notes:

- TDD was not strictly red-first: the registry tests and implementation for each task were written together and landed in one commit per task (the plan's two tasks), with the full suite run before each commit.
- The Memtrace-first guard blocked `cat`/`Read`/`grep` on indexed source in the fresh worktree, so I ran `codegraph init -y` in the worktree (as the global CLAUDE.md instructs) and read through `codegraph node -f`. `.codegraph/` was never staged.
- The `lang test` not-found message now reads "is not an existing module folder or a known module id" (code unchanged).

## Known Stubs

None.

## Threat Flags

None. T-01-36 and T-01-38 are mitigated and tested; registry.ts imports no `child_process`.

## Self-Check: PASSED

- src/lang/registry.ts and src/lang/registry.test.ts exist; commits 9266420 and 11f64cc are on HEAD.
