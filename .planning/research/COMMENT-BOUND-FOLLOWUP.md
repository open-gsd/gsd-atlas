# Follow-up review of plan 03-24 (executor deviations), 2026-10-18

Repo: /Users/trekkie/projects/gsd-atlas, main at dd9343f (03-24 merged: f15a089, 5f108cd, 6ccff2f, 6d9aaca).
Read-only. All scratch scripts are in this folder (fuzz-synth.ts, ref-extract.ts, mut*-extract.ts, real-corpus.ts, real-synth.ts, hostile.ts, hostile-real.ts, lying.ts, floor.ts, astral.ts, e2e/). Filing: this note belongs next to COMMENT-BOUND.md in /Users/trekkie/projects/gsd-atlas/.planning/research/ (the folder also holds ARCHITECTURE.md, FEATURES.md, PITFALLS.md, STACK.md, SUMMARY.md, MCP-HOST-*.md); suggested name `.planning/research/COMMENT-BOUND-FOLLOWUP.md`.

## Verdicts

| # | Item | Verdict |
|---|------|---------|
| 1 | Floor test at 1.8x | CHANGE the test, KEEP the bound 32,768. The 1.8 factor is fitted to the approved number and adds nothing the equality test does not already pin. |
| 2 | Diagnostic visibility | CHANGE. The signal is real but is lost on the first no-op build, never reaches the CLI/Host envelope, and nothing persisted lets a query answer see it. Needs a persisted per-file flag and three read surfaces. Owner: 03-28 (with a small piece in 03-29). Zero impact on the 03-35 scored run on the pinned gsd-core. |
| 3 | Early exit | ACCEPT. Output identical in every attempt to break it with the real engine. Two caveats: the non-overlap proof assumes `text` fits `span` (true for the engine, false for scripted captures), and the hostile-module path (overlapping captures) is not protected, but a one-line change fixes that exactly. `scanProbe` leak: acceptable, tag it. |

---

## 1. Floor test (1.8x)

### Findings

- The test is `src/grammar-engine/extract.test.ts:831-837`: `floor = 1.8 * LONGEST_OBSERVED_ADR_COMMENT` with the literal `17_881` at line 745, plus `bound > 17_881`. The comment at 832-833 admits the factor is "the largest round margin it [32,768] has", so the factor was chosen to make the approved number pass, not derived from a requirement.
- The same file pins the bound by equality in the test before it (`assert.equal(GRAMMAR_LIMITS.commentTextChars, 32_768)`, line 822) and against 03-CONSTANTS.md (line 823). Anyone lowering the bound must edit that test, so the floor test cannot catch a change the equality test does not catch first. It is redundant as a ratchet.
- It does NOT fail when the corpus pin changes: 17,881 is a literal and the test never reads the corpus. If gsd-core is re-pinned and a longer header block appears, nothing fails until someone runs `scripts/adr-citations-check.ts` (not part of `npm test`). The test's own comment ("a corpus whose longest comment moves past the bound") overstates what it does.
- The invariant that matters is "the longest real comment we know of is kept and its citation stored", which is testable functionally. Measured with the real engine (floor.ts): a 17,881-unit comment ending in `ADR-4321` is kept (citation 4321); at 32,769 and 35,762 units it is blanked and `citation_comment_too_long` fires. The existing B-1/B/B+1 tests (lines 839-861) already pin the boundary, but none pins "a comment of the observed maximum survives".
- Brittleness the executor did not mention: the test reads `.planning/phases/03-typescript-module-and-mvp-eval/03-CONSTANTS.md` (line 754). When the phase is archived at milestone completion, or `.planning/` is absent in a packaged or sparse checkout, `npm test` fails for a reason unrelated to the code.
- Distribution (COMMENT-BOUND.md:28-29, measured on gsd-core 10ac3a7 and gsd-pi bb86b6c): ADR-mentioning comments p50 81, p99 4,615, p99.9 15,742, max 17,881 (gsd-core); max 1,429 (gsd-pi). The 12 largest are `.cjs`/`.cts` header blocks. Oracle disagreement by bound (lines 36-43): 16,384 gives 8 of 3,245 missed; 32,768 and every larger bound give the same 1 (an unclaimed `.tsx`). Cost by bound (lines 47-75): store, build time and RSS are flat on real corpora; only the deliberately hostile build moves, +100-200 MB (8-15 percent) at 65,536 versus 4,096.
- Re-measured today on the pinned checkout (scratch corpus gsd-core-K2nv2O at 10ac3a7, 1,689 TS/JS files, real engine): 0 files produce `citation_comment_too_long`, 0 files reach the 200-citation cap.

### Answers to the specific questions

- Sound or brittle: brittle in the wrong way (couples to a planning file and a magic factor) and weak in the right way (does not follow the corpus).
- Defensible margin: the data gives 1.83x on one corpus whose tail is a handful of header blocks, and 22.9x on the other. Beyond "exceeds the maximum observed" there is no derivable margin; the real safety net is the corpus gate (2 percent limit) plus a visible drop (item 2). A multiple of 2 is not required by anything measured.
- Raise to 35,762+? No. The only round values above are 36,864, 40,960 and 65,536. 65,536 was the executor's original and the user chose to move away from it; results are identical to 32,768 on both corpora and cost is flat, so raising buys nothing measurable while doubling worst-case text per hostile capture. Keep 32,768.

### Recommended change

1. In `src/grammar-engine/extract.test.ts` replace the 1.8x floor test with two checks and delete the factor:
   - `assert.ok(GRAMMAR_LIMITS.commentTextChars > LONGEST_OBSERVED_ADR_COMMENT)` (keep the provenance comment: gsd-core 10ac3a7, `scripts/lint-phase-enumeration-drift.cjs`).
   - A functional case through the real engine: a comment of exactly `LONGEST_OBSERVED_ADR_COMMENT` units ending in `ADR-4321` yields citation 4321 and no diagnostic. The same shape already exists as `lineCommentOfLength`.
2. Make `constantValue()` tolerant of a moved registry: if the file does not exist, `t.skip('03-CONSTANTS.md not present')` for the registry assertions only. Keep the equality assertion against `GRAMMAR_LIMITS`.
3. Honest wording for 03-CONSTANTS.md row `adr.maxCommentUnits` (replace the evidence clause): "32768 UTF-16 code units, skip not clip. Basis: on gsd-core 10ac3a7 the longest ADR-mentioning comment is 17,881 units (the bound is 1.83 times that, an observed headroom and not a derived requirement); on gsd-pi bb86b6c the longest is 1,429. 16,384 misses 8 of 3,245 oracle citations; 32,768 and above miss none attributable to the bound. If the corpus pin changes, rerun `scripts/adr-citations-check.ts --sample 1000`; a result above the 2 percent limit means the bound is too small. A bound is not what limits hostile cost (2 MiB source cap, 200 citations per file, linear scan)."
4. Add to the 03-24 SUMMARY deviations a sentence replacing "1.8 times": "the floor test requires the bound to exceed the longest observed comment and keeps that comment through the real engine; it does not use a multiple".

Owner: a fix-up commit on 03-24 (test and registry text only). Effort: 20 minutes.

---

## 2. Visibility of `citation_comment_too_long`

### Trace (code and measured)

1. The extractor emits one per-file info diagnostic with the count of blanked comments: `src/grammar-engine/extract.ts:850-858`. It is returned in `ExtractResult.diagnostics` and goes nowhere persistent.
2. `src/indexer/process.ts:269-271` reduces it to a boolean on the `PathResult` of a path with outcome `parsed` (`commentsTooLong`, line 125). The diagnostic itself and the count are dropped. A `linked` path (same content hash already stored) never carries the flag.
3. The only reader of the flag is `reconcileWorktree`, `src/indexer/reconcile.ts:168-191`: it counts flagged results of THIS run and adds one aggregated note to `ReconcileReport.skipped`. `codegraph query commentsTooLong` finds no other consumer. The watch path (`submit`, `ensureFresh`) and `Indexer.reconcile()` never aggregate it: `ReconcileOutcome` (`src/indexer/types.ts:140-146`) and `IndexerStatus` (types.ts:162-179) have no field for it, and `Indexer.reconcile` returns no diagnostics.
4. `runBuild` copies `skipped` into `BuildResult` (`src/indexer/build.ts:37`). The Tenant then publishes `buildData` (`src/tenant/create.ts:95-107`) with `skipped: result.skipped.length` and returns `okEnvelope(BUILD_SCHEMA, buildData(...))` with NO diagnostics (create.ts:705). The CLI prints exactly that envelope.
5. Measured end to end (scratch e2e/, CLI `src/bin/gsd-atlas.ts build --repo`, isolated store, a git repo with a 39,236-unit ADR header block and one short citing file):
   - build 1: `parsed 2, skipped 2, diagnostics []` (one of the two skips is the unclaimed `.md`; the other is our note, unnamed).
   - build 2, nothing changed: `parsed 0, linked 2, skipped 1, diagnostics []`. The note is gone.
   - build 3 after adding an unrelated file: `parsed 1, linked 2, skipped 1`. Still gone.
   - `health` (atlas_status): `health ok`, `reasons []`, no field about citations. `src/query/status.ts:20` has a closed list of six health reasons; none fits.
   - Store after build: only `src_ok.ts` has a `citations` row for ADR-7. The `files` table columns are id, hash, module, grammar_version, nsym, nref, error_bytes, total_bytes, state, stale, retired_at, first_seen, last_seen: nothing records the skip. There is no persisted trace of it at all; it cannot be recomputed without re-parsing.
   - `refs ADR-7 --kind adr` today answers "No definition matched" (the adr query surface does not exist until 03-28), so there is no live query that could be wrong yet. Once 03-28 lands, "which code cites ADR-7" returns the short file only, with `diagnostics []`, `degraded` absent: confidently incomplete.
6. `degraded` codes (`src/facts/degraded.ts:16-31`, fourteen) are a closed, additive vocabulary also asserted by the skill test (03-33) and the doc test (03-34, "the fourteen"). None describes missing facts. `explain` (03-26) explains facts that exist, not facts that were dropped. `gsd-atlas diagnostics` is the user-consented reporting feature (03-32/03-35 context), not a visibility surface for a build.

So: after any build that parses no file, after any watch or `ensureFresh` update, and always in the CLI/Host envelope, the signal is gone, and no query answer carries it. The text of the 03-24 SUMMARY ("Known limit of the report") is accurate but understates it: even the first build's note never reaches the user.

### Risk if left as is

- On the pinned gsd-core the risk to the eval is zero (0 flagged files, 0 files at the 200 cap, measured today), so 03-35 is not endangered.
- Product risk: any repo with a header block over 32,768 units, or a file with more than 200 mentions (the cap truncates silently too, `file-facts.ts:105`; same class), returns incomplete ADR answers with `diagnostics: []`. This is the failure mode the project exists to avoid ("correct, cited answers"), and the Phase 3 abstain handling (03-28 `unresolved` status = "not found") would turn a dropped citation into a false "nobody cites ADR-N".

### Minimal design

1. Persist (store): a per-file-version fact `FileFacts.citationGaps?: { skippedComments: number; capped: boolean }` (absent when 0/false, like `citations`, so Phase 2 shapes round-trip). Extractor sets it from `cited.tooLong` and from "more than 200 mentions found". Stored in one nullable column on `files` or a one-row `citation_gaps` table (CREATE IF NOT EXISTS, the 02-11 and 03-20 precedent for additive derived data). Because it is keyed by content hash it survives incremental runs and applies to every path that links to the same hash. Schema stays "unreleased version 2" (schema.ts:6-12 documents the precedent); if a column is chosen, bump to 3 now, while it costs one dev rebuild. The `Reader` exposes a count: files in the overlay with a gap, via the existing `overlay_files` join.
2. Surface on ADR answers (03-28): any `kind: adr` answer from `code_refs`/`code_find`, and `code_context` citations, adds one fixed-text info diagnostic `citation_comment_too_long` (count of flagged files in the worktree overlay, no paths) when the count is above zero, and for an `unresolved` ADR (no citations found) also says citations may be missing. Do NOT add a 15th degraded code: it would reopen the mcp-contract amendment and the fourteen-code assertions of 03-33 and 03-34. The Tenant already has this pattern (`explained()`, create.ts:294-304). If a degraded code is preferred later, `stale`-style reuse is wrong; an additive code is a separate decision.
3. Status: add `citations: { filesWithGaps: number }` to the `atlas_status` snapshot (`src/query/status.ts` StatusSnapshot, `src/tenant/status-port.ts`). Do not add a health reason (it would flip `health` to degraded for a benign repo). 03-34 documents the new field.
4. Build envelope: keep the documented `data` of `gsd-atlas.build/1` unchanged (`docs/reference/cli.md:178` lists `skipped` as a count) and fill the existing, currently always-empty envelope `diagnostics` array with the pathless aggregated notes of `BuildResult.skipped` (`emit_output_not_indexed`, `citation_comment_too_long`), filtering out any diagnostic that has a `subject`. `buildData` states "counts only, so no repository path or text reaches the envelope"; the aggregated notes honour that. The tutorial example at `docs/tutorials/index-and-ask.md:103` shows `"diagnostics":[]` for a clean build and stays true. Build now reports the note on EVERY build because the count comes from the persisted flag (see below), not from the parsed set.
5. Make the build note independent of what was parsed: compute `commentFiles` in `reconcileWorktree` from the persisted count (Reader) instead of `results.filter(commentsTooLong)`. Then a no-op build repeats it and `commentsTooLong` on `PathResult` can be deleted.

Which later plan absorbs it:
- 03-29 (precise eager resolve; already specifies "a `resolver_timeout` note in the diagnostics" of the build result, line 127 of its PLAN, and touches `src/tenant/create.ts` build): step 4 and 5 (envelope diagnostics from `BuildResult.skipped`, count from the store). Effort 1 hour inside that plan.
- 03-28 (ADR resolution; its files already include `src/fact-store/{types,reader,snapshot,provenance}.ts`, `src/tenant/create.ts`, `src/query/{find,refs,context,adr}.ts`): step 1 (reader count), step 2 (diagnostic on adr answers), step 3 (status field). Its own must_have "MUST NOT drop a citation because its ADR file is missing" and the `unresolved` abstain edge (lines 56-57) are where the false "not found" would arise. The extractor and writer part of step 1 (`extract.ts`, `file-facts.ts`, `schema.ts`, `writer.ts`, `reader.ts`, `lifecycle.ts`) is not in 03-28's file list; add it as Task 0 of 03-28, or as a small plan 03-24b before it. Effort 3 to 4 hours total.
- 03-26 (explain): optionally mention a file's gap in a `cit/` or `sym/` explanation; not required.
- 03-33/03-34: document the diagnostic code and the status field (the doc test reads degraded codes from source, so a diagnostic code needs a separate list entry if tested).

Before 03-35: not required (0 flagged on the pinned corpus), but 03-28 must land before the scored run anyway since adr questions need it. After 03-35: nothing. If the scored run's adr-citers answers are compared to the oracle, the only checkable risk is the 200-cap (none) and header blocks (none).

---

## 3. Early exit

### What the code does

`collectCitationDrafts` (`src/grammar-engine/extract.ts:332-391`): readable comment captures are sorted by (start, end); adjacent pairs are tested for `next.start >= prev.end`; if all pass, drafts are built from comments in order and the loop stops at 200, with `scanAdrMentions(text, probe, cap - drafts.length)` stopping inside the comment; otherwise cap is infinity (full scan, then `attachCitations` sorts and slices to 200, line 405-409).

### Soundness argument (checked)

- Adjacent non-overlap in start order implies global non-overlap: if capture A overlapped a later capture C, then any capture B between them in start order has `B.start <= C.start < A.end`, so (A, B) is already adjacent-overlapping or B itself is the offender. Hence the adjacent test is sufficient.
- With disjoint comments sorted by start, all mentions of an earlier comment sort before all mentions of a later one (a mention lies inside its comment), and within one comment mentions are strictly increasing. So the first 200 in iteration order are exactly the first 200 of the global sort of `attachCitations` (key: start, end, number). No ties are possible in this branch.
- Blanked comments (`text === ''`) are counted in the first loop before any exit (line 344-351), so the count after the cap is correct. Verified by the test at extract.test.ts:967.

### Attempts to break it (all against `ref-extract.ts`, a copy of extract.ts with the early exit removed: `cap = Infinity`; full `JSON.stringify` of `{facts, diagnostics}` compared)

| Attack | Result |
|---|---|
| 42,000 synthetic extractor runs: 7 shapes (disjoint one-per-line, few large comments full of mentions, overlapping/nested/identical, outer comment with 100 inner captures, random unrelated spans, adjacent end==start, overlapping big comments of 150-400 mentions), counts around 195-205, 250, 400, token soup with `\n`, `\r\n`, astral characters, `ADR-0`, 18-digit numbers, `§` details, `quadr-5`, blanked comments, random definitions so `enclosing` varies, arrival order sorted, reversed and shuffled | 0 divergences (seeds 1-3: 18,000 runs over 6 shapes; seeds 11-13: 24,000 runs over 7 shapes) |
| Mutation check of the fuzzer: early exit forced on even when overlapping (`mut-extract.ts`) | caught: 1,678 of 4,000 diverge |
| Mutation: per-capture max of 150 in the slow path (`mut3`) | caught only after adding shape 6 (overlapping 150-400-mention comments); my first fuzzer MISSED it (0 of 3,000). Recorded as a failed first attempt; the final fuzzer does catch it (113 of 4,000) |
| Real engine, real gsd-core 10ac3a7, all 1,689 TS/JS files (real-corpus.ts) | 0 divergences; 820 files with citations; 0 files overlap; 0 files at 200 (the early exit never triggers on real data, so this run proves the normal path only) |
| Real engine, 800 synthetic sources (real-synth.ts): JSDoc inside classes, trailing comments, unterminated nested `/*`, strings/templates/regex containing `// ADR`, JSX comments, CRLF, emoji, `<!--`, shebang, `/**/ADR-1/**/` runs, 40-line header blocks; 514 of them reach the 200 cap | 0 divergences, 0 files with overlapping comment captures |
| Astral and CRLF columns through the real engine (astral.ts) | columns are UTF-16 and match `line.slice(col)`; rows count LF only |
| Comments straddling the bound, ties at exactly 200, repeated numbers | covered by the shape-0/5 generators (199/200/201 captures, `ADR-1` repeated) and by the repo tests (extract.test.ts:839-979); 0 divergences |
| Spans narrower than text ("lying spans", lying.ts) | DIVERGES: two scripted captures, A span `[0,0]-[0,5]` with 250 mentions of text, B span `[0,5]-[0,10]` with 5 mentions: early exit keeps the first 200 mentions of A only, the reference ranks B's five mentions (which sit at columns inside A's overrun text) among the first 200, so the two outputs differ (printed: equal false). Unreachable with the real engine: `toCapture` (`src/grammar-engine/normalize.ts:37`) takes `text` as `source.slice(node.startIndex, node.endIndex)` of the same node as the span. Reachable only with the fake engine or a scripted test. |

### Is "identical to the old post-hoc cap" true?

Yes under the invariant "text is the source slice of the span" (always true for the engine); proven by argument and by the runs above. It is not true for captures whose text is longer than their span; that is an unchecked precondition, not a bug today.

### Hostile input: does the early exit survive?

- Real grammar, real engine: comment nodes are tree nodes and never overlap (0 overlaps in 1,689 + 800 files), so a hostile REPOSITORY TEXT cannot force the slow path. Measured on the 2 MiB hostile files (hostile-real.ts, extract stage only; the engine run is unchanged):
  - 233,016 one-line `// ADR-1` comments: extract 39 ms (early exit) versus 122 ms (reference); max RSS 416 MB vs 453 MB; dominated by the 233k capture objects the engine already made (engine 311 ms).
  - 64 comments of 32,766 units full of mentions: 1 ms vs 34 ms; RSS 68 MB vs 195 MB.
  - one 2 MiB comment: blanked (over bound), 0 ms, 66 MB, `citation_comment_too_long`.
- A REPO-SUPPLIED MODULE is in the threat model (`.gsd-atlas/languages/<name>/` has highest precedence, `src/lang/registry.ts:22-25,126-129`; docs/PRD.md:404 "Untrusted repos and modules") and controls the query. It can capture the same comment through K patterns, or capture non-comment nodes under the name `comment`, making captures overlap and forcing the full path. Scripted measurement (hostile.ts, extract stage only), early exit defeated:
  - 64 big comments x K=10 (640 captures): 299 ms, 773 MB RSS (reference 327 ms, 750 MB).
  - 233k lines x K=10 (2.33 M captures): 1,378 ms, 1,214 MB.
  - K is bounded only by the 256 KiB query size, so the extract stage is unbounded in practice. This is not a regression (identical to before 03-24's fix) but it means the early exit is not a DoS boundary for untrusted modules.
- Cheap, exact hardening found (tested): always bound the per-capture scan by 200, also in the overlapping case: a capture can never contribute more than its first 200 mentions to the global top 200. Replace `scanAdrMentions(capture.text, probe, cap - drafts.length)` by `scanAdrMentions(capture.text, probe, disjoint ? cap - drafts.length : MAX_CITATIONS_PER_FILE)` (`mut2-extract.ts`). Fuzz: 24,000 runs, 0 divergences (and the discriminating fuzzer rejects the 150 variant). Effect on the overlap case: 64 big comments x K=10 goes from 299 ms/773 MB to 23 ms/94 MB. Capture-count cost (233k x K) is unchanged because it is created by the engine: the real control for untrusted modules is a per-run cap on captures and total capture text in the engine (`src/grammar-engine/limits.ts` has none; `matchLimitMax` bounds in-progress matches only). That is outside 03-24; log it for the engine or Phase 4 hardening.

### `scanProbe` surface

- `ExtractInput.scanProbe?` (`extract.ts:82`) is a type member of an exported interface; `ExtractInput` is re-exported from `src/grammar-engine/index.ts:17`. `ScanProbe` and `scanAdrMentions` themselves are not re-exported from the index. The compiled `dist/grammar-engine/extract.d.ts` contains `scanProbe`/`ScanProbe`. The package has no `exports` map (only `bin`), so dist files are deep-importable, but nothing is documented: no hit in docs/ or schemas/. No production caller passes it (`src/indexer/modules.ts` does not mention it).
- Verdict: accept. It follows the repo's existing convention ("TEST HOOK ... production omits it", `src/tenant/types.ts:79,90,92`). Optional polish: add `/** @internal */` to the field and the interface, or strip it with `stripInternal`; effort 5 minutes. Not needed before 03-35.

### Recommended changes (item 3)

1. One line in `collectCitationDrafts` (above) plus two tests in extract.test.ts: (a) "overlapping captures: each capture scans at most 200 mentions" using `scanProbe` with K=10 identical big comments, `steps <= 12 * 200 * K`; (b) the existing overlap reference comparison extended to captures with 150-400 mentions each (the current test at lines 942-951 uses 150-mention comments, which is exactly the size that hid the 150 mutant in my first fuzzer).
2. Add a precondition guard so the proof does not rest on an unstated assumption: in the disjointness loop also require that the capture's text fits its span (single-line: `text.length === endColumn - startColumn` and no `\n`; multi-line: length after the last `\n` equals `endColumn`); a capture that fails takes the full path. O(length) native string search, only for captures in the pre-check. Low priority (unreachable with the engine), but it makes "identical to the post-hoc cap" unconditional for the fake engine and scripted tests.
3. Keep the committed tests; they are good (reference comparison, reversed and shuffled order, step probe bounds). Add the tie case "exactly 200 mentions, then a blanked comment" if not present (present at 967-979 for 400).

Owner: fix-up commit on 03-24. Effort: 1 hour.

---

## Prioritised change list

| Priority | Change | Plan | Effort | When |
|---|---|---|---|---|
| P1 | Persist per-file citation gaps (comment skipped, 200 cap) in the store; read count in Reader | 03-28 Task 0 (or 03-24b) | 2 h | before 03-28 merges; before 03-35 only because 03-28 is before 03-35 |
| P1 | Diagnostic on `kind: adr` answers (code_refs, code_find, code_context), no new degraded code; status field `citations.filesWithGaps` | 03-28 | 1.5 h | before 03-35 (same plan) |
| P2 | Build envelope `diagnostics` carries the pathless aggregated notes; count from the store so a no-op build repeats it; drop `PathResult.commentsTooLong` | 03-29 | 1 h | before 03-35 |
| P2 | Replace the 1.8x floor test with "bound > longest observed" and "longest observed is kept through the real engine"; skip registry assertions when 03-CONSTANTS.md is absent; reword the registry row | 03-24 fix-up | 20 min | before 03-35 (test hygiene, no behaviour) |
| P2 | Per-capture scan bound of 200 in the overlap path, with tests; text-fits-span guard | 03-24 fix-up | 1 h | before 03-35 (trivial and exact; avoids a documented 773 MB path) |
| P3 | `@internal` on `scanProbe` / `ScanProbe` | 03-24 fix-up | 5 min | any time |
| P3 | Engine-level cap on captures and total capture text per run (untrusted modules); outside this plan | Phase 4 hardening backlog | 1 day | after 03-35 |
| P3 | Document the new diagnostic/status field in docs/reference (03-34 reads degraded codes from source; add the diagnostic code to the list the doc test checks) | 03-34 | 20 min | with 03-34 |

Not recommended: raising the bound to 35,762+ or 65,536; adding a 15th degraded code; clipping instead of skipping.

## Files and lines cited

- /Users/trekkie/projects/gsd-atlas/src/grammar-engine/extract.ts:82, 91-92, 237-313, 321-391, 400-424, 777-874
- /Users/trekkie/projects/gsd-atlas/src/grammar-engine/limits.ts:16-34, 39-42
- /Users/trekkie/projects/gsd-atlas/src/grammar-engine/normalize.ts:37
- /Users/trekkie/projects/gsd-atlas/src/grammar-engine/extract.test.ts:742-992
- /Users/trekkie/projects/gsd-atlas/src/grammar-engine/index.ts:16-17
- /Users/trekkie/projects/gsd-atlas/src/indexer/process.ts:121-125, 263-272
- /Users/trekkie/projects/gsd-atlas/src/indexer/reconcile.ts:164-203
- /Users/trekkie/projects/gsd-atlas/src/indexer/build.ts:25-40
- /Users/trekkie/projects/gsd-atlas/src/indexer/types.ts:98-114, 140-146, 162-179
- /Users/trekkie/projects/gsd-atlas/src/tenant/create.ts:94-108, 294-304, 696-711
- /Users/trekkie/projects/gsd-atlas/src/query/status.ts:20-30, 33-60
- /Users/trekkie/projects/gsd-atlas/src/facts/degraded.ts:16-31; src/facts/file-facts.ts:104-124
- /Users/trekkie/projects/gsd-atlas/src/fact-store/schema.ts:3-12, 52-66
- /Users/trekkie/projects/gsd-atlas/src/lang/registry.ts:22-25, 126-129
- /Users/trekkie/projects/gsd-atlas/.planning/research/COMMENT-BOUND.md:26-45, 47-75, 99-118
- /Users/trekkie/projects/gsd-atlas/.planning/phases/03-typescript-module-and-mvp-eval/03-24-SUMMARY.md:132-134
- /Users/trekkie/projects/gsd-atlas/.planning/phases/03-typescript-module-and-mvp-eval/03-CONSTANTS.md:40, 196
- /Users/trekkie/projects/gsd-atlas/.planning/phases/03-typescript-module-and-mvp-eval/03-28-PLAN.md (files_modified, must_haves 51-57); 03-29-PLAN.md:127; 03-26-PLAN.md; 03-33-PLAN.md:28; 03-34-PLAN.md:28
- /Users/trekkie/projects/gsd-atlas/docs/reference/cli.md:177-178; docs/tutorials/index-and-ask.md:103
