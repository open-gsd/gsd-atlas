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

"approve" (no ssh=, cpus=, mem= or node= tokens: defaults ssh target, 4 CPUs, 12g, Node 24.22.0). Probe output was run by the user at the prompt.

## Host facts (Task 3, without the host name)

Docker server 29.8.2; Docker data dir 341G total, 184G free; memory 30954 MiB total, 27087 available, 8191 swap; 8 CPUs; load average 19.36/19.08/14.35 (above the chunk gate of 6, re-read before each chunk); no own objects present.

## Baseline of the other containers (names and states, Task 3)

All running: gsd-test-27f5445b5e6343e443e4a68c40f0e950-linux-node24-4bdc0e89, gsd-test-163efe79ff8c0c793dc24480f93973b9-linux-node24-bd33ef96, gsd-test-9a64b01556-linux-node24-f5f28329, arm-rippers, ovid-staging-web, ovid-staging-api, ovid-staging-db, ovid-staging-redis, ovid-web-1, ovid-api-1, ovid-valkey-1, ovid-prod-api, ovid-prod-web, ovid-prod-db, ovid-db-1.

## Provisioning (Task 4)

Registered base, tooling tip, tooling commit, bundle sha256, image id, base digest, container id (short), limits, versions,
prepared-corpus record, gate output, first ten cells: (not yet)

Partial (local, offline, Task 4 steps 1 and 6): REGISTERED_BASE a21ef8bfed512fb3810c2b9944344d1f530f0d5b; TOOLING_TIP cb1ad313281aaae49f380bc04cab96699118d4d2; TOOLING_COMMIT 8efcac65d90a99ffc2b1cbe8eecf32a0b2a27a07 (local, never pushed; differs from the base only under scripts/cleanroom and docker/cleanroom); bundle sha256 c2e2b3b62ee1c42c3e6635f15438240131c541e4071863df4a039ce1bd66f266 (5317586 bytes, verified). Bundle file is in the session scratchpad. Build inputs of the base equal the registered atlas commit (empty diff). Host steps 2-5 and 7-9 pending: the Bash tool's auto-mode classifier denies commands that contact the host.

Provisioned 2026-10-21 (host steps run by the user at the prompt and, after the user added an allow rule for cleanroomctl.sh, by the executor):
- Probe repeated: the same 15 containers, all running, no own objects (matches the Task 3 baseline).
- Image gsd-atlas-cleanroom:03-39 id sha256:009c7f36fce20262c20ff75ae81484c1a88cfc10471255e4b61e36058f45a4af, label 03-39, base node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5; build verified the release-manifest signature (fingerprint 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE) and the binary checksum.
- Container up: 4 CPUs, 12 GiB (swap equal), 2048 pids, shares 512, non-root uid 10001, capabilities dropped, no-new-privileges, no published port; mounts only the two own volumes.
- Inside: claude 2.1.302; node v24.22.0; npm 11.19.1; ripgrep 13.0.0; git 2.39.5; no ANTHROPIC_/CLAUDE_CODE_/AWS_/GOOGLE_/AZURE_ variables; DISABLE_UPDATES=1, DISABLE_AUTOUPDATER=1; doctor: auto-updates disabled; notes file identical to the neutral text; os.totalmem 32458448896 (host figure), nproc 8, cgroup memory.max 12884901888, cpu.max 400000 100000.
- HEAD in the container equals TOOLING_COMMIT 8efcac65d90a99ffc2b1cbe8eecf32a0b2a27a07 (status empty; bundle removed). npm ci --ignore-scripts 4 s; npm run build 11 s, exit 0. Tooling smoke: both --help exit 0; check-chunk --streams-only on an empty directory exits 1 with stream_missing and no stack trace.
- Prepared corpus: sha 10ac3a7a947903ba50f538a907af036744d759d5, npmCi true, typescriptVersion 6.0.3, lockSha256 dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb (all equal to the registered record); no CLAUDE.md, AGENTS.md, .claude or .mcp.json in the corpus root.
- verify-prereg ok; plan --scored: gate ok, 450 cells (225 atlas, 225 grep), seed 20261017, concurrency 2, model claude-sonnet-5-5; first ten cells equal the original run's.
- DEVIATION (verify-provision exit 1 on one check): ~/.claude holds `backups/` (one 84-byte backup of Claude Code's own ~/.claude.json) in addition to CLAUDE.md. Both were created by Claude Code when the executor ran `claude doctor`/`--version` in the container; contents not read (E3). No skills, hooks, settings, plugins or memory files. Decision pending from the user: accept as Claude Code runtime state, or adjust.
- Observation: host load average was 16 to 19 on 8 CPUs during provisioning; the chunk gate needs at most 6.


## Preflight (Task 6)

Task 5: login done by the user in the container (reply "logged-in"); the executor never saw the credentials.
Auth (four-field filter): loggedIn=true authMethod=claude.ai apiProvider=firstParty subscriptionType=max. No provider, API-key or token variable. Home entries: .credentials.json, CLAUDE.md, backups (no hooks, skills, agents, commands or plugins; the user accepted-by-default the backups/ runtime-state deviation noted under Provisioning). Doctor: auto-updates disabled.
Probes (all status ok, apiKeySource none, claude 2.1.302, model claude-sonnet-5-5, zero hook events, no init-signature difference for either arm):
- atlas: cost 0.043898, 4147 ms
- grep: cost 0.024794, 3551 ms
- control-harness: reply `none`, cost 0.0108187
- control-default: reply `# Notes`, cost 0.0100809
Isolation reading: control-default quoted the notes and control-harness replied none, so the harness isolation flags kept the user-level notes file out of the session.
Probe cost total 0.0895916 USD notional (cap 0.20). Headroom: five-hour 0.12 (resets 2026-10-21T05:20:00Z), seven-day 0.03 (resets 2026-10-27T23:00:00Z), status allowed, isUsingOverage false, overageEnabled false. Ceilings hold (seven-day < 0.93, five-hour < 0.75).
Gate after login: plan --scored gate ok, 450 cells, first ten cells equal the original's; preflight: ok.
Host after preflight: own objects present (five); 1-minute load 10.88 (gate needs <= 6); disk 186G free; the other containers are the host's own (two gsd-test-* names differ from the Task 3 baseline: host activity, not ours).

## Chunk table (Tasks 7 and 8)

| Chunk | Cells | Notional cost | Wall time | Check result | Max utilization (five-hour / seven-day) |
| --- | --- | --- | --- | --- | --- |
| 1 (line 5 USD, load 0.01 at start, nice 10) | rows 0 to 141 (attempts 141, streams 141, skipped 0) | 5.0233 USD | about 80 min (ended 2026-10-21T12:43Z; start time approximate) | harness exit 1 (cost stop reached, expected); check-chunk: ok; 0 infrastructureFailure true | 0.08 / 0.08 |
| 2 (line 10 USD, load 0.04 at start, nice 10) | rows 141 to 303 (attempts 303, streams 303) | 10.0409 USD | about 5 h (ended 2026-10-21T18:10Z; start time approximate) | harness exit 1 (cost stop reached, expected); check-chunk: ok; 0 infrastructureFailure true | 0.03 / 0.09 (window reset between chunks) |
| 3 (line 20 USD, load 0.18 at start, nice 10) | rows 303 to 450 (attempts 450, streams 450, skipped 303) | 5.4666 USD (run total 15.5075 USD) | about 30 min (ended 2026-10-21T18:50Z; start time approximate) | harness exit 0 (all cells done); check-chunk --final: ok; 0 infrastructureFailure true | 0.06 / 0.10 |

Harness summary (450 rows, no failed session): atlas 225 ok, mean billable tokens 42906.1, mean tool calls 3.3, mean wall 11899 ms, cost 8.7457 USD; grep 225 ok, mean billable tokens 23951.7, mean tool calls 3.0, mean wall 10555 ms, cost 6.7618 USD; 75 questions with both arms; disagreement 4 of 75 (5.3%). Registered analysis (Task 9) not yet run.

## Discards

(none)

## Fetch hashes (Task 9)

(not yet)

## Classification (Task 9)

(not yet)

## Teardown (Task 11)

(not yet)
