---
status: complete
quick_id: 261018-github-alpha-release
---

# Quick task 261018: GitHub alpha release Summary

PUBLISHED on 2026-10-19 (04:01:41Z) by explicit user instruction ("make it a release, make it 0.0.1-alpha, we will publish the first npm with 0.1.0"). The GitHub prerelease `v0.0.1-alpha` is live on the private repo `open-gsd/gsd-atlas`, with the tarball attached and honest "alpha, install it yourself" notes. No branch, `main` or npm publish was pushed; the only ref created is the tag `v0.0.1-alpha`.

## The release

- URL: https://github.com/open-gsd/gsd-atlas/releases/tag/v0.0.1-alpha
- Tag: `v0.0.1-alpha`, a lightweight tag (`git ls-remote --tags origin` shows a single `refs/tags/v0.0.1-alpha` line and no peeled `^{}` entry), pointing at `facb447464a4cb9b0207efab7e692321a9ab912d`. It is the only tag on the remote.
- Title: `gsd-atlas 0.0.1-alpha — alpha: install it yourself`
- State: `isDraft: false`, `isPrerelease: true`, not Latest (`gh release list` shows `isLatest: false`); `targetCommitish` `facb447464a4cb9b0207efab7e692321a9ab912d`, equal to `origin/main` (re-checked with `git ls-remote origin main` before publishing).
- Body: `release-notes.md` in this folder (the exact file passed with `--notes-file`).

## Version numbers (the design point)

The release and tag are `v0.0.1-alpha`. The tarball inside was not rebuilt: it is built from `package.json` `0.1.0-alpha.0`, so the installed CLI prints `gsd-atlas 0.1.0-alpha.0`. The notes explain this in a "Version numbers" section. The first npm publish is a different, later version (the user said 0.1.0); the notes promise no npm version, date or availability.

## The asset

`opengsd-gsd-atlas-0.1.0-alpha.0.tgz`, 830958 bytes, sha256 `2cde1571398a1417256cd7fcdb7fc5114e7dd642d925a060443fd705b8b2032d`. GitHub reports the same digest. The tarball is not committed; it lives on the release. Asset URL: https://github.com/open-gsd/gsd-atlas/releases/download/v0.0.1-alpha/opengsd-gsd-atlas-0.1.0-alpha.0.tgz

## Verification

- Before publishing: draft target and asset matched the instruction (commit `facb447`, one asset, same sha256); `origin/main` still `facb447`; `git ls-remote --tags origin` empty; `npm view @opengsd/gsd-atlas` returned E404 (so the notes keep "not on npm yet").
- Draft edited with `gh release edit v0.1.0-alpha.0 --tag v0.0.1-alpha --title ... --notes-file release-notes.md`, then published with `gh release edit v0.0.1-alpha --draft=false --prerelease --latest=false`.
- After publishing: `gh release view v0.0.1-alpha` shows `isDraft:false`, `isPrerelease:true`, one asset with the same digest; tag `refs/tags/v0.0.1-alpha` -> `facb447464a4cb9b0207efab7e692321a9ab912d`.
- `gh release download v0.0.1-alpha -p '*.tgz'` into a scratch directory: `shasum -a 256` = `2cde1571398a1417256cd7fcdb7fc5114e7dd642d925a060443fd705b8b2032d` (matches).
- `npm install -g --prefix <scratch> <that tgz>`: installed (npm 11 warned that `@parcel/watcher` has install scripts not covered by `allowScripts`; works without them); `gsd-atlas --version` printed `gsd-atlas 0.1.0-alpha.0`, as the notes say.
- Earlier checks on the tarball (kept from the draft stage): `node scripts/release-check.ts --channel alpha` ok; `gsd-atlas build` / `find` on a scratch repo ok; from-source build prints `gsd-atlas 0.1.0-alpha.0`; evaluation figures in the notes match `docs/eval/analysis.md` (`OVERALL: MVP not met`); linked docs exist at the target commit and links are pinned to the commit sha.

## Not verified

- Source install at the tag (`git checkout v0.0.1-alpha`) was not re-run after publishing; the tag points at the same commit that was built from source earlier.
- Windows is not covered (postponed).
- The repo is private, so the release and download need repo access.

## Deviations

The draft was originally prepared as `v0.1.0-alpha.0`; on the user's instruction it was re-tagged `v0.0.1-alpha` and published. No repo source, ROADMAP, STATE, REQUIREMENTS, frozen eval or skill files were touched.
