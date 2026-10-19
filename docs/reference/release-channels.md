# Release channels and release workflow reference

How `@opengsd/gsd-atlas` versions map to npm channels, what the release workflow and the `release-check` script do, and which npm rules they rely on. The page states facts and gives no instructions; the steps for a maintainer are in [how to release an alpha](../how-to/release-an-alpha.md).

## Channels

A channel is a version shape and an npm dist-tag with the same name. A channel holds a release only after one has been published to it.

| Channel | Version shape | npm dist-tag | Install command |
| --- | --- | --- | --- |
| `alpha` | `X.Y.Z-alpha.N` | `alpha` | `npm install -g @opengsd/gsd-atlas@alpha` |
| `next` | `X.Y.Z-next.N` or `X.Y.Z-rc.N` | `next` | `npm install -g @opengsd/gsd-atlas@next` |
| `latest` | `X.Y.Z`, no prerelease part | `latest` | `npm install -g @opengsd/gsd-atlas` |

- `N` is a whole number without leading zeros. `X`, `Y` and `Z` are whole numbers without leading zeros. Build metadata (`+build`) is refused.
- `0.0.0` is the unreleased placeholder and is refused on every channel.
- A prerelease version is refused on `latest`, so a prerelease can never become the default install.
- `npm publish` itself refuses a prerelease version when no `--tag` is given ("You must specify a tag using --tag when publishing a prerelease version"), so a missing tag cannot put a prerelease on `latest`.
- A version number, once published, can never be used again, even after an unpublish.

The first alpha is `0.1.0-alpha.0`. The alpha promises no date for a stable release.

## The release workflow

The file is `.github/workflows/release.yml`. It runs on `workflow_dispatch` only, so it never starts on a push, a pull request, a schedule or a tag. GitHub offers the Run workflow button only for a workflow file that is on the default branch.

### Inputs

| Input | Values | Default | Meaning |
| --- | --- | --- | --- |
| `channel` | `alpha`, `next`, `latest` | `alpha` | The release channel. It is also the npm dist-tag, passed as `--tag`. |
| `dry_run` | `true`, `false` | `true` | When true, every step runs and `npm publish` gets `--dry-run`, so nothing is published. |
| `auth` | `oidc`, `token` | `oidc` | `oidc` publishes with npm trusted publishing and uses no stored secret. `token` publishes with the secret `NPM_TOKEN`. |

### Jobs

| Job | Runs | Permissions |
| --- | --- | --- |
| `verify` | The guard (real releases only), checkout, Node 24.16.0, `npm ci --ignore-scripts`, the toolchain check, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run schema:check`, `npm test`, `node scripts/eval/verify-prereg.ts`, `release-check` on the chosen channel, `npm pack`, and the upload of the tarball as the artifact `package-tarball`. | `contents: read` |
| `publish` | After `verify`, in the GitHub environment `npm-publish`: the guard again, checkout, Node 24.16.0 with the registry `https://registry.npmjs.org`, the toolchain check, the download of `package-tarball`, then one of two publish steps. | `contents: read` and the OIDC `id-token` write permission, on this job only |

- The tarball that `publish` sends is the tarball that `verify` packed and checked; it is not rebuilt.
- Both publish steps run `npm publish <tarball> --provenance --access public --tag <channel>`, and add `--dry-run` when `dry_run` is true. The step with `auth` set to `oidc` has no token in its environment. The step with `auth` set to `token` sets `NODE_AUTH_TOKEN` from the secret `NPM_TOKEN`; it is the only place that secret is used.
- Workflow inputs reach shell code through environment variables, never by interpolation into a `run` block.
- No step is optional: the workflow has no `continue-on-error` and no `|| true`.
- Every action is pinned to a commit SHA with a version comment. Dependencies are installed with `npm ci --ignore-scripts`, and no package cache is used in a release build.
- Runs queue instead of cancelling (`concurrency` group `release`, `cancel-in-progress: false`).

### The guard

When `dry_run` is false, the first step of both jobs fails the run unless the ref is `refs/heads/main` and the GitHub API reports the repository as not private (`gh api repos/<owner>/<repo> --jq .private` returns `false`). If the API call fails, the step fails. A dry run skips the guard and can run from any branch.

### What the workflow does not do

It does not create a git tag, a GitHub release, a commit or a push, and it does not change repository settings. It does not run `npm dist-tag`.

## The release-check script

`scripts/release-check.ts` runs the version, changelog, manifest and tarball rules. It opens no network connection and reads no token.

| Command | Meaning |
| --- | --- |
| `node scripts/release-check.ts --channel <alpha\|next\|latest>` | All rules, including `npm pack --dry-run --json --ignore-scripts` (the package must be built first). |
| `node scripts/release-check.ts --channel auto` | The same, on the channel that the `package.json` version names. A version that names none fails. |
| `... --skip-pack` | Version, changelog and manifest only, with no build needed. |
| `... --pack-json <file>` | Judge a saved `npm pack --json` output instead of running `npm pack`. |
| `... --root <dir>` | Judge another directory. |
| `... --print-tag` | Print only the dist-tag of the channel, and judge nothing. |
| `node scripts/release-check.ts --tool-versions` | Fail unless Node is 22.14.0 or newer and npm is 11.5.1 or newer. |

Exit 0 when every rule holds, 1 when a rule fails (one line per failure on stderr), 2 for a usage error.

### Rules

| Area | Rule |
| --- | --- |
| Version | Fits the channel (see [Channels](#channels)). |
| Changelog | `CHANGELOG.md` has a non-empty entry headed `## [<version>] - YYYY-MM-DD` for the exact version. |
| Manifest | Name `@opengsd/gsd-atlas`; licence `MIT` and a `LICENSE` file with the MIT text; `engines.node` `>=24.16.0`; `repository` type `git` and URL `git+https://github.com/open-gsd/gsd-atlas.git`; `bugs.url` `https://github.com/open-gsd/gsd-atlas/issues`; `homepage` `https://github.com/open-gsd/gsd-atlas#readme`; `publishConfig` access `public` and provenance `true`; a non-empty `description` and `keywords`; not `private`; bins `gsd-atlas` and `gsd-atlas-mcp` at `dist/bin/gsd-atlas.js` and `dist/bin/gsd-atlas-mcp.js`. |
| Tarball allow-list | Only `dist`, `schemas`, `modules`, `skills` and `diagnostics` below the top level, plus `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md`. `.planning`, `.github`, `scripts`, `src`, `test`, `docs` and `node_modules` never ship. |
| Tarball content | No source map, no TypeScript source and no test output under `dist`. The files `modules/typescript/grammar.wasm` and `modules/javascript/grammar.wasm` are present and not empty. Each bin target is in the tarball and starts with `#!/usr/bin/env node`. |
| Size | Packed size at most 5 MiB (5,242,880 bytes); unpacked size at most 25 MiB. |
| Text scan | No packed text file holds an absolute home path (`/Users/<name>`, `/home/<name>/`, a drive-letter `Users` path) or a secret-looking string (GitHub, npm, AWS, Anthropic and Slack token shapes, a private key header, a bearer token, an npmrc auth token). A message names the file and the kind, never the match. Placeholder user names such as `x` and `user` are not counted. |

The bin files have mode 644 in the tarball; npm marks them executable when it installs the package, which is why the rule checks the shebang line and not the file mode.

## The pull request rehearsal

The `static` job of `.github/workflows/ci.yml` runs on every pull request. After `npm run build` it runs `node scripts/release-check.ts --channel auto` and `npm publish --dry-run --ignore-scripts --tag <channel>`, so the release pipeline is exercised without publishing. `ci.yml` has no `id-token` permission and no secret.

## npm rules the pipeline relies on

Retrieved from the npm documentation on 2026-10-18.

- **Trusted publishing** needs npm 11.5.1 or newer and Node 22.14.0 or newer, GitHub-hosted runners (self-hosted runners are not supported), and the OIDC `id-token` write permission in the workflow. Node 24.16.0 bundles npm 11.13.0.
- **Trusted publisher fields** on npmjs.com are the organisation or user, the repository, the workflow file name with its `.yml` extension (file name only, in `.github/workflows/`), an optional environment name, and the allowed actions. Direct `npm publish` must be allowed among the actions for this pipeline. npm does not check the configuration when it is saved; a mismatch appears only at publish time. Every field is case-sensitive.
- **First publish of a configuration.** A new trusted publisher configuration must complete its first successful publish within 2 days, or it expires and cannot be used or edited. An existing configuration cannot be changed, only deleted and created again. A package can have up to 10.
- **A package must exist** before it can be configured: `npm trust` states "The package you're configuring must already exist on the npm registry", and the settings are on the package's page. A package that has never been published therefore cannot yet use trusted publishing; `auth` set to `token` is the route for the first publish.
- **Provenance** is generated automatically for a trusted-publishing publish from GitHub Actions of a public repository, and with `--provenance` for a token publish from GitHub Actions. It is not generated for a private repository, even for a public package. The `repository.url` in `package.json` must match the GitHub repository exactly (case-sensitive).
- **Granular access tokens** are created on the npm website. A token for CI publishing needs the permission Read and write (publish and stage) on the package or scope, and the Bypass two-factor authentication option, since CI cannot answer a one-time password.
- **Dist-tags.** `npm publish --tag <tag>` sets the tag. Managing tags with `npm dist-tag` from a trusted-publishing workflow is a separate permission and needs npm 11.21.0 or newer; this pipeline does not use it.
- **Unpublish policy.** A newly created package with no dependents can be unpublished within 72 hours of publishing. After that, a version can be unpublished only if no other package depends on it, it had fewer than 300 downloads in the last week, and it has a single owner. Unpublishing all versions blocks new versions of that package for 24 hours. Otherwise the package can be deprecated with `npm deprecate`.

Sources: <https://docs.npmjs.com/trusted-publishers>, <https://docs.npmjs.com/generating-provenance-statements>, <https://docs.npmjs.com/cli/v11/commands/npm-publish>, <https://docs.npmjs.com/cli/v11/commands/npm-trust>, <https://docs.npmjs.com/creating-and-viewing-access-tokens>, <https://docs.npmjs.com/policies/unpublish>, and, for the npm version that ships with Node, <https://nodejs.org/dist/index.json>.
