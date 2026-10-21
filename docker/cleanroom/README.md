# Clean-room replication: maintainer re-run guide

This directory holds the container recipe and the control script of the clean-room replication (plan 03-39). The guide is for maintainers and is deliberately not linked from the root README.

## What the clean room is, and what it can and cannot show

The clean room runs the registered eval command unchanged inside a container that holds Node, git, ripgrep, Claude Code 2.1.302 and one short neutral notes file, with no plugin, skill, MCP server, hook, agent or secret of its own. It is a supplementary replication: it asks whether the measured quantities depend on the maintainer's machine and configuration.

- The registered verdict is `OVERALL: MVP not met` in `docs/eval/analysis.md`, and it stands. A replication cannot make the MVP met, cannot make it not met and cannot unblock Phase 4. Only a new registered run that meets the gate does.
- The result is never pooled with the original run and never replaces it.
- One run of 450 sessions is one more sample of a stochastic process. It is not a variance estimate and tests no single condition in isolation.
- The report of the replication that was made is `docs/eval/replication-cleanroom.md`; its result tables are under `docs/eval/results-cleanroom/`.

## Prerequisites

- ssh access to a Docker host, with the target exported as `CLEANROOM_SSH` (there is no default, and the script refuses a value with characters outside letters, digits and `. _ @ : -`).
- Docker on that host usable without sudo. The script never uses elevated rights, mounts no socket and publishes no port.
- A Claude Max login that you control, with extra usage turned off. The run uses the subscription allowance; the preflight stops when it sees paid usage or does not rule it out.
- The registered-base rule: build the checkout from the registered base commit (see below), never from the integration head.

Every remote command the script builds uses five fixed object names, all labelled `org.gsd-atlas.cleanroom.plan=03-39`: the container `gsd-atlas-cleanroom`, the image `gsd-atlas-cleanroom:03-39`, the network `gsd-atlas-cleanroom-net` and the volumes `gsd-atlas-cleanroom-home` and `gsd-atlas-cleanroom-work`. Removal reads the label first and acts only on those names.

## Which code goes in the container

The container is always built from the registered base commit `a21ef8bfed512fb3810c2b9944344d1f530f0d5b` plus one local tooling commit that differs from the base only under `scripts/cleanroom` and `docker/cleanroom`. Never build it from the integration head: the head's build inputs differ from the measured build (the post-eval fixes), and the scored gate refuses it. Package the two commits as a git bundle on the maintainer machine and record its sha256 for `load-bundle`.

## Steps

All commands run from the repository root of the maintainer machine. `ctl` below stands for `bash docker/cleanroom/cleanroomctl.sh` with `CLEANROOM_SSH` exported.

1. Probe the host (read-only). It prints facts about Docker, disk, memory, CPUs and load, and exits 3 if one of the five own objects already exists; reuse or removal is then your choice.

   ```
   ctl probe
   ```

2. Build the image. The context is a tar stream of `Dockerfile` and `user-claude.md`; nothing is staged on the host. Node is 24.22.0 by default; `NODE_MAJOR=26` selects the pinned 26.12.0 base instead.

   ```
   ctl build
   ```

3. Create the network and volumes and start the container with explicit limits, then show its state.

   ```
   ctl up
   ctl status
   ```

4. Load the bundle and provision the checkout inside the container (clone from the bundle, `npm ci`, `npm run build`, prepare the corpus checkout under `/work/prep` with `scripts/eval/prepare-corpus.ts`), using `ctl exec <command>` for each step.

   ```
   ctl load-bundle <bundle file> <sha256>
   ctl exec git clone /work/in/atlas-cleanroom.bundle /work/gsd-atlas
   ```

5. Check the provisioning. It compares Claude Code version, Node version, uid, absence of API-key and token variables, the contents of the Claude home, the tooling commit, a clean git status, the atlas build, the prepared corpus record and the registered plan (gate `ok`, 450 cells, first ten cells). It prints `provision: ok`.

   ```
   TOOLING_COMMIT=<full tooling commit id> ctl verify-provision
   ```

6. Log in. This is done by you, in a separate terminal, inside the container; the script never handles the login.

   ```
   ctl shell
   claude auth login        # inside the container, choose the Max subscription login
   ```

7. Preflight. It checks the login is the Max subscription login with no paid usage, runs four short probe sessions (atlas, grep and two isolation controls) within a 0.20 USD notional cap, checks their streams and re-checks the registered plan. It prints `preflight: ok`.

   ```
   ctl preflight
   ```

8. Run in chunks. The registered command is launched detached, once per chunk, each with a cost line from `--stop-at-cost-usd` (harness-side: it stops scheduling when the results directory has cost that much, so the lines rise from chunk to chunk, 5, 10 and 20 USD in the replication that was made). Wait for the host load to be 6 or less before each launch (see Troubleshooting).

   ```
   ctl exec --detach chunk1 node scripts/eval/harness.ts run --scored \
     --questions scripts/eval/questions/gsd-core.questions.json \
     --answers scripts/eval/questions/gsd-core.answers.json \
     --corpus-dir <the directory under /work/prep> --out-dir /work/cleanroom-run \
     --arms atlas,grep --runs 3 --concurrency 2 --seed 20261017 \
     --model claude-sonnet-5-5 --prereg docs/eval/preregistration.md \
     --stop-at-cost-usd 5
   ```

   Follow the log under `/work/logs/chunk1.log` with `ctl exec tail -n 20 /work/logs/chunk1.log`. A chunk that stops at its line exits 1, which is expected; the last chunk exits 0 when all 450 cells are done.

9. Check after every chunk, before the next launch. The harness records a rate-limit or infrastructure failure as an incorrect answer and never reruns it, so a quiet failure would become data. The check also reports Max headroom and prints `check: ok` when it finds nothing; any finding is a stop for you. Use `--final` after the last chunk.

   ```
   ctl exec node scripts/cleanroom/check-chunk.ts --out-dir /work/cleanroom-run
   ctl exec node scripts/cleanroom/check-chunk.ts --out-dir /work/cleanroom-run --final
   ```

10. Fetch the results to a local directory (the script accepts only paths under `/work` and prints a sha256 per file).

    ```
    ctl fetch /work/cleanroom-run <local directory>
    ```

11. Summarise and analyse with the registered tools, unmodified, then compare under the rules fixed beforehand and scrub the files you intend to commit.

    ```
    node scripts/eval/harness.ts summary --out-dir <local directory>/cleanroom-run
    node scripts/eval/analyze.ts <local directory>/cleanroom-run/results.jsonl \
      --prereg docs/eval/preregistration.md --out docs/eval/results-cleanroom/analysis-cleanroom.md
    node scripts/cleanroom/compare.ts --original docs/eval/results/results.jsonl \
      --replication <local directory>/cleanroom-run/results.jsonl --environment <environment.json> \
      --out docs/eval/results-cleanroom/comparison.md --json <file>
    node scripts/cleanroom/scrub.ts --check <files and directories to commit>
    ```

12. Tear down. `down` logs out of Claude Code in the container first (`claude auth logout`, starting a stopped container once for that), whatever the choice, then acts.

    ```
    ctl down remove          # container, network, volumes and image, label read first
    ctl down keep-stopped    # or: log out, stop the container, keep everything
    ctl down keep-running    # or: log out only
    ```

## Node version

The pinned default is Node 24.22.0; Node 26.12.0 is available by explicit selection (`NODE_MAJOR=26` at build and at `verify-provision`). The original registered run was made on Node 26.11.1. The Node version is therefore a declared difference of the clean room from the original run, a condition under test, not a confound that was removed; no difference in the results is attributed to it.

## Resource limits and why

The container runs with 4 CPUs, 12 GiB of memory with swap equal to it, 2048 processes, CPU shares 512, uid 10001, all capabilities dropped, `no-new-privileges`, no restart policy and no published port. They exist because the host is shared: whatever goes wrong in the run, its impact on the host is bounded. They are set with `CPUS`, `MEM`, `PIDS` and `SHARES` at `up` and are a recorded condition of the run.

## What the replication that was made took

- Three chunks with notional cost lines of 5, 10 and 20 USD: rows 0 to 141 in about 80 minutes, rows 141 to 303 in about 5 hours, rows 303 to 450 in about 30 minutes.
- 15.5075 USD notional in total, on a Max login with extra usage off. Headroom ended at five-hour 0.06 and seven-day 0.10.
- The host load was above the gate of 6 (10 to 19 on 8 CPUs) during provisioning, so each chunk waited until the load was 0.2 or less.

## Troubleshooting

- Login expired or `preflight` reports a login that is not the Max login: log in again in the container (step 6), then run `ctl preflight` again.
- Container stopped: start it on the host, then check `ctl status` before going on. Run `ctl exec` only against a container that shows as running.
- Headroom: if the check or the preflight reports too little five-hour or seven-day headroom, wait for the window to reset. Never turn on extra usage to get past it.
- Host load: read `/proc/loadavg` through `ctl exec cat /proc/loadavg` and wait until the one-minute figure is 6 or less before launching a chunk.
- Infrastructure failures: the harness records them as incorrect answers and never reruns them. Run `check-chunk.ts` after every chunk. If it names a finding, stop and decide with the Deviations policy of the pre-registration; do not rerun or edit rows by hand.
