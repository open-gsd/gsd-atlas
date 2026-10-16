# Deferred items (phase 02)

## From plan 02-02

- `scripts/package.test.ts`: 4 cases fail in the phase-02-execute worktree (built dist shebang/version, production-only dist, pack contents, installed tarball). Cause: `node_modules/typescript/bin/tsc` is not present in the worktree, so `tsc -p tsconfig.build.json` cannot run. Environmental and unrelated to src/facts changes; rerun in a checkout with a full `npm ci`.
