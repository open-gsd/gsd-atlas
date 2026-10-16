---
phase: 01-foundations-and-walking-skeleton
plan: 03
subsystem: infra
tags: [eslint, flat-config, module-boundaries, github-actions, ci, supply-chain]

requires:
  - phase: 01-foundations-and-walking-skeleton
    provides: "package.json scripts, tsconfig pair, src/facts, src/test-kit, src/host-client, src/bin (plans 01-01, 01-04)"
provides:
  - "eslint.config.js: generated per-module no-restricted-imports / no-restricted-syntax blocks (FND-07)"
  - "Exports MODULES, SQLITE_OWNERS, ADAPTERS, CLOSED_IMPORTS, TEST_CONTEXT_FILES, patternsFor, syntaxFor for fixture tests"
  - "src/lint/boundaries.test.ts: 79 fixture cases (one violation plus controls per rule) and a real-tree lint test"
  - ".github/workflows/ci.yml: static, test (3 OS x Node 24.16.0/26) and grammar (3 OS) jobs (FND-01)"
  - "scripts/ci-config.test.ts: universal safety assertions over every workflow file"
affects: [01-05, 01-07, 01-09, 01-10, 01-11, 01-12, 01-13, 01-14, 01-15, 01-16, 01-17]

plan_head_before: ae258aa4bcf04b24b4cad53cf6d27e260eb3d536
plan_head_after: e8553b0f560b4edba1396e1085099ac4b3926ad0

actuals:
  tokens: 9600    # chars/4 over the 4 files written (38,542 chars)
  tasks: 3
  commits: 3      # MEASURED: git rev-list --count ae258aa..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "One complete rule block per module plus a later test-context block, because flat config replaces rule options between blocks"
    - "Leaf and production-purity properties enforced as lint rules, not conventions"
    - "Line-oriented regex assertions over workflow YAML, no YAML library"

key-files:
  created:
    - eslint.config.js
    - src/lint/boundaries.test.ts
    - .github/workflows/ci.yml
    - scripts/ci-config.test.ts
  modified: []

key-decisions:
  - "eslint.config.js uses defineConfig from eslint/config instead of tseslint.config(): the latter is marked @deprecated in typescript-eslint 8.71.2 and defers to ESLint core"
  - "Adapter test files (src/cli, src/mcp-shim *.test.ts and contract.ts) may import test-kit; production adapter files still import only host-client"
  - "Dynamic import() and require() selectors for test-kit and contract use relative-path regexes (esquery regex literals cannot contain a slash)"
  - "The parse guard also applies in grammar-engine test files, and the with-tree.ts override block keeps the module's other selectors"

patterns-established:
  - "Fixture-test shape: ESLint lintText with a virtual src/<module>/x.ts path, a case table carrying group, expected outcome, optional rule id and optional message text"
  - "ci-config test discovers .github/workflows/*.yml by glob so later workflows are checked automatically"

requirements-completed: [FND-07, FND-01]

duration: 30min
completed: 2026-10-15
status: complete
---

# Phase 1 Plan 03: Boundary lint and three-OS CI Summary

**ESLint boundary rules generated per module (child_process, SQLite, index.ts-only imports, policy, adapters, leaves, production purity, parser guard) with 79 fixture cases, plus a SHA-pinned, read-only, script-free three-OS CI workflow guarded by a static test.**

## Performance

- **Duration:** about 30 min
- **Tasks:** 3 (1 tracer, 2 auto/tdd)
- **Files created:** 4

## Accomplishments

- A deliberate violation of each ROADMAP SC1 rule fails lint: child_process outside `src/command-runner`, `src/sqlite` or a SQLite driver outside its owners, a deep import past another module's `index.ts`, `policy` importing anything but `facts`, and an adapter importing anything but `host-client`. Each has a positive control.
- `facts` and `test-kit` are lint-enforced leaves (`CLOSED_IMPORTS`), so a command-runner to test-kit cycle cannot exist. Production purity forbids `node:test`, any test-kit path and any `contract.ts` outside test context (static, dynamic and require forms, plus `export * from`), so the compiled package cannot load a contract suite or the test kit.
- D-12 stays literal: a test in another module importing `../command-runner/contract.ts` still fails the deep-import rule.
- The parser guard bans `.parse(` member calls (except `JSON.parse`) in `src/grammar-engine` outside `with-tree.ts`.
- `npm run lint` exits 0 on the real tree and the real-tree test asserts zero boundary findings under `src/**/*.ts`.
- `.github/workflows/ci.yml` runs `static` once on ubuntu, `test` on ubuntu/macos/windows x Node 24.16.0/26, and `grammar` on all three OSes with the only wasi toolchain cache. Every action is a verified 40-hex SHA with a version comment (checked with `gh api`, including the tag-to-SHA mapping for v7.0.1, v7.1.0 and v6.1.0).
- `scripts/ci-config.test.ts` enforces on every workflow file: pinned `uses:`, `contents: read` only, no `pull_request_target`, `persist-credentials: false`, `npm ci --ignore-scripts` and no `npm install`, `fail-fast: false`, `cancel-in-progress: true`, `defaults.run.shell: bash`, and `timeout-minutes` per job. A mutation run (unpinned tag, bare npm ci, missing persist-credentials, fail-fast true) failed four tests, then was restored.

## Task Commits

1. **Task 1: Tracer, child_process rule** - `9fb1a93` (feat)
2. **Task 2: One fixture per remaining rule, leaf and purity, real tree** - `57d2b92` (test)
3. **Task 3: CI workflow and static safety test** - `e8553b0` (feat)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tseslint.config is deprecated**
- **Found during:** Task 1
- **Issue:** the plan names `tseslint.config(...)`; typescript-eslint 8.71.2 marks it `@deprecated` in favour of ESLint core `defineConfig`.
- **Fix:** `eslint.config.js` default-exports `defineConfig([...])` from `eslint/config`; `tseslint.parser` is still the parser.
- **Files modified:** eslint.config.js
- **Commit:** 9fb1a93

**2. [Rule 3 - Blocking] Config import failed typecheck**
- **Found during:** Task 2
- **Issue:** `import('../../eslint.config.js')` in the test gave TS7016 (no declaration for a JS config).
- **Fix:** import by file URL and cast to a local `ConfigExports` interface.
- **Files modified:** src/lint/boundaries.test.ts
- **Commit:** 57d2b92

### Judgement calls within the plan

- Adapter test files may import `test-kit`. The plan's test-context list was "complete list minus the three purity patterns", which would have left an adapter-only ban on test-kit in `cli`/`mcp-shim` tests. That contradicts the plan's own statement that test files may use test-kit and would block `src/cli/cli.test.ts` (plans 01-14, 01-17). Test files still cannot import `lang`, `facts` or any other module. Fixtures `cli test file may use the test kit` and `cli test file still may not import lang` pin this.

No plan content was dropped. No auth gates.

## Issues Encountered

- A first draft of the case table contained one self-contradicting case (command-runner test importing child_process expecting a pass under a "may not" name); it was rewritten before running. All 79 cases passed on the first run of the final table, so teeth were checked by the rule-id and message assertions on each violation case rather than by a red-first run per case: the generator was written whole in Task 1 as the plan directs, and Task 1's test was proven red (no config) before the config existed.
- Worktree tooling blocked compound `git`/`gh` shell forms; commands were split into plain calls.

## Known Stubs

None.

## Threat Flags

None. The workflow uses no secrets, no `pull_request_target` and read-only permissions.

## Self-Check: PASSED

- FOUND: eslint.config.js, src/lint/boundaries.test.ts, .github/workflows/ci.yml, scripts/ci-config.test.ts
- FOUND commits: 9fb1a93, 57d2b92, e8553b0 (all ancestors of HEAD)
- `node --test src/lint/boundaries.test.ts` 79/79, `node --test scripts/ci-config.test.ts` 16/16, `npm run lint` exit 0, `npm run typecheck` exit 0, `npm test` 170/170.

## Carry forward

- The CI workflow has not been executed; its first real run is plan 01-15. Scripts it names that do not exist yet (`schema-build.ts`, `grammar-*.ts`, `ensure-tree-sitter.ts`) come from plans 01-06, 01-07 and 01-12.
- Later plans that add a module directory not in `MODULES` (for example `src/lint` is intentionally unlisted) get no boundary rules until it is added to `MODULES` in `eslint.config.js`.
