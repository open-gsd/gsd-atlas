## Questions replaced by the audit (all logged in `selection-log.md` and `audit-exclusions.json`)

| replaced | category | class | finding | replaced by |
| --- | --- | --- | --- | --- |
| `Component` (core/src/metadata/directives.ts, interface) | references | key-likely-incomplete / ambiguous-wording | One merged symbol: an interface and the decorator constant `Component`. The oracle key lists 8 files and none of the hundreds of specs that apply `@Component(...)`; a reader following "uses of the declaration" would count them, and no role can separate the interface from the constant it is merged with. | `Component` (compiler/src/render3/r3_ast.ts, class), p-307 |
| `NgModuleFactory` (core/src/linker/ng_module_factory.ts) | heritage | ambiguous-wording | The same defect that excluded it from rule v1: one of its 2 subtypes is a class of the same name in the same package, reached through an alias. | `NgModuleRef` (same file), p-310, with the new heritage sentence about same-named subtypes |
| `chain` (core/src/resource/resource.ts) | impact | key-likely-overinclusive | The function has no call expression anywhere: it appears only as the shorthand property `{chain,}` of `paramsContext`, and callers use the interface member `ResourceParamsContext.chain`. The 11 key files (all forms/signals, none containing the word) come from the module-level container. | `registerLocaleData` (core/src/i18n/locale_data_api.ts), p-314 |

Replacements were taken by the generator as the next candidate in seeded order under the rule; none was chosen by hand. The `chain` finding is also a warning about the oracle: it follows an object-literal shorthand into the interface member and then through module-level containers; the v1 impact questions did not exercise this.

## Grep cost proxy per question (premise judged before any session)

"Grep files" is whole-word `git grep -l` over the whole tree (what a grep-first session sees); "scope" is the same restricted to the pilot scope; "other decls" is the number of other files that declare the same name at top level; "per key file" is whole-tree grep files divided by key files (how many wrong files a name search drags in). For comparison, rule v1 had 13 to 135 whole-tree grep files per question (median 25) and the calibration grep mean was 35.9k billable tokens.

| id | category | name | tier | key files | grep files (tree) | grep files (scope) | other decls | per key file |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| p-301 | callers | `untracked` | 2 | 39 | 93 | 51 | 1 | 2.4 |
| p-302 | callers | `visitAll` | 2 | 20 | 45 | 34 | 1 | 2.3 |
| p-303 | callers | `digest` | 2 | 4 | 55 | 46 | 1 | 13.8 |
| p-304 | callers | `stringify` | 2 | 29 | 246 | 160 | 2 | 8.5 |
| p-305 | references | `Text` | 1 | 14 | 164 | 94 | 3 | 11.7 |
| p-306 | references | `RuntimeErrorCode` | 1 | 8 | 182 | 170 | 9 | 22.8 |
| p-307 | references | `Component` | 1 | 40 | 2,989 | 1,099 | 2 | 74.7 |
| p-308 | references | `ChangeDetectionStrategy` | 1 | 46 | 162 | 70 | 3 | 3.5 |
| p-309 | heritage | `Validator` | 2 | 4 | 41 | 29 | 2 | 10.3 |
| p-310 | heritage | `NgModuleRef` | 2 | 3 | 53 | 30 | 1 | 17.7 |
| p-311 | impact | `recognize` | 2 | 4 | 43 | 22 | 1 | 10.8 |
| p-312 | impact | `translate` | 2 | 5 | 257 | 63 | 2 | 51.4 |
| p-313 | impact | `isArray` | 2 | 17 | 189 | 160 | 1 | 11.1 |
| p-314 | impact | `registerLocaleData` | 2 | 10 | 31 | 15 | 1 | 3.1 |
| p-315 | definition | `Version` | 1 | 1 | 75 | 23 | 2 | 75.0 |
| p-316 | abstain | `isInSkipHydrationCollector` | - | 0 | 0 | 0 | 0 | - |

Reading, without a model: the new set is much harder than v1 mainly in identification (no file is named, 1 to 9 same-named declarations, three of them in the same package as the target) and in `Text`, `Component`, `stringify`, `translate`, `RuntimeErrorCode`, where a name search returns 160 to 2,989 files. It is not uniformly harder: six questions have under 60 whole-tree grep files, four callers and impact keys are 4 to 5 files, and `registerLocaleData` (31 files, key 10) will probably cost about what a v1 question cost. Only 5 of 16 questions are tier 1 (the four references and the definition); callers, heritage and impact could be filled only from tier 2 (see `rule-v2.md`, amendments 1 and 2). Whether this raises the grep mean to the 68k floor is open; calibration decides.
