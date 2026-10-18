---
phase: 03-typescript-module-and-mvp-eval
plan: 17
subsystem: diagnostics
tags: [ratings, answer-id, flight-recorder, metrics, cli, privacy, d-16]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-12 createAnswerId, isAnswerId and Envelope.answer_id in the facts kernel"
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-15 Host origin handling (allow_forbidden for an MCP-origin Host) that rate follows"
provides:
  - "Every tool answer (code_find, code_refs, code_context, code_impact, atlas_status, lang_list) carries a random answer_id; build, maintain, status, index_state, history and allow responses carry none"
  - "src/tenant/flight.ts: createFlightRecorder, a capped local JSON-lines recorder (flight.jsonl and flight.prev.jsonl under <store dir>/flight) with append, recent, lastAnswer, sessionId, clear and close"
  - "Tenant.recentAnswers, lastAnswerId, sessionId and rate; TenantTuning.flightMaxEvents and flightMaxBytes (2000 and 5242880, recorder.* in 03-CONSTANTS.md)"
  - "Metrics migration 2: ratings (at, scope, value, answer_id, feature, session_id) with closed checks; RatingEvent, RATING_FEATURES, RATING_SCOPES, RATING_VALUES"
  - "Host request kind rate (interactive class, strict arguments) and gsd-atlas rate up|meh|down [--session | --feature <name> | --last]"
  - "createSessionId, isSessionId, SESSION_ID_PATTERN in the facts kernel"
affects: [03-32, 03-33, 03-35]
actuals:
  tokens: 29600
  tasks: 3
  commits: 3
commits: 3
plan_head_before: 17979847f53d02f36d7768d8420d79367b90437e
plan_head_after: ecf06569baf9a233631912b6c46c29905b0cf1ca
tech-stack:
  added: []
  patterns:
    - "A local-only flight recorder shared by every process that answers for a repository: one whole line per append, torn or foreign lines skipped on read, never throws"
    - "Stamp the id once the answer exists, with the same id the recorder gets (the Tenant stamps its own answers; the Host stamps what bypasses a Tenant)"
    - "Closed-vocabulary event plus a table that refuses the same rows (CHECK constraints) for anything that is a person's input"
    - "A request kind a person sends and an MCP-origin Host refuses, with no tool in the table"
key-files:
  created:
    - src/tenant/flight.ts
    - src/tenant/flight.test.ts
    - src/tenant/rate.ts
    - src/tenant/answer-record.test.ts
    - src/host/answer-id.test.ts
    - src/host/rate.test.ts
    - src/cli/rate.test.ts
    - scripts/answer-id-e2e.test.ts
    - scripts/rate-e2e.test.ts
  modified:
    - src/facts/answer-id.ts
    - src/facts/index.ts
    - src/metrics/types.ts
    - src/metrics/validate.ts
    - src/metrics/migrations.ts
    - src/metrics/store.ts
    - src/metrics/index.ts
    - src/metrics/metrics.test.ts
    - src/tenant/create.ts
    - src/tenant/types.ts
    - src/tenant/record.ts
    - src/tenant/defaults.ts
    - src/tenant/index.ts
    - src/host/host.ts
    - src/host/route.ts
    - src/host/index.ts
    - src/host-client/index.ts
    - src/cli/tool-commands.ts
    - src/cli/index.ts
    - src/cli/text.ts
    - src/mcp-shim/mcp.test.ts
    - src/tenant/harness.test.ts
    - src/tenant/overlay.test.ts
    - scripts/test-helpers/fixture-repo.ts
key-decisions:
  - "The session marker is written lazily, just before a Tenant's first recorded answer, not at Tenant creation: the CLI process that runs `rate` opens a Tenant too, and an eager marker would make `rate --session` rate that throwaway process instead of the session that answered."
  - "The recorder is off when the user turned metrics off (metrics false): nothing is kept about their use, and a rating then reports rating_not_saved."
  - "Rotation is by half the caps (more than maxEvents/2 events or maxBytes/2 bytes), so two segments hold about the locked 2,000 events or 5 MB and a reader sees between half the cap and the whole cap, trimmed to the newest maxEvents. The plan's 'newest ten' for cap 10 holds as 'the newest events in order, at most ten'."
  - "Exit codes follow the CLI contract in src/cli/exit.ts (1 usage, 2 failure), not the plan's literal numbers: a usage error exits 1; no_recent_answer, no_recent_session and rating_not_saved exit 2."
  - "A rating is saved only when Metrics accepted it, nothing is left in its queue and no write failure or drop happened during its flush; otherwise rating_not_saved."
  - "A Host started for MCP refuses the rate kind itself (rate_forbidden, before the arguments are read), as it does for allow, in addition to there being no rating tool."
requirements-completed: [SKL-02]
coverage:
  - id: D1
    description: "Every tool answer carries an answer_id through the Host, so the CLI and MCP JSON both carry it; non-answers carry none"
    requirement: "SKL-02"
    verification:
      - kind: unit
        ref: "src/host/answer-id.test.ts"
        status: pass
      - kind: integration
        ref: "scripts/answer-id-e2e.test.ts#CLI: answer ids"
        status: pass
    human_judgment: false
  - id: D2
    description: "The Tenant appends one event per tool answer to the flight recorder with ids, codes, counts and handles only; a failing recorder never reaches the caller"
    requirement: "SKL-02"
    verification:
      - kind: unit
        ref: "src/tenant/answer-record.test.ts and src/tenant/flight.test.ts (append and recent, last answer, session marker, unwritable directory, corrupt line skipped, args truncated)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The recorder honours its caps under concurrent instances and two real processes, never leaves a torn line, rotates by rename, clears, and uses modes 0700 and 0600"
    requirement: "SKL-02"
    verification:
      - kind: unit
        ref: "src/tenant/flight.test.ts (event cap, byte cap, concurrent instances, two processes, reader during rotation, clear, file modes)"
        status: pass
    human_judgment: false
  - id: D4
    description: "ratings table and rating event are a closed vocabulary with no free text; migration 2 is forward-only and keeps version 1 data"
    requirement: "SKL-02"
    verification:
      - kind: unit
        ref: "src/metrics/metrics.test.ts (migration 2, rating closed vocabulary, read-only database)"
        status: pass
    human_judgment: false
  - id: D5
    description: "gsd-atlas rate up|meh|down rates the newest answer, a feature or the session; no recent answer, a rating that cannot be saved and usage errors are handled; no agent can rate"
    requirement: "SKL-02"
    verification:
      - kind: unit
        ref: "src/cli/rate.test.ts, src/host/rate.test.ts, src/mcp-shim/mcp.test.ts#no rating tool"
        status: pass
      - kind: integration
        ref: "scripts/rate-e2e.test.ts (rows in metrics.db, another process rates)"
        status: pass
    human_judgment: false
---

# Phase 3 Plan 17: Answer ids, the flight recorder and ratings Summary

**Every tool answer now carries a random `answer_id`, a capped local flight recorder remembers the last answers across processes, and `gsd-atlas rate up|meh|down [--session | --feature <name> | --last]` stores a rating as an id and a closed value in a new `ratings` table, with no MCP rating tool and no free text.**

## What was built

1. **Task 1 (tracer, `3dbee65`)**: answer ids and the per-tenant flight recorder. The Tenant stamps `answer_id` on the five tool answers it gives, with the same id it appends to `<store dir>/flight/flight.jsonl`; the Host stamps `lang_list` and tool requests refused before a Tenant saw them. The event holds the id, time, tool, request arguments (strings cut at 200 characters, bounded depth and width), outcome (`ok` or the first diagnostic code), a latency bucket label, the degraded codes, the citation count and up to 20 handles. The tracer gate ran: the verify command was re-run end to end and passed before Tasks 2 and 3 started.
2. **Task 2 (`bad3a31`)**: metrics migration 2 (`ratings`, with a CHECK that each scope carries exactly its own reference column and an index on `at`), the closed `rating` event and its validation, an insert path that never coalesces ratings, the Host `rate` kind, `Tenant.rate`, and the CLI command with `--session`, `--feature` and `--last` (no `--note`).
3. **Task 3 (`ecf0656`)**: caps and rotation. The current segment is renamed over `flight.prev.jsonl` once it holds more than half the event cap or half the byte cap; the size estimate is corrected from the file after each append so other writers cannot make a segment grow unbounded; readers retry when the previous segment was replaced between their two reads; `clear()` is in place for the later `bug --clear`.

## Test results

- `npm test`: 3348 tests, 3347 pass, 0 fail, 1 skipped (the baseline before this plan was 3277 tests with the same skip). 71 tests were added across the flight recorder, the Tenant answer record, the Host answer ids and `rate`, the CLI `rate`, the metrics ratings and migration 2, the MCP no-rating-tool check and two end-to-end files.
- `npm run typecheck`, `npm run lint` and `npm run build` pass. The boundary test is unchanged (`MODULES.length` is still 22; no module was added).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The CLI exit codes in the plan contradict the CLI's own contract**
- **Found during:** Task 2
- **Issue:** The plan says `rate --last` with nothing to rate exits 1 and a usage error exits 2. `src/cli/exit.ts` (and its tests, the mcp-contract amendment and every other command) define 1 as usage and 2 as any other failure.
- **Fix:** Usage errors exit 1 and `no_recent_answer`, `no_recent_session` and `rating_not_saved` exit 2 through the existing mapping, so a script reads one table. The error envelope is printed unchanged either way.
- **Files modified:** none beyond the plan's (the mapping was left as it is); `src/cli/rate.test.ts` and `scripts/rate-e2e.test.ts` assert the contract values.
- **Commit:** bad3a31

**2. [Rule 1 - Bug] An eager session marker would rate the wrong session**
- **Found during:** Task 1
- **Issue:** The plan writes the session marker at tenant creation. `gsd-atlas rate --session` runs in a new CLI process that creates a Tenant, so its own fresh marker would be "the newest session".
- **Fix:** The marker is appended lazily before the Tenant's first recorded answer. A process that only builds, rates or reads status leaves no marker. Test: `src/tenant/answer-record.test.ts#session marker` and `scripts/rate-e2e.test.ts` (one marker, written by the answering process).
- **Commit:** 3dbee65

**3. [Rule 1 - Bug] Rotation at "more than half" cannot always leave the newest ten**
- **Found during:** Task 3
- **Issue:** The plan's rotation rule (past half the caps) and its example (25 events at cap 10 leave "the newest ten") disagree: after 25 events the segments hold 7. Keeping ten would need segments of the full cap, doubling the disk use past the locked 5 MB.
- **Fix:** Kept the rotation rule and the locked disk bound; the readable window is the newest events with no gap, between half the cap and the whole cap, never more than `maxEvents`. The tests assert that.
- **Commit:** ecf0656

**4. [Rule 2 - Missing critical functionality] No recorder when metrics are off**
- **Found during:** Task 1
- **Issue:** A user who turned metrics off (`metrics: false`) would still get a local file of their requests.
- **Fix:** No flight recorder is created in that case; answers are still stamped. `rate` then answers `rating_not_saved`.
- **Commit:** 3dbee65

**5. [Rule 2 - Missing critical functionality] An MCP-origin Host accepted the `rate` kind**
- **Found during:** Task 2
- **Issue:** Not offering a rating tool does not stop a client that sends a raw `rate` request to a Host started for MCP.
- **Fix:** The Host refuses `rate` from an MCP origin before reading its arguments (`rate_forbidden`), the way it refuses `allow`.
- **Commit:** bad3a31

**6. [Rule 3 - Blocking] Existing tests compared envelopes and a store snapshot**
- **Found during:** Task 1 (first `npm test`, 13 failures)
- **Issue:** The random `answer_id` broke byte-for-byte CLI versus MCP parity, the follower product test and the Tenant answer-purity and burst tests; the follower-overlay test snapshots the store folder and now saw the flight recorder grow.
- **Fix:** `maskNonce` (scripts/test-helpers/fixture-repo.ts) masks the id, `withoutNonce` (src/tenant/harness.test.ts) drops it, and the overlay snapshot skips the `flight` folder (a follower writes the recorder by design, never the store). Metrics tests that assumed `user_version` 1 and an injected version 2 now expect 2 and inject 3.
- **Commit:** 3dbee65, bad3a31

Otherwise the plan was executed as written. Two plan behaviors needed a reading: "the printed JSON is the Host envelope unchanged; stderr carries one confirmation line without the answer id's neighbours" is implemented as one line naming the value and the scope (`recorded "up" for the last answer`) and never an id; a `rate` with no index at all answers `no_recent_answer` for the newest-answer and session scopes and `not_indexed` for a feature rating, and creates no store.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. Nothing opens a network path. The flight recorder is a new local file (0600, folder 0700) holding the request arguments of answered requests; it is the surface T-03-171 covers and is bounded as planned. Plan 03-32 (`bug`) must hash names and paths in what it exports from it.

## Threat model coverage

| Threat | Status |
|--------|--------|
| T-03-171 recorder disclosure | mitigated: local only, modes 0600/0700, caps, args cut at 200 characters and bounded in depth and width, no data or untrusted text (tested by absence in `answer-record.test.ts`) |
| T-03-172 agent records a rating | mitigated: no tool, `rate` refused by an MCP-origin Host, test on the tools/list schemas and on a `rate` call |
| T-03-173 free text in the ratings table | mitigated: closed event validation plus CHECK constraints on the table, tested at both layers |
| T-03-174 recorder delays answers | mitigated: one synchronous write and at most one rename after the envelope exists, never throws, no timers |
| T-03-175 torn lines | mitigated: whole-line appends, unparsable lines skipped; tested with concurrent instances and two real processes |

## Self-Check: PASSED

- Files: `src/tenant/flight.ts`, `src/tenant/rate.ts`, `src/tenant/flight.test.ts`, `src/cli/rate.test.ts`, `scripts/rate-e2e.test.ts` and the other created files exist.
- Commits: 3dbee65, bad3a31 and ecf0656 are on the branch.
- `grep -c "kind: 'rating'" src/metrics/validate.ts` is above 1; the migration list has `version: 2` with `ratings`.
