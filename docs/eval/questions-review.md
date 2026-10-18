# Question set review (plan 03-09)

Drafted without running atlas: yes

Attestation. The 75 scored questions and the 5 pilot questions were drafted from the gsd-core source and ADRs. The candidates come from a compiler-derived census of the prepared checkout (the oracle's TypeScript program), ordered by a seeded shuffle; the texts were written by reading files and `git grep` on the checkout; the expected answers come from the oracle. No atlas command, no atlas MCP tool and no code-intelligence server was run or read while choosing or writing a question.

## Corpus and preparation

- Corpus: `gsd-core` at `10ac3a7a947903ba50f538a907af036744d759d5`
- Prepared checkout: `npm ci --ignore-scripts`: yes
- Compiler used for the keys: TypeScript 6.0.3
- package-lock.json sha256 (CRLF read as LF): `dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb`
- Oracle version: `03-14.1`
- Candidate order seed: 20261017 (`eval.bootstrapSeed`)
- Pilot categories (picked by the seed): references, adr, impact, definition, abstain

## Summary

| Category | Scored | Share | Pilot |
| --- | --- | --- | --- |
| callers | 17 | 23% | 0 |
| references | 8 | 11% | 1 |
| heritage | 8 | 11% | 0 |
| emit | 10 | 13% | 0 |
| adr | 10 | 13% | 1 |
| impact | 6 | 8% | 1 |
| definition | 7 | 9% | 1 |
| abstain | 9 | 12% | 1 |
| total | 75 | 100% | 5 |

## How the questions were chosen

Candidates of each category were ordered by a seeded shuffle of the census (sorted by file and name first). One pass over that order looked at a candidate only while a slot was open for it, and passed over a candidate only for one of these rules:

- `used-by-pilot`: its subject belongs to a pilot question.
- `duplicate-symbol`: its subject is already used by an earlier question or by a free-alternatives scan question.
- `ambiguous-name`: the name is declared more than once in the program, or the oracle refuses it as ambiguous (an abstain probe that matches something is the same case).
- `unexplained`: the key has a textual mention the compiler result neither includes nor classifies, or an ADR citation without an ADR file.
- `empty` and `too-large`: a non-abstain expected answer is empty, or larger than 30 entries at the key's granularity.

Candidates after the last one needed stay `unused`: they were never looked at, and a larger N continues the same order.

## Scored questions

### q-001 (callers)

> Which files call `isManagedHookCommand`, the function exported from `src/shell-command-projection.cts`? Include test files, plain JavaScript files and calls made through a renamed import. A different function that happens to share the name does not count. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 4 at granularity file (14 key items)
- First expected: `bin/install.js:5409 sectionHasStaleCommand`, `src/installer-migrations/002-codex-legacy-hooks-json.cts:67 isManagedCodexHookCommand`, `tests/portable-node-runner.install.test.cjs:522 <module>`

### q-002 (callers)

> List every file that contains a call to `unresolvableProbeVerdict` from `src/gate-phase-context.cts`, counting test files and plain JavaScript files as well as TypeScript sources. List each file once; a same-named function declared elsewhere is not the same function. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (7 key items)
- First expected: `src/gate-verify-command-paths.cts:48 evaluateVerifyCommandPaths`, `src/gate-verify-failure-directions.cts:26 evaluateVerifyFailureDirections`

### q-003 (callers)

> `declareGateExit` is exported from `src/gate-exit.cts`. Which files use it by calling it? Test files and plain JavaScript files count, a call under another local name counts, and a different function with the same name does not. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 4 at granularity file (10 key items)
- First expected: `src/check-command-router.cts:66 emitGateResult`, `src/phase.cts:5111 cmdPhaseUatPassed`, `src/verify.cts:1271 emitVerbVerdict`

### q-004 (callers)

> Which files call `toDiskStatus`, the function exported from `src/phase-status.cts`? Include test files, plain JavaScript files and calls made through a renamed import. A different function that happens to share the name does not count. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (15 key items)
- First expected: `src/init.cts:3101 cmdInitManager`, `src/roadmap.cts:601 collectAnalyzePhases`, `tests/phase-status.test.cjs:78 <module>`

### q-005 (callers)

> List every file that contains a call to `computeCalibration` from `src/phase-estimation.cts`, counting test files and plain JavaScript files as well as TypeScript sources. List each file once; a same-named function declared elsewhere is not the same function. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (20 key items)
- First expected: `src/estimate-cli.cts:169 cmdEstimateCheck`, `tests/estimate-calibrate.test.cjs:233 simulate`, `tests/phase-estimation.test.cjs:147 <module>`

### q-006 (callers)

> `readBaseRefFromSettings` is exported from `src/worktree-base-ref.cts`. Which files use it by calling it? Test files and plain JavaScript files count, a call under another local name counts, and a different function with the same name does not. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (11 key items)
- First expected: `bin/install.js:13650 install`, `src/worktree-base-ref.cts:276 parseBaseRef`, `tests/worktree-base-ref.test.cjs:69 <module>`

### q-007 (callers)

> Which files call `changedFilesSince`, the function exported from `src/git-base-branch.cts`? Include test files, plain JavaScript files and calls made through a renamed import. A different function that happens to share the name does not count. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (6 key items)
- First expected: `src/refactor-trigger-command-router.cts:731 handleEvaluate`, `tests/refactor-trigger-cli.test.cjs:211 <module>`

### q-008 (callers)

> List every file that contains a call to `getGlobalConfigDir` from `src/runtime-homes.cts`, counting test files and plain JavaScript files as well as TypeScript sources. List each file once; a same-named function declared elsewhere is not the same function. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 20 at granularity file (144 key items)
- First expected: `bin/install.js:1175 getGlobalDir`, `hooks/gsd-cursor-subagent-start.js:178 resolveIsolationEvidence`, `src/agent-install-check.cts:157 getAgentsDir`

### q-009 (callers)

> `setJsoncValue` is exported from `src/jsonc-edit.cts`. Which files use it by calling it? Test files and plain JavaScript files count, a call under another local name counts, and a different function with the same name does not. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (16 key items)
- First expected: `bin/install.js:9565 writeJsoncConfig`, `src/installer-migrations.cts:788 renderRewrittenJson`, `tests/jsonc-edit.test.cjs:36 <module>`

### q-010 (callers)

> Which files call `stripFencedCode`, the function exported from `src/markdown-sectionizer.cts`? Include test files, plain JavaScript files and calls made through a renamed import. A different function that happens to share the name does not count. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 12 at granularity file (34 key items)
- First expected: `src/api-coverage.cts:447 detectApiIntegration`, `src/assumption-delta.cts:183 detectAssumptionDelta`, `src/decision-coverage-support.cts:139 stripCommentsAndFences`

### q-011 (callers)

> List every file that contains a call to `parsePlanningDoc` from `src/planning-document.cts`, counting test files and plain JavaScript files as well as TypeScript sources. List each file once; a same-named function declared elsewhere is not the same function. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 9 at granularity file (15 key items)
- First expected: `src/phase.cts:2441 updateRoadmapAfterPhaseRemoval`, `src/planning-document.cts:845 replaceProse`, `src/roadmap-upgrade.cts:2226 substituteCrossRefs`

### q-012 (references)

> Which files refer to `PHASE_COMMAND_ALIASES`, exported from `src/command-aliases.cts`? Count every use except its declaration (imports, calls, reads), including uses inside `src/command-aliases.cts`, and include test files and plain JavaScript files. List each file once; a different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `src/command-aliases.cts:980 <module>`

### q-013 (references)

> Where is `getFieldClassification` from `src/state-transition.cts` used? List each file that contains a use of it other than its declaration (an import, a call, a read or a type reference), including `src/state-transition.cts` if it uses the symbol itself. A different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 4 at granularity file (33 key items)
- First expected: `src/state-transition.cts:1092 applyStatePreservation`, `src/state.cts:3837 syncStateFrontmatter`, `tests/state-transition.test.cjs:21 <module>`

### q-014 (references)

> Which files refer to `resolveExecutableBinary`, exported from `src/shell-command-projection.cts`? Count every use except its declaration (imports, calls, reads), including uses inside `src/shell-command-projection.cts`, and include test files and plain JavaScript files. List each file once; a different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 5 at granularity file (58 key items)
- First expected: `gsd-core/bin/gsd-tools.cjs:4714 resolveSpawnBinary`, `src/fallow-runner.cts:21 <module>`, `src/shell-command-projection.cts:928 projectSpawnInvocation`

### q-015 (references)

> Where is `CreateHookBusOptions` from `src/hook-bus.cts` used? List each file that contains a use of it other than its declaration (an import, a call, a read or a type reference), including `src/hook-bus.cts` if it uses the symbol itself. A different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `src/hook-bus.cts:47 createHookBus`

### q-016 (references)

> Which files refer to `RedEvidenceResult`, exported from `src/tdd-red-evidence.cts`? Count every use except its declaration (imports, calls, reads), including uses inside `src/tdd-red-evidence.cts`, and include test files and plain JavaScript files. List each file once; a different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (2 key items)
- First expected: `src/tdd-red-evidence.cts:93 classifyRedEvidence`

### q-017 (heritage)

> Which interfaces or classes extend or implement `RuntimeConfigIntent`, declared in `src/runtime-config-adapter-registry.cts`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 1 at granularity file+symbol (1 key items)
- First expected: `src/runtime-config-adapter-registry.cts:79 InstallPlan`

### q-018 (heritage)

> Which interfaces or classes extend or implement `ReviewerLaneCommon`, declared in `src/review-lane-descriptor.cts`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 2 at granularity file+symbol (2 key items)
- First expected: `src/review-lane-descriptor.cts:263 SpawnLane`, `src/review-lane-descriptor.cts:268 HttpLane`

### q-019 (heritage)

> Which interfaces or classes extend or implement `ResolveKimiOpts`, declared in `src/runtime-homes.cts`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 1 at granularity file+symbol (1 key items)
- First expected: `src/runtime-homes.cts:92 ResolveKimiHooksTomlOpts`

### q-020 (heritage)

> Which interfaces or classes extend or implement `ResolvedFailingDirection`, declared in `src/verify-command-grounding.cts`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 1 at granularity file+symbol (1 key items)
- First expected: `src/verify-command-grounding.cts:230 FailingDirectionEntry`

### q-021 (heritage)

> Which interfaces or classes extend or implement `HostIntegrationInterface`, declared in `src/embedding-adapter.cts`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 1 at granularity file+symbol (1 key items)
- First expected: `src/adapter-imperative.cts:35 ImperativeAdapter`

### q-022 (emit)

> Which files in this repository `require` the compiled CommonJS module that the build produces from `src/runtime-artifact-layout.cts`? Include test files, plain JavaScript files and `.cts` sources that call `require`; list each file once. Give your answer in the required JSON form.

- Key kind: emit-consumers
- Granularity: file; equality: exact-set
- Expected answers: 24 at granularity file (36 key items)
- First expected: `bin/install.js:803`, `gsd-core/bin/verify-reapply-patches.cjs:403`, `src/capability-writer.cts:366`

### q-023 (emit)

> The TypeScript build compiles `src/capability-activation.cts` to a CommonJS file. At which path, relative to the repository root, does the build write the compiled file? Give your answer in the required JSON form.

- Key kind: emit
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `gsd-core/bin/lib/capability-activation.cjs`

### q-024 (emit)

> The build compiles `src/cjs-command-router-adapter.cts` to a `.cjs` module. Which files load that module with `require`, whether by its compiled path or by a sibling `.cjs` specifier? Test files and plain JavaScript files count; list each file once. Give your answer in the required JSON form.

- Key kind: emit-consumers
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (3 key items)
- First expected: `tests/cjs-command-router-adapter.test.cjs:6`

### q-025 (emit)

> Where does the build put the compiled CommonJS output of `src/workstream.cts`? Give the path relative to the repository root. Give your answer in the required JSON form.

- Key kind: emit
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `gsd-core/bin/lib/workstream.cjs`

### q-026 (emit)

> The TypeScript build compiles `src/estimate-cli.cts` to a CommonJS file. At which path, relative to the repository root, does the build write the compiled file? Give your answer in the required JSON form.

- Key kind: emit
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `gsd-core/bin/lib/estimate-cli.cjs`

### q-027 (emit)

> Which files in this repository `require` the compiled CommonJS module that the build produces from `src/installer-migrations/011-opencode-mcp-no-prompts.cts`? Include test files, plain JavaScript files and `.cts` sources that call `require`; list each file once. Give your answer in the required JSON form.

- Key kind: emit-consumers
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `tests/installer-migration-opencode-mcp-no-prompts.test.cjs:20`

### q-028 (emit)

> The build compiles `src/install-fs-adapter.cts` to a `.cjs` module. Which files load that module with `require`, whether by its compiled path or by a sibling `.cjs` specifier? Test files and plain JavaScript files count; list each file once. Give your answer in the required JSON form.

- Key kind: emit-consumers
- Granularity: file; equality: exact-set
- Expected answers: 4 at granularity file (4 key items)
- First expected: `tests/executed-plan.test.cjs:45`, `tests/install-fs-adapter-seam.test.cjs:39`, `tests/runtime-artifact-layout.test.cjs:29`

### q-029 (adr)

> Which ADR files do the comments on `FINGERPRINT_VERSION` in `src/verification.cts` cite, counting comments inside its body? Give the path of each ADR file under `docs/adr`. Give your answer in the required JSON form.

- Key kind: adr-of
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `docs/adr/5057-one-owner-per-workflow-verdict.md`

### q-030 (adr)

> Which ADR files do the comments on `StateTransactionKind` in `src/state-transition.cts` cite, counting comments inside its body? Give the path of each ADR file under `docs/adr`. Give your answer in the required JSON form.

- Key kind: adr-of
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (2 key items)
- First expected: `docs/adr/3408-state-write-path-preservation.md`, `docs/adr/3473-enforcement-by-construction.md`

### q-031 (adr)

> Which ADR files do the comments on `classifyDriftSeverity` in `src/plan-drift-guard.cts` cite, counting comments inside its body? Give the path of each ADR file under `docs/adr`. Give your answer in the required JSON form.

- Key kind: adr-of
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `docs/adr/22-plan-drift-guard.md`

### q-032 (adr)

> Which files cite ADR-3524 in a code comment, however the number is written (`ADR-3524`, `ADR 3524` or `ADR #3524`)? Include tests, scripts and JavaScript configuration files; Markdown documents do not count. List each file once. Give your answer in the required JSON form.

- Key kind: adr-citers
- Granularity: file; equality: exact-set
- Expected answers: 5 at granularity file (10 key items)
- First expected: `src/phase-lifecycle.cts:8`, `src/phase.cts:8`, `src/validate.cts:24`

### q-033 (adr)

> Which files cite ADR-2619 in a code comment, however the number is written (`ADR-2619`, `ADR 2619` or `ADR #2619`)? Include tests, scripts and JavaScript configuration files; Markdown documents do not count. List each file once. Give your answer in the required JSON form.

- Key kind: adr-citers
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `src/observability/logger.cts:196`

### q-034 (adr)

> Which files cite ADR-1372 in a code comment, however the number is written (`ADR-1372`, `ADR 1372` or `ADR #1372`)? Include tests, scripts and JavaScript configuration files; Markdown documents do not count. List each file once. Give your answer in the required JSON form.

- Key kind: adr-citers
- Granularity: file; equality: exact-set
- Expected answers: 14 at granularity file (31 key items)
- First expected: `eslint.config.mjs:403`, `scripts/lint-phase-arg-assignment.cjs:57`, `src/adr-parser.cts:289`

### q-035 (adr)

> Which files cite ADR-894 in a code comment, however the number is written (`ADR-894`, `ADR 894` or `ADR #894`)? Include tests, scripts and JavaScript configuration files; Markdown documents do not count. List each file once. Give your answer in the required JSON form.

- Key kind: adr-citers
- Granularity: file; equality: exact-set
- Expected answers: 9 at granularity file (13 key items)
- First expected: `gsd-core/bin/lib/capability-registry.cjs:6`, `gsd-core/bin/lib/capability-validator.cjs:1799`, `gsd-core/bin/lib/loop-host-contract.cjs:6`

### q-036 (impact)

> List the files affected if the signature of `renderProgressBar` in `src/phase-lifecycle.cts` changed, to depth two: files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly. Include tests and plain JavaScript files; leave out `src/phase-lifecycle.cts` itself. Give your answer in the required JSON form.

- Key kind: impact
- Granularity: file; equality: exact-set
- Expected answers: 17 at granularity file (17 key items)
- First expected: `src/commands.cts`, `src/gsd2-import.cts`, `src/milestone.cts`

### q-037 (impact)

> List the files affected if the signature of `buildLocalShellHookCommand` in `src/shell-command-projection.cts` changed, to depth two: files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly. Include tests and plain JavaScript files; leave out `src/shell-command-projection.cts` itself. Give your answer in the required JSON form.

- Key kind: impact
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (2 key items)
- First expected: `bin/install.js`, `tests/shell-command-projection-dispatch.test.cjs`

### q-038 (impact)

> List the files affected if the signature of `readCalibrationSamples` in `src/estimate-cli.cts` changed, to depth two: files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly. Include tests and plain JavaScript files; leave out `src/estimate-cli.cts` itself. Give your answer in the required JSON form.

- Key kind: impact
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (3 key items)
- First expected: `gsd-core/bin/gsd-tools.cjs`, `tests/estimate-calibrate.test.cjs`, `tests/phase-estimation.test.cjs`

### q-039 (impact)

> List the files affected if the signature of `listResources` in `src/mcp-catalog.cts` changed, to depth two: files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly. Include tests and plain JavaScript files; leave out `src/mcp-catalog.cts` itself. Give your answer in the required JSON form.

- Key kind: impact
- Granularity: file; equality: exact-set
- Expected answers: 8 at granularity file (8 key items)
- First expected: `bin/gsd-mcp-server.js`, `src/mcp-server.cts`, `tests/gsd-mcp-server.test.cjs`

### q-040 (definition)

> Where is `assertWithinRoot` declared in the TypeScript (`.cts`) sources under `src/`? Give the file and the line of its declaration. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/security.cts:255 assertWithinRoot`

### q-041 (definition)

> Give the file and line where `getGlobalSkillDir` is declared, among the TypeScript (`.cts`) sources under `src/`. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/runtime-homes.cts:691 getGlobalSkillDir`

### q-042 (definition)

> Where is `OPENCODE_V1_FREEZE_DATE` declared in the TypeScript (`.cts`) sources under `src/`? Give the file and the line of its declaration. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/opencode-version.cts:616 OPENCODE_V1_FREEZE_DATE`

### q-043 (definition)

> Give the file and line where `asRawTokens` is declared, among the TypeScript (`.cts`) sources under `src/`. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/phase-estimation.cts:89 asRawTokens`

### q-044 (definition)

> Where is `SectionSelection` declared in the TypeScript (`.cts`) sources under `src/`? Give the file and the line of its declaration. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/section-manifest.cts:217 SectionSelection`

### q-045 (abstain)

> Where is the function `lookupUiSpecInDir` defined, and which files call it? If this repository has no such function, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: the name `lookupUiSpecInDir`, which no tracked file mentions

### q-046 (abstain)

> Which file defines `lookupPristineInGit`, and which files call that function? If no function with that name exists in this repository, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: the name `lookupPristineInGit`, which no tracked file mentions

### q-047 (abstain)

> Which file defines the function `makeHookBus` that builds the hook bus, and which files call it? If there is no such function, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: the name `makeHookBus`, which no tracked file mentions

### q-048 (abstain)

> Which files call `resolveProgressTable`, exported from `src/progress-table.cts`? If that module or that function does not exist, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: the name `resolveProgressTable`, which no tracked file mentions

### q-049 (abstain)

> Which file in `docs/adr` records ADR-123? If no ADR file carries that number, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: ADR number 123, which no ADR file carries

### q-050 (abstain)

> Where in `docs/adr` is ADR-2481 written down? Name the file, or say so if there is no such ADR file. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: ADR number 2481, which no ADR file carries

### q-051 (callers)

> Which files call `generationForMajor`, the function exported from `src/opencode-version.cts`? Include test files, plain JavaScript files and calls made through a renamed import. A different function that happens to share the name does not count. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (5 key items)
- First expected: `src/opencode-version.cts:293 resolveOpencodeGeneration`, `tests/opencode-version.test.cjs:30 <module>`

### q-052 (callers)

> List every file that contains a call to `openStateTransaction` from `src/state-transition.cts`, counting test files and plain JavaScript files as well as TypeScript sources. List each file once; a same-named function declared elsewhere is not the same function. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (83 key items)
- First expected: `src/state.cts:4400 applyPostSyncPreservation`, `tests/state-transition.test.cjs:2547 <module>`, `tests/state.test.cjs:21899 narrowStatus`

### q-053 (callers)

> `detectAssumptionDelta` is exported from `src/assumption-delta.cts`. Which files use it by calling it? Test files and plain JavaScript files count, a call under another local name counts, and a different function with the same name does not. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (5 key items)
- First expected: `gsd-core/bin/gsd-tools.cjs:3087 routeAssumptionDelta`, `src/assumption-delta.cts:267 <module>`, `tests/assumption-delta.test.cjs:376 <module>`

### q-054 (callers)

> Which files call `escapeCell`, the function exported from `src/markdown-table.cts`? Include test files, plain JavaScript files and calls made through a renamed import. A different function that happens to share the name does not count. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (11 key items)
- First expected: `src/markdown-table.cts:616 insertTableRow`, `src/phase.cts:2402 updateRoadmapAfterPhaseRemoval`, `src/roadmap.cts:1342 cmdRoadmapUpdatePlanProgress`

### q-055 (callers)

> List every file that contains a call to `isPathConfined` from `src/external-descriptor-trust.cts`, counting test files and plain JavaScript files as well as TypeScript sources. List each file once; a same-named function declared elsewhere is not the same function. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 5 at granularity file (21 key items)
- First expected: `src/external-descriptor-trust.cts:106 check`, `src/install-engine.cts:1604 installOpencodeFamilySkills`, `src/install-profiles.cts:758 readInstalledCapabilitySkill`

### q-056 (callers)

> `resolveGsdToolsPath` is exported from `src/shell-command-projection.cts`. Which files use it by calling it? Test files and plain JavaScript files count, a call under another local name counts, and a different function with the same name does not. List each file once. Give your answer in the required JSON form.

- Key kind: callers
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (2 key items)
- First expected: `src/shell-command-projection.cts:1075 dispatchGsdCommand`, `tests/shell-command-projection-dispatch.test.cjs:1162 <module>`

### q-057 (references)

> Which files refer to `RouteCommand`, exported from `src/verification.cts`? Count every use except its declaration (imports, calls, reads), including uses inside `src/verification.cts`, and include test files and plain JavaScript files. List each file once; a different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (3 key items)
- First expected: `src/verification.cts:269 <module>`

### q-058 (references)

> Which files refer to `scanInlineCodeSpans`, exported from `src/markdown-sectionizer.cts`? Count every use except its declaration (imports, calls, reads), including uses inside `src/markdown-sectionizer.cts`, and include test files and plain JavaScript files. List each file once; a different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (7 key items)
- First expected: `src/api-coverage.cts:63 <module>`, `tests/markdown-sectionizer.test.cjs:49 <module>`

### q-059 (references)

> Which files refer to `stripTaggedBlocks`, exported from `src/markdown-sectionizer.cts`? Count every use except its declaration (imports, calls, reads), including uses inside `src/markdown-sectionizer.cts`, and include test files and plain JavaScript files. List each file once; a different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 3 at granularity file (9 key items)
- First expected: `src/roadmap-parser.cts:64 <module>`, `src/verify-command-grounding.cts:31 <module>`, `tests/markdown-sectionizer.test.cjs:44 <module>`

### q-060 (heritage)

> Which interfaces or classes in the TypeScript (`.cts`) sources under `src/` extend or implement the built-in TypeScript type `Record`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 1 at granularity file+symbol (1 key items)
- First expected: `src/installer-migrations.cts:736 JournalAction`

### q-061 (heritage)

> Which interfaces or classes extend or implement `CatalogPromptEntry`, declared in `src/mcp-catalog.cts`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 1 at granularity file+symbol (1 key items)
- First expected: `src/mcp-catalog.cts:173 CatalogPromptEntryInternal`

### q-062 (heritage)

> Which interfaces or classes extend or implement `SelectableSection`, declared in `src/section-manifest.cts`? Give the file and the name of each. Give your answer in the required JSON form.

- Key kind: heritage
- Granularity: file+symbol; equality: exact-set
- Expected answers: 1 at granularity file+symbol (1 key items)
- First expected: `src/init.cts:519 ManifestSection`

### q-063 (emit)

> The TypeScript build compiles `src/real-home-guard.cts` to a CommonJS file. At which path, relative to the repository root, does the build write the compiled file? Give your answer in the required JSON form.

- Key kind: emit
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `gsd-core/bin/lib/real-home-guard.cjs`

### q-064 (emit)

> Which files in this repository `require` the compiled CommonJS module that the build produces from `src/installer-migrations/005-opencode-baseline-commands-dir.cts`? Include test files, plain JavaScript files and `.cts` sources that call `require`; list each file once. Give your answer in the required JSON form.

- Key kind: emit-consumers
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `tests/installer-migrations.test.cjs:21`

### q-065 (emit)

> The build compiles `src/model-resolver.cts` to a `.cjs` module. Which files load that module with `require`, whether by its compiled path or by a sibling `.cjs` specifier? Test files and plain JavaScript files count; list each file once. Give your answer in the required JSON form.

- Key kind: emit-consumers
- Granularity: file; equality: exact-set
- Expected answers: 10 at granularity file (24 key items)
- First expected: `tests/claude-orchestration.test.cjs:924`, `tests/codex-config-agents.test.cjs:20`, `tests/codex-config-hooks.test.cjs:20`

### q-066 (adr)

> Which ADR files do the comments on `formatProgressMachineSegment` in `src/state-transition.cts` cite, counting comments inside its body? Give the path of each ADR file under `docs/adr`. Give your answer in the required JSON form.

- Key kind: adr-of
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `docs/adr/3180-planning-semantic-model-single-owner.md`

### q-067 (adr)

> Which files cite ADR-5 in a code comment, however the number is written (`ADR-5`, `ADR 5` or `ADR #5`)? Include tests, scripts and JavaScript configuration files; Markdown documents do not count. List each file once. Give your answer in the required JSON form.

- Key kind: adr-citers
- Granularity: file; equality: exact-set
- Expected answers: 1 at granularity file (1 key items)
- First expected: `scripts/gen-adr-index.cjs:114`

### q-068 (adr)

> Which files cite ADR-4629 in a code comment, however the number is written (`ADR-4629`, `ADR 4629` or `ADR #4629`)? Include tests, scripts and JavaScript configuration files; Markdown documents do not count. List each file once. Give your answer in the required JSON form.

- Key kind: adr-citers
- Granularity: file; equality: exact-set
- Expected answers: 6 at granularity file (26 key items)
- First expected: `scripts/lint-state-write-path-drift.cjs:165`, `src/state-transition.cts:523`, `src/state.cts:4976`

### q-069 (impact)

> List the files affected if the signature of `evidenceFromError` in `src/gate-evidence.cts` changed, to depth two: files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly. Include tests and plain JavaScript files; leave out `src/gate-evidence.cts` itself. Give your answer in the required JSON form.

- Key kind: impact
- Granularity: file; equality: exact-set
- Expected answers: 29 at granularity file (29 key items)
- First expected: `src/check-command-router.cts`, `src/gap-checker.cts`, `src/gate-api-coverage-verify-pre.cts`

### q-070 (impact)

> List the files affected if the signature of `antigravityWatermark` in `src/review-lane-runner.cts` changed, to depth two: files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly. Include tests and plain JavaScript files; leave out `src/review-lane-runner.cts` itself. Give your answer in the required JSON form.

- Key kind: impact
- Granularity: file; equality: exact-set
- Expected answers: 8 at granularity file (8 key items)
- First expected: `gsd-core/bin/gsd-tools.cjs`, `tests/antigravity-repo-grounding.test.cjs`, `tests/antigravity-reviewer.test.cjs`

### q-071 (definition)

> Where is `isSandboxHeld` declared in the TypeScript (`.cts`) sources under `src/`? Give the file and the line of its declaration. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/codex-agent-toml.cts:613 isSandboxHeld`

### q-072 (definition)

> Give the file and line where `STATUS_ANCHORED_PATTERNS` is declared, among the TypeScript (`.cts`) sources under `src/`. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/state-document.cts:802 STATUS_ANCHORED_PATTERNS`

### q-073 (abstain)

> Where is the function `locateLaneBudget` defined, and which files call it? If this repository has no such function, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: the name `locateLaneBudget`, which no tracked file mentions

### q-074 (abstain)

> Which file defines `verifyFieldName`, and which files call that function? If no function with that name exists in this repository, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: the name `verifyFieldName`, which no tracked file mentions

### q-075 (abstain)

> Which file in `docs/adr` records ADR-3873? If no ADR file carries that number, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: ADR number 3873, which no ADR file carries

## Pilot questions

### p-001 (references)

> Where is `cmdGitBaseBranch` from `src/git-base-branch.cts` used? List each file that contains a use of it other than its declaration (an import, a call, a read or a type reference), including `src/git-base-branch.cts` if it uses the symbol itself. A different symbol with the same name does not count. Give your answer in the required JSON form.

- Key kind: references
- Granularity: file; equality: exact-set
- Expected answers: 2 at granularity file (16 key items)
- First expected: `gsd-core/bin/gsd-tools.cjs:365 <module>`, `tests/git-base-branch.test.cjs:448 <module>`

### p-002 (adr)

> Which files cite ADR-2629 in a code comment, however the number is written (`ADR-2629`, `ADR 2629` or `ADR #2629`)? Include tests, scripts and JavaScript configuration files; Markdown documents do not count. List each file once. Give your answer in the required JSON form.

- Key kind: adr-citers
- Granularity: file; equality: exact-set
- Expected answers: 8 at granularity file (15 key items)
- First expected: `gsd-core/bin/gsd-tools.cjs:4750`, `src/config.cts:952`, `src/estimate-cli.cts:161`

### p-003 (impact)

> List the files affected if the signature of `fileRefPrompt` in `src/review-lane-invocation.cts` changed, to depth two: files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly. Include tests and plain JavaScript files; leave out `src/review-lane-invocation.cts` itself. Give your answer in the required JSON form.

- Key kind: impact
- Granularity: file; equality: exact-set
- Expected answers: 14 at granularity file (14 key items)
- First expected: `gsd-core/bin/gsd-tools.cjs`, `src/opencode-version.cts`, `src/review-lane-runner.cts`

### p-004 (definition)

> Give the file and line where `SmartEntryResult` is declared, among the TypeScript (`.cts`) sources under `src/`. Give your answer in the required JSON form.

- Key kind: definition
- Granularity: file+line; equality: exact-set
- Expected answers: 1 at granularity file+line (1 key items)
- First expected: `src/smart-entry.cts:144 SmartEntryResult`

### p-005 (abstain)

> Where is the function `locateProjectRoot` defined, and which files call it? If this repository has no such function, say so. Give your answer in the required JSON form.

- Key kind: abstain
- Granularity: file; equality: exact-set
- Expected answer: not found (abstain)
- Probe: the name `locateProjectRoot`, which no tracked file mentions

## Rejected candidates

| Reason | Count |
| --- | --- |
| unexplained | 1 |
| too-large | 2 |
| empty | 0 |
| duplicate-symbol | 0 |
| used-by-pilot | 0 |
| ambiguous-name | 6 |
| total | 9 |

| Category | Candidates | Accepted | Rejected | Unused |
| --- | --- | --- | --- | --- |
| callers | 581 | 17 | 1 | 563 |
| references | 1255 | 9 | 3 | 1243 |
| heritage | 19 | 8 | 1 | 10 |
| emit | 518 | 10 | 0 | 508 |
| adr | 725 | 11 | 2 | 712 |
| impact | 581 | 7 | 0 | 574 |
| definition | 1294 | 8 | 2 | 1284 |
| abstain | 246 | 10 | 0 | 236 |

### unexplained

- callers rank 13, `sym:clampPercent` (callers): 1 mention(s) neither included nor classified, first src/phase.cts:76

### too-large

- references rank 9, `sym:escapeRegex` (references): the expected answer has 60 items at granularity file; the limit is 30
- adr rank 24, `adr:2143` (adr-citers): the expected answer has 31 items at granularity file; the limit is 30

### ambiguous-name

- references rank 1, `sym:validateRequirement` (references): the name is declared 3 times in the program
- references rank 5, `sym:stateFieldValue` (references): the name is declared 2 times in the program
- heritage rank 2, `sym:CleanupManifestEntry` (heritage): the name is declared 2 times in the program
- adr rank 3, `sym:analyzeCoverage` (adr-of): the name is declared 3 times in the program
- definition rank 2, `sym:withLedgerLock` (definition): the name is declared 2 times in the program
- definition rank 9, `sym:FieldSource` (definition): the name is declared 2 times in the program
