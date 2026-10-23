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
| N2 | Verifiability | Citation rate defined exactly as registered H3 (a session counts when its answer cites at least one file and line and every cited file and line verifies on disk; questions with an answer), judged on the point estimate with the interval reported: A-reg at least 0.80 (the old H3 threshold, kept unchanged), and at least G's rate under the same definition. (Earlier draft wording, "every claimed item carries a citation", was stricter than H3 and is dropped; see `offline-confirmation-2026-10.md`.) |
| N3 | Cost is bounded, not minimised | Priced cost ratio A-reg / G, upper bound of the 90% interval at most **R_max = 1.5** (owner decision, 2026-10-22). |
| N4 | The tool is used | Share of A-reg sessions with at least one atlas call: at least 0.50 on questions in the structural strata (callers, references, impact). |

**Pass** = N1, N2, N3 and N4 all hold. **Fail** otherwise. No partial credit and no change of margins after data. A failure is a second documented miss, and both attempts are cited by any later registration.

Tokens are reported (billable and priced) but are not a pass condition except through N3. EVL-03 and EVL-04 in `REQUIREMENTS.md` currently say "fewer tokens"; changing that wording is a requirements decision recorded outside the eval (section 5).

## 3. What the existing evidence says about feasibility (descriptive only, not used to set margins)

Pilot v2, 96 sessions, 16 questions, audited keys (`angular-pilot/v2/pilot-audit.md`): exact-set correctness G 71.9%, A-ts 71.9%, A-reg 84.4% (n=32 sessions each, no interval computed for correctness). R was 1.22 (A-ts) and 2.25 (A-reg) on billable tokens. This is why N1 and N3 are the decisive conditions: N1 may be reachable, N3's bound decides whether the product is acceptable at its current context cost, and N4 depends on routing work (`diagnosis.md` section 9) that is a legitimate engineering fix to do before registration, on questions that are not the fresh set.

Priced cost, from `priced-cost-and-baseline-regression.md` (descriptive; not used to set R_max, which was fixed first): the A/G priced ratio on the angular pilot was 1.510 for A-reg (90% bootstrap interval 1.238-1.794) and 1.104 for A-ts (0.985-1.223); the registered gsd-core run was 1.186 (1.137-1.236). So N3 at 1.5 is **borderline for the registered tool configuration as it stands**: the A-reg point estimate sits on the line and the interval's upper bound is above it. Cache reads are 74-88% of billable tokens but only 6-13% of cost; cache creation (tool definitions and context entering the cache) is 64-75% of cost. The cost is therefore driven by what is put into context, not by how many tokens are re-read, and the engineering fixes below target exactly that. Impact questions were the worst stratum (ratios 1.72, 1.41, 2.04).

Two caveats that argue against reading the pilot as a prediction: the called sessions were less accurate than the not-called A-reg sessions (73.3% against 94.1%), and A-reg's non-calling sessions look like the better sessions, so the correctness gain may not come from atlas.

## 4. Design of the registered run (outline)

- **Corpus:** angular/angular (MIT) at a SHA fixed in the registration (the pilot used `3cc1edf3`; a later SHA is acceptable, a different corpus needs reasons given before data). The two-corpus plan (angular + gsd-pi) from the corpus survey is the alternative; pooling across corpora stays EVL-04's job.
- **Questions:** a fresh draw under rule v2 with a new seed, no overlap with p-201..p-216 or p-301..p-316, keys by the oracle plus a second-reader audit before any session. Size: at least 40 questions across the five categories; the pilot's 16 gives intervals too wide for N1. Questions stay blind to tool changes: engineering fixes are made first and frozen, then the questions are drawn.
- **Arms and runs:** G and A-reg, 3 runs each, concurrency 1. Order: 40 questions x 2 arms x 3 runs = 240 sessions, roughly 25 USD notional at the pilot's rates (8.27 USD per 96), several hours. A-ts as a third arm adds about 12 USD notional.
- **Engineering before registration (not part of the gate):** diagnosis items 1-3 (cut fixed footprint, make one call replace shell calls, fix routing for emit, heritage, ADR), and the options ranked in `atlas-output-vs-explore-design.md`: (1) compact, file-grouped result rendering with citation and debug records opt-in; (2) a single `atlas_explore` tool; (3) optional inline source spans; (4) trimmed tool definitions (about 1.4k tokens). Option 5 (passive instructions or a hook) needs a trust-boundary ADR amendment first and is out unless that amendment is made. All are decided and frozen with a commit hash before the question draw. Two constraints from the evidence: byte cuts alone raised tokens 7% in an earlier probe, so a change must replace calls and not only shrink output; and H3 (citation) might depend on the citation records, which the offline check below found it does not. The nonce fence on repo text stays.
- **Offline confirmation before freezing (no new model sessions):** re-render the recorded atlas envelopes in the compact format and count bytes; replay the recorded multi-call sequences against a merged tool to count calls saved; count Read calls that follow an atlas call in the 225 recorded sessions (how often the matched line was not enough); repeat the first-request measurement of probe P1 with the new definitions. If these do not show a fixed-footprint cut of at least the size claimed, the fix is not frozen as a fix.

**Offline confirmation results** (`offline-confirmation-2026-10.md`, rules written before measuring; 305 recorded atlas-arm sessions: replication 76 called atlas, pilot v2 17, calibration 3; registered-run raw streams no longer exist, so the registered run is not in this population):

| Check | Verdict | Numbers |
| --- | --- | --- |
| A compact re-render | partly confirmed | 892 to 188 bytes per reference with the matched line kept (-79%); 8-reference page 7,616 B to 1,701 B (about 1,904 to 425 tokens, bytes/4). Lean variant median 136 B per reference against the rule's 100; the design note's 60 B was not reproduced. N2/H3 is computable from the compact fields (the scorer reads only the answer's file and line). |
| B merge replay | not confirmed | at most 46 of 142 calls saved; 1.48 calls per session that called atlas; 73% of called sessions have nothing to merge; 72% of the saving is `more` continuations. |
| C reads after atlas | not confirmed | 1 of 96 called sessions (1.0%) re-read a returned file within two turns; 9 of 96 if a grep counts. |
| D first-request footprint | confirmed on the calibrated metric | tools/list 9,267 B; trimmed definitions save 1.1-1.9k tokens; one-tool draft saves about 3.1k per request, first request about 7.5k against grep's 6.0k (1.25x). The calibration is unvalidated for shortened text. |

Consequences for the frozen-fix list: options 1 (compact rendering) and 4 (trimmed definitions, or a one-tool surface for its shorter definition) are supported. The call-merging part of option 2 is not: sessions already make about 1.5 calls and rarely re-read, so merging does not reduce calls much. Option 3 (inline spans) has little support from check C. The cost problem is the fixed footprint in every session, not the calls made. Unmeasurable offline: the first-request measurement with new definitions (needs a model), `code_context` under the compact format, any per-session cost. One surprise: only 64% of cited answer lines equal a row atlas returned (pilot v2: 8 of 38), so agents often cite lines atlas did not return, which bears on attributing any N1 gain to atlas.
- **Controls:** same safeguards as every run (subscription login only, extra usage off, stop at 0.60 either window, no API key, pinned Claude Code version, model pin).
- **Multi-question arm (amortisation), reported, not gated unless the owner decides so (decision 6):** every session so far answers one question, which charges the full fixed context cost to a single answer. Real use is longer. A third pair of arms, G-multi and A-reg-multi, puts 5 questions (one per category, drawn from the same fresh set, fixed order) into one session, 40 questions giving 8 sessions per arm per run, 3 runs: 48 sessions, about 5 USD notional at the pilot's rates before the longer contexts. Outcomes: per-question marginal priced cost (cost of question k minus cost of question k-1 within a session), and correctness by position. Pre-stated reading: if the A-reg-multi / G-multi priced ratio is lower than the single-question ratio, fixed cost is being amortised; if not, the single-question result is not hiding an amortisation effect. Nothing in the literature reviewed in `memory-tools-evidence-2026-10.md` tests this, so it is unmeasured. Risk: later questions can be answered from earlier context (leakage between questions), so the order is fixed and answers are scored per question with that caveat stated.
- **Registration:** a new document (not Revision 2 of the old one), its own approvals and hashes, citing the old verdict, replication and pilot.

## 5. Decisions the owner must make before registration (item 1 decided; 2 to 7 open)

1. **R_max for N3: decided, 1.5 times grep's priced cost (owner, 2026-10-22; recorded before any new data).** Original question: The honest way to set it is by what the extra cost buys the user, before looking at the next data. The only numbers on the table are the old 1.19x priced ratio and the pilot's token ratios, which must not be used to tune it. A value is a judgement, for example whether an agent session may cost up to 1.5x or 2x grep for more accurate, cited answers.
2. **Requirements wording.** Whether EVL-03 and EVL-04 are amended to the N1-N4 form, or the new run is recorded as a separate claim with EVL-03 left failing. D-04 says a changed margin voids the claim, so the amendment must be a dated decision, not a silent edit.
3. **Phase 4.** Whether it stays blocked until this gate is met, or starts by an explicit recorded decision (option F) in parallel. The roadmap says the dependency is a decision, not technical.
4. **Corpus and size.** Angular alone with 40 questions, or angular plus gsd-pi.
5. **Whether N4 stays a pass condition.** Without it a correct but unused tool could pass by chance on N1; with it the gate also tests the routing fix.

6. **Multi-question arm.** Whether it is included, and whether its priced ratio is only reported or a fifth condition (N5: multi-question priced ratio upper bound at most R_max). Recommendation: report only in the first registered run, because N1-N4 are already four conditions to meet, and its design has not been piloted.
7. **Fix freeze and N3 margin.** Because the registered configuration sits at 1.51 against R_max 1.5, either the engineering fixes are completed and confirmed offline before the draw (recommended, this section 4), or the owner accepts a likely N3 failure as a documented second miss. R_max stays 1.5 either way; it is not reopened after seeing data.

## 5a. Owner decision on the claim (2026-10-22)

Asked whether atlas's claim is cheaper structural answers or cited exact facts, the owner chose **cited exact facts**. Recorded here before any new data. Consequences for this proposal (drafting, not yet registered):

- **Headline condition.** The claim is that an agent gets exact, cited, current facts. N1 (correctness superiority) and N2 (citation rate, registered H3 definition) carry it. N3 stays as a bound on what the claim may cost, not as a goal; the product is no longer positioned as the cheaper path.
- **Question set must test the claim.** Structural questions grep answers from names do not test it. The fresh set should weight questions where exactness and completeness with a cited line are the point (full caller or reference sets, heritage, impact beyond a name match, ADR citations) and, if the owner includes it, platform-SDK facts (introduced/deprecated OS versions), where grep has no counterpart. The SDK-pack half has not been evaluated at all; whether it belongs in the first registered run is open decision 8.
- **Attribution.** Because only 64% of cited lines equal a row atlas returned, a correctness gain needs an attribution check: report correctness and citation rate separately for sessions that called atlas and sessions that did not, and treat N4 (atlas used) as required for the claim to be about atlas.
- **Documents that currently say the opposite** and would need dated amendments, not silent edits (none made yet): `.planning/PROJECT.md` key decision "Beats grep = fewer tokens", `.planning/REQUIREMENTS.md` EVL-03 and the "beats grep" definition at its top, `docs/DESIGN.md` A32 "Atlas must be the cheaper path", ADR 13 (MCP contract: "cheaper than grep") and ADR 14 (value dashboard premise). ADRs are append-only with dated amendments; this proposal does not amend them.
- **Open decision 8.** Include the platform-SDK facts in the first registered run, or run the code-fact gate first and the SDK gate separately.

## 6. What this does not do

- It does not change the registered verdict, the replication, the pilot, or any frozen file.
- It does not make the MVP met. Only a registered run that meets this gate would, and only against this gate.
- It does not claim the product wins on the new gate. The pilot suggests N1 may be reachable and N3 and N4 are uncertain.
