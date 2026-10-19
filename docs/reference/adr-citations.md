# gsd-atlas ADR citations reference

Which code comments gsd-atlas reads as citations of an ADR, how a number is joined to an ADR file, and what an answer says when it cannot be complete. The fields of the answers are in [the MCP reference](mcp.md#adr-citations), the commands in [the CLI reference](cli.md#gsd-atlas-find).

## What counts as a citation

A citation is a mention of an ADR number in a code comment. Mentions in string literals, and anywhere else that is not a comment, are not citations.

| Form | Example |
| --- | --- |
| `ADR-<n>` | `// ADR-0007` |
| `ADR <n>` | `// adr 7` |
| `ADR #<n>` | `// ADR #7` |
| `ADR#<n>` | `// ADR#7` |

- Any letter case. A section suffix after the number, such as `§3.2`, is kept as the detail of the citation.
- The number is compared by value, so `ADR-0007` and `ADR #7` cite the same ADR.
- Comments are read only in a language module that supports them; the built-in `typescript` and `javascript` modules do.

## The name of an ADR in a question

`gsd-atlas find <name> --kind adr`, `gsd-atlas refs <name> --kind adr` and the tools `code_find` and `code_refs` with `kind: adr` take an ADR number as the name.

| Accepted | Refused |
| --- | --- |
| `ADR-3473`, `adr 3473`, `ADR #3473`, `ADR#3473`, `#3473`, `3473`, with leading zeros allowed | zero, more than 11 digits, anything else |

A refused name gives `invalid_args` with the text `With kind adr the name must be an ADR number such as ADR-3473, adr 3473, ADR #3473, #3473 or 3473.` (exit 1).

## ADR files and directories

An ADR file is a regular file whose name is digits, a dash, a name, and `.md`: `0001-first.md` and `2-second.md` are ADR files; `README.md`, `12.md` and `adr-0003.md` are not. The number of the file is compared by value with the number of a citation. Only the names of files are used: no ADR document is read, indexed or returned.

The directories searched, in order of precedence:

| Source | Directories |
| --- | --- |
| `adrDirs` of the repository file `.gsd-atlas/config.json` | The listed directories replace every other source for that repository. |
| `project.adrDirs` of the active language module manifests (manifest `schemaVersion` 2) | The union of their lists, in first-seen order. The built-in modules name `docs/adr`, `docs/adrs`, `doc/adr` and `adr`. |
| The convention list | `docs/adr`, `docs/adrs`, `doc/adr`, `adr`, used when no manifest names any. |

The repository file is untrusted data and can never enable a command or a permission:

- Only `adrDirs` is read. It is a list of at most eight relative paths inside the repository. Every other key is ignored, and the answer then carries one `info` diagnostic, `repo_config_ignored`, with fixed text.
- A file over 64 KiB, a file that is not valid JSON and a file that is not an object are ignored whole, with the same diagnostic.
- A directory is listed through a confined reader: a path that leaves the repository, or a link that points outside it, lists nothing. At most 5000 names are read from a directory (`adr.listMaxEntries`).

## Statuses

`status` says what a number names in the repository's ADR directory. A citation is never dropped because its ADR file is missing.

| Status | When | `files` | Confidence of the citation links |
| --- | --- | --- | --- |
| `resolved` | One ADR file has the number. | that file | `EXTRACTED` |
| `ambiguous` | Several files have the number, for example `0010-ten-a.md` and `10-ten-b.md`. | every file, sorted | `INFERRED`, one link per file |
| `unresolved` | No file has the number. | none | `INFERRED`; the citations are still listed, and `code_find` says how many there are |

When the listing of a directory was cut, an `unresolved` answer also carries `listTruncated: true`.

## Handles

`code_explain` accepts the `cit/` handle of a citation, the `debug` value of its citation entry. `explanation.kind` is `citation`, `explanation.citation` is `{ number, detail? }` and `data.adr` is `{ number, status, files[] }`. The handle of an ADR file in a `code_find` answer, `adr/<path>`, is not accepted by `code_explain`: the file's text is never read, so that citation carries no `untrusted_text`.

## Bounds

| Bound | Value | Behaviour past it |
| --- | --- | --- |
| Comment size (`adr.maxCommentUnits`) | 32768 UTF-16 code units | The whole comment is skipped and counted. It is never clipped, so `ADR-123` cannot become `ADR-1`. |
| Citations per file (`adr.maxCitationsPerFile`) | 200 | The first 200 are kept; the scan stops there. |

## Gap diagnostic

A skipped comment or a cut file leaves a trace stored with the file version. While the answered worktree holds at least one such file, every `kind: adr` answer of `code_refs` and `code_find` carries one `info` diagnostic with the code `citation_comment_too_long` and no `subject`, on every page of a cursor-paged answer. Its text is fixed and its only variable is the number of such files:

| The answer holds | Text |
| --- | --- |
| A citation | `Citations may be missing from this answer: 1 file has ADR mentions that were not indexed (a comment over the comment size bound, or more than 200 mentions in one file).` (`2 files have` for two or more) |
| None | `No citation of this ADR was found, but 1 file has ADR mentions that were not indexed, so a citation may exist that this answer cannot show.` (`2 files have` for two or more) |

- The count is worktree-wide and names no file, because a skipped comment was never read.
- `code_context` carries the first text only when the file that defines the symbol holds a gap.
- `gsd-atlas build` reports the same code once, with the count, when at least one file holds a gap. The count is read from the store, so a build that parses nothing repeats it.
- `atlas_status` reports the count as `citations.filesWithGaps`; it adds no health reason.
- It is a diagnostic, not a degraded code: `degraded` is not set for it.
- A development store built before the table of gaps existed reports no gap until its `facts.db` (in the store folder, see [Where the index lives](cli.md#where-the-index-lives)) is recreated by a build.

## Example

A comment `// The config format follows ADR-7.` above a declaration, and the file `docs/adr/0007-demo.md`:

<!-- verified-by: cli: gsd-atlas refs ADR-7 --kind adr -->
```json
{"schema":"gsd-atlas.code-refs/1","ok":true,"data":{"adr":{"number":7,"status":"resolved","files":["docs/adr/0007-demo.md"]},"results":[{"path":"src/config.ts","line":1,"col":30,"attachedTo":"Config","confidence":"EXTRACTED","citation":"c1"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/config.ts","line":1,"col":30,"endLine":1,"endCol":35,"confidence":"EXTRACTED","debug":"cit/src%2Fconfig.ts/09988070c645527a4cd55b67b025864fd3c41381/0","text_ref":"ut1"}],"watermark":{"seq":4,"stalePaths":[]},"untrusted_text":{"nonce":"987a029dd961924b1f604fa3ca26c8c6","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-987a029dd961924b1f604fa3ca26c8c6\n// The config format follows ADR-7.\nEND-UNTRUSTED-987a029dd961924b1f604fa3ca26c8c6"}]},"answer_id":"a_623595565102cfee"}
```

## See also

- [gsd-atlas MCP reference](mcp.md)
- [gsd-atlas command-line reference](cli.md)
