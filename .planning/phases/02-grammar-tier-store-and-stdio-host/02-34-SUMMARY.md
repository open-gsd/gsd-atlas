---
phase: 02-grammar-tier-store-and-stdio-host
plan: 34
subsystem: indexer
tags: [indexer, governor, containment, gap-closure]
requires: []
provides:
  - "Indexer.stop() that always disposes the module host and releases the writer slot (WR-13)"
  - "isInside(root, candidate, api?) shared containment helper in the facts leaf module (IN-03)"
  - "Documented and tested Governor timeout contract (IN-11)"
affects: [src/indexer, src/facts, src/governor, scripts/corpus-fetch.ts]
tech-stack:
  added: []
  patterns: ["teardown in try/finally with every unsubscribe through one guarded call", "one pure path-containment helper in the leaf module"]
key-files:
  created: [src/indexer/stop.test.ts, src/facts/inside.ts, src/facts/inside.test.ts]
  modified: [src/indexer/indexer.ts, src/facts/index.ts, src/indexer/paths.ts, src/indexer/git-dir.ts, scripts/corpus-fetch.ts, src/governor/types.ts, src/governor/governor.test.ts]
key-decisions:
  - "Governor timeout behaviour is unchanged: the slot is freed on expiry; the contract (honour the signal or set no timeout) is documented and pinned by test."
  - "isInside takes (root, candidate); corpus-fetch's old (child, parent) call was flipped accordingly."
status: complete
commits: 3
plan_head_before: 27ae4745b8b40d2ef56534198753f39e59ef3085
plan_head_after: 4ab04067ac833eed743eccf4dc34de27f51a2f2e
actuals:
  tokens: 6000
  tasks: 3
  commits: 3
requirements-completed: [STO-08, IDX-03, HST-03, STO-09]
duration: ~25 min
completed: 2026-10-17
---

# Phase 2 Plan 34: stop() teardown, one isInside, Governor timeout contract Summary

`Indexer.stop()` can no longer strand the writer slot, the Governor's timeout contract is written down and pinned, and the indexer, git-dir and corpus-fetch copies of the containment test are one separator-aware helper in `facts`.

## Tasks

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Tracer: stop() with a failing unsubscribe still releases writer and module host | 9fce039 | src/indexer/indexer.ts, src/indexer/stop.test.ts |
| 2 | One containment helper replaces the hand-written copies | d63a4ec | src/facts/inside.ts, inside.test.ts, index.ts, src/indexer/paths.ts, git-dir.ts, scripts/corpus-fetch.ts |
| 3 | Write down and test the Governor's timeout contract | 4ab0406 | src/governor/types.ts, governor.test.ts |

## What changed

- **Task 1 (WR-13).** The legacy `unsubscribes` loop used a bare `await unsubscribe()` that aborted `stop()` before `host.dispose()` and `writer.release()`. Every unsubscribe (legacy, git, per covered worktree) now goes through `closeLate`, and everything after `queue.close()` is inside `try { ... } finally { try { await host.dispose() } finally { writer?.release(); writer = undefined } }`. Happy-path order is unchanged. `stop()` still returns the one memoised `stopping` promise.
  `stop.test.ts` cases: `legacy unsubscribe fails`, git and per-worktree failures (regression guard), `active job`, `concurrent stops`, `lease regained`. The module host disposal is observed through a wrapping engine that counts grammar `dispose` calls.
- **Task 2 (IN-03).** `facts/inside.ts` exports `isInside(root, candidate, api = path)` built on `api.relative`: `''` inside; `'..'` or `'..' + sep` prefix outside; absolute result (another drive) outside. Exported from `facts/index.ts`. Replaced copies: `src/indexer/paths.ts` (private `isInside`), `src/indexer/git-dir.ts` (exported `isInside` keeps its realpath handling and signature, delegates the comparison), `scripts/corpus-fetch.ts` (private `isInside(child, parent)`, call flipped to `isInside(repoRoot, destination)`). Tests include `sibling prefix`, `dot-dot name`, `windows drive`, `windows case` (the Windows flavour runs on every OS via `path.win32`).
- **Task 3 (IN-11).** Doc comments on `Job.timeoutMs`, `GovernorResult` and `Governor.run` state that on expiry the signal is aborted and the slot freed at once, and that a job must honour its signal or set no timeout. Two tests in a new `real Governor: timeout contract (IN-11)` suite: `timeout honours the signal` and `timeout ignores the signal` (running count drops while the function is pending, the freed slot is reused, settling later releases nothing twice). No behaviour change.

## `governor.run` call sites in src/host, src/indexer, src/tenant (none passes `timeoutMs`)

- `src/host/host.ts:115` `{ tenant, class: cls, cost: 1 }`
- `src/host/host.ts:127` `{ tenant, class: cls, cost: 1 }`
- `src/indexer/process.ts:126` (`runJob`) `{ tenant, class, cost: 1, requestId? }`
- `src/tenant/create.ts:354` `{ tenant, class: 'maintenance', cost: 1 }`

## Mutation check (Task 1)

Reverting the `stop()` body to the old shape (bare `await unsubscribe()` in the legacy loop, no `finally` around host dispose and writer release) makes `legacy unsubscribe fails` and `lease regained` fail (3 pass, 2 fail). Caveat recorded honestly: removing only the `finally` while keeping the guarded unsubscribes is not detected by these cases, because the guarded calls absorb every failure that currently reaches the try block; the `finally` is defence in depth for a throw from `writeHint` or an unforeseen step, and has no dedicated failing case.

## Deviations from Plan

- **TDD red step for Task 2 was not run.** `inside.test.ts` and `inside.ts` were written back to back and the first run was already green; the red state was "module does not exist", not observed. Task 1 was run red first as specified (2 of 5 cases failed before the fix). Task 3 tests pass on arrival by design.
- **Task 2 "failing unsubscribe" test expectation:** `lease regained` first asserted 4 files; the toy fixture's README.md is not a source file, the correct count is 3 (test fixed, not product code).

Otherwise none: the plan executed as written.

## Remaining copies (out of scope, not touched)

`grep` finds other private `isInside` functions this plan does not own: `src/host/route.ts` and `src/host/history.ts` (plan 02-41), `src/source-tree/read-text.ts` (plan 02-38), and also `src/lang/module-files.ts`, `scripts/corpus-gates.ts` and `scripts/recall.ts`, which no plan in the review ledger lists. Logged here for the orchestrator; not fixed (scope boundary).

## Verification

- `node --test "src/indexer/*.test.ts" "src/governor/*.test.ts" "src/facts/*.test.ts" scripts/corpus-fetch.test.ts src/tenant/takeover.test.ts`: 251 tests, 251 pass.
- `npm run typecheck` and `npm run lint`: exit 0.
- No stubs, no new network or file-access surface (no threat flags). Threat T-02-112 and T-02-113 mitigated as planned; T-02-114 accepted and pinned.

## Self-Check: PASSED

Files exist: src/indexer/stop.test.ts, src/facts/inside.ts, src/facts/inside.test.ts. Commits 9fce039, d63a4ec, 4ab0406 are ancestors of HEAD.
