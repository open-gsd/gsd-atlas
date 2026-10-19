# How to release an alpha to npm

For a maintainer who publishes `@opengsd/gsd-atlas` to the `alpha` channel of npm with the release workflow. The channels, the workflow inputs and the checks are in [the release channels reference](../reference/release-channels.md).

The workflow publishes from GitHub Actions only, with npm provenance. It never creates a git tag or a GitHub release, and it publishes nothing while `dry_run` is ticked.

## Before the first release

Do these once.

1. Merge the release workflow to `main`. GitHub shows the Run workflow button only for a workflow file that is on the default branch.
2. Make the repository public: Settings, then General, then the Danger Zone, then Change visibility. Provenance is not generated for a private repository, and the release workflow refuses a real release from one. Making it public also makes the Actions history and logs of the repository visible to everyone.
3. Create the environment: Settings, then Environments, then New environment, named `npm-publish`. Add Required reviewers (up to 6; one approval is enough). Leave Prevent self-review off when you are the only maintainer. Optionally restrict the environment to the `main` branch. A repository on a GitHub Free plan can configure environments only while it is public.
4. Make sure you can publish under the `@opengsd` scope on npm: you need an npm account, and `@opengsd` must be an organisation or user that you can publish for.
5. Create an npm granular access token for the first publish, because a package that has never been published cannot yet have a trusted publisher:
   1. On npmjs.com, open your profile picture, then Access Tokens, then Generate New Token.
   2. Set the permission Read and write (publish and stage), select the `@opengsd` scope under Packages and scopes, check Bypass two-factor authentication, and choose a short expiration.
   3. In the repository, open Settings, then Environments, then `npm-publish`, and add an environment secret named `NPM_TOKEN` with the token.

## Run a dry run

1. Open the Actions tab, choose Release in the left sidebar, and click Run workflow.
2. Choose the branch `main`, set `channel` to `alpha`, leave `dry_run` ticked, and set `auth` to `token`.
3. Approve the run in the `npm-publish` environment when GitHub asks.
4. Read the log. In the `verify` job, `release-check` prints `release-check: ok (channel alpha, version 0.1.0-alpha.0, tag alpha)`. In the `publish` job, the publish step prints the file list of the tarball and names `@opengsd/gsd-atlas@0.1.0-alpha.0`; nothing is sent to the registry.
5. If a step fails, fix the cause on a branch, merge it to `main` and start again. The message of a failed `release-check` names each broken rule.

## Publish

1. Run Release again from `main` with `channel` set to `alpha`, `dry_run` unticked and `auth` set to `token`.
2. Approve the run in the `npm-publish` environment.
3. Check the result:
   1. Open `https://www.npmjs.com/package/@opengsd/gsd-atlas`. The page shows the version and a Provenance section that links to the workflow run.
   2. Run `npm view @opengsd/gsd-atlas dist-tags` and confirm that `alpha` is `0.1.0-alpha.0`.
   3. Run `npm install -g @opengsd/gsd-atlas@alpha`, then `gsd-atlas --version`, which prints the version `0.1.0-alpha.0`.
   4. In a project directory, run `npm install @opengsd/gsd-atlas@alpha` and then `npm audit signatures`, which verifies the registry signature and the provenance attestation of the installed package.
4. Optionally tag the commit by hand, for example `v0.1.0-alpha.0`, and create a GitHub release from the `CHANGELOG.md` entry. The workflow does neither.

## Switch later releases to trusted publishing

After the package exists, later releases need no stored token.

1. On npmjs.com, open the package, then Settings, then Trusted Publisher, and choose GitHub Actions.
2. Enter the organisation `open-gsd`, the repository `gsd-atlas`, the workflow file name `release.yml` and the environment name `npm-publish`, and allow `npm publish` among the allowed actions.
3. Run Release within 2 days of saving the configuration, with `auth` set to `oidc`, first as a dry run and then as a real release. A configuration whose first successful publish does not happen within 2 days expires and must be created again.
4. When the OIDC release has worked, open the package, then Settings, then Publishing access, choose Require two-factor authentication and disallow tokens, delete the `NPM_TOKEN` environment secret and revoke the token on npmjs.com.

## Release a later version

1. Set `version` in `package.json` to the next number of the channel: `0.1.0-alpha.1` for the next alpha, `0.2.0-next.0` or `0.2.0-rc.0` for `next`, `1.0.0` for `latest`.
2. Add a dated `## [<version>] - YYYY-MM-DD` entry to `CHANGELOG.md`, with the version number exactly as in `package.json`.
3. Merge to `main`, then run Release with the matching `channel`, first as a dry run and then as a real release.

## Undo a mistake

1. Within 72 hours of publishing a new package that nothing depends on, `npm unpublish @opengsd/gsd-atlas@0.1.0-alpha.0` removes the version. The version number cannot be used again.
2. After that, deprecate the version instead: `npm deprecate @opengsd/gsd-atlas@0.1.0-alpha.0 "<message for installers>"`. The version stays installable and shows the message.
3. Publish a corrected version with the next number.
