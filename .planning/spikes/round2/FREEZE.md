# Round 2 freeze record

- **Frozen:** 2026-10-28, on the owner's instruction ("Freeze plan section 11 and go ahead with step 2").
- **What:** `docs/research/embedding-retrieval-spike-plan.md`, section 11 (from the heading "## 11. Confirmation round" to the end of the file). Exact text kept in `plan-section-11.frozen.md` beside this file.
- **sha256:** `ed37944aaa891aa1c034bc89250ee17b91bcae31858780a05da7c980f922afe7` (9,537 characters).
- **Repo HEAD at freeze:** `84c108597727eb3de9c74968a8a2781b0b2cf138`.
- **Owner decisions recorded at freeze:** (1) Authors for the vocabulary-gap set: the owner writes 50 queries; an independent fresh agent that has seen no result files, FTS5 output, `gold-a.json` or `gold-a2.json` writes 70 or more. (2) Mac only: no CUDA, Linux-node or CPU-only llama.cpp arms; other hardware is extrapolated and labelled. (3) Pool B and the macOS `sandbox-exec` network-denied run are approved by the instruction to proceed with Pool B extraction; `sandbox-exec` approval is still to be confirmed when that step is reached.
- **Changes after this point** to section 11 need a dated amendment below, not an edit to the frozen copy.

## Amendments
(none)

### A1 (2026-10-28): target eligibility for the vocabulary-gap set V2 (clarifies 11.3; not a change of rule)
Pool B has 9,558 documents: 833 from `@types/node` 24.19.2 and 8,725 from TypeScript 6.0.3 `lib.*.d.ts` (lib.dom 5,719; lib.webworker 1,970; ECMAScript libs about 1,000). `lib.dom` and `lib.webworker` repeat many declarations, so a target must be unambiguous. V2 targets are drawn with seed 31 from documents whose (member name, owning interface) pair is unique in Pool B, whose comment is at least 40 characters, and whose name is not a round 1 gold target. The draw is half from the `@types/node` part and half from the TypeScript lib part. The 140 drawn targets are split by the same seed: the first 55 go to the owner (50 queries needed), the next 85 to the independent agent (70 or more needed). Queries for targets that fail the overlap checker are dropped, not repaired after seeing search output.

### A2 (2026-10-28): checker rule and a disclosure
- **Checker:** `check-v2.mjs` implements 11.3's wording rule as: reject a query if it contains a word piece (3+ letters, crude stemming) of the target's name, owning interface or file name; or more than 1/3 of its content words (whole words after stemming) occur in the target's name, declaration or documentation; or its length is outside 5 to 18 words. It reads text only, never search output. Rejected queries are dropped, not repaired. The file-name part makes "dom" a forbidden word for `lib.dom` targets, which is stricter than needed and is kept.
- **Independent agent's queries:** 83 written, 2 targets skipped by the agent, 74 pass the checker, 9 rejected (kept in `agent-queries.raw.json`). That meets the "70 or more" requirement.
- **Disclosure:** a smoke test of the harness was run before the query sets were frozen, using the 56 round 1 queries as a stand-in for V2 and the real, unfrozen I1 set, with EmbeddingGemma 2 Q8_0 on Metal. It showed per-arm recall@10 on the I1 test half and the stand-in V2 halves, including that identifier-like misspellings score 0 for FTS5 and that router R1 sends them to FTS5. No set, arm, rule or threshold was changed afterwards. The I1 test-half numbers from that run are therefore not blind; the V2 sets (owner and agent queries, authored and checked without any search output) remain blind. This is reported in the round 2 results.

### A3 (2026-10-28): authorship of V2 changed to two independent AI agents (amends the owner decision recorded at freeze and 11.1)
At freeze, the authoring split was recorded as "owner writes 50, independent agent writes 70 or more". The owner clarified that this was a misreading of button text and that no human authoring was intended: all queries are AI-generated. V2 is therefore authored by two separate fresh AI agents, each given only its own target file and the wording rules, with no access to results, search output, round 1 gold sets or the other agent's queries: agent 1 (85 targets, 83 queries written, 74 pass the checker) and agent 2 (55 targets, file `ai2-queries.raw.json`). No human-written queries exist in V2. Consequence for validity: both authors are the same model family, so shared phrasing habits may correlate with the embedding models' training data and flatter the dense lane; this is a stated limitation of the confirmation round, not something it can rule out. File names `owner-targets.md` and the field "owner" in `v2-targets.json` keep their original names and mean "agent 2".

### A4 (2026-10-28): additional V2 targets to reach the 120-query minimum
11.3 requires at least 120 V2 queries. After the checker, agent 1 supplied 74 and agent 2 supplied 34 (21 of its 55 were rejected for name pieces or word overlap, and are dropped, not repaired), 108 in total. To reach 120 or more, 60 further targets are drawn by continuing the same seeded shuffles (positions 70 to 99 of the `@types/node` order and of the TypeScript lib order, then shuffled with seed 33; `sample-v2.mjs` with `EXTRA=1`; the original 140-target draw is unchanged) and given to a third fresh AI agent with the same brief, file `extra-targets.md`, output `ai3-queries.raw.json`. Authorship per query is kept (agent 1, 2, 3) so results can be reported per author. No search output has been consulted at any point in this step.

### Frozen query sets (2026-10-28, before any scoring)
- gold-v2.json (V2, 156 queries: agent1 74, agent2 34, agent3 48): sha256 680d40a06004a553ea8d97c0575dd43ff7e232a60c20fce493ef36c8e7b472c0
- gold-i1.json (I1, 84 queries, seed 32, unchanged since generation): sha256 84179a71955dfc2f96c2abdc480aa7224e12faad8de0772b30e77326cd88faf7
- gold-v2.authors.json (query id to author): sha256 f10f2d1c6b47b8cc6c246ac046e7c9e2f63424b2e677253b985e7f9fea4273fa
- Harness run-round2.mjs sha256 166b8b67a74ca5c96903bd01cec35f5e4480a65b1c16b7dff76baa3c352b343a; checker check-v2.mjs sha256 78c37edf5f74f5bbcea78809cd1879238721df209c1ab89d1b7f2e675925ffeb
- Split rule: fnv1a(kind|id) mod 10 < 3 is tuning, else test (harness). Primary arm: R1 with tuned weight. Test halves are scored once per model.
