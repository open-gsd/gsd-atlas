# How to exclude files from the index

Use this when atlas indexes files you do not want answers from: generated documentation, vendored code, snapshots. The index already leaves out `node_modules/`, build output and caches; the list is in [the index exclusions reference](../reference/index-exclusions.md).

1. Create a file named `.atlasignore` in the root of the repository. It uses the syntax of `.gitignore`, one pattern per line:

   ```text
   # generated documentation and snapshots
   docs/generated/
   *.snap
   !keep.snap
   ```

   A `.atlasignore` in a subdirectory applies below that directory. Tracked files under `node_modules/`, `dist/` and `build/` stay indexed by default; to remove them, name the directory here (for example `dist/`). The file can only remove files from the index. It cannot bring back a file `.gitignore` hides or one of the built-in exclusions, and it works on tracked files too.

2. Index the repository again:

   ```sh
   gsd-atlas build --repo .
   ```

   The `diagnostics` of the answer say how many files were left out, for example `1 file was left out of the index by .atlasignore`. The note never names a file.

3. Check the counts. `gsd-atlas health --repo .` shows them in `data.indexer.excluded`, as `byDefaults` and `byAtlasignore`.

4. If a file is still indexed, check two things. Patterns are matched as git matches them, and a pattern with a slash in the middle is anchored at the directory of the `.atlasignore`, so `docs/generated/` does not match `lib/docs/generated/`. And a later line starting with `!` brings back a file an earlier line removed.

5. If the build reports `atlasignore_unusable`, the file was not used at all. The command prints the warning on standard error as well. Fix the cause and build again:

   - The `.atlasignore` files of the repository hold more than 64 KiB together: shorten them.
   - A file contains a NUL byte or text that is not valid UTF-8: save it as UTF-8 text.
   - `.atlasignore` is a link, or a directory has that name: replace it with a regular file inside the repository.

While atlas runs, saving a `.atlasignore` makes it forget what it learned about the files it was asked about; the files already indexed leave the index at the next `gsd-atlas build` or Reconcile.

Related: [the index exclusions reference](../reference/index-exclusions.md) and [the CLI reference](../reference/cli.md).
