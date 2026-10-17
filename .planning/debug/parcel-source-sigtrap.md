---
status: resolved
trigger: "node --test src/indexer/parcel-source.test.ts intermittently dies with signal SIGTRAP on macOS arm64 (about 1 in 16-20 parallel runs, 1 in ~4 full npm test runs); regression came with plan 02-26"
created: 2026-10-17T14:20:00Z
updated: 2026-10-17T16:30:00Z
goal: find_and_fix
---

## Current Focus

hypothesis: CONFIRMED (see Resolution). A watched directory that is deleted at about the time it is unsubscribed corrupts the heap inside @parcel/watcher's FSEvents backend; plan 02-26 added a second watched directory (`.git/worktrees`) that the test teardown deletes and that is almost always reported as removed.
next_action: none (fix committed; verification below)

## Symptoms

expected: `node --test src/indexer/parcel-source.test.ts` passes every time
actual: the whole file is reported failed: `exitCode: ~`, `signal: 'SIGTRAP'`, `error: 'test failed'`. The output stops after test 1 or 2 of the real-watcher suite (the corruption is detected by a later malloc, so the victim varies)
errors: signal SIGTRAP (also SIGSEGV and SIGBUS seen in the native reproduction)
reproduction: `for i in $(seq 1 40); do (node --test --test-reporter=tap src/indexer/parcel-source.test.ts > /tmp/x_$i.log 2>&1) & done; wait; grep -l SIGTRAP /tmp/x_*.log`
started: plan 02-26 (commit 73119b6, the nested subscription on `worktrees/`), amplified by the teardown order of the git test

## Eliminated

- hypothesis: renewing the nested `worktrees/` subscription (unsubscribe while events flow, then subscribe again) corrupts memory
  evidence: native test "unsubscribe while events are flowing, directory kept": 8 processes x 100 rounds, 0 deaths. HEAD product with only the teardown order of the git test changed (stop before delete): 0 SIGTRAP in 160 runs although the renewals are unchanged
- hypothesis: stop() racing a pending renewal
  evidence: stop awaits `renewing` first (unchanged); the scripted test "stop while a renewal is waiting" passes; the crashes need a deleted directory
- hypothesis: a subscription unsubscribed twice by our code
  evidence: each subscription object is unsubscribed once (stop, or the renewal that replaces it); the double release is inside the native layer
- hypothesis (my first fix, discarded): make `unsubscribe` wait for the watcher's report of the removal of the watched directory
  evidence: works against the native reproduction (0 deaths in 4,800 rounds against 5 to 11 in 16 processes) but it HANGS the real test. When the directory's ancestors are deleted too (rm -rf of the repository), FSEvents does not report the removal of the watched directory at all (`.git` itself: 0 reports in 336 rounds; `.git/worktrees`: reported in 40 to 80 percent of rounds; a root whose parent stays: reported every time). "Pending" and "never coming" cannot be told apart, so any wait needs a timeout, which was not allowed, and an unbounded wait hangs stop(). Reverted

## Evidence

- timestamp: 2026-10-17T14:30Z
  checked: crash reports in ~/Library/Logs/DiagnosticReports/node-*.ips (macOS 27, Node 26.11.1)
  found: EXC_BREAKPOINT in `_xzm_xzone_malloc_freelist_outlined` (the allocator found a corrupted free list) in unrelated code: FSEventStreamCreate on a libuv worker, sqlite3 prepare, node::PipeWrap, V8 serializer, V8 baseline compiler
  implication: heap corruption detected later, not at the corrupting write; the culprit is a native memory error, not a JS exception
- timestamp: 2026-10-17T14:35Z
  checked: the real-watcher suite under `MallocScribble=1 MallocPreScribble=1` (freed memory filled with 0x55, so a use after free dies at the use), 3 rounds x 40 processes
  found: 24 of 120 SIGTRAP as before, plus a crash at the culprit: EXC_BAD_ACCESS in `FSEventsBackend::unsubscribe` -> `FSEventStreamStop` -> `CFMachPortInvalidate` -> `__CF_IS_OBJC`, on a libuv worker (a stream that was already released is stopped again)
  implication: a double release of an FSEventStream, by `unsubscribe` and something else
- timestamp: 2026-10-17T14:40Z
  checked: source of the installed @parcel/watcher 2.6.0 (`src/macos/FSEventsBackend.cc`, `Backend.cc`, `binding.cc`, `Watcher.cc`)
  found: `FSEventsCallback` (the run loop thread) sets `deletedRoot` when an event says `paths[i] == watcher->mDir` was removed, and at the END of the callback does `stopStream(streamRef)` (stop, unschedule, invalidate, release) and `watcher->state = nullptr`. `FSEventsBackend::unsubscribe` (a libuv worker, called from `UnsubscribeRunner::execute`) reads `watcher->state` and, if it is set, does `stopStream(s->stream)` as well. There is no lock between the two and `state` is a plain `shared_ptr`. `notify()` (which sends the removal event to JavaScript) runs BEFORE the teardown in the same callback
  implication: if `unsubscribe` reads `state` before the callback clears it, the stream is released twice. Upstream 2.6.0 is the latest release (npm dist-tag), so there is no upstream fix to take
- timestamp: 2026-10-17T14:45Z
  checked: native reproduction with @parcel/watcher alone (no code of this repository), `scratchpad/rootdel.mjs`: subscribe, write files, then one of four endings, 8 processes x 100 rounds (and 16 x 150 under MallocScribble)
  found: delete the watched directory then unsubscribe at once: 3 of 8 processes died (SIGTRAP 133, SIGBUS 138, SIGSEGV 139), repeated: 3 of 8, with MallocScribble 11 of 16. Unsubscribe then delete: 0 of 8. Unsubscribe while events flow, directory kept: 0 of 8. Delete, wait for the report of the removal, then unsubscribe: 0 of 24 and 0 of 16 (the report always arrived)
  implication: the trigger is "watched directory deleted and unsubscribed at about the same time", nothing to do with the product code
- timestamp: 2026-10-17T14:50Z
  checked: test-kit `createTempGitRepo().cleanup()` and the registration order of `t.after` in the git test
  found: `cleanup` deletes the whole temp directory (repository, `.git`, `.git/worktrees`) and the test registered it BEFORE `stop()`, so the watch was stopped AFTER everything it watches was deleted
  implication: this is the delete-then-unsubscribe shape
- timestamp: 2026-10-17T15:05Z
  checked: which watched directories get a removal report when the repository is deleted (native replay of the git test flow, `scratchpad/dirflow2.mjs`, unsubscribing after 1.5 s)
  found: `.git` (root of the main git subscription): reported in 0 of 336 rounds; `.git/worktrees` (root of the subscription 02-26 added): reported in 40 to 80 percent of rounds; with only `.git` deleted and its parent kept: reported 10 of 10. Delete-then-unsubscribe under a 40 process load: main subscription only 2 of 40 processes died in 15 rounds, main + nested 10 of 40
  implication: the removal report is what makes the native callback tear the stream down by itself. Before 02-26 the only watched directory was almost never reported, so the crash was rare (cdce5ed: 3 of 120 at 40 parallel). 02-26 added a watched directory that git deletes and that is mostly reported, which multiplied the rate by about six (HEAD: 25 of 160)
- timestamp: 2026-10-17T15:20Z
  checked: rates at 40 processes in parallel, 4 x 40 runs unless noted
  found: HEAD 25 of 160 SIGTRAP (6, 8, 3, 8); at 20 parallel 0 of 140 (the lead's rate could not be reached on this machine); cdce5ed source and test 3 of 120 (one round of 40 was killed from outside and is not counted); HEAD with only the git test's teardown order changed 0 of 160; HEAD product with the nested subscription switched off on macOS 0 of 200; final code 0 of 240; final product with the old teardown order 0 of 240
  implication: both the extra directory and the delete-before-stop order take part; either removes the failure at this scale, both together are the fix
- timestamp: 2026-10-17T15:40Z
  checked: whether macOS needs the nested subscription (the reason 02-26 added it was Linux inotify, which watches a new directory without scanning what is in it)
  found: with it off, "delivers head for a checkout in the main and in a linked worktree, worktrees for git worktree add" passed in every run (199 of 200 logs show it; the 200th stopped after test 1 with no error and no signal line, cause unknown, not seen again in 480 later runs). FSEvents is recursive in the operating system
  implication: the extra subscription is redundant on macOS, so dropping it there loses nothing

## Resolution

root_cause: |
  Native defect in @parcel/watcher 2.6.0 (macOS FSEvents backend), triggered by this repository's teardown. When a watched directory is deleted, `FSEventsCallback` (run loop thread) releases the stream by itself at the end of the callback and clears `watcher->state`; `FSEventsBackend::unsubscribe` (libuv worker) releases the stream too if it still sees `state`. With no synchronisation the two overlap, the FSEventStream is released twice and the heap is corrupted; the process dies later in unrelated code (SIGTRAP from the macOS allocator, SIGSEGV, SIGBUS). Plan 02-26 raised the rate about six times by (1) opening a second subscription on `.git/worktrees`, a directory git deletes and that FSEvents reports as removed in 40 to 80 percent of the repository deletions, and unsubscribing it first in `stop()`, and (2) `parcel-source.test.ts` deleting the repository (`t.after(repo.cleanup)`, registered first, so it runs first) before `t.after(stop)`.
fix: |
  src/indexer/parcel-source.ts: `subscribeGit` no longer opens or renews the `worktrees/` subscription on macOS (`renewsWorktrees`, new option `platform` for tests; Linux, Windows and the others keep it, so the linked worktree HEAD fix of 02-26 is intact). FSEvents is recursive in the operating system, so the git directory subscription alone sees a linked worktree's HEAD, and no directory that git deletes on its own is watched. A comment in the file and in the options says that a watched directory must be unsubscribed before it is deleted.
  src/indexer/parcel-source.test.ts: the git test stops the watch before the repository is deleted (one `t.after` that does both, in that order); `withGitWatch` is hoisted and takes a platform (Linux by default, so the existing renewal cases do not depend on the host); two new scripted cases state the platform decision (macOS: a worktrees event opens nothing and a linked worktree HEAD still arrives; Linux, Windows, FreeBSD: the nested subscription is renewed).
verification: |
  Final code, `node --test --test-reporter=tap src/indexer/parcel-source.test.ts` x 40 in parallel, 6 rounds: 0 of 240 SIGTRAP, 0 other signals, 0 non-zero exits, 0 truncated logs (HEAD: 25 of 160). At 20 in parallel (the reported setting), 4 rounds: 0 of 80. Attribution: product change alone with the old teardown order 0 of 240; teardown order alone on the HEAD product 0 of 160. `npm run typecheck` and `npm run lint` clean; all 93 indexer tests pass; `npm test` 12 of 12 runs green (2,394 tests each, no signal).
files_changed:
  - src/indexer/parcel-source.ts
  - src/indexer/parcel-source.test.ts

## Residual risk (honest)

The native defect is still in @parcel/watcher. Anything that deletes a watched directory and unsubscribes it at about the same time can still hit it on macOS: the main git directory subscription and the worktree root subscriptions are unchanged. Measured with @parcel/watcher alone, under a 40 process load: 2 of 40 processes died in 15 rounds for one watched directory (about 0.3 percent per delete-then-unsubscribe); idle it is about 0.4 percent per round for a directory whose parent stays. In the product the shape only occurs when a repository is deleted while a host runs and is stopped within milliseconds (the Indexer drops a removed worktree's subscription only after `git worktree list`, which takes much longer than the callback). No hang-free, timeout-free guard exists: the callback gives no "done" signal and FSEvents does not report the removal when the directory's ancestors are deleted too.

Recommended follow-ups (not done here, a decision for the owner): report it upstream with `scratchpad/rootdel.mjs` as the reproduction (fix: take one lock in both `FSEventsCallback` and `FSEventsBackend::unsubscribe`, or null `state` before releasing the stream and test it in both); until it is fixed, keep tests that delete a repository stopping the watch first (the other real-watcher tests already do).

## Reproduction kit (kept in the session scratchpad, not in the repository)

- `par.sh N outdir [file]`: N parallel `node --test --test-reporter=tap` runs, counts SIGTRAP, other signals, non-zero exits, truncated logs
- `rootdel.mjs ITER MODE`: @parcel/watcher alone: `rm-then-unsub`, `unsub-then-rm`, `unsub-busy`, `rm-wait-unsub`
- `dirflow2.mjs ITER MODE`: the git directory flow at the native level: `main-only`, `nested`, `nested-gitonly`, `nested-wait`
- `ips.py`: summarises the faulting stacks of the `node-*.ips` crash reports
