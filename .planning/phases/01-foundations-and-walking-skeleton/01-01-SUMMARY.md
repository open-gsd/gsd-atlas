---
phase: 01-foundations-and-walking-skeleton
plan: 01
subsystem: infra
tags: [npm, typescript, node-type-stripping, tsc, node-test, exact-pins, ignore-scripts]

requires: []
provides:
  - "Installable package @opengsd/gsd-atlas with bins gsd-atlas and gsd-atlas-mcp (FND-02)"
  - "package.json with all eleven npm script names later plans rely on, exact pins, engines >=24.16.0"
  - "tsconfig.json (typecheck) and tsconfig.build.json (emit to dist/, test code excluded)"
  - "gsd-atlas --version / -v / --help / -h from TypeScript source and from dist/"
  - "gsd-atlas-mcp stub (Phase 2 notice on stderr, exit 1) and runMcpShim in src/mcp-shim/index.ts"
  - "scripts/package.test.ts: static package invariants, bin parity, production-only dist guard"
affects: [01-02, 01-03, 01-07, 01-16, all later Phase 1 plans]

plan_head_before: 3576e2be5e8316f004c08d89af3cb14531124e98
plan_head_after: ef3108192bd1ede36aea238f9735f1c27416952d

actuals:
  tokens: 2700    # chars/4 over the 9 hand-written changed files; 20400 if the generated package-lock.json is counted
  tasks: 2        # Tasks 3 and 4 executed here; Tasks 1 and 2 were human gates resolved at the orchestrator
  commits: 3      # MEASURED: git rev-list --count 3576e2b..HEAD before this SUMMARY commit

tech-stack:
  added: [web-tree-sitter 0.27.1, zod 4.6.7, tree-sitter-cli 0.27.1, typescript 6.0.3, eslint 10.12.0, typescript-eslint 8.71.2, c8 12.0.0, ajv 8.20.0, ajv-formats 3.0.1, better-sqlite3 13.0.3, "@types/node 24.19.2"]
  patterns:
    - "Native Node type stripping for dev and tests (.ts import extensions, erasableSyntaxOnly, verbatimModuleSyntax)"
    - "tsc emit to dist/ with rewriteRelativeImportExtensions, no bundler"
    - "Every install uses --ignore-scripts; tree-sitter-cli binary fetch is a later explicit step (plan 01-07)"
    - "Test helpers spawn bins via process.execPath with argument arrays, never npm/npx/.cmd shims"

key-files:
  created:
    - .gitignore
    - .gitattributes
    - package.json
    - package-lock.json
    - tsconfig.json
    - tsconfig.build.json
    - src/bin/gsd-atlas.ts
    - src/bin/gsd-atlas-mcp.ts
    - src/mcp-shim/index.ts
    - scripts/package.test.ts
  modified: []

key-decisions:
  - "Task 1 decision: remove-all (stray root package.json, package-lock.json and node_modules/ deleted by the user from the main checkout)"
  - "Task 2 decision: approved web-tree-sitter 0.27.1, tree-sitter-cli 0.27.1, zod 4.6.7, typescript-eslint 8.71.2, eslint 10.12.0, @types/node 24.19.2"
  - "engines.node is >=24.16.0 (user decision 2026-10-15, overrides D-13/FND-02 wording because Node 24.15.0 node:sqlite truncates TEXT at an embedded NUL)"
  - "@types/node pinned exactly to 24.19.2 (plan said all devDependencies exact) rather than the research's ^24.19"
  - "peerDependencies.better-sqlite3 is also exact-pinned and the invariant test checks peer and optional dependency maps as well as dependencies and devDependencies"

patterns-established:
  - "Production-only dist guard: scripts/package.test.ts walks dist/ and scans import/export/import() specifiers (comments stripped) for node:test and test-kit"
  - "dist/ is deleted and rebuilt once per test process so assertions describe current tsc output, not stale files"

requirements-completed: [FND-02]

duration: 25min
completed: 2026-10-16
status: complete
---

# Phase 1 Plan 01: Package scaffold and two runnable bins Summary

**`@opengsd/gsd-atlas` scaffolded as one ESM npm package with exact pins, a reproducible `npm ci --ignore-scripts` install, and both bins running identically from TypeScript source (Node type stripping) and from tsc-emitted `dist/`, guarded by six `node:test` invariants including a production-only build-output check.**

## Performance

- **Duration:** about 25 min
- **Completed:** 2026-10-16
- **Tasks:** 2 executed by this agent (Tasks 3 and 4); Tasks 1 and 2 were human gates resolved by the user at the orchestrator
- **Files created:** 10

## Accomplishments

- Tracer (Task 3): `npm install --ignore-scripts` produced the lockfile; `rm -rf node_modules && npm ci --ignore-scripts` reproduced it (146 packages, 0 vulnerabilities). `node_modules/tree-sitter-cli/tree-sitter` is absent, proving no dependency install script ran (T-01-01). `npm run typecheck` is clean and `node src/bin/gsd-atlas.ts --version` prints `gsd-atlas 0.0.0`.
- Task 4 (TDD): wrote `scripts/package.test.ts` first and ran it red (tests 4 to 6 failed: no `tsconfig.build.json`, no MCP bin), committed RED, then added `tsconfig.build.json`, `src/mcp-shim/index.ts` and `src/bin/gsd-atlas-mcp.ts` and ran it green (6/6).
- From a clean `rm -rf node_modules dist`: `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`, `node dist/bin/gsd-atlas.js --version` (`gsd-atlas 0.0.0`) and `npm test` (6 pass, 0 fail) all succeed. `dist/` contains only `bin/` and `mcp-shim/` output.
- `node dist/bin/gsd-atlas-mcp.js` writes the Phase 2 notice to stderr and exits 1.
- The specifier scan used by Test 6 was exercised separately on a sample with import, `export ... from`, side-effect import and dynamic `import()` forms plus line and block comments: it reported the four real specifiers and ignored both comments.

## Task Commits

1. **Task 1: stray root files decision** - no commit (human gate; `remove-all`, performed by the user in the main checkout; the files never existed in this worktree)
2. **Task 2: legitimacy verification of six [SUS] packages** - no commit (human gate; approved)
3. **Task 3: tracer, scaffold and `--version`** - `7df9b80` (feat)
4. **Task 4 RED: failing package invariant tests** - `3e839d8` (test)
5. **Task 4 GREEN: emit config, MCP bin, shim** - `ef31081` (feat)

REFACTOR was not needed.

## Decisions

- **Task 1: `remove-all`** (chosen verbatim by the user). The three stray untracked paths were deleted by the user from the main checkout before this plan ran, so Task 3 step 1 required no action here and `.planning/forensics/` and `.planning/config.json` were never touched.
- **Task 2: approved**, with publishers and repositories confirmed against github.com/tree-sitter/tree-sitter, colinhacks/zod, typescript-eslint/typescript-eslint, eslint/eslint and DefinitelyTyped/DefinitelyTyped. Approved pairs: `web-tree-sitter@0.27.1`, `tree-sitter-cli@0.27.1`, `zod@4.6.7`, `typescript-eslint@8.71.2`, `eslint@10.12.0`, `@types/node@24.19.2`. Only tree-sitter-cli has an install script.

## Deviations from Plan

### Auto-fixed Issues

None - the plan executed as written, with these small judgement calls that stay inside the plan's intent:

1. **[Rule 2 - hardening] Invariant test also covers peer and optional dependency maps.** The plan names dependencies and devDependencies; the test additionally applies the exact-pin and no-gsd-core/gsd-graph checks to `peerDependencies` and `optionalDependencies`, since `peerDependencies.better-sqlite3` is itself an exact pin and the product-boundary prohibition should not have a loophole. File: `scripts/package.test.ts`. Commit: `3e839d8`.
2. **[Process] Pre-commit ledger file not persisted.** The plan-commit ledger (`gsd-plan-head-before-01-01`) could not be written under the shared `.git/worktrees/` directory because the sandbox refuses compound git-path commands in a worktree. The base SHA (`3576e2b`) was recorded manually from `git rev-parse HEAD` at start and is written into `plan_head_before` above; `commits: 3` was measured with `git rev-list --count 3576e2b..HEAD`.

**Total deviations:** 0 correctness deviations, 1 test hardening, 1 process note.

## Authentication Gates

None.

## Issues Encountered

- `package-lock.json` is about 70 KB of generated content; `actuals.tokens` excludes it (2,700 tokens hand-written, about 20,400 with it). The plan estimate of 63,000 tokens was therefore far above the realized diff.
- The Node used locally is 26.11.1 (npm 11.20.0), not the 24.16.0 floor; the floor lane is exercised by CI in plan 01-03.

## Known Stubs

- `src/mcp-shim/index.ts` / `src/bin/gsd-atlas-mcp.ts`: `gsd-atlas-mcp` is an intentional stub that writes a notice and exits 1 until the MCP server lands in Phase 2 (stated in the plan's truths). Not recorded in the broken-windows ledger because `.planning/WINDOWS.md` does not exist in this worktree and the stub is the plan's explicit deliverable.
- `package.json` scripts `schema:build`, `schema:check`, `grammar:build`, `grammar:verify`, `grammar:budget` and `lint` point at files created by later plans (`scripts/schema-build.ts`, `scripts/grammar-*.ts`, an ESLint config). Intentional per the plan; they are not run here.

## Threat Flags

None. No new network endpoints, auth paths or trust-boundary file access were introduced; T-01-01, T-01-02 and T-01-SC from the plan's threat model are mitigated as described above.

## Next Phase Readiness

- Plans 01-02 onward can rely on every npm script name, the tsconfig rules, `.gitattributes` byte rules and the committed lockfile.
- `tree-sitter-cli` has no binary yet by design; plan 01-07 owns `scripts/ensure-tree-sitter.ts`.
- No blockers.

## Self-Check: PASSED

- Files present: `.gitignore`, `.gitattributes`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `src/bin/gsd-atlas.ts`, `src/bin/gsd-atlas-mcp.ts`, `src/mcp-shim/index.ts`, `scripts/package.test.ts`.
- Commits reachable from HEAD: `7df9b80`, `3e839d8`, `ef31081`.
