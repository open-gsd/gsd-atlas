# gsd-atlas

gsd-atlas builds a local index of a code repository and answers cited, fresh, worktree-correct questions about it for coding agents: where a symbol is defined, who refers to it, what surrounds it and what depends on it. It answers through the `gsd-atlas` command and a stdio MCP server.

## Status

This is an alpha. It indexes TypeScript and JavaScript repositories on macOS and Linux (Windows is not supported in the alpha), and asks the TypeScript compiler for exact references. It requires Node 24.16.0 or newer (24.15.0 truncates TEXT at an embedded NUL in `node:sqlite`), and CI runs Node 24.16.0 and 26 on Linux and macOS. Indexing and answering questions use no network, and gsd-atlas sends no telemetry.

The decision records under [docs/adr](docs/adr/README.md) are ratified, numbered and Accepted; a record changes only by a dated amendment or by a new record that supersedes it. [The alpha limitations](docs/reference/alpha-limitations.md) say what is and is not done yet and hold the [evaluation status](docs/reference/alpha-limitations.md#evaluation-status).

To install the alpha from npm, run `npm install -g @opengsd/gsd-atlas@alpha`, then `gsd-atlas --version`. No date for a stable release is promised. [The release channels reference](docs/reference/release-channels.md) lists the channels. To build from a clone instead, use `npm ci --ignore-scripts` and `npm run build`; the tutorial below walks through it.

## Where to go

- Learn: [Index a repository and ask it questions](docs/tutorials/index-and-ask.md).
- Do:
  - [Register the MCP server with Claude Code, Cursor and Codex](docs/how-to/register-the-mcp-server.md)
  - [Install the gsd-atlas skills](docs/how-to/install-the-skills.md)
  - [Answer a question about an older commit](docs/how-to/answer-a-question-about-an-older-commit.md)
  - [See why atlas gave an answer](docs/how-to/see-why-atlas-gave-an-answer.md)
  - [Find the code that cites an ADR](docs/how-to/find-the-code-that-cites-an-adr.md)
  - [Approve a precise command for one repository](docs/how-to/approve-a-precise-command.md)
  - [Keep the store healthy](docs/how-to/keep-the-store-healthy.md)
  - [Run the measured gates locally](docs/how-to/run-the-measured-gates-locally.md)
  - [Contribute a change](docs/how-to/contribute-a-change.md)
  - [Release an alpha to npm](docs/how-to/release-an-alpha.md) (for maintainers)
- Look up: [the command-line reference](docs/reference/cli.md), [the MCP reference](docs/reference/mcp.md), [TypeScript support](docs/reference/typescript-support.md), [ADR citations](docs/reference/adr-citations.md), [the release channels](docs/reference/release-channels.md) and [the alpha limitations](docs/reference/alpha-limitations.md).
- Understand: [freshness and the writer lease](docs/explanation/how-freshness-and-the-writer-lease-work.md), [the precise TypeScript tier](docs/explanation/how-the-precise-tier-works.md) and [what atlas trusts and never sends](docs/explanation/how-atlas-decides-what-to-trust.md).
- Give feedback: [rate an answer](docs/how-to/rate-an-answer.md), [report a bug](docs/how-to/report-a-bug.md) and [turn diagnostics on and off](docs/how-to/turn-diagnostics-on-and-off.md). All three stay on your machine.

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

- Decision records (ratified, numbered and Accepted): [docs/adr/README.md](docs/adr/README.md)
- Product requirements: [docs/PRD.md](docs/PRD.md)

## Licence

MIT. See [LICENSE](LICENSE).
