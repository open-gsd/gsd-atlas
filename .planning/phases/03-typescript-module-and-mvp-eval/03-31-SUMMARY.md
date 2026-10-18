---
phase: 03-typescript-module-and-mvp-eval
plan: 31
subsystem: edge-precision-sample
tags: [oq9, prd-criterion-1, edge-sample, stratified-sample, wilson-interval, independent-verifiers, tdd]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-16 frozen Stage A (D-08 precondition; scripts/eval/oracle.ts and stats.ts used as the independent code); 03-24 citations table (schema version 2); 03-25 resolved_relations and scripts/relations-check.ts (census, fixture shapes); 03-29 eager resolution (the resolved_edges the sample draws from); OQ9 Confirmed in 03-DECISIONS.md; eval.bootstrapSeed in 03-CONSTANTS.md"
provides:
  - "scripts/edge-sample.ts: loadPopulation (read-only SQL over the store file), drawSample (seeded stratified), six verify* functions, renderTable, runEdgeSample, runCli; exit 0 at or above 0.98, 1 below, 2 for usage or an unreadable store"
  - "docs/eval/edge-sample.md: the reviewed sample of 100 EXTRACTED facts of the pinned gsd-core, 100 of 100 correct, Wilson 95% interval 0.963 to 1.000, with the human confirmation pending"
affects: [03-37]
tech-stack:
  added: []
  patterns:
    - "The verifier shares nothing with the system under test: node:sqlite read-only for the facts, the oracle's frozen helpers and a fresh TypeScript parse or program for the truth, no import from src/ (a test greps the import lines)"
    - "A review table is generated above a marker and hand-written below it; a regeneration keeps everything from the marker on, and the header names the code commit, not the table commit, so regenerating after committing the table changes nothing"
    - "A verifier is itself audited: the whole population is run through it to find verifier defects, and corrupted copies of real facts are shown to it to prove it is not blind"
key-files:
  created:
    - scripts/edge-sample.ts
    - scripts/edge-sample.test.ts
    - docs/eval/edge-sample.md
  modified: []
key-decisions:
  - "Six strata (definition, import, export, reference_edge, relation, citation) with the relation kinds extends, implements and overrides listed as sub-rows even at zero. The floor is min(10, floor(n / strata with facts)) per stratum, the rest in proportion to population with largest remainders, capped by each stratum's size; a stratum with no facts is skipped and the sample is topped up from the others. Each stratum has its own mulberry32 stream from (seed + index * golden ratio constant), so a change in one stratum's share never moves another stratum's draw."
  - "The store keeps an import as specifier and span (the file it names is worked out at read time), so there is no stored target to compare. The import verifier checks the specifier at the span with a fresh parse and, for a relative specifier, that the oracle's emit-aware resolution finds either no program file or one the index holds."
  - "A qualified name is checked against the chain of definitions in the scoping the grammar modules document (a class expression and an object literal method are not links), not against every enclosing declaration; the first reading flagged 91 correct definitions in vendored bundles."
  - "Gate by integer arithmetic (correct * 50 >= total * 49), so 98 of 100 is at the gate and not a floating-point accident."
  - "The seed is a required argument (the approved eval.bootstrapSeed 20261017 is named in the usage text), and the atlas commit in the header is the last commit that changed src, modules, schemas or the script."
requirements-completed: [TSM-01, TSM-04]
status: complete
commits: 5
plan_head_before: 6ef95cb5ea7199102e1672d4990d0a19f3c2f0bd
plan_head_after: 9af82a111057d6e8e7cfed245bbb3e04f23a094e
actuals:
  tokens: 35600
  tasks: 2
  commits: 5
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 31: Edge precision sample on the pinned gsd-core Summary

**A seeded, stratified sample of 100 EXTRACTED facts of the pinned gsd-core (definitions, imports, exports, precise reference edges, relations, ADR citations), drawn with `eval.bootstrapSeed` from the store with plain read-only SQL and checked by code that imports nothing from atlas, is 100 of 100 correct (Wilson 95% interval 0.963 to 1.000, gate 0.98 met); the human confirmation of twenty rows is queued.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | The sampler draws and independently verifies facts of every stratum on the oracle fixture | beb2db1 | 7093da8 |
| 2 | Run it on the pinned gsd-core, commit the table, queue the human confirmation | (the table is generated; the fixes it needed are in Task 1's commits) | 9af82a1 |
| - | Follow-ups: header names the code commit (35f2578); a preparation record is read when present (15ffc48) | - | 35f2578, 15ffc48 |

The tracer gate (task type `tracer`, no `gate="blocking-human"`, `HUMAN_VERIFY_MODE` end-of-phase, automated-only `<verify>`): `node --test scripts/edge-sample.test.ts && npm run typecheck` was re-run after the commit (21 tests, typecheck clean) and passed, so the plan expanded. The RED commit holds the test file only and failed to load (`scripts/edge-sample.ts` did not exist).

## What was built

- **Population.** `loadPopulation(dbPath, {worktree})` opens `facts.db` through `node:sqlite` with `readOnly: true`, refuses a schema version other than 2 (`WRITTEN_FOR_SCHEMA_VERSION`; a test compares it with `SCHEMA_VERSION`), refuses a store with several snapshots of derived data, and reads the six strata with SQL over `overlay_files`, `files`, `symbols`, `names`, `imports`, `exports`, `citations`, `resolved_edges` and `resolved_relations`. A relation also looks up the span of its `from` symbol so the table can say where it is.
- **Draw.** `drawSample(strata, n, seed)` as described under key decisions; the same strata, `n` and `seed` give the same list, another seed another list, no fact twice.
- **Verifiers.** Definition: a fresh `createSourceFile` has a declaration of that kind and name at the span (start after `export`, `default`, `declare` only; end give or take one `;` or `,`) nested as the qualified name says. Import: described above. Export: a fresh parse has, at the span, a statement or assignment that exports the name (ES `export`, re-exports, `export default`, `export =`, and `module.exports = {...}`, `exports.x =`, `module.exports.x =`, `exports['x'] =` in CommonJS). Reference edge: the oracle's `symbolAt` and `canon` (alias-resolved) on the identifier at the site, in a program built from the tracked tsconfig files (the requested one first), has a declaration at the stored target path with the stored qualified name and kind; declaration files are looked up in the program. Relation: the heritage clause of the subtype holds the stored base with the matching `extends` or `implements` token (checker type for forms such as `Mixin(Base)`); an override is a member the owner class's base chain declares at the stored path. Citation: the oracle's comment scanner and pattern find the stored number at the span inside a comment. Every file read is checked against the blob id the overlay recorded; a fact whose file is gone, differs, or is in no program is `unverifiable` and counts as wrong.
- **Table and command.** `renderTable` is deterministic Markdown (header, overall line with the Wilson interval, per-stratum and per-relation-kind counts including zeros, the 100 rows with a blank Human column, a Wrong or unverifiable section). `composeFile` keeps everything from `<!-- edge-sample:notes -->` on, so the hand-written notes and the human confirmation survive a regeneration. A `.eval-prepared.json` record in the checkout is read and must agree with the checkout's commit; `--prepared` makes it required.

## Verification

`npm run typecheck`, `npm run lint`, `npm run build` and `npm run schema:check` clean. `node scripts/eval/verify-prereg.ts`: ok (no Stage A file touched). `npm test`: 4,194 tests, 4,192 pass, 0 fail, 2 skipped (both pre-existing), against 4,172 on the base commit (22 new, all in `scripts/edge-sample.test.ts`). No flake in the full run.

### The sample (pinned gsd-core `10ac3a7`, prepared per OQ8, macOS arm64, Node 26.11.1)

`node scripts/edge-sample.ts --dir "$GSD_ATLAS_EDGE_SAMPLE_DIR" --n 100 --seed 20261017 --out docs/eval/edge-sample.md`, exit 0:

| Stratum | Population | Sampled | Correct |
|---------|-----------|---------|---------|
| definition | 25,230 | 27 | 27 |
| import | 13,771 | 19 | 19 |
| export | 3,465 | 12 | 12 |
| reference_edge | 15,273 | 20 | 20 |
| relation (22 extends; implements and overrides 0) | 22 | 10 | 10 |
| citation | 3,253 | 12 | 12 |
| overall | 61,014 | 100 | 100 (precision 1.000, Wilson 95% 0.963 to 1.000) |

The index was a fresh build with the built binary into an isolated store, followed by `refs` for each of the 16 interfaces that have a subtype (relations are stored when first asked for; the plan did not mention this step, so the table's notes list it). Regenerating the table after committing it leaves the file unchanged.

### Audits of the verifiers (not part of the claim; recorded in the table's notes)

- Audit of 6,000 facts: 97 flagged, all verifier defects (91 qualified-name readings, 3 declaration-file sites, 3 alphanumeric ADR section details). Fixed with regression tests.
- Audit of all 61,014 facts after the fixes: 61,012 correct; the two flagged were one more verifier defect (a chained CommonJS export `exports.A = exports.EVENTS = void 0;`, fixed with a test) and one atlas defect (below).
- Health check: 600 real facts were corrupted one field at a time and shown to the verifiers; every corrupted fact was flagged (233/233, 132/132, 41/41, 145/145, 10/10, 39/39 per corruption).
- I opened the twenty rows whose # is a multiple of five at their cited lines in the checkout and each is true. This is not the human confirmation the plan asks for.

## Deviations from Plan

**1. [Interpretation] The import stratum has no stored target**
- The behavior list says an import is checked against "the stored target file". The store keeps the specifier and the span; the target is worked out at read time. The verifier checks the specifier at the span and that the oracle's resolution finds either nothing or a file the index holds. A resolution to a file the index lacks would be wrong.

**2. [Rule 2 - Missing] The relation stratum is empty after a plain build**
- The eager pass of plan 03-29 stores reference edges, not relations, so the run needs the `refs` step above before sampling. Recorded in the table's notes.

**3. [Rule 1 - Bug, in the new verifiers] Four verifier defects found by auditing the population**
- A class expression and an object literal method counted as links of a qualified name (91 flagged); a stored ADR section detail longer than the digits the oracle reads (`§5d`, `§OpenCode`); a site in a `.d.cts` file; a chained CommonJS assignment. All four fixed in 7093da8 with regression cases in `scripts/edge-sample.test.ts`. The regression cases were written with the fix and not before it: the failures were observed in the audit runs, not in a test. Everything else follows RED then GREEN.

**4. [Scope] A real atlas defect found outside the sample, not fixed**
- `lockMod.withLedgerLock(cwd, fn)` at `src/refactor-trigger-command-router.cts:436` is stored as a precise reference to the module-local function `withLedgerLock` (line 417), while the compiler resolves it to the property signature of a type literal declared inside that function (lines 419, 424). Cause: `mapTarget` in `src/precise-resolver/typescript/identity.ts` accepts a grammar symbol with the declaration's name whose span merely contains the name token. One edge of 15,273, not drawn by the seeded sample, so the plan's "fix at the cause" duty (which is for facts the sample finds) does not apply, and the file belongs to plans 03-23 and 03-29. A fix could require the compiler declaration kind (property signature) to be compatible with the grammar symbol kind (function), or carry the symbol's name-token position in `LocatedSymbol`. Recorded in the table's notes.

**5. [Detail] Interface choices**
- `--seed` is required; `--store` (or `GSD_ATLAS_STORE_DIR`) names the index, since the plan's command has no store argument; the header's atlas commit is the last commit that changed `src`, `modules`, `schemas` or the script, so committing the table cannot change it. The plan's verify command (no `--prepared`) gives the same table as the `--prepared` run because the preparation record is read when present.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-03-311: verifiers use the compiler, the oracle's helpers and the file text only; a test greps the import lines of `scripts/edge-sample.ts` for `src/`; the corrupted-store, mutation and spot-read checks show they are not blind; the human confirmation of twenty rows is pending. T-03-312: seed from the approved constants, the same seed in every run of the claim, unverifiable counts as wrong, all 100 rows committed, the audits' other seeds are labelled and unused for the claim. T-03-313: read-only connection, a test that the store file's bytes and modification time are unchanged and a test that every `new DatabaseSync(` carries `readOnly: true`.

## Open items

- **Human confirmation (queued for the phase verifier):** a person opens `docs/eval/edge-sample.md`, takes the twenty rows whose # is a multiple of five, and confirms each against the source at the cited line in the prepared checkout (`node scripts/eval/prepare-corpus.ts --corpus gsd-core --dest <dir>`); the Human confirmation section of the table says `Status: pending`.
- The `mapTarget` defect of Deviation 4, for a later plan or the phase gap review.
- The output sections of the table are regenerated by the script; the Human column of the rows stays blank unless a person fills it in the committed file by hand (a regeneration would blank it, so confirmations go in the Human confirmation section, which is kept).

## Self-Check: PASSED

- Files present: scripts/edge-sample.ts, scripts/edge-sample.test.ts, docs/eval/edge-sample.md and this summary.
- Commits beb2db1, 7093da8, 35f2578, 15ffc48 and 9af82a1 are ancestors of HEAD; `git rev-list --count 6ef95cb..HEAD` was 5 before this file was added.
