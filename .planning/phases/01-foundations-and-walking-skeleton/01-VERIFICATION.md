---
phase: 01-foundations-and-walking-skeleton
verified: 2026-10-15T18:00:00Z
status: gaps_found
score: 4/5 roadmap success criteria verified (SC4 partial: 2 blockers); 13/13 requirement IDs accounted for, 11 satisfied, FND-05 and FND-06 blocked
covered_files:
  - ".github/workflows/ci.yml"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-01-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-01-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-02-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-02-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-03-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-03-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-04-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-04-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-05-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-05-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-06-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-06-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-07-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-07-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-08-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-08-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-09-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-09-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-10-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-10-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-11-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-11-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-12-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-12-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-13-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-13-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-14-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-14-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-15-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-15-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-16-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-16-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-17-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-17-SUMMARY.md"
  - "corpora/corpora.json"
  - "docs/adr/README.md"
  - "eslint.config.js"
  - "package.json"
  - "scripts/grammar-budget.ts"
  - "scripts/grammar-build.ts"
  - "scripts/grammar-verify.ts"
  - "src/cli/index.ts"
  - "src/command-runner/decide.ts"
  - "src/command-runner/git-spec.ts"
  - "src/command-runner/hostile-repo.test.ts"
  - "src/command-runner/real.ts"
  - "src/lang/registry.ts"
  - "src/lang/test-runner.ts"
  - "src/source-tree/real.ts"
  - "test/fixtures/modules/toy/grammar.lock"
covered_digest: "v3:sha256:80b949c4267781d97a69e916c0fd5e330a90f4af1398797acd3729c214ba8aeb"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "SC4 / FND-06 / plan 01-13: a hostile repository runs nothing; gitSpec neutralises EVERY configured filter driver (no allowlist)"
    status: failed
    reason: "CR-02 reproduced. A filter driver whose name contains '=' (for example filter.a=b.clean) is dropped by parseFilterNames and cannot be expressed through -c, so SourceTree.snapshot() executes the repo-controlled clean command during hash-object --stdin-paths. Marker file was created."
    artifacts:
      - path: "src/command-runner/git-spec.ts"
        issue: "parseFilterNames cuts at first '=' and discards the key; neutraliseFilters uses '-c filter.<name>.<var>=' which cannot carry an '=' in the name"
      - path: "src/command-runner/decide.ts"
        issue: "GIT_FILTER_KEY regex [^=\\s]+ also refuses such keys, so the fix needs the GIT_CONFIG_COUNT/KEY_n/VALUE_n channel"
      - path: "src/command-runner/hostile-repo.test.ts"
        issue: "Only covers a driver named 'evil'; no case for a name containing '='"
    missing:
      - "Fail-closed neutralisation of every driver name (GIT_CONFIG_COUNT/KEY/VALUE env overlay, decide updated to permit it) and parse names with slice(7, lastIndexOf('.'))"
      - "Hostile-repo test for a driver named a=b with a marker assertion"
  - truth: "SC4 / FND-06 / command-runner ADR decision 4: a hostile repository runs nothing through the Source Tree"
    status: failed
    reason: "CR-01 reproduced. A repo-controlled promisor remote (extensions.partialClone, remote.origin.promisor=true) plus core.sshCommand makes SourceTree.hasObject()/read() trigger a lazy fetch that spawns the attacker command. Marker file was created."
    artifacts:
      - path: "src/command-runner/git-spec.ts"
        issue: "env pins only GIT_OPTIONAL_LOCKS and GIT_TERMINAL_PROMPT; no GIT_NO_LAZY_FETCH, no GIT_ALLOW_PROTOCOL=none"
      - path: "src/source-tree/real.ts"
        issue: "hasObject/read run cat-file against caller-supplied ids that may be absent"
    missing:
      - "GIT_NO_LAZY_FETCH=1 and GIT_ALLOW_PROTOCOL=none in every gitSpec env (verified fix per the review)"
      - "Hostile-repo test with a promisor config plus core.sshCommand asserting the marker is absent"
human_verification:
  - test: "Review the editorial repairs made at ADR ratification"
    expected: "Restored passages in 3-trust-boundaries.md decision 2, 5-language-modules.md decision 5, 6-fact-model.md decision 2 and PRD.md section 4.7 match the author's intent (repaired from PRD 4.6 and DESIGN A9)"
    why_human: "Text was reconstructed from secondary sources; only the author can confirm intent (plan 01-02 human check)"
  - test: "Supply the truncated clause in docs/SDK-PROVIDERS.md (normalized result paragraph)"
    expected: "The sentence ending mid-clause is completed"
    why_human: "The lost text cannot be recovered from any source in the repo"
  - test: "Type the confirmation phrase for the unset defaults: CommandRunner 60 s timeout and SQLite 5000 ms busy timeout"
    expected: "Defaults are set, or explicitly kept unset"
    why_human: "Held by decision pending a human-typed confirmation phrase"
  - test: "Open a throwaway pull request (or confirm one is not needed) to see the CI workflow run under the pull_request trigger"
    expected: "Static, Test (3 OS x Node 24.16.0 and 26) and Grammar rebuild jobs all run and pass on the PR event"
    why_human: "SC1 says every PR; the only real run is a push on ci/phase-1 (PRs were not authorised). ci.yml declares pull_request and a test asserts it, but no PR-event run exists"
  - test: "Accept or reject the Fact Store seam evidence (decision D-09)"
    expected: "A frozen interface with a compile-time signature check, plus the SQLite driver conformance suite on both drivers, is accepted as meeting SC4 for the Fact Store (no fake store, per the Accepted fact-store-interface ADR); a Fact Store level conformance suite arrives with its implementation in Phase 2"
    why_human: "Judgment call on whether a driver-level conformance suite counts as the Fact Store seam's 'double or conformance suite'"
---

# Phase 1: Foundations and Walking Skeleton Verification Report

**Phase Goal:** A developer can build and test the repo on macOS, Linux and Windows and run `gsd-atlas lang test` on a fixture language module end to end, with every module seam frozen behind an interface and a test double.
**Verified:** 2026-10-15
**Status:** gaps_found
**Re-verification:** No, initial verification
**Mode:** mvp (goal is not in "As a ... I want ... so that ..." form; verified against the roadmap goal and success criteria, no User Flow Coverage table produced)

## Verdict

Most of the phase is real and works. Every gate passes when run by the verifier. Success criteria 1, 2, 3 and 5 are verified. Success criterion 4 is not met in substance: the hostile-repo guarantee ("a hostile repo runs nothing") is falsified by two reproduced bypasses (CR-01, CR-02 from 01-REVIEW.md). Both were independently reproduced against the real runner and Source Tree on git 2.54.0, not taken from the review.

## Gates run by the verifier (worktree at d38cdfb, Node 26.11.1, macOS arm64)

| Gate | Result |
| ---- | ------ |
| `npm ci --ignore-scripts` | 0 vulnerabilities |
| `npm test` | 806 tests, 806 pass, 0 fail, 0 skipped, 0 todo |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0; `dist/bin/gsd-atlas.js` and `gsd-atlas-mcp.js` emitted |
| `npm run schema:check` | "schemas/atlas-lang.schema.json is current" |
| `npm run grammar:budget` | toy: errorBytes 0 of 202, ratio 0, budget 0.005, OK |
| `npm run grammar:verify` (toolchain cached locally) | darwin-arm64 rebuild sha256 equals committed grammar.wasm and grammar.lock (ffe6c2ed...0f9a, abi 15, cli 0.27.1) |
| `node scripts/corpus-check.ts` | 4/4 pinned corpora confirmed upstream by SHA |
| `npm pack --dry-run` | 134 files, 84.1 kB, both bins and schema present |
| Debt markers (TODO/FIXME/XXX/TBD) in `src` and `scripts` | none |

CI evidence: run 38841954238 on `ci/phase-1` at 2e59fc7 concluded success with ten jobs (Static; Test on ubuntu, macos, windows each at Node 24.16.0 and 26; Grammar rebuild on all three OSes). `git diff 2e59fc7 HEAD` touches only three planning files, so that run covers the current source.

## Success Criteria

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 1 | Every PR builds and tests on 3 OSes, produces the package with both bins; deliberate boundary violations fail lint | VERIFIED (PR-event run is a human item) | `ci.yml` triggers on `pull_request`, `push` and `workflow_dispatch`; matrix is ubuntu/macos/windows x Node 24.16.0 and 26, SHA-pinned actions, `contents: read`. Real run succeeded on all ten jobs. Package builds and `installed tarball runs the bins` test passes. I planted violations myself: `node:child_process` in `src/lang`, a deep `../facts/span.ts` import, `node:fs` and `fact-store` imports in a `policy` file, and a `cli` file importing `grammar-engine`; ESLint reported all five as errors with the intended messages. `src/lint/boundaries.test.ts` has fixture tests for every rule, each with a passing control, plus dynamic `import()` and `require` forms. |
| 2 | `lang test` end to end; `lang list` shows source and tiers; invalid manifest skipped with a diagnostic | VERIFIED | `node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy` returns `ok: true` with four fixtures (basic, bom, crlf, emoji) and goldens with 0-based UTF-16 spans. With the toy as a repo module and a second module with an unknown manifest key, `lang list` returned the toy (`source: repo`, tiers `grammar` active) plus a `manifest_invalid` warning for the bad one and exit 0. I mutated a golden endColumn and `lang test` failed with `golden_mismatch`. 3-OS execution evidenced by the CI run (`lang-test.e2e.test.ts` runs in the matrix). |
| 3 | Grammar WASM built from pinned upstream with pinned CLI on 3 OSes; rebuild reproduces pinned hash; ERROR-byte parse quality with failing CI budget | VERIFIED | `grammar.lock` pins CLI 0.27.1, abi 15 and sha256; the `upstream` source type requires `archiveSha256` (test `archive_hash_mismatch`). Local rebuild reproduced the hash (above); CI grammar jobs passed on all three OSes. Windows carries its own pinned hash (user decision, plan 01-15), the committed artifact is still hash-pinned on Windows. `measureErrors` reports bytes inside ERROR nodes; `grammar-budget` exits 1 for the negative fixture and uses strictly-greater comparison. Caveat: the only module is a local toy grammar, so the upstream-archive path is exercised by tests (file:// archive), not by a real upstream grammar yet (Phase 2/3 scope). |
| 4 | Each seam has a fixed interface plus a double or conformance suite passing in CI, and a hostile-repo test shows no child process starts except through the CommandRunner, including one batched `hash-object --stdin-paths` | FAILED (2 blockers) | Seams: CommandRunner (fake, recording, contract run on fake and real), Source Tree (fake, contract), Grammar Engine (fake, contract run on real and fake), PreciseResolver (stub, contract), Governor (noop and fake, contract run on both), Fact Store (frozen interface plus compile-time signature check plus SQLite driver contract on node:sqlite and better-sqlite3; no fake by D-09, see human item). The hostile-repo test exists, has a positive control, asserts zero denials, only built-in git starts, and exactly one `hash-object` start for 150 files. But the guarantee it exists to prove does not hold: see Gaps. |
| 5 | Corpus manifest pins each corpus to a SHA; every ADR this phase depends on Accepted with amendments, plus a schedule | VERIFIED | `corpora/corpora.json`: four 40-hex SHAs confirmed upstream by `corpus-check`; Swift reference app explicitly unselected until Phase 5 (SWF-05). `docs/adr/` has ADRs 2 to 9 renamed `<issue#>-<slug>.md`, `Status: Accepted`, and GitHub issues #2 to #9 exist in open-gsd/gsd-atlas. README has a ratification log, an amendment log (nine dated amendments, originals untouched) and a schedule naming Phase 2, 3 and 4 for the six remaining drafts. Tests assert all of this. |

## Gaps (blockers)

Both criticals are gaps against a stated success criterion and a stated plan truth. Plan 01-13 must-haves say gitSpec "neutralises EVERY configured filter driver by name ... with no allowlist"; `hostile-repo.test.ts` and `git-spec.ts` headers state that a hostile repository runs nothing. ROADMAP SC4 read literally ("no child process starts except through the CommandRunner") is satisfied by the test as written, because the recording runner only sees what Atlas starts. I weigh the criterion by its stated purpose and by the test's own docstring ("a hostile repository runs nothing"), which the reproductions falsify. Treat both as BLOCKERs for FND-06 and FND-05's Source Tree seam.

1. **CR-02, filter driver name containing `=` runs its clean command.** Reproduced by `scratchpad/repro.mts` against `createRealRunner()` plus `createSourceTree()`: `.gitattributes` with `*.txt filter=a=b`, config `filter."a=b".clean = "touch MARKER; cat"`, then `tree.snapshot(dir)`. Result: `marker exists: true`, snapshot otherwise normal with no diagnostics. Root cause in `git-spec.ts` `parseFilterNames` (cuts at first `=`, silently drops the key) and `-c` cannot express the name. Fix direction from the review (GIT_CONFIG_COUNT/KEY_n/VALUE_n overlay, fail closed on unparsable names, update `decide`) is sound.
2. **CR-01, promisor remote plus `core.sshCommand` runs an attacker command via `hasObject`/`read`.** Reproduced: `extensions.partialClone=origin`, `remote.origin.promisor=true`, `remote.origin.url=ssh://example.invalid/x.git`, `core.sshCommand=sh -c 'touch MARKER; exit 1' --`; `tree.hasObject('1234...')` returned `false` and `marker exists: true`. Fix direction: `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=none` in the gitSpec env, plus a hostile-repo test.

The hostile-repo test needs both new cases; today it would stay green while the guarantee is false (its fixture is limited to a filter named `evil`, fsmonitor and hooksPath).

## Observable Truths from PLAN must-haves (spot-checked against code, not SUMMARY)

| Truth | Status | Evidence |
| ----- | ------ | -------- |
| Boundary lint with fixture test per rule (01-03) | VERIFIED | See SC1; verifier-planted violations all failed lint |
| gitSpec prepends fsmonitor/hooksPath/quotepath overrides, pins env, neutralises every filter driver (01-13) | PARTIAL | First clauses hold; "every filter driver" fails for names containing `=` (CR-02) |
| One batched `hash-object --stdin-paths` per snapshot (01-13) | VERIFIED | Recording runner asserts exactly one hash-object start for 4 and for 154 files |
| Strict manifest schema, committed JSON Schema, Ajv parity (01-06) | VERIFIED | `schema:check` current; `schema-parity.test.ts` and 10 invalid manifest fixtures pass |
| Toy module and reproducible grammar pipeline (01-07) | VERIFIED | Local rebuild hash match |
| CommandRunner spec/decide/real/recording, streaming and batch stdin (01-09) | VERIFIED | `StdinSource` accepts async iterables, `stream()` exists, timeout-kill and output-cap tests pass. Default 60 s timeout intentionally unset (human item) |
| Driver layer with conformance on both drivers; frozen Fact Store interface (01-10) | VERIFIED | `driver contract: node:sqlite` and `driver contract: better-sqlite3` both ran in `npm test`; `fact-store/index.ts` exports only four error classes as values |
| Governor and PreciseResolver seams with doubles and contracts (01-11) | VERIFIED | Contracts run on noop and fake Governor; PreciseResolver stub contract passes; `precise` commands are data, never run |
| Grammar Engine seam, ERROR-byte measurement, budget script (01-12) | VERIFIED | Contract on real and fake engine; budget tests pass |
| lang test through CLI and HostClient with UTF-16, CRLF, BOM goldens (01-14) | VERIFIED | Run above; adapter lint forbids cli importing anything but host-client |
| Four-location precedence registry, invalid-module skipping, inert precise commands (01-17) | VERIFIED | Run above; `registry.test.ts` passes. Known defect WR-06 (self-collision for duplicate extensions) is a warning |
| Tarball smoke, quickstart, final CI evidence (01-16) | VERIFIED | `installed tarball runs the bins` passes; CI run exists |
| ADR amendments D-16, D-17 and Node floor record (01-08) | VERIFIED | `ADR amendments (FND-10, D-16, D-17)` suite passes; Phase 2 amendments correctly not applied |

## Requirements Coverage

All 13 requirement IDs declared across the 17 plans appear in REQUIREMENTS.md and in the ROADMAP Phase 1 list; none are orphaned, and REQUIREMENTS.md maps no other ID to Phase 1 (FND-12 is Phase 2). The REQUIREMENTS.md checkboxes and traceability still read Pending and must be updated by the orchestrator after the gaps close.

| Requirement | Source plan(s) | Status | Evidence |
| ----------- | -------------- | ------ | -------- |
| FND-01 CI on 3 OSes per PR | 01-03, 01-15, 01-16 | SATISFIED (PR-event run human item) | ci.yml; run 38841954238 |
| FND-02 one package, Node >= 24.16, tsc emit, two bins | 01-01, 01-16 | SATISFIED | package.json engines `>=24.16.0`; pack and tarball test |
| FND-03 manifest validated, Zod-generated JSON Schema, invalid skipped | 01-06, 01-14, 01-17 | SATISFIED | schema:check, parity test, lang list run |
| FND-04 reproducible grammar WASM, pinned CLI, 3 OSes | 01-07, 01-15, 01-16 | SATISFIED | grammar:verify local and CI |
| FND-05 each seam has interface plus double or conformance | 01-04, 01-09 to 01-13 | BLOCKED (Source Tree seam is not hostile-safe; Fact Store double is a human decision) | see SC4 |
| FND-06 every child starts through CommandRunner, enforced by lint, streaming and batch | 01-09, 01-13 | BLOCKED | Lint and batch/streaming hold; hostile-repo guarantee fails (CR-01, CR-02) |
| FND-07 boundary lint rules | 01-03 | SATISFIED | Verifier-planted violations |
| FND-08 corpus manifest pinned to SHAs | 01-05 | SATISFIED | corpus-check 4/4 |
| FND-09 ADRs ratified | 01-02 | SATISFIED (repairs need human review) | ADR files and issues #2 to #9 |
| FND-10 three ADR gap amendments | 01-08 | SATISFIED | amendment tests and README log |
| FND-11 `lang test` on fixture module on 3 OSes | 01-14, 01-16 | SATISFIED | CLI run; CI matrix |
| LNG-01 module folder resolved repo > user > npm > built-in, `lang list` | 01-17 | SATISFIED | registry and CLI run |
| LNG-06 bytes inside ERROR nodes with CI budget | 01-12 | SATISFIED | budget script and tests |

## Other review findings weighed (non-blocking for this phase's must-haves)

These are real defects in 01-REVIEW.md that I did not elevate to gaps because they do not falsify a Phase 1 must-have, but they should be scheduled before Phase 2 builds on these seams:

- WR-01: `decide` option denylist is bypassable (`hash-object -wt`, abbreviated `--textc`, `rev-list --output`/`--alternate-refs`) and does not require the safety overrides. Latent; no current call site passes untrusted text in option position. Closing CR-01/CR-02 should fold this in.
- WR-02 (symlinked parent directory followed), WR-03 (one vanished file aborts the whole snapshot), WR-04 (every non-zero `cat-file` exit read as "missing"), WR-05 (`rootCommit` changes on shallow deepen): Source Tree correctness issues Phase 2 indexing will hit.
- WR-06: a module declaring `[".ts", ".TS"]` collides with itself (LNG-01 edge case).
- WR-09: untrusted repo text written raw to stderr (terminal escape injection); belongs with the Phase 2 MCP untrusted-text fencing work but is a cheap fix now.
- WR-10, WR-13, WR-14 and the Info items: grammar-engine time bounds, unverified tree-sitter binary download in CI, budget reader inconsistency. Not Phase 1 criteria.

## Human Verification Required

See `human_verification` in the frontmatter: (1) review the ADR editorial repairs, (2) the truncated clause in `docs/SDK-PROVIDERS.md`, (3) the human-typed confirmation for the unset CommandRunner 60 s and SQLite 5000 ms default timeouts, (4) a PR-event CI run for SC1's "every PR", and (5) accept the Fact Store seam evidence under D-09.

Judgment on the Fact Store (known-context question): the frozen interface plus the driver conformance suite on both drivers is a reasonable reading of SC4 given the Accepted fact-store-interface ADR says "no fake store", and a Fact Store level suite cannot exist before an implementation does (Phase 2). I did not count it as a gap, but it is a literal stretch of "conformance suite" for the Fact Store, so it is recorded for human acceptance.

## Gaps Summary

Close CR-02 and CR-01 (both small, localized to `git-spec.ts`, `decide.ts` and the hostile-repo test), re-run the full gate set, and the phase should pass. Suggested closure plan: one gap-closure plan covering CR-01, CR-02 and WR-01 together, because they share `git-spec.ts` and `decide.ts` and WR-01 asks `decide` to require the very overrides that CR-01/CR-02 add. Do not weaken the hostile-repo test; extend its fixture with the `a=b` driver and the promisor/sshCommand case.

---

_Verified: 2026-10-15_
_Verifier: Claude (gsd-verifier)_
