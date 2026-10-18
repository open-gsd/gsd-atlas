# gsd-atlas command-line reference

Requirements: Node 24.16.0 or newer, `git` on the path, macOS, Linux or Windows. Node 24.15.0 truncates `TEXT` values at an embedded NUL in `node:sqlite`, which is why the floor is 24.16.0 (`engines` in `package.json`; the comment in `.github/workflows/ci.yml`).

The package has two bins, declared in `package.json`. In a built clone they are:

| Bin | Path in a built clone | Purpose |
| --- | --- | --- |
| `gsd-atlas` | `dist/bin/gsd-atlas.js` | The command line described on this page. |
| `gsd-atlas-mcp` | `dist/bin/gsd-atlas-mcp.js` | The stdio MCP server, described in the MCP reference (`docs/reference/mcp.md`). |

The command runs the Host inside its own process. It starts no background service of its own: when the command ends, it closes its Host and releases whatever it held.

## Output contract

- stdout carries exactly one JSON envelope, printed as the Host returned it, followed by a newline. `--version` and `--help` print text instead.
- stderr carries one line per diagnostic whose severity is `error` or `warning`, in the form `gsd-atlas: <severity> <code>: <message>`. A `busy` answer appends ` (retry after <n> ms)`.
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
| 2 | Any other failure. | `not_indexed`, `not_a_repo`, `bad_cursor`, `output_too_large`, `commit_not_found`, `git_failed`, `history_unavailable`, `store_unavailable`, `schema_too_new`, `timeout`, `unknown_worktree`, `tenant_closed`, `unavailable`, `internal_error`, `config_refused`, `launch_command_invalid`, and an envelope with `ok: false` and no code above |
| 3 | Another process holds the writer lease, or the host is busy. | `lease_held`, `busy` |

Precedence when an envelope carries several codes: usage (1), then lease held or busy (3, even when other errors ride along), then any other failure (2), then ok (0). A not-ok envelope without a diagnostic list exits 2.

## Options

Options are parsed strictly: an option that is not in the table for the command is a usage error (`--<name> does not apply to <command>`), and an option value that starts with a dash must be written `--name=value`.

`--version` (`-v`) prints `gsd-atlas <version>` on stdout and exits 0. `--help` (`-h`) prints the usage text on stdout and exits 0.

### Selection

| Option | Value | Commands | Meaning |
| --- | --- | --- | --- |
| `--repo` | directory | `find`, `refs`, `context`, `impact`, `history`, `health`, `build`, `maintain`, `status` | The repository or worktree to use. |
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
| `--kind` | text | `find`, `refs`, `history` | `find`: only symbols of this kind, for example `function` or `class`. `refs`: only definitions of this kind are followed. |
| `--mode` | `exact`, `prefix`, `fuzzy` or `auto` | `find`, `history` | How names match. Default `auto`. `exact` reads the exact tier, `prefix` the exact and prefix tiers, `fuzzy` and `auto` all three when the name has at least 3 characters. |
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
- Options: `--repo`, `--cwd`. The command prints the JSON of the `code_explain` MCP tool, apart from `answer_id`.
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
- `data`: `worktree`, `files` (files in the source set), `parsed` (files whose facts were extracted), `linked` (files attached to facts the store already held), `removed` (paths that left the index), `skipped` (count of skipped items), `failed` (count of files that failed), `failedCodes` (failure code to count).
- Errors: `not_a_repo`, `lease_held` (exit 3), `store_unavailable`, `schema_too_new`.

### gsd-atlas maintain

```
gsd-atlas maintain [reconcile|resolve|refresh|collect|compact|check|all] [--full] [--repo <dir>] [--cwd <dir>]   (exit 3 when another process holds the writer lease)
```

- Tasks: `reconcile`, `resolve`, `refresh`, `collect`, `compact`, `check`, `all`. The default is `all`, which runs the other six in that order. `--full` is accepted only with `compact` and `all`.
- Options: `--repo`, `--cwd`, `--full`.
- Result schema: `gsd-atlas.maintain/1`. `data.tasks` maps each task that ran to `complete`, `spentMs`, `processed`, and, when present, `note` (`resolve` reports `no precise tier is active`) and `ok` (`check` only).
- Every task except `resolve` needs the writer lease; without it the answer is `lease_held` (exit 3). `reconcile` and `refresh` also need the worktree to have been built.
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

### gsd-atlas init

```
gsd-atlas init [--agent claude|cursor|codex] [--dry-run]
```

- Options: `--agent`, `--dry-run`. Takes no arguments.
- Result schema: `gsd-atlas.init/1`. `data`: `dryRun` and `hosts[]`, one per selected agent, each with `agent`, `file`, `action` and, when there is one, `reason`.
- Per-host actions: `created`, `updated`, `unchanged`, `skipped`, `refused`.
- It edits user-scope files under the home directory and starts no program. The command it registers is the absolute path of the Node executable with the absolute path of the `gsd-atlas-mcp` file as its argument, under the entry name `gsd-atlas`.
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

### gsd-atlas lang list

```
gsd-atlas lang list [root flags]
```

- Options: the module roots.
- Result schema: `gsd-atlas.lang-list/1`.
- `data.modules[]`: `name`, `source` (`repo`, `user`, `npm` or `builtin`), `dir`, `version`, `extensions`, `inactiveExtensions` (extensions another module owns), `tiers[]` (`tier`: `grammar`, `precise` or `platform`; `active`; `reason` when given), `shadowed[]` (`source`, `dir`).

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

`confidence` is `EXTRACTED` or `INFERRED`. Optional fields are left out of the JSON when they have no value.

Sample (a `find` answer; the `nonce` differs on every answer, and a `build` or `health` answer names the directory you ran in):

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
| `invalid_fresh_path` | warning | A `--fresh` path was refused; the answer is still given. | 0 |
| `history_truncated` | warning | A commit has more than 2000 source files. | 0 |
| `user_config_ignored` | warning | The user configuration file, or `GSD_ATLAS_STORE_DIR`, was ignored. | 0 |

## Degraded codes

A degraded answer still carries its data. The codes below are the whole set, in the order they are reported.

| Code | Meaning |
| --- | --- |
| `resolver_failed` | The reference resolver failed; the answer carries grammar-tier `INFERRED` edges. |
| `resolver_timeout` | The reference resolver overran its bound (1500 ms); the answer carries grammar-tier `INFERRED` edges. |
| `fresh_timeout` | The paths named with `--fresh` were not all stored within the wait (2000 ms), or no way to index them was available; the answer comes from the store. |
| `precise_base_commit` | none stated |
| `precise_unavailable` | none stated |
| `stale` | Some files are marked stale and are served from their still-valid facts, or a citation has no source text because its line could not be trusted. |
| `follower` | The answer came from a process that does not hold the writer lease. |
| `cache_unavailable` | A reader without the lease computed its result without the cache. |
| `reconciling` | The index is catching up with the working tree after start-up. |
| `rebuilding` | The store is being rebuilt. |
| `watermark_moved` | The index advanced since the `more` cursor was issued. |

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
| `XDG_CACHE_HOME` | Absolute path, used as the cache root. Default `<home>/.cache`. A relative value is ignored. |
| `TMPDIR` | The directory `history` creates its temporary store in (the operating system's temporary directory by default). |

The configuration file is `<user-dir>/config.json`, read only from there and never from a repository. It is at most 64 KiB. Every key is optional and unknown keys are not allowed:

| Key | Type | Meaning |
| --- | --- | --- |
| `store.dir` | absolute path | Same as `GSD_ATLAS_STORE_DIR`. |
| `indexer.debounceMs` | positive whole number | Debounce of file events. Default 100. |
| `indexer.maxWaitMs` | positive whole number | Longest a changed path waits before indexing; not below `debounceMs`. Default 500. |
| `gc.graceMs` | whole number, 0 or more | How long a retired file version is kept when git does not have its blob. Default 24 hours. |
| `permissions.allow` | array of `{ repo, executable, argsPrefix? }` | Commands the command runner may start beyond its built-in read-only git rule. `repo` is an absolute path. |

A file that is larger than the cap, cannot be read, is not valid JSON or has a wrong key or value is ignored whole. Stderr then carries `gsd-atlas: warning user_config_ignored: The user configuration file was ignored: <reason>. Defaults are in effect.`

### Where the index lives

By default the store is the folder `gsd-atlas` inside the repository's git common directory, shared by every worktree of the repository; nothing is written to the working tree. The folder holds `facts.db`, `lease.db`, `metrics.db` and, while a process holds the writer lease, `lease.json`.

The store moves to `<cache root>/gsd-atlas/<store id>` when the git common directory is missing, not writable, inside a synced folder (iCloud Drive, Dropbox, OneDrive, Google Drive), on a network mount, or when `gsd-atlas` there is itself a symbolic link. A `store.dir` or `GSD_ATLAS_STORE_DIR` setting wins over all of this and puts the store at `<dir>/<store id>`. Only `build` creates a store.

## See also

- [Index a repository and ask it questions](../tutorials/index-and-ask.md): a first lesson
- [How to register the MCP server with Claude Code, Cursor and Codex](../how-to/register-the-mcp-server.md)
- [How to answer a question about an older commit](../how-to/answer-a-question-about-an-older-commit.md)
- [How to keep the store healthy](../how-to/keep-the-store-healthy.md)
- [How to run the measured gates locally](../how-to/run-the-measured-gates-locally.md)
- [How to contribute a change](../how-to/contribute-a-change.md)
- [gsd-atlas MCP reference](mcp.md)
- [About how freshness and the writer lease work](../explanation/how-freshness-and-the-writer-lease-work.md)
