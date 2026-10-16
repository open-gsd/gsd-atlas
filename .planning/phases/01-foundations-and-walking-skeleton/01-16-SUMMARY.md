---
phase: 01-foundations-and-walking-skeleton
plan: 16
subsystem: packaging-and-ci-evidence
tags: [npm-pack, tarball-smoke, readme, ci, three-os, success-criteria]
requires: [01-13, 01-14, 01-15, 01-17]
provides:
  - tarball proof - the packed @opengsd/gsd-atlas installs in a clean directory and runs both bins and lang test
  - README Developer quickstart with a test that every documented npm script exists
  - SKELETON.md with five stack items ticked, each with an evidence note
  - final green three-OS CI run on the pushed commit, with the five-criteria evidence table below
affects: [phase verification (/gsd-verify-work), phase 2 planning]
key-files:
  created: []
  modified:
    - scripts/package.test.ts
    - README.md
    - .planning/phases/01-foundations-and-walking-skeleton/SKELETON.md
  deleted:
    - .github/workflows/grammar-hash-parity.yml
decisions:
  - "The new package tests set no wall-clock timeout (no timeoutMs on the runner, no test-level timeout). A repo guard blocks introducing a timeout-shaped constant unless a human types a confirmation phrase, so I did not add one and did not rename around it. A hung registry install is bounded only by the CI job timeout (30 min)."
  - "npm is started as `node <npm-cli.js> ...` through createRealRunner (FND-06): never an npm shim, never a shell. findNpmCli() tries npm_execpath, then two paths relative to the real path of process.execPath, then the `npm` link next to node (Homebrew puts npm outside the node prefix, which the plan's two candidates missed)."
  - "pack-contents uses a strict whitelist (dist/, schemas/, modules/, package.json, README.md, LICENSE) on top of the explicit forbidden-prefix and test-output checks, so an unexpected new path fails instead of slipping through a blacklist."
  - "grammar-hash-parity.yml was removed: plan 01-15 recorded that CI evidence was obtained and that the divergence (win32 rebuild differs) was resolved by the user's per-platform-hash decision, which is now enforced permanently by the `Grammar rebuild` CI job."
metrics:
  commits: 2
  plan_head_before: 8e133bfe9904548975ad8a83a58758bb49479ee7
  plan_head_after: 2e59fc7c424c8699e220c021acdd34f7751fcfe2
  duration: about 25 minutes
actuals:
  tasks: 3
  commits: 2
status: complete
---

# Phase 1 Plan 16: Tarball proof, README and final three-OS CI Summary

The packed `@opengsd/gsd-atlas` tarball now installs in a clean directory with `--ignore-scripts` and runs both bins and `lang test` on the toy module, the README documents the exact local-run commands (guarded by a test), the throwaway parity workflow is gone, and the final CI run on the pushed commit `2e59fc7` is green on all ten jobs on the first push (no iteration needed).

`commits: 2` is the measured count of task commits (`git rev-list --count 8e133bf..2e59fc7`). The SUMMARY itself and the Deployment tick in SKELETON.md are committed after the push, in one docs-only commit that changes no code and no workflow, so the commit CI tested contains every code and config change of this plan.

## What changed

- `scripts/package.test.ts` gained three tests plus a `findNpmCli()` helper:
  - `pack contents` - runs `npm pack --json --ignore-scripts` on a fresh build; requires `package.json`, `dist/bin/gsd-atlas.js`, `dist/bin/gsd-atlas-mcp.js`, `schemas/atlas-lang.schema.json` and compiled `dist/{lang,grammar-engine,cli}`; every bin target in package.json is in the tarball; nothing under `src/ test/ scripts/ docs/ .planning/ .github/ node_modules/`; no `contract.js/.d.ts`, `*.test.js/.d.ts` or test-kit path; every path matches a strict whitelist.
  - `installed tarball runs the bins` - installs the tarball into a clean prefix (`--ignore-scripts --no-audit --no-fund`), checks `web-tree-sitter` and `zod` came from the tarball's own dependencies, scans every installed `dist/**/*.js` for `node:test` and test-kit specifiers (specifier-aware: import, export-from, `import()`), then runs `--version` (`gsd-atlas 0.0.0`), `lang list` against three empty roots (ok envelope, no modules), `lang test` on the repo's `test/fixtures/modules/toy` (ok, four fixtures ok), and `gsd-atlas-mcp` (exit 1, stderr mentions Phase 2).
  - `README npm scripts exist` - README has the `Developer quickstart` heading and the required commands, and every `npm run <name>` in it is a key of package.json `scripts` (and the six required script names are documented).
- `README.md` rewritten: what gsd-atlas is, the honest current stage, the Node 24.16.0 floor with the one-line reason, the quickstart, pointers to `docs/adr/README.md` and `docs/PRD.md`, MIT licence.
- `SKELETON.md`: all five "Stack Touched in Phase 1" boxes ticked, each with an evidence note. No box is ticked without a note. The out-of-scope list is unchanged.
- `.github/workflows/grammar-hash-parity.yml` removed with `git rm`; `scripts/ci-config.test.ts` still passes and CI ran only the permanent workflow.
- No change to `package.json`: the `files` list already produced a clean tarball, so no leak needed fixing and no source file had to change (no production file imports test code).

## CI evidence (final)

FINAL = `2e59fc7c424c8699e220c021acdd34f7751fcfe2`, pushed non-force as a descendant of `d0b5d53` to `refs/heads/ci/phase-1` of open-gsd/gsd-atlas (visibility confirmed PRIVATE first): `git push origin HEAD:refs/heads/ci/phase-1`, output `d0b5d53..2e59fc7`. One push, no iterations.

Run: https://github.com/open-gsd/gsd-atlas/actions/runs/38841954238 - conclusion `success`, head sha `2e59fc7c424c8699e220c021acdd34f7751fcfe2`. No other workflow ran (the parity workflow no longer exists). Job URLs below are under `https://github.com/open-gsd/gsd-atlas/actions/runs/38841954238/job/<id>`.

| Job | Conclusion | Job id | Result detail |
|-----|-----------|--------|---------------|
| Static checks (ubuntu) | success | 116783841572 | lint, typecheck, `schemas/atlas-lang.schema.json is current.` |
| Test (ubuntu-latest, Node 24.16.0) | success | 116783841729 | 806 tests, 806 pass, 0 skipped |
| Test (ubuntu-latest, Node 26) | success | 116783841796 | 806 pass, 0 skipped |
| Test (macos-latest, Node 24.16.0) | success | 116783841937 | 806 pass, 0 skipped |
| Test (macos-latest, Node 26) | success | 116783841791 | 806 pass, 0 skipped |
| Test (windows-latest, Node 24.16.0) | success | 116783841737 | 806 tests, 801 pass, 5 skipped (below) |
| Test (windows-latest, Node 26) | success | 116783841891 | 801 pass, 5 skipped |
| Grammar rebuild (ubuntu-latest) | success | 116783841935 | `verified linux-x64 rebuild sha256 ffe6c2ed...a0f9a; committed ... ffe6c2ed...a0f9a` |
| Grammar rebuild (macos-latest) | success | 116783841768 | `verified darwin-arm64 rebuild sha256 ffe6c2ed...a0f9a; committed ... ffe6c2ed...a0f9a` |
| Grammar rebuild (windows-latest) | success | 116783841669 | `verified win32-x64 rebuild sha256 cba9dce1...8853; committed grammar.wasm sha256 ffe6c2ed...a0f9a` |

Every `Test` cell also ran `npm run build` and `npm run grammar:budget` (steps green). `pack contents`, `installed tarball runs the bins` and `README npm scripts exist` passed in all six test cells, including Windows (installed-tarball test took about 10 to 12 s there).

### Skipped tests per OS

- ubuntu-latest (Node 24.16.0 and 26): 0 skipped.
- macos-latest (Node 24.16.0 and 26): 0 skipped.
- windows-latest (Node 24.16.0 and 26): 5 skipped, identical on both Node versions, all explicit with a reason in the test:
  1. `uses the executable bit (real files)` - Windows has no POSIX exec bit.
  2. `does not read a fixture that is a symlink pointing out of the module folder` - creating symlinks needs elevated rights on Windows.
  3. `does not read a golden that is a symlink pointing out of the module folder` - same reason.
  4. `skips a path with a newline (unhashable_path) and still hashes the rest in one call` - Windows cannot create file names with a newline or a double quote.
  5. `skips a symlink with symlink_skipped and keeps the batch going` - creating a symlink needs privileges on Windows.
  Consequence: symlink-escape behaviour and exec-bit handling are proven by the Linux and macOS legs only. This plan adds no Windows skip.

## Success criteria evidence

Run URL for all CI rows: https://github.com/open-gsd/gsd-atlas/actions/runs/38841954238 (commit 2e59fc7).

| SC | Criterion (short) | Evidence | Status |
|----|-------------------|----------|--------|
| 1 | Builds and tests on macOS, Linux, Windows in CI; produces the package with both bins; boundary violations fail lint | Jobs `Test (ubuntu/macos/windows-latest, Node 24.16.0/26)` all success (build + `npm test` + budget). Package and bins: `scripts/package.test.ts` tests `pack contents` and `installed tarball runs the bins` pass in all six cells (tarball contains both bins and the schema, installs clean, both bins run). Lint: `Static checks` job runs `npm run lint`; one violation fixture per rule in `src/lint/boundaries.test.ts` (child_process outside CommandRunner, `sqlite/` from a non-store module, deep import bypassing `index.ts`, Policy outside `facts/`, adapter beyond HostClient, production purity) passes in every `Test` cell. Local: `npm test` 806 pass. | MET for build/test on three OSes, package, bins and lint. PARTIAL on the word "every PR": `ci.yml` has a `pull_request` trigger (asserted by `scripts/ci-config.test.ts`) but no pull request was opened (not authorised), so a PR-event run is not evidenced. human_needed: confirm on the first real PR. |
| 2 | `lang test` end to end on three OSes; `lang list` shows source and tiers; invalid manifest skipped with diagnostic | `src/lang/lang-test.e2e.test.ts` (real bin through the real CommandRunner: exit 0, envelope, goldens incl. emoji, CRLF, BOM) and `src/lang/registry.test.ts` (`resolveModules: an invalid module is skipped, never a crash`, code `manifest_invalid`) pass in all six test cells; installed-tarball run of `lang list` and `lang test` (above) passes on all three OSes. | MET |
| 3 | Grammar WASM built from pinned upstream with pinned CLI on three OSes; rebuild reproduces the pinned hash; parse quality as ERROR-node bytes with a failing CI budget | Jobs `Grammar rebuild (ubuntu/macos/windows-latest)` success, each `verified <platform> rebuild sha256 ...` equal to its own `grammar.lock` `wasm.platforms` entry (linux-x64 and darwin-arm64 byte-identical `ffe6c2ed...`, win32-x64 `cba9dce1...` by the user's per-platform-hash decision in 01-15). `npm run grammar:budget` step green in all six test cells (`toy: errorBytes 0 totalBytes 202 ratio 0.000000 budget 0.005 OK` locally); negative budget test in `scripts/grammar-budget.test.ts` passes. | MET as amended: cross-OS byte identity does NOT hold for win32 (accepted by user decision in 01-15; cause undiagnosed, toolchain-side). Reproducibility is per platform, not across platforms. |
| 4 | Each of six seams has a fixed interface plus double or conformance suite passing in CI; hostile-repo test; one batched `git hash-object --stdin-paths` | Contract suites: `src/command-runner/contract.ts`, `src/source-tree/contract.ts`, `src/grammar-engine/contract.ts`, `src/precise-resolver/contract.ts`, `src/governor/contract.ts`, and `src/sqlite/contract.ts` (driver conformance for the Fact Store seam, whose interface is frozen in `src/fact-store/types.ts`). All run in every `Test` cell. Hostile-repo: `src/command-runner/hostile-repo.test.ts` (git runs only through the CommandRunner; batched `hash-object --stdin-paths`) green; its Windows skips are items 4 and 5 of the skip list above (newline file name, symlink). | MET with one reading to confirm: the Fact Store has the interface and the SQLite driver conformance suite but, by decision D-09, no fake Fact Store and no `contract.ts` of its own (`src/fact-store/fact-store.test.ts` only). Verifier should confirm that satisfies "double or conformance suite" for that seam. |
| 5 | Corpus manifest pins each corpus to a commit SHA; every Phase 1 ADR Accepted (issue opened, renamed `<issue#>-<slug>.md`) with research-gap amendments applied; schedule for remaining ADRs | `scripts/corpus.test.ts` and `corpora/corpora.json` (SHA pins; Swift reference app is `status: unselected` until Phase 5 per assumption 6), `scripts/adr.test.ts` (eight renamed ADRs `docs/adr/2-...` to `9-...`, issues #2 to #9 opened in the private repo, link check, ratification log, schedule in `docs/adr/README.md`; amendments from plan 01-08) pass in every `Test` cell. | MET. The eight issues are still OPEN by design (see Flagged). |

## Local checks before the push

`npm ci --ignore-scripts`, `npm run build`, `npm test` (806 pass, 0 fail, 0 skipped on macOS arm64 / Node 26.11.1), `npm run lint`, `npm run typecheck`, `npm run grammar:budget` (ratio 0.000000), `node scripts/ensure-tree-sitter.ts` then `npm run grammar:verify` (`verified darwin-arm64 ... ffe6c2ed...a0f9a`), `npm run schema:check` (current). Red-first: the README test failed (`pass 0, fail 1`) before the README was written.

## Deviations from Plan

**1. [Process] No timeout in the new tests.** Found during Task 1. A PreToolUse guard refused a first draft that declared a five-minute network timeout constant for the package tests; it requires a human to type a confirmation phrase naming that constant and its value (the guard's refusal message states it; the phrase is also repeated in this plan's return message to the orchestrator). I did not rename or restructure the constant to slip past it. The tests simply set no timeout (node:test default, runner default: no wall-clock limit); the job-level `timeout-minutes: 30` bounds a hang. If you want an explicit per-test limit, type the phrase and add `timeoutMs` to `runChild` in `scripts/package.test.ts`. (The same guard also fired once on a draft of this SUMMARY that quoted the phrase literally, so the phrase is deliberately not written here.)

**2. [Rule 3 - Blocking] `findNpmCli()` candidate list.** The plan's two candidates (`node_modules/npm/bin/npm-cli.js` next to node, `../lib/node_modules/npm/bin/npm-cli.js`) do not exist on Homebrew, where npm lives outside the node prefix and `<node dir>/npm` is a link to `npm-cli.js`. Added that link as a third candidate. Verified locally; CI layouts use the first two. Files: `scripts/package.test.ts`. Commit `4e0ef4c`.

No tarball leak was found, so the plan's contingency steps (editing `files`, fixing an importing source file, adding a `boundaries.test.ts` fixture) were not needed.

## Flagged for the user

- Held-back timeout defaults (the guard hook names the phrase when the edit is attempted): the 60 s default per-spec timeout in the CommandRunner (plan 01-09, constant `DEFAULT_TIMEOUT_MS`), the 5000 ms busy-timeout default in `src/sqlite/open.ts` (plan 01-10, currently 0), and the optional per-test limit in this plan (above). Phase 2 should not rely on snapshots of very large repos until the runner default is chosen.
- `docs/SDK-PROVIDERS.md` line 123 ends mid-sentence ("... with introduced, deprecated and removed; and"); the lost clause is unrecoverable. Supply it or confirm it can be dropped (plan 01-02).
- Stale "Node 24.15" floor mentions that this phase was told not to edit (plan 01-08 list): `.claude/CLAUDE.md` lines 41, 51, 175; `.planning/research/STACK.md` lines 22, 32, 73, 123, 183; `.planning/research/SUMMARY.md` lines 20, 74; `.planning/research/PITFALLS.md` lines 100, 452; `.planning/STATE.md` line 83. Fix STACK.md first because `.claude/CLAUDE.md` is generated from it.
- DESIGN.md and PRD wording about a file-count parse budget (superseded by the ERROR-node-bytes amendment): `docs/DESIGN.md` lines 60 and 147, `docs/PRD.md` line 352.
- The eight ADR issues (#2 to #9 in open-gsd/gsd-atlas) are all still OPEN; closing them is deferred by the skeleton scope. The six remaining ADRs are scheduled in `docs/adr/README.md` (four in Phase 2, one in Phase 3, one in Phase 4).
- End-of-phase human check (plan 01-02): review the four repaired lost-text passages in `docs/adr/3-trust-boundaries.md`, `docs/adr/5-language-modules.md`, `docs/adr/6-fact-model.md` and `docs/PRD.md` line 193.
- The README "Naming" paragraph in `docs/adr/README.md` still says the repo has no issues yet (plan 01-02 left it).
- Windows byte difference in the toy WASM stays undiagnosed (01-15); Windows symlink and exec-bit behaviour is covered by Linux and macOS legs only.
- The CI run was triggered by a branch push to `ci/phase-1`, not a pull request (see SC1).

## Known Stubs

None.

## Threat Flags

None. T-01-40 is mitigated by `pack contents` (strict whitelist, forbidden prefixes, no test output) and the installed-dist specifier scan; T-01-41 accepted as planned (the tarball install fetches only `web-tree-sitter` 0.27.1 and `zod` 4.6.7 exact pins with `--ignore-scripts`).

## Self-Check: PASSED

- `scripts/package.test.ts`, `README.md`, `SKELETON.md` exist; `.github/workflows/grammar-hash-parity.yml` is gone (`git ls-files .github/workflows` lists only `ci.yml`).
- Commits `4e0ef4c` and `2e59fc7` are ancestors of HEAD; `ci/phase-1` points at `2e59fc7`.
- CI run 38841954238 conclusion and all ten job conclusions queried live with `gh run view` (read-only); logs read for test counts, skips and grammar hashes.
- No force push, no push to any ref other than `ci/phase-1`, no PR or issue created, no STATE.md or ROADMAP.md change, `.codegraph/` not committed.
