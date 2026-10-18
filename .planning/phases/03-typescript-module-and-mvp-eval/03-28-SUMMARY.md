---
phase: 03-typescript-module-and-mvp-eval
plan: 28
subsystem: adr-resolution-and-citation-gaps
tags: [adr-citations, listDirectory, manifest-v2, repo-config, cit-handles, citation-gaps, status-field, tdd]
requires:
  - phase: 03-typescript-module-and-mvp-eval
    provides: "03-24 stored citations (schema 2) and the comment bound; 03-26 handles and code_explain; 03-29 the build envelope that copies Indexer notes; 03-16 frozen Stage A (D-08 precondition, verify-prereg ok); 03-08 ADR 5, 6, 7 and 13 amendments"
provides:
  - "SourceTree.listDirectory(worktree, dir, {maxEntries, ifMtimeMs}): confined, regular files only, bounded scan, names only, an unchanged answer for one stat (real and fake, one shared contract)"
  - "Reader.citations({number | symbol}) with cit/ handles; Reader.citationGaps({path}) and WorktreeStatus.citationGapFiles"
  - "src/tenant/adr.ts: parseAdrFileName, chooseAdrDirs, createAdrDirectory (per-mtime memo, lookup by value, resolved / ambiguous / unresolved); src/tenant/repo-config.ts: readRepoConfig (adrDirs only, one fixed repo_config_ignored note)"
  - "manifest schemaVersion 2 with project.adrDirs (union on schemaVersion, one JSON Schema for both); ModuleEntry.schemaVersion and adrDirs; both built-in modules at version 2 with the convention list"
  - "code_refs and code_find with kind adr, code_context data.citations, cit/ handles in code_explain (kind citation, data.adr)"
  - "FileFacts.citationGaps {skippedComments, capped}, the citation_gaps table (SCHEMA_VERSION stays 2), the Indexer note counted from the store"
  - "the fixed-text diagnostic citation_comment_too_long on kind adr answers and code_context, atlas_status citations.filesWithGaps, adr-citations-check --resolve and its filesWithGaps line"
affects: [03-30, 03-31, 03-33, 03-34, 03-35]
tech-stack:
  added: []
  patterns:
    - "Resolution as a read-time join: the store keeps a number, the Tenant lists ADR directories through the Source Tree seam, so facts stay shareable across branches"
    - "A loss the index knows about is a stored fact of the file version, counted from the store, never a per-run marker"
    - "A closed-vocabulary diagnostic with one integer: the answer says it may be incomplete without naming a file, a number or a word of a comment"
key-files:
  created:
    - src/source-tree/list-directory.ts
    - src/fact-store/citations.ts
    - src/tenant/adr.ts
    - src/tenant/adr.test.ts
    - src/tenant/repo-config.ts
    - src/query/adr.ts
    - src/query/adr.test.ts
    - scripts/adr-e2e.test.ts
    - test/fixtures/manifests/valid-v2-adrdirs.json
    - test/fixtures/manifests/invalid-v1-adrdirs.json
  modified:
    - src/source-tree/types.ts
    - src/source-tree/real.ts
    - src/source-tree/fake.ts
    - src/source-tree/index.ts
    - src/source-tree/contract.ts
    - src/source-tree/source-tree.test.ts
    - src/lang/manifest.ts
    - src/lang/registry.ts
    - src/lang/index.ts
    - src/fact-store/types.ts
    - src/fact-store/reader.ts
    - src/fact-store/provenance.ts
    - src/fact-store/schema.ts
    - src/fact-store/writer.ts
    - src/fact-store/lifecycle.ts
    - src/fact-store/store.ts
    - src/facts/file-facts.ts
    - src/grammar-engine/extract.ts
    - src/indexer/process.ts
    - src/indexer/reconcile.ts
    - src/indexer/types.ts
    - src/query/types.ts
    - src/query/query.ts
    - src/query/context.ts
    - src/query/explain.ts
    - src/query/ranking.ts
    - src/query/status.ts
    - src/query/tools.ts
    - src/tenant/create.ts
    - src/tenant/follower-overlay.ts
    - src/tenant/index.ts
    - scripts/adr-citations-check.ts
    - schemas/atlas-lang.schema.json
    - modules/typescript/atlas-lang.json
    - modules/javascript/atlas-lang.json
    - docs/reference/mcp.md
    - docs/reference/cli.md
key-decisions:
  - "listDirectory has an optional ifMtimeMs: the Source Tree answers unchanged after one stat, which is what makes the memo 'one stat on an unchanged directory' true instead of a readdir every time. maxEntries (default 5000, adr.listMaxEntries) is also an option so the cap is testable without 5001 files; the scan itself looks at no more than four times the cap."
  - "The two manifest versions are a z.discriminatedUnion on schemaVersion built from built-in checks only; the generated schema is one document with a oneOf over both, and the committed file, the parity test and the registry cover both. The $id stays urn:gsd-atlas:schema:atlas-lang:1 (one document, nothing that referenced it breaks); the changelog is in the manifest header."
  - "A citation whose number has no ADR file is kept with INFERRED confidence (a link that cannot be verified is not EXTRACTED); one file gives EXTRACTED, several give one INFERRED link each. The gap does not change a status or a confidence: it adds a diagnostic."
  - "The ADR file of a code_find answer carries a citation at line 1 with the handle adr/<path> and no text (ADR contents are never read); code_explain does not accept it. It does not make the answer stale."
  - "The gap diagnostic counts the worktree's files for code_refs and code_find, and says which of two fixed texts by whether the answer holds a citation (the whole answer, so every page agrees); code_context uses the first text for its own file only (1 file)."
  - "The repository config diagnostic reaches the answer through AdrLookup.diagnostics and is added to kind adr answers only; it is one note however many keys or entries were ignored."
requirements-completed: [TSM-04]
status: complete
commits: 10
plan_head_before: 6ef95cb5ea7199102e1672d4990d0a19f3c2f0bd
plan_head_after: ce7bd31301f888f2216a82438af305dea3e7b321
actuals:
  tokens: 73000
  tasks: 5
  commits: 10
duration: one session
completed: 2026-10-18
---

# Phase 3 Plan 28: ADR resolution and persisted citation gaps Summary

**"Which code cites ADR N, and where is ADR N" is answered by `code_refs`, `code_find` and `code_context` with resolved, ambiguous and unresolved statuses against the repository's ADR directory (module manifests, overridable by an untrusted `.gsd-atlas/config.json` that can name directories and nothing else), and an answer now says so when the index could not store every citation: a per-file gap is stored with the file version, counted from the store, shown as a fixed-text diagnostic and as `citations.filesWithGaps` in `atlas_status`.**

## Tasks

| Task | Name | RED | GREEN |
|------|------|-----|-------|
| 1 (tracer) | `code_refs` of an ADR number lists the citing comments and the resolved ADR file | 912fdb9 | e9b56bd |
| 2 | Manifest version 2 with `adrDirs`, the repository config override, the built-in modules | 166766b | 14afa2a |
| 3 | `code_find` kind adr, `code_context` citations, `cit/` handles, ambiguity, the gsd-core check | be51539 | 90cd63d |
| 4 | Persist per-file citation gaps and count them from the store | f6ef265 | 33fff4b |
| 5 | The gap diagnostic, `citations.filesWithGaps`, the reference text | 7d94682 | ce7bd31 |

Tracer gate (task type `tracer`, no `gate` attribute, interactive, `HUMAN_VERIFY_MODE` end-of-phase, automated-only `<verify>`): the verify tests, typecheck and lint and the whole suite were re-run after the Task 1 commit (4,233 tests, 0 failures) before Task 2 started. Each RED commit holds tests only (and, for Task 2, two manifest fixtures); the failing counts at RED were 27 of 330 (Task 1), 10 of 121 (Task 2), 10 of 182 (Task 3, several of them characterisation of Task 1 behavior), 28 of 327 (Task 4) and 15 of 77 (Task 5). The shell has no `gsd_run`, so the formal `tdd-red-evidence` check was not run.

## What was built

- **`listDirectory`** (`src/source-tree/list-directory.ts`, real, fake, one contract). The path is confined like `readText`: absolute, drive-relative, empty, NUL and `..` are `escape`, and so is a path whose real path (links followed) leaves the worktree; a directory link that stays inside is followed; a link among the entries is never listed; names with a line break or NUL or a leading dash are left out. It starts no git process and reads no file. `ifMtimeMs` returns `unchanged` for one stat.
- **ADR directory** (`src/tenant/adr.ts`). `parseAdrFileName` takes `<digits>-<slug>.md` only (`0001-first.md` is 1, `00-zero.md` is 0, `README.md`, `12.md`, `adr-0003.md` and `.markdown` are none). The index is built from the listings, memoised per directory and mtime, rebuilt only when a directory's state moved, and answers `resolved`, `ambiguous` (listed sorted) or `unresolved`; a cut listing adds `listTruncated`.
- **Directories** (`chooseAdrDirs`): the repository config's `adrDirs` when present (an empty list too), else the union of the active modules' `project.adrDirs` in first-seen order, else `docs/adr`, `docs/adrs`, `doc/adr`, `adr`. `readRepoConfig` reads `.gsd-atlas/config.json` through the confined reader (64 KiB cap), honours `adrDirs` (at most eight entries under the manifest path rule) and gives one fixed `repo_config_ignored` info note for any other key, a dropped entry, or a file ignored whole.
- **Query** (`src/query/adr.ts`). `normaliseAdrName` accepts `ADR-3473`, `adr 3473`, `ADR #3473`, `ADR#3473`, `#3473`, `3473` (11 digits at most, not zero) and refuses the rest with one fixed `invalid_args` sentence. `code_refs` returns `{adr: {number, status, files}, results[]}` (path, line, col, detail, attachedTo, confidence, citation, with the matched comment line fenced); `code_find` returns `{number, status, citations, results[]}` with the ADR files; `code_context` adds `data.citations[]` as a `citation` section between the relations and the imports; paging, budget and cursor are the shared ones. `code_explain` accepts `cit/` handles.
- **Manifest version 2.** `project.adrDirs` exists from version 2 only; version 1 manifests stay valid; the parity test covers both versions with 21 new edge cases; `lang list` shows `schemaVersion` and `adrDirs`.
- **Citation gaps.** The extractor looks one mention past the cap (so exactly 200 is not capped and 201 is, with the same first 200 citations as before) and counts the blanked comments; `validateFileFacts` rejects the empty gap, a bad count, a non-boolean and any extra key; the `citation_gaps` table is written in the file's own transaction, cleared on rewrite and collected with the version; `Reader.citationGaps` counts overlay files (a version linked from two paths counts for each); `WorktreeStatus.citationGapFiles`; the follower overlay merges patched files. The Indexer note is counted from the store after `setOverlay`; `PathResult.commentsTooLong` is gone.
- **Visibility.** `citationGapDiagnostic(files, found)` has the two fixed texts of the plan. `code_refs` and `code_find` with `kind: adr` carry it on every page when the worktree holds a gap; `code_context` carries the first text (`1 file has`) only when the defining file holds one. `atlas_status` gains `citations: {filesWithGaps}` and no health reason. `DEGRADED_CODES` still has fourteen codes.

## Measured on the pinned gsd-core (`10ac3a7`, prepared checkout of 03-24, macOS arm64)

| Check | Result |
|-------|--------|
| `adr-citations-check.ts --resolve --sample 20 --seed 7` | 79 distinct numbers cited in comments: `resolved 72`, `ambiguous 2` (the duplicate ids 10 and 11), `unresolved 5`; 20 compared with the oracle: `disagreements 0` (the sample contains 10, the ambiguous one) |
| `adr-citations-check.ts --sample 20 --seed 7` | `agree 1173`, `store_only 0`, `oracle_only 0`, `filesWithGaps 0` (read from the store it built) |
| `--resolve` also prints | `filesWithGaps 0` |

So the scored run of plan 03-35 gains no diagnostic from this plan. The plan text says "all 102 cited ids"; the oracle finds 79 numbers in code comments (the 03-24 summary measured the same 79), so the counts above are over those 79 and the other cited ids of the research figure are not comment citations.

## Verification

`npm run typecheck`, `npm run lint`, `npm run build` and `npm run schema:check` clean. `npm test`: 4,349 tests, 4,347 pass, 0 fail, 2 skipped (both pre-existing), against 4,172 on the base commit (177 new cases, no flake seen). `node scripts/eval/verify-prereg.ts`: `verify-prereg: ok`; the diff of the base against HEAD touches nothing under `scripts/eval` or `docs/eval`. `node src/bin/gsd-atlas.ts lang test modules/typescript` and `modules/javascript` pass; no golden file changed. `MODULES.length` is still 23 (nothing added to the lint module list); `SCHEMA_VERSION` is still 2 and a test pins it; the SEC-01 hostile-repository test passes with `adrDirs` pointing at `../../etc`, a sibling directory and a link to it (nothing listed, no process but built-in git, no marker).

## Deviations from Plan

**1. [Rule 3 - Blocking] Files outside the plan's `files_modified` that the interface changes required**
- `src/source-tree/list-directory.ts` and `src/fact-store/citations.ts` (new files that keep `real.ts` and `reader.ts` small), `src/fact-store/index.ts`, `src/lang/index.ts`, `src/query/index.ts`, `src/query/query.ts` (the `kind: adr` dispatch, so `find.ts` and `refs.ts` do not import `adr.ts` in a cycle), `src/query/explain.ts`, `src/query/ranking.ts` (the `citation` section), `src/tenant/index.ts`, `src/tenant/follower-overlay.ts` (it implements the whole `Reader`), `docs/reference/cli.md`, `test/fixtures/manifests/*.json` (`invalid-schema-version.json` moved from 2 to 3 because 2 is now valid; two new fixtures).
- Test doubles that list every method of an interface: `src/indexer/harness.test.ts` and `src/indexer/indexer.test.ts` (`SourceTree.listDirectory`), `src/fact-store/fact-store.test.ts` and `src/query/fresh.test.ts` (`Reader.citations` and `citationGaps`), and the expectations that deep-equal a `WorktreeStatus`: `src/fact-store/contract.ts` and `src/fact-store/status-files.test.ts` now include `citationGapFiles: 0`. Parallel plans 03-30 and 03-31 should expect to meet these in a merge.

**2. [Interpretation] The JSON Schema `$id` is unchanged**
- The plan says both that the document stays one document and that its `$id` and title are updated "if it now covers two versions". I kept `urn:gsd-atlas:schema:atlas-lang:1` and the title, because changing a published id buys nothing the `oneOf` does not already say; the manifest header carries the changelog. Change it if you want the id to move.

**3. [Design] `listDirectory` takes two options the interface line did not name**
- `maxEntries` and `ifMtimeMs` (see key decisions). The call `listDirectory(worktree, dir)` is the plan's.

**4. [Design] The ADR file citation of `code_find`**
- The plan wants a citation at line 1 of the ADR file. The document is never read, so the citation has no text and its handle is `adr/<path>`, which `parseHandle` does not accept (`code_explain` answers `invalid_handle` for it, as for any made-up handle). The reference says so.

**5. [Design] `AdrLookup` and `AdrIndex` carry the config diagnostics**
- The plan fixes the diagnostic text and the one-note rule but not the route into an answer. It rides `AdrLookup.diagnostics` and appears on `kind: adr` answers only (not on `code_context` and not on the build envelope).

**6. [Detail] Constants without a registry row**
- The 64 KiB cap on the repository config and the limit of eight `adrDirs` entries are the plan's numbers; `03-CONSTANTS.md` has no row for either (it has `adr.listMaxEntries`, `adr.maxCitationsPerFile` and `adr.maxCommentUnits`, which are used as registered). A row can be added in the end-of-phase step.

**7. [Detail] Early-exit and full-path scan bounds moved from 200 to 201**
- Needed to tell exactly 200 from 201 (`citationGaps.capped`). The citations kept are the same first 200 (the 03-24 reference-comparison and probe tests pass unchanged); the probe bounds in the new tests are `12 * 201 * 10` and `40 * 201`.

**8. [Process] CLI versus MCP parity tests order their runs**
- A process that does not hold the writer lease marks its answers `follower`, so a CLI run started while an MCP server holds the lease differs. The parity tests run every CLI call first and start the MCP server after, so both are leaders.

## Known limits worth a second look

- **A development store built before this plan reports no gap** until `facts.db` is removed from the store directory and `gsd-atlas build` is run again (documented in `docs/reference/mcp.md`); the schema version stays 2, which plan 03-31 pins.
- **The gap count is worktree-wide and names nothing.** A skipped comment's number was never read, so any gap file may hide a citation of the number asked; an answer with a gap always carries the diagnostic, even when the number asked is rare.
- **`history find --kind adr` is not an ADR question.** The history tools read git only and do not take the new meaning of the kind.
- **The repository config and the module registry are read on every ADR question** (a 64 KiB read at most, and a registry scan); only the directory listing is memoised. ADR questions are rare, so no interval-based cache was added.
- **ADR file recognition is stricter than the oracle's.** The oracle accepts `.markdown`, `.mdx` and names like `3_x.md`; the product accepts `<digits>-<slug>.md` only (the plan's table). On gsd-core this made no difference (`disagreements 0`).
- **`skills/gsd-atlas/SKILL.md` and the tutorials are not updated** (plans 03-33 and 03-34 own them); the reference text is in `docs/reference/mcp.md` and `cli.md`.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-03-281 (path to listing: relative-path rule, realpath confinement, `escape`, the hostile fixture with a `..` entry, a sibling and a link), T-03-282 (only `adrDirs` is read; the hostile config enables nothing), T-03-283 (names only as path fields; the number parsed from leading digits; fixed texts), T-03-284 (cap and bounded scan, memo per mtime), T-03-285 (the full envelopes of the fixture runs are searched for the header marker and the gap file names) and T-03-286 (the gap is written in the file's transaction, shared by every path, collected with the version, counted from the store; round trip, link, collect and no-op build cases on both drivers) are mitigated and tested. T-03-287 is accepted as planned.

## Self-Check: PASSED

- Files present: src/source-tree/list-directory.ts, src/fact-store/citations.ts, src/tenant/adr.ts, src/tenant/repo-config.ts, src/query/adr.ts, scripts/adr-e2e.test.ts and every modified file above.
- Commits 912fdb9, e9b56bd, 166766b, 14afa2a, be51539, 90cd63d, f6ef265, 33fff4b, 7d94682 and ce7bd31 are ancestors of HEAD; `git rev-list --count 6ef95cb..HEAD` was 10 before this file was added.
- The `node_modules` link of the worktree and its `dist/` build output are removed before returning.
