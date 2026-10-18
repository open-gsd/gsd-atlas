---
phase: 03-typescript-module-and-mvp-eval
plan: 08
subsystem: adr-contracts
tags: [adr, amendments, mcp-contract, fact-store, command-runner, trust-boundaries]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-DECISIONS.md (OQ1 to OQ9 answers, Gate OQ2 Approved) from plan 03-01"
provides:
  - "Eight dated Phase 3 amendments (2026-10-18) to ADRs 3, 4, 5, 6, 7, 12, 13 and 14"
  - "Eight README amendment-log lines and nine new AMENDED test specs in scripts/adr.test.ts"
affects: [03-12, 03-13, 03-15, 03-17, 03-18, 03-19, 03-20, 03-22, 03-24, 03-25, 03-26, 03-27, 03-28, 03-29]
actuals:
  tokens: 9955
  tasks: 3
  commits: 6
commits: 6
plan_head_before: 3d4b0fa753b7565e137a35329e0a4d2ef6accd71
plan_head_after: 7321d1660daab08c1ff9b30aa22fc8e01c8899eb
tech-stack:
  added: []
  patterns:
    - "Append-only dated amendment per ADR, asserted by scripts/adr.test.ts (heading, Sources line, keywords, preserved sentences, README log line)"
key-files:
  created: []
  modified:
    - docs/adr/13-mcp-contract.md
    - docs/adr/6-fact-model.md
    - docs/adr/7-fact-store-interface.md
    - docs/adr/12-query-and-policy.md
    - docs/adr/14-value-dashboard.md
    - docs/adr/4-command-runner.md
    - docs/adr/3-trust-boundaries.md
    - docs/adr/5-language-modules.md
    - docs/adr/README.md
    - scripts/adr.test.ts
key-decisions:
  - "OQ1 (confirmed default): relations ride an optional PreciseResolver.relations method into a resolved_relations table, read by Reader.relations; written into the fact-model and fact-store-interface amendments"
  - "OQ2 (Gate Approved): memory watch is an in-worker sampler thread with --max-old-space-size as backstop; written into the command-runner amendment as a deliberate deviation from D-21"
  - "OQ3 (confirmed default): a file that is the emit output of an included source gets no facts; tracked hand-written files under outDir keep theirs"
  - "OQ5 (confirmed default): precise.command is a gate plus exit-status recording only, no importer"
  - "OQ6 (confirmed default): skills ship as package files, init does not install them"
requirements-completed: [TSM-01, TSM-03, TSM-04, TSM-05, TSM-07, QRY-07, SKL-02, SEC-02]
coverage:
  - id: D1
    description: "mcp-contract amendment: seventh tool code_explain, answer_id, memory_budget/compiler_fallback/needs_approval, kind adr, citations/emittedAs, ImpactVia hops"
    requirement: "QRY-07"
    verification:
      - kind: unit
        ref: "scripts/adr.test.ts#amendments are appended and dated"
        status: pass
    human_judgment: false
  - id: D2
    description: "fact-model, fact-store-interface, query-and-policy and value-dashboard amendments (cites_adr, emitted_as, relations, negative marker, Resolver scope, findIn, provenance, ProjectContext, FactStore.resolve, schema bump, explain request kind, ratings table)"
    requirement: "TSM-04"
    verification:
      - kind: unit
        ref: "scripts/adr.test.ts#amendments are appended and dated"
        status: pass
      - kind: unit
        ref: "scripts/adr.test.ts#original decision text is preserved"
        status: pass
    human_judgment: false
  - id: D3
    description: "command-runner, trust-boundaries and language-modules amendments (typescript-resolver exact shape, sha256 approvals, MCP origin and needs_approval, compiler trust, manifest version 2, adrDirs)"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "scripts/adr.test.ts#amendments are appended and dated"
        status: pass
      - kind: unit
        ref: "scripts/adr.test.ts#the amendment log in the README lists every amendment"
        status: pass
    human_judgment: false
  - id: D4
    description: "The amendments state the right contracts for the implementing plans 03-12 to 03-33 (semantic correctness is not machine-checked; the test asserts structure and keywords)"
    verification: []
    human_judgment: true
    rationale: "The test checks headings, sources, length, keywords, preserved text and README lines; whether each clause is the right contract is a reviewer judgment."
duration: 35min
completed: 2026-10-18
status: complete
---

# Phase 3 Plan 8: Phase 3 ADR contract amendments Summary

**Eight append-only, dated Phase 3 amendments (mcp-contract, fact-model, fact-store-interface, query-and-policy, value-dashboard, command-runner, trust-boundaries, language-modules) are on record before any implementing code, each enforced by scripts/adr.test.ts.**

## Performance

- **Duration:** about 35 min (start time was not captured; approximate)
- **Completed:** 2026-10-18T04:34Z
- **Tasks:** 3 (1 tracer, 2 auto), each as a RED test commit then a GREEN docs commit
- **Files modified:** 10 (8 ADRs, the ADR README, scripts/adr.test.ts)

## Accomplishments

- mcp-contract: the default profile becomes seven tools (`code_explain` takes a `handle` and optional `repo`, `cwd`), additive `answer_id`, three new degraded codes (`memory_budget`, `compiler_fallback`, `needs_approval`, eleven to fourteen), `kind: adr` on `code_find` and `code_refs`, `citations` and `emittedAs` in `code_context`, and `extends`/`implements`/`overrides` as `ImpactVia` hops. It states which Phase 2 sentences it supersedes ("six tools", "`explain` arrives in Phase 3").
- fact-model and fact-store-interface: `cites_adr` as a local fact resolved at read time (`EXTRACTED`, `INFERRED` per file when several share a number, `unresolved` when none), `emitted_as` keyed by resolution context, relations per OQ1, the negative resolved-edge marker, compiler identity in the context; Resolver scope, `PreciseResolver.resolve` fourth argument, `SymbolLookup.findIn`, `Reader.relations/provenance/emittedAs/citations`, `FactStore.resolve`, `ProjectContext`, notices and typed failures, `SourceTree.listDirectory`, schema 1 to 2 and the `not_indexed` consequence for Phase 2 dev stores.
- query-and-policy and value-dashboard: `code_explain` is a read-only Query request kind with `answer_id` stamped by the Host; a closed-vocabulary ratings table with no free text and consumption deferred to Phase 8.
- command-runner, trust-boundaries and language-modules: the `typescript-resolver` exact-shape built-in, in-worker sampler (OQ2), per-spec stdout cap, `sha256` exact-argv approvals; `gsd-atlas allow`, MCP origin and `--allow-build`, the one-sentence "repository files can never enable a command, diagnostics or auto-submit", OQ5/OQ6, compiler trust with its residual risk; TypeScript project model and adapter ids, manifest `schemaVersion` 2 with `project.adrDirs`, `.gsd-atlas/config.json`.

## OQ answers used (T-03-83)

OQ1 relation storage (default: optional `relations()` plus `resolved_relations`), OQ2 memory watch (default, Gate OQ2 line `Approved`), OQ3 outDir meaning (default), OQ5 `precise.command` scope (default, gate only), OQ6 skill distribution (default). All read from 03-DECISIONS.md (Status: Confirmed 2026-10-18); none was overturned.

## Task Commits

1. **Task 1 (tracer): mcp-contract** - RED `3e89324` (test), GREEN `4a4b677` (docs)
2. **Task 2: fact-model, fact-store-interface, query-and-policy, value-dashboard** - RED `0bb0ae5` (test), GREEN `3c89023` (docs)
3. **Task 3: command-runner, trust-boundaries, language-modules** - RED `1c46c6c` (test), GREEN `7321d16` (docs)

**Tracer gate:** the tracer `<verify>` (`node --test scripts/adr.test.ts`) carries only an automated check, so it was re-run after the commit (41 of 41 pass) and expansion continued.

**RED evidence (all three):** `node --test --test-reporter=tap scripts/adr.test.ts` exit 1, target test `amendments are appended and dated`, 40 pass and 1 fail, classifier verdict `RED_EVIDENCE_OK` (`target_test_failed`). Semantic assessment: the target test ran and failed on the planned assertion (a missing `## Amendment` heading for the new title), not on a syntax, load or unrelated fault. The suite reports only the first missing amendment per run (its loop asserts in sequence), so the cases for the other amendments in a task went red together behind one reported failure and were each confirmed green only after their text existed.

## Verification

- `node --test scripts/adr.test.ts`: 41 tests, 41 pass (the amendment cases are loops inside `amendments are appended and dated`, `original decision text is preserved` and `the amendment log in the README lists every amendment`; the plan's "eight new amendment cases" are eight new spec entries inside those tests).
- `npm run lint` and `npm run typecheck`: clean.
- `git diff --numstat 3d4b0fa..HEAD`: zero deleted lines in every ADR file, the README and the test.
- Acceptance greps: one `## Amendment 2026-10-18: ` heading in each of the eight ADRs; eight `- Amendment 2026-10-18:` README lines; `typescript-resolver` and `sha256` present in the command-runner ADR; `unresolved` in the fact-model ADR.

## Deviations from Plan

**1. [Process] Separate RED and GREEN commits per task.** The plan names one commit per task (`docs(03-08): ...`). With `workflow.tdd_mode` true the tdd reference requires a `test(...)` RED commit before the GREEN commit, so each task has two commits (six total). The GREEN commit is the one the plan's `git diff HEAD^..HEAD --numstat` check applies to, and it shows additions only. Impact: none on content.

**2. [Rule 3 - Blocking, minor] Test keywords need exact case.** Three first drafts of the prose lacked a case-sensitive keyword the test asserts (`seventh`, `negative`, `residual risk`, and `repository files can never` was reworded to a lowercase sentence). The prose was reworded, not the keywords weakened. Commits: part of the GREEN commits.

**Total deviations:** 1 process, 1 minor fix. **Impact:** none on scope.

## Issues Encountered and notes for dependent plans

- **Plan 03-26 expects an extra `answer_id` input.** Its truths say `code_explain` takes a fact id "or an answer id" with "exactly one of `handle` and `answer_id`". This plan's table (and therefore the mcp-contract amendment) specifies only `handle` plus optional `repo`, `cwd`, and states that any further input, such as explaining a recorded answer by `answer_id`, is additive and needs its own dated amendment first. Plan 03-26 (or the planner) should either add that amendment or drop the answer-id form. This is the one place where the written contract is narrower than a downstream plan.
- The `code_explain` error codes `invalid_handle` and `stale_handle` and the `cit/` handle kind come from plans 03-26 and 03-28, not from this plan's table; they are stated in the amendment as the contract.
- The amendment says `precise.adapter` names the built-in adapter id `typescript` and the manifest moves to version 2 in plan 03-28 as the plan table says; the other built-in module (the one 03-28 also moves) is not named in the ADR.
- The mcp-contract amendment adds a "precise-edge labelling" point (`edge` field with `calls`, `references`, `extends`, `implements`, `overrides`) taken from plan 03-25's truths; it is not in this plan's table but keeps the ADR consistent with that plan.
- Windows/Linux: this plan is documentation and a Node test; it ran on macOS only, and the suite has no OS-specific code.

## Known Stubs

None.

## Threat Flags

None. No code, endpoint or file-access surface was added; the trust-boundaries amendment restates that no repository file can enable a command (T-03-82 mitigation), and the preserved-sentence and zero-deleted-lines checks cover T-03-81.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 03-12, 03-13, 03-15, 03-17, 03-18, 03-19 and 03-20 onward can cite the ratified contracts. Resolve the `answer_id` input question above before plan 03-26 runs.

## Self-Check: PASSED

- All ten modified files exist; `03-08-SUMMARY.md` written.
- Commits `3e89324`, `4a4b677`, `0bb0ae5`, `3c89023`, `1c46c6c`, `7321d16` are ancestors of HEAD.
- `git rev-list --count 3d4b0fa..HEAD` is 6, matching `commits: 6`.

---
*Phase: 03-typescript-module-and-mvp-eval*
*Completed: 2026-10-18*
