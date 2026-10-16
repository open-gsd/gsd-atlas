---
phase: 01-foundations-and-walking-skeleton
reviewed: 2026-10-16T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/command-runner/filter-name.ts
  - src/command-runner/git-spec.ts
  - src/command-runner/git-spec.test.ts
  - src/command-runner/decide.ts
  - src/command-runner/decide.test.ts
  - src/command-runner/hostile-repo.test.ts
  - src/source-tree/source-tree.test.ts
findings:
  critical: 0
  warning: 3
  info: 6
  total: 9
status: issues_found
---

# Phase 01: Code Review Report (incremental re-review after gap closure 01-20)

**Reviewed:** 2026-10-16
**Depth:** standard, with executed probes against Node's fatal `TextDecoder`, the real `createRealRunner` / `createSourceTree`, and the test suite
**Files Reviewed:** 7 (diff base 1e9d077..5a1caa0)
**Status:** issues_found

## Summary

Prior CR-01 (non-UTF-8 driver name escapes neutralisation) is RESOLVED. Prior WR-01 (builder and gate disagree for CR) is RESOLVED. No new Critical issue was found.

Security trace of the fix:
- `listFilterNames` decodes with a fatal decoder (`git-spec.ts:191`, `:255`). Probed on Node 26: a lone 0xFF byte, a truncated tail (E2 82) and an encoded surrogate (ED A0 80) all throw. The shared decoder instance is stateless after a throw (the next decode is correct). `ignoreBOM: true` keeps a BOM as U+FEFF, so no byte is dropped. A key line cannot start with a BOM, and a name containing U+FEFF is carried verbatim.
- `filterNameProblem` (`filter-name.ts:38-45`) covers U+FFFD, unpaired surrogates (the non-`u` regex handles high-high-low and high-low-low correctly), NUL, LF, CR and length over 1024. The builder (`git-spec.ts:73-77`) and the gate (`decide.ts:98-105`) both call it. The empty name, `=`, `.`, tabs and leading or trailing spaces pass in both.
- `parseFilterNames` last-dot slicing is consistent with the builder's `filter.${name}.${variable}` and the gate's `lastIndexOf('.')`, so a dotted name round-trips (`filter..clean` gives the empty name).
- I found no name that passes the listing and the predicate but is neutralised under a different key. The order of checks (outcome, strict decode, parse, every name, probe) is correct. Every name error fails before any `hash-object` start.
- Verification run: 263 tests pass, 0 fail, 0 skipped across `src/command-runner/*.test.ts` and `src/source-tree/source-tree.test.ts`.

Still open from the prior review: WR-02, WR-03, IN-01, IN-02, IN-03 (carried forward below, code unchanged by 01-20). New: WR-04 and IN-04 to IN-06.

## Resolved since the prior review

- **CR-01 (resolved):** non-UTF-8 driver name. Fatal decode plus `filterNameProblem`; reproduced at the unit level and covered by hostile-repo tests with real bytes (0xFF, C3 28, ED A0 80, genuine U+FFFD, 1025 units) asserting no marker, a `filter_enumeration_failed` rejection, and exactly one git start (`hostile-repo.test.ts:~300-318`). Header claims (`git-spec.ts:13-30`) now state the true limit.
- **WR-01 (resolved):** builder and gate share one predicate. `git-spec.test.ts` "builder and gate agree" runs a corpus through the predicate, the builder, the gate on builder output, and the gate on a hand-built channel.

## Warnings

### WR-02 (open): the `decide` option denylist is still bypassable through the production gate

**File:** `src/command-runner/decide.ts:44` (`GIT_DENIED_OPTIONS`), `:190`
**Issue:** Unchanged by 01-20. The denylist matches whole arguments only. Abbreviations such as `cat-file --textc`, a bundled `hash-object -wt blob`, `rev-list --alternate-refs` and `rev-list --output=<file>` are allowed. Latent: no call site puts untrusted text in an option position.
**Fix:** Per-subcommand allowlist of exact option strings; reject any other argument starting with `-`. Add the bypasses as denial tests.

### WR-03 (open): `decide` checks the pinned env by presence only and does not bound the rest of the env

**File:** `src/command-runner/decide.ts:79-85`
**Issue:** Unchanged. `GIT_REQUIRED_ENV` requires the pins but any additional variable (`GIT_EXEC_PATH`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_EXTERNAL_DIFF`, a case-variant duplicate of a pin) is accepted. The doc comment at `:67` still says "exactly".
**Fix:** Reject case-variant duplicates of the pins and executable-naming variables, or reword the comment to "at least".

### WR-04 (new): total env size is unbounded, so the 1024 cap does not give the claimed cross-platform behaviour; a repo with many drivers fails the snapshot with an opaque error

**File:** `src/command-runner/filter-name.ts:18-20` (claim), `src/command-runner/git-spec.ts:85-89` (each name is emitted 4 times as a key)
**Issue:** The per-name cap is justified as making "one rule behave identically on all three CI operating systems", but the aggregate is not bounded. Reproduced on macOS: a repo with 300 `[filter]` sections of about 1000 characters makes `snapshot()` reject with `SourceTreeError git_failed ... spawn E2BIG`, not a `GitConfigError` with the remedy text. On Windows the whole environment block is limited to 32767 characters, so about 8 maximum-length names (4 keys each, plus values) are enough. It fails closed (nothing runs), but it is a repo-controlled denial of indexing with a misleading message, and it contradicts the stated invariant.
**Fix:** Bound the sum of key lengths (and the driver count) in `neutraliseFilters`/`listFilterNames`, throwing `filter_enumeration_failed` with the same remedy when exceeded. Add a test with many near-cap names. Or drop the cross-platform claim from the comment.

## Info

### IN-01 (open): protection tests do not depend on their positive control

**File:** `src/command-runner/hostile-repo.test.ts` (the `UNREPRESENTABLE` and `REPRESENTABLE` groups, the pre-existing groups)
**Issue:** The control calls `t.skip(...)` when the poison does not fire, but the protection tests are independent cases and still pass, so on a platform where the poison is silent they prove nothing. Currently 0 skips, so no live gap. The 01-20 coverage gaps from the prior IN-01 (invalid UTF-8, CR, long names) are closed.
**Fix:** Share a flag set by the control and fail (not skip) in CI when it did not fire.

### IN-02 (open): `env.ts` strips an inherited `GIT_CONFIG_COUNT` but not `KEY_n` / `VALUE_n`

**File:** `src/command-runner/env.ts:11-20` (outside this diff)
**Issue/Fix:** Unchanged; see the prior report (strip the whole channel family; handle a user-supplied `safe.directory` deliberately).

### IN-03 (open): minor tidy-ups

**File:** `src/command-runner/decide.ts:175`, `src/source-tree/source-tree.test.ts:97`
**Issue:** `(kv as string)` casts repeat what `gitConfigOverrideAllowed` already proved; `const notOnWindows =(why` is missing a space.
**Fix:** Narrow `kv` once after the `-c` check; fix the spacing.

### IN-04 (new): `shown()` does not escape C1 controls, bidi overrides or U+2028 despite the T-01-53 claim

**File:** `src/command-runner/git-spec.ts:195-206`
**Issue:** `JSON.stringify` escapes only U+0000-U+001F and lone surrogates. Probed: U+009B (single-character CSI), U+202E (right-to-left override) and U+2028 pass through raw. The echoed name is repo-controlled and is only shown when it is refused for another reason (too long, U+FFFD, CR), so an attacker can include these characters. The effect is terminal or display spoofing within an 80-character clipped string, and the tests' `noRawControls` check only looks for CR, LF and NUL.
**Fix:** After `JSON.stringify`, replace `[\u007f-\u009f\u200E\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069]` with `\uXXXX` escapes, and extend the test to a name containing U+009B and U+202E.

### IN-05 (new): remedy text blames the repository config even when the offending section is in user or system config; unreferenceable names are over-refused

**File:** `src/command-runner/git-spec.ts:208`
**Issue:** `git config --get-regexp` reads all scopes, so a stray `[filter "..."]` in `~/.gitconfig` with a CR or very long name makes every snapshot fail with "rename or remove that [filter] section in the repository config". Names with CR, and names too long to matter, cannot even be referenced from `.gitattributes`, so refusing them is stricter than necessary (a deliberate fail-closed choice, but the message should name the scope).
**Fix:** Say "in a git config file (repository, user or system)", or add `--show-scope` and report the scope.

### IN-06 (new): three "representable name" cases cannot fail

**File:** `src/command-runner/hostile-repo.test.ts` (`REPRESENTABLE`: tab, leading space, trailing space, all `file: null`)
**Issue:** An attribute value ends at whitespace, so these drivers can never be referenced and their markers cannot fire even if neutralisation were skipped; the control does not cover them either. They only prove non-refusal, but the test title and assertions read as "neutralises all of them".
**Fix:** Say so in the test comment, or assert on the spec's channel keys (that `filter.<name>.clean` is present for each) so neutralisation of those names is actually checked.

---

_Reviewed: 2026-10-16_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
