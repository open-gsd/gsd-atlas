# Quick task 261018: GitHub alpha release (draft prerelease)

Request: "create a 'install it yourself this is alpha' release on the repo".

Authorised scope: build the tarball from the target commit and create a DRAFT prerelease with the tarball asset via `gh release create`. Not authorised: publishing the draft, pushing any tag or branch, pushing main, `npm publish`, changing visibility, settings or secrets.

## Tasks

1. Verify HEAD equals origin/main, version 0.1.0-alpha.0, CHANGELOG entry; `npm ci --ignore-scripts && npm run build`; `node scripts/release-check.ts --channel alpha`; `npm pack`; record sha256 and size.
2. Run the install instructions to be published: tarball into a scratch prefix, `gsd-atlas --version`, `build` and `find` on a scratch git repo with GSD_ATLAS_USER_DIR and GSD_ATLAS_STATE_DIR redirected; clone and build from source; check the linked docs exist.
3. Write release-notes.md (honest alpha framing, requirements, three install options, sha256, what the alpha is not, bug reporting).
4. `gh release create v0.1.0-alpha.0 <tgz> --repo open-gsd/gsd-atlas --draft --prerelease --latest=false --target <sha> --title ... --notes-file release-notes.md`; verify draft, prerelease, asset, and that no remote tag appeared.
5. Write SUMMARY.md and commit the quick-task docs on the worktree branch only.
