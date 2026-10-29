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
