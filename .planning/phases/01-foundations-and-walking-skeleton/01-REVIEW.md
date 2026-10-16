---
phase: 01-foundations-and-walking-skeleton
reviewed: 2026-10-15T00:00:00Z
depth: standard
files_reviewed: 71
files_reviewed_list:
  - src/command-runner/real.ts
  - src/command-runner/decide.ts
  - src/command-runner/git-spec.ts
  - src/command-runner/env.ts
  - src/command-runner/exec-resolve.ts
  - src/command-runner/spec.ts
  - src/command-runner/fake.ts
  - src/command-runner/index.ts
  - src/source-tree/real.ts
  - src/source-tree/fake.ts
  - src/source-tree/types.ts
  - src/source-tree/validate.ts
  - src/source-tree/index.ts
  - src/sqlite/open.ts
  - src/sqlite/wrap.ts
  - src/sqlite/node-sqlite.ts
  - src/sqlite/better-sqlite3.ts
  - src/sqlite/normalize.ts
  - src/sqlite/driver.ts
  - src/sqlite/errors.ts
  - src/sqlite/index.ts
  - src/fact-store/types.ts
  - src/fact-store/errors.ts
  - src/fact-store/index.ts
  - src/facts/file-facts.ts
  - src/facts/span.ts
  - src/facts/resolution.ts
  - src/facts/answer.ts
  - src/facts/request.ts
  - src/facts/degraded.ts
  - src/facts/diagnostic.ts
  - src/facts/clock.ts
  - src/grammar-engine/load.ts
  - src/grammar-engine/engine.ts
  - src/grammar-engine/measure.ts
  - src/grammar-engine/normalize.ts
  - src/grammar-engine/query.ts
  - src/grammar-engine/with-tree.ts
  - src/grammar-engine/limits.ts
  - src/grammar-engine/check.ts
  - src/grammar-engine/fake.ts
  - src/grammar-engine/types.ts
  - src/grammar-engine/errors.ts
  - src/governor/types.ts
  - src/governor/fake.ts
  - src/governor/noop.ts
  - src/governor/validate.ts
  - src/precise-resolver/stub.ts
  - src/precise-resolver/index.ts
  - src/lang/module-files.ts
  - src/lang/registry.ts
  - src/lang/grammar-lock.ts
  - src/lang/manifest.ts
  - src/lang/golden.ts
  - src/lang/test-runner.ts
  - src/host-client/in-process.ts
  - src/cli/index.ts
  - src/bin/gsd-atlas.ts
  - src/test-kit/git-repo.ts
  - src/test-kit/tmpdir.ts
  - src/test-kit/fake-clock.ts
  - scripts/grammar-build.ts
  - scripts/grammar-verify.ts
  - scripts/ensure-tree-sitter.ts
  - scripts/grammar-budget.ts
  - scripts/corpus.ts
  - scripts/adr.ts
  - scripts/toy-goldens.ts
  - eslint.config.js
  - .github/workflows/ci.yml
  - package.json
findings:
  critical: 2
  warning: 14
  info: 10
  total: 26
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-10-15
**Depth:** standard (with executed reproductions for every Critical and most Warning claims)
**Files Reviewed:** 71 (production sources, scripts, eslint, CI and package config)
**Status:** issues_found

## Summary

The structure is sound: `shell: false` everywhere, an argument-array-only spawn path, Windows shim rejection that holds, parameterised SQL with allowlisted pragmas, realpath-confined module reads, a hash gate before `Language.load`, and CI that is SHA-pinned, `contents: read`, `persist-credentials: false` and `pull_request`-only. I found no problems in SQL parameter binding, the NUL self-test, transaction and savepoint handling, or the `exec-resolve.ts` Windows rules.

The weak area is the one the project cares about most: the "a hostile repository runs nothing" guarantee (FND-06). Two independent ways for a repo-controlled `.git/config` to execute a command through the production `gitSpec` path were reproduced (CR-01, CR-02). Both slip past the neutralisation that `git-spec.ts` documents as complete. The `decide` gate is also looser than its doc comments claim (WR-01).

Every Critical and most Warning findings were reproduced with scratch scripts against git 2.54.0 and the worktree sources. The scripts are in the session scratchpad and are not committed.

Not reported, per instructions: the unset 60 s `CommandRunner` timeout, the unset 5000 ms SQLite busy timeout, per-platform Windows wasm hashes, stale Node 24.15 mentions in docs.

## Critical Issues

### CR-01: A repo-controlled promisor remote makes `hasObject` and `read` run an attacker-chosen command

**File:** `src/command-runner/git-spec.ts:81-100` (no lazy-fetch or transport guard), reached from `src/source-tree/real.ts:182-195`
**Issue:** `gitSpec` neutralises `core.fsmonitor`, `core.hooksPath` and filter drivers, but a repository can also configure `extensions.partialClone` and `remote.<name>.promisor=true`. When `cat-file` is asked for an object that is not present, git performs a lazy fetch. That spawns the configured transport, so `core.sshCommand` in the same `.git/config` runs.

`SourceTree.hasObject(hash)` and `read(commit, path)` both run `cat-file` against caller-supplied ids that may legitimately be absent. For example, the Fact Store `collect` path calls `gitHas` for retired blobs.

Reproduced end to end with the real `createRealRunner` and `createSourceTree`. A temp repo had this config:
- `extensions.partialClone=origin`
- `remote.origin.promisor=true`
- `remote.origin.url=ssh://example.invalid/x.git`
- `core.sshCommand=sh -c 'touch MARKER; exit 1' --`

Calling `tree.hasObject('1234567890abcdef1234567890abcdef12345678')` returned `false`, and `MARKER` was created. This is the same threat model (hostile `.git/config`) that the file header cites for filters and fsmonitor, so the "hostile repo runs nothing" claim is currently false.

**Fix:** Forbid lazy fetch and network transports for every spec built by `gitSpec`. Both of these were verified to stop the command from running:
```ts
// git-spec.ts, in gitSpec()
const env: Record<string, string> = {
  ...opts.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',      // git >= 2.44: never fetch missing promisor objects
  GIT_ALLOW_PROTOCOL: 'none',  // belt and braces: no transport may start
};
```
Add a hostile-repo test with a promisor config plus `core.sshCommand` that asserts the marker is absent. Consider an `env.ts` denylist entry for inherited `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND` and `GIT_EXTERNAL_DIFF`.

### CR-02: A filter driver whose name contains `=` is never neutralised, so its `clean` command runs during `hash-object`

**File:** `src/command-runner/git-spec.ts:54-65` (`parseFilterNames`), `:40-47` (`neutraliseFilters`); `src/command-runner/decide.ts:40` (`GIT_FILTER_KEY`)
**Issue:** `parseFilterNames` cuts each `--name-only` line at the first `=`. `--name-only` prints bare keys, so a driver named `a=b` yields the line `filter.a=b.clean`. The code reads that as key `filter.a`, finds `lastDot <= 'filter.'.length`, and silently drops it. Even if it were parsed, `-c filter.a=b.clean=` cannot express the name, because git splits `-c` at the first `=`. `decide.ts` also refuses such keys through `[^=\s]+`.

Reproduced. `.gitattributes` held `*.txt filter=a=b`, and `.git/config` held `filter."a=b".clean = "touch MARKER; cat"`. `git config --name-only --get-regexp '^filter\.'` printed `filter.a=b.clean`. `hash-object --stdin-paths` ran the command, both with no override and with `-c filter.a=b.clean=`. So `SourceTree.snapshot()` runs repo-controlled code on a hostile repo.

The config-key trick works for "unknown" drivers too: any name the parser cannot represent is a bypass.

**Fix:** Fail closed, and use an override channel that can express any key. `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (git >= 2.31) was verified to neutralise the `a=b` driver. Note that `env.ts` strips an inherited `GIT_CONFIG_COUNT`, but a spec-level overlay is applied after the scrub, so it survives.
```ts
// git-spec.ts: emit every neutralisation through the env, not -c
function neutraliseViaEnv(names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  let n = 0;
  for (const name of names) {
    for (const [k, v] of [['clean', ''], ['smudge', ''], ['process', ''], ['required', 'false']] as const) {
      env[`GIT_CONFIG_KEY_${n}`] = `filter.${name}.${k}`;
      env[`GIT_CONFIG_VALUE_${n}`] = v;
      n += 1;
    }
  }
  env['GIT_CONFIG_COUNT'] = String(n);
  return env;
}
```
Parse names with `line.slice('filter.'.length, line.lastIndexOf('.'))` (do not split on `=` for `--name-only` output). `decide` must then permit the `GIT_CONFIG_*` env path, or the regex must drop `[^=\s]`. Add a hostile-repo test with a driver named `a=b`.

## Warnings

### WR-01: `decide` option denylist is bypassable and does not require the safety overrides it exists to enforce

**File:** `src/command-runner/decide.ts:43` (`GIT_DENIED_OPTIONS`), `:58-86` (`matchGit`)
**Issue:** Four problems were reproduced against the real `decide`:
1. The denylist matches whole arguments, but git's option parser accepts bundled short options. `hash-object -wt blob --stdin` is `-w` in disguise. It was allowed, and it wrote an object (count-objects went 3 to 4).
2. Git accepts unambiguous long-option abbreviations. `cat-file --textc HEAD:a` is `--textconv`, which runs a repo-configured textconv driver. It was allowed and ran.
3. `rev-list --output=/path` is a diff-family option that writes an arbitrary file. `rev-list` is on the allowlist and the call was allowed; the file was created. `rev-list --alternate-refs` is also allowed, and that option executes `core.alternateRefsCommand`.
4. A raw `hash-object --stdin-paths` with no `-c` overrides at all is allowed. `decide` only vets `-c` values when present; it never requires `core.fsmonitor=false`, `hooksPath` or the filter neutralisation. The safety property lives only in `gitSpec`, so any other caller of a `builtinId: 'git'` spec bypasses it.

No current call site puts untrusted text in an option position, so this is latent. But `decide` is documented as the single reviewable policy gate.

**Fix:** Switch to a per-subcommand allowlist of exact option strings (reject anything starting with `-` that is not on the list, and reject bundled short flags). Make `matchGit` require the three mandatory `-c` overrides and `GIT_NO_LAZY_FETCH`.

### WR-02: Snapshot hashes files reached through a symlinked parent directory, contradicting "a symbolic link is never followed"

**File:** `src/source-tree/real.ts:116-119`
**Issue:** Only the last path component is `lstat`-ed. If a parent directory of an index entry is a symlink, the file is classified `ok` and `hash-object` follows the link.

Reproduced. `d/f.ts` was staged, then `d/` was replaced by a symlink to a directory outside the repo. `lstat('d/f.ts')` reported a regular file and `hash-object` returned the blob id of the out-of-tree file. A later consumer that reads content by this path would read outside the worktree.

**Fix:** Resolve the parent: `fs.realpath(path.dirname(abs))` must equal `realWorktree + sep + dirname(rel)`, or compare `realpath(abs)` against `realWorktree`. Skip with `symlink_skipped`.

### WR-03: One vanished or unreadable file aborts the entire snapshot

**File:** `src/source-tree/real.ts:148-168`
**Issue:** The comment at line 107 says unhashable paths are skipped "instead of failing the batch", but `hash-object --stdin-paths` dies on the first unopenable path. A file deleted between the `lstat` pass and the hash call (normal under an editor or formatter), or a file with mode 000, makes git exit 128 mid-batch. `gitText` then throws `git_failed` and the whole snapshot is lost.

Reproduced: a batch of `f0.txt`, `missing.txt`, `f1.txt` returned exit 128, emitted one id, and wrote `fatal: could not open 'missing.txt'`. On a large repo this makes indexing flaky.

**Fix:** On a failed batch, bisect or retry per path to isolate the offender. Alternatively hash in chunks, and on failure re-run the failing chunk one path at a time, skipping with a `missing_on_disk` or `unhashable_path` diagnostic.

### WR-04: `probe()` treats every non-zero exit as "object not found"

**File:** `src/source-tree/real.ts:173-180`, consumed by `hasObject` (`:182`) and `read` (`:188`)
**Issue:** Exit 128 is returned for "not found", but also for "not a git repository", "dubious ownership" (`safe.directory`), a corrupt object database and a missing `repoDir`. These become `false` and `null`.

Reproduced: `createSourceTree({ repoDir: <non-repo> }).read('HEAD', 'a.txt')` returned `null`, and `hasObject(...)` returned `false`. For the Fact Store's collection rule (`gitHas`), a false negative on an environment failure means retired facts are collected while git still needs them.

**Fix:** Distinguish by stderr or by a preflight. For `cat-file -e`, exit 1 means missing and any other non-zero is an error. For `read`, check `rev-parse --verify` first, or parse stderr for the `does not exist` and `exists on disk, but not in` phrases and throw `git_failed` for everything else.

### WR-05: `rootCommit`, and therefore `storeId`, changes when a shallow clone is deepened

**File:** `src/source-tree/real.ts:199-203`
**Issue:** In a shallow clone, `rev-list --max-parents=0 HEAD` returns the shallow boundary commit. Reproduced with a 3-commit repo: the true root was `2b888c8`, a `--depth 1` clone reported `bb6951a`, and after `fetch --deepen 1` it reported `7c9ac42`. The store id hashes that value, so each deepen orphans the previous store, and the clone never matches the full clone. `SourceTreeIdentity` documents the id as stable across clones.

**Fix:** Detect shallowness (`rev-parse --is-shallow-repository`) and either fall back to an identity not derived from the root commit (for example the realpath of the common dir plus the remote URL), or expose `shallow: true` and let the caller decide. Document the behaviour in `types.ts`.

### WR-06: A module that lists the same extension twice collides with itself

**File:** `src/lang/registry.ts:323-340` (`settleExtensions`)
**Issue:** `theirs = owner.get(key)` can be `mine` itself. The manifest does not de-duplicate `extensions` and the key is lower-cased, so `[".ts", ".TS"]` or `[".ts", ".ts"]` is valid.

Reproduced: a single valid module declaring `[".ts", ".TS"]` produced an `extension_collision` **error** ("claimed by both toy ... and toy ...") and listed `.TS` in `inactiveExtensions`. This contradicts the language-modules ADR (collisions are between modules).

**Fix:** `if (theirs === mine) continue;` (or `theirs.entry.name === mine.entry.name`). Also add a manifest-level check that rejects case-insensitive duplicates.

### WR-07: `symbolKey` can collide, and its comment misstates why it cannot

**File:** `src/facts/resolution.ts:52-65`
**Issue:** The comment says NUL "can not occur in a file path, so fields can not run into each other". But `qualifiedName`, `kind` and `discriminator` are source-derived text, and the project's own SQLite self-test exists precisely because source text can contain NUL. Reproduced: `{qualifiedName:'a\0b', kind:'k'}` and `{qualifiedName:'a', kind:'b\0k'}` produce identical keys. Identity collisions silently merge two symbols.

**Fix:** Use an unambiguous encoding: `JSON.stringify([repo, path, qualifiedName, kind, discriminator ?? null])`, or length-prefix each field. Same fix for `siteId` in `src/precise-resolver/stub.ts:19-25` if it should be robust.

### WR-08: `validateFileFacts` is the only gate before a commit but checks spans and `parse` only

**File:** `src/facts/file-facts.ts:85-138`
**Issue:** `types.ts` says this validation "must pass before the writer commits". It does not check `contentHash`, `module` or `grammarVersion` (type or non-emptiness), symbol `name`/`kind`, `path` non-emptiness, `symbols[].parent` (index range, self-reference, cycles), or `errorBytes <= totalBytes`.

Reproduced: `{path:'', contentHash:42, module:null, grammarVersion:undefined, symbols:[{span:ok, parent:99}], parse:{errorBytes:10,totalBytes:1}}` returns zero diagnostics. `contentHash` keys the store, and `module`/`grammarVersion` drive `markStale`, so a bad value corrupts overlay and staleness logic.

**Fix:** Validate each remaining field, with `parent` required to be an integer in `[0, index)` (forward refs are what create cycles).

### WR-09: Untrusted repo text is written raw to the terminal

**File:** `src/cli/index.ts:91-95` (and `:87`)
**Issue:** The CLI prints `d.message` verbatim to stderr. Messages embed repo-controlled strings: unrecognised manifest key names, `JSON.parse` error snippets, fixture and module folder names. Reproduced: a manifest key `"\u001b]0;pwned\u0007evil"` yields the message `"\u001b]0;pwned\u0007evil: Unrecognized key: ..."` with the raw ESC and BEL bytes, and a JSON syntax error echoes `\u001b[2J` from the file. Running `gsd-atlas lang list` in a cloned hostile repo can set the terminal title, clear the screen or rewrite earlier lines. The stdout envelope is safe (`JSON.stringify` escapes). The project states repo text is fenced as untrusted.

**Fix:** Strip or escape C0/C1 control characters (except `\n`) in the stderr writer, e.g. `message.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))`.

### WR-10: The Grammar Engine has no time or work bound on untrusted grammars and queries

**File:** `src/grammar-engine/with-tree.ts:14`, `src/grammar-engine/query.ts:22`, `src/grammar-engine/engine.ts:44`
**Issue:** `parser.parse(source)` is called with no `progressCallback`, and `query.captures(root)` with no `matchLimit`, `maxStartDepth` or `progressCallback`, although web-tree-sitter 0.27.1 supports all of them (checked in `web-tree-sitter.d.ts`: `ParseOptions.progressCallback`, `QueryOptions.matchLimit/maxStartDepth/progressCallback`). `run` is synchronous on the main thread. Repo-supplied modules (highest precedence) supply both the wasm and the query text, so a pathological query or a slow scanner stalls the whole process. The 2 MiB source cap bounds input only.

**Fix:** Pass a deadline-based `progressCallback` to `parse`, and set `matchLimit` plus a progress callback on `captures`. Treat a cancelled parse or an exceeded limit as `GrammarRunError('parse_failed' | 'query_limit')`. A WASM loop inside an external scanner cannot be interrupted this way, so the later worker-pool phase should run grammars in a terminable `worker_threads` worker.

### WR-11: A `timeoutMs` above 2^31-1 kills the child after about 1 ms

**File:** `src/command-runner/real.ts:262-271`
**Issue:** The guard is `Number.isFinite(limit) && limit > 0`, but Node's `setTimeout` clamps values above 2147483647 to 1 ms. Reproduced: `timeoutMs: 3e9` gave `TimeoutOverflowWarning`, `timedOut: true` and a 1 ms run. A caller passing a "very long" timeout gets the opposite. (This is separate from the accepted decision to leave the default timeout unset.)

**Fix:** Clamp: `const ms = Math.min(limit, 2 ** 31 - 1)`, or reject out-of-range values with a spawn error.

### WR-12: `openDatabase` ignores the result of `journal_mode=WAL` but then sets `synchronous=NORMAL`

**File:** `src/sqlite/open.ts:134-138`
**Issue:** `PRAGMA journal_mode=WAL` returns the mode actually in effect, and silently returns `delete` when WAL is unavailable (network or WSL mounts, or a read-only media flag). `synchronous=NORMAL` is only durable-safe with WAL; in rollback-journal mode a power loss can corrupt the database. The code discards the return value and proceeds.

**Fix:** For file databases, check `String(db.pragma('journal_mode','WAL')).toLowerCase() === 'wal'`. If not, either keep `synchronous=FULL` and surface a degraded-mode diagnostic, or throw a typed error.

### WR-13: The grammar CI job executes a downloaded binary that has no integrity check

**File:** `scripts/ensure-tree-sitter.ts:59-69`
**Issue:** `install.js` from `tree-sitter-cli` downloads the release binary from GitHub (it contains no checksum or hash code; confirmed by grep). The script then runs it, and its only validation is the version string the binary reports about itself, which a swapped binary can forge. It also builds the committed wasm artifacts. The wasm hash lock would catch a tampered build later, but only after the untrusted binary has executed in CI with the runner's environment. `npm ci --ignore-scripts` was chosen deliberately, so this re-introduces the install-script trust it avoids.

**Fix:** Pin the expected sha256 of the binary per platform in the repo (next to `cli.version`) and verify before executing. Alternatively use an npm optional-dependency platform package with registry integrity.

### WR-14: `grammar-budget` reads fixtures outside the "one confined reader"

**File:** `scripts/grammar-budget.ts:54-65, 90`
**Issue:** `module-files.ts` declares itself "the one confined reader for language-module files", with realpath containment and size caps. The budget gate instead does `readdirSync(path.join(moduleDir, 'fixtures'))` and `readFileSync(...)`. If `fixtures/` is a symlink out of the module, its contents are read (the `entry.isFile()` comment only protects individual entries). There is no size cap, and invalid UTF-8 is silently replaced, unlike `lang test`, which uses a fatal decoder. The budget can therefore disagree with `lang test` on the same bytes.

**Fix:** List with `readdirSync` as now, but read each file through `readModuleFile(moduleDir, rel, 'fixture')` and decode with the same fatal, `ignoreBOM` decoder as `test-runner.ts`.

## Info

### IN-01: `openGrammar` throws an untyped error on ABI mismatch and never frees the `Language`

**File:** `src/grammar-engine/engine.ts:18-24`
**Issue:** `parser.setLanguage` throws a plain `Error` ("Incompatible language version") for an ABI outside the runtime's range (checked in `web-tree-sitter.cjs`). It is re-thrown raw, so `errors.ts`'s claim "load problems are typed values" does not hold, and `test-runner` reports it as `lang_test_failed`. `GrammarLoadErrorCode` has no `abi_incompatible`.
**Fix:** Catch it in `openGrammar` and throw `GrammarLoadError('wasm_invalid' | 'abi_incompatible', ...)`.

### IN-02: better-sqlite3 `run()` on a statement with `RETURNING` reports `changes: 0`

**File:** `src/sqlite/better-sqlite3.ts:66-70`
**Issue:** The `stmt.reader` branch calls `all()` and returns `{ changes: 0, lastInsertRowid: 0 }`, while node:sqlite returns the real counts. The "kit behaves like node:sqlite" claim fails for `INSERT ... RETURNING`.
**Fix:** After `all()`, query `changes()` and `last_insert_rowid()`, or document the divergence in the contract and add a case to the shared suite.

### IN-03: `better-sqlite3` is an exact-pinned peer dependency

**File:** `package.json` (`peerDependencies`: `"better-sqlite3": "13.0.3"`)
**Issue:** An exact peer range produces `ERESOLVE` or peer warnings for any user with another 13.x. The STACK note says "exact in CI, optional peer".
**Fix:** Keep the devDependency exact; use `"^13.0.3"` for the peer.

### IN-04: `lang test` lists non-fixture files as fixtures, and the golden writer filters differently

**File:** `src/lang/test-runner.ts:102-105`, `scripts/toy-goldens.ts:31`
**Issue:** `listFixtures` includes every non-directory entry except `*.golden.json`, so `.DS_Store`, editor backups and symlinks are tested and fail with "not valid UTF-8" or `golden_missing`. `toy-goldens` uses `entry.isFile()` (excludes symlinks) with a different golden-suffix test (`endsWith('.golden.json')` vs `GOLDEN_SUFFIX`). The generator and the checker can disagree about the fixture set.
**Fix:** Share one listing function. Filter to files whose extension the manifest claims, as `grammar-budget` does.

### IN-05: A failing `lang_test` drops the per-fixture results

**File:** `src/host-client/in-process.ts:88-92`
**Issue:** `failEnvelope` sets `data: null`, so `fixtures[]` (which passed, which failed) is lost exactly when it is most useful. Only diagnostics survive.
**Fix:** Allow a failing envelope to carry `data` (the contract says "null when ok is false", so change it), or return `ok: true` with `data.ok: false`.

### IN-06: `allowAll` is exported from the production barrel

**File:** `src/command-runner/index.ts:21`, `src/command-runner/decide.ts:126-129`
**Issue:** "TEST-ONLY: never pass this to a runner that serves a real repo" is enforced by a comment. `createRealRunner({ decide: allowAll })` disables every guard in this review's scope.
**Fix:** Move it to a test-only entry (for example `command-runner/testing.ts` excluded from `tsconfig.build.json`), or require an explicit `unsafeDisablePolicy: true` option.

### IN-07: Lock fields `name`, `abi` and `wasm.file` are not cross-checked at load time

**File:** `src/lang/module-files.ts:197-241`
**Issue:** The engine input uses `lock.name` (not `manifest.name`), reads `manifest.grammar.wasm`, and hashes it against the hash recorded for `lock.wasm.file`. Mismatches surface only as a hash error if the bytes differ. `lock.abi` is only compared in `grammar-verify.ts`, never at runtime. Separately, the wasm hash gate verifies integrity against the module's own lock only. That is fine for corruption but gives no authenticity for repo or user modules, which the trust-boundaries ADR accepts because the WASM is sandboxed; it deserves one line in the module docs so it is not read as a signature.
**Fix:** Warn when `lock.name !== manifest.name` or `lock.wasm.file !== manifest.grammar.wasm`, and compare `lock.abi` with `language.abiVersion` in `compileGrammar`.

### IN-08: `REPO_PATTERN` accepts `.` and `..` segments

**File:** `scripts/corpus.ts:12`
**Issue:** `[A-Za-z0-9_.-]+` matches `..`, so `../..` is a valid "owner/name" and becomes `gh api repos/../../commits/<sha>` in `corpus-check.ts`. Low risk (committed file, read-only call), but the validator's intent is a GitHub slug.
**Fix:** Require the first character to be alphanumeric and reject `..` (for example `^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$` plus `!repo.includes('..')`).

### IN-09: Network fetch and CI concurrency details

**File:** `scripts/grammar-build.ts:139-143`, `.github/workflows/ci.yml:12-14`
**Issue:** (a) `fetch(url)` for upstream archives has no timeout and no size cap before `arrayBuffer()`, so a stalled or oversized response ties up the job until the 30-minute job limit. The sha256 pin makes this a robustness problem only. (b) `cancel-in-progress: true` is keyed on `github.ref`, so a push to `main` cancels the previous `main` run, and a commit can land with no completed CI result. (c) The `actions/cache` key is a fixed string with no hash input.
**Fix:** Use `AbortSignal.timeout(...)` and check `content-length`. Make `cancel-in-progress` conditional on `github.event_name == 'pull_request'`. Include a version file in the cache key.

### IN-10: `grammar-budget` ignores MISSING nodes

**File:** `scripts/grammar-budget.ts:90-95, 105`
**Issue:** `measureErrors` reports `missingNodes` separately, but the CI gate sums only `errorBytes`. A grammar that repairs most input with zero-width MISSING nodes passes the budget. This matches "D-06" as written, but the parse-quality number it implies is one-sided.
**Fix:** Either fail or warn when `missingNodes / files` exceeds a threshold, or record the decision in the ADR addendum so it is not mistaken for an omission.

---

_Reviewed: 2026-10-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
