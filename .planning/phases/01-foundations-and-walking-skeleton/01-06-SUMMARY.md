---
phase: 01-foundations-and-walking-skeleton
plan: 06
subsystem: language-modules
tags: [zod, json-schema, ajv, manifest, typescript, node-test]
requires: [01-01, 01-04]
provides:
  - "src/lang/manifest.ts: ManifestSchema (strict Zod, schema version 1), Manifest type, parseManifest, manifestJsonSchema, MANIFEST_SCHEMA_VERSION"
  - "schemas/atlas-lang.schema.json: committed JSON Schema 2020-12 generated from the Zod source"
  - "scripts/schema-build.ts: node scripts/schema-build.ts [--check] [file]"
  - "test/fixtures/manifests: two valid and ten invalid manifest fixtures"
affects: [01-12, 01-14, 01-17]
tech-stack:
  added: []
  patterns:
    - "Constraints use built-in Zod checks and .regex() only, never refinement callbacks, so every rule reaches the generated JSON Schema"
    - "Parsers return {ok, ...} results and wrap input handling in try/catch: no input can throw"
    - "Generated artefact committed and guarded by a --check script plus an Ajv test that compiles the committed file"
key-files:
  created:
    - src/lang/manifest.ts
    - src/lang/manifest.test.ts
    - src/lang/schema-parity.test.ts
    - scripts/schema-build.ts
    - schemas/atlas-lang.schema.json
    - test/fixtures/manifests/valid-minimal.json
    - test/fixtures/manifests/valid-full.json
    - test/fixtures/manifests/invalid-unknown-field.json
    - test/fixtures/manifests/invalid-schema-version.json
    - test/fixtures/manifests/invalid-missing-name.json
    - test/fixtures/manifests/invalid-name-case.json
    - test/fixtures/manifests/invalid-absolute-wasm.json
    - test/fixtures/manifests/invalid-drive-letter.json
    - test/fixtures/manifests/invalid-dotdot-query.json
    - test/fixtures/manifests/invalid-backslash-path.json
    - test/fixtures/manifests/invalid-empty-extensions.json
    - test/fixtures/manifests/invalid-parse-budget.json
  modified: []
key-decisions:
  - "Task 1 resolved by the user as option-b (D-04 plus additive optional fields); see Decisions"
  - "One shared relativeAssetPath regex (negative lookaheads plus a negated character class) rejects empty, absolute, drive-letter, backslash, NUL and .. segment forms and is emitted as the same JSON Schema pattern on all six path fields"
  - "scripts/schema-build.ts takes an optional file argument (default schemas/atlas-lang.schema.json) so the drift check is tested against a temp copy instead of mutating the committed file"
  - "kebab-case (^[a-z][a-z0-9-]*$, max 64) is shared by name, project.model and precise.adapter"
requirements-completed: [FND-03]
status: complete
duration: 25min
completed: 2026-10-16
commits: 3
plan_head_before: ae258aa4bcf04b24b4cad53cf6d27e260eb3d536
plan_head_after: d2ea0d6c679358d2acb66c43aea4f391b7d7e0aa
actuals:
  tokens: 8000
  tasks: 3
  commits: 3
---

# Phase 1 Plan 06: Language-module manifest schema Summary

**A strict, versioned Zod manifest (schema version 1) with a never-throwing `parseManifest`, a committed generated JSON Schema 2020-12, and an Ajv test proving the parser and the schema give the same verdict on all twelve fixtures.**

BASE (HEAD at plan start, for the unchanged-package.json criterion): `ae258aa4bcf04b24b4cad53cf6d27e260eb3d536`.

## Decisions

**Task 1 (checkpoint:decision), resolved by the user before execution: `option-b`.** D-04 field names, plus additive optional fields from the PRD and ADRs. `name` is kept (not `id`). The final schema-version-1 field set, implemented exactly and no more:

| Field | Required | Rule |
|-------|----------|------|
| `$schema` | no | string; editor key, no engine meaning |
| `schemaVersion` | yes | literal `1` |
| `name` | yes | `^[a-z][a-z0-9-]*$`, max 64 |
| `version` | no | `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` |
| `extensions` | yes | 1 to 32 strings matching `^\.[A-Za-z0-9]+$` |
| `replace` | no | boolean: this module intentionally replaces another claiming the same extension |
| `grammar` | yes | strict object: `wasm`, `lock` (both required, shared relative-path rule) |
| `queries` | yes | strict object: `tags` required; `refs`, `imports` optional (shared relative-path rule) |
| `tiers` | no | 1 or more of `grammar`, `precise`, `platform`; default `["grammar"]` |
| `parseBudget` | no | number 0 to 1; default `0.005` (D-06) |
| `testGlobs` | no | string array |
| `features` | no | shared relative-path rule |
| `project` | no | strict object: optional `markers` (string array), optional `model` (kebab-case) |
| `precise` | no | either strict `{command: string[]}` (min 1 item, each non-empty) or strict `{adapter: kebab-case}`; never both |

Every object level is `z.strictObject`; an unknown field is rejected. Only `schemaVersion`, `name`, `extensions`, `grammar` and `queries` are required. `version`, `testGlobs`, `features`, `project`, `replace` and `precise` are carried by the parser but not acted on in Phase 1.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Settle the manifest field set (decision, resolved: option-b) | n/a (no code) |
| 2 | Tracer: parseManifest accepts/rejects fixtures and never throws | RED `d1f4759`, GREEN `1628035` |
| 3 | Generated JSON Schema, drift check and Ajv parity test | `d2ea0d6` |

### Task 2 RED evidence (tracer)

- Command: `node --test src/lang/manifest.test.ts` against a stub `parseManifest` that returns `{ok: false, diagnostics: []}`.
- Result: non-zero exit; the target tests (valid fixtures parse, defaults, invalid fixtures name their field, `$schema`, `precise` union) failed on `assert.equal` / `assert.ok` assertions for the planned behaviour, not on load or syntax errors.
- `semanticAssessment`: target tests executed and failed on the planned assertions for the intended reason; the tests that expect `ok: false` with no diagnostics checks passed trivially against the stub, which is expected for a rejecting stub.
- GREEN: the real implementation passed all 32 tests first time; typecheck clean.

Task 3 was written test-first (parity test authored before `manifestJsonSchema()` and the script existed) but run red only as a missing-export load failure, so no separate RED commit was made.

## Verification

- `node --test src/lang/manifest.test.ts src/lang/schema-parity.test.ts`: 82 tests pass (32 + 50).
- `npm run schema:build` then `npm run schema:check`: exit 0 ("current").
- Drift check exercised against a temp copy with one changed character: exit 1, stderr contains `npm run schema:build`. Missing file also exits 1. A CRLF copy compares equal.
- `npm run typecheck`: exit 0.
- `npm test`: 157 tests pass, 0 fail.
- `git diff --numstat ae258aa HEAD -- package.json`: prints nothing (package.json unchanged).
- All twelve fixtures: Zod verdict equals Ajv verdict, and both are true exactly for `valid-*` files. 27 inline edge cases (precise union, NUL, nested and trailing `..`, newline before backslash, name/extension limits, tiers, parseBudget, non-object input) also agree.
- `npm run lint`: fails with "Oops! Something went wrong" because this worktree has no ESLint config. The config belongs to plan 01-03 (same wave, not merged into this base), so this is pre-existing and not caused by this plan; lint of `src/lang` could not be run here and should run in the wave gate.

## Deviations from Plan

**1. [Rule 2 - Test seam] `scripts/schema-build.ts` accepts an optional output/check file argument**
- **Found during:** Task 3
- **Issue:** The plan asks for a verified exit 1 on drift, done by temporarily editing the committed file. That is manual and unrepeatable.
- **Fix:** Optional positional `file` argument (default is the committed path), used by the parity test to check a drifted temp copy. Default behaviour and both npm scripts are unchanged.
- **Files modified:** scripts/schema-build.ts, src/lang/schema-parity.test.ts
- **Commit:** d2ea0d6

**2. [Env] Created a local CodeGraph index in the worktree**
- The repo-level hook guards required CodeGraph for reads of indexed source files, and the worktree had no `.codegraph/`. Per the user's global CLAUDE.md I ran `codegraph init -y`. The directory is untracked and was never staged or committed.

Otherwise: plan executed as written. The plan's note about fixing typecheck errors in plan 01-04 files did not apply (typecheck was clean).

## Auth Gates

None.

## Known Stubs

None. The RED stub in `src/lang/manifest.ts` was replaced in the GREEN commit.

## Threat Flags

None. No new network endpoints, auth paths, file access or schema changes at trust boundaries beyond the plan's threat model. Mitigations:
- T-01-12: one shared regex rejects absolute, drive-letter, backslash, NUL and `..` forms, asserted by parser tests on all six path fields and by Ajv parity (the rule is a JSON Schema `pattern`).
- T-01-13: `parseManifest` is wrapped in try/catch (a throwing Proxy input is tested) and returns diagnostics; name length and extension count are bounded.
- T-01-14: `precise.command` and `precise.adapter` are plain data; nothing in this plan spawns or resolves either (a test parses a non-existent command name and only asserts it round-trips).

## Notes for later plans

- The `.github/workflows/ci.yml` static job calling `npm run schema:check` (key link in the plan) is not in this worktree's base; whichever plan owns CI should wire `schema:check` in.
- Plan 01-12/01-14 add the on-disk realpath containment and manifest size cap; this plan covers the string form only.
- Plan 01-17 requires the registry to enforce that `grammar` is present in `tiers`; the schema deliberately does not.

## Self-Check: PASSED

- FOUND: src/lang/manifest.ts, src/lang/manifest.test.ts, src/lang/schema-parity.test.ts, scripts/schema-build.ts, schemas/atlas-lang.schema.json, twelve files under test/fixtures/manifests
- FOUND commits: d1f4759, 1628035, d2ea0d6 (all ancestors of HEAD)
