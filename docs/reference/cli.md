# gsd-atlas command-line reference

Requirements: Node 24.16.0 or newer, `git` on the path, macOS or Linux (Windows is not supported in the alpha). Node 24.15.0 truncates `TEXT` values at an embedded NUL in `node:sqlite`, which is why the floor is 24.16.0 (`engines` in `package.json`; the comment in `.github/workflows/ci.yml`).

The package has two bins, declared in `package.json`. In a built clone they are:

| Bin | Path in a built clone | Purpose |
| --- | --- | --- |
| `gsd-atlas` | `dist/bin/gsd-atlas.js` | The command line described on this page. |
| `gsd-atlas-mcp` | `dist/bin/gsd-atlas-mcp.js` | The stdio MCP server, described in the MCP reference (`docs/reference/mcp.md`). |

The command runs the Host inside its own process. It starts no background service of its own: when the command ends, it closes its Host and releases whatever it held.

## Output contract

- stdout carries exactly one JSON envelope, printed as the Host returned it, followed by a newline. `--version` and `--help` print text instead. `allow`, `bug` and `diagnostics` print nothing on stdout when they stop before they ask the Host, or when the person declines a question.
- stderr carries one line per diagnostic whose severity is `error` or `warning`, in the form `gsd-atlas: <severity> <code>: <message>`. A `busy` answer appends ` (retry after <n> ms)`. Each entry of the envelope's `hints` is written as `gsd-atlas: hint: <sentence>`. An `info` diagnostic gets no stderr line, except the `diagnostics_*` notes of `diagnostics`.
- A usage error prints `gsd-atlas: <reason>` and the usage text to stderr and nothing to stdout.
- `init` prints its own envelope, with schema `gsd-atlas.init/1`. Its `data` is always present, even when a host is refused.
- A failure inside the CLI itself prints `gsd-atlas: error internal_error: <message>` to stderr and exits 2.
- The first SIGTERM or SIGINT closes the Host and exits 143 or 130. A second signal exits at once.
- A warning about the user configuration file is written to stderr when the Host is composed (see [User configuration](#environment-and-user-configuration)).

## Exit codes

| Code | Meaning | Diagnostic codes that select it |
| --- | --- | --- |
| 0 | The envelope is `ok`. | none |
| 1 | Usage error, invalid arguments, or a `lang test` target that is neither a module folder nor a known module id. | the CLI's own usage errors; `invalid_args`; `module_not_found` |
| 2 | Any other failure. | `not_indexed`, `not_a_repo`, `bad_cursor`, `output_too_large`, `commit_not_found`, `git_failed`, `history_unavailable`, `store_unavailable`, `schema_too_new`, `timeout`, `unknown_worktree`, `tenant_closed`, `unavailable`, `internal_error`, `config_refused`, `launch_command_invalid`, `invalid_handle`, `stale_handle`, `answer_not_found`, `no_recent_answer`, and an envelope with `ok: false` and no code above. `allow`, `bug` and `diagnostics` add exit statuses of their own (see their sections). |
| 3 | Another process holds the writer lease, or the host is busy. | `lease_held`, `busy`; for `allow` only, `config_invalid` |

Precedence when an envelope carries several codes: usage (1), then lease held or busy (3, even when other errors ride along), then any other failure (2), then ok (0). A not-ok envelope without a diagnostic list exits 2.

## Options

Options are parsed strictly: an option that is not in the table for the command is a usage error (`--<name> does not apply to <command>`), and an option value that starts with a dash must be written `--name=value`.

`--version` (`-v`) prints `gsd-atlas <version>` on stdout and exits 0. `--help` (`-h`) prints the usage text on stdout and exits 0.

### Selection

| Option | Value | Commands | Meaning |
| --- | --- | --- | --- |
| `--repo` | directory | `find`, `refs`, `context`, `impact`, `explain`, `history`, `health`, `build`, `maintain`, `status`, `rate`, `allow`, `diagnostics`, `bug` | The repository or worktree to use. |
| `--cwd` | directory | the same commands | A directory inside the worktree. Used when `--repo` is not given. On the code tools, results nearer to it rank first. `health` accepts `--cwd` and ignores it. |

A relative `--repo` or `--cwd` resolves against the process working directory. When neither is given, the process working directory is used. The directory must exist and be inside a git repository whose `git worktree list` has an entry that contains it (checked after resolving links); otherwise the answer is `not_a_repo`.

### Paging

| Option | Value | Commands | Default and limits |
| --- | --- | --- | --- |
| `--budget` | whole number of estimated tokens | `find`, `refs`, `context`, `impact`, `history` | Positive. Default 2000. No response exceeds 8000 whatever is asked. |
| `--limit` | whole number | `find`, `refs`, `context`, `impact`, `history` | Positive. Default 50. A larger value is clamped to 200. |
| `--more` | cursor text | `find`, `refs`, `context`, `impact` | The `more` value of an earlier answer, sent with the same query. At most 1024 characters. |
| `--fresh` | repo-relative path | `find`, `refs`, `context`, `impact` | Repeatable. The paths are indexed before the answer is read; the wait is bounded by 2000 ms. |

### Query

| Option | Value | Commands | Meaning |
| --- | --- | --- | --- |
| `--kind` | text | `find`, `refs`, `history` | `find`: only symbols of this kind, for example `function` or `class`. `refs`: only definitions of this kind are followed. For both, the kind `adr` asks about an ADR number instead of a symbol. |
| `--mode` | `exact`, `prefix`, `fuzzy` or `auto` | `find`, `history` | How names match. Default `auto`. `exact` reads the exact tier, `prefix` the exact and prefix tiers, `fuzzy` and `auto` all three when the name has at least 3 characters. `bug` also takes `--mode`, with other values (see [Reports and approvals](#reports-and-approvals)). |
| `--path` | repo-relative file | `refs`, `context`, `impact`, `history` | `refs`, `context`, `impact`: the defining file, to tell same-named symbols apart. `history`: read only this file of the commit. |
| `--depth` | whole number, 0 or more | `impact`, `history` | Hops to follow outward from the symbol. Default 2, at most 5 (a larger value is reduced, with a hint). 0 follows none. |

### History

| Option | Value | Commands | Meaning |
| --- | --- | --- | --- |
| `--at` | revision name or commit id | `history` | Required. A value that is empty or starts with a dash is refused. |

### Maintenance, status and init

| Option | Value | Commands | Meaning |
| --- | --- | --- | --- |
| `--full` | none | `maintain` | A full compaction. Applies only to the tasks `compact` and `all`. |
| `--since` | count and unit | `status` | Pattern `[1-9][0-9]{0,3}` followed by `m`, `h` or `d` (for example `30m`, `12h`, `7d`). Default `7d`. |
| `--agent` | `claude`, `cursor` or `codex` | `init` | Repeatable. Default: all three. |
| `--dry-run` | none | `init` | Report what would happen and write nothing. |

### Reports and approvals

Accepted by `rate`, `allow`, `diagnostics` and `bug`. The rating names and values are listed under [`gsd-atlas rate`](#gsd-atlas-rate).

| Option | Value | Commands | Meaning |
| --- | --- | --- | --- |
| `--session` | none | `rate` | Rate the session. |
| `--feature` | rating feature | `rate`, `diagnostics preview`, `bug` | `rate`: rate this feature. `diagnostics preview`: what a `--rating` is about, a rating feature, `last` or `session`; needs `--rating`. `bug`: the feature the report is about. |
| `--last` | none | `rate` | Rate the newest answer of the repository. The default when no scope option is given. |
| `--workdir` | directory | `allow` | The working directory of the approved command, relative to the repository. Default `.`. It must exist inside the repository. |
| `--module` | module name | `allow` | Propose the command the named language module declares instead of a command after `--`. |
| `--note` | text | `diagnostics preview` | A note for the report. Must not be empty. |
| `--rating` | `up`, `meh` or `down` | `diagnostics preview`, `bug` | A rating for the report. |
| `--save` | none | `diagnostics preview` | Keep the rendered report on this machine. |
| `--what`, `--expected`, `--steps` | text | `bug` | The reporter's own words. At most 10,000 characters each. |
| `--answer` | answer id | `bug` | The `answer_id` of the answer the bug is about (`a_` and 16 hexadecimal digits). |
| `--include` | comma-separated list | `bug` | The data types to include: `problem`, `versions`, `health`, `recorder`, `failing`. |
| `--mode` | `hashed`, `redacted` or `raw` | `bug` | How names and paths appear. Default `hashed`. |
| `--confirm-raw` | none | `bug` | Confirms `--mode raw` without a terminal. |
| `--clear` | none | `bug` | Empty the repository's flight recorder. Takes no other option than `--repo` and `--cwd`. |

### Module roots

Accepted by `lang list` and `lang test`. Each option replaces its default; a relative value resolves against the process working directory.

| Option | Value | Default |
| --- | --- | --- |
| `--repo-root` | directory | The process working directory. Modules are read from `<repo-root>/.gsd-atlas/languages/<name>/`. |
| `--user-dir` | directory | `GSD_ATLAS_USER_DIR`, else `<home>/.config/gsd-atlas`. Modules are read from `<user-dir>/languages/<name>/`. |
| `--builtin-dir` | directory | The `modules` folder of the package. |
| `--npm-root` | directory | Repeatable. The process working directory. Modules are read from `node_modules/gsd-atlas-lang-<name>` and `node_modules/@opengsd/atlas-lang-<name>` below it. |

When the same module name appears in several places, the highest precedence wins: repo, then user, then npm, then built-in. The others are listed under `shadowed`.

## Commands

Every code command takes the symbol name as its single argument.

### gsd-atlas find

```
gsd-atlas find <name> [--kind <kind>] [--mode exact|prefix|fuzzy|auto] [selection and paging flags]
```

- Options: `--repo`, `--cwd`, `--budget`, `--more`, `--fresh`, `--limit`, `--kind`, `--mode`.
- Result schema: `gsd-atlas.code-find/1`.
- `data.results[]`: `name`, `kind`, `path`, `line`, `col` (both 1-based), `exported` (when known), `confidence`, `citation`.
- `--kind adr` asks where an ADR is: `<name>` is then an ADR number (`ADR-3473`, `adr 3473`, `#3473` or `3473`) and `data` is `{ number, status, citations, results[] }` with the ADR file or files that carry the number (see [ADR citations](mcp.md#adr-citations)).
- Errors: `not_indexed`, `not_a_repo`, `invalid_args`, `bad_cursor`, `output_too_large`.

### gsd-atlas refs

```
gsd-atlas refs <name> [--kind <kind>] [--path <file>] [selection and paging flags]
```

- Options: `--repo`, `--cwd`, `--budget`, `--more`, `--fresh`, `--limit`, `--kind`, `--path`.
- Result schema: `gsd-atlas.code-refs/1`.
- `data.targets[]`: the definitions the references are to (at most 5): `name`, `kind`, `path`, `line`, `handle`.
- `data.results[]`: `target` (a target handle), `path`, `line`, `col`, `kind` (`call`, `new`, `read`, `type`, `heritage` or `member`), `enclosing`, `tier`, `confidence`, `ambiguous`, `candidates`, `citation`.
- A reference matched by name is `INFERRED`, never `EXTRACTED`.
- `--kind adr` lists the code comments that cite an ADR: `<name>` is then an ADR number, `data` is `{ adr: { number, status, files[] }, results[] }` and each result has `path`, `line`, `col`, `detail`, `attachedTo`, `confidence` and `citation` (see [ADR citations](mcp.md#adr-citations)).

### gsd-atlas context

```
gsd-atlas context <name> [--path <file>] [selection and paging flags]
```

- Options: `--repo`, `--cwd`, `--budget`, `--more`, `--fresh`, `--limit`, `--path`.
- Result schema: `gsd-atlas.code-context/1`.
- `data.results[]`: one ordered list for the best-ranked definition. Each item has a `section`: `definition`, `parent`, `child`, `import`, `export` or `reference` (at most 10 references). The other fields depend on the section and always include `name`, `kind`, `path`, `line`, `col`, `confidence`, `citation`.
- `data.alternatives[]`: the other definitions of the name (at most 5).
- `data.file`: present only when the project's compiler configuration says what the defining file compiles to: `{ path, emittedAs[] }`, with `emittedAs` the repository-relative output paths (for example `src/lib.cts` to `out/lib.cjs`). Absent for a file in no TypeScript project, and for a repository with no tsconfig.

### gsd-atlas impact

```
gsd-atlas impact <name> [--path <file>] [--depth <hops>] [selection and paging flags]
```

- Options: `--repo`, `--cwd`, `--budget`, `--more`, `--fresh`, `--limit`, `--path`, `--depth`.
- Result schema: `gsd-atlas.code-impact/1`.
- `data.seeds[]`: the matching definitions: `name`, `kind`, `path`, `line`, `handle`.
- `data.results[]`: `hop`, `via` (`call`, `reference` or `import`), `kind` (`file` for a file), `name`, `path`, `line`, `col`, `confidence` (of this edge), `chain_confidence` (of the whole chain from the seed; `INFERRED` as soon as one edge is), `handle`, `from` (the seed handle), `citation`. Each item is reported once per seed, at the smallest hop that reaches it. A hop keeps at most 200 items per seed.

### gsd-atlas explain

```
gsd-atlas explain <handle | answer id> [--repo <dir>] [--cwd <dir>]
```

- The argument is the `debug` handle of any citation, or the `answer_id` of an earlier answer; an argument shaped like an answer id (`a_` and 16 hexadecimal digits) is sent as `answer_id`, anything else as `handle`.
- Options: `--repo`, `--cwd`. Takes exactly one argument; none or two is a usage error (exit 1). The command prints the envelope of the `code_explain` MCP tool.
- Result schema: `gsd-atlas.code-explain/1`. For a handle, `data.explanation` (the extractor, tier, grammar version, file version, resolution context and cache state, overlay) and `data.tiers` (the precise tier's state and the compiler); for an answer id, `data.answer` and `data.facts[]`. The fields are in [the MCP reference](mcp.md#code_explain).
- It reads what is already stored: it runs no resolver, starts no compiler and writes nothing but the record of its own answer.
- Errors: `invalid_handle`, `stale_handle`, `answer_not_found`, `invalid_args`, `not_indexed`, `not_a_repo`.

### gsd-atlas history

```
gsd-atlas history <find|refs|context|impact> <name> --at <revision> [--path <file>] [--kind <kind>] [--mode exact|prefix|fuzzy|auto] [--depth <hops>] [--limit <n>] [--budget <tokens>] [--repo <dir>] [--cwd <dir>]   (the code as of a commit, from git alone; never writes to the index)
```

- Tools: `find`, `refs`, `context`, `impact`, with the result data of the command of the same name.
- Options: `--repo`, `--cwd`, `--budget`, `--limit`, `--at`, `--path`, `--kind`, `--mode`, `--depth`. `--more` and `--fresh` do not apply.
- Result schema: `gsd-atlas.history/1`.
- History reads git objects only: it never writes to the index and never contacts a remote. It parses the commit's source files into a store in a temporary directory, answers from it and removes it. It needs no index and works in a process that does not hold the writer lease.
- The first hint names the commit (12 characters) and states that the working tree and the index were not consulted.
- At most 2000 source files of a commit are read, in path order; beyond that the answer carries a `history_truncated` warning and `truncated: true`.
- Errors: `invalid_args` (exit 1), `not_a_repo`, `commit_not_found`, `git_failed`, `history_unavailable` (the temporary directory is inside the repository or its index; set `TMPDIR` elsewhere).

### gsd-atlas health

```
gsd-atlas health [--repo <dir>] [--cwd <dir>]   (index status, the atlas_status tool)
```

- Options: `--repo`, `--cwd` (ignored).
- Result schema: `gsd-atlas.atlas-status/1`. The `data` fields are listed in the MCP reference (`docs/reference/mcp.md`), under `atlas_status`.
- `data.health` is `ok` or `degraded`; `data.reasons` lists why (see [Health reasons](#health-reasons)).

### gsd-atlas build

```
gsd-atlas build [--repo <dir>] [--cwd <dir>]   (index the repository; the only way an index is created)
```

- Options: `--repo`, `--cwd`.
- Result schema: `gsd-atlas.build/1`.
- `data`: `worktree`, `files` (files in the source set), `parsed` (files whose facts were extracted), `linked` (files attached to facts the store already held), `removed` (paths that left the index), `skipped` (count of skipped items), `failed` (count of files that failed), `failedCodes` (failure code to count). `skipped` is still a count; the keys and their types do not change.
- After the index is built, a repository with a precise tier (the TypeScript compiler) gets one more pass before the command returns: the compiler is asked about every reference site of the indexed files, in batches, and the answers are stored, so the first `refs` after a build is answered from the store and not from a cold compiler. The pass has a time bound (25 seconds, `precise.requestTimeoutMs`). A pass that does not finish leaves the build successful, with a `resolver_timeout` note in `diagnostics`; `gsd-atlas maintain resolve` continues it.
- `diagnostics` (the envelope field, not `data`): `[]` for a build that left nothing out. Otherwise it lists the notes of the build, in this order: `emit_output_not_indexed` (some files are the emit output of an included source and are not indexed), `citation_comment_too_long` (some files have ADR mentions that are not indexed, a comment over the comment size bound or more than 200 mentions in one file, so citations from them are missing; the count is read from the store, so a build that parses nothing repeats it), then `resolver_timeout` (the compiler pass above did not finish). Each is an `info` diagnostic with fixed text and a count, and carries no file path and no repository text. They are diagnostics, not degraded codes: a build sets no `degraded`. Any other note the build collects (for example files no language module claims) is counted in `skipped` and goes no further.
- Errors: `not_a_repo`, `lease_held` (exit 3), `store_unavailable`, `schema_too_new`.

### gsd-atlas maintain

```
gsd-atlas maintain [reconcile|resolve|refresh|collect|compact|check|all] [--full] [--repo <dir>] [--cwd <dir>]   (exit 3 when another process holds the writer lease)
```

- Tasks: `reconcile`, `resolve`, `refresh`, `collect`, `compact`, `check`, `all`. The default is `all`, which runs the other six in that order. `--full` is accepted only with `compact` and `all`.
- Options: `--repo`, `--cwd`, `--full`.
- Result schema: `gsd-atlas.maintain/1`. `data.tasks` maps each task that ran to `complete`, `spentMs`, `processed`, and, when present, `note` (`resolve` reports `no precise tier is active` when there is none), `ok` (`check` only) and `precise` (`resolve` only, see below).
- `resolve` asks the precise tier (the TypeScript compiler) about every reference site of the worktree's files in batches of at most 2000, stores the answers and remembers which sites were asked, so it is time-boxed, resumable and idempotent: a second run over an unchanged tree asks nothing (`processed: 0`). `processed` counts the sites asked. `precise` is `{ asked, answered, complete }`, and, when the language module declares a `precise.command`, `command`: `{ ran, ok, exitCode, signal, timedOut, ms, needsApproval }`. A module's command is never started unless you approved exactly that command with `gsd-atlas allow`; only its exit status, signal, time-out flag and duration are reported, never its output. An unapproved command is not started and the answer carries `needs_approval`.
- `resolve` also forgets a compiler memory stop, so a project that ran out of memory is tried again once.
- Every task needs the writer lease; without it the answer is `lease_held` (exit 3). `resolve` is the exception while no precise tier is active. `reconcile`, `refresh` and an active `resolve` also need the worktree to have been built.
- Errors: `not_indexed`, `not_a_repo`, `lease_held`, `store_unavailable`, `schema_too_new`.

### gsd-atlas status

```
gsd-atlas status [--since <count>m|h|d] [--repo <dir>] [--cwd <dir>]   (local metrics panels; token figures are estimates)
```

- Options: `--repo`, `--cwd`, `--since`.
- Result schema: `gsd-atlas.status/1`.
- `data.range`: `since` and `until` in milliseconds since the epoch.
- `data.report`: `answers` (`total`, `ok`, `byTool`, `truncated`, `latency`), `degraded` (code to count), `freshness`, `indexHealth` (`files`, `errorFiles`, `staleFiles`, `sizeBytes`, `at`), `tokens` (`estimatedTotal`, `byTool`, `label`). Hour and day buckets that overlap the window are included whole. Histograms give `count`, `p50UpperBoundMs`, `p95UpperBoundMs`, `overflow` and per-bucket counts; the percentiles are bucket upper bounds. Token figures are estimates (characters divided by four) and are labelled `estimate`.
- `data.tenant`: `storeId`, `location` (`dir`, `kind`), `leader`, `store`, `indexer`, `governor`, `metrics`, `startup`, `idle`.

### gsd-atlas rate

```
gsd-atlas rate up|meh|down [--session | --feature <name> | --last] [--repo <dir>] [--cwd <dir>]
```

- Takes exactly one value. The values are `up`, `meh` and `down`. A rating carries no text.
- Options: one scope (`--session`, `--feature`, `--last`), `--repo`, `--cwd`. Giving more than one scope is a usage error (`choose one scope: --session, --feature <name> or --last`). With no scope option the newest answer of the repository is rated, as with `--last`.
- Rating features, the values `--feature` accepts: `code_find`, `code_refs`, `code_context`, `code_impact`, `atlas_status`, `lang_list`, `code_explain`, `skill`, `build` and `init`. Any other name is a usage error.
- Result schema: `gsd-atlas.rate/1`. `data`: `recorded` (`true`), `scope` (`answer`, `feature` or `session`), `value`, and one of `answer_id`, `feature` or `session_id`, according to the scope.
- stderr confirms with `gsd-atlas: recorded "<value>" for the last answer`, `for feature "<name>"` or `for the session`.
- It writes one row to the table `ratings` of `metrics.db`, in the store folder of the repository: the time, the scope, the value and the answer id, feature name or session id. It writes no text and sends nothing.
- A rating is made by a person at the command line. There is no MCP tool for it, and the Host refuses a `rate` request that comes from an MCP server with `rate_forbidden`.
- Errors: `no_recent_answer` (the repository has no recorded answer to rate; exit 2), `not_a_repo`.

<!-- verified-by: cli: gsd-atlas rate up --last -->
```json
{"schema":"gsd-atlas.rate/1","ok":true,"data":{"recorded":true,"scope":"answer","value":"up","answer_id":"a_e6bb500053f5737c"},"diagnostics":[]}
```

### gsd-atlas init

```
gsd-atlas init [--agent claude|cursor|codex] [--dry-run]
```

- Options: `--agent`, `--dry-run`. Takes no arguments.
- Result schema: `gsd-atlas.init/1`. `data`: `dryRun` and `hosts[]`, one per selected agent, each with `agent`, `file`, `action` and, when there is one, `reason`.
- Per-host actions: `created`, `updated`, `unchanged`, `skipped`, `refused`.
- It edits user-scope files under the home directory and starts no program. The command it registers is the absolute path of the Node executable with the absolute path of the `gsd-atlas-mcp` file as its argument, under the entry name `gsd-atlas`. The only argument is that file: the entry never carries `--allow-build`. `init` writes the three host files in the table below and nothing else; it copies no skills.
- The first time it changes an existing file it saves the original beside it as `<file>.gsd-atlas-backup`. A write replaces the file atomically and keeps its byte-order mark, line endings and permission bits.

| Agent | File | Detected when | `init` creates the file | Entry |
| --- | --- | --- | --- | --- |
| `claude` | `~/.claude.json` | the file or the `~/.claude` folder exists | no | `mcpServers["gsd-atlas"]` with `type`, `command`, `args` |
| `cursor` | `~/.cursor/mcp.json` | the file or the `~/.cursor` folder exists | yes | `mcpServers["gsd-atlas"]` with `type`, `command`, `args` |
| `codex` | `~/.codex/config.toml` | the file or the `~/.codex` folder exists | yes | table `[mcp_servers.gsd-atlas]` with `command` and `args` |

Skipped reasons: `not_detected` (neither the file nor the folder exists); `config_not_found` (only the folder exists and the host creates its own file; a manual command is printed on stderr).

Refusal reasons (action `refused`, diagnostic `config_refused`, exit 2, file left untouched):

- the path exists but is not a regular file;
- the file could not be read or written (the message carries the operating system's reason);
- the file contains a NUL byte, or is not valid UTF-8;
- the file is not valid JSON, its top-level value is not an object, or `mcpServers` is not an object;
- a Codex table that cannot be edited safely as text (the message names the line and says to edit it by hand);
- `config_in_use`: the operating system refused to replace the file, because another process holds it open or its folder is not writable; nothing was changed;
- `config_changed_during_init`: the file changed while `init` was running; nothing was written.

`launch_command_invalid` (exit 2, no hosts listed) is reported when the Node executable or the server entry is not an absolute path.

After a registration that is not a dry run and has no refusal, `init` prints `gsd-atlas: to index <repo>, run `gsd-atlas build` inside it` on stderr when a git repository is found above the working directory and has no index.

### gsd-atlas allow

```
gsd-atlas allow [--repo <dir>] [--cwd <dir>] [--workdir <dir>] [--module <name>] -- <executable> <args...>
```

- Records one approval: one exact command for one repository. Everything after the first `--` is the command, the executable first. `--module <name>` takes the command the named language module's manifest declares instead. Exactly one of the two is required; the other cases are usage errors (exit 1), for example `allow takes either --module <name> or a command after a double dash, not both`.
- Options: `--repo`, `--cwd`, `--workdir`, `--module`. The approval is for the main worktree of the repository.
- It needs a terminal: standard input and the stream the person reads must both be a terminal. Without one it sends no request, writes nothing, prints `gsd-atlas: error allow_needs_terminal: allow needs a terminal` on stderr and exits 2. Nothing in an MCP server can start it: there is no MCP tool for it, and a Host started for an MCP server refuses the request.
- Sequence: a preview request (nothing is written), the review on stderr, one question, and, only after `y` or `yes` in any letter case, a second request that carries the hash of what was shown. The Host recomputes the hash from that request and writes only when the two are equal (`confirm_mismatch` otherwise).
- The review lists the repository, the executable, the arguments, the working directory relative to the repository and the approval hash (SHA-256 of the canonical form of the command: the executable, the arguments and the working directory). A command proposed by a module manifest is marked as such. Values are printed quoted, with control characters escaped. The question is `Allow this exact command to run for this repository? [y/N] `.
- Any other answer prints `gsd-atlas: nothing was approved and nothing was written` and exits 1.
- Result schema: `gsd-atlas.allow/1`, printed on stdout after the write. `data`: `written`, `sha256`, `executable`, `args`, and `already_allowed` (`true`) when an identical entry was already there. The preview reply holds `repo`, `executable`, `args`, `cwd`, `sha256` and, for a module's command, `fromModule`; it is not printed on stdout.
- stderr after the write: `gsd-atlas: approved command: "<executable>" ["<argument>", ...]`, then either `gsd-atlas: approved. A running MCP server must be restarted to see this approval, and it runs an approved command only when it was started with --allow-build.` or, for a repeat, `gsd-atlas: this exact command was already approved; nothing was changed`.
- File written: `permissions.allow` of `<user-dir>/config.json` (see [User configuration](#environment-and-user-configuration)). The entry is `{ repo, executable, sha256 }`. The file is created when absent, with mode 0600; it is written through a temporary file in the same folder and renamed; every other key is kept; a link to the file is followed.
- Exit codes: 0 written or already approved; 1 usage error, declined answer, `invalid_args`, `module_not_found`; 2 no terminal, `not_a_repo`, `invalid_workdir` (the working directory is not an existing directory inside the repository, given relative to it), `no_precise_command` (the module declares none), `confirm_mismatch`, `config_too_large` (the file would pass 64 KiB), `config_changed` (the file changed while it was written), `write_failed`; 3 `config_invalid` (the user configuration file is invalid and was left unchanged).
- An approval takes effect for the command line (for example `maintain resolve`). An MCP server uses the permission list only when it was started with `--allow-build` (see [the MCP reference](mcp.md#server)).

<!-- verified-by: cli: gsd-atlas allow -- node -e 1 -->
```json
{"schema":"gsd-atlas.allow/1","ok":true,"data":{"written":true,"sha256":"cac85afe6d9f6f7c4869b281b5a604b048ac2fb0e0ebd9080cbf5ed64c7edd43","executable":"node","args":["-e","1"]},"diagnostics":[]}
```

### gsd-atlas diagnostics

```
gsd-atlas diagnostics enable|types|preview|disable|history
```

Diagnostics are off by default. This command is the only way to turn a data type on; the choices are read from the user configuration folder and never from a repository, and a Host started for an MCP server refuses the request. This version never sends a report: `preview` shows the exact report and `--save` keeps it on this machine.

- Result schema: `gsd-atlas.diagnostics/1`. A usage error (exit 1) is `diagnostics needs one of: enable|types|preview|disable|history`; `--note`, `--rating`, `--feature` and `--save` apply only to `preview`; only `types` takes arguments.

| Sub-command | Needs a terminal | What it does |
| --- | --- | --- |
| `enable` | yes | Walks through the ten data types in order. For each it shows the fields with the values from this machine, how it helps and what it cannot reveal, then asks `Share "<title>" in reports? [a]pprove / [d]eny / ask [e]ach time (Enter = deny): `. `a`, `approve`, `y` or `yes` approves; `d`, `deny`, `n` or `no` denies; `e`, `ask`, `each` or `k` sets ask each time; an empty or unrecognised answer denies. Saves the choices. |
| `types [<type>...]` | yes | The same walk for the named types, or all ten. An empty or unrecognised answer keeps the current state. Prints `gsd-atlas: no changes` when nothing changed. |
| `preview` | no | Builds the report from the approved types. `--note <text>`, `--rating up\|meh\|down` and `--feature <name>` add a note and a rating when the `notes` and `ratings` types are approved (otherwise `gsd-atlas: --note ignored: the notes data type is not approved` and the like). A type set to ask each time is asked about on a terminal (`Include "<title>" in this report? [y/N] `) and is left out, and named on stderr, without one. `--save` writes the report. |
| `disable` | no | Resets every choice to denied, removes the saved reports and the local diagnostics folder, and empties the flight recorder of the repository. |
| `history` | no | Lists the saved reports, at most 200. |

- Without a terminal `enable` and `types` ask nothing, write nothing, print `gsd-atlas: error diagnostics_needs_terminal: diagnostics <sub-command> needs a terminal` on stderr and exit 2.
- `preview` while diagnostics are off returns `data` `{ "enabled": false }` and the `info` diagnostic `diagnostics_off`, exit 0. Diagnostics are off while the `header` type is not approved.
- `preview` data when on: `enabled`, `title`, `labels[]`, `body` (the report as text), `json` (the report fields), `ask_skipped[]` (`id`, `title`), and `note_ignored` or `rating_ignored` when that type is not approved, and `path` after `--save`. A rating `up`, `meh` or `down` appears in the report as an arrow. `--feature` is one of the rating features, `last` or `session`, and needs `--rating`.
- `history` data: `reports[]` with `file`, `title` and `bytes`; stderr lists them.
- `disable` data: `consent_reset`, `removed_reports`, `state_removed`, `flight_cleared`, and `consent_file_invalid` when the consent file fails validation and was left alone.
- Files: the choices are `<user-dir>/diagnostics.json`; saved reports are `<state dir>/diagnostics/reports/<time>.md`, written with mode 0600 in a 0700 folder and never overwritten. The state dir is `$XDG_STATE_HOME/gsd-atlas` when `XDG_STATE_HOME` is an absolute path, otherwise `<home>/.local/state/gsd-atlas`.
- A data type is approved only while the field list the person approved equals the list in `diagnostics/catalog.v1.json`. A release that changes the list turns the type off until it is reviewed again (`needs_review`). A file that is not valid is ignored whole.

The data types of `diagnostics/catalog.v1.json`, catalog version 1:

| Data type | Title | Fields |
| --- | --- | --- |
| `header` | Report header | `atlas_version`, `catalog_version`. Required: with it denied no report can be built. |
| `platform` | Platform | `os_family`, `os_major`, `node_major` |
| `agent_setup` | Agent setup | `agent_host`, `transport` |
| `languages` | Languages and index quality | `languages_active`, `tiers_active`, `parse_error_rate`, `degraded_rate` |
| `scale` | Scale profile | `repo_count_bucket`, `repo_size_bucket`, `worktree_count_bucket`, `agent_concurrency_bucket` |
| `performance` | Performance | `build_time_bucket`, `store_size_bucket`, `query_latency`, `hook_latency`, `budget_breaches` |
| `reliability` | Reliability | `error_codes`, `crash_signature` |
| `agent_behavior` | Agent behaviour | `gate_stats`, `atlas_vs_grep` |
| `ratings` | Ratings | `rating` |
| `notes` | Notes | `note` |

<!-- verified-by: cli: gsd-atlas diagnostics preview -->
```json
{"schema":"gsd-atlas.diagnostics/1","ok":true,"data":{"enabled":false},"diagnostics":[{"code":"diagnostics_off","severity":"info","message":"Diagnostics are off: nothing is collected and nothing is sent. Turn them on, one data type at a time, with \"gsd-atlas diagnostics enable\"."}]}
```

### gsd-atlas bug

```
gsd-atlas bug [--what <text>] [--expected <text>] [--steps <text>] [--feature <name>] [--rating up|meh|down] [--answer <id>] [--include problem,versions,health,recorder,failing] [--mode hashed|redacted|raw] [--confirm-raw] [--clear] [--repo <dir>] [--cwd <dir>]
```

Writes a local bundle that describes one defect. Nothing is sent: the command opens no network connection. The person reads the bundle and attaches it to a report on their own.

- Takes no arguments. Result schema: `gsd-atlas.bug/1`. `data`: `written`, `path` (the bundle folder), `files` (`bundle.json`, `preview.txt`), `included` (the data types in the bundle), `digest` (SHA-256 of `bundle.json`), `bytes` and `preview` (the exact text shown before the write).
- Files: `<cache root>/gsd-atlas/bug-reports/<id>/bundle.json` and `preview.txt`, where `<id>` is a UTC time stamp, a dash and the first eight hexadecimal digits of the digest. The cache root is `XDG_CACHE_HOME` when it is an absolute path, otherwise `<home>/.cache`. The folder is created with mode 0700 and the files with mode 0600, and a bundle is never overwritten. The bundle format is `gsd-atlas-bug-v1`.
- Always in the bundle: a header (`atlas_version`, `catalog_version`) and the reporter's own words (`--what`, `--expected`, `--steps`), scrubbed of paths, links, e-mail addresses and secret shapes. Every other part is a data type that starts denied and is in the bundle only when approved.
- At a terminal, with no `--include`: it asks `What happened? `, `What did you expect? ` and `Steps to reproduce? ` unless the option was given, then shows each data type (what it contains, how it helps, what it cannot reveal) and asks `Include "<title>"? [y/N] `, then prints the preview and asks `Write this bundle on this machine? [y/N] `. A declined write prints `gsd-atlas: nothing was written` and exits 1.
- Without a terminal: a data type is in the bundle only when `--include` names it, and at least one of `--what`, `--expected` or `--steps` is required (`bug_needs_text`, exit 2). With `--include` at a terminal the data types are not asked about, and the preview and the write question still are.
- `--mode`: `hashed` (the default) replaces names and paths by tokens of the form `<h:xxxxxxxx>`, the first eight hexadecimal digits of an HMAC-SHA256 made with a fresh random key for each bundle, so a name has the same token everywhere in one bundle and another token in the next; `redacted` leaves them out; `raw` includes them as they are and marks the preview `RAW MODE: names and paths are included as they are`. `raw` needs `--confirm-raw`, or at a terminal the answer `y` to a separate question; without either, `raw_not_confirmed` (exit 2) and nothing is written.
- `--clear` empties the flight recorder of the repository and takes no option other than `--repo` and `--cwd`. `data`: `cleared`, the number of events removed. stderr reports `gsd-atlas: removed <n> events from the flight recorder` or `gsd-atlas: the flight recorder was already empty`.
- After a write, stderr reports `gsd-atlas: bundle written to <path>` and one fixed sentence that tells the person to attach `bundle.json` to a new issue of the project and that atlas uploads nothing.
- A bundle holds at most 1,048,576 bytes (`bug.bundleMaxBytes`); the flight recorder excerpt is the newest 200 events (`bug.excerptEvents`), trimmed oldest first when the bundle would be larger, with a note in the bundle.
- Usage errors (exit 1): `--mode must be one of hashed, redacted, raw`; `--rating must be one of up, meh, down`; `--feature must be one of` the rating features; `--answer must be the answer_id of an earlier answer`; `--include names unknown data types; expected problem, versions, health, recorder, failing`; `--clear takes only --repo and --cwd`.
- Other errors: `confirm_mismatch` and `already_written` (a bundle is written once per preview).

The five data types of a bundle:

| Data type | Title | Holds |
| --- | --- | --- |
| `problem` | Problem statement | The feature and rating given with `--feature` and `--rating`. |
| `versions` | Versions and configuration | Versions of atlas, Node and SQLite, the loaded language modules and the TypeScript compiler in use, and the user configuration with paths replaced by `<path>` and permissions reduced to a count. |
| `health` | Store and host health | Counts, flags and codes: store schema version, worktree count and size bucket, whether a writer lease is held, whether the store was rebuilt, the host state and the last reconcile. |
| `recorder` | Flight recorder excerpt | The newest tool calls answered for the repository: tool, arguments, outcome, latency label, degraded codes and citation handles. |
| `failing` | Failing answer | The request that gave the wrong answer, a summary of the envelope it returned and, for up to five of its facts, the kind, tier, confidence and extractor. |

Source text is never in a bundle.

<!-- verified-by: cli: gsd-atlas bug --what "the symbol lookup was wrong" --expected "a definition" --steps "ran find" -->
```json
{"schema":"gsd-atlas.bug/1","ok":true,"data":{"written":true,"path":"/path/to/cache/gsd-atlas/bug-reports/20261019T004956Z-85a302c4","files":["bundle.json","preview.txt"],"included":[],"digest":"85a302c4636d0ff9fb9cc25b939b94287c49b6846ab350ec7494da67b2c8632c","bytes":237,"preview":"gsd-atlas bug bundle: format gsd-atlas-bug-v1, mode hashed, 237 bytes, sha256 85a302c4636d\nContains: report header, your own text\nNothing is uploaded. The bytes below are exactly what is written to bundle.json on this machine.\n----- bundle.json -----\n{\n  \"format\": \"gsd-atlas-bug-v1\",\n  \"header\": {\n    \"atlas_version\": \"0.0.0\",\n    \"catalog_version\": 1\n  },\n  \"problem\": {\n    \"what_happened\": \"the symbol lookup was wrong\",\n    \"expected\": \"a definition\",\n    \"steps\": \"ran find\"\n  }\n}\n"},"diagnostics":[]}
```

### gsd-atlas lang list

```
gsd-atlas lang list [root flags]
```

- Options: the module roots.
- Result schema: `gsd-atlas.lang-list/1`.
- `data.modules[]`: `name`, `source` (`repo`, `user`, `npm` or `builtin`), `dir`, `version`, `schemaVersion` (the manifest version the module is written at, 1 or 2), `adrDirs` (the ADR directories its manifest names; empty for a version 1 manifest), `extensions`, `inactiveExtensions` (extensions another module owns), `tiers[]` (`tier`: `grammar`, `precise` or `platform`; `active`; `reason` when given), `shadowed[]` (`source`, `dir`).

### gsd-atlas lang test

```
gsd-atlas lang test <module-folder>|<module-id> [root flags]
```

- Takes exactly one argument. A directory wins over a module id of the same name.
- Options: the module roots.
- Result schema: `gsd-atlas.lang-test/1`. `data`: `ok`, `module`, `fixtures[]` (`file`, `ok`), `diagnostics`; `data` is `null` when the check could not run.
- Exit 0 when every check passes, 1 for `module_not_found`, 2 for a failed check.

## Result envelope

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | string | The schema id of the answer, such as `gsd-atlas.code-find/1`. An error has `gsd-atlas.error/1`. |
| `ok` | boolean | False for a failure. |
| `data` | object or `null` | The result; `null` when `ok` is false. |
| `diagnostics` | array | `{ code, severity, message, subject? }` with `severity` one of `error`, `warning`, `info`. |
| `citations` | array | Where each fact lives: `id`, `path`, `line`, `col`, `endLine`, `endCol` (1-based), `confidence`, `debug` (a handle), `text_ref`. A citation never carries source text. |
| `watermark` | object | `seq` (advances after each commit to the worktree's index) and `stalePaths` (paths the answer may not reflect yet). |
| `untrusted_text` | object | `nonce` and `entries[]` (`ref`, `text`). The only place repository text appears; each entry is tied to a citation by `text_ref`. Each text is wrapped in `BEGIN-UNTRUSTED-<nonce>` and `END-UNTRUSTED-<nonce>` lines. |
| `truncated` | boolean | The answer was cut to fit the budget or limit. |
| `more` | string | The cursor for the next page. |
| `hints` | array of strings | Fixed sentences about the answer. |
| `retry_after` | number | Milliseconds to wait; present only on a `busy` error. |
| `degraded` | array | Why the answer is weaker than a full, fresh one (see [Degraded codes](#degraded-codes)). Absent when empty. |
| `answer_id` | string | `a_` and 16 hexadecimal digits, new for every answer. Present on the answers and error answers of the code tools and `explain`, `health` and `lang list`; absent on `build`, `maintain`, `status`, `history`, `rate`, `allow`, `bug`, `diagnostics` and `init`. `explain` accepts it, and `bug --answer` names it. The flight recorder keeps only the newest answers of a repository, on this machine. |

`confidence` is `EXTRACTED` or `INFERRED`. Optional fields are left out of the JSON when they have no value.

Sample (a `find` answer; the `nonce` differs on every answer, and a `build` or `health` answer names the directory you ran in):

<!-- verified-by: cli: gsd-atlas find parseConfig -->
```json
{"schema":"gsd-atlas.code-find/1","ok":true,"data":{"results":[{"name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"col":8,"exported":true,"confidence":"EXTRACTED","citation":"c1"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/config.ts","line":6,"col":8,"endLine":9,"endCol":2,"confidence":"EXTRACTED","debug":"sym/src%2Fconfig.ts/857f7ac2756066bca45830ed44fbc76df7e8cc69/3","text_ref":"ut1"}],"watermark":{"seq":4,"stalePaths":[]},"untrusted_text":{"nonce":"69654d9f6d4b47f7863464e24ffc24e4","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-69654d9f6d4b47f7863464e24ffc24e4\nexport function parseConfig(text: string, fallbackName: string): Config {\nEND-UNTRUSTED-69654d9f6d4b47f7863464e24ffc24e4"}]}}
```

## Diagnostic codes

| Code | Severity | Condition | Exit |
| --- | --- | --- | --- |
| `not_indexed` | error | The repository, or the worktree, has no index to read. | 2 |
| `not_a_repo` | error | `repo` is not an existing directory inside a git repository. | 2 |
| `invalid_args` | error | A request argument was refused. | 1 |
| `bad_cursor` | error | The `more` cursor is malformed, too long or was issued for a different query. | 2 |
| `output_too_large` | error | A single result is larger than the output ceiling. | 2 |
| `commit_not_found` | error | The revision names no commit the repository holds; nothing was fetched. | 2 |
| `git_failed` | error | `git` could not read the commit. | 2 |
| `history_unavailable` | error | The temporary directory is inside the repository or its index. | 2 |
| `lease_held` | error | Another process holds the writer lease and the command needs it. | 3 |
| `busy` | error | The host is busy; `retry_after` says when to retry. | 3 |
| `store_unavailable` | error | The index could not be opened, or closed itself and cannot answer. | 2 |
| `schema_too_new` | error | The index was written by a newer gsd-atlas. | 2 |
| `timeout` | error | The request took too long and was stopped. | 2 |
| `unknown_worktree` | error | The directory is not a worktree of the repository. | 2 |
| `tenant_closed` | error | The repository was closed while the request ran. | 2 |
| `unavailable` | error | The index status is not available from this host right now. | 2 |
| `internal_error` | error | A bug inside the host; the subject names the error type. | 2 |
| `module_not_found` | error | `lang test` target is neither a module folder nor a known module id. | 1 |
| `invalid_handle` | error | `explain` was given a handle that is malformed, too long or not a fact of this index. | 2 |
| `stale_handle` | error | The file behind the handle of `explain` has changed since the handle was issued. | 2 |
| `answer_not_found` | error | The flight recorder holds no answer with the `answer_id` given to `explain`. | 2 |
| `no_recent_answer` | error | `rate` found no recorded answer to rate. | 2 |
| `allow_needs_terminal` | error | `allow` was run without a terminal. | 2 |
| `diagnostics_needs_terminal` | error | `diagnostics enable` or `diagnostics types` was run without a terminal. | 2 |
| `bug_needs_text` | error | `bug` without a terminal was given none of `--what`, `--expected` and `--steps`. | 2 |
| `raw_not_confirmed` | error | `bug --mode raw` without a terminal and without `--confirm-raw`. | 2 |
| `invalid_fresh_path` | warning | A `--fresh` path was refused; the answer is still given. | 0 |
| `needs_approval` | warning | A command a language module declares was not run because it is not approved (see [`gsd-atlas allow`](#gsd-atlas-allow)). | 0 |
| `compiler_fallback` | info | A compiler other than the project's own did the resolving; the text names the case. | 0 |
| `diagnostics_off` | info | `diagnostics preview` while diagnostics are off. | 0 |
| `history_truncated` | warning | A commit has more than 2000 source files. | 0 |
| `user_config_ignored` | warning | The user configuration file, or `GSD_ATLAS_STORE_DIR`, was ignored. | 0 |

## Degraded codes

A degraded answer still carries its data. The `degraded` codes, their order and their meanings are in [the MCP reference](mcp.md#degraded-codes); the command line reports the same codes in the same field.

### Health reasons

`data.reasons` of `health` lists, in this order: `follower` (this process does not hold the writer lease), `rebuilding` (a corrupt store was found, moved aside and rebuilt), `reconciling`, `stale_files` (a worktree has stale paths), `watch_fallback` (the watch mode is `reconcile-only`), `indexer_failures` (the indexer gave up on one or more paths). `follower`, `rebuilding`, `reconciling` and `stale_files` also appear in `degraded` as `follower`, `rebuilding`, `reconciling` and `stale`.

## Defaults and limits

| Value | Default | Meaning |
| --- | --- | --- |
| Budget | 2000 | Estimated tokens in an answer when `--budget` is not given. |
| Budget ceiling | 8000 | The most estimated tokens any answer carries, whatever budget was asked. |
| Line width | 240 | Width every line of `untrusted_text` is cut to, in UTF-16 code units. |
| Limit | 50 | Results per answer when `--limit` is not given. |
| Maximum limit | 200 | A larger `--limit` is clamped to this. |
| Cursor length | 1024 | The longest `more` cursor accepted, in characters. |
| Fresh wait | 2000 | Milliseconds an answer waits for `--fresh` paths. |
| Resolve timeout | 1500 | Milliseconds the reference resolver may take before the answer degrades. |
| Impact depth | 2 | Hops `impact` follows when `--depth` is not given. |
| Impact maximum depth | 5 | A larger `--depth` is reduced to this. |
| Impact row cap per hop | 200 | Items one hop keeps for each seed; anything cut is reported. |
| History file cap | 2000 | Source files `history` reads from one commit. |
| Context references | 10 | References `context` shows. |
| Reference targets | 5 | Definitions `refs` and `impact` follow, and alternatives `context` lists. |

## Environment and user configuration

| Name | Meaning |
| --- | --- |
| `GSD_ATLAS_USER_DIR` | The user configuration folder. Default `<home>/.config/gsd-atlas`. |
| `GSD_ATLAS_STORE_DIR` | Absolute directory under which each repository's store lives, in a folder named by its store id. Wins over `store.dir` in the configuration file. A relative value is ignored with a warning. |
| `XDG_CACHE_HOME` | Absolute path, used as the cache root. Default `<home>/.cache`. A relative value is ignored. `bug` writes its bundles below it. |
| `XDG_STATE_HOME` | Absolute path, used as the state root. Default `<home>/.local/state`. `diagnostics preview --save` writes below `<state root>/gsd-atlas`. |
| `TMPDIR` | The directory `history` creates its temporary store in (the operating system's temporary directory by default). |

The configuration file is `<user-dir>/config.json`, read only from there and never from a repository. It is at most 64 KiB. Every key is optional and unknown keys are not allowed:

| Key | Type | Meaning |
| --- | --- | --- |
| `store.dir` | absolute path | Same as `GSD_ATLAS_STORE_DIR`. |
| `indexer.debounceMs` | positive whole number | Debounce of file events. Default 100. |
| `indexer.maxWaitMs` | positive whole number | Longest a changed path waits before indexing; not below `debounceMs`. Default 500. |
| `gc.graceMs` | whole number, 0 or more | How long a retired file version is kept when git does not have its blob. Default 24 hours. |
| `permissions.allow` | array of `{ repo, executable, argsPrefix?, sha256? }` | Commands the command runner may start beyond its built-in read-only git rule. `repo` is an absolute path. `sha256` binds the entry to one exact command (executable, arguments and working directory); `gsd-atlas allow` writes entries of the form `{ repo, executable, sha256 }`. |
| `providers.disabled` | array of strings | Ids of built-in providers to turn off. `typescript` turns off the compiler (precise) tier. An id nobody knows is accepted and has no effect. |

A file that is larger than the cap, cannot be read, is not valid JSON or has a wrong key or value is ignored whole. Stderr then carries `gsd-atlas: warning user_config_ignored: The user configuration file was ignored: <reason>. Defaults are in effect.`

### Where the index lives

By default the store is the folder `gsd-atlas` inside the repository's git common directory, shared by every worktree of the repository; nothing is written to the working tree. The folder holds `facts.db`, `lease.db`, `metrics.db` (the metrics counters and the `ratings` table) and, while a process holds the writer lease, `lease.json`; the folder `flight` holds the flight recorder, `flight.jsonl`.

The store moves to `<cache root>/gsd-atlas/<store id>` when the git common directory is missing, not writable, inside a synced folder (iCloud Drive, Dropbox, OneDrive, Google Drive), on a network mount, or when `gsd-atlas` there is itself a symbolic link. A `store.dir` or `GSD_ATLAS_STORE_DIR` setting wins over all of this and puts the store at `<dir>/<store id>`. Only `build` creates a store.

## See also

- [Index a repository and ask it questions](../tutorials/index-and-ask.md): a first lesson
- [How to register the MCP server with Claude Code, Cursor and Codex](../how-to/register-the-mcp-server.md)
- [How to answer a question about an older commit](../how-to/answer-a-question-about-an-older-commit.md)
- [How to keep the store healthy](../how-to/keep-the-store-healthy.md)
- [How to run the measured gates locally](../how-to/run-the-measured-gates-locally.md)
- [How to contribute a change](../how-to/contribute-a-change.md)
- [How to see why atlas gave an answer](../how-to/see-why-atlas-gave-an-answer.md)
- [How to find the code that cites an ADR](../how-to/find-the-code-that-cites-an-adr.md)
- [How to approve a precise command for one repository](../how-to/approve-a-precise-command.md)
- [How to install the gsd-atlas skills](../how-to/install-the-skills.md)
- [gsd-atlas MCP reference](mcp.md)
- [gsd-atlas TypeScript support reference](typescript-support.md)
- [gsd-atlas ADR citations reference](adr-citations.md)
- [About how freshness and the writer lease work](../explanation/how-freshness-and-the-writer-lease-work.md)
