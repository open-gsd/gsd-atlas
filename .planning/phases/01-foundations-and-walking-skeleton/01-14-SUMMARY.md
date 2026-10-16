---
phase: 01-foundations-and-walking-skeleton
plan: 14
subsystem: lang-test
tags: [cli, host-client, golden, lang-test, utf-16, crlf, bom, confined-reader, e2e]
status: complete

requires:
  - phase: 01-09
    provides: CommandRunner (createRealRunner, allowAll) used by the process-level e2e test
  - phase: 01-12
    provides: Grammar Engine, readModuleInputs, the toy module with its fixtures
provides:
  - "gsd-atlas lang test <module folder>: argv -> CLI adapter -> in-process HostClient -> Grammar Engine -> golden comparison -> exit code"
  - "src/lang/index.ts public surface (parseManifest, parseGrammarLock, readModuleInputs, readModuleFile, runLangTest, golden helpers)"
  - "Golden format {schema, fixture, convention, hadBom, captures[]} with renderGolden, compareGolden, serializeGolden"
  - "createInProcessHostClient({ engine }) serving lang_test; schemas gsd-atlas.lang-test/1 and gsd-atlas.error/1"
  - "runCli(argv, io) with exit codes 0 ok, 1 usage or unknown target, 2 failure; src/bin/gsd-atlas.ts as composition root"
  - "Four checked-in toy goldens (basic, emoji, crlf, bom) and scripts/toy-goldens.ts"
affects: [01-15, 01-16, 01-17]

plan_head_before: cc2f19ab00c2bce845ecc08bfb34eece514dcce2
plan_head_after: e8b0df7a10da121d69ecee8cd5ad92b126b6e95b

actuals:
  tokens: 21700   # chars/4 over the 20 files changed (86,894 bytes)
  tasks: 2
  commits: 2      # MEASURED: git rev-list --count cc2f19a..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "Adapter imports only host-client; the composition root builds engine and client and disposes the engine in finally"
    - "Fixture and golden reads go through the same realpath-confined, size-capped reader as every other module file"
    - "Process-level e2e: the real bin is started through the real CommandRunner (process.execPath, allowAll), one JSON line on stdout, human reasons on stderr"
    - "Hand-typed expected numbers in the test source are the oracle; the engine-generated goldens must agree with them"

key-files:
  created:
    - src/lang/index.ts
    - src/lang/golden.ts
    - src/lang/golden.test.ts
    - src/lang/test-runner.ts
    - src/lang/test-runner.test.ts
    - src/lang/lang-test.e2e.test.ts
    - src/host-client/in-process.ts
    - src/cli/index.ts
    - src/cli/cli.test.ts
    - scripts/toy-goldens.ts
    - test/fixtures/modules/toy/fixtures/basic.toy.golden.json
    - test/fixtures/modules/toy/fixtures/emoji.toy.golden.json
    - test/fixtures/modules/toy/fixtures/crlf.toy.golden.json
    - test/fixtures/modules/toy/fixtures/bom.toy.golden.json
  modified:
    - src/lang/module-files.ts
    - src/host-client/index.ts
    - src/host-client/host-client.test.ts
    - src/bin/gsd-atlas.ts
    - scripts/grammar.test.ts

key-decisions:
  - "Target resolution is one function (resolveTarget) with a single 'not an existing directory' branch, the extension point for plan 01-17's registry lookup by id"
  - "A failed lang test returns failEnvelope (data null) per the Envelope contract; the diagnostics carry the fixture name and the first differing capture, so no per-fixture list is lost that a user needs"
  - "A module with a missing or empty fixtures folder fails (fixture_unreadable) rather than passing with nothing tested"
  - "The report and the CLI output carry no parse-quality key; tests assert errorBytes, totalBytes, ratio, parseBudget and missingNodes never appear"

requirements-completed: [FND-11, FND-03]

duration: about 55 min
completed: 2026-10-15
---

# Phase 1 Plan 14: gsd-atlas lang test End to End Summary

**`gsd-atlas lang test <module folder>` runs the toy module from argv through the CLI adapter, in-process HostClient and Grammar Engine to golden comparison and exit codes, with hand-verified UTF-16, CRLF and BOM goldens and every failure mode reported as a diagnostic.**

## Performance

- Duration: about 55 minutes
- Tasks: 2 of 2, 2 task commits
- Full suite at the end: 692 tests passing; typecheck, lint and build clean. The built `dist/bin/gsd-atlas.js` also runs the toy module and exits 0.

## Accomplishments

- Tracer: `node src/bin/gsd-atlas.ts lang test test/fixtures/modules/toy` exits 0 and prints one envelope (`gsd-atlas.lang-test/1`) with four fixtures ok. The e2e test starts the real bin through `createRealRunner({ decide: allowAll })` (process.execPath) and parses stdout as exactly one JSON line.
- Hand-verified goldens (numbers typed in the test source from the fixture bytes, then compared with the engine-generated files; they agreed on the first generation, so no engine fix was needed):
  - emoji.toy: import string line 1 columns 4 to 10 (six UTF-16 units), definition name `héllo` line 2 columns 3 to 8, call target line 3 columns 2 to 6.
  - crlf.toy: identical spans to basic.toy for all six captures.
  - bom.toy: `hadBom: true`, name `a` at line 0 columns 3 to 4.
  - basic.toy: import `"lib/util"` 1:4-1:14, `main` 2:3-2:7, `helper` 3:2-3:8, `Widget` 5:5-5:11.
- Failure modes, each at process level with the right exit code and diagnostic, and no stack trace on stderr: golden mismatch (exit 2, `golden_mismatch` naming `emoji.toy`, `capture 0 field endColumn`, `expected 9, actual 10`), missing golden (2, `golden_missing`), tampered wasm (2, `wasm_hash_mismatch`), invalid manifest (2, `manifest_invalid`), folder without manifest (2, `manifest_unreadable`), unknown target (1, `module_not_found`), missing target, extra argument, unknown command and unsupported flag (1, no envelope on stdout).
- A module folder path with spaces works (all temp copies in the e2e test live under `toy copy N`).
- Threat T-01-37: fixtures and goldens are read through the confined reader. Tests cover a fixture symlink and a golden symlink pointing out of the module folder (`path_escape`, content never appears in the report), a fixture over the 2 MiB cap, and a fixture that is not valid UTF-8 (`fixture_unreadable`).
- D-02: the report and the stdout envelope contain none of `errorBytes`, `totalBytes`, `ratio`, `parseBudget`, `missingNodes` (asserted in the unit test and the e2e test).

## Task Commits

1. Task 1 (tracer): `c2339ad` feat(01-14): gsd-atlas lang test tracer from argv to exit code on the toy module
2. Task 2: `e8b0df7` test(01-14): UTF-16, CRLF and BOM goldens with hand-verified numbers and failure-mode exits

Tracer gate (interactive, `human_verify_mode` end-of-phase, automated-only verify): the tracer's `<verify>` command (36 tests, typecheck, lint) and the full `npm test` were re-run green after the commit before expanding to Task 2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] scripts/grammar.test.ts listed the whole fixtures folder**
- **Found during:** Task 1 (`npm test`)
- **Issue:** the 01-07 "commits exactly the generated files" test asserted the fixtures folder holds exactly four `.toy` files, so the new `basic.toy.golden.json` failed it.
- **Fix:** the listing now ignores `*.golden.json` (those belong to `lang test`); the byte-for-byte check of the generated fixtures is unchanged. `scripts/grammar-budget.ts` already excluded goldens.
- **Files modified:** scripts/grammar.test.ts
- **Commit:** c2339ad

**2. [Rule 2 - Missing critical functionality] Confined reads for fixtures and goldens**
- **Found during:** Task 1 design, against T-01-37 ("the confined reader is the only file access path")
- **Issue:** `confinedRead` in src/lang/module-files.ts was private and only knew the manifest, lock, wasm and query roles; reading fixtures with plain `fs` would have bypassed realpath containment and the size cap.
- **Fix:** added roles `fixture` (`fixture_unreadable`) and `golden` (`golden_missing`, `golden_invalid` when oversized) and exported `readModuleFile(moduleDir, relative, role)`. Both use the 2 MiB `GRAMMAR_LIMITS.sourceBytes` cap.
- **Files modified:** src/lang/module-files.ts, src/lang/index.ts
- **Commit:** c2339ad

### Judgement calls and plan wording

**3. crlf golden text is not byte-equal to basic's for the two multi-line captures.** The plan says the crlf golden "equals the basic.toy golden for every capture span and text". The definition captures contain the line breaks inside the fixture (`fn main {\r\n  helper();\r\n}` in crlf.toy), so their `text` necessarily contains `\r\n`. All six spans are identical; the test asserts spans equal and text equal after expanding `\n` to `\r\n`, and that the four single-line captures are identical.

**4. Extra diagnostic codes** beyond the plan's list, all non-crashing: `golden_invalid` (golden not JSON or over the cap), `invalid_args` (lang_test without a usable target), `lang_test_failed` (unexpected internal error caught inside the runner), CLI `internal_error` (client threw; exit 2, one line, no stack). `fixture_unreadable` is also used for a missing or empty fixtures folder.

**5. Fail envelope data is null.** `failEnvelope` is used as the plan says, so a failed run carries `data: null` and the diagnostics hold the details; an ok run carries the full report.

**6. toy-goldens.ts rewrites all fixtures' goldens** (not just one) and is exported as `writeGoldens(moduleDir)`; it is an author convenience only, as the plan states. During Task 1 I generated all four and removed the three that Task 2 owns before the first commit.

**7. TDD.** Both tasks were run red first (the tests failed on the missing goldens and modules) and then green; each task is one commit containing tests and implementation rather than separate test and feat commits, because the typecheck and lint hooks cannot pass on a red commit.

**8. Tooling note.** The worktree had no `.codegraph/` index and a repo hook routes reads of indexed source through CodeGraph; per the user's global CLAUDE.md I ran `codegraph init -y` in the worktree. `.codegraph/` is untracked and was not committed.

## Verification Evidence

- `node --test src/lang/** src/host-client/** src/cli/**` passes; `npm test` 692 pass, 0 fail; `npm run typecheck`, `npm run lint`, `npm run build` clean.
- `node src/bin/gsd-atlas.ts lang test test/fixtures/modules/toy` exit 0; `node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy` exit 0.
- `git ls-files --eol`: all four goldens are `i/lf w/lf attr/-text`; `crlf.toy` is `i/crlf`, `bom.toy` untouched (`test/fixtures/** -text` in .gitattributes).
- Windows: symlink-escape tests are skipped on win32 (creating symlinks needs elevated rights); the three-OS proof is the CI runs in plans 01-15 and 01-16.

## Threat Model Status

- T-01-37 (mitigate): fixtures and goldens use the realpath-confined, size-capped reader; symlink, oversize and invalid-UTF-8 cases tested. Manifest-referenced paths keep the plan 01-12 containment.

## Known Stubs

None.

## Threat Flags

None. No new network surface; the CLI reads only the module folder given on argv.

## Issues Encountered

None blocking. No hook demanded a confirmation phrase, and no timeout-shaped constant was introduced (the e2e spawns set no `timeoutMs`).

## Next Phase Readiness

Plan 01-17 extends the frozen surface: the `resolveTarget` branch in `src/lang/test-runner.ts` takes the registry lookup by id, `createInProcessHostClient` adds the `lang_list` kind (currently `unknown_kind`), and `runCli`/`src/bin/gsd-atlas.ts` gain the root flags and default roots. The existing cases `lang list` (usage error now) and unknown kinds are asserted in the current tests and will need updating there.

## Self-Check: PASSED

- Files: all files listed under key-files exist.
- Commits: c2339ad and e8b0df7 are ancestors of HEAD.
