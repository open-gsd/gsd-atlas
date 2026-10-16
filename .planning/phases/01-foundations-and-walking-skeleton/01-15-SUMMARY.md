---
phase: 01-foundations-and-walking-skeleton
plan: 15
subsystem: ci
tags: [ci, github-actions, cross-os, wasm-reproducibility, grammar-lock]
requires: [01-03, 01-07, 01-09, 01-10, 01-11, 01-12]
provides:
  - first real three-OS CI evidence for the Phase 1 foundation
  - grammar.lock lockVersion 2 with per-platform rebuild hashes (wasm.platforms)
  - a fully green three-OS CI run (all jobs) on ci/phase-1
affects: [01-16, grammar.lock format, scripts/grammar-verify.ts, scripts/grammar-build.ts]
key-files:
  created: []
  modified:
    - src/lang/grammar-lock.ts
    - src/lang/grammar-lock.test.ts
    - src/lang/index.ts
    - scripts/grammar-build.ts
    - scripts/grammar-verify.ts
    - scripts/grammar.test.ts
    - test/fixtures/modules/toy/grammar.lock
    - .github/workflows/grammar-hash-parity.yml
decisions:
  - "Task 1: user selected push-ci-branch. BASE = cc2f19ab00c2bce845ecc08bfb34eece514dcce2 pushed to refs/heads/ci/phase-1 on open-gsd/gsd-atlas (PRIVATE). The first push was done by the orchestrator with a one-shot credential helper override; earlier attempts failed because git used a stale keychain PAT without the workflow scope."
  - "Task 3 step 3: user decided per-platform-hash. grammar.lock stores one rebuild sha256 per platform key (closed set, `${process.platform}-${process.arch}`); each OS verifies its own rebuild against its own entry; a platform with no entry fails (never passes silently)."
  - "wasm.sha256 keeps its meaning (hash of the committed, shipped wasm), so the engine and module reader still verify the wasm they load against the right hash with no reader change. wasm.platforms[key] is the hash of a rebuild from source on that platform."
  - "lockVersion bumped 1 -> 2 (not kept backward compatible): a v1 lock has no per-platform hashes, so accepting it would mean verifying every OS against one hash, the behaviour A1 refuted. The only lock in the repo (the toy lock) was migrated; the parser rejects lockVersion 1 with a message pointing at --update-lock."
  - "Invariant enforced by the parser: at least one platforms entry equals wasm.sha256, so the committed artifact is always reproducible from source on some platform."
  - "--update-lock (replaces the committed wasm) is allowed only on the artifact platforms linux-x64 and darwin-arm64, whose builds are byte-identical in CI evidence. Other platforms use --update-platform, which records only that platform's rebuild hash and never touches the committed wasm or wasm.sha256."
  - "Check mode of grammar-build no longer writes the wasm into the module (on win32 the rebuild differs from the committed file by design)."
metrics:
  commits: 2
  plan_head_before: 94c27ccab0d1472eafc65f9f39edd5f6acecac48
  plan_head_after: d0b5d531c754a52e74cb9d0165e182ea9cadca18
  duration: continuation (decision implementation and two CI runs)
actuals:
  tasks: 3
  commits: 2
status: complete
---

# Phase 1 Plan 15: First three-OS CI run Summary

The first CI run on macOS, Linux and Windows found that the toy grammar WASM rebuilt on Windows has a different sha256 (and 5 fewer bytes) than on Linux and macOS. The user chose `per-platform-hash`; it is implemented and the second CI run on `ci/phase-1` is green on every job, with each OS hash equal to its own lock entry.

## What changed (per-platform-hash)

- `src/lang/grammar-lock.ts`: schema `lockVersion: 2`. `wasm.sha256` = hash of the committed wasm (the shipped artifact). New required `wasm.platforms`: a partial record over the closed key set `linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64, win32-arm64` (unknown keys are rejected) mapping to the rebuild hash on that platform; at least one entry must equal `wasm.sha256`. New helpers `platformKey()` (maps `process.platform`/`process.arch` into the closed set or `undefined`) and `expectedPlatformSha256()` (strict: unsupported platform or missing entry returns a failure message naming the platform key and the `--update-platform` hint). `ARTIFACT_PLATFORM_KEYS = linux-x64, darwin-arm64`.
- `scripts/grammar-verify.ts`: `compareHashes` now requires (a) both local rebuilds equal each other and equal this platform's `wasm.platforms[key]`, and (b) the committed wasm equals `wasm.sha256`. The two checks are independent, so on Windows the rebuild is compared with the win32-x64 entry while the committed Linux/macOS wasm stays pinned to its own hash. A platform with no entry fails before the toolchain download.
- `scripts/grammar-build.ts`: check mode compares with this platform's entry; `--report` JSON now carries `platformKey`, `lockSha256`, `matchesLock`, `committedSha256`; `--update-platform` records one platform only; `--update-lock` is refused off the artifact platforms; `serializeLock` writes platforms in `PLATFORM_KEYS` order; check mode no longer writes the wasm.
- `test/fixtures/modules/toy/grammar.lock`: lockVersion 2 with the CI-measured values (linux-x64 and darwin-arm64 = `ffe6c2ed...a0f9a`, win32-x64 = `cba9dce1...8853`).
- `.github/workflows/grammar-hash-parity.yml`: each OS now rebuilds with `--report`, then a step fails if the rebuild does not equal that OS's own lock entry (or the entry is missing).
- Readers: `src/lang/module-files.ts` (feeds `expectedSha256` to the engine), `src/grammar-engine/*` and the engine tests read only `wasm.sha256`, which still hashes the committed wasm they load, so no reader change was needed and no integrity check was weakened. The engine still hashes the loaded bytes before `Language.load`.

Tests added: parser accept/reject cases for the platforms map (empty, missing, bad hex, unknown key, no entry equal to the committed hash, lockVersion 1 and 3); `platformKey` and `expectedPlatformSha256`; `checkAgainstLock`, `compareHashes` (linux pass, windows pass with differing committed wasm, committed pin still enforced on windows, windows must not match the linux hash, missing entry fails), `updatedLock`, `updateLockRefusal`, `serializeLock` canonical round trip, and a test that the committed toy lock holds the CI-measured values and is in canonical form. Local run: 757 tests pass, 0 fail.

## CI Evidence

### First run (BASE cc2f19ab, before the fix)

- CI: https://github.com/open-gsd/gsd-atlas/actions/runs/38839445999 (failure: only `Grammar rebuild (windows-latest)`).
- grammar-hash-parity: https://github.com/open-gsd/gsd-atlas/actions/runs/38839445912 (success, print-only).

| OS | arch | bytes | sha256 | equals old single lock hash |
|----|------|-------|--------|-----------------------------|
| linux | x64 | 16237 | ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a | yes |
| darwin | arm64 | 16237 | ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a | yes |
| win32 | x64 | 16232 | cba9dce1c2048b2fc06d408d0c7d0f57c5ee026652a385e8c9080046bdb58853 | NO |

A1 (cross-OS byte identity) held for linux/darwin and was refuted for win32. The Windows build is internally deterministic (two builds identical) and the committed wasm on a Windows checkout was unchanged (not line-ending corruption). The cause is in the Windows toolchain output (wasi-sdk/clang or binaryen `wasm-opt`, both downloaded by tree-sitter CLI 0.27.1); it was not diagnosed to a byte level because the user chose per-platform hashes over the `investigate` option.

### Second run (HEAD d0b5d53, after the fix): all green

Pushed `cc2f19a..d0b5d53` to `refs/heads/ci/phase-1` (non-force, descendant of BASE, repo visibility PRIVATE confirmed first). No further iterations were needed.

- CI: https://github.com/open-gsd/gsd-atlas/actions/runs/38840520547 (success)
- grammar-hash-parity: https://github.com/open-gsd/gsd-atlas/actions/runs/38840520568 (success)

| Job | OS | Node | Conclusion | Notes |
|-----|----|------|------------|-------|
| Static checks | ubuntu | n/a | success | lint, typecheck, schema:check |
| Test | ubuntu-latest | 24.16.0 | success | 757 pass, 0 skipped |
| Test | ubuntu-latest | 26 | success | 757 pass, 0 skipped |
| Test | macos-latest | 24.16.0 | success | 757 pass, 0 skipped |
| Test | macos-latest | 26 | success | 757 pass, 0 skipped |
| Test | windows-latest | 24.16.0 | success | 752 pass, 5 skipped (see below) |
| Test | windows-latest | 26 | success | 752 pass, 5 skipped |
| Grammar rebuild | ubuntu-latest | 24.16.0 | success | `verified linux-x64 rebuild sha256 ffe6c2ed...a0f9a; committed grammar.wasm sha256 ffe6c2ed...a0f9a` |
| Grammar rebuild | macos-latest | 24.16.0 | success | `verified darwin-arm64 rebuild sha256 ffe6c2ed...a0f9a; committed ... ffe6c2ed...a0f9a` |
| Grammar rebuild | windows-latest | 24.16.0 | success | `verified win32-x64 rebuild sha256 cba9dce1...8853; committed grammar.wasm sha256 ffe6c2ed...a0f9a` |
| parity | ubuntu-latest | 24.16.0 | success | linux-x64, 16237 bytes, matchesLock true |
| parity | macos-latest | 24.16.0 | success | darwin-arm64, 16237 bytes, matchesLock true |
| parity | windows-latest | 24.16.0 | success | win32-x64, 16232 bytes, matchesLock true |

Per-OS hashes from the parity job (each equals its own lock entry): linux-x64 and darwin-arm64 `ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a`; win32-x64 `cba9dce1c2048b2fc06d408d0c7d0f57c5ee026652a385e8c9080046bdb58853`.

Floor decision: the driver contract suites ran on Node 24.16.0 and Node 26 on all three OSes, passing.

### Skips (Windows only, both Node versions)

Five expected platform skips: `uses the executable bit (real files)` (no POSIX exec bit), two module-reader symlink-escape tests and the git-seam `symlink_skipped` test (creating symlinks needs elevated rights), and `unhashable_path` newline test (Windows cannot create such file names). Windows skip count went from 1 to 5 because plans 01-13 and 01-14 tests are now part of the run; those were not on the first run's BASE. No skips on Linux or macOS. Symlink-escape behaviour on Windows is therefore covered only by the Linux/macOS legs (carry to 01-16 if Windows symlink coverage is wanted).

### Windows tar.exe behaviour (A2)

Confirmed again: tree-sitter CLI extracted wasi-sdk and binaryen on windows-latest without error. No symptom for the other listed risks (autocrlf A3, `.cmd` shims, test glob quoting A5, null-device hooksPath).

## Deviations from Plan

None requiring a Rule 1-4 call. The format change (lockVersion 2) was the explicit consequence of the user's decision. Execution notes:

- The user decision asked for backward compatibility only if cheap. It was not: a v1 lock cannot express per-platform hashes, so v1 is rejected with a clear message and the toy lock was migrated (only lock in the repo).
- The worktree had no CodeGraph index; `codegraph init -y` was run (per the user's global worktree instruction) because the Memtrace-first guard routes source reads through CodeGraph. `.codegraph/` was not committed.

## Open follow-ups (not blockers)

- After any future grammar source change, `--update-lock` on linux-x64 or darwin-arm64 refreshes the committed wasm and that platform's entry only. The other platforms' entries go stale and fail loudly in CI with the computed hash; refresh each with `--update-platform` (or paste the `--report` value). This is deliberate, so a stale hash can never pass.
- The Windows byte difference remains undiagnosed (toolchain-side). If a future module's grammar is large enough that behavioural equivalence matters, upload the Windows-built wasm as an artifact and diff.
- `grammar-hash-parity.yml` is still throwaway; plan 01-16 deletes it. The `grammar-verify` job in CI carries the same per-platform check permanently.

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- Commits `991caaa` (feat) and `d0b5d53` (ci) exist and are ancestors of HEAD; `ci/phase-1` points at `d0b5d53` and is a descendant of BASE `cc2f19ab`.
- Run URLs and conclusions queried live with `gh run view` (read-only); the second CI run and parity run concluded `success` for every job.
- Local gates before push: `npm test` (757/757), `npm run lint`, `npm run typecheck`, `npm run build`, `npm run schema:check`, `npm run grammar:budget` (ratio 0.000000), `npm run grammar:verify` (darwin-arm64 verified) all passed. `--update-platform` and the missing-entry failure were also exercised by hand on a scratch copy of the toy module (wasm unchanged, lock restored byte-identical).
