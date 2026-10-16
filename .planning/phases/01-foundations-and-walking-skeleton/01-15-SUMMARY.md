---
phase: 01-foundations-and-walking-skeleton
plan: 15
subsystem: ci
tags: [ci, github-actions, cross-os, wasm-reproducibility]
requires: [01-03, 01-07, 01-09, 01-10, 01-11, 01-12]
provides:
  - first real three-OS CI evidence for the Phase 1 foundation
  - evidence that grammar WASM is NOT byte-identical on Windows (A1 refuted for win32)
affects: [01-16, grammar.lock format, scripts/grammar-verify.ts, scripts/grammar-build.ts]
key-files:
  created: []
  modified: []
decisions:
  - "Task 1: user selected push-ci-branch. BASE = cc2f19ab00c2bce845ecc08bfb34eece514dcce2 pushed to refs/heads/ci/phase-1 on open-gsd/gsd-atlas (PRIVATE). The push was done by the orchestrator (not this agent) with a one-shot credential helper override: git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin <BASE>:refs/heads/ci/phase-1. Earlier attempts failed because git used a stale keychain PAT without the workflow scope. No force, no PR, main untouched."
  - "Task 3 step 3 (hash divergence) is OPEN: a checkpoint:decision is returned to the user (per-platform-hash, canonical-linux, investigate). This agent did not choose."
metrics:
  commits: 0
  plan_head_before: cc2f19ab00c2bce845ecc08bfb34eece514dcce2
  plan_head_after: cc2f19ab00c2bce845ecc08bfb34eece514dcce2
actuals:
  tasks: 2
  commits: 0
status: partial
---

# Phase 1 Plan 15: First three-OS CI run Summary

The first real CI run on macOS, Linux and Windows is green everywhere except one job: the Windows grammar rebuild, because the toy grammar WASM built on Windows has a different sha256 (and 5 fewer bytes) than the one built on Linux and macOS. The plan is paused at a decision (Task 3 step 3).

## Decisions

- Task 1 selection: `push-ci-branch`. BASE sha: `cc2f19ab00c2bce845ecc08bfb34eece514dcce2`. Remote ref `refs/heads/ci/phase-1` verified with `git ls-remote origin refs/heads/ci/phase-1` (points at BASE). Repo visibility verified PRIVATE (`gh repo view`).
- The push was performed by the orchestrator, not by this agent, via the one-shot override `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin <BASE>:refs/heads/ci/phase-1` (earlier attempts failed on a stale keychain PAT lacking `workflow` scope). Non-force; this agent pushed nothing, opened no PR, changed no remotes or credentials.

## CI Evidence

Runs for BASE on `ci/phase-1`:

- CI: https://github.com/open-gsd/gsd-atlas/actions/runs/38839445999 (conclusion: failure, one job)
- grammar-hash-parity: https://github.com/open-gsd/gsd-atlas/actions/runs/38839445912 (conclusion: success; it only prints hashes, it does not compare)

| Job | OS | Node | Conclusion | Notes |
|-----|----|------|------------|-------|
| Static checks | ubuntu | n/a | success | lint, typecheck, schema:check |
| Test | ubuntu-latest | 24.16.0 | success | 640 tests, 640 pass, 0 skipped |
| Test | ubuntu-latest | 26 | success | 640/640, 0 skipped |
| Test | macos-latest | 24.16.0 | success | 640/640, 0 skipped |
| Test | macos-latest | 26 | success | 640/640, 0 skipped |
| Test | windows-latest | 24.16.0 | success | 639 pass, 1 skipped |
| Test | windows-latest | 26 | success | 639 pass, 1 skipped |
| Grammar rebuild | ubuntu-latest | 24.16.0 | success | rebuild equals committed hash |
| Grammar rebuild | macos-latest | 24.16.0 | success | rebuild equals committed hash |
| Grammar rebuild | windows-latest | 24.16.0 | FAILURE | `grammar verify failed for atlas_toy on win32/x64`, see below |
| parity | ubuntu-latest | 24.16.0 | success | sha matches lock |
| parity | macos-latest | 24.16.0 | success | sha matches lock |
| parity | windows-latest | 24.16.0 | success (printing only) | sha differs from lock |

Job URLs (CI run): Static https://github.com/open-gsd/gsd-atlas/actions/runs/38839445999/job/116775908205; Grammar rebuild (windows) https://github.com/open-gsd/gsd-atlas/actions/runs/38839445999/job/116775908527.

Floor-decision proof: the driver contract suite (`driver contract: better-sqlite3` and `driver contract: node:sqlite`) passed on Node 24.16.0 and Node 26 on all three OSes.

### Notable skips

- Windows (both Node versions): one skip, `uses the executable bit (real files)` — expected, Windows has no POSIX executable bit. No other skips on any OS.

### WASM sha256 per OS vs grammar.lock (assumption A1)

grammar.lock expected: `ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a`

| OS | arch | CLI | ABI | bytes | sha256 | equals lock |
|----|------|-----|-----|-------|--------|-------------|
| linux | x64 | 0.27.1 | 15 | 16237 | ffe6c2ed...a0f9a | yes |
| darwin | arm64 | 0.27.1 | 15 | 16237 | ffe6c2ed...a0f9a | yes |
| win32 | x64 | 0.27.1 | 15 | 16232 | cba9dce1c2048b2fc06d408d0c7d0f57c5ee026652a385e8c9080046bdb58853 | NO |

Windows failure log excerpt (grammar:verify):

```
grammar verify failed for atlas_toy on win32/x64
  expected (grammar.lock): ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a
  first build:             cba9dce1c2048b2fc06d408d0c7d0f57c5ee026652a385e8c9080046bdb58853
  second build:            cba9dce1c2048b2fc06d408d0c7d0f57c5ee026652a385e8c9080046bdb58853
  committed grammar.wasm:  ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a
```

Findings:

- A1 (cross-OS byte identity) is CONFIRMED between linux/x64 and darwin/arm64 and REFUTED for win32/x64.
- The Windows build is internally deterministic (two builds identical), and the committed `grammar.wasm` itself is unchanged on the Windows checkout (its sha equals the lock), so this is not checkout/line-ending corruption. `.gitattributes` marks `test/fixtures/**` as `-text` and `*.wasm` binary, so the grammar input (`grammar.js`) is not CRLF-converted. The difference is therefore in the Windows toolchain output (wasi-sdk/clang Windows build, or binaryen `wasm-opt` Windows build, both downloaded by tree-sitter CLI 0.27.1: wasi-sdk-34 and binaryen version_132 `x86_64-windows`). Not yet diagnosed to a byte level; the 5-byte size delta suggests a small codegen/section difference, not embedded paths (the macOS wasm contains no path strings other than the clang producer string).
- The full Windows `test` jobs pass, including loading the committed wasm and the grammar budget check, so a Windows-built wasm differing in bytes is not known to be functionally wrong; that was not verified here (no artifact of the Windows-built wasm was uploaded).

### Windows tar.exe behaviour (A2)

The tree-sitter CLI extracted wasi-sdk (about 590 MB tarball, about 23 s) and binaryen to `C:\Users\runneradmin\AppData\Local\tree-sitter\` on windows-latest without error, so A2 (tar extraction under Windows works) is confirmed in practice. The cache action used `C:\Program Files\Git\usr\bin\tar.exe` (GNU tar) with zstd.

Other risks listed in Task 3 (autocrlf A3, `.cmd` shims, test glob quoting A5, checkout flakiness, null-device hooksPath): no symptom surfaced; all Windows test jobs passed.

## Deviations from Plan

None in execution. Task 1 was resolved by the user and the push done by the orchestrator. Task 3 was stopped at step 3 as the plan requires. No code fixes were made.

## Task Status

| Task | Status |
|------|--------|
| 1 (decision) | Resolved: push-ci-branch |
| 2 (tracer) | Done: both workflows ran, per-job conclusions and hashes recorded |
| 3 (fix / escalate) | Paused at divergence decision (see below); latest CI run for ci/phase-1 is `failure` (Windows grammar rebuild only) |

## Open Decision (checkpoint:decision, blocking-human)

Windows toy WASM differs from the Linux/macOS hash. Options:

- `per-platform-hash`: grammar.lock stores one expected sha256 per platform key (linux-x64, darwin-arm64, win32-x64); each OS verifies its own. Strict, but requires adding a hash per platform and CI to prove new platforms.
- `canonical-linux`: grammar.lock stores the Linux hash; other OSes verify by loading the wasm and running golden fixtures rather than comparing bytes. Weaker byte-level guarantee on Windows.
- `investigate`: stop and debug the toolchain first (diff the Windows wasm against the Linux one, e.g. by uploading the built artifact from the parity workflow; check wasm-opt/clang output differences).

Implementation after the choice: `src/lang/grammar-lock.ts`, `scripts/grammar-build.ts`, `scripts/grammar-verify.ts` with tests, push a descendant of BASE to `ci/phase-1` (the only permitted ref), re-run Task 2 steps 2 to 5.

## Carry to plan 01-16

- The final CI run must be green on the Windows grammar job once the divergence decision is implemented.
- Nothing from plans 01-13 or 01-14 failed in this run (those files are not on BASE or did not cause failures).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

- Remote ref `ci/phase-1` at BASE verified; run URLs and conclusions queried live with `gh run view` (read-only).
