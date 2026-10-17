# gsd-atlas

gsd-atlas keeps a live, local map of a codebase and the platform SDKs it targets, and serves it to coding agents over MCP, a CLI and an Agent Skill. It is built to give agents correct, cited, current answers about the code and the platform they build against, instead of guesses from stale training data.

Today it builds a local fact index of a TypeScript or JavaScript repository on macOS, Linux or Windows and answers cited, fresh, worktree-correct questions (`find`, `refs`, `context`, `impact`) through the `gsd-atlas` command or a stateless stdio MCP server. The precise (compiler) tier, the SDK packs, the Agent Skill and the daemon transport come in later phases.

Requires Node 24.16.0 or newer (24.15.0 truncates TEXT at an embedded NUL in `node:sqlite`). CI runs Node 24.16.0 and 26 on macOS, Linux and Windows.

## Developer quickstart

Run these from the repository root.

```sh
# install exact pinned dependencies without running install scripts
npm ci --ignore-scripts

# compile src/ to dist/ (the published layout)
npm run build

# full test suite (also builds and packs the tarball; the pack test uses the network)
npm test

# static checks
npm run lint
npm run typecheck
npm run schema:check

# parse-error budget over the grammar fixtures
npm run grammar:budget

# rebuild the toy grammar from source and compare it with grammar.lock;
# the first command downloads the wasi-sdk toolchain used by tree-sitter-cli
node scripts/ensure-tree-sitter.ts
npm run grammar:verify

# run the walking skeleton: check the toy language module against its golden files
node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy

# show which language modules were found and where each one came from
node dist/bin/gsd-atlas.js lang list
```

Both commands print one JSON envelope on stdout and put reasons on stderr. The exit code is 0 on success, 1 for usage errors or an unknown module, and 2 for a failed check.

## Phase 2 quickstart

Index a repository and ask it questions. Run these after `npm run build`, from the repository you want to index. The bins are `dist/bin/gsd-atlas.js` and `dist/bin/gsd-atlas-mcp.js`; installed from npm they are `gsd-atlas` and `gsd-atlas-mcp`.

```sh
# index the repository: the only command that creates an index (exit 3 when another process holds the writer)
node dist/bin/gsd-atlas.js build

# ask: where is it defined, who uses it, what surrounds it, what breaks if it changes
node dist/bin/gsd-atlas.js find parseConfig
node dist/bin/gsd-atlas.js refs parseConfig
node dist/bin/gsd-atlas.js context parseConfig
node dist/bin/gsd-atlas.js impact parseConfig --depth 2

# the code as of a commit, answered from the repository history alone; it never writes to the index
node dist/bin/gsd-atlas.js history find parseConfig --at HEAD~10

# index health, and local usage metrics (token figures are estimates)
node dist/bin/gsd-atlas.js health
node dist/bin/gsd-atlas.js status --since 7d

# store upkeep: collect retired facts, compact the file, check integrity
node dist/bin/gsd-atlas.js maintain
node dist/bin/gsd-atlas.js maintain compact --full

# register the stdio MCP server with Claude Code, Cursor and Codex (add --dry-run to preview)
node dist/bin/gsd-atlas.js init
```

Every command prints one JSON envelope on stdout and puts reasons on stderr. Exit codes: 0 ok, 1 usage error, 2 failure, 3 the writer lease is held by another process or the host is busy.

The MCP server is `node dist/bin/gsd-atlas-mcp.js`, a stateless stdio server whose tools are `code_find`, `code_refs`, `code_context`, `code_impact` and `atlas_status`. While it runs it holds the writer lease, watches the working tree and keeps the index fresh, so a saved file is found by the next question. A command-line question asked at the same time is answered read-only (`degraded: follower`).

The measured gates behind these claims run against the pinned `gsd-core` corpus (they fetch it into a temporary directory and remove it afterwards):

```sh
# per-construct recall against the TypeScript compiler as an independent oracle
npm run recall:corpus

# build the corpus twice through the Host: source set, accounting, parse errors, second-build idempotence, database size
npm run gates:corpus

# 20,000 edits against a fresh build, store size ratio
npm run size-gate

# save-to-find time: prints p50, p95 and p99 and fails above --max-ms (default one second)
npm run gates:freshness -- --saves 30 --max-ms 3000
```

## Documentation

- Architecture decisions: [docs/adr/README.md](docs/adr/README.md)
- Product requirements: [docs/PRD.md](docs/PRD.md)

## Licence

MIT. See [LICENSE](LICENSE).
