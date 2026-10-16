# Eval corpora

`corpora.json` pins every eval corpus to a commit SHA so that accuracy and eval
numbers are comparable across runs. A moving branch would silently change what an
eval measures. No corpus content is committed here, and no test clones one: the
manifest is data only.

## Fields

| Field | Meaning |
|-------|---------|
| `id` | Stable identifier, `^[a-z][a-z0-9-]*$`, unique in the manifest. |
| `repo` | `owner/name` on GitHub. `null` while `status` is `unselected`. |
| `ref` | The branch the pin was resolved from. Informational only; the SHA is authoritative. `null` while unselected. |
| `sha` | Full lowercase commit id: 40 hex (SHA-1) or 64 hex (SHA-256 repositories). Never a branch, tag or short SHA. `null` while unselected. |
| `status` | `pinned` or `unselected`. An unselected entry must not carry a repo, ref, sha or `pinnedAt`. |
| `role` | What the corpus is used for. Required on every entry. |
| `pinnedAt` | Date (`YYYY-MM-DD`) the SHA was resolved. Optional. |
| `note` | Free text. Optional. |

`scripts/corpus.ts` exports `validateCorpora(json)`, which returns a list of error
strings (empty means valid). `scripts/corpus.test.ts` runs it offline against the
committed manifest as part of `npm test`.

## Current entries

- `gsd-core`: primary validation corpus (TypeScript `.cts` emitted to `.cjs`, ADRs).
- `gsd-pi`: pnpm monorepo with 14 tsconfigs.
- `gsd-path`: Python bring-your-own proof.
- `gsd-graph`: PRD criterion 16 reference set and bridge target.
- `swift-reference-app`: **unselected**. The Swift reference app is chosen and
  pinned in Phase 5 (SWF-05). Until then it is listed explicitly, with no SHA,
  rather than missing.

## Re-pinning

Resolve a ref to its current commit, edit `sha` and `pinnedAt`, then run the tests:

```sh
gh api repos/<owner>/<name>/commits/<ref> --jq .sha
node --test scripts/corpus.test.ts
```

To confirm every pinned SHA still exists upstream (online, needs the `gh` CLI and
authentication; not part of `npm test`):

```sh
node scripts/corpus-check.ts
```

## Warning: earlier measurements are not at these pins

Research measurements taken before this manifest existed (parse-error rates,
file counts, grammar budgets) used unrecorded SHAs. They are not comparable with
numbers taken at these pins. Phases 2 and 3 must re-measure at the SHAs in
`corpora.json` before quoting or budgeting against any such figure.
