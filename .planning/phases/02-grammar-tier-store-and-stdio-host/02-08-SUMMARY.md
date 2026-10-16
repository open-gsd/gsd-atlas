---
phase: 02-grammar-tier-store-and-stdio-host
plan: 08
subsystem: grammar
tags: [tree-sitter, wasm, grammar-lock, typescript, javascript, corpus, goldens]

requires:
  - phase: 01-foundations
    provides: grammar pipeline (prepareSource, buildWasm, grammar.lock v2, per-platform hashes), Grammar Engine, lang test, parse-budget gate, corpora manifest
provides:
  - upstream lock sources accept `generate: false` (build from the parser.c the pinned archive ships)
  - built-in modules `typescript` (.ts .cts .mts) and `javascript` (.js .cjs .mjs .jsx) as pinned, hash-verified data with a tracer tags query, fixture and golden
  - scripts/module-goldens.ts (write or --check goldens for any module)
  - scripts/corpus-fetch.ts (fetchCorpus at the manifest SHA into a throwaway directory)
affects: [02-13 language queries and recall harness, 02-26 Windows grammar hash, CI grammar job, Phase 3 modules]

actuals:
  tokens: 10900
  tasks: 3
  commits: 6
plan_head_before: 109846c4433ad8e486d0b4cb989a9cecd1f0e4e7
plan_head_after: 5e6a36e7f9a500e41a7bcef830e9602bb3079b71

tech-stack:
  added: []
  patterns:
    - "lock `source.generate: false` selects build-only from the shipped parser.c (pure buildCommands helper)"
    - "built-in module = manifest + grammar.lock + committed wasm + queries + fixtures/*.golden.json under modules/<name>"

key-files:
  created:
    - modules/typescript/atlas-lang.json
    - modules/typescript/grammar.lock
    - modules/typescript/grammar.wasm
    - modules/typescript/queries/tags.scm
    - modules/typescript/fixtures/basic.ts
    - modules/typescript/fixtures/basic.ts.golden.json
    - modules/javascript/atlas-lang.json
    - modules/javascript/grammar.lock
    - modules/javascript/grammar.wasm
    - modules/javascript/queries/tags.scm
    - modules/javascript/fixtures/basic.cjs
    - modules/javascript/fixtures/basic.cjs.golden.json
    - scripts/module-goldens.ts
    - scripts/corpus-fetch.ts
    - scripts/corpus-fetch.test.ts
  modified:
    - src/lang/grammar-lock.ts
    - src/lang/grammar-lock.test.ts
    - scripts/grammar-build.ts
    - scripts/grammar.test.ts
    - scripts/package.test.ts

key-decisions:
  - "generate is an optional boolean on upstream lock sources only; absent means generate (Phase 1 behaviour unchanged)"
  - "No tsx module and no .tsx claim in Phase 2 (user decision 1); .tsx is deferred as a data-only `tsx` module from the same archive with subdir tsx"
  - "linux-x64 wasm.platforms entries for both modules are set equal to the darwin-arm64 hash on the artifact-platform rule; they are not yet CI-measured"
  - "corpus-fetch returns the real (symlink-resolved) path of its fresh checkout"

requirements-completed: [LNG-02]

coverage:
  - id: D1
    description: "Lock schema and build pipeline support generate:false; buildCommands is pure and serializeLock keeps canonical source key order"
    requirement: LNG-02
    verification:
      - kind: unit
        ref: "src/lang/grammar-lock.test.ts#upstream source generate flag; scripts/grammar.test.ts#buildCommands, serializeLock with the upstream generate flag, prepareSource generate false"
        status: pass
    human_judgment: false
  - id: D2
    description: "typescript and javascript built-in modules rebuild reproducibly from the pinned npm archives on darwin-arm64, load, pass lang test and the parse budget (ratio 0)"
    requirement: LNG-02
    verification:
      - kind: other
        ref: "node scripts/grammar-verify.ts modules/typescript; node scripts/grammar-verify.ts modules/javascript; node scripts/grammar-build.ts modules/typescript modules/javascript"
        status: pass
      - kind: other
        ref: "node src/bin/gsd-atlas.ts lang test modules/typescript; ... modules/javascript; node scripts/grammar-budget.ts modules/typescript modules/javascript"
        status: pass
      - kind: unit
        ref: "scripts/grammar.test.ts#built-in modules (modules/*)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Pinned-corpus fetch helper checks a corpus out at its manifest SHA in a fresh directory outside the repo"
    verification:
      - kind: unit
        ref: "scripts/corpus-fetch.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "linux-x64 and win32-x64 rebuild hashes for the new modules match CI"
    verification: []
    human_judgment: true
    rationale: "Only darwin-arm64 was measured locally; linux-x64 is recorded by the artifact-platform rule and win32-x64 is recorded from the first Windows CI run in plan 02-26. CI must confirm."

duration: 7min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 08: Built-in TypeScript and JavaScript modules Summary

**Grammar pipeline builds from an upstream archive's shipped parser.c (`source.generate: false`) and uses it to produce the pinned, reproducible `typescript` (tree-sitter-typescript 0.23.2, ABI 14) and `javascript` (tree-sitter-javascript 0.25.0, ABI 15) built-in modules, plus module-golden and pinned-corpus-fetch tools.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-10-16T18:03:17Z
- **Completed:** 2026-10-16T18:10:42Z
- **Tasks:** 3 (Task 1 is a tracer)
- **Files modified:** 20 (15 created, 5 modified)

## Accomplishments

- `GrammarLockSchema` upstream source gains optional `generate`; `buildCommands` (pure) returns one `build --wasm` step when false; `prepareSource` fails with `source_missing` when `generate` is false and the archive ships no `src/parser.c`; `serializeLock` writes `generate` after `subdir`.
- `modules/typescript` builds in about 8 s to a 1,415,400-byte WASM (sha256 `d2439218...a87f`), `modules/javascript` to 413,064 bytes (`7ccbce5b...cbfe`). `grammar-verify` (two independent rebuilds plus ABI check) passes for both on darwin-arm64.
- Both modules pass `lang test` and `grammar-budget` (0 error bytes), and `lang list --builtin-dir modules` lists both as `builtin` with no inactive extensions or collisions. Goldens were checked by hand against the fixtures (for example `shout` at 12:6-12:11, its declarator at 12:6-12:42).
- `scripts/module-goldens.ts <moduleDir> [--check]` generates or checks the golden of every fixture a manifest claims.
- `scripts/corpus-fetch.ts` fetched `gsd-path` at its pinned SHA from GitHub into a scratch directory (smoke test, directory removed) and refuses `swift-reference-app` (`unselected`).

## Task Commits

1. **Task 1 (tracer): skip-generate lock mode and the typescript module** - RED `b747a1e` (test), GREEN `7edd213` (feat)
2. **Task 2: javascript module and cross-module checks** - RED `bb17c98` (test), GREEN `ffb45c3` (feat)
3. **Task 3: pinned-corpus fetch helper** - RED `5813754` (test), GREEN `5e6a36e` (feat)

**Tracer gate:** `<verify>` was automated-only and `human_verify_mode` is `end-of-phase`, so the verify commands were re-run end to end after the Task 1 commit (lang test, rebuild check, grammar-verify) and passed before expansion.

## TDD Evidence

| Task | RED target | Classifier | Semantic assessment |
|------|------------|------------|---------------------|
| 1 | `accepts generate false and generate true on an upstream source` (src/lang/grammar-lock.test.ts) | RED_EVIDENCE_OK | Failed on `assert.equal(result.ok, true)`: strict schema rejected the unknown key. scripts/grammar.test.ts also failed to load (missing `buildCommands` export); that load fault was not used as RED evidence. |
| 2 | `ships exactly the typescript and javascript modules` (scripts/grammar.test.ts) | RED_EVIDENCE_OK | Failed on its assertion (modules/javascript absent); three sibling cases failed with ENOENT on the same absence. |
| 3 | `builds the GitHub https URL from the manifest repo` (scripts/corpus-fetch.test.ts) | RED_EVIDENCE_OK | Failed against a stub returning an empty URL; fetchCorpus cases failed against a stub that rejects `not implemented`. |

The RED evidence records are under `.planning/red-evidence-02-08-t{1,2,3}.json` and were deliberately left untracked.

## Files Created/Modified

See `key-files` above. `modules/*/grammar.wasm` are the committed artifacts; each `grammar.lock` pins the npm tarball sha256 (typescript `0fdf63c3...78a1`, javascript `6214ce23...ffb92`), license MIT, CLI 0.27.1.

## Decisions Made

- `generate` stays upstream-only and optional so every Phase 1 lock keeps its meaning; the toy lock still serializes byte-for-byte.
- `.tsx` is not claimed by any module in Phase 2 (user decision 1). Deferred: a data-only `tsx` module from the same archive (`subdir: tsx`).
- The linux-x64 entries equal the darwin-arm64 hash because the project treats those two as byte-identical artifact platforms; this is an assumption for these two grammars until CI measures it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Installed-tarball test hard-coded an empty built-in module list**
- **Found during:** Task 1 (full `npm test` after adding modules/typescript)
- **Issue:** `scripts/package.test.ts` asserted `lang list` on an installed tarball returns `[]`; the package now ships built-in modules (`files` already whitelists `modules`), so the assertion became false.
- **Fix:** The test now computes the expected names from the repository's `modules/` directories and asserts every listed module is `builtin`, so later plans adding modules do not need to touch it.
- **Files modified:** scripts/package.test.ts
- **Verification:** `node --test scripts/package.test.ts` 9/9 pass; full `npm test` 1040/1040.
- **Commit:** `7edd213`

**2. [Rule 2 - Missing critical] Guard for generate:false without a shipped parser**
- **Found during:** Task 1
- **Issue:** With `generate: false` an archive lacking `src/parser.c` would fail deep inside the CLI with an opaque error.
- **Fix:** `prepareSource` throws `source_missing` naming `src/parser.c`; hermetic test added.
- **Files modified:** scripts/grammar-build.ts, scripts/grammar.test.ts
- **Commit:** `7edd213`

**3. [Rule 1 - Bug] corpus-fetch CLI skipped the id when no `--dest` was given**
- **Found during:** Task 3 smoke test
- **Issue:** `destIndex + 1` evaluated to 0 when `--dest` was absent, so argument 0 was excluded from the id search.
- **Fix:** Exclude the destination operand only when `--dest` is present.
- **Commit:** `5e6a36e`

**Total deviations:** 3 auto-fixed (2 bug, 1 missing-critical). **Impact:** none on scope; all contained in plan files plus one existing test.

## Authentication Gates

None.

## Issues Encountered

- The first `fetchCorpus` test compared against a non-resolved temp path on macOS (`/var` vs `/private/var`); the test now uses the test kit's `realPath`.
- `npm run lint` only covers `src`, so the new scripts are covered by `npm run typecheck` and the tests, not eslint.

## Known Stubs

None.

## Threat Flags

None. The only network paths are the npm tarball fetch (already hash-checked before extraction) and the corpus fetch (dev-time, fresh directory outside the repo); both match the plan's threat model (T-02-22, T-02-24). No prebuilt third-party WASM is used.

## Next Phase Readiness

- Plan 02-13 can expand `queries/tags.scm` and add fixtures; `scripts/module-goldens.ts` and `scripts/corpus-fetch.ts` are ready for the recall harness.
- Open item for CI: confirm the linux-x64 rebuild hashes of both modules equal the recorded values, and record win32-x64 from the first Windows run (plan 02-26). Until then the Windows grammar job fails loudly with the computed hash by design.

## Self-Check: PASSED

- All 15 created files and 5 modified files exist on disk.
- Commits `b747a1e`, `7edd213`, `bb17c98`, `ffb45c3`, `5813754`, `5e6a36e` are ancestors of HEAD; `git rev-list --count` from the recorded base gives 6.
- `npm test` 1040/1040, `npm run typecheck` and `npm run lint` clean; all plan `<verify>` and `<acceptance_criteria>` commands re-run and pass.
