# Changelog

All notable changes to `@opengsd/gsd-atlas` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are published on three npm channels: `alpha` (`X.Y.Z-alpha.N`), `next` (`X.Y.Z-next.N` or `X.Y.Z-rc.N`) and `latest` (`X.Y.Z`, no prerelease).

## [Unreleased]

## [0.1.0-alpha.0] - 2026-10-18

The first alpha. It is a pre-MVP build: the registered evaluation (below) did not meet the MVP gate. Install it with `npm install -g @opengsd/gsd-atlas@alpha`.

### Added

- The `gsd-atlas` command: `find`, `refs`, `context`, `impact`, `explain`, `history`, `health`, `build`, `maintain`, `status`, `rate`, `init`, `allow`, `diagnostics`, `bug`, `lang list` and `lang test`. Every answer is one JSON envelope.
- The `gsd-atlas-mcp` stdio MCP server with seven read-only tools: `code_find`, `code_refs`, `code_context`, `code_impact`, `code_explain`, `atlas_status` and `lang_list`.
- A local index of a repository, kept fresh as files change, with answers that cite file and line.
- Built-in language modules for TypeScript (`.ts`, `.cts`, `.mts`) and JavaScript (`.js`, `.cjs`, `.mjs`, `.jsx`), parsed with grammars built from pinned upstream sources and shipped as WebAssembly.
- A precise tier that asks the TypeScript compiler for exact references, using the project's own TypeScript when it is a 6.x release and the 6.0.3 copy that ships with the package otherwise.
- A routing skill (`skills/gsd-atlas`) and a diagnostics catalog. Diagnostics are off by default, each data type is approved separately, and a report or bug bundle is a file on the local machine.

### Privacy

- Indexing and answering questions open no network connection, and no telemetry is sent.

### Evaluation status

The registered evaluation (75 questions, 450 sessions, atlas arm against grep arm) is complete and its registered verdict is `MVP not met`:

- Accuracy: met. The atlas arm scored 0.8000 and the grep arm 0.7511.
- Tokens: not met. The atlas arm used 47375.1 billable tokens per session on average and the grep arm 29393.1; the registered rule needed the atlas arm to use fewer.
- Citations: not met. 72.7% of the atlas arm's non-abstain sessions carried only verifiable citations, below the 80.0% threshold.

This release makes no claim of fewer tokens, lower cost or better answers than searching with grep.

### Known limits

- Windows is not supported in the alpha. gsd-atlas is built and tested on macOS and Linux, on Node 24.16.0 or newer.
- Commands, MCP tools and the stored index format can change between builds. No compatibility between builds and no release date for a stable version are promised.
- A `.tsx` file is not indexed, and no Swift module exists.
- A project with TypeScript 7.x is answered by the shipped 6.0.3 compiler and the answer is marked `degraded`.
- No SDK facts, no dashboard, no hooks that require an agent to use the tools, and no submission or automatic intake of diagnostics exist.
- The decision records under `docs/adr` are drafts for this alpha; none is ratified.
