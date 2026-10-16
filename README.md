# gsd-atlas

gsd-atlas keeps a live, local map of a codebase and the platform SDKs it targets, and serves it to coding agents over MCP, a CLI and an Agent Skill. It is built to give agents correct, cited, current answers about the code and the platform they build against, instead of guesses from stale training data.

This repository is at the foundations stage. What exists today is the package scaffold, the frozen module seams with test doubles, and one working command, `gsd-atlas lang test`, which checks a language module (manifest, committed WASM grammar, queries and golden files) end to end. Indexing, queries and the MCP server come in later phases.

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

## Documentation

- Architecture decisions: [docs/adr/README.md](docs/adr/README.md)
- Product requirements: [docs/PRD.md](docs/PRD.md)

## Licence

MIT. See [LICENSE](LICENSE).
