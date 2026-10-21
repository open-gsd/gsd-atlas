# Key set v2 (proposal)

This directory is a PROPOSAL for a corrected key set. It is not registered and replaces nothing: the registered questions, keys, scorer and the verdict `OVERALL: MVP not met` stand unchanged and nothing here rescored any result.

- Files: `questions.v2.json` and `answers.v2.json` (75 questions, same schema as the registered files, validated with the registered loader), `changes.md` (per-question diff, rules, evidence, unresolved forms, checks).
- 61 questions are carried unchanged. 14 differ: 7 corrected, 4 reworded and corrected, 3 decided as proposed (wording gave two readings; the user chose on 2026-10-21, see the Decisions section of `changes.md`).
- Question wording changed for 7 questions (q-012, q-022, q-024, q-028, q-030, q-065, q-067) to state the counting rule explicitly.
- A new registration would need: a new document version, a freeze with its own hashes, approvals, and fresh sessions.
- v2 keys were derived AFTER the registered results and the replication were seen, so any accuracy measured under v2 is not a blind test. The sanity table in `changes.md` is exploratory and was not used to tune any key.
- Regenerate with `node scripts/key-oracle/derive-v2.ts` (reads the pinned gsd-core commit from a local clone with read-only git; set `GSD_CORE_REPO` to the clone path; add `--streams <dir>` for the sanity table).
