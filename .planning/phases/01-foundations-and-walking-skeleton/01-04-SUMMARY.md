---
phase: 01-foundations-and-walking-skeleton
plan: 04
subsystem: kernel
tags: [typescript, node-test, fact-model, host-client, test-kit]
requires: []
provides:
  - "src/facts: dependency-free kernel (Span, Diagnostic, Clock, FileFacts + validator, Answer, Watermark, DegradedCode, Request, Envelope, resolution contracts)"
  - "src/host-client: HostClient interface with adapter-facing re-exports"
  - "src/test-kit: FakeClock, makeTempDir, realPath"
affects: [01-09, 01-10, 01-11, 01-12, 01-13, 01-14]
tech-stack:
  added: []
  patterns:
    - "Kernel leaf: src/facts imports only siblings and node: built-ins"
    - "Spans are 0-based line, 0-based UTF-16 column, end exclusive"
    - "Reads never throw for missing data: empty data plus a DegradedCode"
key-files:
  created:
    - src/facts/index.ts
    - src/facts/span.ts
    - src/facts/diagnostic.ts
    - src/facts/clock.ts
    - src/facts/file-facts.ts
    - src/facts/answer.ts
    - src/facts/degraded.ts
    - src/facts/request.ts
    - src/facts/resolution.ts
    - src/facts/facts.test.ts
    - src/host-client/index.ts
    - src/host-client/host-client.test.ts
    - src/test-kit/index.ts
    - src/test-kit/fake-clock.ts
    - src/test-kit/tmpdir.ts
    - src/test-kit/test-kit.test.ts
  modified: []
key-decisions:
  - "OverlaySnapshot exposes its path-to-hash map as pathToHash, matching setOverlay(worktree, ref, pathToHash) in the fact-store-interface ADR"
  - "symbolKey joins repo, path, qualifiedName, kind and discriminator with NUL, which cannot occur in a path; an absent discriminator maps to the empty string"
  - "TempDir.cleanup is synchronous: it closes adopted handles in reverse order, always removes the directory (maxRetries 5, retryDelay 100), then rethrows any close failure"
  - "validateFileFacts reports span_missing for an absent span and span_invalid for a present but malformed one"
requirements-completed: [FND-05]
status: complete
duration: 25min
completed: 2026-10-16
commits: 4
plan_head_before: 3576e2be5e8316f004c08d89af3cb14531124e98
plan_head_after: 1ad20ca32b45e434e9acf54e5471ecd5b514feba
actuals:
  tokens: 9500
  tasks: 2
  commits: 4
---

# Phase 1 Plan 04: Shared kernel, HostClient seam and test kit Summary

**Frozen cross-seam types in `src/facts` (FileFacts with a mandatory-span validator, Answer/Watermark, eight degraded codes, Request/Envelope v1, resolution contracts), the `HostClient` interface, and a test kit with a deterministic FakeClock and a Windows-safe temp directory.**

## Performance

- **Tasks:** 2 of 2 complete, 37 tests passing under `node --test`
- **Commits:** 4 (a RED and a GREEN commit per task)

## Accomplishments

- Task 1 (tracer): `Span` documents the 0-based / UTF-16 / end-exclusive convention and the BOM/CRLF text policy; `validateFileFacts` rejects missing or inverted spans (`span_missing`, `span_invalid`), bad parse numbers (`parse_invalid`) and non-objects (`facts_invalid`); `FACT_PREDICATES` carries the 16 predicates; `FakeClock` wakes sleepers in due-time order; `makeTempDir` closes adopted handles first and removes with retries. Tracer re-verified end to end before expanding.
- Task 2: `Answer`, `Watermark`, `DEGRADED_CODES` (exactly eight), `PROTOCOL_VERSION = 1`, `Request`, `Envelope`, `okEnvelope`, `failEnvelope`, `SymbolIdentity` with `symbolKey`, `OverlaySnapshot`, `ResolutionContext`, `RefSiteKey`, `ResolvedEdge`, `SymbolLookup`, and `HostClient` with `Request`, `Envelope`, `Diagnostic` and `PROTOCOL_VERSION` re-exported so adapters never import facts.

## Task Commits

| Task | Commit | Type |
| ---- | ------ | ---- |
| 1 RED | c15520c | test |
| 1 GREEN | a49d0b7 | feat |
| 2 RED | 8c9ad6b | test |
| 2 GREEN | 1ad20ca | feat |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixtures assigned to readonly fields**
- **Found during:** Task 2, ad hoc `tsc --strict` check of all three directories
- **Issue:** Three Task 1 tests mutated `readonly` properties of `FileFacts`, which would fail the typecheck run in plan 01-03.
- **Fix:** Built the bad values with object spread instead of assignment.
- **Files modified:** src/facts/facts.test.ts
- **Commit:** 1ad20ca

### Environment notes (not plan deviations)

- The worktree base commit contains no `.planning/` directory (it is untracked in the main checkout), so the plan, CONTEXT and RESEARCH were read from the main checkout read-only. All writes and commits are inside the worktree.
- No `node_modules` or `@types/node` exist, so the typecheck was an ad hoc `tsc 7.0.2 --strict --erasableSyntaxOnly --verbatimModuleSyntax --noUncheckedIndexedAccess --exactOptionalPropertyTypes --module esnext --moduleResolution bundler` run, filtered of `node:` module resolution errors. It was clean apart from those. The real typecheck belongs to plan 01-03 and the wave gate.
- Acceptance greps over the source files were not run with `grep` because a repository guard blocks it; the content was verified by construction and by the passing tests.

## Known Stubs

None.

## Threat Flags

None. T-01-09 (span rule) and T-01-10 (temp-dir cleanup) are mitigated as planned.

## Issues Encountered

- `node --test` prints `MODULE_TYPELESS_PACKAGE_JSON` warnings until plan 01-01 adds `"type": "module"`; harmless.

## Next Phase Readiness

Plans 01-09 to 01-14 can import from `src/facts/index.ts`, `src/host-client/index.ts` and `src/test-kit/index.ts`. The facts and test-kit leaf rules are enforced by plan 01-03 once merged.

## Self-Check: PASSED

All 16 files present; commits c15520c, a49d0b7, 8c9ad6b and 1ad20ca are ancestors of HEAD; `node --test` over the three test files reports 37 passing, 0 failing.
