## Questions replaced by the audit

The first run of `generate.ts` selected two questions the audit then found defective; both are listed in `audit-exclusions.json` and the selection took the next candidate in seeded order. They are also in the skipped table of `selection-log.md`.

| replaced | category | class | finding | replaced by |
| --- | --- | --- | --- | --- |
| `NgModuleFactory` (core/src/linker/ng_module_factory.ts) | heritage | ambiguous-wording | The key had 2 subtypes: `render3/ng_module_ref.ts` `class NgModuleFactory extends viewEngine_NgModuleFactory` (found through an alias, and itself named `NgModuleFactory`) and `router_preloader.spec.ts` `BrokenModuleFactory`. The wording says a same-name class elsewhere is a different symbol whose subtypes do not count, which a reader could take to exclude the same-name subclass. Text reading finds the alias form only when the alias is followed. | `Resource` (p-211) |
| `getLocalePluralCase` (common/src/i18n/locale_data_api.ts) | impact | key-likely-incomplete | The only direct caller is `NgLocaleLocalization.getPluralCategory`, an override of an abstract method. The compiler key follows the exact method symbol (callers: `localization_spec.ts`); `getPluralCategory()` in the same file calls the abstract method, so ng_plural.ts and i18n_plural_pipe.ts reach the function through polymorphic dispatch and a reader could count them. | `isTemplateNode` (p-213) |

Two wording defects found in other questions were fixed in the generator (all questions regenerated): heritage questions now say that only named classes and interfaces count (p-210 has an anonymous subclass in a spec that the oracle cannot name), and the audit's own line classifier was fixed for multi-line template literals and namespace member accesses (`o.RecursiveAstVisitor`).

What the audit did not do: it is one reader, text level for the grep side; it did not recompute depth two for p-212 and p-213 beyond reading the unit and the callers by `git grep -w`; it did not check the model's `any`-typed flows beyond the oracle's own any audit (0 sites for 13 questions; p-202 and p-205 have 85 and 19 sites that are member accesses on untyped jasmine and zone objects, and p-212 has 2); a second reader and the owner's review of the 16 questions are pending.
