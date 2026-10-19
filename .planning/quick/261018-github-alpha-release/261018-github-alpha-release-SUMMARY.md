---
status: complete
quick_id: 261018-github-alpha-release
---

# Quick task 261018: GitHub alpha release (draft prerelease) Summary

A DRAFT prerelease for `v0.1.0-alpha.0` exists on the private repo `open-gsd/gsd-atlas`, with the tarball attached and honest "alpha, install it yourself" notes. It is not published. No tag, branch, `main` or npm publish was pushed.

## The release

- URL (draft, visible to repo admins only): https://github.com/open-gsd/gsd-atlas/releases/tag/untagged-603e994e7690f6c5e5da
- Title: `gsd-atlas 0.1.0-alpha.0 — alpha: install it yourself`
- State: `isDraft: true`, `isPrerelease: true`, `--latest=false`
- `targetCommitish`: `facb447464a4cb9b0207efab7e692321a9ab912d` (equal to origin/main at the time)
- `git ls-remote --tags origin`: empty before and after (a draft creates no tag)
- Body: `release-notes.md` in this folder (the exact file passed with `--notes-file`)

## The asset

`opengsd-gsd-atlas-0.1.0-alpha.0.tgz`, 830958 bytes (npm: 831.0 kB packed, 4.1 MB unpacked, 486 files)

sha256 `2cde1571398a1417256cd7fcdb7fc5114e7dd642d925a060443fd705b8b2032d`

GitHub reports the same digest for the uploaded asset. The tarball itself is not committed; it lives on the release. It was built with `npm ci --ignore-scripts && npm run build && npm pack --ignore-scripts` in the worktree at the target commit.

## Verification

- HEAD == origin/main == `facb447464a4cb9b0207efab7e692321a9ab912d` after `git fetch origin`; `package.json` version `0.1.0-alpha.0`; `CHANGELOG.md` has `## [0.1.0-alpha.0] - 2026-10-18`.
- `node scripts/release-check.ts --channel alpha`: `release-check: ok (channel alpha, version 0.1.0-alpha.0, tag alpha)`, exit 0.
- `gh auth status`: logged in (account `trek-e`); `gh repo view`: `open-gsd/gsd-atlas`, private.
- Tarball install (`npm install -g --prefix <scratch> ./opengsd-gsd-atlas-0.1.0-alpha.0.tgz`): bins `gsd-atlas` and `gsd-atlas-mcp` installed; `gsd-atlas --version` printed `gsd-atlas 0.1.0-alpha.0`. npm 11 warned that `@parcel/watcher` has install scripts not covered by `allowScripts`; everything below worked without running them.
- On a scratch git repo with `GSD_ATLAS_USER_DIR` and `GSD_ATLAS_STATE_DIR` redirected: `gsd-atlas build` returned `ok:true, files:2, parsed:2, failed:0`; `gsd-atlas find parseConfig` returned `ok:true`, `src/config.ts` line 6, `EXTRACTED`, matching the tutorial. `gsd-atlas init --dry-run` from the installed package returned `ok:true` with `dryRun:true` (it wrote nothing). The skills `gsd-atlas` and `gsd-atlas-module-author` are present in the installed package under `skills/`.
- From source: `git clone` of the worktree (HEAD `facb447`), `npm ci --ignore-scripts && npm run build`, `node dist/bin/gsd-atlas.js --version` printed `gsd-atlas 0.1.0-alpha.0`.
- Linked docs exist at the target commit: `docs/tutorials/index-and-ask.md`, `docs/how-to/register-the-mcp-server.md`, `docs/how-to/install-the-skills.md`, `docs/how-to/report-a-bug.md`, `docs/reference/alpha-limitations.md`, `docs/eval/analysis.md`, `docs/adr/README.md`. Release-note links are pinned to the commit sha.
- Evaluation figures in the notes match `docs/eval/analysis.md` (accuracy 0.8000 vs 0.7511; tokens 47375.1 vs 29393.1; citations 72.7% vs 73.7%, threshold 80.0%; `OVERALL: MVP not met`).
- `npm view @opengsd/gsd-atlas` returned E404, so the notes say honestly that the package is not published yet.

## Not verified

- Downloading the asset with `gh release download` or a browser from the draft was not tested; the notes tell readers to download it from the release's assets.
- The notes' from-source option pins `git checkout facb447...`; the repo is private, so cloning needs access.
- Windows is not covered (postponed).

## To publish it later (the user's decision)

The draft has no tag. Publishing creates the tag `v0.1.0-alpha.0` at the draft's target commit.

```sh
gh release edit v0.1.0-alpha.0 --repo open-gsd/gsd-atlas --draft=false
```

or press "Publish release" on the release page. Caution: do this at the same commit as the npm publish. The release is pinned to `facb447464a4cb9b0207efab7e692321a9ab912d`; if `main` has moved and the npm package is published from a later commit, re-target the release first (for example `gh release edit v0.1.0-alpha.0 --repo open-gsd/gsd-atlas --target <sha>`) and rebuild and re-upload the tarball, then update the sha256 and the pinned doc links and commit hash in the notes. The notes also say the npm tarball is built separately and differs in bytes. Publishing the draft makes the notes public if the repo is public; the repo is private until the user changes that, and the notes say nothing implying public availability.

## Deviations

None. The plan ran as written; no repo source, ROADMAP, STATE, REQUIREMENTS, frozen eval or skill files were touched.
