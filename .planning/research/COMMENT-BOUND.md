# Review: the ADR comment text bound (`GRAMMAR_LIMITS.commentTextChars`, 4,096 -> 65,536)

Read-only research for plan 03-24. Code read from the worktree `.claude/worktrees/agent-a7a6df41f78433e26` (HEAD 6b889fa); all measurements ran on a scratch copy in `scratchpad/comment-bound/work` whose only change is `commentTextChars: Number(process.env.BOUND ?? 65536)` (limits.ts:29). Corpora: gsd-core @ 10ac3a7 (local `--shared` clone), gsd-pi @ bb86b6c (shallow fetch, the pinned SHA). Machine: macOS arm64, Node 26.11.1. Scripts: `scratchpad/comment-bound/tools/*.mjs`, raw logs `sweep-*.log`, `adv.out`.

## (a) The question

Does the constant cause longer-term degradation (CPU, memory, store size/growth, query latency, worker memory, scan time, hostile-repo cost under SEC-01), and what is the right value and design (unit, what is bounded, truncate vs reject, chunking, per-file budget)?

## (b) How it works today (file:line, worktree)

- **Where the bound is applied.** `src/grammar-engine/limits.ts:29` (`commentTextChars: 65536`), `captureTextLimit(name)` at limits.ts:33-35 returns it only for a capture named `comment`, else `captureTextChars` 256. It is applied in exactly one place: `src/grammar-engine/normalize.ts:37`: `text = node.endIndex - node.startIndex > captureTextLimit(name) ? '' : source.slice(...)`. It is a **blank-the-whole-text** rule, never a clip. The fake engine uses the same function. No other bound on comment text exists; the only other relevant cap is `sourceBytes` 2 MiB (limits.ts:13, enforced at `engine.ts` before parse, UTF-8 bytes).
- **Mechanism for "captures over 256 are empty (T-02-21)" vs comments:** the same `toCapture` ternary, with a per-name limit. So comments over 256 get text only because of `captureTextLimit('comment')`.
- **Unit.** `node.endIndex - node.startIndex` is web-tree-sitter's UTF-16 offset. Measured: a comment of exactly 65,536 CJK units = a 196,602-byte file was kept; 2xB emoji (131k units) was blanked (`adv.mjs cjk65536`, `astral`). 65,536 units can therefore be up to 196,608 UTF-8 bytes (3 B/unit) or 262,144 bytes for astral pairs.
- **Predicate runs on the FULL text regardless of the bound.** The tags query filter `#match?` is evaluated inside web-tree-sitter: `node_modules/web-tree-sitter/web-tree-sitter.js:3524-3534` (`c.node.text` then `regex.test(text)`). So every comment in every file is materialised and regex-tested in the worker; `commentTextChars` does not reduce that cost at all. Regex: `modules/typescript/queries/tags.scm:25`.
- **Where the scan runs.** The Grammar Engine runs in a worker thread pool (`src/bin/compose.ts:93` `createPooledGrammarEngine`; `src/grammar-engine/pool/worker.ts` posts the whole `GrammarRunResult` incl. capture text by structured clone). `extractFileFacts` -> `scanAdrMentions` runs afterwards **in the Host process thread** (`src/indexer/modules.ts:108`, called from `src/indexer/process.ts:257`). So the scan and `attachCitations` block the Host event loop for their duration.
- **The scan.** `extract.ts:229-305` `scanAdrMentions`: a hand-written single pass; digit runs consumed once; zero-run and `§` token loops bounded by `CITATION_TOKEN_MAX`. `collectCitationDrafts` (extract.ts:318-358) builds a draft object per mention for EVERY non-blank comment in the file; only then `attachCitations` sorts all drafts and `slice(0, MAX_CITATIONS_PER_FILE)` (extract.ts:373-377). The cap of 200 (`file-facts.ts:105`, validated at :258; registered in 03-CONSTANTS.md as `adr.maxCitationsPerFile`) is therefore applied after the work, not before. `attachCitations` also does `comments.find(...)` per kept draft (extract.ts:380) and symbol scans (`documentedSymbol`, :395).
- **What is stored (question 1).** `src/fact-store/schema.ts:133-148`: `citations (file_id, ord, number, detail, start_line, start_col, end_line, end_col, enclosing)`, `PRIMARY KEY (file_id, ord)` WITHOUT ROWID, plus `CREATE INDEX citations_by_number ON citations(number)`. Header comment: "No column holds comment text." Writer: `writer.ts:148-163`, one `INSERT` per citation inside `commitFile`'s transaction (`facts.citations?.forEach`), cleared in `rewriteFile` (writer.ts:199). Lifecycle: `lifecycle.ts:61` `FACT_TABLES` includes `'citations'`, so `collect` deletes rows with the file version. Rows per citation: 1. Per-file limit: 200 (above). So **no comment text ever reaches SQLite; store growth is a function of mention count (capped at 200/file), not of the comment bound.**
- **Diagnostic.** A blanked comment is counted and emitted as info diagnostic `citation_comment_too_long` (extract.ts:818). `process.ts:257-262` reads `extracted.facts` only; `extracted.diagnostics` is never read, so **in the indexer the diagnostic is dropped** (grep: `diagnostics` in process.ts appears only for `commit.diagnostics`). The loss is silent in production; it is visible only to unit tests of `extractFileFacts`.

## (c) Measurements

### c1. Length of ADR-mentioning comments (comments the tags predicate would keep; ts/cts/mts/js/cjs/mjs/jsx, tracked, <= 2 MiB)

Script `tools/dist.mjs` (web-tree-sitter, the module WASM, the same regex as tags.scm:25).

| corpus | files parsed | comments (all) | ADR comments | p50 | p90 | p99 | p99.9 | max | > 4096 | > 8192 | > 16384 | > 32768 | > 65536 | > 131072 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| gsd-core 10ac3a7 | 1,689 | 142,964 | 2,846 | 81 | 1,434 | 4,615 | 15,742 | 17,881 | 38 | 11 | 1 | 0 | 0 | 0 |
| gsd-pi bb86b6c | 4,084 | 67,628 | 604 | 75 | 444 | 1,112 | 1,429 | 1,429 | 0 | 0 | 0 | 0 | 0 | 0 |

(gsd-core: 2,846 here vs the executor's 2,847, the difference is the one `.tsx` file no module claims. Max UTF-8 size of an ADR comment 17,970 bytes. All gsd-core outliers are `.cjs`/`.cts` file header blocks: `scripts/lint-phase-enumeration-drift.cjs` 17,881; `lint-state-field-drift.cjs` 15,758; `gsd-core/bin/gsd-tools.cjs` 15,742; `src/user-artifact-staging.cts` 13,546.) Sum of ADR comment text on gsd-core: 1.56 M units out of 14.1 M comment units; gsd-pi 0.10 M of 5.3 M. The longest comment of ANY kind in gsd-pi is 3,209.

### c2. Oracle disagreement by bound (the real `scripts/adr-citations-check.ts`, seed 7; 20-number sample = 1,173 oracle hits; all 79 numbers = 3,245)

| bound (UTF-16 units) | 20-number: agree / store_only / oracle_only | diff % (limit 2) | all 79: agree / store_only / oracle_only | diff % | store citations total |
|---|---|---|---|---|---|
| 4,096 | 1104 / 0 / 69 | 5.88 | 3132 / 0 / 113 | 3.48 | 3,141 |
| 8,192 | 1144 / 0 / 29 | 2.47 | 3203 / 0 / 42 | 1.29 | 3,212 |
| 16,384 | 1167 / 0 / 6 | 0.51 | 3237 / 0 / 8 | 0.25 | 3,246 |
| 32,768 | 1173 / 0 / 0 | 0.00 | 3244 / 0 / 1 | 0.03 | 3,253 |
| 65,536 | 1173 / 0 / 0 | 0.00 | 3244 / 0 / 1 | 0.03 | 3,253 |
| 131,072 | 1173 / 0 / 0 | 0.00 | 3244 / 0 / 1 | 0.03 | 3,253 |
| unbounded (2 MiB source cap) | 1173 / 0 / 0 | 0.00 | 3244 / 0 / 1 | 0.03 | 3,253 |

The one `oracle_only` at every bound >= 32,768 is `.opencode/plugins/gsd-statusline/tui.tsx:1` (ADR-5331): unclaimed extension, not a bound effect. The 4,096 and 65,536 rows reproduce the executor's numbers exactly. Notes: 16,384 already passes the 2 percent gate on this corpus even though one comment (17,881) is over it; the plan's own 20-sample gate (2%) first passes between 8,192 and 16,384; 32,768 is the smallest power of two with zero bound-caused disagreement. gsd-pi has no comment over 1,429, so it constrains nothing above 2,048.

### c3. Resource cost by bound

Full build of gsd-core through `composeHost` (`tools/build.mjs`, one run each; the pooled workers are threads, so RSS includes them):

| bound | build ms | peak RSS MB (sampled) | store bytes | `citations` table bytes (dbstat) | `citations_by_number` bytes | rows | by-number lookup avg ms (200 runs) |
|---|---|---|---|---|---|---|---|
| 4,096 | 6,237 | 636 | 38,092,800 | 90,112 | 45,056 | 3,137 | 0.194 |
| 65,536 | 6,633 | 644 | 38,023,168 | 94,208 | 45,056 | 3,249 | 0.217 |
| unbounded | 6,129 | 665 | 38,043,648 | 94,208 | 45,056 | 3,249 | 0.199 |

Store delta 4,096 -> 65,536 is +112 rows (about 4 KB, 0.01 percent of a 38 MB store); the whole citations table + index is 0.36 percent of the store. Differences in build time and RSS are inside run-to-run noise. WAL was 0 bytes after the build in every run (checkpointed on close).

### c4. Adversarial worst cases (one 2 MiB-class file, real engine + extractor, `tools/adv.mjs`; "run" = parse+query, "extract" = `extractFileFacts`; baseline process RSS about 115 MB)

| case | bound | run ms | extract ms | max RSS MB | citations | note |
|---|---|---|---|---|---|---|
| one 2 MiB comment of `ADR-1 ` x 349k | 4,096 / 65,536 | 34 | 0.3 | 115 | 0 | blanked, diagnostic only |
| same | unbounded | 35 | 35 | 230 | 200 | 349,525 draft objects built, then cut to 200 |
| one 2 MiB comment of distinct `ADR-n ` | 65,536 / unbounded | 34 / 35 | 0.3 / 21 | 131 / 203 | 0 / 200 | |
| 2 MiB near-miss soup (`ADR ADR- ADR# aDr aDR- ADR-x ADR #x`), `AAAA...`, `ADADAD...`, `ADR ` x, `ADR # ` x, `!ADR` x, `xADR-1` x | any | 36-44 | 0.3-0.6 | 113-125 | 0 | predicate rejects; no backtracking blow-up |
| `ADR-` + 2 M digits; `ADR-000..1`; `ADR-1 §` + 2 M letters; `ADR-1 §....` | unbounded | 35-38 | 4-8.5 | 116-118 | 0 / 1 / 1 / 1 | linear; digit run rejected (above 2^53), token detail clipped to 16 chars |
| 233,007 one-line comments `// ADR-1` (2 MiB) | 4,096 / 65,536 / unbounded | 352-383 | 136-148 | 477-543 | 200 | **bound-independent**; 233k captures cross the worker boundary |
| 87,378 `// ADR-1` + `function a(){}` pairs | 4,096 / 65,536 | 964 / 975 | 235 / 275 | 481 / 532 | 200 | worst file seen: about 1.2 s, 0.5 GB |
| 512 / 32 comments each just under the bound, filled with `ADR-1 ` | 4,096 / 65,536 / unbounded(1 MiB) | 30-31 | 58 / 37 / 19 | 233 / 219 / 179 | 200 | the bound does not change the number of mentions a file can hold: 2 MiB / 6 B = 349k either way |
| 2 MiB of non-ADR comments, 233k of them | any | 117 | 0.4 | 164 | 0 | predicate cost without any citation |
| 24 hostile 2 MiB files (6 of each shape above), whole build via Host | 4,096 | 2,033 | - | 1,219-1,279 | 400 | |
| same | 65,536 | 2,004-2,034 | - | 1,322-1,469 | 1,600 | about +100-200 MB (+8-15 percent) vs 4,096 |
| same | unbounded | 1,999 | - | 1,323 | 1,800 | |
| same 24 files with `ADR-` replaced by `XYZ-` | 65,536 | 1,819 | - | 793 | 0 | so the ADR path costs about 0.5 GB extra here, and only about 0.1-0.2 GB of it varies with the bound |

Micro-benchmark of `scanAdrMentions` and of the predicate regex alone (`tools/micro.mjs`, ns per UTF-16 unit): scan 1.2-3.7 ns/unit at 4,096 and 65,536, same at 2 MiB (7.3 only for the mention-dense `ADR-1 ` shape because of array growth); regex 0.00-0.59 ns/unit. Flat across three orders of magnitude of input size: **no quadratic or catastrophic behaviour found in either the scan or V8 irregexp for the predicate** (shapes: A-runs, AD-runs, `ADR `/`ADR-` runs, `!ADR`, `xADR-1`, `ADR # ` runs, 2 M digits).

Extrapolation (per-file extract, Host thread): typical file about microseconds (gsd-core's whole 1.56 M units of ADR comment = about 5 ms). Worst hostile 2 MiB file: about 1 s parse+query in the worker and up to about 275 ms in the Host thread. 100,000 files: if all were hostile 2 MiB files (200 GB of source) the Host-thread extract time would be about 7.6 hours, 100 percent set by the 2 MiB source cap and the count of comments, not by the comment bound; on a realistic 100k-file repo (gsd-core ratio: 1.56 M ADR-comment units per 1,689 files) it is about 0.3 s of scan in total.

Store growth under a hostile repo (`tools/mkrepo.mjs`, 3,000 files, each with a 300-mention header of about 3.9 KB, i.e. under even the 4,096 bound): 600,000 rows, store 28.2 MB vs 2.8 MB for 3,000 plain files; `citations` 17.1 MB + index 8.1 MB (about 42 B/row all in, 9.4 KB/file); build 3.8 s vs 1.9 s; `WHERE number = ?` lookup 0.08 ms. Extrapolated to 100k files: about 0.94 GB, bounded by `MAX_CITATIONS_PER_FILE` and unaffected by the comment bound (a 4,096 bound does not stop it).

### c5. Boundary, CRLF, truncation (`adv.mjs bm1/b0/bp1/straddle/crlf`, B = 65,536)

| input | result |
|---|---|
| comment of B-1 units, `ADR-123` at the end | kept, 123 at col 65,525 |
| exactly B units | kept, 123 |
| B+1 units | blanked, no citation, info diagnostic `citation_comment_too_long` |
| `ADR-123` whose last digit is the B-th unit | kept, 123 (comment is B-1) |
| CRLF block comment, ADR on 4th physical line | line index 3, col 1: correct (rows count LF only, tree-sitter agrees) |
| 65,536 CJK units (196,602 bytes) | kept, UTF-16 unit rule confirmed |
| 131k astral units | blanked |

## (d) Cases

**Strongest case for keeping 4,096.** It is the number the plan, the threat model (T-03-242 "4,096-unit bound") and the tests were written against, and it keeps the copied-text volume small per capture. But the measurements remove the support: the bound is not what limits CPU, memory or storage (c3, c4), and the gate the plan itself set (2 percent) fails at 4,096 (5.88 percent, 3.48 percent on all numbers). A 4,096 bound also silently deletes the citations of the most informative comments: file headers listing many ADRs. Verdict: not defensible.

**Strongest case for removing the bound entirely.** Any bound is a silent false-negative source with no wrong-answer protection (the diagnostic is discarded, process.ts:257-262), the true resource limiters already exist (2 MiB `sourceBytes`, 200 citations per file, linear scan), and measured results with the unbounded setting are equal or better (zero bound-caused disagreement, build time and store size unchanged, c2/c3). Unbounded plus an early exit at 200 mentions is the cheapest hostile case measured (1 ms, 115 MB vs 37 ms, 230 MB for the 2 MiB `ADR-1 ` comment; see the prototype below). Weakness: removing it means the capture text of a 2 MiB comment crosses the worker boundary, and the `''`-means-too-long convention disappears, which is the one place the engine is allowed to emit large text; the 256 default exists so "a whole function body must not be copied per capture" (normalize.ts:35).

**Strongest case against 65,536.** (1) It is not derived from a limit; it is a round number 3.7x the single longest comment on one corpus (17,881), and gsd-pi's longest is 1,429. 32,768 gives the same results on both corpora (c2). (2) It is not what bounds anything: a file can hold 349k mentions or 233k comment captures at any bound (c4); the measured effect of 65,536 vs 4,096 on a hostile build is only +100-200 MB RSS (8-15 percent). (3) Unit mismatch with the other limits (bytes: 2 MiB; units: 256, 65,536): the same value allows 196,608 bytes of CJK. (4) Silent drop above it, with the diagnostic dropped by the indexer. (5) It loosened a number the plan wrote (4,096) and the limits.ts header says loosening needs a person's approval, but it is not in 03-CONSTANTS.md (which is `Status: Approved` and does list the sibling size bound `adr.maxCitationsPerFile`). (6) Its stated protection ("the captures of one file together hold no more than the source (2 MiB), and the scan is linear", limits.ts:25-27) is true but would be equally true of any value, so the comment gives the wrong reason for the number.

## (e) Bugs and defects found

1. **No truncation bug today.** The bound blanks, it never clips, so the "ADR-12|3 becomes ADR-12" hazard cannot occur: tested at B-1, B, B+1 and with the number straddling the bound (c5). It WOULD occur if anyone "improves" the rule into a prefix clip: `scanAdrMentions(text.slice(0, 65539))` on `... ADR-123 §12` returns number **1** instead of 123 (`tools/clip.mjs`; a cut before the first digit gives none, any cut after the first digit of a longer number gives a wrong integer). A test should forbid clipping. If a prefix scan is ever added it must drop a trailing mention whose digit/token run touches the cut.
2. **Silent loss** (defect, medium): over-bound comments produce a diagnostic that `src/indexer/process.ts:257-262` never reads (`extracted.diagnostics` unused). Nothing in `status`/`explain` can tell a user why a citation is missing. The same holds when the 200 cap truncates (no diagnostic at all).
3. **Cap applied after the work** (defect, low-medium): `collectCitationDrafts` creates a draft for every mention and every comment before `slice(0, 200)`. Measured cost on a hostile file: 349k drafts, +115 MB and 35 ms Host-thread time for a single 2 MiB comment; with a 4,096 or 65,536 bound the same total volume is reachable through many comments (`denseUnder`: 58 / 37 ms, 195 / 177 MB). Prototype (scratch `work2`: `scanAdrMentions(text, probe, max)` stops at `max`, and the outer loop breaks once 200 drafts exist, valid because captures arrive sorted by position, `normalize.ts:69`): extract 37 -> 1 ms, RSS 230 -> 115 MB (2 MiB comment); 128 -> 31 ms (233k line comments); 17 -> 1 ms, 189 -> 114 MB (dense under-bound comments). The remaining hostile cost (about 0.5 GB for 233k captures) is in the worker/pool result transfer, which the bound cannot reduce. I did not verify that the first 200 citations are byte-identical to the unpatched output beyond the spot checks (the printed first three match); a real change needs a test.
4. **Host-thread blocking**: scan and `attachCitations` run synchronously on the Host thread (modules.ts:108). Worst measured 275 ms per hostile file, mostly `attachCitations`/draft building, not the bound.

## (f) Recommendation

1. **Value and unit.** Keep a bound, in UTF-16 code units (the engine's native unit; do not switch to bytes, which tree-sitter does not report here), at **32,768**. Rationale: zero bound-caused disagreement on both pinned corpora (c2), 1.83x the longest real comment (17,881) and 22x gsd-pi's; halves the 65,536 worst-case text per capture; the results are flat from 32,768 up, so 65,536 buys nothing measurable. If a person prefers not to re-open the executor's number, 65,536 is also safe: its measured downside is +100-200 MB on a deliberately hostile 48 MB repo and nothing on real corpora. Either is defensible; do not go below 16,384 (misses real header blocks) and do not remove the bound (it is the only thing that keeps `''`-means-oversize meaningful and caps one capture's transfer).
2. **Reject vs truncate.** Keep **reject (blank the whole comment)**, never truncate: truncation can create wrong integers (e). Add the missing signal: surface `citation_comment_too_long` (and a cap-reached count) through the indexer into the file's diagnostics/status so a dropped header is discoverable.
3. **Chunking / streaming.** Not warranted: scan cost is 1-4 ns/unit, linear, and a 2 MiB text is scanned in 15 ms; no chunk boundary logic (and its straddle bug) is needed.
4. **Per-file budget.** Yes, but on the right quantity: stop collecting at `MAX_CITATIONS_PER_FILE` (early exit in `collectCitationDrafts` and a `max` argument on `scanAdrMentions`) instead of cutting after the fact. This is the change that actually bounds hostile CPU/memory (prototype above); the comment text bound does not. No separate "total text scanned per file" budget is needed beyond the 2 MiB source cap.
5. **Huge generated headers.** Over-bound comments are skipped with a diagnostic; that is acceptable because a >32 KiB comment is not an ADR citation site in any corpus measured, and the hostile case is bounded by (4).
6. **03-CONSTANTS.md.** Register it, as `grammar.commentTextChars` (or `adr.commentTextChars`), consumed by 03-24, basis "gsd-core 10ac3a7: max ADR comment 17,881; 16,384 leaves 8 of 3,245 oracle citations unmatched; 32,768 leaves 0; gsd-pi max 1,429". Reason: the limits.ts header requires a person's approval to loosen a bound, the value differs from the plan's 4,096 by 8x (32,768) or 16x (65,536), and the sibling size bound `adr.maxCitationsPerFile` is already a row. The plan's reason for exclusion ("not a timeout, queue bound or gate threshold") is contradicted by the file's own purpose statement, which includes size-shaped constants. The Phase 1 `GRAMMAR_LIMITS` are not rows in 02-CONSTANTS.md (grep: none), so this is a convention judgement, flagged for the user.
7. **How to pin by test** (all in `extract.test.ts` / `grammar-engine.test.ts`, referencing the constant, never a literal): (i) at `B-1`, `B` a comment's citation is stored, at `B+1` it is blanked and counted (already partly there; add the `B` case); (ii) a comment where `ADR-123` straddles `B` yields either 123 or nothing, never 1 or 12; (iii) a floor test: `GRAMMAR_LIMITS.commentTextChars >= 2 * MAX_OBSERVED` where the observed 17,881 and a note citing 10ac3a7 are in the test, so shrinking it fails; (iv) hostile bound tests: 2 MiB comment of `ADR-1 ` returns exactly 200 citations and the `probe.steps`/draft count is O(200), (after the early-exit change); 233k one-line comments return 200 and the first 200 equal the first 200 of an uncapped scan; (v) UTF-16: a comment of B CJK units is kept though it is 3B bytes; (vi) `scripts/adr-citations-check.ts` stays the corpus guard (2 percent limit), which already catches a bound that is too small.

## (g) Confidence and what I could not measure

- High: the oracle table (reproduced the executor's 4,096 and 65,536 numbers exactly), comment-length distribution, store schema/size, linear scan behaviour, the all-or-nothing semantics, and the discarded diagnostic (code read).
- Medium: RSS numbers (single runs for most rows; the 24-file hostile build was repeated three times for 4,096 and 65,536 and ranged 1,219-1,279 and 1,322-1,469 MB). The "ADR path costs 0.5 GB" figure compares one `XYZ` build with the ADR builds; pool concurrency makes peak RSS noisy. Build times use the macOS arm64 machine only; Windows/Linux were not run.
- Not measured: real 100k-file repo (extrapolated from per-file numbers); structured-clone cost of large capture text separately from parse (only end-to-end); Host event-loop blocking latency under concurrent MCP queries; worker `resourceLimits` (grep found none configured, so a worker has default heap limits and OOM behaviour with 233k captures was not provoked beyond 0.5 GB); `.tsx`, Python or Swift comment shapes; query latency for a pathological number cited in 600k rows (only `WHERE number = ?` at 120 rows/number was timed: 0.08 ms; a single number with 600k rows would be a result-size issue for the 03-28 query plan, independent of this constant); V8 irregexp versions other than Node 26.11.1's (the predicate has no nested quantifier, so risk is low).
- Not verified: that early-exit output is identical to the current top-200 in all cases (spot-checked only), and the claim that 32,768 is safe on corpora other than the two pinned ones.

## Where research notes live in this repo

- Project-level topic notes: `/Users/trekkie/projects/gsd-atlas/.planning/research/*.md` (UPPER-KEBAB names: `STACK.md`, `PITFALLS.md`, `MCP-HOST-CONFIGS.md`, `MCP-HOST-LIVE-CHECK.md`; committed as `docs(02): add MCP host config research note`).
- Phase research: `/Users/trekkie/projects/gsd-atlas/.planning/phases/03-typescript-module-and-mvp-eval/03-RESEARCH.md` (one per phase; constants in `03-CONSTANTS.md`, same dir).
- Suggested placement: `/Users/trekkie/projects/gsd-atlas/.planning/research/COMMENT-BOUND.md`. `docs/` holds product docs (DESIGN, DESIGN-REVIEW, ADRs, `docs/eval`), not research notes.
