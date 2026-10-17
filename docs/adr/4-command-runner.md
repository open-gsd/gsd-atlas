# ADR: One CommandRunner for every child process

- **Status:** Accepted
- **Issue:** [#4](https://github.com/open-gsd/gsd-atlas/issues/4)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A9, A44, A54
- **Refines:** [3-trust-boundaries](3-trust-boundaries.md) decision 2, [5-language-modules](5-language-modules.md) decision 5

## Context
The trust rules (who may run a command) were stated in three documents but enforced nowhere in particular. With providers for Apple, Node, C, Java and others plus SCIP indexers, each provider would re-implement the permission check, and a bug in one would let a cloned repo run code. The TypeScript adapter also loads the project's own `typescript` package in-process, which is repo-influenced code (a tsconfig `plugins` entry can load more).

## Decision
1. **One module, the CommandRunner,** is the only code that starts a child process. Nothing else imports `child_process`; a lint rule enforces it.
2. **Providers hand it a `CommandSpec`:** executable, argument template and an optional built-in id. They never see policy.
3. **The runner alone decides:**
   - A spec that exactly matches a first-party built-in runs by default and can be turned off.
   - Any other command runs only if user-level config (`~/.config/gsd-atlas/`) allows that command for that repo.
   - Repo-committed config and repo or npm language modules can never grant permission (A44).
   - Argument arrays only, never a shell.
4. **Two adapters:** the real runner, and a recording fake that tests use to assert what was or wasn't started. The "hostile repo runs nothing" acceptance test uses the fake.
5. **The TypeScript adapter** is a named built-in. It loads the project's `typescript` in a worker with no network, ignores tsconfig `plugins`, and loads only from the repo's installed `node_modules`. It is on by default; turning it off disables precise TypeScript resolution but not the grammar tier. The residual risk (a compromised installed `typescript`) is accepted and documented, since the user has already executed that package's install.
6. **Denials are reported,** not silent: a denied spec yields a diagnostic naming the command and the config key that would allow it.

## Consequences
- The security rule has one place to review and test.
- Providers shrink to "detect, declare commands, parse output".
- The built-in allowlist is an interface: adding a built-in is a reviewed change to the runner's table.
- In-process code loading (the TypeScript adapter) must pass through the same module, which means the runner covers workers as well as processes.

## Alternatives considered
- **Each provider checks permission itself:** duplicated logic, and one forgotten check is a vulnerability.
- **Provider asks the runner, then runs itself:** policy is shared but execution isn't, so a provider can skip the check.
- **Permission the TypeScript adapter like any command:** safest, but turns off the headline TypeScript feature for every new user.

## Amendment 2026-10-15: git runs repo-controlled code

Sources: 01-RESEARCH.md Pitfall 3 and Open Question 5; PITFALLS B6; verified on git 2.54.0.

git is a first-party built-in (decision 3), yet some git commands execute commands named in the repo's own `.git/config`. Verified: `git hash-object --stdin-paths` ran a `filter.<name>.clean` command, `git ls-files -o` ran `core.fsmonitor`, and `git status` ran clean filters even with `core.fsmonitor=false`. The built-in git `CommandSpec` therefore carries these rules, and the runner applies them to every git start:

- It prepends `-c core.fsmonitor=false`, `-c core.hooksPath=<null device>` and `-c core.quotepath=off`, and sets `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`.
- Every `filter` driver found by `git config --name-only --get-regexp '^filter\.'` (a read that executes nothing) is neutralised by name: `clean`, `smudge` and `process` are emptied and `required` is set false. There is no allowlist, not even for a driver named `lfs`, because repo config can give any command that name. LFS pointer files are skipped anyway (language-modules decision 7).
- The built-in git entry allows only `ls-files`, `hash-object`, `cat-file`, `rev-parse`, `rev-list`, `config` (read form) and `check-attr`. `status`, which runs clean filters, is never started.
- Each neutralised filter and each refused git subcommand is reported as a diagnostic, as decision 6 requires.

The hostile-repo test of Phase 1 (plan 01-13) proves it against a poisoned `.git/config`.

## Amendment 2026-10-16: Source Tree git subcommands

Sources: FND-12; 02-CONTEXT.md D-02 and D-03; 02-RESEARCH.md Pattern 3.

Phase 2's Source Tree needs two more git reads than the allowlist in the amendment above. The built-in git allowlist gains `ls-tree` and `worktree`. `worktree` is allowed with the single shape `worktree list --porcelain -z`, which lists the repo's worktrees and runs nothing from repo config. `ls-tree` reads a commit's tree. Both carry the same pinned `-c` overrides and environment as every other git spec, and the runner neutralises filter drivers before them as before. No other `worktree` subcommand (`add`, `remove`, `prune`, `move`) is allowed, and `status` stays refused. The recording-fake decide tests cover both new shapes: each is allowed in its exact form, and `worktree list` without `--porcelain -z` or any other `worktree` verb is denied with a diagnostic.

## Amendment 2026-10-17: Git option allowlist

Sources: FND-12; 02-REVIEW WR-07, WR-11 and IN-05; plans 02-33 and 02-38; the 2026-10-17 addendum of 02-CONSTANTS.md (`runner.defaultTimeoutMs`, approved that day).

The review showed that the git gate denied a list of write options, so a bundled spelling such as `hash-object -wt blob --stdin` passed and wrote an object, and an abbreviated driver option could pass too. This amendment records the gate that replaced the list. The decisions above and the two earlier amendments stand unedited.

1. **An allowlist of exact option tokens per subcommand.** After the subcommand is known, every argument that starts with `-` must be one of the exact tokens allowed for that subcommand; positional arguments pass, and `--` is in no set. A bundled, abbreviated or late-placed option no longer passes, and a subcommand with no entry is denied. `config` and `worktree` keep their fixed-shape checks. The sets are written by value in the gate, which imports nothing from the git spec builder:

   | Subcommand | Allowed option tokens |
   |------------|-----------------------|
   | `ls-files` | `-z`, `-s`, `--others`, `--exclude-standard` |
   | `ls-tree` | `-r`, `-z`, `--full-tree`, `--name-only` |
   | `hash-object` | `--stdin-paths` |
   | `cat-file` | `-e`, `--batch`, `--batch-check` |
   | `rev-parse` | `--verify`, `--quiet`, `--git-common-dir` |
   | `rev-list` | `--max-parents=0` |
   | `check-attr` | `-z`, `--stdin`, `-a` |

   A new option is a reviewed change to this table, as decision 3 already says of the built-in list.
2. **`cat-file --batch-check` is an allowed shape.** The Source Tree asks for object sizes first and reads only the blobs it keeps, so a large blob is never buffered and then discarded. `cat-file --batch` and `-e` stay allowed; the allowed subcommand list of the amendment of 2026-10-15 is otherwise unchanged and `status` stays refused.
3. **A default timeout.** `run()` applies a 60 s limit (the approved `runner.defaultTimeoutMs`, equal to `git.timeoutMs`) to a spec that sets no usable `timeoutMs`; a value that is not a positive finite number counts as none. An explicit `timeoutMs` always wins and `stream()` never gets the default, because a long-lived child has no deadline by design. A real runner built with an invalid default throws `RangeError`. Callers that legitimately run longer set their own limit.
4. **A wider environment denylist.** The inherited environment passed to a child still loses names that look like secrets, and now also the names containing `PASSWD`, `ACCESS_KEY` (which covers the AWS key id) or `PRIVATE_KEY`, names ending in `_AUTH`, and the exact names `SSH_AUTH_SOCK` and `DATABASE_URL`. `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME` and names that only contain `AUTH` (for example `AUTHORITY_NAME`) are kept. The overlay a spec supplies still wins.
5. **Deferred.** Replacing the denylist with an allowlist of inherited names is not done in Phase 2. An allowlist is the right shape once the first non-git provider is added; the deferral is recorded in the header of the runner's environment module, with its home in ROADMAP Phase 4, success criterion 8.
