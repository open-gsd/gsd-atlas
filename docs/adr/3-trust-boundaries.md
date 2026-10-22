# ADR: Trust boundaries

- **Status:** Accepted
- **Issue:** [#3](https://github.com/open-gsd/gsd-atlas/issues/3)
- **Ratified:** 2026-10-15
- **DESIGN.md:** A9, A16, A27, A44
- **Review findings addressed:** S‑1, S‑2, S‑3, S‑4, SDK‑1

> Ratification note: ratified together on 2026-10-18 with every other record in this folder (see docs/adr/README.md).

## Context
gsd‑atlas indexes code the user didn't write: cloned repos, dependencies, SDKs. It runs a local server reachable by other processes, and it feeds text into agents that act on it. The design review found three holes in earlier drafts:
- repo‑committed config or modules could enable command execution;
- a localhost HTTP endpoint is reachable from web pages;
- repo and package prose reached agents unfenced.

## Decision
1. **Where permission comes from.**

   | Source | Can grant permissions? |
   |--------|------------------------|
   | User‑level config (`~/.config/gsd-atlas/`) | Yes: commands, network fetches (`history.allow_fetch`, SDK packs), workspaces, policy overrides |
   | Repo‑committed config (`.gsd-atlas/`) | No. Only data: excludes, module selection, policy *suggestions* the user can accept |
   | Repo or npm language modules | No. Grammars (sandboxed WebAssembly) and queries are data; their commands need user approval per repo and per command |
   | Agents | No. Policy overrides come only from the user |

2. **Commands.**
   - Grammars (sandboxed WebAssembly) and queries (data) are always allowed.
   - Built‑in first‑party providers with fixed command lines run by default and can be turned off.
   - Any other command needs user approval per repo and per command, and never runs through MCP unless the host was started with `--allow-build`.
   - All of them start through one CommandRunner that alone decides permission from a provider's `CommandSpec` ([4-command-runner](4-command-runner.md)). The TypeScript adapter's in‑process load of the project's `typescript` is a sandboxed built‑in: worker, no network, tsconfig `plugins` ignored.
3. **Endpoint.**
   - Unix socket or named pipe preferred; loopback HTTP at a fixed port otherwise.
   - A token is required on every route.
   - `Host` and `Origin` are validated and browser‑style requests rejected.
   - The token file is `0600`.
4. **Untrusted text.**
   - All repo‑, package‑ and SDK‑derived prose is untrusted data.
   - It is fenced in tool responses (`untrusted_text`), length‑capped, redacted, and never placed unfenced into hook context.
   - It is scanned with gsd‑core's read‑injection patterns; matches are flagged in the response.
5. **Secrets.** gsd‑graph's redaction runs on every stored prose field and identifier label before storage.
6. **Network.** None by default. Each fetch path (history, SDK packs) is a separate user‑level switch.

## Consequences
- Cloning and indexing a hostile repo can't run its code or widen atlas's permissions.
- Web pages can't reach the host.
- A first‑time user gets the Apple SDK features without configuration, while third‑party commands stay off.
- Users approve third‑party commands once per repo; a small prompt cost.

## Alternatives considered
- **All commands opt‑in (earlier draft):** the headline SDK feature was off by default.
- **Trust repo config:** remote code execution on index.
- **HTTP with token only:** DNS rebinding and simple cross‑site requests still reach unauthenticated routes.

## Amendment 2026-10-15: git runs repo-controlled code

Sources: 01-RESEARCH.md Pitfall 3 and Open Question 5; PITFALLS B6; verified on git 2.54.0.

The first consequence below, that cloning and indexing a hostile repo cannot run its code, needs one more rule, because git itself runs commands named in a repo's own configuration. Verified on git 2.54.0: `git hash-object --stdin-paths` ran a configured `filter` clean command, `git ls-files -o` ran `core.fsmonitor`, and `git status` ran clean filters. Decision 2's "built-in first-party providers with fixed command lines run by default" therefore does not let repo config steer git. The git `CommandSpec` forces `core.fsmonitor=false` and `core.hooksPath` to the null device, sets `GIT_OPTIONAL_LOCKS=0`, neutralises every configured `filter` driver by name with no allowlist, and allows only read-side git subcommands, as the same-dated amendment in [4-command-runner](4-command-runner.md) specifies. The hostile-repo test proves that a poisoned `.git/config` starts nothing.

## Amendment 2026-10-18: Per-command approvals, MCP origin and compiler trust

Sources: 03-CONTEXT.md D-13, D-15 and D-23; 03-RESEARCH.md Pattern 8 and the Security Domain section; 03-DECISIONS.md OQ5 and OQ6 (researcher defaults, confirmed by the user on 2026-10-18); SEC-01, SEC-02; [4-command-runner](4-command-runner.md), amendment of the same date.

Decision 2 says any other command needs user approval per repo and per command and never runs through MCP unless the host was started with `--allow-build`. Phase 3 builds that approval and records one more trust decision, about the compiler. The decisions above stand unedited; where this section is more specific, it governs.

1. **The one rule, stated plainly.** In one sentence: repository files can never enable a command, diagnostics or auto-submit. That covers repo-committed config (including `.gsd-atlas/config.json`), a module's `precise.command`, a `package.json` with install scripts and any file in the tree. The only source of permission is user-level config under `~/.config/gsd-atlas/`. The repo-level config file is honoured for non-privileged settings only (the ADR directory list, see [5-language-modules](5-language-modules.md), amendment of the same date); any key that names a permission, a command, a diagnostics setting or an auto-submit setting is ignored with a fixed diagnostic and has no effect.
2. **`gsd-atlas allow <command>` (D-15).** The user runs it from the repository. It shows the exact argument list and the working directory, asks yes or no on a terminal, and does nothing without one. On yes it writes one per-repo, per-command entry to user-level config: the repository's canonical path, the executable and a `sha256` over the canonical form of the command (executable, arguments and working directory relative to the repository, as defined in the command-runner amendment). The entry is written to a temporary file in the same directory with mode `0600`, renamed over the old file after the whole file validates again, and kept under the file's size cap. The entry format is user data that later versions must keep reading. A command that later changes in any argument or directory no longer matches and is denied. A running MCP server read its permissions at start, so the command tells the user that a new approval takes effect after the server restarts.
3. **MCP never prompts.** A request that arrives through MCP and needs a command that is not a built-in is answered from the grammar tier with `degraded: ['needs_approval']` ([13-mcp-contract](13-mcp-contract.md), amendment of the same date), and the tier state shown by `explain` says what to run. The user allow list does not apply to MCP-origin requests at all unless the host was started with `--allow-build`; with the flag, an exact approved entry runs and nothing else does. The CLI is the place to approve, because a human is there.
4. **Scope of an approved command in Phase 3 (OQ5).** The approval is a gate and nothing more. An approved command runs through the CommandRunner during `maintain resolve` and its exit status is recorded. There is no importer: no output of a third-party indexer is read into the store in this phase (SCIP import is Phase 9).
5. **Built-in providers (decision 2).** Built-in first-party providers keep running by default, and each can be turned off in user-level config, including the TypeScript compiler worker; turning it off disables precise TypeScript resolution and not the grammar tier. A repository cannot turn one on or off.
6. **No skill auto-install (OQ6).** The shipped package carries the skills as files (`skills` is in the package's published files) and `gsd-atlas init` does not copy them into a user's or a repository's agent configuration. The eval loads the skill from a plugin directory, and install steps are documented for the user to follow. A skill installed by atlas into an agent's instruction path would be repository-visible text steering an agent, which is a trust change this phase does not make.
7. **Compiler trust (D-13).** The compiler worker loads JavaScript the repository's dependency tree supplies: the project's own installed `typescript` when it is a 6.x release, otherwise the copy bundled with atlas (6.0.3), with the answer marked `compiler_fallback`. The worker is a killable child started through the CommandRunner under the exact-shape rule, with a scrubbed environment (only listed keys), a bounded heap and a memory sampler. tsconfig `plugins` are ignored because the program is created without loading them. The compiler's location must resolve, after symlinks, to a path inside the repository; one that leaves it is treated as absent. `explain` shows which compiler and version produced a fact and whether it was the project's or the bundled one. **The residual risk is this:** a compromised `typescript` package inside the repository's `node_modules` runs with the user's file and network rights while the worker is alive, and atlas does not sandbox it further in Phase 3 (Node's permission mode lost resolved sites in measurement and is not used until a differential test shows identical results). The risk is accepted as decision 5 of the command-runner ADR accepted it, because the user has already executed that package's install, and it can be removed by turning the built-in off at user level.

## Amendment 2026-10-21: A repository ignore file is non-privileged

Sources: quick task 261021-re7 (D-01 to D-06) and its measurement record `261021-re7-MEASUREMENTS.md`; point 1 of the amendment of 2026-10-18 above; [5-language-modules](5-language-modules.md) and [4-command-runner](4-command-runner.md), amendments of the same date. The owner approved this amendment on 2026-10-21.

The decisions above and the earlier amendments stand unedited; where this section is more specific, it governs. The index now leaves out built-in tooling and build-output paths and the files a repository's own ignore file names. That adds a second repo-level file to the one point 1 of the amendment of 2026-10-18 honours for non-privileged settings.

1. **A second repo-level file, still non-privileged.** `.atlasignore`, in git's ignore syntax and in any directory of the repository, is honoured next to `.gsd-atlas/config.json`. The one rule of the amendment of 2026-10-18 stands unchanged, because the file can only shrink the index. Git evaluates it apart from `.gitignore` and the result is intersected with git's own list, so it never adds a file outside that list. It cannot re-include a built-in default, because the defaults are command-line excludes, which git ranks above every ignore file and every negation. It grants no permission, command, diagnostics setting or auto-submit, and no key of it means anything but "leave this out".
2. **It is untrusted data.** Before git is told to read any `.atlasignore`, Source Tree reads every one the listings name through the confined reader. Each must be a regular file inside the worktree (a link is never followed, and a link or submodule mode in the index, or a directory of that name, is refused), the files together must hold at most 64 KiB (the approved cap of every repository-supplied file), and the text must be valid UTF-8 without a NUL byte. If any one fails, `.atlasignore` is unusable for the whole worktree in that call, because git cannot skip one file of a per-directory set: git is not told to read it, the listing still succeeds, and one fixed warning, `atlasignore_unusable`, with no path in it is reported. A failure or timeout of the second-stage listing is handled the same way: the first stage's list stands, with the same warning.
3. **The only git surface added.** Three `ls-files` tokens and one value rule, recorded in the command-runner amendment of the same date. The built-in patterns are constants of the program; no text from a repository or from a watcher becomes an argument. The cases run against the installed git on every operating system of the CI matrix, and a hostile-repository test feeds option-looking lines through both ignore files and asserts that every recorded argument is a constant.
4. **Residual risks, accepted.** (a) A repository author can hide files from the index with a hostile `.atlasignore`, which can mislead an agent that trusts the index. Shrink-only is the accepted trade; the numbers are visible in `status` and in the build note, as counts with no names. (b) A gitignored, untracked `.atlasignore` is never listed, so it is not vetted, yet git reads it once the flag is sent because another one was listed. A cloned repository cannot carry such a file; git itself refuses a pattern file over 100 MiB (verified on git 2.54.0: it prints a warning and applies nothing) and does not follow a link. (c) A pathological pattern list can slow git until its timeout, which falls back to ignoring the file.
