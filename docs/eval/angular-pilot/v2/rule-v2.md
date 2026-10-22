# Question rule v2 for the unscored angular pilot (written 2026-10-21, before any question is drawn)

**Unscored, unregistered, pilot only.** The registered verdict `OVERALL: MVP not met` stands; nothing registered is touched. Rule v1 (seed 20261021, the 16 questions `p-201`..`p-216`) is unchanged and stays as it is. This file is committed on its own, before any v2 candidate is looked at.

## Why a second rule

The calibration batch (`../calibration-notes.md`) failed the premise check: grep sessions (G) averaged **35,933** billable tokens against a floor of 68,000 and a failure line of 55,000, and answered in 2 to 5 Bash calls with an exact key. Three properties of rule v1 handed grep the target or kept the work small: every question named the declaring file (the grep arm starts at the answer), keys were capped at 25 files, and candidates were drawn from a window of 10..150 grep files, which is the window in which a name search is cheap. Rule v2 removes the file from the wording, draws from the ambiguous tail only, and widens the keys. It does this without making the questions unfair: a person holding only the wording must be able to find exactly one target symbol, and the oracle must still be able to compute an exact key.

## What was looked at before this commit

Only aggregate counts of a re-run of the existing census (`scripts/angular-pilot/census.ts --with-tests` over the pinned clone, all 699 declarations of the 302 ambiguous names, without the 150-file ceiling of `census-window.json`), by category and bound, with no candidate names printed. That is the same kind of information as the census section of the plan. No oracle key, wording or declaration of any v2 candidate has been read. The bounds below are the owner's brief verbatim; whether the supply meets them is settled in the amendment section, committed after this rule and before any generation.

## Fixed parameters

- Pin `3cc1edf3210a9debb0be57a4e99e53a54505db32`; oracle `angular-pilot-1` (the v1 oracle, TypeScript 6.0.3, spec and test files in scope); scope exactly as v1 (`SCOPE_RULE` in `scripts/angular-pilot/select.ts`).
- **Seed 20261022** (new; v1 used 20261021, the registered run 20261017). Candidates are ordered by `sha256("20261022\0<name>@<declaring file>")`, ascending. One question per distinct name across all categories.
- Ids `q2-301`..`q2-316`, in the order callers, references, heritage, impact, definition, abstain.
- Definitions. *Grep files*: tracked files of the whole tree that contain the name as a whole word (`git grep -l -w -F`). *Other declarations*: exported top-level declarations of the same name in other non-test files of `packages/` (the census `otherDeclFiles`; kind need not match). *Key size*: files for callers, references and impact; named classes and interfaces (items) for heritage.

## The rule

**(a) Targets are identified without the declaring file.** The wording of callers, references, heritage and impact questions names the target by (1) the symbol name, (2) its kind, (3) the package, written `@angular/<directory under packages/>` (for example `@angular/forms`, `@angular/compiler-cli`; `zone.js` for `packages/zone.js`), and (4) a one-line **role description** written by hand from the declaration (its signature and doc comment), beginning "the interface that ...", "the function that ..." and so on. The role must (i) tell this declaration apart from every other declaration of the same name in the tree, including those in the same package, (ii) be at most 30 words, (iii) contain no path separator, no file name or basename, no directory name other than the package, and no line number. The wording says in a fixed sentence how a same-named declaration is told apart: a declaration is the target only if it is in the named package and fits the description; any other declaration of the name is a different symbol, and its uses, calls and subtypes must not be listed. The generator rejects a wording that contains the declaring path or the basename of the declaring file. The question *key* still carries `definedIn` (the frozen shape requires it); the driver prompt uses the question text only. Definition questions are the exception: they are identified by a use site (file and line of a use), which does not name the declaring file; they carry no role. The abstain question is as in v1.

**(b) Candidates come from the ambiguous tail.** A candidate is a declaration with grep files >= 60 and at least 2 other declarations of the same name in other non-test files, so that identification itself costs grep work; the declaring file was last changed on or after 2026-01-01 (contamination mitigation, as v1; dates from `git log -1` over a full-history fetch of the pinned commit). Kind pools as v1: callers and impact take functions and constants with call sites, heritage classes and interfaces with direct subtypes, references and definition any kind.

**(c) Wider keys.** Callers key 8..60 files; references key 8..60 files; impact depth-two key 10..80 files (and at least one file reached only at depth two); heritage key 4..30 named classes or interfaces (anonymous class expressions are excluded as in v1). Definition: exactly one declaration, a use site outside the declaring file and outside tests. Exact-set on a large key is brittle, so both measures exist and are both reported by the driver: **exact-set equality** (the answer set equals the key) and **matched / missing / extra counts**. For the premise check neither matters: tokens are what is measured. For correctness the primary measure is exact-set equality (as the plan's decision rules), with matched/missing/extra as the descriptive measure that shows a near miss on a wide key.

**(d) Mix of 16:** callers 4, references 4, heritage 2, impact 4, definition 1, abstain 1. Impact and wide references are where grep is expected to be costly.

**(e) Counting rules** are the v1 text blocks: `SCOPE_RULE`, `USE_RULES`, `FORM`, the call definition for callers and impact, the heritage text (named classes and interfaces only; alias heritage counts; spec and test declarations count), the definition line rule (including "for an enum the `export enum` line"). From the second reader's findings: every impact question carries the corrected sentence (a call inside a nested function, a callback or an unnamed arrow function counts for the nearest enclosing declaration that has a name; a function that is only passed as a value has no callers), and a sentence about another declaration states its kind (key-set-v2 lesson: never say "class" when it is an interface). Calls inside the declaring file count, and the declaring file is left out of an impact answer; the wording says "declaring file" instead of naming it.

**(f) Exclusion.** A candidate is skipped when the first-reader audit finds an unresolvable key defect (class `ambiguous-wording`, `key-likely-incomplete` or `key-likely-overinclusive` that wording cannot fix), when the wording does not identify exactly one target, or when the oracle's any-risk audit reports at least one site where the name is used through a type the compiler could not bind (any package, not only compiler-cli and language-service as in v1). Every skipped candidate is logged with its reason in `selection-log.md`; a replaced question is the next candidate under the rule, and the replacement is logged too. Processing order is heritage, callers, impact, references, definition (scarcest pool first).

**(g) Contamination mitigation** as v1: declaring file changed on or after 2026-01-01, where that still leaves enough candidates (see the amendment).

## Premise check, again

After calibration (not run by this task) the grep mean billable tokens, over a calibration batch that includes the new impact and wide-reference questions, must be **>= 68,000** to proceed; **< 55,000** means the premise failed again. Between the two the owner decides. If it fails, **nothing happens automatically**: report the numbers, the per-question tokens and the grep cost proxies, and stop; no rule v3 is drafted and no session is run without the owner. Registered files are never touched either way.

## Grep cost proxies reported per question

For each selected question the selection log and key audit give: whole-word grep files over the tree, the number of other same-named declarations, the key size, and grep files per key file.

## Pending

A second reader (a different agent) for the v2 key audit and the owner's review of the 16 questions. No model session has been run for v2 and none is run by this work.
