---
phase: 01-foundations-and-walking-skeleton
plan: 05
subsystem: testing
tags: [corpora, eval, determinism, commit-sha, node-test, gh-api]

requires:
  - phase: 01-foundations-and-walking-skeleton
    provides: "Plan 01-01 package scaffold: node --test over scripts/**/*.test.ts, type-stripped .ts scripts, tsconfig covering scripts"
provides:
  - "corpora/corpora.json: schemaVersion 1 manifest, four corpora pinned to full commit SHAs plus an explicit unselected Swift reference app (FND-08)"
  - "scripts/corpus.ts: validateCorpora(json): string[] (empty means valid), Node built-ins only"
  - "scripts/corpus.test.ts: 29 offline tests including the committed manifest and README"
  - "scripts/corpus-check.ts: optional online check that each pinned SHA exists upstream (gh api, execFileSync argument array)"
  - "corpora/README.md: fields, re-pin procedure, re-measure warning"
affects: [phase-02 corpus measurements, phase-03 grammar budgets, phase-05 SWF-05 Swift reference app selection]

plan_head_before: ae258aa4bcf04b24b4cad53cf6d27e260eb3d536
plan_head_after: 4f3e1dde9b5385c20fe0d6dc19487f6b28e88af9

actuals:
  tokens: 4300   # chars/4 over the 5 hand-written files (17244 chars)
  tasks: 2
  commits: 4     # MEASURED: git rev-list --count ae258aa..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "Pure validator returning an error-string list, tested with a table of mutations that must each fail"
    - "Online checks live in scripts/*-check.ts, run by hand, never referenced by npm test"
    - "External CLIs invoked with execFileSync and an argument array, never a shell"

key-files:
  created:
    - corpora/corpora.json
    - corpora/README.md
    - scripts/corpus.ts
    - scripts/corpus.test.ts
    - scripts/corpus-check.ts
  modified: []

key-decisions:
  - "Pinned entries accept only /^[0-9a-f]{40}$/ or /^[0-9a-f]{64}$/ shas; branch names, tags, short and uppercase shas and empty strings are rejected (T-01-11)"
  - "role is required on every entry including the unselected one; repo, ref, sha and pinnedAt must be null or absent when status is unselected"
  - "ref is informational only (the branch the pin was resolved from); the SHA is authoritative"

patterns-established:
  - "Manifest validators in scripts/ use built-ins only (no Zod) and return string[]"
  - "A committed data file is validated by the same offline test run that validates the validator"

requirements-completed: [FND-08]

coverage:
  - id: D1
    description: "Validator accepts a fully pinned entry and rejects short sha, uppercase sha, branch name, null/empty sha, bad repo, duplicate id, unknown keys, schemaVersion 2"
    requirement: FND-08
    verification:
      - kind: unit
        ref: "node --test scripts/corpus.test.ts (rejects * cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Committed manifest lists exactly five corpora: gsd-core, gsd-pi, gsd-path, gsd-graph pinned to the recorded SHAs, swift-reference-app unselected with null repo, ref and sha"
    requirement: FND-08
    verification:
      - kind: unit
        ref: "scripts/corpus.test.ts#the committed manifest pins <id> to the recorded sha"
        status: pass
    human_judgment: false
  - id: D3
    description: "corpora/README.md names SWF-05 and warns that earlier research measurements used unrecorded SHAs and must be re-measured in Phases 2 and 3"
    requirement: FND-08
    verification:
      - kind: unit
        ref: "scripts/corpus.test.ts#corpora/README.md documents SWF-05 and the re-measure warning"
        status: pass
    human_judgment: false
  - id: D4
    description: "Online check confirms each pinned SHA exists upstream"
    requirement: FND-08
    verification:
      - kind: other
        ref: "node scripts/corpus-check.ts (run once 2026-10-16, exit 0, 4/4 OK)"
        status: pass
    human_judgment: false

duration: 2min
completed: 2026-10-16
status: complete
---

# Phase 1 Plan 05: Eval Corpus Pins Summary

**Corpus manifest pinning gsd-core, gsd-pi, gsd-path and gsd-graph to full commit SHAs, with a dependency-free validator that rejects branch names and short SHAs, an offline test run, and an optional gh-based upstream existence check**

## Performance

- **Duration:** 2 min
- **Started:** 2026-10-16T01:29:49Z
- **Completed:** 2026-10-16T01:32:30Z
- **Tasks:** 2 (Task 1 tracer, Task 2 auto; both TDD)
- **Files modified:** 5 (all created)

## Accomplishments

- `corpora/corpora.json` pins four corpora (`pinnedAt` 2026-10-15) and lists `swift-reference-app` as `unselected` with null repo, ref and sha and a note pointing at SWF-05 (Phase 5).
- `validateCorpora` enforces full lowercase hex SHAs (40 or 64), `owner/name` repos, non-empty ref and role, unique ids, no unknown keys, `schemaVersion` 1, and that an unselected entry carries no repo, ref, sha or pinnedAt.
- 29 offline tests, including a table of 17 mutations that must each fail validation and reads of the committed manifest and README. Full `npm test` is 104/104 green and `tsc -p tsconfig.json` is clean.
- Online check run once (recorded below): all four pins exist upstream.

### Online check output (`node scripts/corpus-check.ts`, exit 0)

```
OK    gsd-core open-gsd/gsd-core@10ac3a7a947903ba50f538a907af036744d759d5
OK    gsd-pi open-gsd/gsd-pi@bb86b6ca2d3d047899092d845d574beeb5a21965
OK    gsd-path open-gsd/gsd-path@73bf62e34f1adb8e9d86ae43378c8dd1200539bc
OK    gsd-graph open-gsd/gsd-graph@b105e4deb1fc3aaafba2cb65f4dfa6405597f799
4/4 pinned corpora confirmed upstream
```

## Task Commits

Each task was committed atomically (TDD, RED then GREEN):

1. **Task 1: Tracer, one pinned corpus validates and bad pins are rejected**
   - `f6d458e` test: failing validator tests (RED; module did not exist)
   - `ff7f135` feat: `scripts/corpus.ts` and first `corpora/corpora.json` (GREEN, 21 tests)
2. **Task 2: Complete the manifest, README and online check**
   - `705ba52` test: five-entry, four-pin, unselected-Swift and README assertions (RED; README test failed)
   - `4f3e1dd` feat: full manifest, `corpora/README.md`, `scripts/corpus-check.ts` (GREEN, 29 tests)

Tracer gate: `<verify>` re-run end to end after Task 1 (21/21 pass), so expansion proceeded.

**Plan metadata:** the commit containing this file (docs: complete plan).

## Files Created/Modified

- `corpora/corpora.json` - schemaVersion 1 manifest, five entries
- `corpora/README.md` - purpose, field table, re-pin steps, re-measure warning
- `scripts/corpus.ts` - `validateCorpora`, built-ins only
- `scripts/corpus.test.ts` - offline validator and committed-manifest tests
- `scripts/corpus-check.ts` - online `gh api repos/<repo>/commits/<sha>` existence check

## Decisions Made

- Pinned shas accept only 40-hex or 64-hex lowercase; this is the T-01-11 mitigation and the FND-08 prohibition (no branch, tag, short SHA or empty string).
- `role` is required on every entry, including the unselected one, so a corpus is never listed without a purpose.
- `ref` is recorded for provenance only; consumers must use `sha`.

## Deviations from Plan

None - plan executed exactly as written. (`corpora.json` for Task 2 was written before the RED run of the Task 2 tests, so the only Task 2 test failing at RED was the README one; the manifest assertions already held.)

## Issues Encountered

None. `node_modules` was absent in the worktree, so `npm ci --ignore-scripts` was run once to allow `tsc` and the full `npm test`; `node_modules` is gitignored.

## Known Stubs

None. The `swift-reference-app` entry is intentionally unselected; Phase 5 (SWF-05) resolves it.

## Threat Flags

None. `scripts/corpus-check.ts` is read-only against the GitHub API, uses an argument array with no shell, and takes repo and sha only from the validated manifest.

## User Setup Required

None - no external service configuration required. The optional online check needs an authenticated `gh` CLI.

## Next Phase Readiness

- Phases 2 and 3 must re-measure corpus-dependent figures (grammar parse-error budgets, file counts) at these pins; earlier research numbers used unrecorded SHAs.
- Phase 5 (SWF-05) must select the Swift reference app and replace the unselected entry with a pinned one.
- REQUIREMENTS.md, STATE.md and ROADMAP.md were not touched here (parallel worktree; orchestrator owns them). FND-08 is ready to be marked complete.

## Self-Check: PASSED

- Files exist: corpora/corpora.json, corpora/README.md, scripts/corpus.ts, scripts/corpus.test.ts, scripts/corpus-check.ts
- Commits reachable from HEAD: f6d458e, ff7f135, 705ba52, 4f3e1dd
- `"status": "unselected"` appears exactly once; README mentions SWF-05 and re-measure
- `node --test scripts/corpus.test.ts` 29/29, `npm test` 104/104, `node scripts/corpus-check.ts` exit 0

---
*Phase: 01-foundations-and-walking-skeleton*
*Completed: 2026-10-16*
