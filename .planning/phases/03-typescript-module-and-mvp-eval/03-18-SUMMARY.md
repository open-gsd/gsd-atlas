---
phase: 03-typescript-module-and-mvp-eval
plan: 18
subsystem: project-model
tags: [project-model, tsconfig, jsonc, differential-test, typescript-7-detection, resolution-context]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-02 jsonc-parser 3.3.1 and the typescript-7 dev alias; 03-08 ADR 5 ProjectModel amendment of 2026-10-18; 03-16 frozen Stage A (D-08 precondition)"
provides:
  - "src/project-model: compiler-free TypeScript ProjectModel (describe, matches, ownerOf, configs, context, compiler)"
  - "detectTypeScriptInstall / selectCompiler / compilerFallbackDiagnostic / BUNDLED_VERSION 6.0.3 (TSM-02)"
  - "buildContext: typescript:<version>:<project|bundled> plus sorted sha256 of every chain file (G4)"
  - "scripts/project-model-differential.ts: corpus differential against ts.parseJsonConfigFileContent"
  - "eslint MODULES entry project-model with a ban on importing typescript in its production files"
affects: [03-19, 03-20, 03-22, 03-23, 03-24, 03-27]
tech-stack:
  added: []
  patterns: ["compiler-free reader behind an injected confined ProjectFs", "differential test against the compiler as the oracle", "diagnostics carry fixed words, never repository text"]
key-files:
  created:
    - src/project-model/index.ts
    - src/project-model/types.ts
    - src/project-model/jsonc.ts
    - src/project-model/tsconfig.ts
    - src/project-model/globs.ts
    - src/project-model/owners.ts
    - src/project-model/context.ts
    - src/project-model/install.ts
    - src/project-model/typescript.ts
    - src/project-model/project-model.test.ts
    - src/project-model/install.test.ts
    - src/project-model/__fixtures__/core-like/tsconfig.json
    - src/project-model/__fixtures__/core-like/tsconfig.build.json
    - scripts/project-model-differential.ts
    - scripts/project-model-differential.test.ts
  modified:
    - eslint.config.js
    - src/lint/boundaries.test.ts
key-decisions:
  - "Default exclude of the output directories uses the MERGED outDir and declarationDir, each read against the config that set it. Measured against TypeScript 6.0.3; the plan text and the research assumed only the config's own compilerOptions."
  - "references are the config's own only (TypeScript does not inherit them); the plan's 'nearest config that sets them' wording was not followed."
  - "Configs are found by directory only as tsconfig.json and jsconfig.json; tsconfig.build.json and similar enter through references or the new optional DescribeInput.extraConfigs."
  - "selectCompiler returns a CompilerChoice; the compiler_fallback diagnostic comes from compilerFallbackDiagnostic(choice). describe() adds it once."
  - "The compiler decision reads package.json from the directory of the lexically first config that owns some overlay file, else the root."
requirements-completed: [TSM-07, TSM-02]
status: complete
commits: 3
plan_head_before: a4a757a43f20c882ad3c398b4fac2b1c0df242df
plan_head_after: 995e2204b84ceba006e1704469c7f32f0f9bd817
actuals:
  tokens: 34500
  tasks: 3
  commits: 3
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 18: Compiler-free ProjectModel and TypeScript detection Summary

**A ProjectModel that reads tsconfig files through an injected confined reader, answers `matches(config, path)` identically to `ts.parseJsonConfigFileContent` on both pinned corpora, picks one owner per file, derives a cache-keying resolution context, and decides between the project's 6.x and the bundled 6.0.3 by reading `package.json` as data.**

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Tracer: core-like fixture, extends, membership equal to the compiler | 5466b9b |
| 2 | extends arrays and packages, JSONC, references, owners, corpus differential | f9d5e47 |
| 3 | Resolution context and install detection with the 7.x fallback cases | 995e220 |

## What was built

- `src/project-model/globs.ts` re-implements the compiler's include/exclude algorithm (spec to regex, base-path walk with directory pruning, supported-extension groups, higher-priority-extension rule with the legacy `.d.ts` exception, invalid-spec rejection). `tsconfig.ts` reads the chain (`extends` string/array/package, `${configDir}`, depth 16, cycle detection, escape detection) and resolves each list against the config that wrote it. `owners.ts` is the nearest-ancestor, plain-name, lexical rule. `install.ts` and `context.ts` are Task 3.
- Lint: `project-model` joins `MODULES` (22 to 23 in `src/lint/boundaries.test.ts`); production files cannot import `typescript`, a subpath or `typescript-7`, statically, dynamically or by `require` (the selector spells `/` as `\x2f` because an esquery regex literal cannot hold a slash). Test files may.

## Differential results (pinned corpora, macOS arm64, network fetch, `--no-npm-ci`)

| Corpus | Configs | Understood | Tracked paths per config | Disagreements | Crashes |
|--------|---------|------------|--------------------------|---------------|---------|
| gsd-core `10ac3a7` | 2 (`tsconfig.json`, `tsconfig.build.json`) | 2 | 3,976 | 0 | 0 |
| gsd-pi `bb86b6c` | 24 | 19 | 5,787 | 0 | 0 |

gsd-core: model 274 files, compiler 274 files for both configs. gsd-pi: all 24 tracked tsconfigs agree (for example `tsconfig.extensions.json` 2,389 files, `tsconfig.resources.json` 999). The 5 not-understood gsd-pi configs extend `../../tsconfig.base.json`, which is not tracked in the pinned checkout; the model reports `extends_unresolved`, the compiler fails the same way, and the file lists still agree.

## Verification

`npm run typecheck`, `npm run lint`, `npm run build` clean. `npm test`: 3444 tests, 3443 pass, 0 fail, 1 skipped (pre-existing skip). New: 31 in `project-model.test.ts`, 11 in `install.test.ts`, 5 in `project-model-differential.test.ts`, 17 new cases in `boundaries.test.ts`. `node scripts/eval/verify-prereg.ts` ok (no Stage A file touched).

## Deviations from Plan

**1. [Rule 1 - Bug in the plan's premise] Output-directory default exclude uses merged options**
- **Found during:** Task 2 (the differential failed on an `outDir` inherited from a base config)
- **Issue:** I had implemented the compiler rule as "only the config's own `compilerOptions.outDir`"; TypeScript 6.0.3 excludes the merged `outDir` and `declarationDir`, each relative to the config that set it (and `${configDir}` relative to the final config).
- **Fix:** `effectiveConfig` uses the merged options; six differential cases pin it.
- **Files modified:** src/project-model/tsconfig.ts, src/project-model/project-model.test.ts
- **Commit:** f9d5e47

**2. [Rule 1] `references` are not inherited**
- **Issue:** The plan lists `references` among the lists "replaced wholesale by the nearest config that sets them". TypeScript excludes `references` from `extends` inheritance.
- **Fix:** `ConfigInfo.references` holds the config's own entries only. Documented in `types.ts`.

**3. [Rule 2] Small API additions**
- `DescribeInput.fs` is optional (falls back to the reader given to `createTypeScriptProjectModel`, which the plan also passes), and `DescribeInput.extraConfigs` was added so the corpus script can describe every tracked `tsconfig*.json` (the plan requires "every tsconfig of the pinned gsd-pi", and only `tsconfig.json`/`jsconfig.json` are found by directory).
- `compilerFallbackDiagnostic(choice)` is a separate export; `selectCompiler` returns just the `CompilerChoice`.
- `owners.ts` was committed with Task 1 (its ownerOf is used by the tracer test), not Task 2.

**4. [Process] One timing flake**
- The first full `npm test` failed `scripts/eval/claude-session.test.ts` ("timeout: kills a slow child within 2 seconds"), a Stage A file I did not touch. It passed alone (51 of 51) and in the second full run. Not caused by this plan.

## Known Stubs

None.

## Threat Flags

None. The only new process start is `scripts/project-model-differential.ts` running `scripts/eval/prepare-corpus.ts` and `git` with argument arrays, dev-time only, and only without `--dir`.

## Threat mitigations (plan register)

- T-03-181: every read goes through the injected `ProjectFs.readText`; a `..` above the root, an absolute path and a refused link give `extends_outside_repo`, `reference_outside_repo` or `compiler_outside_repo` (tests: outside repo, symlink outside repo).
- T-03-182: lint ban plus a source-text test and a `require.cache` test; the model reads `package.json` as JSON only.
- T-03-183: depth 16, cycle detection, cap of 200 configs (`too_many_configs`), reader byte cap, tolerant parsing of hostile configs (test: a hostile config cannot make the model throw).
- T-03-184: `configHashes` and the compiler identity are in the context; tests change a byte, the compiler version and the 7.x layout and show the context changes.

## Self-Check: PASSED

- Files present: src/project-model/{index,types,jsonc,tsconfig,globs,owners,context,install,typescript}.ts, project-model.test.ts, install.test.ts, both fixtures, scripts/project-model-differential.{ts,test.ts}.
- Commits 5466b9b, f9d5e47 and 995e220 are ancestors of HEAD.
