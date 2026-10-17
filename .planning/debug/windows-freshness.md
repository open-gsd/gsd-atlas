---
status: diagnosed
trigger: "Why is the freshness gate (node scripts/freshness-gate.ts) slow on hosted Windows? p50/p95/p99 over 30 saves: 415/597/837 ms then 709/1343/1396 ms, against Linux 197-299 ms and macOS 291-317 ms p99. Roadmap bound p99 < 1000 ms, PR ceiling 3000 ms."
goal: find_root_cause_only
created: 2026-10-17T19:50:00Z
updated: 2026-10-17T20:40:00Z
---

## Current Focus

hypothesis: CONFIRMED (inferred, not yet measured on a Windows machine). Save-to-find latency is `event + 100 ms debounce + N sequential git spawns x spawn cost + a poll overshoot`. N is 3 for an edit of a known file and 7 for a new file. A git spawn costs about 4 ms on hosted Linux, about 7 ms on a dev Mac and about 35-160 ms on hosted Windows, so the Windows figure is the spawn count multiplied by a noisy per-spawn cost.
next_action: owner decides which option below to take; the first one (targeted ignore check, option 1) removes 4 of the 7 spawns of a new file and is the largest single lever. Confirm the per-spawn figure on a hosted Windows run with the trace preload in the appendix.

## Symptoms

expected: p99 save-to-find below 1000 ms on every OS (nightly), below 3000 ms on a pull request.
actual: hosted Windows over 30 saves: 415/597/837 (run A), 709/1343/1396 (run B), 408/507/514 (run C). Linux 197-213 / 224-250 / 251-299, macOS 243-252 / 286-297 / 293-317.
errors: none; the PR ceiling is met, the strict 1000 ms bound would be missed in run B.
reproduction: `gh run view <id> --log --job <Gates (windows-latest) id>`, step "Freshness gate (pull request ceiling)".
started: always on Windows; the size of the figure moves a lot from run to run.

## The three hosted runs (gate job, same step order)

| run | head | Windows p50/p95/p99 | Linux p50/p95/p99 | macOS p50/p95/p99 |
|---|---|---|---|---|
| A 39048213960 | 0b3a460 | 415 / 597 / 837 | 197 / 230 / 264 | 248 / 291 / 293 |
| B 39062625405 | 76957ff | 709 / 1343 / 1396 | 201 / 224 / 299 | 243 / 286 / 317 |
| C 39065781198 (gates job finished; test jobs still running) | 0f4b768 | 408 / 507 / 514 | 213 / 250 / 251 | 252 / 297 / 299 |

Other gate steps in the same jobs (seconds):

| step | Windows A / B / C | Linux A / B / C | macOS A / B / C |
|---|---|---|---|
| corpus first build (1686 files parsed) | 195.7 / 169.3 / 84.0 | 21.0 / 33.1 / 28.6 | 9.0 / 8.9 / 10.8 |
| corpus second build (0 parsed, 1689 linked) | 2.1 / 3.5 / 1.6 | 0.7 / 1.2 / 1.4 | 1.1 / 1.1 / 1.1 |
| size gate (20,000 commits) | 390.3 / 94.0 / 75.5 | 25.1 / 35.8 / 16.0 | 8.0 / 8.3 / 9.3 |
| size gate, longest single `maintain` (ms) | n/a / 608 / 315 | n/a / 87 / 47 | n/a / 24 / 32 |

The size gate changed between A and B (new idle policy, new output), so A is not comparable with B and C for that row.

## Answer to question 1: what the measured latency includes

`scripts/freshness-gate.ts`. The clock starts when `fs.writeFileSync` returns (`saved = performance.now()`), and stops when a poll of `composed.client.handle({kind:'code_find', args:{name, repo}})` returns the new name. The poll sleeps 25 ms (`POLL_MS`) between calls. The gate alternates an edit of an existing file (`m{(save*7)%200}.ts`) with the creation of a new file (`added_{save}.ts`), so half the samples are each kind. It prints only p50/p95/p99 (nearest rank; with 30 samples p99 is the single largest and p95 the second largest). It prints no stage timing and no per-kind figure, although `runFreshnessGate` returns `samples` and `kinds`.

The pieces, in order, with what I measured on macOS (18 cores, local SSD, git spawn about 7 ms; one trace per run, see the appendix):

| # | stage | where | cost |
|---|---|---|---|
| 1 | kernel event, `@parcel/watcher` native thread, parcel's own debounce (`Debounce.cc`: the first event after 500 ms of silence is delivered at once, otherwise it waits for 50 ms of quiet), JS callback | `parcel-source.ts` | macOS: 72 ms when saves are less than 500 ms apart (the fast case), 11 ms when they are further apart (the slow case, which is Windows' case) |
| 2 | Indexer coalescing queue: `indexer.debounceMs` 100 (maxWait 500), per path | `queue.ts`, `defaults.ts` | 100 ms, measured as 113-114 ms from write to first indexer spawn in the slow case |
| 3 | `processBatch` -> `prepare`: PathFilter, `hashPaths`, `sourceSet` | `process.ts`, `ignore.ts`, `source-tree/real.ts` | N sequential git spawns (below) |
| 4 | Governor job: stamp check, `Writer.link` (rejected for a new hash), `readText`, parse in the warm worker pool, `commitFile` | `process.ts` | under 10 ms on macOS (check-attr exit to first BEGIN IMMEDIATE) |
| 5 | poll overshoot: the first `code_find` that starts after the commit and finishes. Each `code_find` is a full Host request (below) | gate + `host/route.ts` | 34-42 ms on macOS plain; 52-175 ms when spawns are slow |

Git spawns in the single-file path (verified from a spawn trace, and by reading the code):

- Edit of a file the PathFilter already knows (everything the build saw): 3, strictly sequential. `git config --name-only --get-regexp ^filter\.` (`listFilterNames`, never cached by design), `git hash-object --stdin-paths`, `git check-attr -z --stdin linguist-generated linguist-vendored` (`sourceSet`).
- Creation of a new file: 7, strictly sequential. `PathFilter.keep` does not know the path, so it calls `tree.snapshot(worktree)` as its ignore oracle: `git config` + `git ls-files -z -s` + `git ls-files -z --others --exclude-standard` + `git hash-object --stdin-paths` over EVERY file in the work tree (200 in the gate, 3,976 in the corpus repository). Then the same 3 as an edit. The `known` set learns the whole snapshot, so only a path that is new to the filter pays, but every new file does.
- Every poll: 3. `Host.repoRequest` -> `resolveRepository` runs `git rev-list --max-parents=0 HEAD` and `git worktree list --porcelain -z` in parallel, then `git rev-parse --git-common-dir` (`SourceTree.identity()` is two spawns in sequence). There is no cache, so every request of the product (not just the gate) pays two spawn stages (three processes) before it reads the store. In the trace an edit window held 6-12 poll spawns against 3 indexer spawns.

What one spawn costs on Windows, by kind: I could not separate the kinds from the logs, and I expect them to be close to each other because process start dominates (`config`, `rev-parse`, `worktree list`, `check-attr` and `rev-list` do almost no work). The exception is the snapshot's `hash-object`, which also opens and hashes every file in the work tree (200 here); on a repository of thousands of files it is the one that grows. The per-spawn cost below is therefore one number per run.

## Answer to question 2: what dominates on Windows

The process spawn, at 3 (edit) or 7 (new file) sequential stages per save, plus a poll that itself spawns. Evidence, in decreasing strength:

1. Spawn-only reproduction. On the Mac I put a `git` shim first on PATH that sleeps a fixed time and then execs the real git (no product code touched, 30 saves, the real gate function). Nothing else was changed: same watcher, same SQLite, same parse pool.

   | per-spawn cost (shim) | p50 / p95 / p99 | edit median | add median |
   |---|---|---|---|
   | none (about 7 ms) | 229 / 268 / 270 (20 saves) | 227 | 266 |
   | about 70 ms (sleep 0.05) | 516 / 857 / 866 | 501 | 689 |
   | about 135 ms (sleep 0.11) | 578 / 1172 / 1178 | 563 | 1160 |

   Hosted Windows run A (415/597/837) sits at about 55-70 ms per spawn, run B (709/1343/1396) at about 130-160 ms, run C (408/507/514) at about 35-45 ms. The shape matches too: edits are about 3 stages and adds about 7, so the distribution is bimodal and the alternating saves put p50 on the boundary and p95/p99 on the adds. With a 135 ms spawn the trace gives: write, watcher event at 11 ms, first indexer spawn at 113 ms, commit at 517 ms (edit; 3 x 135 = 405 after 113) or 1071 ms (add; 7 x 135 = 945 after 113), found at 569 / 1167 ms. Parse and commit are the 10-25 ms that remain.
2. Calibration of the Windows spawn cost from existing CI test timings (run B, Node 26 test jobs, same test, three OSes). A test with a known spawn count (counted locally with the trace preload): `reads a historical blob ... exactly two cat-file starts` is 12 spawns: Windows 1840 ms, Linux 53 ms, macOS 122 ms, so about 150 ms, 4 ms and 10 ms per spawn including the work around it. `exactly one hash-object start for a repository with 150 files` is 15 spawns: 1777 / 73 / 198 ms. Over all 557 tests that take 50 ms or more on Linux, Windows is a median 7.8 times slower than Linux and 6.0 times slower than macOS, and many of the git-heavy ones are 12-35 times slower.
3. A clean single-edit measurement already in the test suite. `src/indexer/freshness.test.ts` edits a known file and polls the store directly (no Host request, so no poll spawns): run A / run B: Linux 127 / 123 ms, macOS 147 / 126 ms, Windows 268 / 313 ms. The Windows excess of 141-190 ms is 3 spawns at about 47-63 ms each, with nothing left over for a slow event delivery. (The same run's gate implies a higher figure for B; the spawn cost moves from minute to minute inside a run too, and the test and gate jobs ran in parallel, not at the same instant.)
4. What the spawn-only simulation does not need. It reproduces the Windows distribution with a fast watcher, fast SQLite and a warm parse pool, so there is no room for a large event-delivery, commit or parse excess:
   - ReadDirectoryChangesW delivery: not supported as a main cause. No residual for it in items 1 and 3. Not measured directly: the trace has to run on Windows to bound it (stage 1 timestamp below).
   - SQLite commit with fsync: at most 2 commits per save. The size gate (pure SQLite, 20,000 commits and 101 maintenance runs) averages 3.8-4.7 ms per commit on Windows in runs B and C, including maintenance (19.5 ms in run A, whose maintenance policy was older). That is at most 10-40 ms of a 400-1400 ms save. The store runs WAL with `synchronous=NORMAL`, which does not fsync on every commit.
   - Defender: the runner image sets Defender passive (secondary source, a blog quoting the runner-images scripts), so on-access scanning is unlikely. Not measured.
   - Parse pool: the build parses the 200 gate files first, so the pool is warm; locally parse plus commit is under 10 ms. The cold start is visible elsewhere (`save to find through the MCP server`, first save: Linux 627-686 ms, Windows 716-1129 ms) and Windows is only 1.1-1.7 times Linux there, which is not the 15-35 times of a spawn.
   - Timer resolution: Windows timers can add up to about 15 ms per hop (parcel debounce, 100 ms queue timer, 25 ms poll sleep). Small, not measured.

Where "N x s" comes from in the source: `process.ts prepare()` awaits `filter.keep` (snapshot), then `hashPaths` (config, then hash-object), then `sourceSet` (check-attr), in that order, one after the other. `check-attr` does not depend on the hash and could overlap with `config`; that is option 2 below.

## Answer to question 3: variance (415 vs 709, and 514 vs 1396)

Runner noise multiplying a spawn-heavy path. We do not cause the noise; we cause how much it is amplified.

- The single-file path has the same spawn count in all three runs. I diffed A to B and B to C (`src/source-tree/real.ts`, `identity.ts`, `host/route.ts`, `indexer/*`): changes are caps and timeouts on other reads, a shared `isInside`, a macOS-only `renewsWorktrees`, an `index_state` kind. None adds or removes a spawn on this path.
- Same-named tests of the Windows test job, run B over run A, median ratio of durations: Windows 1.41, Linux 0.85, macOS 1.00 (648, 393 and 396 tests of 100 ms or more). Windows alone moved.
- The three Windows p99 values are 837, 1396, 514 for the same path (2.7 times between the extremes); Linux 251-299 and macOS 293-317 (about 20 percent). The corpus first build on Windows went 196, 169, 84 s.
- A uniform multiplier fits: p50, p95 and p99 moved by 1.7, 2.2 and 1.7 between A and B.
- Exposure is ours: 3 spawns per edit, 7 per new file, 3 per poll. At 135 ms a new file spends 945 ms in spawns alone; with one spawn it would be 135 ms. So the same noisy runner produces a 2.7 times swing in p99 here and would produce a swing of under 150 ms with a one-spawn path.

## Answer to question 4: do the corpus first build and the size gate share the cause?

Same family (Windows per-operation cost), not the same operation. The freshness path is bound by process creation. The other two are not.

- Size gate: no git, no watcher, no parse, no worker. It is 20,000 `commitFile` calls plus 101 `maintain` runs on SQLite in a temp directory. Its Windows time (390 s in A, 94 s in B, 75.5 s in C, against 16-36 s Linux and 8-9 s macOS) is file-system cost: commits, WAL checkpoints and full VACUUM (the longest `maintain` call is 315-608 ms on Windows against 47-87 ms Linux and 24-32 ms macOS). The unit tests that do compaction and vacuum are 9-33 times slower on Windows (`vacuums a fragmented store once` 76 s against 2.3 s).
- Corpus first build: about 35 git spawns in total (snapshot 4, check-attr 1, then 3 per 256-file chunk times 7 chunks, plus identity and worktree calls), which is 1-6 s of the 84-196 s at 35-160 ms per spawn. The rest is per file: 50-116 ms per parsed file on Windows against 12-20 ms Linux and 5-6 ms macOS. It is not commit cost either: the second build links 1689 files with one commit each in 1.6-3.5 s (1-2 ms per commit). So it is read, extract (worker round trip, WASM) or the Governor, on the 4 vCPU runner. I have no data that separates those three; the trace preload can, if someone wants the corpus build faster.
- A shared cheap lever for the two I/O-heavy gates might be the disk. Every gate creates its work directory with `os.tmpdir()`. The checkout is on `D:\a\...` (shown in the job log) but the project's own notes say hosted temp paths are `RUNNER~1` short names, which is the user profile on `C:`. Community reports say `D:` is much faster than `C:` on hosted Windows runners. Not verified for this image. See option 4.

## Eliminated

- hypothesis: the code changed between run A and B and caused the 415 to 709 step
  evidence: no change to the spawn count or the sequence on the path (diff reviewed above); the same tests got 1.41 times slower on Windows only.
- hypothesis: slow event delivery (ReadDirectoryChangesW or parcel's 50 ms debounce) is the main cost
  evidence: a spawn-only slowdown on a fast-event machine reproduces both Windows distributions; the clean single-edit test leaves nothing over after 3 spawns at 48-63 ms. Parcel's 50 ms quiet wait is skipped at Windows' slow cadence (saves more than 500 ms apart, event at 11 ms in the slow simulation), so Linux and macOS, with saves 230 ms apart, carry an extra 50-60 ms that Windows does not.
- hypothesis: per-save SQLite fsync dominates
  evidence: see item 4; at most 2 small commits per save and the measured commit cost is milliseconds.
- hypothesis: the parse pool is cold or slow in the measured window
  evidence: the build warms it; under 10 ms from check-attr to commit.
- hypothesis (partial, not eliminated): caching the repository identity speeds up the gate
  evidence: prototype (below) shows no gain on an 18-core Mac. It removes 6-12 spawns per save from the machine, which can matter on a 4 vCPU Windows runner, and it removes about two spawn stages from every query, so it is still worth doing for the product.

## Evidence

- timestamp: 2026-10-17T20:05Z
  checked: scripts/freshness-gate.ts, src/indexer/{indexer,process,queue,ignore,parcel-source}.ts, src/source-tree/real.ts, src/command-runner/{real,exec-resolve,git-spec}.ts, src/host/{host,route}.ts, node_modules/@parcel/watcher/src/Debounce.cc
  found: the stage list and spawn counts above; `listFilterNames` runs on every `hashPaths`; `PathFilter.keep` uses `tree.snapshot()` (4 spawns and a hash of every file) for each new path; `repoRequest` resolves the repository with 3 spawns on every request; parcel debounce MIN 50 ms / MAX 500 ms.
  implication: 3 / 7 / 3 sequential spawns for edit / add / poll.
- timestamp: 2026-10-17T20:15Z
  checked: trace of the real gate on macOS (preload logging every `child_process.spawn`, the gate's writes, the watcher callback and SQLite statements)
  found: edit: 3 indexer spawns, add: 7, poll: 3; commit at 193 / 224 ms and found at 227 / 266 ms without a shim; with a 135 ms shim commit at 517 / 1071 ms and found at 569 / 1167 ms.
  implication: the latency is the stage sum; the poll adds 34-175 ms after the commit.
- timestamp: 2026-10-17T20:25Z
  checked: fixed-delay git shim, 30 saves (table above); scratch copy of the repository with two prototype changes
  found: option 1 (targeted ignore check): 70 ms spawn 516/857/866 -> 498/513/513, add median 689 -> 499; 135 ms spawn 578/1172/1178 -> 584/889/890, add median 1160 -> 870. Option 3 (identity cache) alone: 533/749/751 and 653/1228/1275 (no gain, within noise on 18 cores). Both: 470/567/657 and 670/834/862.
  implication: option 1 removes the add/edit gap; the edit path (3 stages) is the floor until option 2 or the deeper options.
- timestamp: 2026-10-17T20:30Z
  checked: Windows vs Linux vs macOS durations of the same tests in the Node 26 test jobs (runs A and B)
  found: median 7.8 times Linux; git-heavy tests 12-35 times; spawn-count calibration 12 and 15 spawns -> 150 ms and 118 ms per spawn on Windows including surrounding work, 4-5 ms Linux, 10-13 ms macOS.
  implication: a Windows spawn is on the order of 50-150 ms on hosted runners.
- timestamp: 2026-10-17T20:34Z
  checked: run 39065781198 (head 0f4b768), gates jobs
  found: Windows 408/507/514, Linux 213/250/251, macOS 252/297/299; corpus first build 84.0 s on Windows. Its Windows test jobs were still running, so no test-job timings from it.
  implication: a quiet Windows runner is near 0.5 s p99 even with this path; noisy ones are 1.4 s.

## Resolution

root_cause: The latency is dominated by sequential git process spawns whose cost on hosted Windows (about 35-160 ms, inferred) is roughly 10-40 times the Linux cost and 5-20 times the macOS cost: 3 per edit, 7 per new file (a full-repository snapshot is taken as the ignore oracle for every new path), plus 3 per `code_find` request (the repository is re-identified on every request, so the gate's poll loop spawns as much as the indexer does). The run-to-run swing is the hosted Windows runner's spawn cost varying, amplified by that spawn count. Not event delivery, not SQLite, not the parse pool.
fix: none applied (diagnose-only). Ranked options follow.
verification: spawn-only simulation reproduces Windows runs A and B; prototype of option 1 in a scratch copy cuts the simulated p99 by 24 to 41 percent. Nothing has been run on a Windows machine in this session.
files_changed: []

## Recommendation, ranked by effort and risk

The bound and the constants stay as they are. Order is what I would do first.

1. Replace the snapshot-as-ignore-oracle with one targeted git call (effort: small, risk: low). In `src/indexer/ignore.ts`, `keep()` calls `tree.snapshot(worktree)` for an undecided path. Add a `SourceTree` method (for example `listUnignored(worktree, paths)`) that runs a single `git --literal-pathspecs ls-files -z -c -o --exclude-standard -- <paths>` (the scratch prototype used exactly this; `GIT_LITERAL_PATHSPECS=1` in the spec environment is the alternative if `gitSpec` should not take a leading global option; use `--pathspec-from-file=- --pathspec-file-nul` for many paths) through the CommandRunner; `ls-files` is already allowed, so the allowlist and the `check-ignore` note in `ignore.ts` stay true. Listed means not ignored; absent means ignored, exactly the meaning the code has today. Gain: a new file goes from 7 sequential spawns to 4 and stops hashing the whole work tree (a cost that grows with repository size and is the real scaling problem; the corpus repository lists 3,976 files). Prototype in a scratch copy, 30 saves: simulated p99 866 -> 513 ms at a 70 ms spawn and 1178 -> 890 ms at 135 ms. Tests needed: ignored vs untracked vs tracked-but-ignored, nested repository entries ("dir/"), pathspec metacharacters in names, `.gitignore` edits still invalidating the memory, a path argument list longer than the platform limit.
2. Let `check-attr` run beside the filter enumeration (effort: small to medium, risk: low). `config` -> `hash-object` -> `check-attr` are sequential only because `sourceSet` takes the hashed map. `check-attr` needs the paths, not the hashes. Gain: one spawn stage off every save (about 50-130 ms on Windows). Needs a `SourceTree` API change; the `filter` neutralisation order (enumerate before hash) is untouched.
3. Do not re-identify the repository on every request (effort: medium, risk: low to medium). Cache `identity` and the worktree list per requested directory in the Host, invalidated by the git-directory watch the Indexer already runs (HEAD and worktrees events) and a short TTL as a backstop. Every `code_find`, `code_refs`, `code_context`, `code_impact` and `atlas_status` currently pays two spawn stages (about 0.1-0.3 s on Windows) before it touches the store; the gate's poll pays the same, 6-12 spawns per save. The prototype shows no freshness gain on an 18-core Mac (cached identity 653/1228/1275 against 578/1172/1178 for the 135 ms spawn, within noise), so this is a query-latency fix first and a possible contention fix for a 4 vCPU runner that I could not test here. Risk is staleness of the store id after a checkout that changes the root commit; the HEAD event covers it.
4. Put the Windows gates' work on the faster volume (effort: one workflow line, risk: none, payoff: unknown). Set `TEMP` and `TMP` to `${{ runner.temp }}` (`D:\a\_temp`) for the Windows gate steps and compare corpus build and size gate over a few runs. It will not change process-creation cost, so do not expect it to move freshness much. First print `os.tmpdir()` in the job to confirm it is on `C:` today.
5. Make the gate's measurement cheaper and more informative (effort: small, risk: low, no product change). Poll through a pre-resolved path (for example `composed.host` with the repository resolved once, or the store reader) and make one final `code_find` to confirm the criterion; print edit and add medians separately and the poll overshoot. This removes 6-12 spawns per save from the measured window and about 50-175 ms of overshoot. It changes what the gate measures (index freshness plus one query rather than index freshness plus poll noise), so the owner should agree it still says what the ROADMAP criterion says.
6. Per-OS nightly bound, owner to approve (effort: policy, risk: weakens the criterion). Only after options 1 and 2. By the model, with options 1 and 2 an edit is 2 spawn stages and a new file 3, so the p99 (a new file) is roughly 70 + 100 + 3 x s + 60 ms: 0.35 s at s = 35, 0.7 s at s = 160 (run B conditions), under 1000 ms in all three observed regimes. With option 1 alone the new file is 4 stages: 0.87 s at s = 160, which the 135 ms simulation confirmed at 890 ms, still under the bound but with little room. If the nightly Windows run still misses, set a measured per-OS figure from at least 10 nightly runs rather than guessing. A PR-job ceiling of 3000 ms already absorbs every observed value.
7. Larger or self-hosted Windows runner (effort: money and setup, risk: unknown). A larger runner helps CPU, but the cost here is process creation under Windows, which a bigger VM may or may not improve; a self-hosted box would show whether the 35-160 ms is the hosted VM or Windows plus Git for Windows. Measure the nightly distribution first; do this only if options 1 and 2 are not enough.
8. Remove the spawn instead of speeding it up (effort: large, risk: high; defer). A long-lived `git cat-file --batch` is the wrong tool: it reads objects, not working-tree files, so it does not help the save path (it helps `readMany` history reads). `git hash-object --stdin-paths` and `git check-attr -z --stdin` do answer line by line on a pipe on macOS with git 2.54 (I tested, no EOF needed), but Git for Windows' stdout buffering is unverified (git documents `GIT_FLUSH=1` for this), and a long-lived `hash-object` reads its config once, which is exactly what `listFilterNames` refuses to cache (the comment in `hashPaths`; T-01-50). Hashing in-process (sha1 of `blob <len>\0` + bytes, A19) is valid only when no clean filter, `text`/`eol`/`ident` attribute or `core.autocrlf`/`core.eol` conversion applies, so it needs a combined attribute and config check with a git fallback. Revisit only if options 1 and 2 do not meet the bound.
9. Small and independent: `resolveExecutable` walks every PATH directory with `fs.statSync` (twice per directory on Windows, for `.exe` and `.com`) on every spawn, synchronously. On a hosted Windows PATH that is dozens of calls on the event loop per spawn. Cache the result per PATH string. Also worth checking on a runner whether `git.exe` resolves to a `cmd\git.exe` or `bin\git.exe` wrapper that starts `mingw64\bin\git.exe` as a second process (my belief, not verified here); if so, each spawn is two process creations. Not a fix to make before measuring.

## What to measure next so the stages are separated (no product change needed)

The gate prints no stage times. These timestamps separate them, and the preload in the appendix already records the first four on any OS:

1. `t_save` (write returned) and `t_event` (first `@parcel/watcher` callback for the path): event delivery. Bounds the ReadDirectoryChangesW question.
2. `t_spawn_start` / `t_spawn_close` of every git, labelled by subcommand: the per-spawn cost, and how many are indexer spawns and how many are poll spawns.
3. `t_commit` (first `BEGIN IMMEDIATE` of the save, or the `indexed` notice's `lagMs`, which the Indexer already computes as now minus the first queue event): the pipeline time without poll overshoot. `found - t_commit` is the poll overshoot.
4. SQLite statement durations over 0.3 ms: bounds the commit cost.
5. In the gate itself: print medians per kind (`kinds` is already returned), and run with `--saves 100` so p99 is the 99th of 100 rather than the maximum.

Run it on a hosted Windows job once (a `workflow_dispatch` step is enough) and the per-spawn cost, the event delay and the commit cost come out as numbers instead of inference.

## Caveats

- The Windows per-spawn cost is inferred from CI timings and a model checked on macOS; nothing here ran on Windows. The inference is consistent across three independent routes (test calibration, the clean single-edit test, the gate shape), but it is an inference.
- The shim adds a fixed sleep on top of a real spawn. Real Windows spawn cost also burns CPU, so contention on the 4 vCPU runner (indexer and poll spawning at once) is not reproduced; the Mac has 18 cores. This is the one place the model can under-state Windows.
- The prototype of options 1 and 3 lives in a scratch copy outside the repository; the repository was not modified except for this file.
- Run C's test jobs had not finished, so its test timings are absent.

## Appendix: reproducing the trace and the simulation

Spawn-cost simulation (macOS/Linux): a directory with an executable `git` that is `#!/bin/sh`, `sleep 0.11`, `exec /usr/bin/git "$@"` (use 0.05 for about 70 ms), put first on PATH, then run the real gate function with a driver that prints `samples` and `kinds`. The CommandRunner resolves `git` from PATH, so no product code is involved. Windows refuses `.cmd`/`.bat` shims by design, so on Windows use the preload below without a shim.

Trace preload (works on any OS; run `TRACE_FILE=out.log node --import ./preload.mjs <driver>`; each line is `<epoch ms> T<thread> <KIND> <detail>`):

```js
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { threadId } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const out = process.env.TRACE_FILE;
if (out) {
  const log = (kind, detail) => fs.appendFileSync(out, `${(performance.timeOrigin + performance.now()).toFixed(2)} T${threadId} ${kind} ${detail}\n`);
  const require = createRequire(process.cwd() + '/package.json'); // run from the repository root

  const origSpawn = childProcess.spawn;
  let seq = 0;
  childProcess.spawn = function (file, args, options) {
    const id = (seq += 1);
    const keep = [];
    const a = [...(args ?? [])];
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === '-C' || a[i] === '-c') { i += 1; continue; }
      if (a[i].startsWith('--git-dir') || a[i].startsWith('--work-tree') || a[i] === '--no-optional-locks') continue;
      keep.push(a[i]);
    }
    const label = `${file.split(/[\\/]/).pop()} ${keep.slice(0, 5).join(' ')}`;
    const began = performance.now();
    log('SPAWN', `#${id} ${label}`);
    const child = origSpawn.call(this, file, args, options);
    child.on('spawn', () => log('SPAWNED', `#${id} +${(performance.now() - began).toFixed(1)}ms`));
    child.on('close', (code) => log('CLOSE', `#${id} exit=${code} total=${(performance.now() - began).toFixed(1)}ms ${label}`));
    return child;
  };
  syncBuiltinESMExports();

  const origWrite = fs.writeFileSync; // the save; the gate writes under src/gen
  fs.writeFileSync = function (file, data, opts) {
    const result = origWrite.call(this, file, data, opts);
    if (typeof file === 'string' && /[\\/]src[\\/]gen[\\/]/.test(file)) log('WRITE', file.split(/[\\/]/).pop());
    return result;
  };
  syncBuiltinESMExports();

  const watcher = require('@parcel/watcher'); // the watcher callback as JavaScript sees it
  const origSubscribe = watcher.subscribe;
  watcher.subscribe = function (dir, fn, options) {
    return origSubscribe.call(this, dir, (error, events) => {
      log('EVENT', error ? 'ERR' : events.map((e) => `${e.type}:${e.path.split(/[\\/]/).pop()}`).join(','));
      return fn(error, events);
    }, options);
  };

  const sqlite = require('node:sqlite'); // statements over 0.3 ms, and every BEGIN/COMMIT
  const wrap = (proto, name, sqlOf) => {
    const orig = proto[name];
    proto[name] = function (...args) {
      const began = performance.now();
      try { return orig.apply(this, args); } finally {
        const dt = performance.now() - began;
        const sql = sqlOf(this, args);
        if (dt >= 0.3 || /^(COMMIT|BEGIN)/i.test(sql)) log('SQL', `${name} ${dt.toFixed(2)}ms ${sql.slice(0, 50).replace(/\s+/g, ' ')}`);
      }
    };
  };
  wrap(sqlite.DatabaseSync.prototype, 'exec', (_t, a) => String(a[0]));
  wrap(sqlite.StatementSync.prototype, 'run', (t) => String(t.sourceSQL));
}
```

Driver: `import { runFreshnessGate } from './scripts/freshness-gate.ts'; const r = await runFreshnessGate({ saves: 30, maxMs: 100000 }); console.log(r.samples.map((ms, i) => `${i} ${r.kinds[i]} ${ms.toFixed(0)}`).join('\n'));`
