---
phase: 01-foundations-and-walking-skeleton
verified: 2026-10-16T12:00:00Z
status: gaps_found
score: "4/5 roadmap success criteria verified (SC4 failed, 1 blocker); 13/13 requirement IDs accounted for, 11 satisfied, FND-05 and FND-06 blocked"
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
  - "package.json"
  - "src/command-runner/decide.test.ts"
  - "src/command-runner/decide.ts"
  - "src/command-runner/git-spec.test.ts"
  - "src/command-runner/git-spec.ts"
  - "src/command-runner/hostile-repo.test.ts"
  - "src/source-tree/real.ts"
  - "src/source-tree/source-tree.test.ts"
covered_digest: "v3:sha256:3c0cb59e9779c1022ae41d2cf5b3779bcc1efaffc02b06e470288a6251228416"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: "4/5 roadmap success criteria (2 blockers, old CR-01 promisor lazy fetch and old CR-02 filter driver name with equals sign)"
  gaps_closed:
    - "CR-01 (old): promisor remote plus core.sshCommand started by hasObject/read (plan 01-18)"
    - "CR-02 (old): filter driver named a=b, a=b=c, my.driver or empty ran its clean command (plan 01-19)"
  gaps_remaining:
    - "New CR-01 (01-REVIEW.md): filter driver name that is not valid UTF-8 escapes neutralisation"
  regressions: []
gaps:
  - truth: "SC4 / FND-06 / plan 01-13 and 01-19: a hostile repository runs nothing; gitSpec neutralises EVERY configured filter driver, whatever it is called (no allowlist)"
    status: failed
    reason: "Reproduced by the verifier against createRealRunner() plus createSourceTree() on git 2.54.0. A .gitattributes line 'a.txt filter=a<0xFF>b' and a [filter \"a<0xFF>b\"] clean command in .git/config: snapshot() resolves normally and the repo-controlled clean command RAN (marker file created). Controls: a plain name ('evil') and 'a=b' left no marker. Cause: listFilterNames decodes git config stdout with a non-fatal TextDecoder (git-spec.ts:208), the invalid byte becomes U+FFFD, neutraliseFilters puts that into GIT_CONFIG_KEY_n and Node encodes it as EF BF BD, so the neutralising key names a different driver than the configured one. Node cannot place arbitrary bytes in a child environment, so the env channel cannot express such a name even with exact decoding. The header claims at git-spec.ts:22 and :60 ('every driver is neutralised, whatever it is called') are therefore false. Same failure class as the old CR-02: a name the builder cannot represent is a bypass."
    artifacts:
      - path: "src/command-runner/git-spec.ts"
        issue: "listFilterNames line 208 uses new TextDecoder().decode (non-fatal); no check that a name round-trips; no U+FFFD rejection"
      - path: "src/command-runner/hostile-repo.test.ts"
        issue: "ODD_DRIVERS is ASCII only; no invalid-UTF-8 name case, so the suite stays green while the guarantee is false"
    missing:
      - "Fail closed in listFilterNames: TextDecoder('utf-8', {fatal: true}), reject any name containing U+FFFD, throw GitConfigError('filter_enumeration_failed') naming the problem"
      - "Single shared name predicate used by both listFilterNames and decide's FILTER_ENV_KEY (also closes review WR-01: CR in a name makes decide refuse the builder's own output)"
      - "Hostile-repo test with a \\xff driver name written as Buffers (marker absent, filter_enumeration_failed rejection) plus CR, tab and long-name cases"
      - "Correct the git-spec.ts header claims once the fail-closed rule exists"
human_verification:
  - test: "Review the editorial repairs made at ADR ratification"
    expected: "Restored passages in 3-trust-boundaries.md decision 2, 5-language-modules.md decision 5, 6-fact-model.md decision 2 and PRD.md section 4.7 match the author's intent"
    why_human: "Text was reconstructed from secondary sources; only the author can confirm intent (plan 01-02 human check)"
  - test: "Supply the truncated clause in docs/SDK-PROVIDERS.md (normalized result paragraph)"
    expected: "The sentence ending mid-clause is completed"
    why_human: "The lost text cannot be recovered from any source in the repo"
  - test: "Type the confirmation phrase for the unset defaults: CommandRunner 60 s timeout and SQLite 5000 ms busy timeout"
    expected: "Defaults are set, or explicitly kept unset"
    why_human: "Held by decision pending a human-typed confirmation phrase"
  - test: "Run the three-OS CI matrix on the post-gap-closure source and open (or waive) a pull-request-event run"
    expected: "Static, Test (ubuntu, macos, windows x Node 24.16.0 and 26) and Grammar rebuild all pass; in particular the new promisor and odd-driver hostile groups, and Windows handling of an empty GIT_CONFIG_VALUE_n"
    why_human: "The only real CI run (38841954238 at 2e59fc7) predates plans 01-18 and 01-19, which changed command-runner source. Plan 01-19 SUMMARY itself lists the three-OS run as pending. No pull_request-event run exists either."
  - test: "Accept or reject the Fact Store seam evidence (decision D-09)"
    expected: "A frozen interface with a compile-time signature check plus the SQLite driver conformance suite on both drivers is accepted as the Fact Store's 'conformance suite' for SC4 (no fake store per the Accepted fact-store-interface ADR); a Fact Store level suite arrives with its implementation in Phase 2"
    why_human: "Judgment call on whether a driver-level suite counts as the Fact Store seam's double or conformance suite"
---

# Phase 1: Foundations and Walking Skeleton Verification Report

**Phase Goal:** A developer can build and test the repo on macOS, Linux and Windows and run `gsd-atlas lang test` on a fixture language module end to end, with every module seam frozen behind an interface and a test double.
**Verified:** 2026-10-16
**Status:** gaps_found
**Re-verification:** Yes, after gap-closure plans 01-18 and 01-19 (HEAD 8f5da3b)

## Verdict

Both gaps from the previous report are closed and I re-confirmed each against the real runner, not the summaries. But the closing code still falls to the same class of attack. The new 01-REVIEW.md Critical CR-01 (filter driver name that is not valid UTF-8) is a real bypass: I reproduced it end to end with the production `createSourceTree` over `createRealRunner()` and the default `decide`, and the repo-controlled clean command ran. ROADMAP SC4 and plan 01-13/01-19 truths state that a hostile repository runs nothing and that EVERY driver is neutralised; that is falsified. 01-REVIEW-DISPOSITION.md lists this finding as "open", so it has not been dispositioned away. Status stays gaps_found.

## Prior gaps: closure check

| Prior gap | Status | Evidence |
| --------- | ------ | -------- |
| Old CR-02: driver name containing `=` ran its clean command | CLOSED | `neutraliseFilters` now returns the GIT_CONFIG_COUNT/KEY_n/VALUE_n overlay (git-spec.ts:62-75), `parseFilterNames` slices to the last dot (:84-93). Verifier repro with name `a=b`: marker false. `hostile-repo.test.ts` group for `a=b`, `a=b=c`, `my.driver`, empty name has positive controls that fire and a protected run that passes (not skipped). |
| Old CR-01: promisor remote plus core.sshCommand ran via hasObject/read | CLOSED | `PINNED_ENV` pins `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=none` after the caller env (git-spec.ts:108-113, 147-151); `decide` refuses specs lacking them. Hostile-repo promisor group: two positive controls fire, protected test passes. |

## Gates run by the verifier (HEAD 8f5da3b, Node 26.x, macOS arm64, git 2.54.0)

| Gate | Result |
| ---- | ------ |
| `npm test` | 885 tests, 885 pass, 0 fail, 0 skipped |
| `node --test src/command-runner/hostile-repo.test.ts` | 11 pass, 0 skipped; all positive controls fired |
| `npm run lint` / `npm run typecheck` / `npm run build` | exit 0 each |
| Hostile repro, driver `a=b` | marker absent (protected) |
| Hostile repro, driver `evil` (control) | marker absent (protected) |
| Hostile repro, driver `a\xffb` | MARKER PRESENT, snapshot resolved normally, no diagnostic (BLOCKER) |

The remaining gates from the previous report (schema:check, grammar:budget, grammar:verify, corpus-check, npm pack) cover files untouched by plans 01-18 and 01-19 (only `src/command-runner/*` and `src/source-tree/source-tree.test.ts` changed); I did not re-run them and carry the earlier results forward.

## Success Criteria

| # | Criterion | Status | Evidence |
| - | --------- | ------ | -------- |
| 1 | CI on 3 OSes per PR, package with both bins, boundary violations fail lint | VERIFIED (with caveat) | Unchanged from the previous report. Caveat: the successful ten-job CI run predates 01-18/01-19; see human item 4. |
| 2 | `lang test` end to end; `lang list`; invalid manifest skipped | VERIFIED | Unchanged; full `npm test` still green including `lang-test.e2e.test.ts`. |
| 3 | Reproducible pinned grammar build, ERROR-byte budget in CI | VERIFIED | Unchanged; grammar files untouched by the gap plans. |
| 4 | Each seam has interface plus double or conformance suite; hostile-repo test shows nothing starts except through the CommandRunner | FAILED (1 blocker) | Seams and the single batched `hash-object` hold, and the promisor and `=`-name classes are closed. The guarantee the hostile-repo test exists to prove (a hostile repository runs nothing) is still false for a non-UTF-8 driver name. |
| 5 | Corpus manifest SHAs, ADRs Accepted with amendments and schedule | VERIFIED | Unchanged. |

## Gaps (blockers)

1. **New CR-01 (01-REVIEW.md), non-UTF-8 filter driver name runs its clean command.** `listFilterNames` (git-spec.ts:208) decodes with a lossy decoder, so the neutralising `GIT_CONFIG_KEY_n` names `filter.a�b.clean` while git has `filter.a\xffb.clean`. Reproduced end to end (see gaps in frontmatter). Because `.gitattributes` and `.git/config` are repo-controlled bytes, this is exactly the "hostile repository runs nothing" guarantee (FND-06, SC4). The fix is small and local (fatal decode, reject U+FFFD and any name `decide` would refuse, typed `filter_enumeration_failed`, one shared predicate, a Buffer-based hostile test). Failing closed is the correct design here because the env channel cannot carry arbitrary bytes, so the only safe response is to refuse the snapshot.

Review dispositions weighed (01-REVIEW-DISPOSITION.md, all "open"):

- WR-01 (CR in a driver name: `decide` refuses what `neutraliseFilters` emits): fail-closed, so not a bypass, but it is the same code path as the blocker and should be fixed with it (one shared name predicate).
- WR-02 (option denylist bypassable: `cat-file --textc`, `hash-object -wt`, `rev-list --output`/`--alternate-refs`): latent, no current call site puts untrusted text in option position. Not elevated; schedule before Phase 2 builds on `decide`.
- WR-03 (pinned env checked by presence only), IN-01 to IN-03: warnings and info, no Phase 1 must-have falsified. IN-01 matters to the blocker: the hostile fixtures are ASCII only, which is why it slipped through.

## Observable Truths from PLAN must-haves

| Truth | Status | Evidence |
| ----- | ------ | -------- |
| gitSpec prepends fsmonitor/hooksPath/quotepath overrides and pins env (01-13, 01-18) | VERIFIED | git-spec.ts:139-161; tests pass |
| gitSpec neutralises EVERY filter driver by name, no allowlist (01-13, 01-19) | FAILED | Holds for ASCII, `=`, `.`, empty names; fails for invalid-UTF-8 names (blocker above) |
| decide refuses any git spec missing the overrides or pinned env; validates the GIT_CONFIG channel (01-18, 01-19) | VERIFIED | decide tests pass (885 green); refusal behaviour holds for the cases it covers (WR-01 and WR-03 are edge shapes) |
| Listing fails closed when git ignores the env channel (01-19) | VERIFIED | Random probe, `git_env_config_unsupported` and `filter_enumeration_failed`, git-spec.ts:190-216 (does not cover undecodable names) |
| One batched `hash-object --stdin-paths` per snapshot (01-13) | VERIFIED | `still yields exactly one hash-object start for a repository with 150 files` passes |
| Remaining plan truths (01-01 to 01-12, 01-14 to 01-17) | VERIFIED | Carried forward from the previous report; `npm test` 885/885 |

## Requirements Coverage

All 13 requirement IDs declared for Phase 1 appear in REQUIREMENTS.md and the ROADMAP Phase 1 list; none are orphaned. (FND-12 appears in plan text but is Phase 2 in REQUIREMENTS.md.) The REQUIREMENTS.md checkboxes still read Pending and are for the orchestrator to update once the gap closes.

| Requirement | Status | Evidence |
| ----------- | ------ | -------- |
| FND-01 | SATISFIED (CI re-run needed, human item 4) | ci.yml; run 38841954238 predates 01-18/19 |
| FND-02, FND-03, FND-04, FND-07, FND-08, FND-09, FND-10, FND-11 | SATISFIED | See previous report; tests green |
| LNG-01, LNG-06 | SATISFIED | Registry and budget tests green |
| FND-05 (each seam has interface plus double or conformance) | BLOCKED | Source Tree seam is not hostile-safe (non-UTF-8 driver name); Fact Store double is a human decision (D-09) |
| FND-06 (every child via CommandRunner, lint, streaming, batch; hostile repo runs nothing) | BLOCKED | Lint, streaming and batch hold; hostile-repo guarantee fails for non-UTF-8 driver names |

## Anti-Patterns

No TODO/FIXME/XXX/TBD in the files changed by plans 01-18 and 01-19. The only finding is the false documentation claim at git-spec.ts:22 and :60 (blocker above).

## Process note

Both gap plans report editing files with a Bash Python script after a worktree guard fired (01-18: three edits in the main checkout; 01-19: git-spec.ts inside the worktree). I did not treat this as a phase gap; the resulting files are consistent and tested, but the orchestrator should be aware.

## Gaps Summary

Re-run `/gsd-plan-phase --gaps` for one small plan covering the new CR-01 together with WR-01 (shared name predicate) and the Buffer-based hostile fixture, and run the three-OS CI on the result so human item 4 is satisfied in the same pass. Do not weaken the existing hostile-repo test, and do not accept a disposition that leaves CR-01 "open" as passing: the guarantee is stated as unconditional.

---

_Verified: 2026-10-16_
_Verifier: Claude (gsd-verifier)_
