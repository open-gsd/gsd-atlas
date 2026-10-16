---
phase: 01-foundations-and-walking-skeleton
plan: 12
subsystem: grammar-engine
tags: [web-tree-sitter, wasm, grammar-engine, parse-quality, utf-16, confined-reader, contract-suite]
status: complete

requires:
  - phase: 01-03
    provides: boundary lint (parse-call selector, contract.ts purity rule, MODULES list already contains grammar-engine)
  - phase: 01-04
    provides: Span and Diagnostic kernel types, test-kit makeTempDir
  - phase: 01-06
    provides: parseManifest and the Manifest schema (parseBudget default 0.005)
  - phase: 01-07
    provides: toy module wasm, grammar.lock, queries and fixtures (basic, emoji, crlf, bom, broken)
provides:
  - "Grammar Engine seam: createGrammarEngine (web-tree-sitter 0.27.1), createFakeGrammarEngine, measureErrors, stripBom, GRAMMAR_LIMITS, typed GrammarLoadError and GrammarRunError"
  - "withTree: the single parse call site, deletes the tree in finally"
  - "defineGrammarEngineContract plus loadToyScenarios (test-only, not exported from the index), run against real and fake"
  - "readModuleInputs: realpath-confined, size-capped module reader returning manifest, lock and GrammarInput or diagnostics"
  - "scripts/grammar-budget.ts (checkBudget, runCli) and npm run grammar:budget"
  - "test/fixtures/modules/toy/atlas-lang.json"
affects: [01-13, 01-14, 01-15, 01-17, phase-02]

plan_head_before: 8c9202eb4ca2e5b89d617f9ce2aa2a79b3d5b625
plan_head_after: cd73b05966415acea2e92e23ae2d83e6bfd06a49

actuals:
  tokens: 19000   # chars/4 over the 20 files changed (about 76 KB of text)
  tasks: 3
  commits: 3      # MEASURED: git rev-list --count 8c9202e..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "Hash gates the load: size caps, then sha256 against grammar.lock, then Language.load on the verified bytes (never a path)"
    - "web-tree-sitter init memoised inside the engine factory closure, not at module level; a failed init is not cached"
    - "Every WASM object is released in finally (tree in withTree, cursor in measureErrors, parser and queries in dispose)"
    - "Fake engine shares size-cap helpers with the real one; one contract suite is registered for both, with the fake scripted from the real engine's output and cross-checked against hand-written emoji expectations"
    - "CLI scripts export a runCli(argv, write) so tests run them in-process; the entry guard compares import.meta.url with the realpath of argv[1]"

key-files:
  created:
    - src/grammar-engine/index.ts
    - src/grammar-engine/engine.ts
    - src/grammar-engine/load.ts
    - src/grammar-engine/check.ts
    - src/grammar-engine/limits.ts
    - src/grammar-engine/types.ts
    - src/grammar-engine/errors.ts
    - src/grammar-engine/with-tree.ts
    - src/grammar-engine/query.ts
    - src/grammar-engine/normalize.ts
    - src/grammar-engine/measure.ts
    - src/grammar-engine/fake.ts
    - src/grammar-engine/contract.ts
    - src/grammar-engine/grammar-engine.test.ts
    - src/grammar-engine/measure.test.ts
    - src/lang/module-files.ts
    - src/lang/module-files.test.ts
    - scripts/grammar-budget.ts
    - scripts/grammar-budget.test.ts
    - test/fixtures/modules/toy/atlas-lang.json
  modified: []

key-decisions:
  - "Parse quality counts UTF-8 bytes inside outermost ERROR nodes; traversal prunes subtrees without errors and never descends into an ERROR"
  - "web-tree-sitter 0.27.1 reports UTF-16 indexes and columns for string input (verified: emoji string columns 4 to 10, accented name 3 to 8), so normalisation needs no conversion"
  - "The measured fixture set is regular files in the fixtures folder whose extension the manifest claims, excluding names containing .golden; an empty set fails instead of passing silently"
  - "A lock over 64 KiB is reported as lock_invalid because the plan's diagnostic code list has no lock_too_large"

patterns-established:
  - "Confined module read: path.resolve then fs.realpathSync, require realpath inside the module folder's realpath plus a separator (sibling-prefix safe), open then fstat then bounded read with one byte of slack"
  - "Independent module reads report all problems at once instead of stopping at the first"

requirements-completed: [FND-05, LNG-06]

duration: about 50 min
completed: 2026-10-15
---

# Phase 1 Plan 12: Grammar Engine, Parse Budget and Confined Module Reader Summary

**Real web-tree-sitter 0.27.1 Grammar Engine that verifies the wasm hash before loading, returns UTF-16 spans and ERROR-byte measurements, with a fake sharing one contract suite, a symlink-safe module reader, and a CI parse-budget script.**

## Performance

- Duration: about 50 minutes
- Tasks: 3 of 3, 3 task commits
- Full suite at the end: 417 tests passing; typecheck, lint and build clean

## Accomplishments

- Tracer: the toy wasm loads only when its sha256 matches grammar.lock (checked before `Language.load`; garbage bytes with a wrong hash fail with `wasm_hash_mismatch`, not `wasm_invalid`). tags, refs and imports captures come back sorted with exact spans: the emoji string import is line 1 columns 4 to 10, the accented name line 2 columns 3 to 8, the call target line 3 columns 2 to 6. CRLF input gives the same spans as LF input, a BOM is stripped and reported as `hadBom` (name `a` at line 0 columns 3 to 4).
- Typed failures: `wasm_hash_mismatch`, `wasm_invalid`, `wasm_too_large` (8 MiB), `query_error` (message carries web-tree-sitter's text, for example `Bad field name 'nme'`), `query_too_large` (256 KiB), `engine_init_failed`; run-time `source_too_large` (2 MiB) and `parse_failed`.
- LNG-06: `measureErrors` sums UTF-8 bytes of outermost ERROR nodes (multi-byte characters count bytes, not UTF-16 units), counts MISSING nodes separately, deletes its cursor in `finally`. broken.toy measures 9 error bytes of 20 (ratio 0.45); all clean fixtures measure 0.
- Real-engine and fake-engine both pass one `defineGrammarEngineContract` (registered twice, 13 contract cases each). The fake validates hash and caps identically; its scripted results are generated from the real engine and asserted equal to hand-written emoji.toy spans so it cannot echo wrong data.
- `readModuleInputs` rejects symlink escapes (including a sibling folder sharing the module folder's name prefix), missing and oversized files, and invalid manifests and locks, without throwing, reporting every independent problem at once.
- `npm run grammar:budget` exits 0 on the toy module (errorBytes 0, totalBytes 202); `node scripts/grammar-budget.ts test/fixtures/modules/toy --fixtures-dir fixtures-negative` exits 1 with ratio 0.45 against budget 0.005.

## Task Commits

1. Task 1 (tracer): `6854dce` feat(01-12): real Grammar Engine loads hash-pinned wasm and returns exact UTF-16 spans
2. Task 2: `da63851` feat(01-12): measure ERROR bytes, add fake engine and one contract run against both
3. Task 3: `cd73b05` feat(01-12): confined module reader, toy manifest and per-module parse-budget script

Tracer gate (interactive, `human_verify_mode` end-of-phase, automated-only verify): the tracer's `<verify>` was re-run end to end after the commit (12 engine tests, typecheck, lint all green) before expanding.

## Deviations from Plan

### Auto-fixed Issues

None needed for correctness. Structural additions and judgement calls, all inside the plan's intent:

**1. [Rule 3 - Structure] Extra files in src/grammar-engine**
- The plan listed errors, load, with-tree, query, normalize, measure, fake, contract and index. I added `types.ts` (shared types, avoids an index import cycle), `limits.ts` (one set of caps for engine, fake and reader), `check.ts` (size-cap helper and sha256 shared by real and fake) and `engine.ts` (createGrammarEngine implementation, so `index.ts` stays a pure export list).
- The hash comparison itself is stated in both `load.ts` and `fake.ts` (each contains the literal `wasm_hash_mismatch` as the acceptance criteria require); only the size caps and the message text are shared.

**2. [Rule 3 - Signature] `defineGrammarEngineContract(label, make)`**
- `make` receives the scenarios (`make(scenarios)`), and the contract loads them itself through the cached `loadToyScenarios()` so callers pass nothing else. This matches the plan's two-argument form.

**3. [Judgement] Budget script measured set**
- Plan said "every non-golden regular file in the fixtures folder". I also require the file's extension to be one the manifest claims, so a stray README or a future `*.golden.json` cannot be parsed as toy source. An empty measured set fails with a problem rather than passing.

**4. [Judgement] CLI testability**
- `scripts/grammar-budget.ts` exports `runCli(argv, write)` and the tests call it in-process, so no test spawns a child process (FND-06 spirit). The actual `node scripts/grammar-budget.ts ...` forms were also run by hand and exit 0 and 1 as specified.

**5. Tooling note**
- The worktree had no `.codegraph/` index, and a repo hook routes reads of indexed source through CodeGraph; per the user's global CLAUDE.md I ran `codegraph init -y` in the worktree. `.codegraph/` is untracked and was not committed.

## Threat Model Status

- T-01-29 (mitigate): size caps, sha256 before instantiation, typed load errors, realpath containment and symlink rejection; all tested.
- T-01-31 (mitigate): withTree and measureErrors delete in `finally` (leak tests with delete counters, including a real-tree faulty-callback case); one Parser per loaded grammar, deleted on dispose; the plan 01-03 lint rule keeps parse calls inside with-tree.ts.
- T-01-30 (accept): unchanged; per-parse time limits arrive with the Phase 2 worker.

## Known Stubs

None. (The Task 1 placeholder values for errorBytes and missingNodes were replaced by measureErrors in Task 2.)

## Threat Flags

None. No network endpoints or new trust boundaries beyond the module-folder boundary the plan already models.

## Issues Encountered

None. The 2 MiB source cap is measured in UTF-8 bytes (the plan said "2 MiB"; bytes is the natural unit and agrees with the ERROR-byte accounting).

## Next Phase Readiness

Plan 01-14 can load a module end to end with `readModuleInputs(dir)` then `createGrammarEngine().load(result.input)`. Plan 01-15's CI test job can run `npm run grammar:budget`. No contingency split was needed (Task 3 ran with room to spare).

## Self-Check: PASSED

- Files: all 20 files listed under key-files.created exist.
- Commits: 6854dce, da63851 and cd73b05 are ancestors of HEAD.
