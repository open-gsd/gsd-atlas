# Proposal: redefine the 1.0 gate before any new data (option D)

**Status: proposal, not registered, not scored.** The registered verdict `OVERALL: MVP not met` (`analysis.md`) stands and is never edited. A gate defined here applies only to data collected after it is registered. Nothing below is applied to the 450 original rows, the replication, or the angular pilot.

Chosen by the owner on 2026-10-22 ("push, then 1"): option D of `reevaluation-options.md` section 1.2, redefine the hypotheses or thresholds in advance, on new data.

## 1. Why the old gate is the wrong question (reasons independent of the observed ratio)

The old gate (EVL-03: fewer billable tokens than grep on gsd-core) rests on an assumption that the evidence since the registered run does not support, for reasons about how the tool is delivered rather than about the 1.6x:

- A fixed context cost is paid by every session whether or not atlas is used. In the first request, registered atlas costs 10.8k tokens against grep's 6.0k (probe P1). Tool definitions are about 34% of session tokens, atlas results about 7.7% (probe P4). A token comparison therefore mostly measures definition size, not answer quality.
- Adoption is low. In the registered run only 34-38% of atlas sessions called a tool and none loaded the skill. In the angular v2 pilot adoption was 46.9% with registered tools and 6.3% with ToolSearch deferral.
- Where atlas is not called, the sessions are equivalent to grep plus overhead. A token gate cannot reward the product for correctness it provides only when called.
- Tokens are a proxy for cost and time. Priced cost was 1.19x on the registered data (`analysis.md`), a different and smaller gap than the raw token count.

The product's stated value (`PROJECT.md` core value) is correct, cited, current answers. The gate should measure that, with cost as a bounded constraint, not as the headline.

## 2. Proposed gate (for registration as a new, separate document)

All of it is judged on a **fresh question set on a corpus fixed in advance** (section 4), with both arms in the configuration an agent actually gets: grep arm G, and atlas with the registered tools and skill (A-reg). The ToolSearch-deferral variant (A-ts) is reported but is not the gated arm.

| Id | Hypothesis | Rule |
| --- | --- | --- |
| N1 | Correctness on structural questions | A-reg exact-set correctness minus G, paired by question, lower bound of the 90% interval above 0 (superiority), on the full fresh set. |
| N2 | Verifiability | Share of A-reg answers whose every claimed item carries a citation that resolves to the right file and line: at least 0.80 (the old H3 threshold, kept unchanged), and at least G's rate. |
| N3 | Cost is bounded, not minimised | Priced cost ratio A-reg / G, upper bound of the 90% interval at most **R_max** (owner to set, see section 5). |
| N4 | The tool is used | Share of A-reg sessions with at least one atlas call: at least 0.50 on questions in the structural strata (callers, references, impact). |

**Pass** = N1, N2, N3 and N4 all hold. **Fail** otherwise. No partial credit and no change of margins after data. A failure is a second documented miss, and both attempts are cited by any later registration.

Tokens are reported (billable and priced) but are not a pass condition except through N3. EVL-03 and EVL-04 in `REQUIREMENTS.md` currently say "fewer tokens"; changing that wording is a requirements decision recorded outside the eval (section 5).

## 3. What the existing evidence says about feasibility (descriptive only, not used to set margins)

Pilot v2, 96 sessions, 16 questions, audited keys (`angular-pilot/v2/pilot-audit.md`): exact-set correctness G 71.9%, A-ts 71.9%, A-reg 84.4% (n=32 sessions each, no interval computed for correctness). R was 1.22 (A-ts) and 2.25 (A-reg) on billable tokens. This is why N1 and N3 are the decisive conditions: N1 may be reachable, N3's bound decides whether the product is acceptable at its current context cost, and N4 depends on routing work (`diagnosis.md` section 9) that is a legitimate engineering fix to do before registration, on questions that are not the fresh set.

Two caveats that argue against reading the pilot as a prediction: the called sessions were less accurate than the not-called A-reg sessions (73.3% against 94.1%), and A-reg's non-calling sessions look like the better sessions, so the correctness gain may not come from atlas.

## 4. Design of the registered run (outline)

- **Corpus:** angular/angular (MIT) at a SHA fixed in the registration (the pilot used `3cc1edf3`; a later SHA is acceptable, a different corpus needs reasons given before data). The two-corpus plan (angular + gsd-pi) from the corpus survey is the alternative; pooling across corpora stays EVL-04's job.
- **Questions:** a fresh draw under rule v2 with a new seed, no overlap with p-201..p-216 or p-301..p-316, keys by the oracle plus a second-reader audit before any session. Size: at least 40 questions across the five categories; the pilot's 16 gives intervals too wide for N1. Questions stay blind to tool changes: engineering fixes are made first and frozen, then the questions are drawn.
- **Arms and runs:** G and A-reg, 3 runs each, concurrency 1. Order: 40 questions x 2 arms x 3 runs = 240 sessions, roughly 25 USD notional at the pilot's rates (8.27 USD per 96), several hours. A-ts as a third arm adds about 12 USD notional.
- **Engineering before registration (not part of the gate):** diagnosis items 1-3 (cut fixed footprint, make one call replace shell calls, fix routing for emit, heritage, ADR). These are decided and frozen with a commit hash before the question draw.
- **Controls:** same safeguards as every run (subscription login only, extra usage off, stop at 0.60 either window, no API key, pinned Claude Code version, model pin).
- **Registration:** a new document (not Revision 2 of the old one), its own approvals and hashes, citing the old verdict, replication and pilot.

## 5. Decisions the owner must make before registration

1. **R_max for N3.** The honest way to set it is by what the extra cost buys the user, before looking at the next data. The only numbers on the table are the old 1.19x priced ratio and the pilot's token ratios, which must not be used to tune it. A value is a judgement, for example whether an agent session may cost up to 1.5x or 2x grep for more accurate, cited answers.
2. **Requirements wording.** Whether EVL-03 and EVL-04 are amended to the N1-N4 form, or the new run is recorded as a separate claim with EVL-03 left failing. D-04 says a changed margin voids the claim, so the amendment must be a dated decision, not a silent edit.
3. **Phase 4.** Whether it stays blocked until this gate is met, or starts by an explicit recorded decision (option F) in parallel. The roadmap says the dependency is a decision, not technical.
4. **Corpus and size.** Angular alone with 40 questions, or angular plus gsd-pi.
5. **Whether N4 stays a pass condition.** Without it a correct but unused tool could pass by chance on N1; with it the gate also tests the routing fix.

## 6. What this does not do

- It does not change the registered verdict, the replication, the pilot, or any frozen file.
- It does not make the MVP met. Only a registered run that meets this gate would, and only against this gate.
- It does not claim the product wins on the new gate. The pilot suggests N1 may be reachable and N3 and N4 are uncertain.
