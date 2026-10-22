# Key corrections (v2)

## 2026-10-21: p-313 `isArray` grows from 17 to 19 files

Found by the second reader (`second-reader-audit.md`, p-313 section), who derived 19 files by hand where the key had 17.

**Bug.** `classify` in `scripts/angular-pilot/oracle-lib.ts` kept a reference only when `symbolOf(id) === targetSym`. A member reached through an instantiated generic type (`ArrayMergeLogic<DisabledReason>`, `ArrayMergeIgnoreLogic<..., null>`, a subclass of `Box<number>`, an alias of `Box<string>`) is a transient symbol (`CheckFlags.Instantiated`) that is not `===` to the declared member, although its `declarations` are the same node. Checked on a minimal program: both the instantiated and the subclass call returned `transient = true`, same declaration, not identical. The hop-two lookup of `ArrayMergeIgnoreLogic.compute` therefore dropped every call made through such a receiver.

**Fix.** `sameSymbol` accepts identity, or, when at least one side is transient, an identical declaration list. Ordinary symbols still compare by identity. Alias following (`getAliasedSymbol`), shorthand properties, import/export specifier roles and same-name-different-symbol are unchanged. Tests: `scripts/angular-pilot/oracle-generic.test.ts` (RED bf04a09, GREEN 9a3067e), including a same-named function in another file that stays a different symbol.

**p-313 key.** Old: 17 files (8 direct, 9 via callers). New: 19 files (8 direct, 11 via callers). The two added files, both calls of `ArrayMergeIgnoreLogic.compute` reached from `schema/logic.ts:166` (calls `isArray`):
- `packages/forms/signals/src/field/state.ts:112` (`disabledReasons.compute(...)`, receiver `ArrayMergeLogic<DisabledReason>`)
- `packages/forms/signals/test/node/logic_node.spec.ts:38` and about 35 more lines (`syncErrors.compute(...)`, receiver `ArrayMergeIgnoreLogic<ValidationError.WithFieldTree, null>`)

**Other keys.** The v1 generator (`generate.ts`) and the v2 generator (`generate-v2.ts`) were rerun with the fixed oracle against the pinned clone (3cc1edf3210a9debb0be57a4e99e53a54505db32), with the committed exclusions and roles. All 16 v1 answers and questions are byte-identical; all 16 v2 questions are byte-identical; all v2 answers are byte-identical except p-313. The v1 questions are not affected. Only the list of skipped candidates changed in two non-key places: the committed `selection-log.md` rows (v1: skipped `visitAll` key size 30 became 31, still outside 2..25; v2: the p-313 row shows 17 and would show 19). Those logs were not edited (they are frozen), so the v2 log still says 17 for p-313; this file is the record.

**Wording.** `pilot-questions.json` is unchanged. The oracle attributes a call inside a class field initializer to the class (by `new`), as `enclosingUnit` treats a property initializer as the class; the sentence "a call in a class field initializer counts for the class" is therefore accurate but was not added to the question text.
