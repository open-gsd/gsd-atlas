---
phase: 02-grammar-tier-store-and-stdio-host
plan: 32
subsystem: facts, fact-store
tags: [validation, WR-05, IN-02, gap-closure]
requires: []
provides:
  - validateFileFacts rejects non-string, empty and NUL-containing names and the other bound text fields
  - files table and writer without the unreachable collected state
affects: [src/facts/file-facts.ts, src/fact-store/writer.ts, src/fact-store/schema.ts]
tech-stack:
  added: []
  patterns: [small field helpers (isFactName, isOptionalString) next to isNonEmptyString]
key-files:
  created:
    - src/facts/names.test.ts
    - src/fact-store/collected-state.test.ts
  modified:
    - src/facts/file-facts.ts
    - src/fact-store/writer.ts
    - src/fact-store/schema.ts
decisions:
  - "SCHEMA_VERSION stays 1 (see below)"
  - "No length cap on names; the writer already bounds rows with MAX_FILE_FACT_ROWS"
metrics:
  tasks: 2
  completed: 2026-10-17
status: complete
actuals:
  tokens: 9000
  tasks: 2
  commits: 2
plan_head_before: 27ae4745b8b40d2ef56534198753f39e59ef3085
plan_head_after: 8dc4f3c
---

# Phase 2 Plan 32: Fact text validation and removal of the collected state Summary

`validateFileFacts` now checks every text field the store binds (names, kinds, optional strings, top-level hash, module and grammar version), and the dead `collected` file state is gone, with a test that states what a collected hash really does.

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Tracer: non-string or empty name rejected at commit, end to end | 5df389f |
| 2 | Remove the dead collected state, document collected-hash behaviour | 8dc4f3c |

## What changed

- **Task 1 (WR-05 part b, LNG-04).** Symbol, reference-site and export `name` must be non-empty strings without NUL; symbol `kind` a non-empty string; `qualifiedName`, `importPath`, export `local` and `from` strings when present; import `path` a string; `contentHash`, `module`, `grammarVersion` non-empty strings. All failures use the existing `facts_invalid` code with the group index and field named. Through a real store (both drivers), `commitFile` with a numeric, empty or NUL name returns `rejected` and writes nothing (no files row, no overlay, no symbol rows). Before the change a numeric name was coerced and committed and a non-coercible one threw a bind error.
- **Task 2 (IN-02, STO-05).** `FILE_STATES` is `['live', 'retired']`; the `files` CHECK matches; the three `state === 'collected'` operands in `commitFile`, `link` and `setOverlay` are removed; the `rewriteFile` comment now describes a stale file only. `collected-state.test.ts` documents the real behaviour: a collected hash committed again gets a new `files.id` and then returns `unchanged` on repeat, `link` answers `hash_unknown`, `setOverlay` stores a pending path (null file id, counted in `stalePaths`), and raw SQL inserting state `collected` fails the CHECK.

## Why SCHEMA_VERSION stays 1

The package has never shipped (version 0.0.0), so no released store carries the wider CHECK. `CREATE TABLE IF NOT EXISTS` leaves an existing development store with its old, wider CHECK, which nothing can trigger because no code writes `collected`. A version bump would force a rebuild for no behavioural gain.

## Deviations from Plan

None - plan executed as written. One sequencing note: the CHECK case was added to `collected-state.test.ts` in the Task 2 commit (not Task 1) so that each commit passes its own verify command; the other three collected-hash cases pass before and after the change because they describe behaviour that already held.

## Verification

- `node --test "src/facts/*.test.ts" "src/fact-store/*.test.ts" scripts/recall.test.ts`: 407 pass, 0 fail.
- Plan verify commands for both tasks, `npm run typecheck`, `npm run lint`: exit 0.
- Full `npm test`: 2260 pass, 0 fail.
- The built-in modules' extraction tests (`src/grammar-engine/extract.test.ts`, `src/lang/extract-toy.test.ts`) pass unchanged.

## Known Stubs

None.

## Threat Flags

None. T-02-109 (malformed fact text reaching the writer) is mitigated by the Task 1 validation and its store-level test.

## Self-Check: PASSED

- src/facts/names.test.ts, src/fact-store/collected-state.test.ts: present.
- Commits 5df389f and 8dc4f3c are ancestors of HEAD.
