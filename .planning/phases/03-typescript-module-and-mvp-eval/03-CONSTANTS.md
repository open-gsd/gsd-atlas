# Phase 3 Constants

Status: Approved (2026-10-18, by the user)

## Purpose

This file lists every timeout-, size-, ratio- and threshold-shaped constant that Phase 3 writes into code, each with the plan that consumes it and its basis, plus the three packages Phase 3 needs added. A person must approve it before any consuming plan runs: Phase 2 followed the same rule (02-CONSTANTS.md) after a PreToolUse guard refused an agent writing such values in Phase 1, and loosening a bound needs user approval. Several rows are locked by earlier decisions (D-03, D-04, D-21, DESIGN A25, EVL-02, EVL-03, ROADMAP criterion 2, DIAGNOSTICS.md 9.1) and are listed for the record, not reopened. Rows marked "planner-added" are values the plan set needs that the research did not list. The three `gate.*PrCeilingMs` rows are looser than the ROADMAP figures (D-10, three times the strict figure, the ratio Phase 2 used for freshness) and take effect only when the human approves them here.

## How plans use this file

A consuming plan reads its value from the table below instead of inventing a number. Each consuming plan carries a precondition that this file says `Status: Approved`; if the Status line is still `Proposed`, that precondition is unmet and the plan halts.

## Constants

| Key | Proposed value | Consumed by plan | Basis |
|-----|----------------|------------------|-------|
| `precise.memoryBudgetPercent` | 25 | 03-27 | D-21 and DESIGN A25, locked |
| `precise.heapShareOfBudget` | 0.8 | 03-27 | RSS exceeded heap by about 130 MB on gsd-core (430 versus 296 MB) |
| `precise.rssSampleMs` | 250 | 03-27 | cheap, far below the 5 s update budget |
| `precise.minBudgetMb` | 512 | 03-27 | planner-added: below this the tier answers memory_budget without starting a worker |
| `precise.startTimeoutMs` | 20000 | 03-23 | spawn plus init; 0.35 to 0.46 s on a Mac, Windows unknown |
| `precise.requestTimeoutMs` | 25000 | 03-23, 03-29 | below the 30 s build budget so a hang fails before the gate |
| `precise.idleExitMs` | 300000 | 03-27 | release about 400 MB when unused |
| `precise.killGraceMs` | 2000 | 03-19, 03-23 | planner-added: wait after ending stdin before killing the worker |
| `precise.maxStdoutBytes` | 9007199254740991 | 03-19, 03-23 | Pitfall 1: the runner cap is cumulative over the child's life |
| `precise.maxLineBytes` | 4194304 | 03-23 | planner-added: longest single JSON line accepted from the worker |
| `precise.sitesPerRequest` | 2000 | 03-23, 03-29 | planner-added: sites in one resolve message |
| `gate.buildPrCeilingMs` | 90000 | 03-30 | D-10: 3 times the roadmap figure; needs approval |
| `gate.updatePrCeilingMs` | 15000 | 03-30 | D-10: 3 times the roadmap figure; needs approval |
| `gate.warmQueryPrCeilingMs` | 6000 | 03-30 | D-10: 3 times the roadmap figure; needs approval |
| `gate.buildStrictMs` | 60000 | 03-30 | ROADMAP criterion 2 says 30000; raised to 60000 by the user's decision "B and C" of 2026-10-18 (Approvals below): 40% above the slowest hosted two-vCPU Linux build seen after the build was optimised (43.0 s); sized on hosted Linux and local macOS, Windows being postponed past the alpha |
| `gate.updateStrictMs` | 5000 | 03-30 | ROADMAP criterion 2, locked |
| `gate.warmQueryStrictMs` | 2000 | 03-30 | ROADMAP criterion 2, locked |
| `recorder.maxEvents` | 2000 | 03-17 | DIAGNOSTICS.md 9.1, locked |
| `recorder.maxBytes` | 5242880 | 03-17 | DIAGNOSTICS.md 9.1, locked |
| `bug.excerptEvents` | 200 | 03-32 | planner-added: recorder events copied into a bundle by default |
| `bug.bundleMaxBytes` | 1048576 | 03-32 | planner-added: largest bundle written |
| `adr.listMaxEntries` | 5000 | 03-28 | planner-added: most directory entries read from an ADR directory |
| `adr.maxCitationsPerFile` | 200 | 03-24 | planner-added: most ADR citations stored for one file version |
| `adr.maxCommentUnits` | 32768 (UTF-16 code units; behaviour: skip, the whole comment is blanked and counted, never clipped) | 03-24 | `GRAMMAR_LIMITS.commentTextChars` in `src/grammar-engine/limits.ts`; the plan's 4,096 lost real citations and the executor's 65,536 was never registered. Approved by the user's reply `approve` to the review in `.planning/research/COMMENT-BOUND.md` (see Approvals). Basis: on gsd-core 10ac3a7 the longest ADR-mentioning comment is 17,881 units (the bound is 1.83 times that, an observed headroom and not a derived requirement); on gsd-pi bb86b6c the longest is 1,429. 16,384 misses 8 of 3,245 oracle citations; 32,768 and above miss none attributable to the bound. If the corpus pin changes, rerun `scripts/adr-citations-check.ts --sample 1000`; a result above the 2 percent limit means the bound is too small. A bound is not what limits hostile cost (2 MiB source cap, 200 citations per file, linear scan). Tests pin it by equality, by "exceeds 17,881" and by a real-engine case, not by a multiple (follow-up of 2026-10-18, see Approvals). |
| `eval.marginPoints` | 5 | 03-05, 03-16 | D-04, locked |
| `eval.runsPerCell` | 3 | 03-10, 03-16 | D-03 and ROADMAP criterion 5, locked |
| `eval.minQuestions` | 50 | 03-09, 03-16 | EVL-02, locked |
| `eval.citationRate` | 0.8 | 03-05, 03-16 | EVL-03, locked (how it is judged is OQ4) |
| `eval.intervalLevel` | 90 percent two-sided (the 5th percentile is the one-sided 95 percent lower bound) | 03-05, 03-16 | research Eval D; registered at the freeze |
| `eval.bootstrapResamples` | 10000 | 03-05, 03-16 | planner-added |
| `eval.bootstrapSeed` | 20261017 | 03-05, 03-16 | planner-added: fixed so the analysis is reproducible |
| `eval.concurrency` | 2 | 03-10 | research Eval E: two to three workers against rate limits |
| `eval.pilotQuestions` | 5 | 03-14 | planner-added: pilot of 5 questions times 2 arms = 10 sessions |
| `eval.maxBudgetUsdPerSession` | 3 (USD) | 03-14, 03-16 | approved by the user's reply to the plan 03-14 checkpoint (see Approvals): the pilot rule gave 1, the user kept the `scan.maxBudgetUsdPerSession` value because a bound set from five easy questions could fail slow correct sessions |
| `eval.sessionWallClockMs` | 900000 | 03-14, 03-16 | approved by the same reply: the pilot rule gave 60000, the user kept the `scan.sessionWallClockMs` value |
| `eval.scoredQuestions` | 75 | 03-14, 03-16 | planner-added row recording the user's choice of N at the plan 03-14 checkpoint; `eval.minQuestions` 50 stays the locked floor |
| `eval.retryDelayMs` | 60000 | 03-16 | `DEFAULT_RETRY_DELAY_MS` in `scripts/eval/arms.ts` (planner-added in plan 03-10): the wait before retrying an infrastructure failure (429 or 529 with no tool call made), at most 2 retries; approved by the user together with the pre-registration at the plan 03-16 checkpoint (see Approvals). The constant stays in `arms.ts`; this row only records the approval |
| `scan.maxBudgetUsdPerSession` | 3 | 03-06 | planner-added: cost cap for each free-alternatives live run |
| `scan.sessionWallClockMs` | 900000 | 03-06 | planner-added: wall-clock kill for each live run |

### Deferred rows (resolved)

`eval.maxBudgetUsdPerSession` and `eval.sessionWallClockMs` were left open when this file was approved: plan 03-14 measured a 10-session pilot and proposed 1 USD and 60000 ms by its rule. The user answered the plan 03-14 checkpoint on 2026-10-18 (see Approvals), keeping the scan values, 3 USD and 900000 ms, and the two rows above carry them. The eval freeze (plan 03-16) records them in the pre-registration. The approval of this file on 2026-10-18 (`approve-all`) did not cover these two values; the later reply does.

### Packages to add (need approval)

| Package | Exact version | Section | Why |
|---------|---------------|---------|-----|
| `typescript` | 6.0.3 | `dependencies` (moved from `devDependencies`) | the worker loads the bundled 6.0.3 when a project has no usable compiler (D-13) |
| `jsonc-parser` | 3.3.1 | `dependencies` | reads tsconfig files in the compiler-free ProjectModel; refusal means plan 03-18 writes its own JSONC tokenizer (research assumption A10) |
| `typescript-7` | `npm:typescript@7.0.2` | `devDependencies` | alias used only by tests to inspect a real 7.x package layout (D-14) |

## Package evidence

Registry queries run read-only on 2026-10-18 (no package was installed by this plan task). Audit verdicts come from the research Package Legitimacy Audit (03-RESEARCH.md): `typescript` OK (years old, 184M downloads per week, github.com/microsoft/TypeScript), `jsonc-parser` OK (3.3.1 published 2024-06-24, 42.9M downloads per week, github.com/microsoft/node-jsonc-parser). None is ASSUMED, SUS or SLOP. `typescript-7` is an npm alias of the same `typescript` package at 7.0.2, so it carries the `typescript` verdict. None of the three has a `preinstall`, `install` or `postinstall` script (the `scripts` output below lists build, test and `prepack` entries only, and `prepack` runs at publish time, not at install time). Each will be installed with an exact version and with scripts disabled (`--ignore-scripts`).

### `npm view typescript@6.0.3 version license dist.integrity dist.unpackedSize time.modified scripts`

```
version = '6.0.3'
license = 'Apache-2.0'
dist.integrity = 'sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw=='
dist.unpackedSize = 24346827
time.modified = '2026-10-17T08:04:49.367Z'
scripts = {
  gulp: 'hereby',
  knip: 'hereby knip',
  lint: 'hereby lint',
  test: 'hereby runtests-parallel --light=false',
  build: 'npm run build:compiler && npm run build:tests',
  clean: 'hereby clean',
  format: 'dprint fmt',
  'build:tests': 'hereby tests',
  'setup-hooks': 'node scripts/link-hooks.mjs',
  'build:compiler': 'hereby local',
  'test:eslint-rules': 'hereby run-eslint-rules-tests',
  'build:tests:notypecheck': 'hereby tests --no-typecheck'
}
```

Verdict: OK. No install script. Version 6.0.3 was published 2026-04-16 (03-RESEARCH.md; `time.modified` above is a later registry metadata touch, not a new publish). Install: exact, scripts disabled. About 24 MB unpacked.

### `npm view jsonc-parser@3.3.1 version license dist.integrity dist.unpackedSize time.modified scripts`

```
version = '3.3.1'
license = 'MIT'
dist.integrity = 'sha512-HUgH65KyejrUFPvHFPbqOY0rsFip3Bo5wb4ngvdi1EpCYWUQDC5V+Y7mZws+DLkr4M//zQJoanu1SP+87Dv1oQ=='
dist.unpackedSize = 212821
time.modified = '2026-07-16T15:49:11.134Z'
scripts = {
  lint: 'eslint src/**/*.ts',
  test: 'npm run compile && mocha ./lib/umd/test',
  clean: 'rimraf lib',
  watch: 'tsc -w -p ./src',
  compile: 'tsc -p ./src && npm run lint',
  prepack: 'npm run clean && npm run compile-esm && npm run test && npm run remove-sourcemap-refs',
  'compile-esm': 'tsc -p ./src/tsconfig.esm.json',
  'remove-sourcemap-refs': 'node ./build/remove-sourcemap-refs.js'
}
```

Verdict: OK. No install script. About 213 KB unpacked. Install: exact, scripts disabled.

### `npm view typescript@7.0.2 version license dist.integrity exports optionalDependencies scripts`

```
version = '7.0.2'
license = 'Apache-2.0'
dist.integrity = 'sha512-8FYau96o3NKOhbjKi/qNvG/W5jhzxkbdm5sj9AbZ/5T5sWqn3hJgLfGx27sRKZWTvyzCP8dLRBTf5tBTSRVUNA=='
exports = {
  '.': './lib/version.cjs',
  './unstable/fs': './dist/api/fs.js',
  './package.json': './package.json',
  './unstable/ast': './dist/ast/index.js',
  './unstable/sync': './dist/api/sync/api.js',
  './unstable/async': './dist/api/async/api.js',
  './unstable/proto': './dist/api/proto.js',
  './unstable/ast/is': './dist/ast/is.js',
  './unstable/ast/clone': './dist/ast/clone.js',
  './unstable/ast/utils': './dist/ast/utils.js',
  './unstable/ast/factory': './dist/ast/factory.generated.js',
  './unstable/ast/scanner': './dist/ast/scanner.js',
  './unstable/ast/visitor': './dist/ast/visitor.js'
}
optionalDependencies = {
  '@typescript/typescript-aix-ppc64': '7.0.2',
  '@typescript/typescript-linux-arm': '7.0.2',
  '@typescript/typescript-linux-x64': '7.0.2',
  '@typescript/typescript-sunos-x64': '7.0.2',
  '@typescript/typescript-win32-x64': '7.0.2',
  '@typescript/typescript-darwin-x64': '7.0.2',
  '@typescript/typescript-netbsd-x64': '7.0.2',
  '@typescript/typescript-freebsd-x64': '7.0.2',
  '@typescript/typescript-linux-arm64': '7.0.2',
  '@typescript/typescript-linux-ppc64': '7.0.2',
  '@typescript/typescript-linux-s390x': '7.0.2',
  '@typescript/typescript-openbsd-x64': '7.0.2',
  '@typescript/typescript-win32-arm64': '7.0.2',
  '@typescript/typescript-darwin-arm64': '7.0.2',
  '@typescript/typescript-netbsd-arm64': '7.0.2',
  '@typescript/typescript-freebsd-arm64': '7.0.2',
  '@typescript/typescript-linux-loong64': '7.0.2',
  '@typescript/typescript-linux-riscv64': '7.0.2',
  '@typescript/typescript-openbsd-arm64': '7.0.2',
  '@typescript/typescript-linux-mips64el': '7.0.2'
}
```

Verdict: OK. The package declares no `scripts` at all (none printed), so there is no install script. The platform binaries are optional dependency packages under the `@typescript/` scope, one per platform; only the matching one installs. Published 2026-07-08 (03-RESEARCH.md). About 27 MB of dev-only platform binaries. Install: exact, scripts disabled, as the dev alias `typescript-7`.

## Approvals

Task 2 of plan 03-02 (blocking-human checkpoint) was answered by the user on 2026-10-18. Reply, verbatim:

> approve-all

Meaning: every constant in the table above is approved unchanged, including the three `gate.*PrCeilingMs` D-10 ceilings (`gate.buildPrCeilingMs` 90000, `gate.updatePrCeilingMs` 15000, `gate.warmQueryPrCeilingMs` 6000), and all three packages are approved for install: typescript 6.0.3 (runtime, moved from devDependencies, exact), jsonc-parser 3.3.1 (runtime, exact) and typescript-7 = npm:typescript@7.0.2 (dev, exact). No package was refused. `eval.maxBudgetUsdPerSession` and `eval.sessionWallClockMs` remain deferred to plans 03-14 and 03-16.

Task 2 of plan 03-14 (blocking-human checkpoint, the pilot decision) was answered by the user on 2026-10-18. Reply, verbatim:

> n75 keep-scan fix-oracle

Meaning: the scored question set is extended from 50 to 75 questions (`eval.scoredQuestions` 75; `eval.minQuestions` 50 is unchanged); the per-session bounds keep the `scan.*` values, so `eval.maxBudgetUsdPerSession` is 3 (USD) and `eval.sessionWallClockMs` is 900000; and the oracle blind spot found by the pilot (computed `require(path.join(...))` paths, `docs/eval/pilot.md` Findings 7) is fixed and the affected answer keys are regenerated before the plan 03-16 freeze. Only these two eval rows and the new `eval.scoredQuestions` row changed; the Status line stays `Approved` and no other constant or package changed. This is the approval of those values; plan 03-16 still records them in the pre-registration and asks the user to approve the frozen files.

Task 3 of plan 03-16 (blocking-human checkpoint, the pre-registration) was answered by the user on 2026-10-18. Replies, verbatim:

> point_estimate, stricter point estimate, approve pre-registration

and, when asked whether the replies conflicted:

> both unless they conflict and you didn't tell me

Meaning: the replies do not conflict and both apply, resolved as `approve` with `stricter oq4=point_estimate`. The pre-registration (including its Run configuration) is approved as written, and that approval covers `DEFAULT_RETRY_DELAY_MS` = 60000 (infrastructure failures only, at most 2 retries), recorded in the `eval.retryDelayMs` row above. `scripts/eval/arms.ts` is not edited. No other constant changed.

Plan 03-24 (ADR citations), after the adversarial review of the comment text bound (`.planning/research/COMMENT-BOUND.md`), was answered by the user on 2026-10-18. Reply, verbatim:

> approve

Meaning: exactly five changes are approved. (1) `adr.maxCommentUnits`, the comment text bound `GRAMMAR_LIMITS.commentTextChars`, is 32768 UTF-16 code units (it was 65536; the plan wrote 4096), and the behaviour stays skip: a longer comment is blanked whole and counted, never clipped, so `ADR-123` can never become `ADR-1`. (2) The dropped-comment note `citation_comment_too_long` is reported by the Indexer, as one counted note with fixed text in a run's `skipped` diagnostics. (3) The citation scan stops once 200 citations (`adr.maxCitationsPerFile`) are held, with the same output as the cut after a full scan. (4) This row and this entry. (5) The tests that pin the bound. No other constant changed.

Follow-up to plan 03-24 (`.planning/research/COMMENT-BOUND-FOLLOWUP.md`) was answered by the user on 2026-10-18. Reply, verbatim:

> approve both

Meaning: the two before-03-35 changes of that review are approved. (1) The floor test with the factor 1.8 is replaced by "the bound exceeds the longest observed comment (17,881)" plus a real-engine case (a 17,881-unit comment keeps its citation, 32,769 and 35,762 units are dropped); the test no longer reads this file; the wording of the `adr.maxCommentUnits` row above is corrected to say the 1.83 margin is an observation, not a derived requirement. The value stays 32768. (2) The citation scan takes at most 200 mentions per capture on the full path (overlapping or repeated captures), a capture whose text is longer than its span takes the full path, and `scanProbe` is tagged `@internal`; the output is unchanged. The earlier entries of this section are kept as they were written. No constant changed.

Plan 03-30 follow-up (`03-30-SUMMARY.md`, "Build ceiling follow-up (2026-10-18)"): the strict full-build ceiling was breached on hosted Linux (42.2 s) and Windows (54.9 s) against 30 s, and the user was asked whether to optimise the build (B), raise the ceiling (C), or both. Reply, verbatim (the question was "Decision 1"):

> Decision 1: B and C

Meaning: both. (B) The build was optimised without changing any answer (a resolver call reads each file's symbols once instead of once per edge target; `03-30-SUMMARY.md` has the figures). (C) `gate.buildStrictMs` is raised from 30000 to 60000 (milliseconds), sized on hosted two-vCPU Linux and local macOS after the optimisation (Windows is postponed past the alpha and was not used): the slowest hosted Linux full build seen was 43.0 s, and 60 s is 40% above it (the requirement was at least about 30%, which is 55.9 s). The new value is `gate.buildStrictMs` 60000 in the table above and `BUILD_STRICT_MS` in `scripts/precise-gate.ts`. The other five gate rows are unchanged (`gate.buildPrCeilingMs` 90000, `gate.updatePrCeilingMs` 15000, `gate.warmQueryPrCeilingMs` 6000, `gate.updateStrictMs` 5000, `gate.warmQueryStrictMs` 2000), and so are the sample counts and every timeout. ROADMAP criterion 2 still reads 30 s; it was not edited here.
