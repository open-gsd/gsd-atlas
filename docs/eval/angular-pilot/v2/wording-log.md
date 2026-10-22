# Wording log (v2)

Records changes to the text of v2 questions after the keys were audited. Unscored, unregistered. Existing documents are not edited; this is a new file.

## 2026-10-21: p-313 `isArray` gets "a call in a class field initializer counts for the class"

**Why.** The second reader (`second-reader-audit.md`, p-313 section) found that no impact question says what a call inside a class field initializer counts for. The oracle attributes it to the class (by `new`): `enclosingUnit` in `scripts/angular-pilot/oracle-lib.ts` returns the class for a property declaration with an initializer. `key-corrections.md` recorded that the sentence was accurate but not added. This change adds it, for p-313 only, because that is the question whose key depends on it (`field/context.ts:139`, an arrow inside the field initializer `index = computed(...)`, counts for the class `FieldNodeContext`).

**What changed.** Only the `text` of p-313 in `pilot-questions.json`. In the nested-call clause, after "counts for the nearest enclosing declaration that has a name," the text now reads "a call in a class field initializer counts for the class, and a function that is only passed as a value has no callers". Nothing else in p-313 changed, and no other question's text changed.

**How.** `scripts/angular-pilot/select-v2.ts`: `questionTextV2` takes an optional `classFieldRule` (impact only; off by default, so every other impact question is generated exactly as before); `EntryV2` carries it to `buildFilesV2`. `scripts/angular-pilot/generate-v2.ts`: the constant `CLASS_FIELD_RULE_FOR` names the one entry (`isArray@packages/forms/signals/src/util/type_guards.ts`). Tests first: `select-v2.test.ts` (RED, then GREEN).

**Verification.** `generate-v2.ts` was rerun against the pinned clone (HEAD 3cc1edf3210a9debb0be57a4e99e53a54505db32, read only) with the committed `census-v2.json`, `audit-exclusions.json` and `roles.json`, writing into a scratch directory. `pilot-answers.json` came out byte-identical to the committed file (so keys, including p-313 at 19 files, are unchanged). `pilot-questions.json` differs from the committed file in exactly one line, the p-313 text; the 15 other question texts are byte-identical. The regenerated `selection-log.md` differs from the committed one only in the p-313 key size row (17 in the frozen log, 19 now; recorded in `key-corrections.md`); it was not copied over the frozen log.

**Effect on measurement.** The wording is fixed from here on for the 96-session pilot. The 12 calibration sessions used the earlier p-313-free question set (p-304, p-307, p-310, p-312), so none of them saw this question; calibration data are not pooled with the pilot in any case.
