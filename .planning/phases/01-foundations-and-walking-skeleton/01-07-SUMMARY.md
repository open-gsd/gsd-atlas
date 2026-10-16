---
phase: 01-foundations-and-walking-skeleton
plan: 07
subsystem: grammar-pipeline
tags: [tree-sitter, wasm, reproducible-build, grammar-lock, toy-language, sha256, web-tree-sitter]

requires:
  - phase: 01-01
    provides: package scaffold, exact pins (web-tree-sitter 0.27.1, tree-sitter-cli 0.27.1), .gitattributes with *.wasm binary and test/fixtures/** -text
  - phase: 01-04
    provides: Diagnostic kernel type and the test-kit makeTempDir helper
provides:
  - "Reproducible grammar pipeline: ensure-tree-sitter, grammar-build (--update-lock, --report), grammar-verify"
  - "grammar.lock schema (GrammarLockSchema, parseGrammarLock, diagnostic code lock_invalid)"
  - "Toy language module atlas_toy: grammar source, committed hash-pinned wasm, tags/refs/imports queries, byte-exact UTF-16, CRLF and BOM fixtures, negative fixture"
  - "Upstream-archive source support with archiveSha256 check and ordered git-apply patches (tested hermetically)"
  - "Throwaway three-OS hash-parity workflow"
affects: [01-12, 01-14, 01-15, 01-16, phase-02]

plan_head_before: ae258aa4bcf04b24b4cad53cf6d27e260eb3d536
plan_head_after: 31a859a16fb9e8cc6b1e5a1a8d87f29cebad9f00

actuals:
  tokens: 12600   # chars/4 over the 19 hand-written text files (50.5 KB); the 16 KB binary wasm is excluded
  tasks: 3
  commits: 4      # MEASURED: git rev-list --count ae258aa..HEAD before this SUMMARY commit

tech-stack:
  added: []
  patterns:
    - "Every script entry is guarded by comparing import.meta.url with the realpath of process.argv[1], so tests import helpers without triggering a build"
    - "Build in an os.tmpdir() mkdtemp directory, never in the repo; removed with rmSync maxRetries 5 / retryDelay 100"
    - "Fixtures that must keep exact bytes are generated as Buffers by a script and asserted byte for byte; they are never written with an editor"
    - "tar and git apply are spawned with argument arrays; tar gets relative paths and a cwd (GNU tar on Windows reads C: as a host)"

key-files:
  created:
    - scripts/ensure-tree-sitter.ts
    - scripts/grammar-build.ts
    - scripts/grammar-verify.ts
    - scripts/grammar.test.ts
    - scripts/toy-fixtures.ts
    - src/lang/grammar-lock.ts
    - src/lang/grammar-lock.test.ts
    - test/fixtures/modules/toy/grammar/grammar.js
    - test/fixtures/modules/toy/grammar/tree-sitter.json
    - test/fixtures/modules/toy/grammar.wasm
    - test/fixtures/modules/toy/grammar.lock
    - test/fixtures/modules/toy/queries/tags.scm
    - test/fixtures/modules/toy/queries/refs.scm
    - test/fixtures/modules/toy/queries/imports.scm
    - test/fixtures/modules/toy/fixtures/basic.toy
    - test/fixtures/modules/toy/fixtures/emoji.toy
    - test/fixtures/modules/toy/fixtures/crlf.toy
    - test/fixtures/modules/toy/fixtures/bom.toy
    - test/fixtures/modules/toy/fixtures-negative/broken.toy
    - .github/workflows/grammar-hash-parity.yml
  modified: []

key-decisions:
  - "Toy wasm sha256 pinned in grammar.lock: ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a (16237 bytes, ABI 15, CLI 0.27.1, built on darwin/arm64, Node 26.11.1)"
  - "Patch paths in grammar.lock are relative to the module directory (the lock's own directory); the plan left the base unspecified"
  - "Build and verify scripts cover both lock source types in one prepareSource, and patches apply to local sources too"
  - "buildModule returns bytes and hash from one temp build; grammar-verify calls it twice so the two builds land in two distinct mkdtemp directories"

patterns-established:
  - "Hash-pinned binary artifact: lock records sha256, npm test re-hashes the committed file on every OS, grammar:verify proves a rebuild reproduces it"
  - "Hermetic upstream-source test: the test builds its own tar.gz and patch, uses a file:// URL, and needs neither network nor wasi"

requirements-completed: [FND-04]

duration: 35min
completed: 2026-10-16
status: complete
---

# Phase 1 Plan 07: Grammar pipeline and toy language module Summary

**A grammar goes from pinned source to a committed, sha256-locked WASM through one lock-driven build script, with the tree-sitter CLI fetched explicitly and version-checked, a verify script that rebuilds twice and must reproduce the pinned hash, and a toy `atlas_toy` language module (queries plus byte-exact UTF-16, CRLF and BOM fixtures) ready for the engine plan.**

## Performance

- **Duration:** about 35 min
- **Tasks:** 3 (Task 1 tracer, Tasks 2 and 3 TDD)
- **Files created:** 20 (19 text, 1 binary wasm)

## Accomplishments

- Tracer (Task 1): `grammar-build` runs `tree-sitter generate --abi 15` then `build --wasm -o` in a temp directory, hashes the result and, with `--update-lock`, writes the wasm and the new hash into `grammar.lock`. Rebuilding without the flag reproduces the same hash (exit 0). Altering the expected hash in a copy makes the build exit 1 and print platform, both hashes and `run with --update-lock if this change is intentional`.
- `ensure-tree-sitter` runs `node_modules/tree-sitter-cli/install.js` only when the binary is absent (the one deliberate network fetch) and asserts the binary version equals web-tree-sitter, the package.json pin and the lock. `install.js` is referenced by no npm script.
- `grammar.lock` Zod schema rejects unknown keys, lockVersion 2, non-lowercase-hex or short hashes, absolute / drive-letter / backslash / NUL / `..` paths and non-https/file upstream URLs, all as `lock_invalid` diagnostics without throwing.
- The committed `grammar.wasm` is re-hashed against the lock inside `npm test` (so line-ending corruption is caught on every OS without the wasi toolchain), loads in web-tree-sitter as `atlas_toy` with ABI 15, and parses `fn a { }` with no ERROR node.
- Task 2: tags, refs and imports queries compile against the committed wasm and capture exactly `fn main`/`Widget` definitions, `helper` call and `"lib/util"` import from `basic.toy`. Fixtures are generated as Buffers by `scripts/toy-fixtures.ts` (emoji written as `\u{1F600}`); exact bytes, CRLF-only line breaks, the BOM and UTF-16 positions (string at line 1 columns 4 to 10, name at 2:3-8, call target at 3:2-6, BOM-stripped name at 0:3-4) are asserted. `broken.toy` sits in `fixtures-negative/` and parses with ERROR nodes. `git ls-files --eol` shows `i/crlf w/crlf attr/-text` for `crlf.toy`.
- Task 3: `grammar-verify` builds each module twice into two distinct temp directories and requires first build, second build, lock and the committed file's hash to agree, then loads the committed wasm and checks its ABI equals the lock. `prepareSource` for upstream sources verifies `archiveSha256` (`archive_hash_mismatch`), extracts with system `tar` and relative paths stripping one directory (honouring `subdir`), then applies each patch with `git apply` (`patch_failed` naming the patch). Hermetic tests build their own tar.gz and patch and run with no network and no wasi.
- `.github/workflows/grammar-hash-parity.yml` runs ubuntu, macos and windows, never fails on a hash difference, and prints `{platform, arch, node, cli, abi, sha256, bytes}` per OS via `--report`.

## Task Commits

1. **Task 1 RED: failing lock, CLI-version and committed-wasm tests** - `f4074ed` (test)
2. **Task 1 GREEN: pipeline tracer, lock schema, toy grammar, committed wasm** - `6a51f08` (feat)
3. **Task 2: queries and byte-exact fixtures** - `038ba33` (feat)
4. **Task 3: verify, upstream archives with patches, parity workflow** - `31a859a` (feat)

## Verification

- `node --test src/lang/grammar-lock.test.ts scripts/grammar.test.ts` passes without the wasi toolchain.
- `npm test`: 124 tests, 0 failed, 0 skipped.
- `node scripts/grammar-verify.ts`: exit 0, `atlas_toy: verified sha256 ffe6c2ed...0f9a (abi 15, cli 0.27.1)`.
- `npm run typecheck`: exit 0. `npm run lint` not run: `eslint src` has no config until plan 01-03 (same wave); the plan defers lint to the wave gate.
- Tracer gate: `<verify>` re-run end to end after Task 1 (lock and grammar tests plus a rebuild reproducing the pinned hash) before expanding to Tasks 2 and 3.

## Deviations from Plan

None - plan executed as written. Two plan-ambiguity choices are recorded under key-decisions (patch path base, patches also applied to local sources); neither changes a stated behaviour.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. The only new trust-boundary surface (CLI binary fetch, wasi-sdk/binaryen download, upstream archive fetch) is already covered by T-01-15, T-01-16 and T-01-17. T-01-15 is mitigated: the hash is checked by `npm test` on every OS, by `grammar:verify`, and (later) at load by the Grammar Engine. T-01-16 residual stays accepted as written: the CLI and toolchain binaries come over https without a per-asset hash.

## Notes for downstream plans

- Plan 01-15 compares the per-OS parity-workflow hashes with `ffe6c2edbbd5cb905f70f98a31ce17c354e6ec4da263bcc3e5aa70d52e1a0f9a`; this value was observed only on darwin/arm64 (assumption A1 is still unverified on Linux and Windows). Assumption A2 (Windows `tar.exe` with `--strip-components`, cache location) is also first exercised in CI; the hermetic upstream test and the workflow are the checks.
- Plan 01-12 consumes the node and field names (`source_file`, `use_stmt.path`, `definition.kind/name`, `call_stmt.target`) and capture names (`@definition.function`, `@definition.type`, `@name`, `@reference.call`, `@import.path`). BOM handling: the engine strips a leading BOM before parsing; the toy grammar's whitespace extra would also absorb it.
- The `grammar:budget` npm script still points at `scripts/grammar-budget.ts`, which belongs to plan 01-12.
- `.codegraph/` was created in the worktree by `codegraph init -y` (per the user's worktree rule) and is untracked; it was never staged.
- The `eslint src` boundary lint will need to ignore or accept `src/lang/` when plan 01-03 lands; `src/lang/` has no `index.ts` yet (the plan did not list one).

## Self-Check: PASSED

- All 20 files listed under key-files.created exist.
- Commits f4074ed, 6a51f08, 038ba33 and 31a859a are all present in `git log ae258aa..HEAD`.
