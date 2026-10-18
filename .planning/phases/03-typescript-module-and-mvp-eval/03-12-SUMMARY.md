---
phase: 03-typescript-module-and-mvp-eval
plan: 12
subsystem: shared-kernel
tags: [facts, degraded-codes, answer-id, envelope, eslint, module-boundaries, diagnostics]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "mcp-contract amendment of 2026-10-18 (fourteen degraded codes, envelope extra answer_id) from plan 03-08"
provides:
  - "DEGRADED_CODES with fourteen entries (memory_budget, compiler_fallback, needs_approval appended)"
  - "createAnswerId, isAnswerId, ANSWER_ID_PATTERN in the facts kernel, re-exported from src/facts/index.ts"
  - "EnvelopeExtras.answer_id (optional, never serialized when absent)"
  - "'diagnostics' in the eslint MODULES table with production and test boundary blocks and 17 fixture cases"
affects: [03-13, 03-18, 03-21, 03-32]
actuals:
  tokens: 4398
  tasks: 2
  commits: 2
commits: 2
plan_head_before: 455baaa40a3f4dc910e8ea67aea5602201c80bbc
plan_head_after: ac90ea7b26cbd488da9d7f6fb91c562a442d1f53
tech-stack:
  added: []
  patterns:
    - "Additive kernel growth: new degraded codes append to the end, earlier order untouched; unknown codes are not codes and never throw"
    - "Injectable random source (RandomBytes) defaulting to node:crypto randomBytes, so id shape is testable without mocks"
    - "A new module is born with its lint walls: add to MODULES and the per-module block builder emits both blocks"
key-files:
  created:
    - src/facts/answer-id.ts
  modified:
    - src/facts/degraded.ts
    - src/facts/request.ts
    - src/facts/index.ts
    - src/facts/facts.test.ts
    - eslint.config.js
    - src/lint/boundaries.test.ts
key-decisions:
  - "createAnswerId takes only an optional random source (no request, tool, path or answer), so no answer data can reach an id; a source returning other than 8 bytes throws"
  - "diagnostics is added to MODULES only: no CLOSED_IMPORTS, ADAPTERS or SQLITE_OWNERS entry; the existing per-module builder yields the production and test blocks with no code change"
requirements-completed: [SEC-02, SKL-02]
coverage:
  - id: D1
    description: "Fourteen degraded codes, earlier eleven first and in order; isDegradedCode true for the three new codes and false for future_code"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "src/facts/facts.test.ts#is exactly the fourteen codes of the contract, the earlier eleven first and in order"
        status: pass
      - kind: unit
        ref: "src/facts/facts.test.ts#[edge SEC-02/forward-compat] an unknown code is not a code and never throws"
        status: pass
    human_judgment: false
  - id: D2
    description: "Answer id is random, content-free and strictly shaped (a_ plus 16 lower-case hex), with an injectable source"
    requirement: "SKL-02"
    verification:
      - kind: unit
        ref: "src/facts/facts.test.ts#answer id shape / answer id random (5 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "EnvelopeExtras.answer_id survives a JSON round trip and leaves no key when absent or undefined"
    requirement: "SKL-02"
    verification:
      - kind: unit
        ref: "src/facts/facts.test.ts#okEnvelope keeps answer_id and the envelope round-trips through JSON"
        status: pass
      - kind: unit
        ref: "src/facts/facts.test.ts#an envelope built without answer_id has no answer_id key"
        status: pass
    human_judgment: false
  - id: D4
    description: "diagnostics module walls: no child_process, no SQLite driver or src/sqlite, no deep imports, not importable by cli or mcp-shim, host reaches it through index.ts only"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "src/lint/boundaries.test.ts#diagnostics: (17 cases) and config exports the documented tables"
        status: pass
      - kind: other
        ref: "npm run lint; npm test (2996 tests, 0 failures)"
        status: pass
    human_judgment: false
duration: 35min
completed: 2026-10-18
status: complete
---

# Phase 3 Plan 12: Shared kernel additions and diagnostics lint boundary Summary

**The facts kernel now carries fourteen degraded codes (memory_budget, compiler_fallback, needs_approval added additively) and a random, content-free `answer_id` helper plus envelope extra, and the future `diagnostics` module is walled off by lint (no process, no SQLite, no deep imports, no adapter access) before it has any code.**

## Performance

- **Duration:** about 35 min (start time was not captured at spawn; estimated)
- **Completed:** 2026-10-18T05:42Z
- **Tasks:** 2
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- `DEGRADED_CODES` grows from eleven to fourteen; the header comment says what each Phase 3 code means. `isDegradedCode('future_code')` is false and never throws, so consumers keep treating unknown codes as "degraded, reason unknown".
- `src/facts/answer-id.ts`: `ANSWER_ID_PATTERN = /^a_[0-9a-f]{16}$/`, `createAnswerId(random = randomBytes)` and `isAnswerId(value)`. The only input is an optional random source; nothing about a request, tool, path or answer can reach the id (T-03-121).
- `EnvelopeExtras.answer_id?: string`; the existing `definedExtras` filter already keeps JSON free of undefined keys, now covered by tests.
- `eslint.config.js`: `'diagnostics'` in `MODULES` (comment names SKL-03 and SKL-04). The per-module builder emitted both blocks with no further edits. 17 `diagnostics:` fixture cases cover each rule: child_process (static and dynamic), node:sqlite, better-sqlite3, src/sqlite, deep import, cli and mcp-shim and cli test file blocked, host through index.ts allowed and host deep import blocked, facts stays a leaf, production vs test-file purity, plus positive controls (facts index, zod).

## Task Commits

1. **Task 1: Tracer - degraded codes and answer id through the kernel** - `f264362` (feat)
2. **Task 2: Boundary rules for the diagnostics module** - `ac90ea7` (chore)

**Plan metadata:** the docs commit that adds this file.

## TDD record

The plan is `type: execute` with `tdd="true"` tasks, so there is no separate `test(...)` commit; the plan specifies one commit per task. RED was still observed on the real assertions before GREEN:

- Task 1: with the new tests and a stub `answer-id.ts` (returns an empty string), `node --test src/facts/facts.test.ts` failed on the planned assertions (`'' !== 'a_00112233445566ff'`, missing exception for a wrong-length source, the fourteen-code list). Then the real implementation made it pass.
- Task 2: with the 17 new cases and no `MODULES` entry, 13 `diagnostics:` cases and the `config exports the documented tables` test failed on the planned assertions (14 failures); adding `'diagnostics'` made all 123 boundary tests pass.

## Files Created/Modified

- `src/facts/answer-id.ts` - answer id pattern, creator (injectable random source) and guard
- `src/facts/degraded.ts` - three new codes and updated header
- `src/facts/request.ts` - optional `answer_id` on `EnvelopeExtras`
- `src/facts/index.ts` - re-exports `ANSWER_ID_PATTERN`, `createAnswerId`, `isAnswerId`
- `src/facts/facts.test.ts` - fourteen-code list, unknown-code case, five answer-id cases, three envelope cases
- `eslint.config.js` - `'diagnostics'` in `MODULES`
- `src/lint/boundaries.test.ts` - 17 diagnostics cases; config-table test now expects 22 modules and checks diagnostics is no SQLite owner, adapter or closed module

## Decisions Made

- An id source that returns other than eight bytes throws instead of silently producing a short or odd id.
- The plan's `RandomBytes` type is exported from `answer-id.ts` but not re-exported from the kernel index (nothing outside needs it yet).

## Deviations from Plan

### Auto-fixed Issues

**1. [Plan assumption, no code change] Metrics validator rejects an unknown degraded code instead of dropping the dimension**
- **Found during:** Task 1 (reading `src/metrics/validate.ts`)
- **Issue:** The plan's truth and behavior bullet say the metrics validator "drops the dimension instead of failing" for a hand-made envelope with `degraded: ['future_code']`. `validateEvent` actually rejects the whole event with the fixed reason `bad_degraded` (the closed-vocabulary privacy rule of MET-01). It never throws, which is the safety property that matters here. `src/metrics/metrics.test.ts` already pins the rejection (`a degraded value outside the closed set`) and asserts the reason never echoes the input.
- **Fix:** Left the validator untouched (not in this plan's `files_modified`, and changing it would contradict the existing MET-01 test). The kernel-side forward-compat case in `facts.test.ts` asserts what the kernel owns: `isDegradedCode('future_code')` is false and never throws, and a consumer filtering an envelope from a newer host keeps only the codes it knows. The facts module is closed (lint), so its test cannot import the metrics module.
- **Consequence to know about:** if a future host ever emitted a code a running metrics validator did not know, that one answer's metrics event would be discarded, not counted with the code dropped. Both sides ship in one package today, so this cannot happen yet; revisit if hosts and clients ever version independently.
- **Files modified:** none
- **Commit:** n/a

**2. [Rule 3 - Blocking] Worktree CodeGraph index needed for the read guard**
- **Found during:** Task 1 setup
- **Issue:** The repo's read guard blocks plain `Read` on indexed `.ts` files unless a `codegraph node` span for this worktree's own index precedes it; the first spans came from the parent checkout's index and did not satisfy it.
- **Fix:** Ran `codegraph init -y` in the worktree and used `--path` spans. The generated `.codegraph/` directory is untracked and removed before return.

**Total deviations:** 1 plan-assumption note, 1 environment blocker. **Impact:** none on behavior or scope.

## Issues Encountered

None beyond the above.

## Known Stubs

None.

## Threat Flags

None. No new endpoint, auth path, file access or schema surface was introduced; `createAnswerId` reads only the system random source.

## Verification

- `node --test src/facts/facts.test.ts src/metrics/metrics.test.ts src/lint/boundaries.test.ts`: 235 pass, 0 fail (Task 1), later boundaries 123 pass
- `npm run typecheck`: clean
- `npm run lint`: clean
- `npm test`: 2996 tests, 2995 pass, 0 fail, 1 skipped (pre-existing skip)
- Acceptance criteria: degraded.ts contains all three new codes; answer-id.ts exports the three names; facts.test.ts titles include `fourteen codes`, `answer id shape`, `answer id random`, `unknown code is not a code`; eslint.config.js contains `'diagnostics'` in `MODULES`; 17 boundary cases titled `diagnostics:`.

## Next Phase Readiness

The approval, ratings, diagnostics and precise-tier plans can use `needs_approval`, `memory_budget`, `compiler_fallback`, `createAnswerId` and `EnvelopeExtras.answer_id` from `src/facts/index.ts`, and can create `src/diagnostics/` under ready-made lint walls. Plans that add more modules (03-18, 03-21, 03-32 also edit `eslint.config.js` and `boundaries.test.ts`) must bump the `MODULES.length` assertion from 22 accordingly.

REQUIREMENTS.md was not touched (shared-ID gate: SEC-02 and SKL-02 are declared by other plans; the orchestrator owns that update). STATE.md and ROADMAP.md were not touched, per the dispatch instructions.

## Self-Check: PASSED

- Created and modified files all present on disk: `src/facts/answer-id.ts`, `src/facts/degraded.ts`, `src/facts/request.ts`, `src/facts/index.ts`, `src/facts/facts.test.ts`, `eslint.config.js`, `src/lint/boundaries.test.ts`.
- Commits `f264362` and `ac90ea7` are ancestors of HEAD; `git rev-list --count 455baaa..HEAD` was 2 before this SUMMARY commit.
