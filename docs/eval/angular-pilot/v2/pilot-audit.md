# Angular pilot, rule v2: audit of the 23 non-exact session answers against the keys (supplementary, unscored, unregistered)

**Addendum to `pilot-results.md`, which is not edited.** The registered verdict `OVERALL: MVP not met` stands. The outcome class in `pilot-results.md` ("stop and reconsider the token gate") is not softened here; the re-scoring below leaves it unchanged under every scoring tried, and no clause flips.

## Result in short

- **No key is defective.** Of the 35 distinct (question, file) disagreements in the 23 non-exact sessions, 29 are omissions of genuine key hits (c), 6 are over-inclusions by the session that the question text or the oracle excludes (a), 0 are genuine hits the key lacks (b). The four path-prefix sessions (d) are format artifacts: they are right once the leading `packages/` is restored, except for 3 and 14 genuine omissions in two of them.
- `pilot-audit-keys.json` therefore proposes **zero key changes** (`defects: []`, every audited key `changed: false`); it carries the oracle evidence. The "corrected keys" scoring equals the original scoring.
- With the leading `packages/` restored (not the pre-declared rule; sensitivity only), correctness is G 24/32 (75.0%), A-ts 24/32 (75.0%), A-reg 27/32 (84.4%), against 71.9 / 71.9 / 84.4 as registered. R, premise, adoption and the called-versus-G comparison do not depend on correctness, so R is 1.216 / 2.250 in every scenario and the class is the same in all four.
- Most omissions (c) are uses that a text search does not surface as a call: `instanceof Text`, type annotations, uses through an alias (`TmplAstText`, `ɵRuntimeErrorCode as RuntimeErrorCode`), and calls through an instantiated generic receiver (`ArrayMergeLogic<DisabledReason>`).

## Method

- Inputs: `pilot/summary.json` (`notExact`: missing and extra file names per session), `pilot/pilot-sessions.jsonl`, `pilot-questions.json`, `pilot-answers.json` (key of record, p-313 at 19 files), `key-corrections.md`, `pilot-run-plan.md`.
- Clone: a read-only copy of the Angular repository at `3cc1edf3210a9debb0be57a4e99e53a54505db32` (HEAD verified; not modified). `node scripts/angular-pilot/pilot-audit.ts --docs docs/eval/angular-pilot/v2 --evidence --repo <clone> --out docs/eval/angular-pilot/v2/pilot-audit-keys.json` regenerates each audited key with the oracle (`oracle-lib.ts`, with the generic-receiver fix 9a3067e) and records, for every audited file, the oracle's classified references (line, role, enclosing declaration). All 9 audited keys regenerate byte-identical to the key of record (`regeneratedEqualsKey: true`).
- Per-file verdicts are in `pilot-audit-verdicts.json` (hand-written, one reason each). Besides the oracle, I read the source lines behind every (a) verdict and behind the (c) verdicts of p-301, p-304, p-306, p-313 and p-314; for p-305 and p-307 the (c) verdicts rest on the oracle's reference lines plus spot reads of `content_projection.ts`, `t2_binder.ts`, `scope.ts` and `selectorless.ts`.
- `node scripts/angular-pilot/pilot-audit.ts --docs docs/eval/angular-pilot/v2` fails if any missing or extra file has no verdict, and prints the tables below (tests: `pilot-audit.test.ts`, `pilot-audit-cli.test.ts`; its baseline scenario reproduces `summary.json` exactly: R, correctness, matched / missing / extra, class).
- Verdict letters: a = key right, session wrong; b = session found a genuine hit the key lacks (key defect); c = session omitted a genuine key hit; d = path-format artifact or question-wording ambiguity.

## Verdict per key

| question | symbol (kind) | sessions off | verdict on the key | basis |
| --- | --- | ---: | --- | --- |
| p-301 | `untracked` (callers) | 1 | right | G r2 omitted `router_link_active.ts`: `untracked(isActive(...))` at line 288 is a call, imported from `@angular/core` (c). |
| p-304 | `stringify` (callers) | 2 | right | A-reg r2 omitted `stringify_spec.ts` (calls at lines 12, 15) (c). G r2 listed the declaring file: `stringify.ts:15` is `token.map(stringify)`, a function passed as a value; the question says a reference that is not called is not a call, the oracle classifies it as a use, not a call (a). |
| p-305 | `Text` (references) | 4 | right | Omissions are type-position and `instanceof` uses (c); two sessions dropped the leading `packages/` (d). |
| p-306 | `RuntimeErrorCode` (references) | 1 | right | A-reg r1 omitted `async_animation_renderer.ts`: line 93 reads `RuntimeErrorCode.ANIMATION_RENDERER_ASYNC_LOADING_FAILURE` through the alias `ɵRuntimeErrorCode as RuntimeErrorCode` of the re-export `private_export.ts:19` (c). |
| p-307 | `Component` (references) | 4 | right | A-ts omitted 4 and 9 files with type-position uses (c); two G sessions dropped the leading `packages/` (d), and one of them still lacks 14 files after restoring it (c). |
| p-308 | `ChangeDetectionStrategy` (references) | 3 | right | `router/test/integration/integration.spec.ts` contains the name only in the test title string at line 114; a string literal is not a use (a). |
| p-311 | `recognize` (impact, depth 2) | 1 | right | G r2 added `router/src/router.ts`. `operators/recognize.ts` and two specs call the target (depth 1), `navigation_transition.ts` calls that wrapper (depth 2); `router.ts` calls `NavigationTransitions` methods, which is depth 3 (a). |
| p-313 | `isArray` (impact, depth 2) | 5 | right | Three sessions omitted `field/state.ts` and `test/node/logic_node.spec.ts` (c): `state.ts:112` and `logic_node.spec.ts:38` (and more) call `compute` on `ArrayMergeLogic<DisabledReason>` / `ArrayMergeIgnoreLogic<..., null>`, and `ArrayMergeIgnoreLogic.compute` calls `isArray` (`logic.ts:166`). `field_adapter.ts` (`new FieldNodeState(node)`) and `deep_signal.spec.ts` (calls `deepSignal`, which calls the private `valueForWrite`, which calls `isArray`) are depth 3 (a). |
| p-314 | `registerLocaleData` (impact, depth 2) | 2 | right | A-ts r1 omitted `common/locales/closure-locale.ts` (line 2050 calls the common wrapper that forwards to the target) (c). A-ts r2 added `generate-locales-tool/closure-locale-file.ts`, whose `registerLocaleData` text (lines 172, 186) sits inside the template literal returned by `generateClosureLocaleFile` (a). |

The seven keys not in this table (p-302, p-303, p-309, p-310, p-312, p-315, p-316) had only exact answers; the audit adds nothing to them.

## Question-wording check for the four path-prefix sessions

The question text does not tell a session to drop `packages/`. Its only mention is the scope sentence ("tracked `.ts` files under `packages/`"); the answer schema (`scripts/eval/answer-schema.json`) says "Path of the file, relative to the repository root", and the harness prompt (`scripts/eval/harness.ts:118`) says "Report file paths relative to the repository root". So the four sessions disobeyed an explicit instruction, which makes this (d) in the path-format sense, not a wording defect. Observations, none of them proof: the four are 3 G and 1 A-ts (A-reg has none), and all four are on the two questions about compiler syntax-tree classes (p-305, p-307); the dropped-prefix paths are exactly the paths relative to `packages/`, which is what a search run from inside `packages/` prints. The raw session answers and streams were not kept, so why they dropped the prefix is unverified.

| session | as answered (matched / missing / extra) | with `packages/` restored | what remains after restoring |
| --- | --- | --- | --- |
| G p-305 r1 | 0 / 14 / 11 | 11 / 3 / 0 | 3 genuine omissions: `t2_binder.ts`, `content_projection.ts`, `scope.ts` (c) |
| A-ts p-305 r2 | 0 / 14 / 14 | 14 / 0 / 0, exact | none |
| G p-307 r1 | 0 / 40 / 26 | 26 / 14 / 0 | 14 genuine omissions (c) |
| G p-307 r2 | 0 / 40 / 40 | 40 / 0 / 0, exact | none |

Without normalisation (the pre-declared rule) these are 4 wrong sessions; with it, 2 are exact and 2 are still wrong. Restoring the prefix moves the G sums of matched / missing / extra from 393 / 99 / 81 to 470 / 22 / 4 and the A-ts sums from 459 / 33 / 17 to 473 / 19 / 3; A-reg is unchanged (485 / 7 / 1).

## Tables (generated by pilot-audit.ts)

### Per-session table (23 non-exact sessions)

| session | matched / missing / extra | files and verdicts |
| --- | --- | --- |
| ang-G-p-301-r2 | 38 / 1 / 0 | missing router/src/directives/router_link_active.ts (c) |
| ang-A-reg-p-304-r2 | 28 / 1 / 0 | missing core/test/util/stringify_spec.ts (c) |
| ang-G-p-304-r2 | 29 / 0 / 1 | extra core/src/util/stringify.ts (a) |
| ang-A-reg-p-305-r2 | 10 / 4 / 0 | missing compiler-cli/preprocessor/language-service/src/completions.ts (c); missing language-service/src/completions.ts (c); missing language-service/src/semantic_tokens.ts (c); missing language-service/src/template_target.ts (c) |
| ang-A-ts-p-305-r1 | 11 / 3 / 0 | missing compiler/src/render3/view/t2_binder.ts (c); missing compiler/src/typecheck/ops/content_projection.ts (c); missing compiler/src/typecheck/ops/scope.ts (c) |
| ang-A-ts-p-305-r2 | 0 / 14 / 14 | path format: 14 answered paths lack the leading `packages/` (d); after restoring it the answer equals the key |
| ang-G-p-305-r1 | 0 / 14 / 11 | path format: 11 answered paths lack the leading `packages/` (d); after restoring it 3 key files are still missing: compiler/src/render3/view/t2_binder.ts (c), compiler/src/typecheck/ops/content_projection.ts (c), compiler/src/typecheck/ops/scope.ts (c) |
| ang-A-reg-p-306-r1 | 7 / 1 / 0 | missing platform-browser/animations/async/src/async_animation_renderer.ts (c) |
| ang-A-ts-p-307-r1 | 36 / 4 / 0 | missing compiler-cli/src/ngtsc/typecheck/api/checker.ts (c); missing compiler-cli/src/ngtsc/typecheck/src/checker.ts (c); missing compiler/test/render3/view/binding_spec.ts (c); missing compiler/test/render3/view/util.ts (c) |
| ang-A-ts-p-307-r2 | 31 / 9 / 0 | missing compiler/src/indexer/api.ts (c); missing compiler/src/render3/view/t2_api.ts (c); missing compiler/src/typecheck/ops/bindings.ts (c); missing compiler/src/typecheck/ops/content_projection.ts (c); missing compiler/src/typecheck/ops/inputs.ts (c); missing compiler/src/typecheck/ops/references.ts (c); missing compiler/src/typecheck/ops/signal_forms.ts (c); missing compiler/test/render3/view/binding_spec.ts (c); missing compiler/test/render3/view/util.ts (c) |
| ang-G-p-307-r1 | 0 / 40 / 26 | path format: 26 answered paths lack the leading `packages/` (d); after restoring it 14 key files are still missing: compiler/src/indexer/api.ts (c), compiler/src/render3/view/t2_api.ts (c), compiler/src/render3/view/t2_binder.ts (c), compiler/src/typecheck/oob.ts (c), compiler/src/typecheck/ops/bindings.ts (c), compiler/src/typecheck/ops/content_projection.ts (c), compiler/src/typecheck/ops/inputs.ts (c), compiler/src/typecheck/ops/references.ts (c), compiler/src/typecheck/ops/schema.ts (c), compiler/src/typecheck/ops/scope.ts (c), compiler/src/typecheck/ops/selectorless.ts (c), compiler/src/typecheck/ops/signal_forms.ts (c), compiler/test/render3/view/binding_spec.ts (c), compiler/test/render3/view/util.ts (c) |
| ang-G-p-307-r2 | 0 / 40 / 40 | path format: 40 answered paths lack the leading `packages/` (d); after restoring it the answer equals the key |
| ang-A-ts-p-308-r1 | 46 / 0 / 1 | extra router/test/integration/integration.spec.ts (a) |
| ang-A-ts-p-308-r2 | 46 / 0 / 1 | extra router/test/integration/integration.spec.ts (a) |
| ang-G-p-308-r1 | 46 / 0 / 1 | extra router/test/integration/integration.spec.ts (a) |
| ang-G-p-311-r2 | 4 / 0 / 1 | extra router/src/router.ts (a) |
| ang-A-reg-p-313-r1 | 19 / 0 / 1 | extra forms/signals/src/field/field_adapter.ts (a) |
| ang-A-reg-p-313-r2 | 18 / 1 / 0 | missing forms/signals/test/node/logic_node.spec.ts (c) |
| ang-A-ts-p-313-r1 | 17 / 2 / 0 | missing forms/signals/src/field/state.ts (c); missing forms/signals/test/node/logic_node.spec.ts (c) |
| ang-G-p-313-r1 | 17 / 2 / 1 | missing forms/signals/src/field/state.ts (c); missing forms/signals/test/node/logic_node.spec.ts (c); extra forms/signals/test/node/deep_signal.spec.ts (a) |
| ang-G-p-313-r2 | 17 / 2 / 0 | missing forms/signals/src/field/state.ts (c); missing forms/signals/test/node/logic_node.spec.ts (c) |
| ang-A-ts-p-314-r1 | 9 / 1 / 0 | missing common/locales/closure-locale.ts (c) |
| ang-A-ts-p-314-r2 | 10 / 0 / 1 | extra common/locales/generate-locales-tool/closure-locale-file.ts (a) |

### Verdict counts

| basis | a: key right, session wrong | b: genuine hit the key lacks | c: session omitted a genuine key hit | d: path format or wording |
| --- | ---: | ---: | ---: | ---: |
| per question and file (35) | 6 | 0 | 29 | 0 |
| per session instance (238) | 8 | 0 | 48 | 182 |

### Re-scoring (tokens unchanged; class by the rules of pilot-run-plan.md)

| scenario | correctness G | correctness A-ts | correctness A-reg | exact sessions G / A-ts / A-reg | matched / missing / extra G | A-ts | A-reg | R A-ts | R A-reg | class | flags |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | --- | --- |
| original keys, as answered | 71.9% | 71.9% | 84.4% | 23 / 23 / 27 | 393 / 99 / 81 | 459 / 33 / 17 | 485 / 7 / 1 | 1.216 | 2.250 | stop and reconsider the token gate | adoption below 20%; stop clause 1: both R at or above 1.10 with the premise passed; stop clause 2: atlas sessions with a call cost at least as much as G on the same questions |
| original keys, leading packages/ restored | 75.0% | 75.0% | 84.4% | 24 / 24 / 27 | 470 / 22 / 4 | 473 / 19 / 3 | 485 / 7 / 1 | 1.216 | 2.250 | stop and reconsider the token gate | adoption below 20%; stop clause 1: both R at or above 1.10 with the premise passed; stop clause 2: atlas sessions with a call cost at least as much as G on the same questions |
| corrected keys, as answered | 71.9% | 71.9% | 84.4% | 23 / 23 / 27 | 393 / 99 / 81 | 459 / 33 / 17 | 485 / 7 / 1 | 1.216 | 2.250 | stop and reconsider the token gate | adoption below 20%; stop clause 1: both R at or above 1.10 with the premise passed; stop clause 2: atlas sessions with a call cost at least as much as G on the same questions |
| corrected keys, leading packages/ restored | 75.0% | 75.0% | 84.4% | 24 / 24 / 27 | 470 / 22 / 4 | 473 / 19 / 3 | 485 / 7 / 1 | 1.216 | 2.250 | stop and reconsider the token gate | adoption below 20%; stop clause 1: both R at or above 1.10 with the premise passed; stop clause 2: atlas sessions with a call cost at least as much as G on the same questions |

| scenario | billable mean, exact-set sessions only: G | A-ts | A-reg |
| --- | ---: | ---: | ---: |
| original keys, as answered | 48,166 | 61,813 | 127,839 |
| original keys, leading packages/ restored | 55,762 | 66,904 | 127,839 |
| corrected keys, as answered | 48,166 | 61,813 | 127,839 |
| corrected keys, leading packages/ restored | 55,762 | 66,904 | 127,839 |

Reading of the re-scoring table: the "original keys, as answered" row is the registered scoring and reproduces `pilot-results.md` (G 393 / 99 / 81, A-ts 459 / 33 / 17, A-reg 485 / 7 / 1; R 1.216 and 2.250). The "corrected keys" rows are identical to the original ones because no key was found defective; they are listed so the comparison is explicit, not because they differ. "Restored" is a sensitivity analysis, not a rule of the plan: the plan matches paths as answered.

## Outcome class under each scoring

Applied mechanically with `classify` of `pilot-analysis.ts` (same code path as `pilot-results.md`), tokens unchanged, premise passed (G mean 72,662):

- Class 1 ("worth a registered run") needs R <= 0.85 for one A condition; R is 1.216 and 2.250, so it fails in every scoring, whatever the correctness.
- Clause 2(a) (both A conditions R >= 1.10 with the premise passed) holds in every scoring: R does not depend on correctness.
- Clause 2(b) (called A sessions cost at least as much as G on the same questions) holds in every scoring: it is a token comparison.
- Flags: adoption below 20% (A-ts 2 of 32) holds in every scoring; correctness below 50% for any condition holds in none (lowest 71.9%); the key-change trigger (more than 3 of 16 keys changed) holds in none (1 of 16 before the pilot, 0 added by this audit).
- Result: **"stop and reconsider the token gate" in all four scorings; no clause flips.** Correctness moves by at most one session per G and A-ts condition (3.1 points) and does not enter any clause that decides the class, except through the class 1 correctness test, which is moot because R fails.

## What this audit does and does not show

- It shows that for the 23 non-exact sessions the keys were right and the sessions were wrong or incomplete. Of the 29 omitted genuine hits, many are of the kind a grep-style search misses (type-position uses, `instanceof`, aliased imports, generic receivers); the 6 over-inclusions are a function passed as a value, a name inside a string, generated code inside a template literal, and three depth-3 files.
- It does not prove the keys complete. Sessions never offered a genuine hit that the key lacks, which is evidence of completeness only for the 9 audited keys and only at the strength of what 96 sessions happened to list. The independent text-level key audit (`key-audit.md`, `second-reader-audit.md`) is the check on completeness; this audit adds nothing to it.
- The oracle is the same machinery that produced the keys, so regeneration equality is a consistency check, not independent evidence. The independent part is my reading of the source lines named in the verdict table; for the p-305 and p-307 omissions (the largest group, 7 and 16 distinct files) I read four files and rely on the oracle's reference lines for the rest.
- Raw session answers and streams were not retained in the run directory, so the analysis uses the missing / extra lists of `pilot/summary.json`. Why four sessions dropped the leading `packages/` is unverified.
- The p-304 over-inclusion (`stringify.ts:15`, a recursive function passed as a value) is the only one where a reader could argue for the session; the question text settles it against the session ("a reference that is not called ... is not a call"). Counting such references would be a change of the question, not a correction of the key.
- A sampling caution: p-313 is the only key that was changed before the pilot (17 to 19 files, `key-corrections.md`), and 3 of the 5 non-exact p-313 sessions omit exactly the two files that change added (a fourth omits one of them). The changed key is right (verdict c above); two of those sessions (G r2, A-ts r1) answered the old 17 files exactly and would have been exact against the old key.

## Files

- `pilot-audit-verdicts.json`: per-file verdicts and reasons (35 entries) and the list of the four path-format sessions.
- `pilot-audit-keys.json`: proposed corrected keys (none changed), oracle regeneration of the nine audited keys, and per-file oracle references for the 35 audited files.
- `scripts/angular-pilot/pilot-audit-lib.ts`, `pilot-audit.ts`, `pilot-audit.test.ts`, `pilot-audit-cli.test.ts`: rescoring, verdict bookkeeping, report and evidence generator.
