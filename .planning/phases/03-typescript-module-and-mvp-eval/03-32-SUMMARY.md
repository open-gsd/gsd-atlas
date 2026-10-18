---
phase: 03-typescript-module-and-mvp-eval
plan: 32
subsystem: diagnostics
tags: [bug, forensics, privacy, hashing, flight-recorder, cli, host, skl-04, d-17]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-17 the flight recorder (Tenant.recentAnswers, lastAnswerId, clear) and answer ids"
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-21 the diagnostics module (scrubNote, buckets, catalog version), the diagnostics Host kind and the two-step patterns of allow"
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-26 code_explain and fact provenance (extractor, tier, confidence, cache state)"
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-28 atlas_status citations.filesWithGaps (the snapshot the hint rides next to)"
provides:
  - "src/diagnostics/hash.ts, sanitize.ts, bundle.ts: HMAC-SHA256 tokens with a random per-bundle key, six typed leaf kinds, one sanitiser for hashed, redacted and raw, and buildBundle (format gsd-atlas-bug-v1) with a preview made of the exact bytes of bundle.json"
  - "Host request kind bug (collect, write, clear): collect returns the preview and the sha256 of the bytes, write is bound to that digest, a bundle is never overwritten, an MCP-origin Host refuses the kind"
  - "gsd-atlas bug [--what --expected --steps --feature --rating --answer --include --mode --confirm-raw --clear --repo --cwd]: the terminal walkthrough (every type starts denied, raw is its own question), the non-terminal flow, and the fixed attach sentence"
  - "Tenant.explainSummary, FlightEvent.schema/diag/seq, FlightRecorder.clear() returning the number of answers removed, an internal_error event for a failure inside the Tenant"
  - "BUG_HINT on atlas_status (StatusPort.recentInternalError) and on the status request, printed as a hint line by the CLI"
affects: [03-33, 03-35, 03-36, 03-37]
requirements-completed: [SKL-04]
status: complete
# commits is measured from plan_head_before to plan_head_after; it excludes this SUMMARY's own commit.
commits: 6
plan_head_before: 5b032e4931b1029292ed9cb2daae17584b3b087e
plan_head_after: 411920e2d097a3c9ce5642978eaff8238a00bf20
actuals:
  tokens: 52700
  tasks: 3
  commits: 6
metrics:
  completed: 2026-10-18
key-decisions:
  - "The user's own words (what happened, expected, steps) are always in the bundle, scrubbed, because they are the report: with nothing approved the bundle is exactly format, header and problem. The consent type `problem` therefore governs the two closed structured fields (feature, rating), not the text."
  - "Bundles go to <cache root>/gsd-atlas/bug-reports/<id>/, not <cache root>/bug-reports/<id>/: in production the cache root is the shared XDG cache directory, and a generic folder name there is not atlas's to take. The stores already live under <cache root>/gsd-atlas."
  - "The hashing key is random per bundle and exists only in a closure, so the Host keeps the collected bundle between collect and write (by digest, with the arguments it was collected with) instead of rebuilding it; a write whose arguments or digest differ is confirm_mismatch."
  - "A value that is not of the closed shape its field should have never becomes a code: it is `unknown`, or a name (hashed), or counted in other_args. A mistake in a builder costs a token, not a leak."
  - "ok, schema, diagnostic codes and watermark of a failing answer come from three new recorder fields (schema, diag, seq), because the recorder did not keep them; they are program-chosen words and a number."
  - "A failure inside the Tenant now leaves an internal_error event (tool and arguments, never the message); without it the hint `something went wrong; run gsd-atlas bug` could never fire on an internal error."
---

# Phase 3 Plan 32: `gsd-atlas bug`, a local, hashed, previewed bundle Summary

**One command gathers a header, the user's own scrubbed words and, per type the person approved, versions and configuration, store and host health, a flight-recorder excerpt and the failing answer with its explain summaries; names and paths are HMAC tokens by default, the preview is the exact bytes of `bundle.json`, nothing is uploaded, and `status` and `atlas_status` point at it after a corruption rebuild or an internal error.**

## What was built

1. **Task 1 (tracer, `ad3edf6` RED, `f263110` GREEN)**: `createHasher` (HMAC-SHA256, 16 random bytes held in a closure, token `<h:xxxxxxxx>`), the typed-leaf sanitiser (`name`, `path`, `handle`, `text`, `code`, `count`; hashed, redacted, raw; a bare string, an invented leaf kind or a key outside the fixed key shape throws), `buildBundle` and `renderPreview`, the Host `bug` kind (collect, write bound to the digest, `already_written`, `confirm_mismatch`, 0700/0600, temporary file and rename) and the CLI command with the attach sentence. The tracer gate ran: the verify command (the four test files, typecheck, lint) passed end to end before Tasks 2 and 3 started.
2. **Task 2 (`24a99bb` RED, `bf84706` GREEN)**: the four forensic types. Versions and effective configuration (a directory is a flag, permissions a count, tunables and disabled providers kept), health (store, host, indexer, governor and tier as numbers, bucket labels and codes), the recorder excerpt (newest `bug.excerptEvents`, times as seconds before the newest, trimmed oldest first by bisection to `bug.bundleMaxBytes`, with the note), and the failing answer (request, envelope summary, up to five explain summaries). `Tenant.explainSummary` asks Query directly, so building a bundle records no answer and moves no watermark. The recorder gained `schema`, `diag` and `seq` per answer.
3. **Task 3 (`5221f2c` RED, `411920e` GREEN)**: `bug --clear` (the number of answers removed), the status hint, the `internal_error` event, hints on stderr, and the no-network guard. The terminal walkthrough, the raw confirmation and the declined write were already part of the Task 1 CLI file, so their tests (written first in Task 3) passed at the RED commit; the Host, Query and Tenant parts of Task 3 failed there (11 failures) as they should.

## DIAGNOSTICS 9.6 acceptance tests 1 to 4

| # | Test | Where |
|---|------|-------|
| 1 | Nothing approved gives the header and the user's own text only | `src/diagnostics/bundle.test.ts` (nothing approved bundle), `src/host/bug.test.ts` (collect writes nothing, write) |
| 2 | Five-marker fixture (`ZEBRA_SYMBOL`, `/home/secret/path`, `AKIAIOSFODNN7EXAMPLE`, `internal.corp.example`, `hunter2`; branch, remote and commit message too): none in the hashed or redacted bundle, preview, stdout or stderr with every type approved; in raw mode the symbol and path appear only after `--confirm-raw`, the preview opens with `RAW MODE: names and paths are included as they are`, the secrets never appear | `scripts/bug-e2e.test.ts` (hashed mode contains no marker, redacted mode contains no marker either, raw mode needs confirmation and is marked), real CLI main, real Host, isolated cache |
| 3 | The recorder excerpt never exceeds its cap and appears only when approved (2,000 events) | `src/host/bug.test.ts` (the recorder never exceeds its excerpt cap) |
| 4 | A recorded integrity failure produces the hint | `src/query/status.test.ts` (hint after corruption rebuild, hint after internal error, no hint when healthy), `src/host/bug.test.ts` (Host status hints at a bug report, including a real corrupted store file), `scripts/bug-e2e.test.ts` |

Test 5 (the intake workflow) is Phase 4. The edge case is covered by `src/host/bug.test.ts` (2,000 events and a long failing answer in raw mode give a bundle within 1 MiB, `excerpt trimmed to N of 200 events`).

## Test results

- `npm test`: 4,511 tests, 4,509 pass, 0 fail, 0 cancelled, 2 skipped (both pre-existing), against 4,403 on the base commit (108 new: `src/diagnostics/bundle.test.ts` 35, `src/host/bug.test.ts` 35, `src/cli/bug.test.ts` 24, `scripts/bug-e2e.test.ts` 8, `src/query/status.test.ts` 4, `src/tenant/answer-record.test.ts` 2). No flake seen in three full runs.
- `npm run typecheck`, `npm run lint` and `npm run build` pass. `MODULES.length` is still 23 (no module was added) and `src/lint/boundaries.test.ts` passes. `node scripts/eval/verify-prereg.ts`: `verify-prereg: ok`; no Stage A file is in the diff.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Bundles go under `<cache root>/gsd-atlas/bug-reports`**
- **Found during:** Task 1
- **Issue:** The plan writes `<cache root>/bug-reports/<id>`. The Host's cache root is the shared XDG cache directory (`~/.cache`), so that would create a generic `bug-reports` folder in a directory other tools own. Stores already nest under `<cache root>/gsd-atlas`.
- **Fix:** `BUG_REPORTS_PATH = ['gsd-atlas', 'bug-reports']`; the tests assert that path. Everything else in the plan (0700 folder, 0600 files, `bundle.json` and `preview.txt`, never overwritten) is as written.
- **Commit:** f263110

**2. [Rule 1 - Bug] The recorder did not keep what the failing answer needs**
- **Found during:** Task 2
- **Issue:** The plan's failing answer carries "the envelope's schema, ok flag, degraded codes, diagnostic codes, counts and watermark"; a recorder event held only outcome, degraded codes, count and handles.
- **Fix:** `FlightEvent` gains `schema`, `diag` (diagnostic codes) and `seq` (watermark sequence number), written by `flightAnswer`. They are program-chosen words and a number; the existing recorder tests pass unchanged.
- **Files modified:** `src/tenant/flight.ts`, `src/tenant/record.ts`
- **Commit:** bf84706

**3. [Rule 2 - Missing critical functionality] An internal error left no trace, so the hint could never fire on one**
- **Found during:** Task 3
- **Issue:** The hint fires when one of the recorder's newest 50 events has the outcome `internal_error`, but a failure inside the Tenant propagated to the Host, which turned it into an envelope nobody recorded.
- **Fix:** `Tenant.handle` appends an `internal_error` event (tool and arguments, never the message) before rethrowing. Test: `src/tenant/answer-record.test.ts` (a request that fails inside the Tenant leaves an internal_error event).
- **Commit:** 411920e

**4. [Rule 3 - Blocking] Files outside the plan's list**
- `src/cli/bug.ts` (new): the command needs its own file, like `allow.ts` and `diagnostics.ts`; the plan lists only `tool-commands.ts` and `index.ts`.
- `src/host/bug.test.ts` (new): the Host cases of the three tasks; the plan's verify command runs `host.test.ts`, which has no `bug` cases. `src/host/index.ts` exports the kind and the paths.
- `src/query/types.ts` and `src/query/index.ts`: `StatusPort.recentInternalError` and the `BUG_HINT` export; the plan names `status.ts`, `status-port.ts` and `tenant/create.ts` but the port type lives in `types.ts`.
- `src/tenant/record.ts`, `src/tenant/index.ts`, `src/diagnostics/index.ts`: the new recorder fields, `flightFailure`, and the module's exports.
- `src/tenant/answer-record.test.ts`: two cases for the new recorder fields and the `internal_error` event.
- `route.ts` was not changed: `bug` is not a repository-scoped kind (it must work for a repository nobody indexed and for a directory that is not a repository), so it is routed like `diagnostics`, and `docs/DIAGNOSTICS.md` and the ADRs were not touched.
- **Commits:** f263110, bf84706, 411920e

**5. [Interpretation] Exit codes follow the plan, as `allow` does**
- The plan says a non-terminal run without text exits 2, a raw request without `--confirm-raw` exits 2 and a declined write exits 1. These are the numbers `allow` already uses (no terminal 2, declined 1), so they were implemented as written; a Host refusal exits by `exitCodeFor` (`invalid_args` 1, any other error 2).

### TDD gate

`tdd_mode` is on. Each task has a `test(03-32)` RED commit before its `feat(03-32)` GREEN commit. RED was observed for Task 1 (modules not found), Task 2 (20 failures) and Task 3 (11 failures, checked in an export of the RED commit). For Task 3 the CLI cases passed at RED because the CLI flow had been written in Task 1 (see "What was built").

## Authentication Gates

None.

## Known Stubs

None. A consent type whose data cannot be gathered (no index, not a repository) is written as `{"status": "unavailable"}` on purpose, so the bundle still writes.

## Threat Flags

None new beyond the plan's register. Notes for the verifier:

| Threat | Status |
|--------|--------|
| T-03-321 names, paths or secrets in a shared bundle | mitigated: one sanitiser with typed leaves, hashed by default, the five-marker fixture across the three modes through the real CLI, user text scrubbed in every mode, source text and `untrusted_text` have no field to travel in (tested with events that carry them) |
| T-03-322 dictionary recovery of hashed names | mitigated: HMAC with a random key that never leaves the closure; two hashers give two tokens (tested) |
| T-03-323 a preview that differs from the file | mitigated: the preview is a framing plus the serialised tree, the write recomputes the digest, `preview.txt` is the previewed text (tested byte for byte) |
| T-03-324 an agent producing a bundle | mitigated: no MCP tool, and a Host started for MCP refuses the kind (`bug_forbidden`) before reading the arguments; raw needs `--confirm-raw` or the question |
| T-03-325 an enormous bundle | mitigated: excerpt cap, oldest-first bisection to 1 MiB, five fact summaries |
| network | no code path: a test replaces `fetch`, `http`, `https` and `net` with throwing stubs and runs the CLI flows, and the real-Host collect, write, raw and clear flows |

## Self-Check: PASSED

- Files: `src/diagnostics/hash.ts`, `sanitize.ts`, `bundle.ts`, `bundle.test.ts`, `src/host/bug.ts`, `bug.test.ts`, `src/cli/bug.ts`, `bug.test.ts` and `scripts/bug-e2e.test.ts` exist.
- Commits: ad3edf6, f263110, 24a99bb, bf84706, 5221f2c and 411920e are ancestors of HEAD; `git rev-list --count 5b032e4..HEAD` is 6.
- No file under `scripts/eval` or `docs/eval` is in the diff; `docs/adr` and `docs/DIAGNOSTICS.md` are untouched (nothing was ratified).
