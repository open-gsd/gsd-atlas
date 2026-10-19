# gsd-atlas

gsd-atlas builds a local index of a code repository and answers cited, fresh, worktree-correct questions about it for coding agents: where a symbol is defined, who refers to it, what surrounds it and what depends on it. It answers through the `gsd-atlas` command and a stdio MCP server.

## Status

It indexes TypeScript and JavaScript repositories on macOS, Linux and Windows. It requires Node 24.16.0 or newer (24.15.0 truncates TEXT at an embedded NUL in `node:sqlite`), and CI runs Node 24.16.0 and 26 on all three systems. Indexing and answering questions use no network, and gsd-atlas sends no telemetry. The precise (compiler) tier, SDK packs, the Agent Skill, a daemon transport and Swift support arrive in subsequent phases.

The decision records under [docs/adr](docs/adr/README.md) are drafts for this alpha, and none is ratified. [The alpha limitations](docs/reference/alpha-limitations.md) say what else is not done yet.

## Where to go

- Learn: [Index a repository and ask it questions](docs/tutorials/index-and-ask.md).
- Do:
  - [Register the MCP server with Claude Code, Cursor and Codex](docs/how-to/register-the-mcp-server.md)
  - [Answer a question about an older commit](docs/how-to/answer-a-question-about-an-older-commit.md)
  - [Keep the store healthy](docs/how-to/keep-the-store-healthy.md)
  - [Run the measured gates locally](docs/how-to/run-the-measured-gates-locally.md)
  - [Contribute a change](docs/how-to/contribute-a-change.md)
- Look up: [the command-line reference](docs/reference/cli.md) and [the MCP reference](docs/reference/mcp.md).
- Understand: [About how freshness and the writer lease work](docs/explanation/how-freshness-and-the-writer-lease-work.md).

## Developer quickstart

Run these from the repository root.

```sh
npm ci --ignore-scripts   # install the pinned dependencies without install scripts
npm run build             # compile src/ to dist/
npm test                  # the full suite; its pack step needs the network
npm run lint
npm run typecheck
npm run schema:check
npm run grammar:budget    # parse-error budget over the grammar fixtures
node scripts/ensure-tree-sitter.ts   # download the tree-sitter CLI binary
npm run grammar:verify    # rebuild the grammars and compare them with grammar.lock
node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy
node dist/bin/gsd-atlas.js lang list
```

What each command proves is in [How to contribute a change](docs/how-to/contribute-a-change.md).

## Documentation

- Architecture decisions: [docs/adr/README.md](docs/adr/README.md)
- Product requirements: [docs/PRD.md](docs/PRD.md)

## Licence

MIT. See [LICENSE](LICENSE).
