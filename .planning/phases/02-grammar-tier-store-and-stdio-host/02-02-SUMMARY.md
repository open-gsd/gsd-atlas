---
phase: 02-grammar-tier-store-and-stdio-host
plan: 02
subsystem: facts-kernel
tags: [typescript, node-test, fact-model, envelope, clock]

requires:
  - phase: 01-walking-skeleton
    provides: "src/facts kernel (FileFacts, Envelope, DEGRADED_CODES, Clock), FakeClock test kit"
provides:
  - "Optional FileFacts fields: LocalSymbol.exported, RefSite.kind/enclosing, ImportSite.style/bindings, FileFacts.exports, with REF_KINDS and IMPORT_STYLES"
  - "validateFileFacts range-checks enclosing/parent and closed-set checks kind/style/bindings/exports"
  - "Eleven degraded codes (reconciling, rebuilding, watermark_moved added)"
  - "Full optional Envelope (citations, watermark, untrusted_text, truncated, more, hints, retry_after) via okEnvelope/failEnvelope extras"
  - "Clock.after(ms, fn) cancellable timer on systemClock and FakeClock"
affects: [02-extractor, 02-fact-store, 02-query, 02-indexer, 02-host, 02-governor]

actuals:
  tokens: 8000
  tasks: 3
  commits: 6
plan_head_before: 9d1326c087130a7ebc821576b9c1b932286c21a8
plan_head_after: 26227b7

tech-stack:
  added: []
  patterns:
    - "Additive-only kernel growth: every new field optional, Phase 1 values and call sites unchanged"
    - "Envelope extras copied through a defined-keys filter so JSON never carries undefined keys"
    - "Single ordered timer list in FakeClock for sleepers and after callbacks, cancel by identity"

key-files:
  created: []
  modified:
    - src/facts/file-facts.ts
    - src/facts/degraded.ts
    - src/facts/request.ts
    - src/facts/index.ts
    - src/facts/clock.ts
    - src/facts/facts.test.ts
    - src/test-kit/fake-clock.ts
    - src/test-kit/test-kit.test.ts

key-decisions:
  - "Citation.debug is a string handle (draft-mcp-contract: 'debug handle'); Citation has no text field, only the optional text_ref, so repo text can only travel in untrusted_text"
  - "exports is validated as an optional array; a non-array value is facts_invalid rather than ignored"
  - "systemClock.after does not unref its timer: a pending timer is legitimate work"

patterns-established:
  - "Index-valued optional fields (parent, enclosing) are range-checked against the symbols array in validateFileFacts"

requirements-completed: [LNG-04, QRY-01]

coverage:
  - id: D1
    description: "FileFacts can carry exports, reference kinds, enclosing symbols and import bindings, all optional, with validation"
    requirement: LNG-04
    verification:
      - kind: unit
        ref: "src/facts/facts.test.ts#validateFileFacts with the Phase 2 optional fields"
        status: pass
    human_judgment: false
  - id: D2
    description: "Eleven degraded codes and the full optional response envelope with retry_after"
    requirement: QRY-01
    verification:
      - kind: unit
        ref: "src/facts/facts.test.ts#DEGRADED_CODES, #Envelope extras (QRY-01)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Cancellable Clock.after on systemClock and FakeClock"
    verification:
      - kind: unit
        ref: "src/test-kit/test-kit.test.ts#FakeClock after cases; src/facts/facts.test.ts#systemClock.after"
        status: pass
    human_judgment: false
  - id: D4
    description: "No new Envelope field carries repo text outside untrusted_text (prohibition QRY-01)"
    requirement: QRY-01
    verification: []
    human_judgment: true
    rationale: "Prohibition is judgment-verified per the plan; tests only assert Citation key structure."

duration: 9min
completed: 2026-10-16
status: complete
---

# Phase 2 Plan 02: Kernel Extensions Summary

**Additive FileFacts (exports, reference kinds, enclosing symbols, import bindings), eleven degraded codes, a full optional response Envelope and a cancellable Clock.after, all with Phase 1 values unchanged.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-10-16T17:41:01Z
- **Completed:** 2026-10-16T17:50:00Z
- **Tasks:** 3 (6 commits: RED and GREEN each)
- **Files modified:** 8

## Accomplishments
- `FileFacts` expresses exports, `RefSite.kind` and `enclosing`, `ImportSite.style` and `bindings`, `LocalSymbol.exported`; `validateFileFacts` rejects out-of-range `enclosing`/`parent`, unknown kinds and styles, empty binding names and exports without a valid span, and still accepts Phase 1 values and the all-empty value.
- `DEGRADED_CODES` is eleven codes; `okEnvelope(schema, data, diagnostics?, extras?)` and `failEnvelope(schema, diagnostics, extras?)` add citations, watermark, untrusted_text, truncated, more, hints and `retry_after` (ms) without undefined-valued keys.
- `Clock.after` returns an idempotent cancel; `FakeClock` fires sleepers and timers in one due-order list with ties in call order.

## Task Commits

1. **Task 1 (tracer): optional export, reference-kind and import-binding facts** - `2f5cd99` (test, RED), `7385563` (feat)
2. **Task 2: degraded codes and the full envelope** - `634f77d` (test, RED), `c945d48` (feat)
3. **Task 3: cancellable Clock.after** - `6df2889` (test, RED), `26227b7` (feat)

**Plan metadata:** docs commit (SUMMARY, STATE, ROADMAP, REQUIREMENTS)

## RED evidence (semantic assessment)

- Task 1: 12 of the new target tests failed on assertions (0 diagnostics where 1 expected; `REF_KINDS` undefined via a namespace import so the file loaded). Planned behavior was absent, no load or syntax fault.
- Task 2: 5 target tests failed on assertions (eight codes instead of eleven, extras dropped).
- Task 3: 8 target tests failed with `after is not a function` inside the target tests; the file loaded and other cases passed.
- `gsd_run check tdd-red-evidence` was not run: the plan is `type: execute` with per-task `tdd="true"`, not a plan-level `type: tdd` gate.

## Files Created/Modified
- `src/facts/file-facts.ts` - REF_KINDS, IMPORT_STYLES, ImportBinding, ExportSite, optional fields, extended validator
- `src/facts/degraded.ts` - three new codes, comment updated
- `src/facts/request.ts` - Citation, UntrustedEntry, UntrustedText, EnvelopeExtras, extended Envelope and helpers
- `src/facts/index.ts` - re-exports
- `src/facts/clock.ts` - `Clock.after`, `systemClock.after`
- `src/test-kit/fake-clock.ts` - unified timer list with `after`
- `src/facts/facts.test.ts`, `src/test-kit/test-kit.test.ts` - new cases

## Decisions Made
See key-decisions. `src/facts` remains a closed leaf (relative imports only); `src/governor/fake.ts` and `governor.test.ts` compile and pass unchanged.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Commit 26227b7 includes a rename staged by plan 02-01**
- **Found during:** Task 3 commit
- **Issue:** Plan 02-01 runs in the same worktree and had staged `docs/adr/draft-worktree-lifecycle.md -> docs/adr/11-worktree-lifecycle.md`; `git commit` swept it into my commit (3 files instead of 2).
- **Fix:** Not rewritten: 02-01 had committed `5446153` on top before I could amend. A `git reset --soft HEAD~1` I ran briefly moved HEAD behind `5446153`; it was restored with `git reset --soft 5446153` and HEAD, index and log were verified identical to before. Later commits use `git commit --only` style pathspecs.
- **Impact:** The ADR rename is attributed to `feat(02-02)` in history; content is 02-01's and unchanged. Orchestrator may want to note this when merging.

**Total deviations:** 1 (Rule 3, process). **Impact on plan:** none on code.

## Issues Encountered
- Full `npm test` shows 4 failures in `scripts/package.test.ts` (build, pack and tarball cases): `node_modules/typescript/bin/tsc` is missing in this worktree. Pre-existing and environmental, logged in `deferred-items.md`; the other 945 tests pass.

## Known Stubs
None.

## Threat Flags
None. T-02-04 mitigated (enclosing/parent range checks tested); T-02-05 mitigated structurally (Citation has no text field).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
Extractor, store, query and Governor plans can import the new types and `Clock.after` from `src/facts/index.ts`.

## Self-Check: PASSED
All eight modified files exist; commits 2f5cd99, 7385563, 634f77d, c945d48, 6df2889, 26227b7 are ancestors of HEAD; facts, test-kit and governor tests pass (103/103); `npm run typecheck` and `npm run lint` exit 0.

---
*Phase: 02-grammar-tier-store-and-stdio-host*
*Completed: 2026-10-16*
