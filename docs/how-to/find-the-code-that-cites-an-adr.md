# How to find the code that cites an ADR

This guide lists the code comments that cite one ADR and finds the ADR file itself. It assumes a built index. Run the commands from inside the repository; `gsd-atlas` below stands for `node /path/to/gsd-atlas/dist/bin/gsd-atlas.js`.

1. List the comments that cite the ADR. Give its number, with or without leading zeros:

   ```sh
   gsd-atlas refs ADR-7 --kind adr
   ```

   Each entry of `data.results` is one comment: its `path`, `line` and `col`, the section `detail` when the comment gives one (`ADR-7 §3.2`), and `attachedTo`, the definition the comment belongs to, or `null`. The comment's own line is in `untrusted_text`.

2. Find the ADR file:

   ```sh
   gsd-atlas find ADR-7 --kind adr
   ```

   `data.results` lists the file or files with that number, and `data.citations` says how many comments cite it. `data.adr.files` of the `refs` answer lists the same files.

3. To see which ADRs a symbol's comments cite, ask for its context:

   ```sh
   gsd-atlas context <symbol name>
   ```

   The section `data.citations` lists each mention attached to the definition, with the number, its status and its files.

4. To see how one comment was read, pass the `cit/` handle of its citation (the `debug` value) to `explain`:

   ```sh
   gsd-atlas explain <cit handle>
   ```

## If the status is `unresolved`

No ADR file with that number is in the ADR directories, so `data.adr.files` is empty. The comments are still listed. Check the number, then check whether the repository keeps its ADRs in another directory (see below).

## If more than one file matches the number

The status is `ambiguous`: every file with the number is listed, sorted, and each link is marked `INFERRED`. Open the files and pick the one the comment means.

## If the answer carries `citation_comment_too_long`

Some files have ADR mentions that were not indexed, because a comment is over the comment size bound or a file has more than 200 mentions. The list may be incomplete. The count is for the whole worktree and names no file, so look in the files you suspect with a text search of your own. `gsd-atlas health` shows the count as `citations.filesWithGaps`.

## If the repository keeps its ADRs in another directory

Name the directories in `.gsd-atlas/config.json` at the repository root, at most eight relative paths:

<!-- verified-by: code: src/tenant/repo-config.ts -->
```json
{ "adrDirs": ["decisions"] }
```

Ask again; no build is needed. Only `adrDirs` is read from this file. Any other key is ignored, and the answer then carries the note `repo_config_ignored`.

## If the answer says no comment cites the number

Nobody cites it, or the index is behind the files. Run `gsd-atlas build` after changing the repository, then ask again.

For the forms of a citation, the statuses and the bounds, see [the ADR citations reference](../reference/adr-citations.md). For the fields of the answers, see [the MCP reference](../reference/mcp.md#adr-citations).
