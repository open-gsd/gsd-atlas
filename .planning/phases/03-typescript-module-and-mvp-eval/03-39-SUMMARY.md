---
phase: 03-typescript-module-and-mvp-eval
plan: 39
subsystem: eval
tags: [eval, replication, clean-room, docker, claude-max]
status: complete

provides:
  - "docs/eval/replication-cleanroom.md: supplementary clean-room replication report"
  - "docs/eval/results-cleanroom/: compact rows, scrubbed sidecars, registered analysis, comparison, environment"
  - "scripts/cleanroom/ tooling (compare, check-chunk, scrub, probe, init-signature) and docker/cleanroom/ (image, control script, re-run guide)"

actuals:
  tasks: 11
  cost_usd_notional: 15.5075
  chunks: 3
  discards: 0
plan_head_before: 025269b
---

# Plan 03-39 summary: clean-room replication

**The registered verdict stands: `OVERALL: MVP not met` (`docs/eval/analysis.md`).** This replication is supplementary and is never pooled with it.

## Result

Class **agreement-with-drift**, valid. The three registered criteria agree with the original (H1 accuracy met, H2 tokens not met, H3 citations not met); the registered analysis, run unmodified on the replication rows, also prints `OVERALL: MVP not met`. One statistic moved: the paired accuracy difference (atlas minus grep) is +0.0044 against +0.0489, with a between-run difference of -0.0444 (interval -0.0933 to 0.0000, incompatible because the bound sits on zero). The token difference (+18954.4 against +17982.0) and the atlas citation rate (70.2% against 72.7%) are compatible. Most of the accuracy movement is in the `impact` category (atlas 0.611 to 0.389), which the report does not explain.

## Environment differences (declared, not removed)

Node version first: original 26.11.1, clean room 24.22.0. Also: macOS arm64 against Debian bookworm x86_64 container, 4 CPUs and 12 GiB limits, one neutral notes file instead of the maintainer's account state, a different network, a different date. No difference is attributed to any one condition.

## What was and was not verified

Verified: 450 of 450 sessions ok, no infrastructure failure, no hook event, no init-signature difference, no paid-usage use, login via claude.ai Max with extra usage off; the harness isolation flags kept the user-level notes file out of sessions (control probes); fetched files equal the container's hashes; the interpretation rules (`compare.ts`) and the frozen eval files are unchanged. Not verified: which declared condition, if any, caused the accuracy movement; variance of the measurement (this is one more sample); server-side revocation of the login.

## Cost, time, chunks

15.5075 USD notional on a Max subscription. Three chunks (lines 5, 10 and 20 USD notional; rows 0 to 141, 141 to 303, 303 to 450; about 80 min, 5 h and 30 min), one launch each, no discards, no reruns. Host load gated each start.

## Teardown

Retention choice `remove`: logged out, then the container, network, both volumes and the image removed; the host's other services are unchanged apart from two of the host's own short-lived test containers.

## Open items

- A re-run must again use the registered base commit plus a local tooling commit, never the integration head, whose build inputs differ from the measured build (the scored gate refuses it).
- Follow-up, started by the user: one sentence in the README's evaluation status or the alpha limitations page citing `docs/eval/replication-cleanroom.md` with the class, the Node version of the run and the standing verdict. This plan did not edit the user documentation.
- The stale executor worktree `.claude/worktrees/agent-aea1cc3d299452739` (and the guide worktree) can be removed with `git worktree remove --force`.
- Nothing is pushed; the 19 plan commits are local.
