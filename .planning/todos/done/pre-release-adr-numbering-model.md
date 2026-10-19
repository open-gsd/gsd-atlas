---
created: 2026-10-18
title: Set up the ADR numbering model before the final release
area: docs/adr
---

Decision (user, 2026-10-18): issue-numbered ADRs are for post-release enhancements and feature requests. Pre-release (MVP) ADRs are not ratified and get no issue and no number; they stay drafts (`draft-*.md`) until the MVP is done.

Before the final release, design and set up the model properly:
- how pre-release drafts become accepted, and when numbers are assigned;
- what to do with the Phase 1 and 2 ADRs that were already numbered with issues;
- split `scripts/adr-ratify.ts` into "accept" and "number at release";
- Phase 3 left `user-controlled-diagnostics` as an unnumbered draft (issue open-gsd/gsd-atlas#15 was closed as not planned); plan 03-21 / SKL-03 expects a ratified ADR and needs re-planning or a changed precondition.

A research pass on ADR best practices was started on 2026-10-18; see pre-release-adr-numbering-research.md in this folder.

Closed 2026-10-18 by plan 03-37. Option A of the research was applied: the twelve earlier records kept their numbers, Status, Issue and Ratified lines; the last two records (host-process-model, issue 16; user-controlled-diagnostics, issue 15, reopened) were numbered in one logged pass through one pull request (open-gsd/gsd-atlas#17); `scripts/adr-ratify.ts` renames only with `--gate mvp` and reads the gate list from the draft files present; every issue named by a record was closed; the legend, notes, README wording and tests were replaced by the final statements. Not done: no `Provisional` status value was added, and the earlier records were not renamed or re-headed.
