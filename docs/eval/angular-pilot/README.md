# Angular pilot: questions, keys and driver (unscored, unregistered)

Nothing here is registered. The registered verdict `OVERALL: MVP not met` stands; no registered file, key or result was touched. No model session has been run and no money spent.

Files here:
- `census-window.json`, `sample-keys.json`: the earlier census and prototype keys (plan sections 2 and 3).
- `pilot-questions.json`, `pilot-answers.json`: 16 questions (callers 5, references 3, heritage 3, impact 2, definition 2, abstain 1) and their oracle keys, in the registered shapes (they load through `scripts/eval/questions.ts`).
- `selection-log.md`: seed, rule, the selected rows and every skipped candidate with its reason.
- `key-audit.md`, `audit-notes.json`, `audit-preface.md`, `audit-exclusions.json`: the first-reader key audit and the two questions it replaced.

Regenerate (the pinned clone, read-only; seed 20261021):
- `node scripts/angular-pilot/generate.ts --repo <clone at 3cc1edf3> --out docs/eval/angular-pilot --exclusions docs/eval/angular-pilot/audit-exclusions.json`
- `node scripts/angular-pilot/audit.ts --repo <clone> --dir docs/eval/angular-pilot --notes docs/eval/angular-pilot/audit-notes.json --preface docs/eval/angular-pilot/audit-preface.md`
- `node scripts/angular-pilot/prepare-checkout.ts --repo <clone> --sha 3cc1edf3210a9debb0be57a4e99e53a54505db32 --dest <empty dir> --scratch <dir>` (strips agent config, records the manifest hash)

Print the plan without launching anything: `node scripts/angular-pilot/driver.ts --dry-run [--cap-usd N]` (96 sessions in 7 chunks, calibration batch, closed-book control, commands and guards). Sessions need `--launch --stage closed-book|calibration|pilot`; the notional cap defaults to 4 USD and only the owner raises it (ceiling 30).

Pending:
- a second reader (a different agent) for the key audit, and the owner's review of the 16 questions;
- the first model session of any kind: closed-book control, then the 12-session calibration batch, then the owner's confirmation of the cost cap;
- an atlas build of the prepared checkout with the merged indexer ignore rules (28f3952) before any atlas session;
- the analysis against the decision rules of the plan (section 6).
