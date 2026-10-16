---
phase: 01-foundations-and-walking-skeleton
verified: 2026-10-16T14:00:00Z
status: passed
score: "5/5 roadmap success criteria verified in code; 13/13 requirement IDs accounted for and satisfied in code; 4 human decision items remain"
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
  - ".planning/phases/01-foundations-and-walking-skeleton/01-18-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-18-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-19-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-19-SUMMARY.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-20-PLAN.md"
  - ".planning/phases/01-foundations-and-walking-skeleton/01-20-SUMMARY.md"
  - "package.json"
  - "src/command-runner/decide.test.ts"
  - "src/command-runner/decide.ts"
  - "src/command-runner/filter-name.ts"
  - "src/command-runner/git-spec.test.ts"
  - "src/command-runner/git-spec.ts"
  - "src/command-runner/hostile-repo.test.ts"
  - "src/source-tree/real.ts"
  - "src/source-tree/source-tree.test.ts"
covered_digest: "v3:sha256:448b912ea88077e6ff538ad2ca2653b45b9baad3705ec7fe785d93510781d568"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "4/5 roadmap success criteria (SC4 failed: 1 blocker, filter driver name not valid UTF-8 escapes neutralisation)"
  gaps_closed:
    - "CR-01 (01-REVIEW, prior): non-UTF-8 / U+FFFD / unpaired-surrogate / NUL / LF / CR / over-1024-unit filter driver name ran its clean command (plan 01-20)"
    - "WR-01 (prior): builder emitted CR names that decide refused; one shared predicate now (plan 01-20)"
    - "Human item 4 (three-OS CI on post-gap-closure source plus a pull_request-event run): push run 38896073556 and PR run 38896083789, all ten jobs success on head 5a1caa0, src/scripts/.github/package.json identical to HEAD"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Review the editorial repairs made at ADR ratification"
    expected: "Restored passages in 3-trust-boundaries.md decision 2, 5-language-modules.md decision 5, 6-fact-model.md decision 2 and PRD.md section 4.7 match the author's intent"
    why_human: "Text was reconstructed from secondary sources; only the author can confirm intent (plan 01-02 human check)"
  - test: "Supply the truncated clause in docs/SDK-PROVIDERS.md (normalized result paragraph)"
    expected: "The sentence ending mid-clause is completed"
    why_human: "The lost text cannot be recovered from any source in the repo"
  - test: "Type the confirmation phrase for the unset defaults: CommandRunner 60 s timeout and SQLite 5000 ms busy timeout"
    expected: "Defaults are set, or explicitly kept unset"
    why_human: "Held by decision pending a human-typed confirmation phrase (01-09 and 01-10 SUMMARY deviations; a repo guard forbids an agent from setting them)"
  - test: "Accept or reject the Fact Store seam evidence (decision D-09)"
    expected: "A frozen interface with a compile-time signature check plus the SQLite driver conformance suite on both drivers is accepted as the Fact Store's 'conformance suite' for SC4 (no fake store per the Accepted fact-store-interface ADR); a Fact Store level suite arrives with its implementation in Phase 2"
    why_human: "Judgment call on whether a driver-level suite counts as the Fact Store seam's double or conformance suite"
---

# Phase 1: Foundations and Walking Skeleton Verification Report

**Phase Goal:** A developer can build and test the repo on macOS, Linux and Windows and run `gsd-atlas lang test` on a fixture language module end to end, with every module seam frozen behind an interface and a test double.
**Verified:** 2026-10-16
**Status:** human_needed
**Re-verification:** Yes, after gap-closure plan 01-20 (HEAD 8c04681; source identical to CI head 5a1caa0)

## Verdict

The single blocker from the previous report is closed, and I confirmed that independently rather than from the summary. The remaining items are four human decisions that an agent must not settle (ADR editorial intent, a lost sentence, two held default timeouts, and acceptance of the Fact Store seam evidence). No code gap remains, so the status is `human_needed`, not `gaps_found` and not `passed`.

## Prior blocker: closure check (independent)

Previous blocker: a filter driver name that is not valid UTF-8 was decoded lossily, neutralised under a different name than configured, and the repo-controlled clean command ran (ROADMAP SC4, FND-05, FND-06).

What I checked in code:

- `src/command-runner/filter-name.ts` (new leaf, 50 lines): one shared rule `filterNameProblem` refuses U+FFFD, unpaired surrogates, NUL, LF, CR and names over 1024 UTF-16 code units.
- `src/command-runner/git-spec.ts`: `listFilterNames` decodes git's stdout with `new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })` (line 191), runs every listed name through `filterNameProblem`, and throws `GitConfigError('filter_enumeration_failed')` before any `hash-object` start. `neutraliseFilters` calls the same predicate (lines 73-77). `decide.ts` imports the leaf rule, not `git-spec.ts`, so the gate does not trust the builder.
- Header claims in `git-spec.ts` and `filter-name.ts` now state the true limit (no more "whatever it is called").

What I ran (my own script against `createSourceTree` over `createRealRunner()` and the default `decide`, git 2.54.0, macOS arm64; each case run unprotected and protected):

| Driver name | Unprotected | Protected `snapshot()` |
| ----------- | ----------- | ---------------------- |
| `evil` (control) | marker written | no marker, resolves |
| `a=b` | marker written | no marker, resolves |
| `a\xffb` (the previous blocker) | marker written | no marker, rejected `filter_enumeration_failed` |
| `a\xc3\x28b` | marker written | no marker, rejected `filter_enumeration_failed` |
| `a\xed\xa0\x80b` | marker written | no marker, rejected `filter_enumeration_failed` |

The positive control fired in every case, so the protected result is a real protection, not a silent poison.

Tests: `hostile-repo.test.ts` has real-byte cases (0xFF, C3 28, ED A0 80, genuine U+FFFD, 1025 units, CR) that assert no marker, a typed rejection and exactly one git start (`config`); a representable group (non-ASCII, emoji, exactly 1024 units, tab, leading and trailing space) checks no over-refusal. `git-spec.test.ts` has a builder/gate agreement corpus.

## Gates run by the verifier (HEAD 8c04681; Node 26.11.x, macOS arm64)

| Gate | Result |
| ---- | ------ |
| `npm test` | 918 tests, 918 pass, 0 fail, 0 skipped |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `npm run schema:check` | schema is current |
| `npm run grammar:budget` | toy errorBytes 0, ratio 0.000000, budget 0.005 OK |
| `npm run grammar:verify` | atlas_toy rebuild sha256 equals committed grammar.wasm (abi 15, cli 0.27.1) |
| `gsd-atlas lang list` (built bin) | `ok: true`, empty module list when no root flags |
| `gsd-atlas lang test test/fixtures/modules/toy` (built bin) | `ok: true`; basic, bom, crlf, emoji fixtures all `ok` |
| `git diff --quiet 5a1caa0 HEAD -- src scripts .github package.json package-lock.json` | exit 0 (HEAD source equals the CI-tested source) |
| `git diff --stat 8f5da3b HEAD -- . ':!.planning'` | only 7 files in `src/command-runner/` and `src/source-tree/source-tree.test.ts` changed since the previous verification, so regression surface is those files, and the full suite is green |

CI (read with `gh run view`): push run 38896073556 and pull_request run 38896083789, both conclusion success on `headSha` 5a1caa09160e0e9dfadd93092579f3251d1c8d66, all ten jobs success (Static checks; Test on ubuntu, macos, windows at Node 24.16.0 and 26; Grammar rebuild on the three OSes). This satisfies the CI part of previous human item 4.

## Success Criteria

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 1 | CI on 3 OSes per PR, package with both bins, boundary violations fail lint | VERIFIED | Ten-job green push and PR runs on the final source; bins `gsd-atlas` and `gsd-atlas-mcp` in `package.json`, built `dist/bin/gsd-atlas.js` runs; lint and boundary tests green |
| 2 | `lang test` end to end; `lang list`; invalid manifest skipped | VERIFIED | Built CLI run above; `src/lang` tests and `lang-test.e2e.test.ts` green in 918/918 |
| 3 | Reproducible pinned grammar build, ERROR-byte budget in CI | VERIFIED | `grammar:verify` rebuild hash equals committed wasm; `grammar:budget` OK; Grammar rebuild jobs green on 3 OSes |
| 4 | Each seam has interface plus double or conformance suite; hostile-repo test shows nothing starts except through the CommandRunner | VERIFIED in code; one acceptance item human | Blocker closed (table above); single batched `hash-object` test passes; Fact Store seam acceptance is human item 4 |
| 5 | Corpus manifest SHAs, ADRs Accepted with amendments and schedule | VERIFIED (code and docs); editorial repairs human | Unchanged by plan 01-20; human items 1 and 2 |

## Observable Truths from PLAN must-haves

| Truth | Status | Evidence |
| ----- | ------ | -------- |
| 01-20: a repo with a non-UTF-8 / U+FFFD / CR / over-long driver name executes nothing during `snapshot()`; rejects `filter_enumeration_failed`; one `config` start and no `hash-object` start | VERIFIED | Independent repro and hostile-repo tests above |
| 01-20: `listFilterNames` decodes fatally and every name passes the shared predicate | VERIFIED | git-spec.ts:191, :253-268 |
| 01-20: builder and gate share one rule, neither imports the other | VERIFIED | `filter-name.ts` leaf; `decide.ts` imports it, not `git-spec.ts`; agreement corpus test |
| gitSpec neutralises every filter driver whose name the channel can carry, no allowlist (01-13, 01-19) | VERIFIED | `neutraliseFilters` lines 73-90; `a=b`, `a=b=c`, dotted, empty names covered |
| gitSpec pins fsmonitor/hooksPath/quotepath and promisor-safe env; decide refuses specs lacking them (01-18) | VERIFIED | git-spec.ts PINNED_ENV (`GIT_NO_LAZY_FETCH`, `GIT_ALLOW_PROTOCOL`); promisor hostile group green |
| Listing fails closed when git ignores the env channel (01-19) | VERIFIED | random probe, `git_env_config_unsupported` |
| One batched `hash-object --stdin-paths` per snapshot (01-13) | VERIFIED | 150-file test passes |
| Remaining plan truths (01-01 to 01-12, 01-14 to 01-17) | VERIFIED | Full suite 918/918; carried from previous report with no relevant file changes |

## Requirements Coverage

Requirement IDs declared across the PLAN frontmatter: FND-01 to FND-11, LNG-01, LNG-06 (13 IDs). Every one is present in REQUIREMENTS.md and mapped to Phase 1 in its traceability table; none orphaned. (FND-12 is Phase 2 in REQUIREMENTS.md.) REQUIREMENTS.md checkboxes still read Pending, for the orchestrator to update after the human items are resolved.

| Requirement | Status | Evidence |
| ----------- | ------ | -------- |
| FND-01 | SATISFIED | ci.yml; three-OS push and PR runs green on final source |
| FND-02 | SATISFIED | package.json, two bins, tsc emit; build exit 0. (Note: REQUIREMENTS.md says Node >= 24.16; `.claude/CLAUDE.md` says 24.15; CI uses 24.16.0. Documentation drift, not a phase gap.) |
| FND-03 | SATISFIED | zod-generated schema, `schema:check` current, invalid manifest skipped |
| FND-04 | SATISFIED | `grammar:verify` reproducible; Grammar rebuild jobs on 3 OSes |
| FND-05 | SATISFIED in code; Fact Store double acceptance is human item 4 | interfaces plus doubles/conformance for Source Tree, CommandRunner, Grammar Engine, PreciseResolver, Governor; Fact Store frozen interface plus driver conformance on both drivers |
| FND-06 | SATISFIED | lint-enforced child process boundary, streaming, one batched hash-object, hostile-repo guarantee now holds for non-UTF-8 names |
| FND-07 | SATISFIED | boundary lint tests green |
| FND-08 | SATISFIED | corpus manifest SHAs (previous report; no changes) |
| FND-09, FND-10 | SATISFIED in repo; editorial intent is human items 1 and 2 | ADR ratification artefacts present; author review pending |
| FND-11 | SATISFIED | built `gsd-atlas lang test test/fixtures/modules/toy` ok |
| LNG-01, LNG-06 | SATISFIED | registry tiers and `lang list`; ERROR-byte budget gate OK |

## Anti-Patterns Found

No TBD/FIXME/XXX in `filter-name.ts`, `git-spec.ts` or `decide.ts`. No stubs in the files changed by 01-20. Open review items are all non-blocking and none falsifies a must-have:

| Item | Severity | Disposition |
| ---- | -------- | ----------- |
| WR-02 `decide` option denylist bypassable by abbreviation or bundling (`cat-file --textc`, `hash-object -wt`, `rev-list --output`) | Warning | Latent: no call site puts untrusted text in an option position. Schedule before Phase 2 builds on `decide` (recorded in 01-20 SUMMARY and 01-REVIEW-DISPOSITION.md) |
| WR-03 pinned env checked by presence only; rest of env not bounded; doc comment says "exactly" | Warning | Same scheduling |
| WR-04 total env size unbounded: many long-named `[filter]` sections give an opaque `spawn E2BIG` (about 8 max-length names on Windows); the cross-platform comment on the 1024 cap is overstated | Warning | Fails closed (nothing runs), repo-controlled denial of its own indexing only; fix or reword before Phase 2 |
| IN-01 to IN-06 | Info | IN-01 (protection tests do not fail when their positive control is skipped; 0 skips on all runs seen), IN-04 (`shown()` leaves C1 controls and bidi overrides raw), IN-05 (remedy text names only repository config), IN-06 (three representable-name cases cannot fail) |

## Human Verification Required

### 1. Review the editorial repairs made at ADR ratification

**Test:** Read the restored passages in `3-trust-boundaries.md` decision 2, `5-language-modules.md` decision 5, `6-fact-model.md` decision 2 and `PRD.md` section 4.7.
**Expected:** They match the author's intent.
**Why human:** Text was reconstructed from secondary sources; only the author can confirm intent.

### 2. Supply the truncated clause in docs/SDK-PROVIDERS.md

**Test:** Complete the sentence ending mid-clause in the normalized result paragraph.
**Expected:** A complete sentence.
**Why human:** The lost text cannot be recovered from any source in the repo.

### 3. Confirm the unset defaults (CommandRunner 60 s timeout, SQLite 5000 ms busy timeout)

**Test:** Type the repo guard's confirmation phrase so the defaults can be set, or decide to keep them unset.
**Expected:** Defaults are set, or explicitly kept unset.
**Why human:** A repo guard requires a human-typed phrase; agents must not self-issue it or rename around it.

### 4. Accept or reject the Fact Store seam evidence (decision D-09)

**Test:** Decide whether a frozen interface with a compile-time signature check plus the SQLite driver conformance suite on both drivers counts as the Fact Store's "conformance suite" for SC4.
**Expected:** Accepted (a Fact Store level suite arrives with its implementation in Phase 2, no fake store per the Accepted fact-store-interface ADR), or rejected with a follow-up.
**Why human:** Judgment call on the meaning of the seam criterion.

## Gaps Summary

None. The previous blocker is closed in code and tests, reproduced as protected by an independent script, and covered by a green three-OS CI run (push and pull_request events) on the exact source now at HEAD. The phase waits only on the four human decisions above; the three open warnings (WR-02, WR-03, WR-04) are scheduled before Phase 2 builds on the command runner and should be planned there.

## Process note

Plan 01-20 reports one two-line test file edit made with a Python snippet instead of the Edit tool (content verified by diff and passing tests); not a phase gap.

---

_Verified: 2026-10-16_
_Verifier: Claude (gsd-verifier)_
