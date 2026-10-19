# ADR handling before first release vs after (research for gsd-atlas)

## Current gsd-atlas process (from docs/adr/README.md, scripts/adr.ts, scripts/adr-ratify.ts)
- Files are `draft-<slug>.md` until "ratified": open a GitHub issue, `git mv` to `<issue#>-<slug>.md`,
  header Status Proposed -> Accepted, add `Issue:` and `Ratified:` lines, rewrite every `draft-<slug>` reference.
- `adr-ratify.ts` refuses any slug not in the hard-coded `RATIFIED_SLUGS` (PHASE1/2/3 lists) and refuses non-drafts.
- 12 ADRs numbered 2-9, 11-14 (issue numbers, so gaps: 1, 10 are not ADRs). 2 remain `draft-` (host-process-model,
  user-controlled-diagnostics). Status vocabulary: Proposed, Accepted, Superseded, Retired. Amendments are dated
  sections appended to Accepted ADRs (never rewrite). README says conventions follow gsd-core.
- Note: "ratified" here is doing two jobs at once: (a) assigning an identifier, (b) changing status. Owner's new rule
  separates them: nothing is ratified pre-MVP, issue numbers only for post-release changes.

## What the primary sources say
1. Nygard, "Documenting Architecture Decisions" (2011), https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
   - "Numbered sequentially and monotonically. Numbers will not be reused." Statuses: proposed, accepted,
     deprecated, superseded. Reversed decisions are kept and marked superseded, referencing the replacement.
   - Does not prescribe immutability explicitly; status may change over time.
2. adr.github.io / joelparkerhenderson collection, https://github.com/joelparkerhenderson/architecture-decision-record
   - ADRs are "immutable": amend with new information or supersede with a new ADR. Notes some teams prefer mutable
     "living" ADRs with dated notes. Skip ADRs for tiny, single-developer, or temporary decisions (workarounds, PoCs).
     Naming: lowercase-dashed present-tense verb phrase; no numbering rule.
3. MADR, https://adr.github.io/madr/
   - `NNNN-title-with-dashes.md`, consecutive numbers (4 digits). Optional front-matter `status`: proposed, rejected,
     accepted, deprecated, "superseded by ADR-0123". Numbers may be per-category if using subfolders.
4. adr-tools (Pryce), https://github.com/npryce/adr-tools
   - `adr new` creates the next numbered file; `adr new -s 9` supersedes ADR 9 and edits its status. README is silent
     on merge conflicts/renumbering (the known weakness of sequential numbering with parallel branches).
5. Log4brains, https://github.com/thomvaill/log4brains
   - Deliberately "no required file numbering schema" to avoid git merge conflicts; uses date prefix
     (`20200101-slug.md`). Statuses listed: proposed, accepted, deprecated, superseded.
     (Log4brains docs also have a "draft" notion for work-in-progress; not confirmed from the fetched page.)
6. UK GDS ADR framework, https://www.gov.uk/government/publications/architectural-decision-record-framework/architectural-decision-record-framework
   - Status is a required field, but no lifecycle or numbering rules given. ADRs reviewed regularly and "updated when
     the context or consequences change" (i.e. a living-record posture), escalation table by decision scope.
7. Rust RFCs, https://github.com/rust-lang/rfcs/blob/master/text/0002-rfc-process.md
   - Draft file is `0000-my-feature.md`; the number is assigned at merge and equals the PR number. Drafts are
     unnumbered; the identifier is issued by acceptance. This is the closest precedent for "draft-" then number.
8. Python PEPs, https://peps.python.org/pep-0001/
   - Author takes the next free number (not used by a published or open-PR PEP) or editors assign it; statuses
     Draft, Accepted, Final, Provisional, Deferred, Rejected, Withdrawn, Superseded, Active. Numbers are issued on
     submission, not on acceptance. "Provisional" = accepted for implementation but may still change after release
     pending feedback; PEP 1 prefers reducing scope over using it. Rejected/withdrawn records are kept.

## Synthesis
- Status lifecycle: everyone converges on Proposed -> Accepted -> (Deprecated | Superseded by N); PEP/RFC add
  Draft, Rejected, Withdrawn. Rejected/withdrawn are kept as records.
- Numbering drafts: two camps. (a) Number on creation, sequentially (Nygard, MADR, adr-tools, PEP): number is
  identity, stable; costs merge conflicts. (b) Number at acceptance (Rust: PR number; gsd-atlas today): drafts carry a
  placeholder, so rejected/abandoned ideas never burn numbers; costs a rename and link-rewrite step (which the
  repo already automated). Log4brains/date-prefix avoids the problem entirely.
- Issue/PR-linked numbers (Rust, gsd-core style) give free uniqueness and a discussion thread, but numbers become
  sparse and tied to the hosting platform. Sequential numbers are dense and portable.
- Migration/renumbering: no source recommends renumbering accepted records. Nygard: numbers never reused; MADR/PEP
  treat numbers as permanent identifiers. Practice: keep old numbers, add front-matter or a log mapping, and
  change the scheme going forward only. Renaming files breaks external links; this repo's script rewrites internal
  links only.
- Pre-1.0 "living" approach: sources support (i) keeping decisions Proposed/Draft while the design can still move,
  or (ii) allowing dated edits (GDS, joelparkerhenderson "living" variant, PEP Provisional) until a stability point,
  then freezing and amending only by dated sections/supersession after release. The "immutable" rule matters most
  once other people depend on the decision, i.e. after release. Inference: nothing in the sources demands
  immutability before anyone consumes the record, but amend-by-date is already how this repo behaves.
- Trade-off of "nothing ratified until MVP done": Status then carries less information (everything Proposed),
  so add a separate marker (e.g. Status: Accepted-for-MVP / "Provisional") or a "Baseline" tag; otherwise agents
  cannot tell settled decisions from open ones. Also re-evaluate in one batch at MVP: risk of a rubber-stamp review.

## Options for gsd-atlas
### Option A: Keep the 12 numbered files; stop issue-numbering for the rest; add a Provisional state (recommended)
- Leave `2-...14-` files and their links untouched (stable identifiers, no renumbering; matches Nygard/MADR/PEP
  "numbers are permanent"). Document that these 12 were numbered pre-release under the old rule.
- Remaining and new pre-MVP ADRs stay `draft-<slug>.md`, Status Proposed (Rust-like unnumbered drafts).
  Optionally downgrade the 12 from Accepted to a new `Provisional` (PEP precedent) via a dated amendment line rather
  than editing history, meaning "baseline for MVP, may still change, to be confirmed at MVP completion".
- At MVP completion: one ratification pass, then freeze (immutable + dated amendments + Superseded). Post-release
  enhancements use `<issue#>-<slug>.md` as the owner wants.
- Pros: zero churn, no broken links, honest status, matches owner's rule. Cons: mixed scheme (12 numbered, rest draft);
  `Provisional` is a new vocabulary item; gaps in numbers remain (already true).

### Option B: Revert the 12 to `draft-` names (un-ratify)
- Pros: uniform "pre-MVP = drafts, post-MVP = issue-numbered" story; truthful to "nothing ratified before MVP".
- Cons: contradicts every source (numbers/identifiers should not be reused or retracted); breaks links in PRD,
  DESIGN, plans, summaries, amendments and the "Ratified" log; GitHub issues #2-#14 already exist and are referenced
  externally; the ratify script would need a reverse path. High churn for a cosmetic gain.

### Option C: Switch pre-MVP ADRs to a different dense scheme (e.g. MADR `0001-` sequential or date prefix)
- Pros: removes dependence on issues; Log4brains-style date prefixes avoid merge conflicts for a solo+agents team.
- Cons: a third naming style on top of two; renumbering the 12 is Option B's problem again; not needed given a single
  maintainer plus agents (merge-conflict risk is low).

## Recommendation
Option A. Concretely: (1) amend adr-ratify/README so "ratify" is a post-MVP step and issue-number files are for
post-release; (2) add one status value (`Provisional` or `Baseline`) used for pre-MVP-settled decisions, recorded as
a dated amendment on the 12, not a history rewrite; (3) keep `draft-` + Proposed for the 2 outstanding ADRs and any
new pre-MVP ones, but allow dated edits to drafts; (4) freeze at MVP: promote Provisional -> Accepted in one logged
pass, from then on append-only with Superseded links. Remove the phase-gated `RATIFIED_SLUGS` coupling or retarget
it to the MVP gate.

Confidence/limits: facts about Nygard, MADR, adr-tools, PEP 1, Rust RFC 0002, GDS and joelparkerhenderson come from
fetched pages summarised by a small model; Log4brains "draft" status and adr-tools merge handling were not confirmed.
