# Offline confirmation of the design-note claims (unregistered, 2026-10-22)

Status: supplementary and unregistered. Analysis of recorded data only: no model session, no network, no new Claude run, no API key. The registered verdict `OVERALL: MVP not met` stands and is not reinterpreted here. Nothing under `src/` or any frozen file is changed. This note carries out the four measurements listed in `gate-redefinition-proposal.md` section 4 ("Offline confirmation before freezing") against the claims of `atlas-output-vs-explore-design.md`.

## Decision rules (written before measuring)

These rules were committed before any number was computed. They are not edited afterwards; a change would be appended as a dated note below this section.

What was looked at before writing them (no figure was computed): the design note, the gate proposal, the probe notes (calibration of tool-definition tokens: about 3,500 tokens for the 9,267-byte `tools/list`, i.e. about 0.38 tokens per byte), the shape of one recorded stream, and the file list of the recorded data.

Conventions used by every rule: "tokens" are bytes/4 unless a rule says calibrated; calibrated means bytes x 0.378 (P1: 3,500 tokens for 9,267 bytes of definitions), which applies only to tool definitions. Populations are named in the results. A result is "confirmed" only when the rule's condition holds as written; "not confirmed" means the condition failed or could not be evaluated; "partly" is used only where the rule defines it.

### A. Compact re-render

Claim in the design note (summary item 6 and option 1): about 940 bytes per reference now against about 60 bytes for `path:line enclosing`, a page of about 7.5 KB with 8 references.

- Confirming: over all recorded atlas results that carry references (`code_refs`, `code_impact`, `code_find`), the compact format with the matched line included cuts bytes per reference by at least 70% (aggregate and median), and the compact form without the matched line (path:line plus enclosing) has a median at or below 100 bytes per reference. Both must hold.
- Partly confirmed: the cut with the matched line is between 50% and 70%, or the no-text median is between 100 and 150 bytes.
- Not confirmed: the cut with the matched line is under 50%, or the no-text median exceeds 150 bytes.
- Bytes per reference are measured on the recorded results; the "about 940" figure is checked as the aggregate of recorded `code_refs` pages (bytes / references), and is reported as not confirmed if it differs from 940 by more than 25%.
- N2/H3 computability: confirmed computable from the compact fields if the scorer's inputs (the answer's `items[].file`, `items[].line`, and the key's needles verified on disk) do not read any record the compact format drops. Not confirmed if any scorer input or any model-side step needed to produce a verifiable `file`+`line` depends on a dropped field, in which case the note names the field.

### B. Merge replay

Claim: a single `atlas_explore` tool brings calls per question from 3 to 4 down to 1 to 2.

- Replacement rule (strict, the one the rules are judged on): inside one session, consecutive atlas calls (`code_find`, `code_refs`, `code_context`, `code_impact`, including `more` continuations) with no other atlas call on a different symbol between them are replaced by one call when they share the same symbol name (the `name` input, or the `target` resolved by the preceding `code_find`). A call on a different symbol starts a new group. Non-atlas calls between atlas calls do not break a group. A looser upper bound (all atlas calls of a session on one question merged into one call) is also reported but is not judged on.
- Confirming (the claim "3 to 4 down to 1 to 2" holds on the recorded data): among sessions with at least one atlas call, the mean number of atlas calls is at least 3 and the strict rule saves at least 1 call in at least half of those sessions.
- Partly confirmed: the strict rule saves at least 1 call in 25% to 50% of the sessions with an atlas call, or the mean atlas calls per calling session is between 2 and 3.
- Not confirmed: the strict rule saves a call in under 25% of the sessions with an atlas call, or the mean atlas calls per calling session is under 2.
- Reported either way: calls saved per session and in total, the distribution, and the fraction of all atlas sessions (called or not) in which nothing can be merged. The result is an upper bound for the recorded behaviour of the recorded tools, never a prediction of what a model would do with a merged tool.

### C. Reads after atlas calls

Claim (option 3): a Read follows an atlas call on the same file within two turns often enough to matter; the note says the option is falsified if under 20% of called sessions Read afterwards.

- Population: sessions with at least one atlas tool call. The proposal's "225 recorded atlas sessions" is taken to be the 225 atlas-arm sessions of the clean-room replication streams (the same 225 as probe P4); this is checked and stated. The angular pilot sessions are reported as a separate population and not pooled.
- Counted: after the first atlas call of a session, each `Read`, each `Grep`, and each `Bash` call that reads a file (a command whose first utility is cat, sed, head, tail, nl, awk, less, or grep/rg with an explicit file operand). A call "targets a file atlas had just returned" when its file operand, normalised to the repo root, equals a `path` in an atlas result returned earlier in the same session, and it occurs within two assistant turns of that result ("two turns" as in the design note).
- Confirming (signal present): at least 20% of the sessions with an atlas call contain a Read or Bash file read of a file atlas had returned within two turns.
- Not confirming (falsified, in the note's own words): under 20%.
- Search-style Grep and Bash greps with no file operand are reported as their own category and are not counted toward the signal. Report per category and overall.

### D. First-request footprint

Claims: the trimmed definition set saves 1.4k tokens per request (measured in P1); a one-tool surface has 0.5k to 0.7k tokens of definition and saves about 2.8k tokens per request; atlas first request is 10.8k against grep 6.0k (P1).

- Measured by calling the server's `tools/list` locally (no model) and by counting the instructions and skill file bytes; the drafts are kept in this note, not in `src/`.
- Confirming for the trim: the trimmed set (the three tools find, refs, impact with shorter descriptions, without `lang_list`, `atlas_status`, `code_explain`) is smaller than the current set by at least 1,200 calibrated tokens (within about 15% of 1.4k).
- Confirming for the one-tool surface: the drafted definition is at most 0.7k calibrated tokens and the saving against the current seven definitions is at least 2.4k calibrated tokens (within about 15% of 2.8k).
- Not confirming: the trim saves under 1,000 calibrated tokens, or the one-tool draft costs more than 1.0k calibrated tokens, or saves under 2.0k.
- In between: reported as partly confirmed.
- Parity statement (no threshold, arithmetic only): atlas first request after the saving, 10,814 minus the saving, against grep 6,034.
- A byte count by bytes/4 and the calibrated count are both reported; the calibrated figure is the one the rule is judged on, because it comes from the P1 measurement.

## Results

(To be filled after measuring.)
