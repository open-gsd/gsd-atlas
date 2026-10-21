# Plan 03-39 progress record (clean-room replication)

This file is the resumable record of plan 03-39. It never holds a token, a credential, an email address, an account or
organization name or id, or the Docker host name. A restarted executor continues at the first task whose record is missing and
verifies live state (container, chunk table, row count) instead of repeating it.

Scheduling: execution is deferred by the user. Tasks 1 and 2 are offline. Nothing has been sent to the Docker host. Task 3 onward
needs the user.

## Header

- Plan start commit (HEAD before Task 1; Task 9 uses it for the unchanged-originals check): `025269b0a841ce085de738e866bd275a112f3f60`
- Task 1 RED commit: `d46addb6a47238a189d4df64d4e73c1f0bdc626e` (the modules under test did not exist: ERR_MODULE_NOT_FOUND)
- Rules commit (Task 1 GREEN, the commit that fixes the interpretation rules in `scripts/cleanroom/compare.ts`):
  `2c7831fb212286688549c6756de71a5aa7ef60b7`
- Blob id of `scripts/cleanroom/compare.ts` at the rules commit: `46a6cafb7e68ae1ca92ad3bd6b8027a1e1f961cf`
  (Task 9 requires `git rev-parse HEAD:scripts/cleanroom/compare.ts` to print the same blob id; the content cases that Task 2
  appends to `cleanroom.test.ts` do not touch the compare cases, which Task 9 checks case by case)
- Task 2 RED commit: (not yet)
- Task 2 GREEN commit: (not yet)

## Tasks

| Task | Status | Commit |
| --- | --- | --- |
| 1 Tracer: replication tooling | done (42 test cases green at the rules commit; typecheck clean; verify-prereg ok; self comparison prints `classification: strong-agreement`) | `d46addb` RED, `2c7831f` GREEN |
| 2 Image, control script, probe | not done | |
| 3 Approval before anything on the host | not started (waits for the user) | |
| 4 to 11 | not started | |

## Approval reply (Task 3, verbatim)

(not yet)

## Host facts (Task 3, without the host name)

(not yet)

## Baseline of the other containers (names and states, Task 3)

(not yet)

## Provisioning (Task 4)

Registered base, tooling tip, tooling commit, bundle sha256, image id, base digest, container id (short), limits, versions,
prepared-corpus record, gate output, first ten cells: (not yet)

## Preflight (Task 6)

Auth fields, environment names, home listing, four probe lines, headroom, gate: (not yet)

## Chunk table (Tasks 7 and 8)

| Chunk | Cells | Notional cost | Wall time | Check result | Max utilization (five-hour / seven-day) |
| --- | --- | --- | --- | --- | --- |

## Discards

(none)

## Fetch hashes (Task 9)

(not yet)

## Classification (Task 9)

(not yet)

## Teardown (Task 11)

(not yet)
