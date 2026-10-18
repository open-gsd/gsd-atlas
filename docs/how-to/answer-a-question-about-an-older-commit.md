# How to answer a question about an older commit

This guide answers a symbol question as the code was at an earlier revision, with `gsd-atlas history`. It assumes a built clone of gsd-atlas and a git repository that contains the commit. The repository does not need an index.

1. Pick the revision for `--at`: a branch name, a tag, a commit id (short or full) or an expression such as `HEAD~1`.

2. Run `history`, naming the tool (`find`, `refs`, `context` or `impact`), the symbol and the revision, from inside the repository:

   ```sh
   node /path/to/gsd-atlas/dist/bin/gsd-atlas.js history find parseConfig --at HEAD~1
   ```

   The answer is the code as of that commit. It is read from git objects alone, nothing is written to the index, and no remote is contacted.

3. Read the answer.
   - `schema` is `gsd-atlas.history/1`, and `data` has the shape of the answer of the tool you named.
   - The first of `hints` names the commit (12 characters) and says that the working tree and the index were not consulted.
   - Each citation gives the `path`, `line` and `col` in that commit, and the line text in `untrusted_text` is the line as it was then.

## If you need one file only

Add `--path` with the repo-relative path of the file as it is in that commit:

```sh
node /path/to/gsd-atlas/dist/bin/gsd-atlas.js history find JobQueue --at 3d72fc0 --path src/queue.ts
```

If the path is not a source file of that commit, the answer is empty and a hint says so. A path that leaves the repository (`..`) is refused with `invalid_args` and exit 1.

## If the answer is too large

Lower `--limit` or `--budget`, or narrow the question with `--path`, `--kind` or `--mode`. The answer is marked `truncated`. `history` takes no `--more`, so a cut answer cannot be continued; ask a narrower question instead. A commit with more than 2000 source files is read in path order up to that number and carries a `history_truncated` warning; use `--path` to ask about one file.

## If the revision is not found or not usable

- `commit_not_found` (exit 2): the repository holds no commit by that name; nothing was fetched. In a shallow clone, a commit older than the clone's depth gives this answer too.
- A `--at` value that is empty or starts with a dash is refused with a usage error (exit 1), because it could be taken for an option.
- A missing `--at` is a usage error (exit 1).

## If `history_unavailable`

The temporary directory is inside the repository or its index. Set `TMPDIR` to a directory elsewhere and run the command again.

## If the answer is empty

A hint says why: no loaded language module claims the file's extension, the symbol name matched nothing, or some files could not be used (binary, over the size cap or not parsable).

For every flag and exit code, see [the CLI reference](../reference/cli.md). For the answer envelope, see [the MCP reference](../reference/mcp.md).
