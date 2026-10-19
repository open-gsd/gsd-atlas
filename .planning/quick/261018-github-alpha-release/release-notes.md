## gsd-atlas 0.0.1-alpha: alpha, install it yourself

This is the first alpha of gsd-atlas, a local map of a codebase for coding agents. It indexes a TypeScript or JavaScript repository on your machine and answers "where is this defined, who uses it, what would break" with answers that cite a file and line.

It is a pre-MVP build, published so that people can try it, not because it is ready. You install it yourself, from the tarball attached to this release or from source. It is not on npm yet. Commands, tools and the index format can change between builds, and nothing is promised about compatibility, dates or a stable release.

This release was built from commit `facb447464a4cb9b0207efab7e692321a9ab912d`, tagged `v0.0.1-alpha`. The links below point at that commit.

### Version numbers

Two different numbers are in play, and they are not the same:

- The GitHub release and its git tag are `v0.0.1-alpha`.
- The tarball attached here was built from a `package.json` whose version is `0.1.0-alpha.0`, so the installed command prints `gsd-atlas 0.1.0-alpha.0`, not `0.0.1-alpha`. The file name, `opengsd-gsd-atlas-0.1.0-alpha.0.tgz`, carries the package version too.

The npm package, when it is published, carries its own version number and is not this release. Nothing here promises an npm version, a date or availability.

### Requirements

- Node 24.16.0 or newer, and `git` on the path.
- Linux or macOS. **Windows is not supported in the alpha.**
- Languages: TypeScript (`.ts`, `.cts`, `.mts`) and JavaScript (`.js`, `.cjs`, `.mjs`, `.jsx`). Other files, such as `.tsx`, are not indexed.

### Install

Pick one.

**1. The tarball attached to this release (works today).** Download `opengsd-gsd-atlas-0.1.0-alpha.0.tgz` from this release's assets, check it, and install it:

```sh
shasum -a 256 opengsd-gsd-atlas-0.1.0-alpha.0.tgz
npm install -g ./opengsd-gsd-atlas-0.1.0-alpha.0.tgz
gsd-atlas --version
```

The checksum should be `2cde1571398a1417256cd7fcdb7fc5114e7dd642d925a060443fd705b8b2032d` (830958 bytes; `sha256sum` on Linux). The last command should print `gsd-atlas 0.1.0-alpha.0`, the package version (see "Version numbers" above). With npm 11 you may see a warning that `@parcel/watcher` has install scripts not covered by `allowScripts`; the install and the checks described here worked without running them.

**2. From npm.** The package `@opengsd/gsd-atlas` is not published to npm yet, so `npm install` of it does not work today. When it is published, it carries its own version number, is not this release, and the tarball npm serves is built separately from the one attached here, so its bytes (and its checksum) will differ.

**3. From source.**

```sh
git clone https://github.com/open-gsd/gsd-atlas.git
cd gsd-atlas
git checkout v0.0.1-alpha
npm ci --ignore-scripts
npm run build
node dist/bin/gsd-atlas.js --version
```

The last command should print `gsd-atlas 0.1.0-alpha.0` (the package version, not the tag). The repository is private for now, so the clone needs access to it. With a source build, run `node dist/bin/gsd-atlas.js` where the guides below write `gsd-atlas`.

### Try it, register it, install the skill

- Index a small repository and ask it questions: [Index a repository and ask it questions](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/docs/tutorials/index-and-ask.md). The tutorial builds from source; with the tarball, run `gsd-atlas build` inside your repository instead.
- Register the MCP server with Claude Code, Cursor or Codex: [How to register the MCP server](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/docs/how-to/register-the-mcp-server.md).
- Install the agent skill: [How to install the skills](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/docs/how-to/install-the-skills.md). The skills are inside the tarball under `skills/`.

### What this alpha is not

- **It is pre-MVP.** The registered evaluation ended with `OVERALL: MVP not met`. The accuracy criterion was met (atlas arm 0.8000, grep arm 0.7511). The token criterion was not met (mean billable tokens per session: atlas arm 47375.1, grep arm 29393.1). The citation criterion was not met (non-abstain sessions with verifiable citations: atlas arm 72.7%, grep arm 73.7%, threshold 80.0%). Read [the analysis](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/docs/eval/analysis.md) for the rules and the other figures. This release makes no efficacy claim beyond them.
- **It is not finished.** There is no Windows support, no TypeScript 7.x resolver, no SDK facts, no Swift module, no dashboard and no hooks. The full list is in [the alpha limitations reference](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/docs/reference/alpha-limitations.md). Where that page speaks of the `alpha` channel of npm, note that the package is not published there yet.
- **It does not phone home.** Indexing a repository and answering a question open no network connection, and gsd-atlas sends no telemetry. Diagnostics are off by default, each data type is approved separately, and a report or a bug bundle is a file on your machine; nothing is submitted. See the privacy section of the same limitations page.
- **Its design decisions were ratified together.** The decision records are in [docs/adr](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/docs/adr/README.md), numbered and Accepted in one pass on 2026-10-18.

### Reporting a bug

Run `gsd-atlas bug`. It asks about each kind of data (all start denied), hashes names and paths by default, writes a bundle on your machine and uploads nothing. You read it and attach it to an issue yourself. See [How to report a bug](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/docs/how-to/report-a-bug.md).

The full change list is in [CHANGELOG.md](https://github.com/open-gsd/gsd-atlas/blob/facb447464a4cb9b0207efab7e692321a9ab912d/CHANGELOG.md).
