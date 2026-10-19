---
phase: quick-261018-npm-release-pipeline
plan: 01
subsystem: release
tags: [npm, github-actions, provenance, release-check, changelog, docs]
requires: []
provides:
  - "scripts/release-check.ts: channel/version, changelog, manifest, tarball allow-list, size and text-scan gate"
  - ".github/workflows/release.yml: workflow_dispatch release with dry_run (default true) and channels alpha | next | latest"
  - "ci.yml static job: release-check and npm publish --dry-run on every pull request"
  - "package version 0.1.0-alpha.0, npm metadata, CHANGELOG.md"
  - "docs: npm install path, release channels reference, maintainer how-to"
affects: [package.json, CHANGELOG.md, README.md, docs/reference, docs/how-to, .github/workflows, scripts]
key-files:
  created:
    - scripts/release-check.ts
    - scripts/release-check.test.ts
    - .github/workflows/release.yml
    - CHANGELOG.md
    - docs/reference/release-channels.md
    - docs/how-to/release-an-alpha.md
  modified:
    - package.json
    - package-lock.json
    - .github/workflows/ci.yml
    - scripts/ci-config.test.ts
    - scripts/package.test.ts
    - scripts/docs-reference.test.ts
    - README.md
    - docs/reference/alpha-limitations.md
    - docs/tutorials/index-and-ask.md
decisions:
  - "A third workflow input, auth (oidc | token, default oidc), exists because a trusted publisher can only be configured on a package that already exists, so the first publish needs a token; later releases use OIDC."
  - "The publish job publishes the tarball that the verify job packed and checked, not a rebuild."
  - "release.yml queues runs (cancel-in-progress false); every other workflow keeps cancel-in-progress true. ci-config.test.ts encodes both."
  - "The tarball keeps mode 644 for bins (npm marks them executable on install), so release-check checks the shebang, not the file mode."
  - "CHANGELOG.md is added to package.json files because npm does not include it on its own."
metrics:
  commits: 9
  plan_head_before: 52a0043
  plan_head_after: f3559258898ec4727ddc15888caeb32e69904230
  tests: "4715 run, 4713 pass, 0 fail, 2 skipped"
status: complete
actuals:
  tasks: 5
  commits: 9
---

# Quick task 261018: npm release pipeline for the alpha

Pipeline, version, changelog and docs for publishing `@opengsd/gsd-atlas@0.1.0-alpha.0` to the `alpha` channel of npm. Nothing was published, tagged, pushed or reconfigured; no token was touched.

## What was built (test first, RED then GREEN)

1. **`scripts/release-check.ts`** (+ 33 tests). Rules: version fits the channel (alpha `X.Y.Z-alpha.N`, next `-next.N` or `-rc.N`, latest no prerelease; dist-tag equals channel; any prerelease refused on latest; `0.0.0` refused); dated non-empty CHANGELOG entry for the exact version; manifest (name, MIT, engines, repository/bugs/homepage for open-gsd/gsd-atlas, publishConfig, bins, description, keywords); tarball allow-list from `npm pack --dry-run --json`; no source maps, `.ts` or test output under `dist`; both grammar `.wasm` present and non-empty; bins packed with a node shebang; 5 MiB packed and 25 MiB unpacked caps; text scan for home paths and secret shapes. Modes: `--channel <alpha|next|latest|auto>`, `--skip-pack`, `--pack-json`, `--root`, `--print-tag`, `--tool-versions` (npm >= 11.5.1, Node >= 22.14.0). Exit 1 per failure set, 2 for usage.
2. **`.github/workflows/release.yml`**: `workflow_dispatch` only; inputs `channel` (default alpha), `dry_run` (default true), `auth` (default oidc); `verify` job (guard, npm ci --ignore-scripts, toolchain check, typecheck, lint, build, schema:check, npm test, verify-prereg, release-check, npm pack, artifact upload) then `publish` job (guard, download the same tarball, `npm publish --provenance --access public --tag <channel>`, `--dry-run` when dry_run). `id-token: write` only on `publish`; environment `npm-publish`; real release refused unless ref is `main` and the GitHub API says the repo is not private; Node 24.16.0; pinned SHAs; no `continue-on-error`. actionlint reports nothing for it. **`ci.yml`** static job now builds, runs `release-check --channel auto` and `npm publish --dry-run --ignore-scripts --tag <channel>` on every pull request. 14 new invariants in `scripts/ci-config.test.ts`.
3. **Version and metadata**: `0.1.0-alpha.0`, repository, bugs, homepage, keywords, `CHANGELOG.md` in `files`; honest changelog (pre-MVP; registered verdict "MVP not met" with the three criteria results; macOS and Linux only; known limits). The CLI prints `gsd-atlas 0.1.0-alpha.0` because it reads `package.json`. Test-injected `0.0.0` strings are unrelated and unchanged.
4. **Docs** (skill `writing-docs-with-diataxis` invoked first): README and `alpha-limitations.md` state `npm install -g @opengsd/gsd-atlas@alpha` with no stable-release date and keep the Windows sentence and the evaluation status; new reference `docs/reference/release-channels.md` and how-to `docs/how-to/release-an-alpha.md`. `docs-reference.test.ts` now pins the exact allowed install statements per page and rejects any other `npm install` command or release promise.

## Evidence

- Local `npm publish --dry-run --tag alpha --ignore-scripts`: `+ @opengsd/gsd-atlas@0.1.0-alpha.0`, **486 files, package size 830.9 kB, unpacked 4.1 MB**, both `grammar.wasm`, LICENSE, README, CHANGELOG. Without `--tag`, npm refuses: "You must specify a tag using --tag when publishing a prerelease version."
- `node scripts/release-check.ts --channel alpha`: `ok (channel alpha, version 0.1.0-alpha.0, tag alpha)`; `--channel latest` fails with the prerelease message.
- Install check from the packed tarball (`npm install -g --prefix <scratch> --ignore-scripts <tgz>`, scratch user/state dirs; HOME was not redirected because the sandbox refuses it): `gsd-atlas --version` prints `gsd-atlas 0.1.0-alpha.0`; `gsd-atlas lang list` lists the `javascript` and `typescript` built-in modules. Registry check: `npm view @opengsd/gsd-atlas` returns 404 (not yet published).
- Gates: typecheck, lint, build, `schema:check` clean; `verify-prereg: ok`; `npm test` 4715 tests, 4713 pass, 0 fail, 2 skipped (no timing failure). One earlier full run failed once on `scripts/package.test.ts` "built dist/bin/gsd-atlas.js starts with a shebang and prints the same version..." (the version regex did not allow a prerelease); fixed in f355925.
- Stage A/B, `docs/eval/**`, `skills/gsd-atlas/SKILL.md`, ADR files, ROADMAP, STATE and REQUIREMENTS are untouched. SCHEMA_VERSION 2 and MODULES.length 23 are unchanged (no `src/` change).

## Manual checklist for the user (in this order)

1. Merge this branch to `main` (GitHub offers the Run workflow button only for a workflow on the default branch).
2. Make `open-gsd/gsd-atlas` public (Settings, General, Danger Zone, Change visibility). This also exposes the Actions history and logs.
3. Confirm you can publish under the `@opengsd` npm scope (account plus organisation or user named `opengsd`).
4. Create the GitHub environment `npm-publish` (Settings, Environments), add required reviewers (leave Prevent self-review off if you are the only maintainer), optionally limit it to `main`.
5. On npmjs.com create a granular token: Read and write (publish and stage), scope `@opengsd`, Bypass two-factor authentication, short expiry. Store it as the environment secret `NPM_TOKEN` in `npm-publish`.
6. Actions, Release, Run workflow: branch `main`, channel `alpha`, `dry_run` ticked, `auth` token. Read the logs.
7. Run it again with `dry_run` unticked. Approve in the environment.
8. Verify: npm page shows Provenance; `npm view @opengsd/gsd-atlas dist-tags` shows `alpha: 0.1.0-alpha.0` (and see open item 3); `npm install -g @opengsd/gsd-atlas@alpha && gsd-atlas --version`; in a project, `npm install @opengsd/gsd-atlas@alpha && npm audit signatures`.
9. Then, within 2 days, add the trusted publisher on the package (org `open-gsd`, repo `gsd-atlas`, workflow `release.yml`, environment `npm-publish`, allow `npm publish`), run a dry run and a real release with `auth` oidc, then disallow tokens and revoke the token.
10. Optionally tag `v0.1.0-alpha.0` and create a GitHub release by hand; the workflow does neither.

## Open items (not verified)

1. **Trusted publishing for a package that does not exist.** The npm docs say `npm trust` needs an existing package and place the setting on the package page, and the registry returns 404 for this package, so the pipeline assumes the first publish uses a token. The npm website flow for a never-published package was not tested; if it allows pre-registration, `auth` oidc can be used from the start.
2. **GitHub-side behaviour was not executed.** release.yml was checked by actionlint, by 14 static invariants and by running its commands locally, but it has not run on GitHub. In particular `npm publish --dry-run --provenance` of a tarball inside Actions, the `gh api repos/... --jq .private` guard, and environment approvals are untested. Run the dry run first.
3. **`latest` tag after a first prerelease publish.** Not verified whether the registry also sets `latest` when the first version of a new package is published with `--tag alpha`. Check `npm view @opengsd/gsd-atlas dist-tags` after the first publish.
4. **npm organisation `@opengsd`.** Existence and your publish rights were not checkable without logging in.
5. **GitHub plan.** Environments with required reviewers work on a Free plan only for public repositories (GitHub docs); the plan of `open-gsd` was not checked.
6. **The README and limitations page now state an install command that works only after the first publish.** Merge them with, or after, the publish.
7. **Dry runs also go through the `npm-publish` environment**, so reviewers are asked to approve them too; drop the environment's reviewers or approve twice if that is unwanted.
8. **Windows** is not supported in the alpha; release.yml runs on Ubuntu only and ci.yml is unchanged for Windows legs.

## Deviations from Plan

- [Rule 1 - Bug] The bin-mode rule first written (executable bit in the tarball) failed on the real tarball (mode 644; npm sets the bit on install). Replaced by a shebang check, with a test.
- [Rule 1 - Bug] `modules/*/fixtures/*.ts` ship on purpose; the "no TypeScript source" rule applies to `dist/` only. A placeholder home path in a `dist` comment (`C:/Users/x`) is not counted.
- [Rule 3 - Blocking] `scripts/package.test.ts` pinned a plain `X.Y.Z` version output and a four-file allow-list; both were widened deliberately (prerelease part, CHANGELOG.md).
- [Rule 2] The shared "concurrency cancels" test was split so release.yml must queue (cancel-in-progress false).
- The sandbox refused redirecting HOME or XDG_CONFIG_HOME, so the scratch install check used `GSD_ATLAS_USER_DIR` and `GSD_ATLAS_STATE_DIR` only.

## Known Stubs

None.

## Self-Check: PASSED
