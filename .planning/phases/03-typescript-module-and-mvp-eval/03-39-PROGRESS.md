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
- Task 2 RED commit: `24e51e3496babd89711b81d28d185d482dbfa7dd` (17 of 57 cases failed: `docker/cleanroom/*` and `scripts/cleanroom/probe.ts` did not exist)
- Task 2 GREEN commit: `9e4e89066c6919a88b24ee32c7d3e1fb4bd9f2d4` (57 of 57 cases pass; `compare.ts` blob id unchanged at `46a6cafb7e68ae1ca92ad3bd6b8027a1e1f961cf`)

## Tasks

| Task | Status | Commit |
| --- | --- | --- |
| 1 Tracer: replication tooling | done (42 test cases green at the rules commit; typecheck clean; verify-prereg ok; self comparison prints `classification: strong-agreement`) | `d46addb` RED, `2c7831f` GREEN |
| 2 Image, control script, probe | done (57 cases green; typecheck clean; `bash -n` and shellcheck clean; verify-prereg ok; nothing built or sent anywhere; `docker build --check` not run because it resolves the pinned base image over the network and this pass is offline) | `24e51e3` RED, `9e4e890` GREEN |
| 3 Approval before anything on the host | not started (waits for the user) | |
| 4 to 11 | not started | |

## Assumptions that only a live run can confirm (written offline in Tasks 1 and 2)

- Dockerfile: the manifest layout `platforms["linux-x64"].checksum` and the detached-signature check with `gpg --verify`
  follow the published installer's shape; the first build (Task 4) confirms them. A mismatch stops the build and is reported, not patched.
- `cleanroomctl.sh preflight`: reads `claude auth status` as JSON through a four-field `jq` filter; if the 2.1.302 output is not JSON the
  check reports FAIL and the executor reads the fields by another filter (never the raw output).
- `claude doctor` may need a terminal; the checks run it under `timeout 60` and report FAIL if no auto-update line appears.
- Probes use the answer schema in the two arm probes so that the init event lists `StructuredOutput` as the registered signature does;
  the control-harness probe leaves the schema out so its reply is plain text (isolation flags unchanged).
- The `credential_access` stop in `check-chunk.ts` fires on any tool call whose input names the credentials file, the global config file or
  `~/.claude`; a corpus question that greps for `~/.claude` as a search pattern would also fire it (the plan's rule; a stop is a question to the human).

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
