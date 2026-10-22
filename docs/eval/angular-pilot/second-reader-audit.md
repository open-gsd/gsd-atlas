# Second-reader audit of the 16 angular pilot questions

**Second reader, exploratory, nothing registered.** Written by an agent that did not build the oracle or the keys. It re-derived each answer set from the wording alone, with a text-level method, before looking at `pilot-answers.json`; it did not use the compiler oracle and did not trust `key-audit.md`. No model session was run. Corpus: the pinned angular clone at `3cc1edf3210a9debb0be57a4e99e53a54505db32` (checked with `git rev-parse HEAD`, working tree clean, read only).

## Summary

1. All 16 keys equal my independently derived sets: 0 key-only and 0 mine-only items in every question (file sets for callers, references, impact; file+symbol for heritage; file+line for definition; empty for the abstain).
2. Class: 14 consistent, 2 ambiguous-wording (p-212, p-215). None key-likely-incomplete, key-likely-overinclusive or unverified.
3. Recommend: keep 14, reword 2 (p-212 materially, p-215 cosmetically), replace 0. The pilot's rule "more than 3 of 16 keys changed by the audit" is not triggered by this audit (0 keys change).
4. p-212 is the only question whose key depends on a reading choice: the call at `zone.js/lib/common/timers.ts:69` sits in anonymous callbacks, and the key attributes it to the nearest named enclosing function (`patchTimer`). Under "innermost function, anonymous included" the key would be 1 file, not 4.
5. p-215: the wording says "Another class named `CanDeactivate`", but the other declaration is `export interface CanDeactivate<T>` (`packages/router/src/models.ts:1107`). The answer is unaffected; the sentence is false.
6. The first reader's open item for p-202 and p-205 (a destructured use of the testing module) is closed: the one destructuring (`zone.js/test/zone-spec/fake-async-test.spec.ts:1260`) takes `tick` and `flush` from the zone.js fake-async module (an `any`), which is the other symbol, not the one in `core/testing`.
7. The anonymous class expression in p-210 is exactly one, `compiler/test/expression_parser/utils/unparser.ts:295`; the key excludes it as the wording says. The aliased heritage `RecursiveAstVisitor as AstVisitor` (`compiler-cli/preprocessor/src/selectorless.ts:16,22`) is in the key.
8. No overridden-abstract-method trap applies to the five callers questions: all five targets are free functions, not methods. Same-name methods (`flush`, `tick`) exist but are different symbols.
9. Traps that the keys handle correctly and a text-only solver can miss or over-count: aliased re-export `withEventReplay as ɵwithEventReplay` (p-201), a JSDoc example call in the declaring file (p-201), the near-copy package `compiler-cli/preprocessor/language-service` (p-204), alias heritage `T2ForeignComponentMeta` (p-207), three enums named `TokenType` (p-208).
10. Not checked: checker-level resolution of any-typed flows, git history of the abstain name, non-`.ts` files; see the last section.

## Method

- Scope applied as the wording says: `.ts` under `packages/`, spec and test files in, `.d.ts`, `schematics/`, `examples/`, `integrationtest/` out.
- Whole-word hits with ripgrep over `packages/` (a repo-wide grep was not blocked by the hook; the harness refused `git grep` in the clone, so ripgrep and small node text scripts were used instead). The scripts are throwaway, in the scratchpad, not in the repo: one lists, per file, every import or export statement that names the symbol (with its module specifier and aliases) plus the non-comment lines that mention it; one lists every `class` or `interface` header (named or anonymous) whose `extends` or `implements` part matches a pattern.
- Each hit file was classified at the hit lines and at the import specifier: call, value use, type-only use, import or export specifier, re-export, comment or JSDoc, string or template literal, different same-name symbol (resolved by import path and `export *` chain), alias or namespace use, inheritance, decorator or DI token, anonymous class expression.
- No `codegraph` use: the clone has no `.codegraph` index and is read only, so no index was created there.
- Probes for the first reader's gaps: (a) destructured or aliased `tick` and `flush`: import statements naming them, bare-call search `(?<![\w$.])tick\(` and `flush\(` over all of `packages/` (per-file counts, every non-import hit read), namespace imports of the testing module, `const {..} =` destructurings of all five callers targets; (b) anonymous class expressions: every class header with a heritage clause matching each heritage target; (c) abstract overrides: see summary item 8.

## Per-question table

Size means files for callers, references and impact; file+symbol items for heritage; file+line items for definition.

| id | symbol | category | key size | my size | key-only | mine-only | class | recommendation |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| p-201 | `withEventReplay` | callers | 3 | 3 | 0 | 0 | consistent | keep |
| p-202 | `tick` | callers | 4 | 4 | 0 | 0 | consistent | keep |
| p-203 | `bindingUpdated` | callers | 4 | 4 | 0 | 0 | consistent | keep |
| p-204 | `findTightestNode` | callers | 3 | 3 | 0 | 0 | consistent | keep |
| p-205 | `flush` | callers | 2 | 2 | 0 | 0 | consistent | keep |
| p-206 | `TemplateContext` | references | 19 | 19 | 0 | 0 | consistent | keep |
| p-207 | `ForeignComponentMeta` | references | 8 | 8 | 0 | 0 | consistent | keep |
| p-208 | `TokenType` | references | 2 | 2 | 0 | 0 | consistent | keep |
| p-209 | `Validator` | heritage | 8 | 8 | 0 | 0 | consistent | keep |
| p-210 | `RecursiveAstVisitor` | heritage | 17 | 17 | 0 | 0 | consistent | keep |
| p-211 | `Resource` | heritage | 3 | 3 | 0 | 0 | consistent | keep |
| p-212 | `isFunction` | impact | 4 | 4 | 0 | 0 | ambiguous-wording | reword |
| p-213 | `isTemplateNode` | impact | 2 | 2 | 0 | 0 | consistent | keep |
| p-214 | `SecurityContext` | definition | 1 | 1 | 0 | 0 | consistent | keep (optional phrase) |
| p-215 | `CanDeactivate` | definition | 1 | 1 | 0 | 0 | ambiguous-wording (minor) | reword (cosmetic) |
| p-216 | `getParentClassHandler` | abstain | 0 | 0 | 0 | 0 | consistent | keep |

## Detail: questions that are not consistent

### p-212 impact `isFunction` (packages/zone.js/lib/common/utils.ts:546) - ambiguous-wording, reword

Recomputed depth-two closure by hand.

- Direct callers (hop 1). `isFunction` (whole word) occurs in `zone.js/lib/common/timers.ts` and `utils.ts` only, among zone.js files. `timers.ts` imports it from `./utils` (line 13-19) and calls it at line 52 (`data.isRefreshable = isFunction(handleOrId?.refresh)`, inside the nested function declaration `scheduleTask`, line 36) and at line 69 (`if (isFunction(args[0]))`, inside an anonymous function returned by an anonymous arrow passed to `patchMethod`, itself inside `patchTimer`, line 28). `utils.ts` has no call of its own besides the declaration. The other `isFunction` symbols are different: `elements/src/utils.ts:42`, `router/src/utils/type_guards.ts:26`, `upgrade/src/common/src/util.ts:97`; `t.isFunction(..)` (babel) and `x.isFunction()` (linker AST value methods) are member calls.
- Containers of the direct calls (hop 2 sources). `scheduleTask` (named, nested): it is only passed as a value (`timers.ts:109`, argument to `scheduleMacroTaskWithCurrentZone`), never called, so it has no callers. The anonymous callbacks at line 69 have no name; their nearest named enclosing function is `patchTimer`.
- Callers of `patchTimer` (hop 2): `zone.js/lib/browser/browser.ts` (imports at line 15, calls from line 35), `zone.js/lib/node/node.ts` (import line 11, calls from line 48), `zone.js/test/common/setTimeout.spec.ts` (import line 9, calls at lines 84 and 164). `zone.js/test/node/timer.spec.ts` imports `taskSymbol` only. No other file names `patchTimer`.
- Closure, target file `utils.ts` left out: `timers.ts`, `browser.ts`, `node.ts`, `setTimeout.spec.ts` = 4 files = the key.

Is the formula applied consistently? Yes, if "contains a direct call" means the nearest enclosing function, method or class that has a name, with anonymous functions and arrow functions that are not bound to a name skipped (this is what `enclosingUnit` in `scripts/angular-pilot/oracle-lib.ts` does). Two other readings differ: (1) the innermost function counting anonymous ones: the line-69 call belongs to an anonymous callback with no callers, so the key would be `timers.ts` alone (1 file); (2) every lexically enclosing function: `patchTimer` and `scheduleTask` both contain the calls, same 4 files as the key. The wording does not say which, so a careful solver can land on 1 or 4.

Proposed wording change. Replace "plus files that call any function, method or class (by `new`) that contains a direct call to it" with: "plus files that call any named function, method or class (by `new`) in whose body a direct call to it appears; a call inside a nested function, a callback or an arrow function that is not bound to a name counts for the nearest enclosing declaration that has a name, and a function that is only passed as a value, never called, has no callers". Keep the key.

### p-215 definition `CanDeactivate` (packages/router/src/utils/preactivation.ts:35) - ambiguous-wording (minor), reword cosmetically

The key is right: `export class CanDeactivate` at `preactivation.ts:35`; `check_guards.ts:40` imports it from `../utils/preactivation`, line 81 is the type annotation `checks: CanDeactivate[]`. The wording says "Another class named `CanDeactivate` is declared elsewhere in the tree", but the only other declaration of the name in scope is `export interface CanDeactivate<T>` at `packages/router/src/models.ts:1107`. The claim is false as written, though it cannot mislead toward a wrong answer (searching for `class CanDeactivate` finds one declaration). The first reader's evidence line already names the interface, but the wording was not flagged.

Proposed wording change: "Another class named `CanDeactivate`" -> "Another declaration named `CanDeactivate` (an interface) exists elsewhere in the tree; it is a different symbol, and only the one used at that line counts." Keep the key.

## Evidence for the consistent questions

**p-201 `withEventReplay`** (platform-browser/src/hydration.ts:127). Whole-word hits in scope: 9 files. Calls of this symbol: `platform-server/test/event_replay_spec.ts` (many calls, imports it from `@angular/platform-browser` at line 26), `incremental_hydration_spec.ts` (177, 243, 306; import line 46), `transfer_state_spec.ts` (135; import line 20). Not calls: `hydration.ts:121` is a JSDoc example, 209 and 236 are `{@link}`/`@see`; `platform-browser.ts:29` is a re-export; `core/src/hydration/api.ts:345` calls the core function `hydration/event_replay.ts:77`, and `hydration.ts:128` calls `ɵwithEventReplay`, which is `core_private_export.ts:100` `export {withEventReplay as ɵwithEventReplay}` of the core function, so both are the other symbol. Set = 3 files = key.

**p-202 `tick`** (core/testing/src/fake_async.ts:140). 83 files contain the word. Files importing `tick` from the core testing module (`'../testing'` or `'@angular/core/testing'`): `core/test/change_detection_scheduler_spec.ts` (calls 728, 759, 996), `core/test/component_fixture_spec.ts` (380), `core/test/fake_async_spec.ts` (many calls), `platform-browser/test/testing_public_spec.ts` (260, 298). Bare-call search `(?<![\w$.])tick\(` finds no other file with a real call; `core/testing/src/fake_async.ts` has only JSDoc examples and the declaration; `testing.ts` is a re-export. Other `tick` are `TestBed.tick()`, `appRef.tick()`, `jasmine.clock().tick()`, zone.js `tick` (`zone-spec/fake-async-test.ts:1034`), a local `let tick` (`core/test/signals/computed_spec.ts:37`). No aliased import (`tick as ..`), no namespace import of the testing module. The only destructuring, `zone.js/test/zone-spec/fake-async-test.spec.ts:1260` `const {fakeAsync, tick, discardPeriodicTasks, flush, flushMicrotasks} = fakeAsyncTestModule;` with `fakeAsyncTestModule = (Zone as any)[Zone.__symbol__('fakeAsyncTest')]` (line 1259), reads the zone.js module, i.e. the other `tick`/`flush`, and is `any`-typed, so a type-checker would not link it to core either. Set = 4 files = key.

**p-203 `bindingUpdated`** (forms/signals/src/directive/bindings.ts:74). Importers from `./bindings`: `control_custom.ts` (34, 46), `control_cva.ts` (93, 101), `control_native.ts` (115, 131, 133), `form_field.ts` (271). The 15 other importers take the core function from `render3/bindings`. Declaring file has no call. Set = 4 files = key.

**p-204 `findTightestNode`** (compiler-cli/preprocessor/language-service/src/references_and_rename_utils.ts:67). Callers in the same package: `references_and_rename.ts` (176, 444, 614), `signature_help.ts` (96), and the declaring file itself (69 recursive, 277, 477). The 13 files under `language-service/src` import `./utils/ts_utils`, a different function (`ts_utils.ts:31`). Set = 3 files = key.

**p-205 `flush`** (core/testing/src/fake_async.ts:162). Import statements naming it: `change_detection_scheduler_spec.ts` (call 734), `fake_async_spec.ts` (5 calls); `testing.ts` is a re-export. All other bare `flush(` hits are declarations or comments of other methods (`resource_spec.ts:58`, `resource_loader_mock.ts:56`, `root_effect_scheduler.ts:38,103`, animation engines, `HttpTestingController` request `flush`, `override flush()` in animation renderer specs). Set = 2 files = key.

**p-206 `TemplateContext`** (compiler-cli/.../typecheck/extended/api/api.ts:49). Users resolved through `../../api` and `../api` (the `extended/api` directory): the declaring file (lines 40, 105, 118, 131), 17 `extended/checks/*/index.ts` files, `extended/src/extended_template_checker.ts` (23, 77) = 19 files. The importers of `../../../typecheck/api` or `../api` from `typecheck/src/context.ts`, `typecheck/testing/index.ts` and `annotations/component/src/handler.ts` take the other interface (`typecheck/api/context.ts:26`). `incremental_typecheck_spec.ts:643,727,812,890` and `change_detection_transplanted_view_spec.ts` hits are text inside template literals. Set = 19 files = key.

**p-207 `ForeignComponentMeta`** (compiler/src/render3/view/t2_api.ts:178). Uses of the compiler interface: `t2_api.ts:230` (own file), `t2_binder.ts` (import `./t2_api`; 9 uses), `compiler/test/render3/view/binding_spec.ts` (1691, 1706), and files that import it from `@angular/compiler`: `compiler-cli/preprocessor/src/compiler-utils.ts` (759, 763), `typecheck/api/checker.ts` (344), `typecheck/src/checker.ts` (474), `typecheck/testing/index.ts` (610, 614). Alias: `ngtsc/metadata/src/api.ts:18,27` `ForeignComponentMeta as T2ForeignComponentMeta` ... `interface ForeignComponentMeta extends T2ForeignComponentMeta` is a use in an `extends` clause. The other interface is that same-named declaration; its users (`foreign_component.ts`, `annotations/component/src/{handler,metadata,util}.ts`, `metadata/src/util.ts`, `scope/src/typecheck.ts`) import it through `../../../metadata`, `./metadata` or `./api` and are excluded. `compiler.ts` re-exports `t2_api` with `export *` (line 247). Set = 8 files = key.

**p-208 `TokenType`** (language-service/src/semantic_tokens.ts:62, a `const enum`). Users: the declaring file (130, 241), `language-service/test/semantic_tokens_spec.ts` (349-360). `language_service.ts:59` imports `TokenEncodingConsts` only. The other `TokenType` enums are `compiler/src/expression_parser/lexer.ts:11` and `compiler/src/ml_parser/tokens.ts:11` (with `compiler.ts` re-exporting the latter as `LexerTokenType`). Set = 2 files = key.

**p-209 `Validator`** (forms/src/directives/validators.ts). Heritage clauses naming `Validator`, from a scan of every class and interface header: `AbstractValidatorDirective implements Validator, OnChanges` (validators.ts:119), `interface AsyncValidator extends Validator` (325), `CustomValidatorDirective` (`forms/test/directives_spec.ts:56`), `CustomValidator` (`reactive_integration_spec.ts:85`), `NoOpValidator` (`reactive_integration_spec.ts:4114`, `template_integration_spec.ts:2447`), `LegacyControlWithValidators` and `LegacyControlWithOnValidatorChange` (`forms/signals/test/web/interop.spec.ts:182,249`) = 8 items in 5 files = key. Excluded correctly: the benchpress `Validator` subclasses (`RegressionSlopeValidator`, `SizeValidator`, `MockValidator` x2; different class), JSDoc examples (validators.ts:82, `forms/src/validators.ts:70`), subtypes of subtypes (`RequiredValidator` etc. extend `AbstractValidatorDirective`). No alias import of the interface exists.

**p-210 `RecursiveAstVisitor`** (compiler/src/expression_parser/ast.ts:741). 17 named direct subclasses (listing and lines in the scan: `CombinedRecursiveAstVisitor`, `SimpleExpressionChecker`, `PipeVisitor`, `DynamicAstValidator`, `ReplaceSpanVisitor`, test `Visitor`, `ASTValidator`, `ExpressionSourceHumanizer` (`e.RecursiveAstVisitor`, `e` = `expression_parser/ast`), test `AstVisitor`, `SelectorlessPipeAnalyzer` (alias `AstVisitor`), two `ExpressionsSemanticsVisitor`, `PipeExpressionVisitor`, `FunctionArgumentVisitor`, `EventTypeVisitor`, `ExpressionSpanVisitor`, `ExpressionVisitor`) = key. Excluded correctly: the anonymous `new (class extends RecursiveAstVisitor {..})` at `unparser.ts:295`; `PotentialTopLevelReadsVisitor extends o.RecursiveAstVisitor` (`extract_dependencies.ts:283`), where `o` is `outputAst`, the other class (`output/output_ast.ts:1732`); indirect subclasses of `CombinedRecursiveAstVisitor` (`IndexerVisitor`, `TemplateBinder`, two `AnimationsAnalyzer`, `SelectorlessDirectivesAnalyzer`, `TemplateVisitor`). `@angular/compiler` does not re-export the output-ast class under this name, so every `@angular/compiler` import is the expression-parser class. No other alias of the class exists.

**p-211 `Resource`** (core/src/resource/api.ts:90). Direct: `interface WritableResource<T> extends Resource<T>` (api.ts:134), `class SnapshotResource<T> implements Resource<T>` (from_snapshots.ts:25), `interface InternalRouterResource<T> extends Resource<T>` (router/src/router_resource.ts:47) = key. Different symbol: `interface ExternalResource extends Resource` in `compiler-cli/.../resource_registry.ts:26` (`Resource` there is its own interface, line 21). Indirect, correctly out: `ResourceRef`, `HttpResourceRef`, `BaseWritableResource`. No type alias of `Resource<..>` is used in a heritage clause.

**p-213 `isTemplateNode`** (language-service/src/utils/index.ts:103) - recomputed. Direct callers: `language-service/test/legacy/template_target_spec.ts` (about 57 calls, all inside anonymous `it` callbacks) and `utils/index.ts:80`, which is inside `isTemplateNodeWithKeyAndValue` (declaring file, left out). Different symbols: `platform-browser/src/dom/dom_renderer.ts:561` (local function), the copy in `compiler-cli/preprocessor/language-service/src/utils.ts:121`. Hop 2: callers of `isTemplateNodeWithKeyAndValue`: `language-service/src/template_target.ts` (495, 497, 515; imported from `./utils`), and `utils/index.ts:49` (declaring file, left out). The spec's containers are anonymous, so they add nothing. Closure = `template_target_spec.ts`, `template_target.ts` = 2 files = key; the formula is applied the same way as in p-212 (nearest named enclosing declaration), and here it is not sensitive to the reading.

**p-214 `SecurityContext`** (core/src/sanitization/dom_security_schema.ts:18). `i18n_parse.ts:12` imports it from `../../sanitization/dom_security_schema` (core); line 988 is the type annotation `let schemaContext: SecurityContext;`. The other enum is `compiler/src/schema/dom_security_schema.ts:18`, also at line 18, so the line number alone does not discriminate, the file does. Each file has exactly one declaration of the name (no merging, overload, namespace or interface with the same name); JSDoc above (lines 10-17) mentions the name but the declared name is on line 18. Optional: the line rule text names only function and class; add "for an enum the `export enum` line". Keep the key.

**p-216 `getParentClassHandler`** (abstain). Zero whole-word hits; zero case-insensitive substring hits for `getparentclasshandler` over the whole clone including ignored and hidden files and all file types; zero hits for the snake-case and split forms (`get_parent_class_handler`, `parent_class_handler`, `ParentClassHandl`). Closest names: `getParentClassDeclaration` (22 hits), `getParentClassMeta` (`language-service/src/references_and_rename_utils.ts:432`), `findParentClassDeclaration` (`core/schematics/utils/typescript/class_declaration.ts:25`, out of scope). None is a rename or variant of the asked name under a reasonable reading, so "no such function" is the correct answer.

## Discrepancies with the first reader's key-audit.md

- None in any key. All 16 classes agree with the first reader except the wording notes below.
- p-215: the first reader's evidence line states that the other declaration is an interface, but did not flag that the question text says "class". New finding (cosmetic).
- p-212: the first reader states the reliance on "textual containment in a nested function". I add that the key's 4 files rest on the line-69 call being attributed to `patchTimer` through anonymous callbacks, not on `scheduleTask` (which has no callers); a stricter reading gives 1 file. I classify this ambiguous-wording; the first reader classified it consistent.
- p-202 and p-205: the first reader's "not checked: a destructured use" is now checked (zone.js spec destructuring, other symbol, any-typed).
- p-213: the first reader did not recompute depth two beyond reading the unit and the callers by `git grep -w`; I recomputed it (hops listed above) and get the same set.
- Counts differ only by scope definition: `selection-log.md` shows grep-file counts of the whole tree (for example `tick` 135, `Resource` 83) and `key-audit.md` the pilot scope (83, 35). Not a discrepancy.

## What I could not check

- Checker-level resolution. My method is text and import-chain level. I followed import specifiers, `export *` chains (`metadata/index.ts`, `compiler.ts`, `core_private_export.ts`) and aliases by hand; I did not run the TypeScript checker, so a use reached only through an inferred type (a value typed from the symbol, accessed without naming it) is not counted by either method. For `tick` and `flush` this is where the 85 and 19 `any`-typed member sites sit; I checked that none is a bare call of the imported function.
- Not every one of the roughly 57 `isTemplateNode` calls in `template_target_spec.ts` was individually checked for its enclosing declaration; the closure does not change unless a named helper in that spec were called from another file, which spec helpers are not.
- Git history. `git` in the clone was not usable from this session, so a rename of `getParentClassHandler` in history, or in other branches, was not checked. Only the pinned tree was.
- Files that are not `.ts` (for example `.js`, `.html`, `.md`, BUILD files) were searched only for p-216. Out of scope by the wording for the other questions.
- Template-literal code in tests (for example `incremental_typecheck_spec.ts` fixtures declaring `TemplateContext`) was treated as text, as the wording says; I did not check whether any fixture string is compiled with the symbol.
- Whether the pilot's solvers will read "a call is ... a decorator use" or "use through an alias" the same way: not testable without model sessions.
- Windows or Linux differences: none expected (text scope), not tested.

## Recommendation per question

| id | recommendation |
| --- | --- |
| p-201 | keep |
| p-202 | keep |
| p-203 | keep |
| p-204 | keep |
| p-205 | keep |
| p-206 | keep |
| p-207 | keep |
| p-208 | keep |
| p-209 | keep |
| p-210 | keep |
| p-211 | keep |
| p-212 | reword: replace "that contains a direct call to it" by the exact sentence proposed in the p-212 section; key unchanged (4 files) |
| p-213 | keep |
| p-214 | keep (optionally add "for an enum the `export enum` line" to the line rule) |
| p-215 | reword (cosmetic): "Another class named `CanDeactivate`" -> "Another declaration named `CanDeactivate` (an interface)"; key unchanged |
| p-216 | keep |
