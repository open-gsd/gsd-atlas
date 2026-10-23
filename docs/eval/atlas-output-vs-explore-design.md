# What atlas returns per call, against a one-call explore surface (design investigation, unregistered)

Status: investigation note by an agent, 2026-10-22. Not registered, not scored, no decision, no product code changed. No model session, no network. It reads, without editing, `memory-tools-evidence-2026-10.md`, `probe-notes-2026-10.md` and `angular-pilot/v2/pilot-results.md`. The ADRs are Accepted and append-only; nothing here amends one.

## Summary

1. A default atlas result page is about 7.5 KB (about 1.9k tokens by bytes/4) and carries 8 references. Only about 22% of the bytes are repo text (the single matched source line of each hit); about 36% are the facts (path, line, kind, enclosing name, tier, a 130-character target handle repeated on every row); about 30% are citation records whose `debug` handle serves `code_explain` (0 calls in 225 sessions per the probe notes); the rest is envelope. Atlas never returns a symbol body, an enclosing function, or a call path.
2. `budget_tokens` and `limit` do not lift the cap: with `budget_tokens=200000, limit=1000` a page is still about 32 KB (about 8k tokens), 34 to 39 results. Fully enumerating p-304 (103 call sites in the key) takes 12 calls at default and 3 at the cap; p-307 6 and 1; p-313 9 and 2.
3. Completeness against the audited keys is poor on two of five questions even after all pages are read (p-307 13 of 40 files; p-304 24 of 29), and heritage (p-310) is only answered by `code_context` (its `subtypes` field, 2 of 2 exact), not by `code_refs`, which lists 8 usage files. An agent has to know that. Impact output mixes importers with callers and does not follow the key's depth-two definition (extras 8 and 16).
4. A CodeGraph-style `explore` call is capped near 25 KB (about 6k tokens): three queries on this repo gave 25,308, 25,048 and 25,359 bytes. It returns line-numbered verbatim source plus call paths. I could not measure it on Angular (see Unmeasured), so its completeness on the audited keys is unknown.
5. Fixed cost: `tools/list` is 9,267 bytes for 7 tools; the instructions are about 900 bytes. Measured in the probes (P1): about 3,500 tokens for the seven definitions, 313 for the instructions, 965 for the skill. A one-tool surface is estimated at 0.5k to 0.7k tokens of definition, a saving of roughly 2.8k tokens per request (estimate, not measured), which is about 8 to 14k tokens per session at 3 to 5 requests, mostly cache reads.
6. The lever with the largest, cheapest-to-confirm effect is the shape of a result, not the number of tools: roughly 940 bytes per reference now against about 60 bytes for `path:line enclosing`. That can be confirmed offline before any run.

## Method

- Built this worktree (`npm ci --ignore-scripts && npm run build`). Index of a copy of the prepared Angular checkout (HEAD `3cc1edf`, 11,629 files, copy made from `scratchpad/angular-prepared`, read-only source) in a scratch cache via `XDG_CACHE_HOME`: `gsd-atlas build` then `maintain resolve`. The compiler fallback diagnostic ("project has no TypeScript compiler; bundled 6.0.3 used") appeared on results, as in the pilot.
- `scripts/design-probe/run-atlas.ts` talks to `dist/bin/gsd-atlas-mcp.js` over stdio JSON-RPC (initialize, tools/list, tools/call), i.e. what an agent's host receives; a paged step follows `more` to exhaustion. `analyze.ts` scores the `path` fields of the results against `pilot-answers.json` at file granularity, with the question's scope (under `packages/`, no `.d.ts`, no `schematics/`, `examples/`, `integrationtest/`). Helpers `measure-lib.ts` are unit-tested (RED 57d6b42, GREEN be6b83f). Each question was scripted as an agent would: `code_find` for the name, then the tool matching the kind with `path` set to the key's defining file (this assumes the agent disambiguates correctly; `code_find stringify` returns 11 rows including two `.d.ts` mocks and four fuzzy neighbours).
- Tokens are bytes/4 (the same estimate `gsd-atlas status` uses). No tokenizer exists locally (no tiktoken or equivalent installed; none was fetched). The probe notes measured 3,500 real tokens for definitions that are 9,267 bytes (2,317 by bytes/4), so bytes/4 probably undercounts JSON with hashes and URLs by around 1.5x; all token figures below are therefore lower bounds on the atlas side. Inconclusive on the exact factor.

## Per-question table (Angular, atlas, no model)

"Default" follows `more` with the default page; "cap" asks `limit=1000, budget_tokens=200000` (the server still cuts at about 32 KB). Calls include the `code_find` in the default column only. Source text: only the matched line per hit, fenced.

| question | kind | key files | default: calls / bytes / tok | cap: calls / bytes / tok | files found, matched / missing / extra | note |
|---|---|---:|---|---|---|---|
| p-304 `stringify` | callers | 29 | 12 / 88,822 / 22.2k | 3 / 71,257 / 17.8k | 24 / 5 / 1 | the extra is the declaring file (the key lists it differently); missing: ng_class.ts, ng_if.ts, pipes/utils.ts, metadata_overrider.ts, test_bed.ts |
| p-307 `Component` | references | 40 | 6 / 43,490 / 10.9k | 1 / 31,187 / 7.8k | 13 / 27 / 0 | search ended (`more` absent) with 38 results: 27 key files are not returned at all, so more paging would not help |
| p-310 `NgModuleRef` | heritage | 2 (file+symbol) | refs 6 calls 41.8k bytes (10.5k tok), 0 of the subtypes named as such; plus `code_context` 1 call 7,553 / 1.9k | refs cap: 1 / 23,063 / 5.8k | context `subtypes`: 2 / 0 / 0 | `code_refs` gives 8 usage files; the answer is in `code_context.subtypes`, in a 7.5 KB reply |
| p-312 `translate` | impact depth 2 | 5 | 3 / 17,035 / 4.3k | 1 / 8,444 / 2.1k | 2 / 3 / 8 | extras are importers (index.ts, private.ts), the defining file and spec files; missing: the three `tools/` translate plugins |
| p-313 `isArray` | impact depth 2 | 19 | 9 / 66,692 / 16.7k | 2 / 51,787 / 12.9k | 16 / 3 / 16 | extras include the defining file and public_api re-exports |
| mean of the five | | | 7.4 / 51,600 / 12.9k | 1.6 / 37,100 / 9.3k | | |

The key for p-307 and p-304 counts uses of the declaring symbol resolved by the compiler oracle; atlas indexed with the bundled 6.0.3 compiler and the name-and-path tier. Whether the 27 missing p-307 files are an atlas recall defect or a scope mismatch (for example uses through `Component` imports from a package barrel) was not diagnosed; the number stands as measured.

Composition of the bytes (p-304 default, 12 calls): data 32,192 (36%), citations 26,461 (30%), untrusted matched lines 19,426 (22%), envelope 10,743 (12%). Other questions are within 3 points.

On this repo (index of the worktree, no `maintain resolve`; not audited, no key): `code_find createTenant` 1,419 B; `code_refs createTenant` 495 B with 0 results (a likely recall miss before the compiler pass, not investigated, so inconclusive); `code_context handleLang` 7,755 B with `more` set; `code_impact buildMcpServer` depth 2: 4,209 B, 5 results. CodeGraph `explore` on three symbol queries in this repo returned 25.0 to 25.4 KB each.

## What atlas returns that is useless or missing

Useless to a model answering a file-set question:
- Citation records: about 30% of bytes, each with a roughly 150-character `debug` handle meant for `code_explain`, which no session called. Per-row `target` handle (130 chars) repeated on every `code_refs` row although `targets` already lists it.
- Duplicate files: p-304 default pages list one file up to 8 times, one row each; a model must dedupe.
- `code_find` fuzzy neighbours (`stringifyAndEscape`, `stringifyForError`) and `.d.ts` mock-package hits in a 7.8 KB reply for a name the question already fixed.
- `watermark.stalePaths`, `diagnostics`, `hints`, `answer_id` on every page.

Missing, and the reason a model Reads or greps afterwards:
- No enclosing symbol text or span, no way to ask for a few lines around a hit; only the single matched line.
- No call-path or group-by-file view; no "N sites in M files" summary at the top.
- No way to get one complete answer in one call: a hard cap near 32 KB regardless of the arguments.
- Heritage hidden behind `code_context`; `code_refs` does not say which references are `extends`/`implements`.
- Impact is a mixed importer/caller list without a depth label per file that matches a stated definition.

## Fixed cost

| surface | definitions (tools/list bytes) | measured in probes | note |
|---|---:|---:|---|
| 7 tools now | 9,267 B | about 3,500 tokens defs, 313 instructions, 965 skill (P1) | `code_find`, `code_refs`, `code_context`, `code_impact` are 1.6 to 1.8 KB each; `code_explain` 1.4 KB; `atlas_status`, `lang_list` 0.4 KB each |
| 3 tools (find, refs, impact) | about 5.4 KB | -1,420 tokens (P1) | measured |
| hypothetical 1 tool | about 2 KB | not measured | estimate 0.5k to 0.7k tokens; saving about 2.8k per request |

The saving per session is mostly cache reads at 0.05 to 0.1 weight (`memory-tools-evidence`), so in priced terms it is small; in the unweighted token convention of the registered gate it is not.

## Design options, ranked by expected effect

Every option lists the confirming measurement to run before any registered run, and what would falsify it. None is an implementation.

1. **Answer-shaped result rendering for enumeration questions** (compact rows `path:line enclosing`, grouped by file, with a total count, citation/debug handles moved behind an opt-in or an ID the host can resolve, repeated target handle dropped). Expected: bytes per reference from about 940 to about 60; p-304 in one call of about 6 KB; fewer pages, so fewer requests. Confirm offline: re-render the recorded envelopes (`rec-angular*.json` pattern) and report bytes and calls per question; no model needed. Falsified if the compact form needs more than 2 calls on any of the five questions, or if per-row fields a model needs (tier, ambiguity) cannot fit under 100 bytes. Risk: the citation record is the unit H3 measures (I did not re-read H3's definition; if it counts citations returned or used, hiding them changes its denominator and must be settled before use); a compact mode must keep the nonce fence for repo text (trust-boundaries ADR) and be added by dated amendment or as an opt-in, not by editing the ADR.
2. **One `atlas_explore` tool** (name or question in; kind inferred from the name and an optional `want`: refs, callers, subtypes, impact; returns find plus the chosen walk with file-level grouping and optional inline spans). Expected: fixed cost down by about 2.8k tokens per request; calls per question 3 to 4 down to 1 to 2. Confirm offline: the cap column above is the lower bound on calls today; build a replay that merges the recorded steps into one result and count bytes; measure definition tokens with the P1 first-request method on a scratch server copy (the probes already have `patch-server.ts`). Falsified if one-call output exceeds the 32 KB cap on more than 1 of 5 questions, or P1 shows less than 1.5k tokens saved. Risks: a merged tool changes what the A arms in H1/H3 call (tool names in registered prompts and `ARMS` reference the seven); the model must still choose it (adoption was 2 of 32 under deferral, 15 of 32 upfront).
3. **Optional inline spans** (`source: line | enclosing | none`; `enclosing` returns the symbol body up to N lines, fenced). Expected: removes the Read that location-only results force (arXiv 2608.13568: inline text cut reads 5.2 to 3.2 and tokens about 19%, preliminary, localisation tasks of about 1k tokens). Confirm: count, in the 225-session streams, how many Read calls follow an atlas call on the same file within two turns (`scripts/probes/run-payload.ts` is the nearest tooling); falsified if under 20% of called sessions Read afterwards. Risks: more untrusted repo text per response (each span is fenced, but the injection surface grows with bytes); results get larger, which P4 showed is not a lever on its own (a 93% byte cut raised tokens 7% because the model compensated with more calls), so spans must replace calls, not add bytes.
4. **Trim the definitions without merging** (drop `lang_list`, `atlas_status`, `code_explain` from the default surface, shorter descriptions). Expected: 1.4k tokens per request (measured in P1). Confirm: already measured; the P1 projection showed parity is not reached by trimming alone (1.14x to 1.32x of grep at best). Low risk, low reward; do it only as part of option 2.
5. **Passive delivery**: server `instructions` carrying a routing sentence and the heritage-in-`code_context` fact, or a PreToolUse hook that appends atlas's compact answer when the model greps for a name. Expected: adoption up; effect on tokens uncertain (P3 forced routing tripled billable tokens; the AGENTS.md study found generated context files raise cost by 20% or more). Confirm: replay the 225 recorded sessions' grep commands against the index and count how many would receive a complete compact answer; falsified if under half. Risk: a hook injecting repo-derived text is a trust-boundary change and the permission model says permissions come only from user-level config; this needs its own ADR amendment first.

Ordering rationale: 1 and 2 act on the mechanism the evidence ties to token cost (calls and turns, per `memory-tools-evidence` section 3 item 1) and are checkable offline for bytes and calls; 3 is the CodeGraph feature but its value depends on whether Reads follow atlas calls, which is data we hold but I did not count; 4 is measured and small; 5 touches delivery and trust and is the most uncertain.

## Would a one-call, inline-source surface plausibly cut calls and tokens?

Calls: yes, plausibly. Today the cap-sized path needs 1 to 3 calls plus the find, the default path 3 to 12; a merged compact result removes the pagination and the find. Tokens: only if the result is compact. A CodeGraph-shaped reply (about 25 KB, source-heavy) is larger than one atlas page (7.5 KB) and equal to about 3 of them; it would beat atlas only where atlas needs 4 or more pages, which is the case on 2 of 5 Angular questions at default settings (p-304, p-313) and not on the others. For name-addressable questions with a cheap grep baseline (the pilot's G averages 5.1 calls), I cannot show a net token win from these measurements: they bound atlas's own cost, not the baseline's.

## Unmeasured, deviations, and caveats

- CodeGraph on Angular and on the gsd-core questions: not measured. `codegraph init` on a scratch copy was refused by the permission classifier and I did not retry; CodeGraph numbers above are three same-shape queries on this repo (output size only, cap-saturated), so they say nothing about completeness against the keys or whether a model would still Read afterwards.
- The four gsd-core questions (q-001, q-013, q-017, q-036 were chosen): not measured; no figure from them is used anywhere in this note.
- The ADR and trust-boundary statements are from the task brief and the constraints in the project instructions; I did not re-read the ADR text. The H3 definition was not re-read either.
- No tokenizer: bytes/4 only, likely an undercount for atlas output.
- One pass, one index state (Angular after `maintain resolve`; this repo before it), one scripted agent policy; page counts depend on the model choosing `path`, using `more`, and not using `limit`. The model may paginate less than assumed and answer from a partial set, which is what the p-307 and p-304 recall figures suggest would be wrong.
- Impact "extra" files are scored against the key's depth-two call definition; atlas's definition is wider (importers), so those extras are a definition mismatch, not necessarily errors.
- Files: `scripts/design-probe/measure-lib.ts` (+ test), `run-atlas.ts`, `analyze.ts`. Raw records were kept in the scratchpad only.
