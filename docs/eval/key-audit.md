# Key audit of the 75 registered questions

Status: exploratory audit, not a registered document. The registered verdict `OVERALL: MVP not met` (docs/eval/analysis.md) stands. The keys are frozen and are not edited here. Nothing below is a rescore or a corrected result. Nothing here is ratified.

## Summary

1. All 75 keys (`scripts/eval/questions/gsd-core.answers.json`) were compared with the 450 replication sessions (6 per question) and, where they differed or accuracy was below 100%, checked against the pinned corpus (gsd-core at 10ac3a7a947903ba50f538a907af036744d759d5) with read-only git.
2. Counts per class: consistent 61, ambiguous-wording 4, key-likely-incomplete 10, key-likely-overinclusive 0, unverified 0.
3. Key-likely-incomplete: q-001, q-008, q-010, q-011, q-014, q-024, q-028, q-036, q-065, q-069. In every one, the sessions' extra files are real hits under a literal reading of the wording (examples with file:line below).
4. Ambiguous-wording: q-012 (string-keyed reads), q-022 (`import x = require()` vs "call `require`"), q-030 (banner comment above the symbol), q-067 (`ADR-0005`, zero padded).
5. Four mechanical patterns account for all 10 incomplete keys: `import x = require('./m.cjs')` in `.cts` files (4 questions, with q-022), calls through a destructured or cast module object (4), variable-path requires (q-011 and parts of q-065), depth-two closure through `export = {...}` modules (2).
6. The key rule is not applied uniformly: it counts `hooks/gsd-cursor-subagent-start.js:177` (destructured require, q-008) and tests that `require(path.join(ROOT, ...))` (q-022) but not the equivalent forms in other files.
7. The 4 emit-path questions (q-023, q-025, q-026, q-063) have correct keys; most failures are sessions citing `tsconfig.build.json` instead of (or beside) the output path. Classified consistent, with a caveat (see Unverified).
8. The 9 abstain keys are right: no symbol and no ADR file of that number exist in the pinned corpus.
9. 11 of the 14 non-consistent questions score 0/3 in all four arm-run groups; q-012 and q-030 score at most 1/3 per group; q-067 is the exception (up to 3/3, because some sessions found the padded form).
10. Exploratory only: over the 52 non-abstain consistent questions the arms score 96.2% / 90.4% (run 1 atlas / grep) and 91.7% / 91.7% (run 2), against 77.3% / 71.7% and 73.7% / 73.2% on the registered 66-question basis. This changes no verdict.

## The scoring rule as found in code

Source: `scripts/eval/score.ts` (`scoreAnswer`, `matchSets`, `projectItems`), `scripts/eval/questions.ts` (key shape). Read with CodeGraph.

- Every one of the 75 keys has `equality: "exact-set"`. Granularity is `file` for 60 questions (callers 17, references 8, emit 10, adr 10, impact 6, abstain 9), `file+symbol` for the 8 heritage questions and `file+line` for the 7 definition questions.
- Correct means: the answer is `found`, no answered path is rejected (absolute outside checkout, `..`, NUL), the key set and the answered set (after projection to the granularity, one-to-one matching) have no missing key item and no extra answered item. Any extra file makes the answer incorrect (`extra items`), any omitted key file makes it incorrect (`missing items`).
- `file+line` items match when the lines are within `LINE_SLACK = 2`. `file+symbol` matches on the last segment of a qualified name.
- Abstain keys: correct only if the answer is `not_found` with zero items. `not_found` on a non-abstain question is `gave up`.
- Citations (`verifyCitation`) are scored separately in the `citation` fields and do not decide `correct`, except that a rejected path makes the answer incorrect.
- There is no partial credit and no tolerance for "also true" extra files. A key that omits one genuine hit therefore fails every session that lists it.

## Method and limits

- Consensus: the file set of each of the 6 replication sessions (3 atlas, 3 grep; final `StructuredOutput` input) was read from `.../fetch-cleanroom/cleanroom-run/streams/`. A file is in the consensus when at least 5 of 6 sessions name it. `key_only` = key files not in the consensus; `consensus_only` = consensus files not in the key. All 450 streams had a final answer.
- Accuracy is shown for the registered run (docs/eval/results/results.jsonl, "run 1") and the replication run (docs/eval/results-cleanroom/results.jsonl, "run 2"), as correct sessions out of 3 per arm. The consensus uses only the 6 replication sessions; the registered-run session answers were not available.
- Disputed files were checked with `git -C /Users/trekkie/projects/gsd-core grep -n <pattern> 10ac3a7a... -- <paths>` and `git show 10ac3a7a...:<path>`, run through small read-only scripts. Nothing was checked out, fetched or executed in the clone.
- Limits. (a) For the roughly 50 questions where key and consensus agree, the key was not independently re-derived: agreement of 5 or 6 sessions with the key is the evidence. For callers and references I additionally ran a crude whole-word grep and inspected the extra files for q-003, q-052, q-054, q-055, q-058, q-013 (all comments or strings, so the keys stand). (b) The depth-two checks (q-036, q-069) match exported names by word, not by a type-resolved call; the cited lines are real calls but the full closure was not recomputed. (c) Definition keys (file+line) and ADR keys were compared at file level only. (d) The consensus is one run of 6 sessions, so a hit named by 4 of 6 is shown but not counted.
- Resolving which file a destructured name originates from was done by reading the import lines, not by a type checker.

## Patterns

| pattern | description | questions | count |
|---|---|---|---|
| P1 | `import x = require('./m.cjs')` in `.cts` files is not counted as a `require` consumer | q-022, q-024, q-028, q-065 | 4 |
| P2 | Call through a module object obtained by destructuring or by a cast (`const { f } = require('./m.cjs') as {...}`, `import m = require(..); const { f } = m`, `({ f } = require(..))`, `runtimeHomes.f(..)`) | q-001, q-008, q-010, q-014 | 4 |
| P3 | `require` with a variable or computed path, or inside a script string | q-011 (`MODULE_PATH`), q-065 (`pi/gsd.cjs:265`), q-022 (`release-tarball-smoke` string) | 3 |
| P4 | Depth-two closure incomplete when the intermediate `.cts` uses `export = {...}` or the callers are reached through a module object | q-036, q-069 | 2 |
| P5 | Self-call in the defining file: key includes it, sessions often omit it (key is right) | q-010, q-053 | 2 |
| P6 | Emit-path answer given as the config file, or config added as an extra item | q-023, q-025, q-026, q-063 | 4 |
| P7 | Wording reading differences: string-keyed read (q-012), banner comment (q-030), zero-padded number (q-067) | q-012, q-030, q-067 | 3 |
| P8 | Key files that sessions miss because the require path is built from segments or the hit is in a rarely checked test | q-022 (2 tests), q-036 (2 tests), q-010 (1) | 3 |

Not observed as a pattern: renamed imports, same-name functions in other files (hooks/gsd-statusline.js `renderProgressBar` in q-036 is correctly excluded by the key), test files and plain-JS files as such. Question wording asks for them explicitly and key and sessions mostly agree on them.

Distinct questions with at least one of P1 to P4: q-001, q-008, q-010, q-011, q-014, q-022, q-024, q-028, q-036, q-065, q-069 = 11 (10 key-likely-incomplete plus the ambiguous q-022).

## Per-question table

Columns: key files = distinct files in the key; cons. differs = consensus set differs from key set; key_only/cons_only = counts; accuracy = correct sessions of 3 as atlas , grep for run 1 (registered) and run 2 (replication). For q-025, q-026, q-063 the "differs" is only that fewer than 5 sessions name the (correct) key path.

| id | category | key files | cons. differs | key_only/cons_only | acc atlas , grep run 1 | acc atlas , grep run 2 | class | evidence |
|---|---|---|---|---|---|---|---|---|
| q-001 | callers | 4 | yes | 0/1 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | src/runtime-hooks-surface.cts:1064,2725 call it via `import x = require()` + cast destructure (l.51) |
| q-002 | callers | 2 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-003 | callers | 4 | no | 0/0 | 3/3 , 2/3 | 3/3 , 3/3 | consistent | extras in grep are comments or strings |
| q-004 | callers | 3 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-005 | callers | 3 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-006 | callers | 3 | no | 0/0 | 1/3 , 3/3 | 3/3 , 3/3 | consistent | key includes self-call worktree-base-ref.cts:276 |
| q-007 | callers | 2 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-008 | callers | 20 | yes | 0/3 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | src/commands.cts:120 and scripts/live-config-guard.cjs:326 call it via destructured require; capability-state.cts:562 |
| q-009 | callers | 3 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-010 | callers | 12 | yes | 1/2 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | uat.cts:19 and uat-predicate.cts:21,173 destructure from `import = require`; key_only self-call markdown-sectionizer.cts:628 is genuine |
| q-011 | callers | 9 | yes | 0/1 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | tests/planning-document.test.cjs:27,42 destructure from `require(MODULE_PATH)` |
| q-012 | references | 1 | no | 0/0 | 0/3 , 0/3 | 1/3 , 1/3 | ambiguous-wording | alias-drift-families.cjs:24 and commands.test.cjs:4549 name it as a string for `manifest[key]` reads |
| q-013 | references | 4 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-014 | references | 5 | yes | 0/1 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | src/runtime-hooks-surface.cts:3189 `deps.resolveExecutableBinary ?? resolveExecutableBinary` (destructured l.59) |
| q-015 | references | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-016 | references | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-017 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-018 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-019 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-020 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-021 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-022 | emit | 24 | yes | 2/5 | 0/3 , 0/3 | 0/3 , 0/3 | ambiguous-wording | wording says ".cts sources that call `require`"; 4 `.cts` use `import x = require()`; 2 key_only tests use `require(path.join(ROOT,..))` |
| q-023 | emit | 1 | no | 0/0 | 1/3 , 0/3 | 2/3 , 2/3 | consistent | key path = outDir + rootDir mapping; failures cite tsconfig.build.json:5 |
| q-024 | emit | 1 | yes | 0/14 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | 13 `.cts` `import x = require('./cjs-command-router-adapter.cjs')` (e.g. roadmap-command-router.cts:15) |
| q-025 | emit | 1 | yes | 1/0 | 3/3 , 0/3 | 2/3 , 0/3 | consistent | as q-023; 4/6 sessions cite tsconfig.build.json |
| q-026 | emit | 1 | yes | 1/0 | 2/3 , 1/3 | 1/3 , 1/3 | consistent | as q-023; 4/6 sessions cite tsconfig.build.json |
| q-027 | emit | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-028 | emit | 4 | yes | 0/10 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | 10 `.cts` `import installFsAdapter = require('./install-fs-adapter.cjs')` (e.g. install-engine.cts:43) |
| q-029 | adr | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-030 | adr | 2 | yes | 1/0 | 0/3 , 0/3 | 0/3 , 1/3 | ambiguous-wording | ADR-3473 comes from banner comment l.399-407, blank line before the doc comment l.408 (ADR-3408 only) |
| q-031 | adr | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-032 | adr | 5 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-033 | adr | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-034 | adr | 14 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-035 | adr | 9 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-036 | impact | 17 | yes | 2/13 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | commands.cts is `export = {` (l.4359); gsd-tools.cjs:1346 `commands.cmdGenerateSlug(`, commands.test.cjs:4935 `cmdEffortSync(`; key_only clock.test.cjs also genuine |
| q-037 | impact | 2 | no | 0/0 | 3/3 , 3/3 | 1/3 , 3/3 | consistent | |
| q-038 | impact | 3 | no | 0/0 | 3/3 , 2/3 | 2/3 , 3/3 | consistent | |
| q-039 | impact | 8 | no | 0/0 | 2/3 , 3/3 | 2/3 , 2/3 | consistent | |
| q-040 | definition | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-041 | definition | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-042 | definition | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-043 | definition | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-044 | definition | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-045 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | symbol absent (git grep, no hit outside docs) |
| q-046 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | symbol absent |
| q-047 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | symbol absent |
| q-048 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | symbol and src/progress-table.cts absent |
| q-049 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | no docs/adr file numbered 123 |
| q-050 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | no docs/adr file numbered 2481 (cited in comments only) |
| q-051 | callers | 2 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-052 | callers | 3 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | extra grep hit is a comment |
| q-053 | callers | 3 | yes | 1/0 | 3/3 , 1/3 | 0/3 , 1/3 | consistent | key includes genuine self-call src/assumption-delta.cts:267; sessions often omit the defining file |
| q-054 | callers | 3 | no | 0/0 | 3/3 , 2/3 | 3/3 , 3/3 | consistent | extra grep hits are comments |
| q-055 | callers | 5 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | extra grep hits are comments or strings |
| q-056 | callers | 2 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-057 | references | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-058 | references | 2 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | extra grep hit is a comment |
| q-059 | references | 3 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-060 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-061 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-062 | heritage | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-063 | emit | 1 | yes | 1/0 | 3/3 , 2/3 | 2/3 , 0/3 | consistent | as q-023 |
| q-064 | emit | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-065 | emit | 10 | yes | 0/8 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | 7 `.cts` `import x = require('./model-resolver.cjs')`; pi/gsd.cjs:265 `require(path.join(GSD_CORE,..,'model-resolver.cjs'))` |
| q-066 | adr | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-067 | adr | 1 | yes | 1/0 | 3/3 , 1/3 | 2/3 , 0/3 | ambiguous-wording | only comment hit is scripts/gen-adr-index.cjs:114 `ADR-0005`; docs/adr/0005-* exists |
| q-068 | adr | 6 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-069 | impact | 29 | yes | 0/14 | 0/3 , 0/3 | 0/3 , 0/3 | key-likely-incomplete | gsd-tools.cjs:1248 `verify.cmdVerifySummary(`, :3117 `gapChecker.cmdGapAnalysis(`, phase.cts:3815 `verifyMod.verifySummaryCore(` |
| q-070 | impact | 8 | no | 0/0 | 3/3 , 2/3 | 2/3 , 2/3 | consistent | |
| q-071 | definition | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-072 | definition | 1 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | |
| q-073 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | symbol absent |
| q-074 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | symbol absent |
| q-075 | abstain | 0 | no | 0/0 | 3/3 , 3/3 | 3/3 , 3/3 | consistent | no docs/adr file numbered 3873 (cited in a script comment only) |

Note on the "differs" column for q-053 and the emit-path questions q-025, q-026, q-063: the key is right and the sessions are split.

## Detail for every non-consistent question

Commands are shown as the pattern given to `git grep -n` at the pinned commit. "Hits" are file:line of the first relevant line.

### q-001 callers of `isManagedHookCommand` (key-likely-incomplete, P2)
- key_only: none. consensus_only: `src/runtime-hooks-surface.cts` (6 of 6 sessions).
- `git grep -n isManagedHookCommand -- src/runtime-hooks-surface.cts`: l.51 destructured from `shellCmdProjection` (imported by `import shellCmdProjection = require('./shell-command-projection.cjs')`, l.48), l.1064 `const managed = isManagedHookCommand(cmd ...)`, l.2725 `&& isManagedHookCommand((h as ...).command, ...)`. Two genuine calls.
- tests/codex-config-install.test.cjs:2724 is a comment only (not in the key, not in the consensus; correct).
- Wording: "calls made through a renamed import" and "Include test files, plain JavaScript files". Calls through a destructured module object satisfy a literal "call".

### q-008 callers of `getGlobalConfigDir` (key-likely-incomplete, P2)
- consensus_only: `scripts/live-config-guard.cjs`, `src/capability-state.cts`, `src/commands.cts` (6 of 6 each).
- `getGlobalConfigDir` in `scripts/live-config-guard.cjs`: l.276 `({ getGlobalConfigDir, ... } = require(...))`, l.326 `const dir = getGlobalConfigDir(runtime);`.
- `src/commands.cts`: l.120 `const { getGlobalConfigDir } = require('./runtime-homes.cjs') as {...}`, l.121 call.
- `src/capability-state.cts`: l.544 `const runtimeHomes = require('./runtime-homes.cjs') as {...}`, l.562 `runtimeHomes.getGlobalConfigDir(canonical)`.
- The key does include `hooks/gsd-cursor-subagent-start.js` (l.177 `const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs')`, l.178 call), so the key rule counts one destructured-require form and omits the others.

### q-010 callers of `stripFencedCode` (key-likely-incomplete, P2, P5)
- key_only: `src/markdown-sectionizer.cts` (named by 2 of 6). Genuine: l.628 `const body = stripFences ? stripFencedCode(bodyRaw).text : bodyRaw;` is a call inside the defining file. consensus_only: `src/uat-predicate.cts`, `src/uat.cts`.
- `src/uat-predicate.cts`: l.20 `import markdownSectionizer = require('./markdown-sectionizer.cjs')`, l.21 `const { stripFencedCode } = markdownSectionizer;`, l.173 and l.206 calls. `src/uat.cts`: l.18 and l.19 same shape.

### q-011 callers of `parsePlanningDoc` (key-likely-incomplete, P3)
- consensus_only: `tests/planning-document.test.cjs` (6 of 6).
- `git show ...:tests/planning-document.test.cjs`: l.22 `mod = require(MODULE_PATH)`, l.26-29 `const { parsePlanningDoc, ... } = mod;`, l.42 `parsePlanningDoc(source, artifact)`. A plain-JS test calls it through a variable-path require.
- `scripts/lint-planning-document-positive-control.cjs` (3 of 6 sessions) calls an injected `parsePlanningDocFn` at l.194; this is not a call to the exported function by name and is correctly outside the key and the consensus.

### q-012 references to `PHASE_COMMAND_ALIASES` (ambiguous-wording, P7)
- Key: only `src/command-aliases.cts` (use at l.980). Sessions add `scripts/lib/alias-drift-families.cjs` (l.24, string in a data table) and `tests/commands.test.cjs` (l.4549, string in `familyArrayKeys`, then `manifest[key]` l.4553).
- Key follows a binding-level reading ("imports, calls, reads"). Sessions follow a textual reading ("refer to"). Both files read the export by its name as a string key. No import or identifier use exists in them. Not settled by the wording.

### q-014 references to `resolveExecutableBinary` (key-likely-incomplete, P2)
- consensus_only: `src/runtime-hooks-surface.cts` (6 of 6): l.59 destructured, l.3189 `const resolve = deps.resolveExecutableBinary ?? resolveExecutableBinary;` is a read of the imported binding.
- `tests/configured-entrypoint-validation.test.cjs:146` has an object key `resolveExecutableBinary: () => null` (dependency injection stub, not the imported symbol); sessions did not include it; fine.

### q-022 requirers of the compiled `runtime-artifact-layout` (ambiguous-wording, P1, P3, P8)
- Wording: "`require` the compiled CommonJS module ... Include test files, plain JavaScript files and `.cts` sources that call `require`".
- Key rule visible in the key: `src/capability-writer.cts` is in the key (l.366 `require('./runtime-artifact-layout.cjs') as {...}`, a call). The four consensus_only `.cts` files use the `import x = require()` declaration form: `src/install-engine.cts:27`, `src/surface.cts:66`, `src/install-shadow-report.cts:115`, `src/installed-surface-resolver.cts:62`. The declaration compiles to a `require` call but is not a call expression in source. The wording "call `require`" reads either way.
- consensus_only `tests/release-tarball-smoke.install.test.cjs:475,500,529`: `require(path.join(lib,'runtime-artifact-layout.cjs'))` lies inside a string array passed to a child process; unsettled.
- key_only (2 of 6 sessions each, genuine): `tests/runtime-artifact-layout-descriptor-drive.test.cjs:37-40` and `tests/runtime-config-adapter-registry.test.cjs:35` build the path with `path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs')` inside `require(...)`.
- All 6 sessions per group fail on this question in both runs because the key and the sessions differ in both directions.

### q-024, q-028, q-065 consumers that `require` a compiled module (key-likely-incomplete, P1; q-065 also P3)
- Wording (all three): "Which files load that module with `require`, whether by its compiled path or by a sibling `.cjs` specifier? Test files and plain JavaScript files count". A `.cts` file with `import x = require('./m.cjs')` loads the module with `require` by a sibling `.cjs` specifier.
- q-024 (`cjs-command-router-adapter`): key is `tests/cjs-command-router-adapter.test.cjs` only; `git grep -n cjs-command-router-adapter -- src/*.cts` shows 13 files with `import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');` (e.g. `src/roadmap-command-router.cts:15`, `src/validate-command-router.cts:25`, `src/phases-command-router.cts:16`). The consensus has 15 files (14 missing from the key).
- q-028 (`install-fs-adapter`): key is 4 tests; 10 `.cts` use `import installFsAdapter = require('./install-fs-adapter.cjs')` (`src/install-engine.cts:43`, `src/retired-artifact-cleanup.cts:19`, `src/runtime-artifact-layout.cts:25`, `src/runtime-artifact-conversion.cts:29`, `src/installer-migrations.cts:37`, `src/install-model-override-resolver.cts:35`, `src/commonjs-marker.cts:39`, `src/install-profiles.cts:24`, `src/install-effort-resolver.cts`, `src/user-artifact-staging.cts`).
- q-065 (`model-resolver`): key is 10 tests; consensus adds `src/docs.cts:22`, `src/model-adapter.cts:24`, `src/commands.cts:56`, `src/init.cts:22`, `src/claude-orchestration-command-router.cts:54`, `src/install-effort-resolver.cts:41`, `src/install-model-override-resolver.cts:47` (all `import x = require('./model-resolver.cjs')`) and plain-JS `pi/gsd.cjs:265` `require(path.join(GSD_CORE, 'bin', 'lib', 'model-resolver.cjs'))`, which names the compiled path.
- Contrast: q-027 and q-064 carry the sentence "and `.cts` sources that call `require`" in their wording and their keys match the consensus; q-024, q-028 and q-065 do not carry it. Whether the missing sentence is why the wording was meant to exclude `.cts` is not stated anywhere checked.

### q-030 ADR files cited by comments on `StateTransactionKind` (ambiguous-wording, P7)
- key: ADR-3408 and ADR-3473. Consensus: ADR-3408 only (5 of 6; one grep session adds 3473).
- `src/state-transition.cts`: l.408 doc comment `/** The two sanctioned write-path kinds (ADR-3408 §8.3's ...) */` directly above l.409 `export type StateTransactionKind = 'open' | 'rebuild';`. ADR-3473 appears at l.399 in a section banner (`// The state transaction (ADR-3473 §8.6, issue #3871)`), followed by comment lines up to l.407, then a blank line, then the doc comment.
- Key follows "any comment in the contiguous region above the declaration", sessions follow "the comment attached to the symbol". The type alias has no body comments.

### q-036 and q-069 depth-two impact closure (key-likely-incomplete, P4)
- Wording: "files that call it directly, plus files that call any function exported by a `.cts` file that calls it directly".
- q-036: direct callers of `renderProgressBar` (not the same-named function in `hooks/gsd-statusline.js:646`) are `src/commands.cts`, `src/gsd2-import.cts`, `src/state-transition.cts` and `tests/phase-lifecycle.test.cjs`. `src/commands.cts:4359` is `export = {` (a large object of `cmd*` functions). Files that call those exports and are missing from the key: `gsd-core/bin/gsd-tools.cjs:1346` (`commands.cmdGenerateSlug(`), `tests/commands.test.cjs:4935` (`cmdEffortSync(`), plus 11 others by exported-name match (`src/audit.cts`, `src/uat.cts`, `src/health-diagnostic.cts`, `tests/commands.platform.test.cjs`, `tests/roadmapper-granularity.test.cjs`, `tests/core-utils.test.cjs`, `tests/commit-docs-bypass.test.cjs`, `tests/codex-inherit-smoke.test.cjs`, `tests/plant-seed-id.test.cjs`, `tests/list-seeds.property.test.cjs`, `tests/gsd2-import.test.cjs`). key_only `tests/clock.test.cjs` and `tests/feat-3881-yaml-parser-consequences.test.cjs` use `transitionCore` (exported by `src/state-transition.cts`); genuine, sessions missed them.
- q-069: direct callers of `evidenceFromError` are 7 `.cts` files plus `scripts/lint-gate-evidence-drift.cjs`. Missing from the key by exported-name match: `src/phase.cts:3815` (`verifyMod.verifySummaryCore(`), `gsd-core/bin/gsd-tools.cjs:1248` (`verify.cmdVerifySummary(`) and `:3117` (`gapChecker.cmdGapAnalysis(`), `tests/phase.test.cjs:13967` (`normalizePhaseReqIds(`), and 10 further files.
- Confidence: the cited call lines are real. The exact closure (which names are exported, which matches are collisions) was not recomputed; the count of missing files (13 and 14) is the consensus count, not a verified count. Mechanism for the key's omission (module objects, `export =`) is a hypothesis.

### q-053 (consistent, listed for P5)
- key includes `src/assumption-delta.cts`; l.267 `const result = detectAssumptionDelta(input, termsOverride);` is a call. Sessions mostly omit the defining file. The wording does not exclude it. Model error under a literal reading.

### q-067 files citing ADR-5 (ambiguous-wording, P7)
- Key: `scripts/gen-adr-index.cjs:114` (`(ADR-0174 -> ADR-0005.)` inside a block comment). `git grep -n -E 'ADR[ -]?#?0*5([^0-9]|$)'` over `*.js *.cjs *.cts *.mjs *.ts *.yml *.yaml *.json` returns that line and `tests/adr-parser.unit.test.cjs:1121-1122` (`'- ADR-0005'` in a string literal, excluded by the key as non-comment). `docs/adr/0005-sdk-architecture-seam-map.md` exists.
- Wording: "however the number is written (`ADR-5`, `ADR 5` or `ADR #5`)". The key accepts zero padding. 4 of 6 replication sessions answered `not_found`, searching the three listed forms. No unpadded form exists in any non-Markdown file, so a literal search of the three forms gives an empty set while the key is non-empty.

### q-023, q-025, q-026, q-063 emit paths (consistent, P6)
- `tsconfig.build.json` at the pinned commit has `rootDir: "src"`, `outDir: "gsd-core/bin/lib"`, `include: ["src/**/*.cts"]`, with a comment that sources compile to gitignored `.cjs` artifacts under `gsd-core/bin/lib/`. `.gitignore` lists `/gsd-core/bin/lib/workstream.cjs` (l.345), `estimate-cli.cjs` (l.277), `real-home-guard.cjs` (l.86). `package.json:113` `"build:lib": "tsc -p tsconfig.build.json"`. The four keys equal `gsd-core/bin/lib/<name>.cjs`.
- Failures are sessions answering `tsconfig.build.json` with a line (q-025: 4 of 6 sessions, q-026: 4 of 6, q-063: 4 of 6, q-023: 2 of 6), which is an extra or wrong item under exact-set.
- The output files are not tracked (`git ls-tree` of `gsd-core/bin/lib/` shows no `workstream.cjs`), so a session reading the tree cannot see the key file. Whether the prepared checkout had been built is not known from here.

## Sensitivity (exploratory, NOT a registered analysis, NOT a rescore)

Descriptive only; sessions pooled over 3 runs per question; run 1 = registered run, run 2 = replication run. The registered basis in docs/eval/analysis.md excludes the abstain questions (66 questions, 198 sessions per arm); that basis is repeated first for comparison. No threshold or verdict is evaluated.

| subset | run 1 atlas | run 1 grep | run 2 atlas | run 2 grep |
|---|---|---|---|---|
| 66 non-abstain (registered basis) | 153/198 = 77.3% | 142/198 = 71.7% | 146/198 = 73.7% | 145/198 = 73.2% |
| non-abstain, without the 10 key-likely-incomplete (56 q) | 153/168 = 91.1% | 142/168 = 84.5% | 146/168 = 86.9% | 145/168 = 86.3% |
| non-abstain, consistent only (52 q) | 150/156 = 96.2% | 141/156 = 90.4% | 143/156 = 91.7% | 143/156 = 91.7% |
| non-abstain, consistent minus the 4 emit-path (48 q) | 141/144 = 97.9% | 138/144 = 95.8% | 136/144 = 94.4% | 140/144 = 97.2% |
| all 75 (incl. abstain) | 180/225 = 80.0% | 169/225 = 75.1% | 173/225 = 76.9% | 172/225 = 76.4% |
| all 75, consistent only (61 q) | 177/183 = 96.7% | 168/183 = 91.8% | 170/183 = 92.9% | 170/183 = 92.9% |

(The first row is recomputed from the result rows here and is shown for comparison; the registered table in analysis.md is the authority.)

Not consistent: 14 of 75 questions (18.7%): 10 key-likely-incomplete + 4 ambiguous-wording.

Per category (questions / not consistent):

| category | questions | key-likely-incomplete | ambiguous-wording | consistent |
|---|---|---|---|---|
| callers | 17 | 4 | 0 | 13 |
| references | 8 | 1 | 1 | 6 |
| heritage | 8 | 0 | 0 | 8 |
| emit | 10 | 3 | 1 | 6 |
| adr | 10 | 0 | 2 | 8 |
| impact | 6 | 2 | 0 | 4 |
| definition | 7 | 0 | 0 | 7 |
| abstain | 9 | 0 | 0 | 9 |

Accuracy over consistent questions by category (correct of sessions; run 1 atlas, run 1 grep, run 2 atlas, run 2 grep): callers 37/39, 35/39, 36/39, 37/39; references, heritage, adr, definition and abstain 100% in all four groups; emit 15/18, 9/18, 13/18, 9/18 (the 4 emit-path questions); impact 11/12, 10/12, 7/12, 10/12.

## What a corrected key set would require

Descriptive only; none of this is proposed for application here.
- A new registration. The keys, the preregistration and the scorer are frozen; a corrected key set is a new, separately registered set of questions and keys with its own pinned scorer hash.
- For P1 and P2: an explicit decision on whether `import x = require()` and destructured or cast module objects count as `require` and as calls, written into the wording (q-022/q-027/q-064 already carry a ".cts sources that call `require`" sentence; q-024/q-028/q-065 do not), and an oracle that resolves those forms the same way in every file type.
- For P3: either a rule for variable-path and path.join requires, or questions that exclude them.
- For P4: a stated closure rule for modules exported with `export = {...}`, and a recomputed closure.
- For P6: ask for the compiled path as a value (a different answer shape), or accept the config file as the cited evidence, or require a built checkout.
- For q-012, q-030, q-067: reword to say whether string-keyed reads, banner comments and zero-padded numbers count.
- Keys regenerated by an oracle that handles these patterns, then re-audited the same way (consensus versus key, direct corpus check).

## Unverified items and things not checked

- Registered-run session answers were not available; the consensus uses the 6 replication sessions only. If the registered-run sessions behaved differently for any question, that is not seen here.
- Keys that agree with the consensus (about 50 questions) were not re-derived from the corpus. Sessions agreeing with a key does not prove the key is complete. Definition (file+line), heritage (file+symbol) and ADR keys were compared at file level only.
- q-036 and q-069 closures were matched by exported name and not recomputed with type resolution; the 13 and 14 "missing" file counts are consensus-set counts.
- q-022 `tests/release-tarball-smoke.install.test.cjs` (require inside a script string) is not settled either way.
- Whether the prepared checkout used by the sessions contained the built `gsd-core/bin/lib/*.cjs` files is unknown; this affects only the interpretation of the emit-path failures (q-023, q-025, q-026, q-063), which stay classified consistent.
- `unverified` class count is 0, but the classes `key-likely-overinclusive` and `unverified` being empty reflects what was checked, not a proof that no such key exists.
