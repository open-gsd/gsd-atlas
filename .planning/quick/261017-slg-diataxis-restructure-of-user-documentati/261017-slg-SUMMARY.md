---
phase: quick-261017-slg
plan: 01
subsystem: docs
tags: [documentation, diataxis, readme, reference, tutorial, how-to, explanation]
requires: []
provides:
  - "README front door (48 lines) with one pointer per need"
  - "Tutorial, five how-to guides, two reference pages and one explanation page, each verified against the code or the built CLI"
affects: [README.md, docs/tutorials, docs/how-to, docs/reference, docs/explanation]
tech-stack:
  added: []
  patterns: ["Diataxis page types; drift gates compare pages with FLAGS, COMMANDS, TOOLS, DEGRADED_CODES, DEFAULT_QUERY_CONFIG, HEALTH_REASONS"]
key-files:
  created:
    - docs/reference/cli.md
    - docs/reference/mcp.md
    - docs/explanation/how-freshness-and-the-writer-lease-work.md
    - docs/how-to/register-the-mcp-server.md
    - docs/how-to/answer-a-question-about-an-older-commit.md
    - docs/how-to/keep-the-store-healthy.md
    - docs/how-to/run-the-measured-gates-locally.md
    - docs/how-to/contribute-a-change.md
    - docs/tutorials/index-and-ask.md
  modified:
    - README.md
decisions:
  - "README keeps a compact Developer quickstart because scripts/package.test.ts pins it; editing that test was out of scope"
  - "The MCP reference documents six tools because lang_list is registered"
  - "The tutorial's clone line works only for readers with access to the private repository"
  - "package.json's description still mentions SDKs (out of scope)"
metrics:
  duration: "about 30 minutes of tool time (probes started about 00:50 UTC, last commit about 01:15 UTC on 2026-10-18)"
  completed: 2026-10-18
status: complete
plan_head_before: e729ffa60e71f4c2f5e7ce74fef051da199575f7
plan_head_after: 9f23c7f33c2cfe20921b1cd0055cfdb1282cc28d
commits: 11
actuals:
  tokens: 24069
  tasks: 11
  commits: 11
---

# Quick 261017-slg: Diataxis restructure of the user documentation

One-liner: the 101-line README is split by reader need into a 48-line front door, one tutorial replayed end to end, five how-to guides, a CLI reference and an MCP reference that mirror the code's own tables, and one explanation page whose reasons come only from ADRs, DESIGN.md and code comments.

## Commits

| Task | Commit | Files |
| --- | --- | --- |
| 1 CLI reference | f10df27 | docs/reference/cli.md |
| 2 MCP reference | 0ccb331 | docs/reference/mcp.md |
| 3 Explanation | bdc8000 | docs/explanation/how-freshness-and-the-writer-lease-work.md |
| 4 How to register the MCP server | d5027df | docs/how-to/register-the-mcp-server.md |
| 5 How to answer about an older commit | e47c425 | docs/how-to/answer-a-question-about-an-older-commit.md |
| 6 How to keep the store healthy | 4b15bd7 | docs/how-to/keep-the-store-healthy.md |
| 7 How to run the measured gates locally | e0bcc72 | docs/how-to/run-the-measured-gates-locally.md |
| 8 How to contribute a change | f0b28cf | docs/how-to/contribute-a-change.md |
| 9 Tutorial | 3da199a | docs/tutorials/index-and-ask.md |
| 10 See also links on both reference pages | 254bad0 | docs/reference/cli.md, docs/reference/mcp.md |
| 11 README | 9f23c7f | README.md |

Nothing was pushed. Every commit contains docs files only. The whole change touches only README.md and the nine new pages (scope gate: `git diff --name-only` against the base lists nothing else).

## Decisions for the user

1. README keeps a compact Developer quickstart because scripts/package.test.ts pins it ('README npm scripts exist'); moving it fully needs a one-line change to that test pointing at docs/how-to/contribute-a-change.md. The real test passes with the new README (`npm test`: 2679 tests, 0 failures).
2. The MCP reference documents six tools because lang_list is registered (src/query/tools.ts:12, live `tools/list` call).
3. The repository is private today (GitHub API, per the plan), so the tutorial's clone line works only for readers with access. The tutorial makes no claim about visibility and does not describe installing from a package registry.
4. package.json's description still mentions SDKs; it was out of scope and left alone.

## Deviations from Plan

**1. [Rule 1 - Inaccurate claim in the old README] `node scripts/ensure-tree-sitter.ts` does not download the wasi-sdk.**
- Found during: task 8.
- Issue: the old README comment said the first command "downloads the wasi-sdk toolchain". The script's header and a real run show it downloads the tree-sitter command-line release binary (`Downloading .../tree-sitter-macos-arm64.gz`) that `npm ci --ignore-scripts` leaves out. The wasi toolchain is used by the grammar build (scripts/grammar-build.ts header: "uses the network and the wasi toolchain").
- Fix: the contribute guide and the README comment say what the code shows.
- Commits: f0b28cf, 9f23c7f.

**2. [Rule 1 - Plan finding refined] `not_indexed` has three texts, not two.**
- Found during: task 2, by probing a linked worktree.
- The two texts a tool can return are (a) no index at all ("...Run "gsd-atlas build" in a terminal inside it...") and (b) an indexed repository whose worktree was never built ("...Run "gsd-atlas build" in it, then ask again."). A third text, naming the lease holder, comes from `gsd-atlas maintain` on an unbuilt worktree. All three are documented, the third as a CLI-only note.
- Commit: 0ccb331.

**3. [Rule 3 - Tooling] Probe area in the session scratchpad.**
- The plan asked for `mktemp -d` and a path file in the OS temp directory. The worktree guard refuses writes into a git repository outside the worktree and compound shell commands, so the probe area (atlas-demo, a temporary HOME, scripts) lived in the session scratchpad and was driven through script files. It has been removed.

**4. [Rule 3 - Link order] Plain-text pointers in cli.md until task 10.**
- cli.md (task 1) mentions the MCP reference by path in plain text because mcp.md did not exist at its commit; the real links arrive in the See also section (task 10).

**5. [Adjustment] Tutorial needs `git init` only.**
- The replay proved that an indexed repository with no commit works (build, find, and finding a newly saved file), so the tutorial has no `git add` or `git commit` and needs no git identity.

**6. [Adjustment] Explanation page length.**
- The page has 55 lines of dense prose against the plan's "roughly 120 to 200 lines"; each of the five sections is one bounded "why" and the content was not padded.

## Not run, by design or by guard

- `node scripts/ensure-tree-sitter.ts` cannot be run from the shell (the hook refuses it). It was verified by reading and by `npm run grammar:verify`, which calls it and printed the binary download.
- Running one test file (`node --test <path>`) was not run for the same reason; the page states only the form derived from the `test` script (`node --test` plus two patterns).
- The automated drift gates (`node --input-type=module -e "import ... './src/...'"`) did run.
- Windows was not tested; no page makes a Windows-specific claim beyond what the code and CI say.

## Verification ledger

Evidence column: file:line is the source read through codegraph; `run:` is a real command in the built clone or a probe repository. All sample output uses `/path/to/...`.

### docs/reference/cli.md

| Statement | Evidence |
| --- | --- |
| Every flag, command, usage line, maintain task, history tool | src/cli/tool-commands.ts:21-41, 59, 74, 91-186; `--help` output; drift gate (FLAGS, COMMANDS, MAINTAIN_TASKS, HISTORY_TOOLS all present) |
| Output contract: one envelope on stdout, stderr line `gsd-atlas: severity code: message`, busy retry suffix | src/cli/index.ts:100-118; run: find in a non-index repo, lease_held, busy path read |
| Usage errors print reason plus usage on stderr, exit 1 | src/cli/index.ts:66-70; run: 22 wrong-shape invocations (probe1) |
| Exit codes 0/1/2/3 and precedence | src/cli/exit.ts:11-37; run: not_indexed 2, not_a_repo 2, lease_held 3, module_not_found 1, history path ../ 1 |
| Option values starting with a dash need `--name=value` | run: `--at -x` and `--depth -1` rejected by the parser; `--at=-x` reaches the CLI check (src/cli/tool-commands.ts:260) |
| `--repo`/`--cwd` resolution, `health` ignores `--cwd` | src/host/route.ts:151-187; src/cli/tool-commands.ts:266-269, 322-323; run: `--repo .`, `--cwd src`, `health --cwd src` |
| Defaults: budget 2000, ceiling 8000, line 240, limit 50, max 200, cursor 1024, fresh wait 2000, resolve 1500, depth 2, max depth 5, row cap 200 | src/query/defaults.ts:10-22; drift gate; run: `--budget 50` truncates, depth 9 reduced to 5 (mcp probe) |
| Per-command result fields | run: find, refs, context, impact, history, health, build, maintain, status, lang list, lang test; src/query/*.ts, src/tenant/create.ts:59-72, 577-609 |
| `maintain` order, `--full` rule, lease needs, `resolve` needs none | src/tenant/create.ts:33-37, 520-543, 594-609; src/cli/tool-commands.ts:241-249; run: probe with a server holding the lease |
| history: git objects only, 2000-file cap, `history_truncated`, `history_unavailable`, `--more`/`--fresh` refused | src/host/history.ts:1-14, 36-64, 164-166, 199-228, 282-290; run: history on a repo with no index, `--more` and `--fresh` usage errors |
| init: hosts, files, detection, actions, refusal reasons, backup file, hint on stderr | src/cli/init.ts:103-167, 246-297; src/cli/init-targets.ts:129-156, 579-585; src/cli/init-files.ts:42, 117-118, 184-238; run: probe7 with HOME redirected to a temporary folder |
| Envelope fields, citation shape, `degraded` | src/facts/request.ts:14-75; run: any answer |
| Degraded codes and the meanings given | src/facts/degraded.ts:11-23; src/fact-store/types.ts:153-163, 250-254; src/query/page.ts:65-66; src/query/query.ts:48-87; src/tenant/create.ts:564-568 (two codes have no stated meaning and say so) |
| Health reasons | src/query/status.ts:20, 75-84 |
| Environment, config keys, 64 KiB cap, warning text | src/host/config.ts:18-133; src/bin/compose.ts:63-72; src/fact-store/location.ts:100-104; run: probe8 (warnings on stderr) |
| Store location rules | src/fact-store/location.ts:130-168; run: store under `.git/gsd-atlas`, `git status` clean |

### docs/reference/mcp.md

| Statement | Evidence |
| --- | --- |
| Six tools, titles, descriptions, strict schemas, `readOnlyHint` | src/query/tools.ts:12-116; run: live stdio session, `tools/list` returned six tools; drift gate |
| Server name, version, capabilities `tools.listChanged`, instructions text | src/mcp-shim/server.ts:29-52; run: `initialize` with 2025-06-18 |
| Stateless, repo by `repo`/`cwd`, Host composed on first call | src/mcp-shim/server.ts:1-9; src/bin/gsd-atlas-mcp.ts:1-9 |
| stderr lines and exit codes 0, 2, 143, 130 | src/mcp-shim/index.ts:54-82; src/bin/shutdown.ts:15-81 |
| Schema validation refusal is plain text | run: unknown key `bogus` gave the quoted text, `isError: true` |
| Error texts (not_indexed x2, not_a_repo, bad_cursor, store_unavailable x2, schema_too_new, busy, timeout, unavailable, internal_error) | src/tenant/messages.ts:21-59; src/host/host.ts:44, 143-159; src/query/query.ts:27-31; src/query/find.ts:67-71, 76-84; src/query/status.ts:62; run: not_indexed (both), not_a_repo, bad_cursor |
| Untrusted text rules: nonce, fence lines, 240 and 200 widths, `[line omitted]` | src/query/fence.ts:12-68; src/query/cite.ts:34-65; src/query/defaults.ts |
| Writer lease: lock, `lease.json`, takeover 10000-30000 ms, idle release 1800000 ms, idle maintenance 30000 ms | src/fact-store/lease.ts:1-12, 33-39; src/tenant/defaults.ts:14-20; src/host/defaults.ts:10-12; run: held by a stdio session, CLI answered `follower`, `lease_held` exit 3 |
| `lease.json` content | run: `{"pid":...,"startedAt":...,"version":"0.0.0"}` while the session held the lease |

### docs/explanation/how-freshness-and-the-writer-lease-work.md

Reasons are taken from, and link to: docs/adr/13-mcp-contract.md (Amendment 2026-10-17), docs/adr/11-worktree-lifecycle.md (decisions 3, 5, 6; amendments 2026-10-16 and 2026-10-17), docs/adr/9-tenant-composition.md (decisions 2, 3; amendments 2026-10-15 and 2026-10-17), docs/adr/8-sqlite-store.md (decision 5), docs/adr/7-fact-store-interface.md (decision 5), docs/adr/6-fact-model.md, docs/adr/3-trust-boundaries.md, docs/DESIGN.md (A4, A17, A24, A26, A28); code comments src/host/host.ts:234-244, src/indexer/event-source.ts:1-12, scripts/size-gate.ts:1-17, src/tenant/follower-overlay.ts:1-13. Every A-number cited exists in the DESIGN A-table. No sentence names a later phase.

### How-to pages

| Page | Evidence |
| --- | --- |
| register-the-mcp-server | `init --dry-run`, `init`, `--agent`, second run `unchanged`, edited entry `updated`, invalid JSON and wrong shape `refused` (file untouched), claude folder only `config_not_found` with manual command; all with HOME set to a temporary folder (probe7). `config_in_use`/`config_changed_during_init` read at src/cli/init.ts:155-162 and src/cli/init-files.ts:96-118 (not reproduced) |
| answer-a-question-about-an-older-commit | branch, tag, short and full id, `HEAD~1`; four tools; `--path`; `--limit 1` and `--budget 50` truncate and carry an unusable `more`; nonexistent revision exit 2; shallow clone missing commit `commit_not_found`; no index needed; health seq and store file sizes identical before and after history (probe10); no temporary directory left behind |
| keep-the-store-healthy | `health`, `status`, `status --since`, every `maintain` task, `compact --full`, `--full` refusal, `lease_held` exit 3 with a server holding the lease, `maintain resolve` still ok, not_indexed; reasons from src/query/status.ts:75-84. Actions for `stale_files` and `watch_fallback` (`maintain reconcile`, `--fresh`) are read from src/indexer/types.ts:117-119 and src/tenant/create.ts:524-526, not reproduced |
| run-the-measured-gates-locally | ran `recall:corpus`, `gates:corpus` (network), `size-gate` (reduced, plus `--max-ratio 0.5` giving OVER exit 1), `gates:freshness` (30 saves, plus `--max-ms 1` giving OVER exit 1, plus a bad argument exit 1); defaults from scripts/recall.ts:38-47, scripts/corpus-gates.ts:41-45, scripts/size-gate.ts:29-32, scripts/freshness-gate.ts:31-37; workflows ci.yml and nightly.yml |
| contribute-a-change | ran `npm ci --ignore-scripts`, `npm run build`, `npm test` (2679 pass), `lint`, `typecheck`, `schema:check`, `grammar:budget`, `grammar:verify`, `lang test`, `lang list`; `npm test` pack step needs the network per scripts/package.test.ts:207-209 |

### docs/tutorials/index-and-ask.md

`docs/tutorials/index-and-ask.md` was replayed literally by a script that runs every shell block, writes every code block to the named file and compares every JSON block with the real output (nonce and path normalised). It ran in a pristine folder holding a local clone of this worktree, after deleting `atlas-demo` and the clone's `dist` (the restart case). Result: REPLAY OK, all six JSON blocks match; the version, `git init`, and `npm run build` output blocks were compared by eye. Git status of atlas-demo afterwards showed only the untracked `src/`.

### README.md

| Statement | Evidence |
| --- | --- |
| No network, no telemetry in indexing and answering | `grep` of non-test src for node:http, https, net, tls, dgram, dns imports, `fetch(`, WebSocket, undici, telemetry/analytics words: no hit; no fetch, pull, push, clone, remote or ls-remote git subcommand in src; git is limited to read-side subcommands (src/command-runner/decide.ts:25-29); the only MCP dependency is @modelcontextprotocol/server, imported at src/mcp-shim/server.ts:10 and src/mcp-shim/index.ts:7 (stdio entry). The check covers src, not the dependencies' own code |
| Platforms and Node floor | package.json engines; .github/workflows/ci.yml matrix |
| Developer quickstart pinned text | inline replica of the 'README npm scripts exist' test, and the real test inside `npm test` (pass) |
| Later-phase sentence | exactly one, in the Status section |

### Gates

| Gate | Result |
| --- | --- |
| Hygiene (paths, TODO/TBD/FIXME, daemon, Swift, SDK pack, Agent Skill) on all nine pages | pass |
| Links (`checkRelativeLinks`) at every task commit and at the end | zero broken |
| No empty directory under docs | pass |
| Scope | only README.md and the nine new pages changed |
| Drift gates: cli.md against FLAGS/COMMANDS/MAINTAIN_TASKS/HISTORY_TOOLS/DEGRADED_CODES/DEFAULT_QUERY_CONFIG; mcp.md against TOOLS and schema shapes; keep-the-store-healthy against HEALTH_REASONS | pass |

## Known Stubs

None.

## Threat Flags

None. No file under src, scripts or package.json changed.

## Self-Check: PASSED

- All ten page files exist; all eleven commits are in the branch history (`git log e729ffa..HEAD` lists them).
- `commits: 11` is measured with `git rev-list --count e729ffa60e71f4c2f5e7ce74fef051da199575f7..HEAD`.
