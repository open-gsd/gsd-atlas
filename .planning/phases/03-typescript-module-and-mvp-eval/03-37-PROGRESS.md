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

(none yet)
