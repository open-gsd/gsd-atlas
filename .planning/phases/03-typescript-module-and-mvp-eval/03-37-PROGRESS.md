# Plan 03-37 progress (not the SUMMARY)

Status at the end of the first segment: Task 1 done, stopped at the Task 2 blocking-human checkpoint. Nothing was sent to GitHub, nothing was pushed, no draft was renamed.

## Task 1 (tracer)

- RED: `2cad2e5` (the test file imports exports that do not exist yet: `does not provide an export named 'MVP_GATE'`).
- GREEN: `ba7dce5` (`scripts/adr.ts` helpers, `scripts/adr-ratify.ts` flags and gate).
- `node --test scripts/adr.test.ts`: 75 tests, 0 failures (41 before). The 13-entry history is still pinned by its test.
- The integration block derives its expectations from the files present. It was also run on a temporary copy after both drafts were renamed by the real script (git repository in the scratchpad): 75 of 75 pass, `--list-gate` prints nothing, `--list-issues --numbers` prints 14 numbers.
- Full run: typecheck, lint, build and `npm test` clean (4651 tests, 0 failures, 2 skipped as before); `node scripts/eval/verify-prereg.ts` prints ok.

## Gate list read from the files present (Task 2 input)

- `--list-gate`: host-process-model, user-controlled-diagnostics.
- `--list-issues --numbers` (local, no GitHub): 2 3 4 5 6 7 8 9 11 12 13 14.
- `host-process-model` needs a new issue. `user-controlled-diagnostics` reuses issue 15 (closed as not planned, reopened by the pass).

## Read-only GitHub state at the checkpoint (2026-10-18)

- Authenticated as the repository owner's account with ADMIN permission on open-gsd/gsd-atlas; default branch `main`, not protected, merge commits allowed.
- Issues 2 to 9 and 11 to 14: OPEN, each passes the own-issue check (`ADR:` title, body names the record's draft file).
- Issue 15: CLOSED / NOT_PLANNED, passes the own-issue check.
- Numbers 1 and 10 are pull requests (closed) and are not touched. No issue exists for the host process model record. No branch `adr/mvp-gate-ratification` and no open pull request exist.
- Remote base: `origin/main` is `d23b44c` and is an ancestor of the integration branch, which is 152 commits ahead of it; only the plan's own commits name 03-37. The base is NOT pushed, so Task 3 step 5 would stop. The person pushes the integration branch first (as with "push main first"), then the checkpoint is re-run.

## Approval reply

Reply to the Task 2 blocking checkpoint, verbatim, 2026-10-18: `approve ack-verdict`. It contains `approve` and `ack-verdict` (the registered verdict is `OVERALL: MVP not met`, so `ack-verdict` is required) and satisfies the reply grammar. It authorises exactly the list in the checkpoint report. The user also replied earlier the same day: 'meant reopen' (issue #15 is reopened), 'ok on one pr', 'ok on task 4'; issues #2 to #14 (the numbers named by the records) are to be closed.

## Segment 2 (continuation): checks before any write, 2026-10-18

- Integration branch `worktree-agent-a831d504fe83fd4be`, base and HEAD `839d66c`. `origin/main` is `839d66c` (after `git fetch origin` and by `git ls-remote`); `HEAD..origin/main` = 0 and `origin/main..HEAD` = 0, so the base is pushed.
- Repository `open-gsd/gsd-atlas`, permission ADMIN, default branch `main`, merge commits allowed. Remote heads: ci/phase-1, ci/phase-2, main (no `adr/mvp-gate-ratification`). Pull requests: #1 merged, #10 closed; none open.
- `--list-gate`: host-process-model, user-controlled-diagnostics (as in the checkpoint report). `--print-issue --slug host-process-model` equals the approved text. `--list-issues --numbers`: 2 3 4 5 6 7 8 9 11 12 13 14.
- Issue states from `gh issue list --state all`: #2 to #9 and #11 to #14 OPEN and `own`; #15 CLOSED/NOT_PLANNED and `own`; no issue mentions the host process model. #1 and #10 are pull requests and are not touched.

## Published record

| Slug | Issue | How | Issue URL | Pull request | Merge commit | Closed |
|------|-------|-----|-----------|--------------|--------------|--------|

## Earlier records

| Slug | Issue | State before | Own-issue check | Closed |
|------|-------|--------------|-----------------|--------|
| product-boundary | 2 | OPEN | own | |
| trust-boundaries | 3 | OPEN | own | |
| command-runner | 4 | OPEN | own | |
| language-modules | 5 | OPEN | own | |
| fact-model | 6 | OPEN | own | |
| fact-store-interface | 7 | OPEN | own | |
| sqlite-store | 8 | OPEN | own | |
| tenant-composition | 9 | OPEN | own | |
| worktree-lifecycle | 11 | OPEN | own | |
| query-and-policy | 12 | OPEN | own | |
| mcp-contract | 13 | OPEN | own | |
| value-dashboard | 14 | OPEN | own | |
