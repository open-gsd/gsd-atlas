# Plan 03-33: checkpoint (Task 2, blocking-human)

Status: awaiting the human. Tasks 1 and the Stage B freezer code (the first half of Task 3) are committed. The Stage B freeze itself has NOT been run, and the smoke run has NOT been run.

## Committed so far (branch worktree-agent-ad2dd6fa55a760208, base 5b032e4)

| Commit | What |
| --- | --- |
| d1f642d | test: skills.test.ts (red) |
| ae7ac92 | feat: final `gsd-atlas` skill, new `gsd-atlas-module-author` skill (green) |
| 33b7ea0 | test: Stage B freezer cases (red) |
| 19f0705 | feat: `freeze-prereg.ts --stage B` (green) |

Checks at 19f0705: typecheck, lint, build clean. `npm test`: 4422 tests, 4420 pass, 0 fail, 2 skipped (both pre-existing skips). `node scripts/eval/verify-prereg.ts` ok (Stage A unchanged; no file under the sixteen registered paths was touched).

## What the human must review

1. `skills/gsd-atlas/SKILL.md` (body 57 lines of 80; description 884 of 1,536 characters). This is the text the scored run is registered against.
2. `skills/gsd-atlas-module-author/SKILL.md` (body 94 lines of 200; not part of the eval; it can change later).
3. Three wording choices in the router skill that the reviewer should look at for "answer key" bias (T-03-332) or token effect:
   - The `code_context` row says it also tells "what a TypeScript file compiles to". That is a real tool field (`file.emittedAs`), but it overlaps the eval's emit question category. Remove the clause if it reads as a hint.
   - "Confirm with one grep before you conclude" after an empty atlas answer. Honest on the abstain questions, but it can add a tool call to atlas-arm sessions.
   - The line "use `code_impact` once ... instead of several greps" is a routing nudge toward the tool. The pilot's atlas arm never called `code_impact`.

## The finding that needs a decision: the skill is inert under the registered tool set

The registered environment is `--tools Bash,Read` in both arms (`scripts/eval/arms.ts` `BUILTIN_TOOLS`, enforced exactly by `checkInit`). Claude Code has no `Skill` tool in that set. The 03-14 pilot noticed this (finding 5) and inferred that "the description is all the model can see". I tested that inference (two live probes, `claude` 2.1.302, same isolation flags, plugin directory with the new skill, cost 0.035 USD in total, nothing committed):

| Tool set | init `tools` | init `skills` lists `gsd-atlas-eval:gsd-atlas` | What the model could see |
| --- | --- | --- | --- |
| `--tools Bash,Read` (registered) | Bash, Read | yes | Nothing. Asked to quote the skill's description it answered it could see no skill list at all, and that it has no `Skill` tool. |
| `--tools Bash,Read,Skill` | Bash, Read, Skill | yes | The full description, and the `Skill` tool to load the body. |

So in the scored run as registered, the init event passes the skill check (`checkInit` only looks at the init `skills` array) while the atlas-arm model sees neither the description nor the body. The only routing channel the model has is the MCP server's `instructions` (`SERVER_INSTRUCTIONS`) and the tool descriptions. Consequences:

- The scored run measures atlas tools plus server instructions, not the skill. The pilot's remark that the atlas arm's extra tokens came from "carrying the skill description" is wrong: no description was carried.
- The Stage B skill hash will be a true record of a file that the run loads but that no session reads.
- The skill text I wrote keeps the full routing in its description (the part a model sees when the Skill tool exists), so it works in both worlds.

Options (the human chooses; the executor does not):

- **(a) Accept the registered configuration.** Record Stage B as planned. Add a short "Stage B" subsection to the prose of `docs/eval/preregistration.md` saying plainly that the skill is registered and loaded but not visible to the model under `--tools Bash,Read`, so the verdict covers the atlas tools and server instructions only. Cheapest. The claim "agents using atlas" is then tested without the skill, which is the weaker routing channel, so a pass is not inflated by the skill.
- **(b) Reopen Stage A to add `Skill` to the atlas arm only.** Needs edits to the frozen `arms.ts` (the atlas arm's built-in tools, `checkInit`, `allowedToolsFor` with `Skill(gsd-atlas-eval:gsd-atlas)`), probably `harness.ts` and their tests, a re-freeze of Stage A, and a new version of the pre-registration with its approvals (Deviations policy: a new registered run). The 19 bundled Claude Code skills would also become visible in the atlas arm unless disallowed, which is a second confound to design out. This is a bigger change than this plan owns.

## Reply grammar

One line, any of:

- `approve` : approve both skills as written and accept option (a). The continuation then does the smoke run and the Stage B freeze.
- `changes: <edits>` : the edits to the skill text (and optionally `author:` edits). The plan loops back to Task 1, then asks again.
- `reopen-stage-a` : choose option (b). The executor stops; a new plan or an amendment to Stage A has to be written first. Nothing is frozen.

The reply is recorded verbatim under Approvals in `docs/eval/preregistration.md`.

## What the continuation does after `approve` (Task 3, rest)

1. Smoke run (live, unscored), as in the plan: `npm run build`, scratch copies of the pilot questions and answers reduced to `p-001`, `node scripts/eval/harness.ts pilot --questions <scratch>/one.questions.json --answers <scratch>/one.answers.json --arms atlas,grep --runs 1 --out-dir <scratch>/smoke --corpus-dir <prepared gsd-core checkout> --max-budget-usd 3 --wall-clock-ms 900000`. Expected, given the finding above: both inits match; the atlas arm may or may not call an atlas tool (the pilot's did in 2 of 5); the skill is listed but not invoked. The plan requires at least one `mcp__gsd-atlas__` call: if there is none, report it as a finding and do not tune the skill or the harness after the fact. A prepared corpus checkout is needed (`prepare-corpus.ts`; the pilot used one).
2. Commit the Approvals entry (the reply verbatim) and the Stage B prose subsection to `docs/eval/preregistration.md` FIRST. The freezer refuses a dirty tree, and the Stage B commit should then contain only the freezer's own edit (the block and one status line).
3. Run the Stage B freezer on the FINAL tree: `node scripts/eval/freeze-prereg.ts --stage B --by "<name>"`. It records `stageB.skillSha256` and `stageB.atlasCommit` = HEAD, so HEAD must already contain every `src/`, `modules/` and `package.json` change that will ship in the scored run: merge plan 03-32, the build-performance task and anything else that changes the build BEFORE running it. `scripts/eval/harness.ts` does not compare `atlasCommit` with the binary it runs (the scored gate checks only the skill hash), so T-03-334 is only as strong as that discipline; a check in `verify-prereg.ts` that nothing under `src/`, `modules/`, `package.json` or `package-lock.json` differs between `atlasCommit` and HEAD would close it (not in this plan's files).
4. `node scripts/eval/verify-prereg.ts` must print ok; then the verify command of Task 3; commit `docs(03-33): freeze the pre-registration, Stage B (skill and atlas build)`.
5. Write `03-33-SUMMARY.md` (the smoke result: init tool sets matched or not, atlas tool call count, skill invoked or not; what changed because of the pilot; the finding above).

## What changed because of the pilot, and what was left alone

Changed: the description now carries the whole routing (it is the only part a model can see where a `Skill` tool exists); one line says to prefer atlas over grep for named-symbol questions and why; one says to use `code_impact` once instead of several greps; ADR questions route to `kind: adr`; an empty atlas answer is reported as "found nothing" and checked with one grep; every degraded code that can explain a weak answer is covered, including `compiler_fallback`, `memory_budget` and `resolver_timeout`.

Left alone: the "when not to use atlas" rule (non-symbol text, a known file), the citation rule, the untrusted-text rule, the read-only stance. No repository fact, file name or symbol from the question set appears in the skill; the examples are `parseConfig` (from the docs) and generic category names.
