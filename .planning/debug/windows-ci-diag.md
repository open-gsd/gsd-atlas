# Windows CI slowness: measured causes (branch ci/win-diag)

Runs on the throwaway orphan branch `ci/win-diag` of open-gsd/gsd-atlas (workflow `win-diag`, no product code, `ci.yml` not triggered).
Run 1: 39069761216 (all experiments). Run 2: 39071242220 failed to parse (YAML, no jobs); the corrected rerun is run 39071311568 (spawn variants, long-cap suite). Image: win25-vs2026 20261007.264.1, Windows 10.0.26100, 2 vCPU (AMD EPYC 7763), 8 GiB, git 2.56.0.windows.2, Node 24.16.0. Single runs, so numbers carry runner noise of roughly +-30 percent (see the three C: file-IO rows and baseline-vs-baseline below).

## Runner facts (A. environment)
- `os.tmpdir()` = `C:\Users\RUNNER~1\AppData\Local\Temp` (C:, virtual disk 0, 160 GB, 31 GB free). `RUNNER_TEMP` = `D:\a\_temp` and `GITHUB_WORKSPACE` = `D:\a\gsd-atlas\gsd-atlas` (D:, separate virtual disk 1, 80 GB). C: and D: are different volumes on different virtual disks.
- Defender: service running, but `RealTimeProtectionEnabled False`, `BehaviorMonitorEnabled False`, `IsTamperProtected False`, `DisableRealtimeMonitoring True`, and `ExclusionPath {C:\, D:\}` already set by the image. WSearch disabled, Sense stopped. Power plan High performance. MsMpEng is the top CPU process by accumulated time (18 s) but is not scanning on access.
- `where.exe git` order for Node: `Git\ucrt64\bin\git.exe`, `Git\bin\git.exe`, `Git\cmd\git.exe`. Git config: `core.fscache=true`, `core.autocrlf=true`, lfs filters in system config.

## B. Spawn microbenchmark (median ms, 200 sequential spawns, no shell)

| variant | Linux | macOS | Windows | Win/Linux | Win/macOS |
|---|---:|---:|---:|---:|---:|
| node -e 0 | 18.8 | 26.9 | 57.6 | 3.1x | 2.1x |
| git --version (PATH = ucrt64\bin) | 1.6 | 4.8 | 37.8 | 24x | 7.8x |
| git rev-parse --git-dir | 1.6 | 4.9 | 39.8 | 24x | 8.2x |
| git hash-object a.txt | 1.7 | 5.0 | 39.7 | 23x | 7.9x |
| git config --get-regexp ^filter\. | 1.7 | 4.7 | 39.1 | 23x | 8.2x |
| cmd.exe /c exit 0 (Windows only) | | | 21.3 | | |
| git Git\bin\git.exe --version | | | 38.2 | | |
| 4 parallel, git --version, per spawn | 1.2 | 1.5 | 28.9 | | |

Round 2 (a quieter runner): git 27.0, bin\git.exe 26.9, cmd.exe 14.8, node 44.6, git rev-parse 28.1; parallel x4 20.0 per spawn. The `Git\cmd\git.exe` and `mingw64`/`ucrt64`-root variants errored with ENOENT in both runs (my GitRoot derivation picked `Git\ucrt64`); `cmd\git.exe` was therefore not measured directly. Cwd in D: (`RUNNER_TEMP`) or C: makes no difference (36.8-39.3 vs 37.8-39.8).

## C. File-IO (median ms per op; ops/s in brackets), the big finding

| metric | Linux | macOS | Windows C: (os.tmpdir) | Windows D: (RUNNER_TEMP) | Windows D: (workspace) |
|---|---:|---:|---:|---:|---:|
| create+write+fsync+close+unlink | 0.41 (947 to 2311 ops/s) | 0.58 | **5.74 (164)** | 0.69 (1372) | 0.68 (1391) |
| mkdir+rmdir | 0.033 | 0.049 | **0.418 (2302)** | 0.151 (6178) | 0.148 (6311) |
| append 4 KiB + fsync | 0.23 | 0.45 | **3.33 (286)** | 0.25 (3519) | 0.25 (3561) |

On C: Windows is 13-14x Linux; on D: it is 1.2-1.7x (appends and file create) and 4.5x for mkdir/rmdir. D: is 8-13x faster than C: for fsync-bearing work. In the Defender job the C: numbers were 103/144 ops/s (create, append) against 1421/3683 on D:.

## D. Defender variants (Windows, spawn median ms)
| variant | baseline | exclusions added | real-time monitoring disabled |
|---|---:|---:|---:|
| git --version | 35.3 | 36.2 | 35.4 |
| git rev-parse | 36.5 | 38.2 | 37.0 |
| cmd.exe /c exit 0 | 19.1 | 19.9 | 19.3 |
| node -e 0 | 55.8 | 58.3 | 55.5 |
| C: create+fsync ops/s | 103 | 201 | 202 |
| C: append+fsync ops/s | 144 | 375 | 370 |
| D: create+fsync ops/s | 1421 | 1402 | 1415 |

Speedups are 0.96-1.01x for every spawn. The disable command was accepted (no Tamper Protection) but it was already off. The C: file-IO doubling after the exclusions is not a Defender effect: the same step order was baseline (first, cold) then the others, and the real-time scanner was already off; the C: value is also noisy between jobs (164, 103 ops/s baseline; 201, 202 later). Treat as 1.5-2x noise/warm-up on C:, still 5-10x below D:.

## E. Real suite slice (src/source-tree, src/command-runner, indexer/freshness, fact-store/maintain; node --test; `npm ci --ignore-scripts`)

| run | Linux | Windows |
|---|---:|---:|
| baseline (default concurrency = 3 at 2-4 vCPU) | 62.1 s | run 1: >200 s (cap). run 2: >560 s (cap) |
| TEMP/TMP = RUNNER_TEMP (D:) | | run 1: 131.7 s. run 2: 136.1 s |
| conc 1 (C: temp) | 59.8 s | run 2: 431 s |
| conc 4 (C: temp) | 50.1 s | run 2: 415.7 s |
| Defender exclusions only (C: temp) | | run 1: >200 s (cap) |
| Defender exclusions + TEMP on D: | | 135.7 s |
| all combined: TEMP=D:, conc 1 / 2 / 4, exclusions on | | 137.9 / 127.0 / 111.7 s |

Windows slice on D: temp is about 2.2x Linux (136 vs 62 s). Windows baseline is more than 9x Linux (>560 s vs 62 s). The baseline never finished inside the cap, so the true baseline is higher than the numbers shown. Concurrency 1 vs 4 on C: moved 431 vs 416 s (1.04x); on D: with exclusions conc 1/2/4 gave 138/127/112 s (about 1.2x between extremes).

## Interpretation (with numbers)

1. **The disk (C: vs D:) is the dominant cause of the test and size-gate slowness.** The slice goes from >560 s to 136 s (more than 4.1x, and the baseline is a lower bound) by pointing TEMP/TMP at `RUNNER_TEMP` on D: alone. The microbenchmark explains it: fsync-bearing file operations on `os.tmpdir()` (C:) take 3.3-5.7 ms, on D: 0.25-0.69 ms (Linux 0.2-0.4 ms). Our tests and gates create their work dirs under `os.tmpdir()`, and the size gate does 20,000 SQLite commits plus VACUUM there. This matches the earlier observation (size gate 390 s vs 8-25 s; maintain/vacuum tests 9-33x slower).
2. **Defender is not the cause.** The image already has real-time and behaviour monitoring off and `C:\` and `D:\` fully excluded; adding exclusions or disabling monitoring changed spawn cost by 0.96-1.01x and the suite not at all (exclusions only: still capped; exclusions + D: temp 135.7 s vs D: temp alone 131.7-136.1 s).
3. **The git.exe launcher layer is not the cause.** `git` via PATH (ucrt64\bin) 37.8 ms equals `Git\bin\git.exe` 38.2 ms (round 2: 27.0 vs 26.9). Caveat: `cmd\git.exe` and the mingw64 variants were not measured (ENOENT, my path derivation).
4. **Raw process creation on Windows is the remaining floor for spawns, and it is not removable by configuration.** `cmd.exe /c exit 0` already costs 14.8-21.3 ms, `node -e 0` 45-58 ms, git 27-40 ms (Linux 1.6, macOS 4.8). That is 23-24x Linux and 8x macOS per git spawn, in line with the 118-150 ms per spawn in test timings (those include extra work on C:). Disk location does not change it (D: cwd 36.8-39.3 ms). The only lever is fewer spawns per operation; hence the freshness-gate options in `windows-freshness.md` still stand, and the 3-vs-7 spawn counts there give 3 x 27-40 = 80-120 ms of pure process cost at the quiet end.
5. **CPU contention / test concurrency: minor.** 1.04x (conc 1 vs 4 on C:), at most 1.2x on D:. Not a cause. Note the runner has 2 vCPUs (not 4) and 8 GiB.
6. **What remains after moving to D:** the slice is 2.2x Linux (136 vs 62 s), consistent with the spawn floor (point 4); an unmeasured part of the full Windows job.

## Smallest CI change that recovers most of the gap
Set `TEMP`, `TMP` (and `TMPDIR`) to `${{ runner.temp }}` for the Windows jobs (a single `env:` block, or `echo "TEMP=$RUNNER_TEMP" >> $GITHUB_ENV` in a bash step; the gates should use `os.tmpdir()` which then returns D:\a\_temp). Measured: slice 4.1x or better faster, and the same path is what the size gate, corpus build and freshness gate use. No Defender tweak, no git path change and no concurrency change is justified by the data. Verify on the full job (the ~22-30 min Windows test job) after the change; expect it to remain slower than Linux because of the spawn floor.

## Caveats
Each cell is one runner instance; Windows runners vary (spawn 37.8 vs 27.0 ms for the same step between rounds). Suite pass/fail counts were not parsed (reported null; exit 0 in every uncapped run). The `Git\cmd\git.exe` variant was not measured. Round-1 artifacts: run 39069761216; its job summaries hold the full tables.
