# Clean-room replication: side-by-side with the registered run

## Declared differences

| condition | original run | replication |
| --- | --- | --- |
| Node.js version | 26.11.1 | 24.22.0 |
| Operating system and architecture | macOS arm64 | Debian bookworm x64 (container) |
| CPU and memory limits | the maintainer machine, no limits set | container limits (see environment.json) |
| User-level configuration | the maintainer's account state | one neutral notes file |
| Network location | the maintainer network | the Docker host network |
| Time | the date of the original run (plan 03-35) | the date of the replication (see environment.json) |

These are declared conditions, fixed before any replication data existed: they are the conditions under test, neither corrected for nor isolated. The classification below is a function of the result rows only.

classification: agreement-with-drift

The registered verdict is `OVERALL: MVP not met` in `docs/eval/analysis.md`. A replication cannot make the MVP met, cannot make it not met, and cannot unblock Phase 4. Only a new registered run that meets the gate does (D-04). Everything below is supplementary evidence about whether the measured quantities depend on the maintainer's machine and configuration, and is never pooled with the original run.

What it triggers: The criteria agree and some statistics moved; the report names which. The review is informational.

## Validity

Validity: valid.

## A1: the outcome of each registered criterion

| criterion | original | replication | agree |
| --- | --- | --- | --- |
| H1 accuracy | met | met | yes |
| H2 tokens | not met | not met | yes |
| H3 citations | not met | not met | yes |

## A2: the between-run difference per statistic (10000 resamples over questions, seed 20261017, 2.5th to 97.5th percentile)

| statistic | original | replication | difference | lower | upper | compatible |
| --- | --- | --- | --- | --- | --- | --- |
| S1 accuracy difference (atlas minus grep) | +0.0489 | +0.0044 | -0.0444 | -0.0933 | 0.0000 | NO |
| S2 billable-token difference (atlas minus grep) | +17982.0 | +18954.4 | +972.4 | -2767.7 | +5591.1 | yes |
| S3 atlas citation rate | +0.7273 | +0.7020 | -0.0253 | -0.0657 | +0.0101 | yes |

Criteria that differ: none.
Statistics that moved: accuracy.

## Reported quantities (not classified)

| quantity | original | replication |
| --- | --- | --- |
| mean billable tokens, atlas | 47375.1 | 42906.1 |
| mean billable tokens, grep | 29393.1 | 23951.7 |
| token ratio, atlas over grep | 1.612 | 1.791 |
| atlas sessions with a verifiable citation | 144 of 198 (72.7%) | 139 of 198 (70.2%) |
| grep sessions with a verifiable citation | 146 of 198 (73.7%) | 147 of 198 (74.2%) |
| atlas sessions that called an atlas tool | 86 of 225 (38.2%) | 76 of 225 (33.8%) |
| atlas sessions that loaded the skill | 0 of 225 (0.0%) | 0 of 225 (0.0%) |
| notional cost, USD | 16.1142 | 15.5075 |
| mean wall time, atlas, ms | 7910 | 11899 |
| mean wall time, grep, ms | 7627 | 10555 |
| failed sessions, atlas | 0 | 0 |
| failed sessions, grep | 0 | 0 |
| cells whose correctness differs, atlas | n/a | 15 |
| cells whose citation outcome differs, atlas | n/a | 17 |
| cells whose correctness differs, grep | n/a | 15 |
| cells whose citation outcome differs, grep | n/a | 17 |

### Per category

| category | accuracy atlas (O / R) | accuracy grep (O / R) | token ratio (O / R) |
| --- | --- | --- | --- |
| abstain | 1.000 / 1.000 | 1.000 / 1.000 | 1.363 / 1.546 |
| adr | 0.900 / 0.867 | 0.833 / 0.833 | 1.679 / 1.658 |
| callers | 0.725 / 0.706 | 0.686 / 0.725 | 1.403 / 1.559 |
| definition | 1.000 / 1.000 | 1.000 / 1.000 | 1.413 / 1.760 |
| emit | 0.500 / 0.433 | 0.300 / 0.300 | 1.822 / 1.813 |
| heritage | 1.000 / 1.000 | 1.000 / 1.000 | 1.816 / 1.810 |
| impact | 0.611 / 0.389 | 0.556 / 0.556 | 1.805 / 2.667 |
| references | 0.750 / 0.792 | 0.750 / 0.792 | 1.861 / 1.811 |
