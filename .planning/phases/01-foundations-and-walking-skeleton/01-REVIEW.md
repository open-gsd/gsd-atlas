---
phase: 01-foundations-and-walking-skeleton
reviewed: 2026-10-15T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/command-runner/decide.test.ts
  - src/command-runner/decide.ts
  - src/command-runner/git-spec.test.ts
  - src/command-runner/git-spec.ts
  - src/command-runner/hostile-repo.test.ts
  - src/command-runner/index.ts
  - src/source-tree/source-tree.test.ts
findings:
  critical: 1
  warning: 3
  info: 3
  total: 7
status: issues_found
---

# Phase 01: Code Review Report (re-review after gap closure 01-18 and 01-19)

**Reviewed:** 2026-10-15
**Depth:** standard, with executed reproductions against git 2.54.0 and the real `createRealRunner` / `createSourceTree` / `decide`
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Gap-closure verdicts on the two Criticals of the prior review:

- **Prior CR-01 (promisor remote lazy fetch runs `core.sshCommand`): CLOSED.** `gitSpec` pins `GIT_NO_LAZY_FETCH=1` and `GIT_ALLOW_PROTOCOL=none` after the caller env (`git-spec.ts:108-151`), drops case variants of the pins, and `decide` now refuses any git spec (other than bare `--version`) that lacks the pins, the three `-c` overrides, or has a malformed config channel. The hostile-repo promisor tests ran with their positive controls firing (no skips) and pass.
- **Prior CR-02 (filter driver named `a=b` never neutralised): CLOSED for the cases it named, but the class is NOT closed.** `a=b`, `a=b=c`, `my.driver`, the empty name and a driver that sets `filter.<n>.process` are all neutralised through the `GIT_CONFIG_COUNT` channel (reproduced: process and clean markers absent). A driver name that is not valid UTF-8 still runs its clean command (new CR-01 below). The "there is NO allowlist and EVERY driver is neutralised, whatever it is called" claim in `git-spec.ts:13-18` and `:60` is therefore still false.

The fixes introduced one regression-class issue (WR-01: builder/gate disagree for names containing CR, which turns a hostile repo into a permanent snapshot denial). The rest of the prior WR-01 (denylist bypasses) was not part of these plans and remains open.

Verification run: `node --test` on the four test files, 163 pass, 0 fail, 0 skipped; `tsc --noEmit` and `eslint` on the 7 files are clean.

## Critical Issues

### CR-01: A filter driver whose name is not valid UTF-8 escapes neutralisation and its `clean` command runs

**File:** `src/command-runner/git-spec.ts:208` (`new TextDecoder().decode(result.stdout)`), `:62-75` (`neutraliseFilters`), `:84-93` (`parseFilterNames`)
**Issue:** `listFilterNames` decodes the `git config --name-only` bytes with a non-fatal `TextDecoder`, so an invalid byte becomes U+FFFD. `neutraliseFilters` then puts the decoded name in `GIT_CONFIG_KEY_n`, and Node encodes the env string as UTF-8, producing `EF BF BD`. Git compares bytes, so the neutralising key names a different driver than the one configured. Node also cannot place arbitrary bytes in a child environment at all, so the env channel cannot express such a name even if decoding were exact.

Reproduced end to end with the production `createSourceTree` over `createRealRunner()` (default `decide`): `.gitattributes` `a.txt filter=a\xffb`, `.git/config` `[filter "a\xffb"] clean = '<node>' '<touch script>' MARK`. `snapshot()` resolved normally and `MARK` was created. Control runs: a plain name and a tab-containing name did not run the command. Because `.gitattributes` and `.git/config` are repo-controlled bytes, the "hostile repository runs nothing" guarantee (FND-06, ROADMAP SC4) is still broken, by the same mechanism as the prior CR-02 ("a name the parser cannot represent is a bypass").

**Fix:** Fail closed on any name that cannot round-trip, in `listFilterNames`:
```ts
const raw = result.stdout;
const text = new TextDecoder('utf-8', { fatal: true }); // throws on invalid UTF-8
let decoded: string;
try { decoded = text.decode(raw); }
catch { throw new GitConfigError('filter_enumeration_failed', 'a filter driver name is not valid UTF-8 and cannot be neutralised'); }
```
Also reject names with U+FFFD, and (WR-01) any name `decide` would refuse, with the same typed error, so the failure is explicit rather than a denial at the hash step. Add a hostile-repo test with a `\xff` driver name (write `.git/config` and `.gitattributes` as Buffers) asserting no marker and a `filter_enumeration_failed` rejection. Correct the header claims that every driver is neutralised "whatever it is called".

## Warnings

### WR-01: Builder and gate disagree for a driver name containing CR, so a hostile repo permanently breaks `snapshot()`

**File:** `src/command-runner/decide.ts:90` (`FILTER_ENV_KEY` excludes `\r`), `src/command-runner/git-spec.ts:62-75`
**Issue:** `decide` refuses a channel key whose driver name contains CR, but `neutraliseFilters` emits it unchanged, and git config permits a literal CR inside a quoted subsection. Reproduced: a `[filter "a\rb"]` section makes `snapshot()` throw `git hash-object --stdin-paths failed: ... was not started: it is not a first-party built-in`. That is fail-closed, which is the right direction, but it surfaces as a misleading denial, any repository can DoS its own indexing, and it contradicts the test titled "builder and gate agree" (`git-spec.test.ts:152`), which only covers a short list of names. The same shape applies to a very large number of drivers or very long names (env block limits: 32767 characters on Windows, 128 KiB per string on Linux), which end as an opaque spawn error.
**Fix:** Make `listFilterNames` the single place that validates names (same predicate as `FILTER_ENV_KEY`, plus the UTF-8 check from CR-01) and throw `GitConfigError('filter_enumeration_failed', ...)` naming the offending driver. Export the predicate from one module so builder and gate cannot drift, and test with CR, tab, leading/trailing space and a long name.

### WR-02: Prior WR-01 is still open: the `decide` option denylist is bypassable through the production gate

**File:** `src/command-runner/decide.ts:43` (`GIT_DENIED_OPTIONS`), `:171-172`
**Issue:** The denylist matches whole arguments only. Re-verified against the current `decide` with specs built by `gitSpec`:
- `cat-file --textc HEAD:a.txt` and `cat-file --text ...` (abbreviations of `--textconv`) are allowed and ran a repo-configured `diff.<driver>.textconv` command (marker created). `--textconv` itself is denied, so the test at `decide.test.ts:126` gives false assurance.
- `hash-object -wt blob --stdin` (bundled `-w`) is allowed and wrote an object (`count-objects` went from 4 to 5).
- `rev-list --output=<file>`, `rev-list --alternate-refs` (runs `core.alternateRefsCommand`), `ls-files --recurse-submodules` and `cat-file --batch` are all allowed.

No current call site puts untrusted text in an option position (`SourceTree.read` validates the commit and path), so this is latent, but the gate's stated job is that nothing outside the reviewed shapes starts.
**Fix:** Per-subcommand allowlist of exact option strings; reject any argument starting with `-` that is not on the list, which also removes bundling and abbreviation. Keep the current deny tests and add the four bypasses above as denials.

### WR-03: `decide` checks the pinned env by presence only, and does not bound the rest of the env

**File:** `src/command-runner/decide.ts:66-84`
**Issue:** The doc comment says a git spec "must carry exactly" the pinned environment, but `gitEnvPinned` only checks that each pin is present with the right value. A spec may also carry any other variable (`GIT_EXEC_PATH`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_GLOBAL` pointing into the repo, `LD_PRELOAD`, `PATH`), and a case-variant duplicate of a pin (`git_no_lazy_fetch=0`) next to the correct one is accepted. `gitSpec` strips the case variants, but the whole point of `decide.test.ts:9` ("the gate must not trust the builder") is that the gate does not rely on that. On Windows, where names are case-insensitive, which duplicate wins is undefined (not tested here).
**Fix:** Reject any env name matching a pinned name case-insensitively other than the exact pin, and add a small denylist or allowlist for variables that name executables (`GIT_EXEC_PATH`, `GIT_SSH*`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_ASKPASS`, `GIT_PAGER`). Alternatively correct the comment to say "at least".

## Info

### IN-01: Test coverage stops short of the hostile names that matter

**File:** `src/command-runner/hostile-repo.test.ts:163-168`, `src/command-runner/git-spec.test.ts:152-159`
**Issue:** `ODD_DRIVERS` and the builder/gate agreement loop use only ASCII names. Neither invalid UTF-8 (CR-01) nor CR (WR-01) nor a very long name is covered, which is why both slipped through. Separately, the protection tests (`:142`, `:208`, `:244`) do not assert that their positive control fired, so on a platform where the control skips, the protection test passes without proving anything.
**Fix:** Add the three name classes to the fixtures; have the protection tests share a flag set by the control, or fail (not skip) in CI when the control does not fire.

### IN-02: `env.ts` strips an inherited `GIT_CONFIG_COUNT` but not `KEY_n` / `VALUE_n`, and drops a user's own channel silently

**File:** `src/command-runner/env.ts:11-20` (outside the 7 reviewed files, noted because the new channel depends on it)
**Issue:** The spec always supplies `GIT_CONFIG_COUNT`, so stray inherited `KEY_n` / `VALUE_n` are ignored and not exploitable. But a user who sets the channel in CI (commonly `safe.directory`) loses it, git then answers exit 128 (dubious ownership), and `hasObject` reports `false`.
**Fix:** Strip the whole channel family in `isDenied`, and merge a user-supplied `safe.directory` entry deliberately (or document it).

### IN-03: Minor tidy-ups

**File:** `src/command-runner/decide.ts:157`, `src/source-tree/source-tree.test.ts:97`
**Issue:** `(kv as string)` casts repeat what `gitConfigOverrideAllowed` already proved; `const notOnWindows =(why` is missing a space.
**Fix:** Narrow `kv` once after the `-c` check; fix the spacing.

---

_Reviewed: 2026-10-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
