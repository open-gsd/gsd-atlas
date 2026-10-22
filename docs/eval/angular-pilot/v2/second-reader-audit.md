# Second-reader audit of the 16 rule-v2 angular pilot questions (p-301..p-316)

**Second reader, exploratory, nothing registered.** Written by an agent that did not build the oracle, the keys or the first-reader audit. Each answer set was derived from the wording alone (package, kind and role description, no declaring file) with ripgrep and small text scripts, and compared with `pilot-answers.json` only afterwards. The compiler oracle was not run and `key-audit.md` was not trusted. No model session, no cost. Corpus: the pinned clone at `3cc1edf3210a9debb0be57a4e99e53a54505db32` (HEAD checked in `.git/refs/heads/main`), read only, no code run from it.

## Summary

1. 15 of the 16 keys equal my independently derived sets exactly (0 key-only, 0 mine-only): p-301..p-312, p-314, p-315, p-316.
2. One key is incomplete: **p-313 `isArray`** (impact). Hop two misses 2 files (`forms/signals/src/field/state.ts`, `forms/signals/test/node/logic_node.spec.ts`), so the key has 17 files and the wording asks for 19. Class key-likely-incomplete; recommend **replace**.
3. Cause of the p-313 gap (hypothesis, oracle not run): hop two of `schema/logic.ts:166` lands in `ArrayMergeIgnoreLogic.compute`, a method of a generic class. Calls through `ArrayMergeIgnoreLogic<..>` or `ArrayMergeLogic<..>` receivers are not credited, which fits `classify` comparing `symbolOf(id) !== targetSym` (`scripts/angular-pilot/oracle-lib.ts:336`) when the checker returns an instantiated member symbol. The first reader left exactly this hop unverified.
4. No `ambiguous-wording` finding. Every wording identifies one target. The cases where only the package separates two near-identical declarations are p-304 (`stringify`, compiler twin has the same body) and p-308 (`ChangeDetectionStrategy`, compiler enum has the same three members); the fixed sentence of rule (a) covers both, and a solver must trace imports.
5. Alias and re-export traps the keys handle correctly: `ɵstringify as stringify` (6 files, p-304), `TmplAstText` / `TmplAstComponent` / `TmplAstComponent as Component` (p-305, p-307), `ɵRuntimeErrorCode as RuntimeErrorCode` (p-306), `recognize as recognizeFn` (p-311), `translate as _translate` and `ɵtranslate` (p-312), `ɵregisterLocaleData` (p-314), `NgModuleRef as viewEngine_NgModuleRef` (p-310).
6. Traps that a text-only solver gets wrong and the keys get right: a template-string copy of the call in `closure-locale-file.ts` (p-314), `ChangeDetectionStrategy` inside test strings in `ngtsc_spec.ts` (p-308), `digest` passed as a value in `i18n_html_parser.ts:50` (p-303), `stringify` passed as `token.map(stringify)` in its own file (p-304), same-named methods `visitAll` / `digest` / `compute` (p-302, p-303).
7. p-307 `Component` and p-305 `Text`: I read every compiler-package file with the whole word, and every `TmplAstText` / `TmplAstComponent` file, at all hit lines. No extra file; no deep import of `r3_ast` from another package exists.
8. Heritage p-309 (4 items) and p-310 (3 items): no anonymous class expression, mixin or aliased extender beyond those in the key.
9. The grep-cost table matches my counts except three whole-tree figures that differ by 4 to 6 because `git grep -w` treats `ɵ` as a word boundary and ripgrep does not (details below); the Version figure (75) disagrees with the first reader's own body text (71).
10. Not checked: the oracle itself (cause of p-313), commit dates, the any-risk audit, templates and non-`.ts` files.

## Per-question table

Size is files for callers, references and impact; file+symbol items for heritage; file+line items for definition.

| id | symbol | category | key size | my size | key-only | mine-only | class | recommendation |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| p-301 | `untracked` | callers | 39 | 39 | 0 | 0 | consistent | keep |
| p-302 | `visitAll` | callers | 20 | 20 | 0 | 0 | consistent | keep |
| p-303 | `digest` | callers | 4 | 4 | 0 | 0 | consistent | keep |
| p-304 | `stringify` | callers | 29 | 29 | 0 | 0 | consistent | keep |
| p-305 | `Text` | references | 14 | 14 | 0 | 0 | consistent | keep |
| p-306 | `RuntimeErrorCode` | references | 8 | 8 | 0 | 0 | consistent | keep (optional: say `const enum`) |
| p-307 | `Component` | references | 40 | 40 | 0 | 0 | consistent | keep |
| p-308 | `ChangeDetectionStrategy` | references | 46 | 46 | 0 | 0 | consistent | keep |
| p-309 | `Validator` | heritage | 4 | 4 | 0 | 0 | consistent | keep |
| p-310 | `NgModuleRef` | heritage | 3 | 3 | 0 | 0 | consistent | keep |
| p-311 | `recognize` | impact | 4 | 4 | 0 | 0 | consistent | keep |
| p-312 | `translate` | impact | 5 | 5 | 0 | 0 | consistent | keep |
| p-313 | `isArray` | impact | 17 | 19 | 0 | 2 | key-likely-incomplete | replace |
| p-314 | `registerLocaleData` | impact | 10 | 10 | 0 | 0 | consistent | keep |
| p-315 | `Version` | definition | 1 | 1 | 0 | 0 | consistent | keep |
| p-316 | `isInSkipHydrationCollector` | abstain | 0 | 0 | 0 | 0 | consistent | keep |

## Detail: p-313 `isArray` (packages/forms/signals/src/util/type_guards.ts:12), key-likely-incomplete, replace

Wording read: the type guard `isArray` of `@angular/forms` used by signal forms; the other `isArray` (`compiler-cli/src/ngtsc/annotations/common/src/evaluation.ts:93`) is in another package. Target identified without doubt.

Hop one, derived by hand. Importers of `util/type_guards` that call the function: `compat/src/api/extract.ts` (115, 125), `src/api/structure.ts` (503, 552), `src/field/context.ts` (139), `src/field/proxy.ts` (41), `src/field/structure.ts` (334, 362), `src/field/validation.ts` (381, 406), `src/schema/logic.ts` (166), `src/util/deep_signal.ts` (52). That is the key's 8 direct files. `field/node.ts:485` has a boolean parameter named `isArray`, not a call.

Hop two, unit by unit (nearest enclosing declaration with a name, then every file that calls it):

| call | enclosing unit | callers outside its own file |
| --- | --- | --- |
| extract.ts:115 | `isContainerNode` (not exported) | none |
| extract.ts:125 | `extractChildren` (not exported) | none |
| api/structure.ts:503 | `submit` (exported, overloaded) | `directive/form_root.ts:53`, `webmcp/registration.ts:77`, `test/node/compat/compat.spec.ts:338`, `test/node/submit.spec.ts` (many) |
| api/structure.ts:552 | `setSubmissionErrors` (not exported) | none |
| field/context.ts:139 | arrow inside field initializer `index = computed(...)`, so the class `FieldNodeContext` (by `new`) | `field/node.ts:84` |
| field/proxy.ts:41 | method `get` of the `FIELD_PROXY_HANDLER` literal | none (invoked by `Proxy` only) |
| field/structure.ts:334, 362 | private method `computeChildrenMap` | none outside the file (one file contains the word) |
| field/validation.ts:381 | `normalizeErrors` (not exported; the exported one in `rules/validation/util.ts` is another symbol) | none |
| field/validation.ts:406 | `addDefaultField` (exported, overloaded) | `rules/validation/standard_schema.ts:178`, `validate.ts:41`, `validate_async.ts:174,177`, `validate_tree.ts:37` (and `api/structure.ts:557`, already direct) |
| schema/logic.ts:166 | method `ArrayMergeIgnoreLogic.compute` (class is generic: `ArrayMergeIgnoreLogic<TElement, TIgnore>`) | see below |
| util/deep_signal.ts:52 | `valueForWrite` (not exported) | none |

The key's 9 hop-two files are exactly the callers of `submit` (4), `addDefaultField` (4) and `FieldNodeContext` (`node.ts`). The `compute` row is the gap. `logic.ts:262` declares `readonly syncErrors: ArrayMergeIgnoreLogic<ValidationError.WithFieldTree, null>` and `logic.ts:257` declares `readonly disabledReasons: ArrayMergeLogic<DisabledReason>`, where `ArrayMergeLogic` extends `ArrayMergeIgnoreLogic` and does not override `compute`. Calls through those receivers resolve to the exact declaration `ArrayMergeIgnoreLogic.compute`:

- `packages/forms/signals/src/field/state.ts:112` `...this.node.logicNode.logic.disabledReasons.compute(this.node.context)` (the other `.compute` calls in `state.ts` go to `BooleanOrLogic` or `MetadataMergeLogic`, which are other methods).
- `packages/forms/signals/test/node/logic_node.spec.ts:38` and about 35 more lines, all `logicNode.logic.syncErrors.compute(fakeFieldContext)`.
- `field/validation.ts:164,185,233` are the same kind of call but the file is already in the direct set. `field/metadata.ts:49,75` call through `AbstractLogic` and `MetadataMergeLogic`, so they do not count.

Under the wording ("method ... with calls resolved to the exact declaration") the answer has 19 files; the key has 17. This is the only place where the written formula and the key disagree, and it is not a wording flaw but an oracle gap on methods of generic classes (not run, so the cause is a hypothesis: `oracle-lib.ts` `classify` keeps a reference only when `symbolOf(id) === targetSym`, and a call through a type with type arguments can yield an instantiated member symbol instead of the declared one). The same defect cannot touch p-311, p-312 or p-314: their enclosing units are plain functions.

Recommendation: replace p-313 by the next candidate under the rule (the selection log already shows impact is the scarcest pool, so check supply first), or, if the owner prefers to keep it, fix the identity comparison for members of instantiated generic types, regenerate, and expect the key to become the 19 files above. Rewording cannot fix it. Separately, for any impact question, the wording does not say what a call inside a class field initializer counts for; the oracle attributes it to the class (by `new`, here `FieldNodeContext`), which is the only reading that fits "function, method or class (by `new`)". If p-313 is kept add: "a call in a class field initializer counts for the class".

## Evidence lines for the consistent questions

- **p-301** `untracked` (core wrapper, `render3/reactivity/untracked.ts`; the other is `core/primitives/signals/src/untracked.ts`). 51 whole-word files, 39 with a real call, all importing from `@angular/core`, `../../src/core` or the wrapper path; the rest are comments or test titles (`provider_spec`, `reactive_safety_spec`, `reactive_lview_consumer`, four forms specs), the two re-exports, `extract.ts` (import only), and the primitive. The wrapper calls the primitive under the alias `untrackedPrimitive`, which is not a call to the target.
- **p-302** `visitAll` (ml_parser, optional `context`). The r3 `visitAll` has no context argument and is exported as `tmplAstVisitAll` (`compiler.ts:194`). 34 files: 20 call the ml one (`html.visitAll`, `ml.visitAll`, bare in `ml_parser/ast.ts:315` and in four localize files importing from `@angular/compiler`); 14 are method calls (`this.visitAll`, `deferred.visitAll`, `visitor.visitAll`), r3 calls (`t.visitAll`, `a.visitAll`, bare in `r3_ast.ts` and `partial/component.ts`), a comment or the `compiler.ts` export.
- **p-303** `digest` (`digest.ts:21`, XLIFF1 `computeDigest`; the other is `serializers/xmb.ts:205`, decimal). Calls: `serializers/xliff.ts:137`, `digest_spec.ts:15`, `extractor_merger_spec.ts:540`, `i18n_parser_spec.ts:409`. `i18n_html_parser.ts:50` passes `digest` as a value (not a call); `xtb.ts` imports the xmb one; `translation_bundle_spec.ts` declares a local `digest`.
- **p-304** `stringify` (core). 160 scope files, 32 reach the core function by name or as `ɵstringify as stringify`; 29 contain a call. Not calls: `core/src/util/stringify.ts:15` (`token.map(stringify)`), `render3/styling/static_styling.ts` and `test/di/static_injector_spec.ts` (import `concatStringsWithSpace` / unused import only), the re-export `core_private_export.ts:193`. Twins in other packages: `compiler/src/util.ts:84` (same body; its callers `parse_util.ts`, `util_spec.ts` must not be listed), `common/locales/.../object-stringify.ts`, and a non-exported local in `router/src/create_url_tree.ts:563`.
- **p-305** `Text` (r3). Other classes named `Text`: `ml_parser/ast.ts:40`, `i18n/i18n_ast.ts:80`, `serializers/xml_helper.ts:101`. 14 files = 10 in the compiler (`t.Text` in `combined_visitor`, `r3_template_transform`, `ingest`, three specs/util; named import in `t2_binder`, `content_projection`, `scope`; the declaring file) plus 4 `TmplAstText` users. `compiler.ts:184` is an export specifier. `localize` imports `Text` from `@angular/compiler`, which is the ml class. DOM `Text` in core/zone.js is a global.
- **p-306** `RuntimeErrorCode` (platform-browser, `const enum`). 8 files: `browser.ts`, `browser/meta.ts`, `browser/testability.ts`, `dom/dom_renderer.ts`, `dom/events/event_manager.ts`, `hydration.ts`, `security/dom_sanitization_service.ts` (each with member accesses) and `animations/async/src/async_animation_renderer.ts` (`ɵRuntimeErrorCode as RuntimeErrorCode` from `../../../index`, line 93). `private_export.ts:19` is a re-export. Nine other packages each declare their own enum; every import in them resolves to its own `errors.ts`.
- **p-307** `Component` (r3 class). 40 files = 18 `TmplAstComponent` files outside the compiler (11 compiler-cli, 7 language-service; one is `TmplAstComponent as Component` in `template_target_spec.ts:15`) + 22 compiler files. The ml `Component` (`ml_parser/ast.ts:162`) is reached as `html.Component` / `ml.Component` in 13 compiler files, all correctly out; `core/metadata/directives.ts` (interface + const) is the decorator, out. All 46 compiler files with the word read at their hit lines.
- **p-308** `ChangeDetectionStrategy` (core). 70 scope files; 46 import from core (`@angular/core`, `../../src/core`, `change_detection/constants`) and each has a code use beyond the import. Out: re-exports (`core/src/change_detection.ts`, `change_detection/change_detection.ts`), comments (`change_detector_ref`, `provide_check_no_changes_config`, `interfaces/definition.ts`, `view_ref`, `router_outlet`), strings (`ngtsc_spec.ts` 5996-6049, `handler.ts:548`, `jit_environment_spec.ts:62`), the compiler enum and users (`compiler/src/core.ts:29`, `partial_component_linker_1.ts`, `util_spec.ts`), and the core `type ChangeDetectionStrategy = number` in `core/src/compiler/compiler_facade_interface.ts:381`. The declaring file has no self-use.
- **p-309** `Validator` (benchpress). `extends Validator` appears four times in benchpress: `regression_slope_validator.ts:20`, `size_validator.ts:18`, `runner_spec.ts:137` (`MockValidator`), `sampler_spec.ts:259` (`MockValidator`). No `implements`, alias or class expression. Forms `Validator` (interface) and signals `Validator` (type) are other symbols.
- **p-310** `NgModuleRef` (abstract, `linker/ng_module_factory.ts:19`). Direct subtypes: `InternalNgModuleRef` (interface, same file:41), render3 `NgModuleRef` (`render3/ng_module_ref.ts:41`, `extends viewEngine_NgModuleRef`), `EnvironmentNgModuleRefAdapter` (`ng_module_ref.ts:119`, same alias). A multi-line search for `extends|implements ... NgModuleRef|ɵRender3NgModuleRef` returns only these three.
- **p-311** `recognize` (`router/src/recognize.ts:46`; the other is the operator `router/src/operators/recognize.ts:19`). Direct: `operators/recognize.ts` (as `recognizeFn`, inside the `mergeMap` callback, so attributed to the operator `recognize`), `test/apply_redirects.spec.ts`, `test/create_router_state.spec.ts`. Hop two: the operator is called only by `navigation_transition.ts:545`; the specs' enclosing helpers (`checkRedirect`, `createState`) are local. `recognize.spec.ts` imports `Recognizer` and defines its own `recognize` wrapper: it never calls the target, correctly out.
- **p-312** `translate` (`localize/src/utils/src/translations.ts:55`, first argument is the record, throws `MissingTranslationError`). The others: `localize/src/translate.ts:101` (uses `$localize.TRANSLATIONS`) and `tools/src/source_file_utils.ts:420` (record is the second argument, logs). Direct: `translate.ts` (alias `_translate`), `source_file_utils.ts` (`ɵtranslate`), `translations_spec.ts:251` (`doTranslate`, local). Hop two: callers of `source_file_utils.translate` = `es2015_translate_plugin.ts:45`, `es5_translate_plugin.ts:44`; `translate.ts`'s function is only assigned (`$localize.translate = translate`, line 67), no calls.
- **p-314** `registerLocaleData` (core). Direct (8): `common/src/i18n/locale_data.ts:21`, six `common/test` files via `ɵregisterLocaleData`, `core/test/i18n/locale_data_api_spec.ts` (relative import). Hop two (2): callers of the common wrapper = `common/locales/closure-locale.ts:2050`, `core/test/acceptance/i18n_spec.ts` (through `@angular/common`). `closure-locale-file.ts:172,186` is inside a template literal that generates `closure-locale.ts`, not code.
- **p-315** `Version`: `compiler-cli/src/version.ts:15` imports it from `@angular/compiler`, `compiler.ts:265` re-exports `Version` from `./util`, line 17 is `new Version(...)`; declaration `compiler/src/util.ts:118` (`export class Version {` carries the name). Others: `core/src/version.ts:14` (class), `core/primitives/signals/src/graph.ts:25` (type).
- **p-316** `isInSkipHydrationCollector`: 0 whole-word and 0 case-insensitive substring hits over the whole tree (hidden files included), none under `packages/`. A reader will meet near names that do not change the answer but could tempt a wrong one: `isInSkipHydrationBlock` (`core/src/hydration/skip_hydration.ts:64`, `core/src/render3/state.ts:263`), `isI18nInSkipHydrationBlock`, `isSkipHydrationRootTNode`. "Not found" is correct.

## Grep-cost proxy (step 8): counts re-done

Whole-tree whole-word files by ripgrep (hidden files included, `.git` excluded), then the number of other same-named top-level exported declaring files in non-test files:

| id | mine tree | first reader | mine other decls | first reader |
| --- | ---: | ---: | ---: | ---: |
| p-301 | 93 | 93 | 1 | 1 |
| p-302 | 45 | 45 | 1 | 1 |
| p-303 | 55 | 55 | 1 | 1 |
| p-304 | 246 | 246 | 2 | 2 |
| p-305 | 164 | 164 | 3 | 3 |
| p-306 | 178 | 182 | 9 | 9 |
| p-307 | 2989 | 2989 | 2 | 2 |
| p-308 | 162 | 162 | 3 | 3 |
| p-309 | 41 | 41 | 2 | 2 |
| p-310 | 53 | 53 | 1 | 1 |
| p-311 | 43 | 43 | 1 | 1 |
| p-312 | 257 | 257 | 2 | 2 |
| p-313 | 189 | 189 | 1 | 1 |
| p-314 | 25 | 31 | 1 | 1 |
| p-315 | 71 | 75 (table), 71 (body) | 2 | 2 |
| p-316 | 0 | 0 | 0 | 0 |

The three differences: p-306 (4) and p-314 (6) are the files whose only hit is the `ɵ`-prefixed name (`ɵRuntimeErrorCode`, `ɵregisterLocaleData`), which `git grep -w` counts and ripgrep does not; for p-314 the 6 extra are exactly the six `common/test` files. p-315: the first reader's table and selection log say 75 (and 75.0 files per key file) while the same audit's p-315 body says 71 and so do I. In scope the first reader's figures are 170 (p-306, mine 166) and 15 (p-314, mine 9) for the same `ɵ` reason; the rest of the scope column equals mine. Key-file ratios are unaffected except p-315 (71.0, not 75.0).

## Discrepancies with the first reader's audit

1. p-313 hop two: the first reader's "unverified, stays" is now resolved against the key (2 files missing, above).
2. p-315 grep files: 75 in the table and `selection-log.md`, 71 in the audit body; 71 is correct.
3. p-306 and p-314 grep counts: 182 / 170 and 31 / 15 are `git grep -w` figures that count `ɵ`-prefixed names; a Unicode-aware search sees 178 / 166 and 25 / 9. Neither is wrong, but "grep files" means different things depending on the tool a solver uses.
4. p-310: the audit's summary line gives key 2 (files); the key has 3 file+symbol items in 2 files. Consistent, only the unit differs.
5. Everything else the first reader marked consistent I also found consistent, including the 3 grep-only files of p-305 and the 12 alias files of p-307 (which are the 12 non-compiler files that use only `TmplAstComponent`).

## What I could not check

- The oracle: I did not run `oracle-lib.ts`, so the p-313 cause is a reading of its code (`enclosingUnit`, `classify`, `impactDepthTwo`), not a measurement. Whether other generic-class members elsewhere in the 16 keys are affected: none of the 16 targets has a generic-class method as a hop-two unit except p-313.
- Dates of declaring files (tier 2 has no date condition; tier 1 files were not re-dated), the any-risk audit (unresolved types), the seeded order and the tier bounds in `selection-log.md`.
- Tracked vs working tree: I searched the working tree of a clean clone; `git ls-files` was not used. Equal counts with the first reader's `git grep` figures (apart from the `ɵ` effect) make a difference unlikely.
- Angular HTML templates, inline `template:` strings and non-`.ts` files, by the wording's own scope rule.
- The 30-word limit of roles: counted from `roles.json`, all 14 roles are 16 to 28 words; the "no path or file name" part of the rule was read, not machine-checked.
