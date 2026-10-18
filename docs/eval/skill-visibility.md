# Skill visibility in the eval arms (plan 03-38)

Date: 2026-10-18. Claude Code 2.1.302 (the registered version), model `claude-sonnet-5-5`. Plan 03-38, Revision 1 of the pre-registration.

This file records the live evidence behind Revision 1: whether the model can see and load the `gsd-atlas` skill in each arm, which flags make it so, what that costs, and what the smoke run showed. It records counts, names, booleans and short excerpts only: no transcript, no raw stream, no home directory path. The probe sessions were built through `runClaudeSession` with a `SessionSpec` made from `ARMS`, `allowedToolsFor`, `buildMcpConfig` and `buildPluginDir` over the real `skills/gsd-atlas/SKILL.md`, so the flags are the harness's own. Each probe was capped at `--max-budget-usd 0.25` and a 120000 ms wall clock. The `claude` on the search path of the machine reported 2.1.303 on the day of the run (a newer install); the probes and the smoke run were therefore started with the 2.1.302 binary by its path, so that the registered version is the one measured.

## The question

Plan 03-33 found that under the registered `--tools Bash,Read` the init event lists the skill `gsd-atlas-eval:gsd-atlas`, while the model sees no skill list and has no `Skill` tool (two probes, 0.035 USD). The 03-14 pilot read the init event and concluded that the atlas arm carried the skill description. It did not. D-03 and D-09 say the atlas arm uses the skill; this plan makes that true and proves it.

## Flag sets

- **A, registered before Revision 1 (atlas arm):** `-p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --mcp-config <mcp.json> --plugin-dir <plugin> --tools Bash,Read --allowedTools <12 shell patterns>,Read,<7 atlas tools> --max-budget-usd 0.25 --model claude-sonnet-5-5 --no-session-persistence`
- **B, Skill tool added, nothing else (atlas arm):** A with `--tools Bash,Read,Skill` and the one rule `Skill(gsd-atlas-eval:gsd-atlas)` added to `--allowedTools` after `Read`.
- **C, final (atlas arm):** B with `--settings '{"disableBundledSkills":true,"skillOverrides":{"plugin-authoring":"off","design":"off","doctor":"off"}}'` between `--plugin-dir` and `--tools`. This is `ARMS.atlas` as committed.
- **G, grep arm (unchanged):** A without `--plugin-dir`, with an empty `mcpServers` map and without the atlas tools in `--allowedTools`. No `Skill` token, no `--settings`.

## Probes

The prompts: P1 asks, with no tool use allowed, (a) whether a tool named Skill exists, (b) for the exact name of every skill the model can see, one per line, (c) for the first sentence of the description of `gsd-atlas-eval:gsd-atlas`. The model's answer to (c) is judged by a normalised substring match against the first sentence read from `skills/gsd-atlas/SKILL.md`. P3 asks the model to load the skill with the Skill tool and report how many atlas tools the body names.

| Probe | Arm, flags | Init: Skill tool, skills listed | Model: (a) Skill tool, (b) skills it sees, (c) description | Verdict | Input + cache tokens | Cost USD |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | atlas, B | yes; 20 skills (the registered skill and 19 of Claude Code's own) | yes; 15 names (the registered skill and 14 of Claude Code's own); (c) quoted the first sentence: "Use gsd-atlas before searching a repository for code by name, before editing a function, class or type, and when asked who calls, implements, extends or depends on something." | the atlas model sees and quotes the description; it also sees 14 skills that are not ours (a confound) | 12,597 | 0.0519 |
| P2 | grep, G | no; 19 skills listed in init (Claude Code's own) | "No. The only tools I can see are Bash and Read. No tool named Skill is available to me." (b) NONE, (c) CANNOT SEE | the grep model cannot see any skill | 5,464 | 0.0113 |
| P3 | atlas, C | yes; 1 skill | the model called `Skill` with `{"skill":"gsd-atlas-eval:gsd-atlas"}`, the tool_result was not an error ("Launching skill: gsd-atlas-eval:gsd-atlas"), and the answer was `7` (the body names seven atlas tools) | the Skill tool loads the body without a permission error | 22,223 over 2 turns | 0.0228 |
| P4 | atlas, A (the registered configuration) | no Skill tool; 20 skills listed in init | "No. I have no tool named Skill ... " (b) NONE, (c) CANNOT SEE | the plan 03-33 finding reproduces on the installed version: the init event lists the skill, the model sees none | 9,268 | 0.0382 |

Ladder trials (each repeats P1 with the flags of rung one, two and the refined rung one; the model is asked the same three questions):

| Trial | Flags added to B | Init skills | Skills the model sees | Cost USD |
| --- | --- | --- | --- | --- |
| rung one | `--settings '{"disableBundledSkills":true}'` | 4: the registered skill, `design`, `doctor`, `plugin-authoring` | 2: the registered skill and `plugin-authoring` | 0.0151 |
| rung two | `--disallowedTools` with `Skill(<name>)` for each of the 19 names in the init event of P1 | 20 (unchanged) | 15 (unchanged: the same list as P1, including three names that init did not list: `keybindings-help`, `init`, `security-review`) | 0.0248 |
| rung one, refined (C) | `--settings` with `disableBundledSkills` and `skillOverrides` "off" for the three leftovers | 1: the registered skill only | 1: the registered skill only; (c) quoted | 0.0147 |
| C again, through the committed `ARMS.atlas` (final check) | the same | 1 | 1; (c) quoted | 0.0147 |

## Ladder outcome

The plan's ladder: rung one, disable bundled skills through `--settings`; else rung two, deny each bundled skill by name; else rung three, accept the listing and count it.

- Rung one alone is not enough on 2.1.302: it hides every bundled skill except `plugin-authoring`, which the model still sees, and the init event still lists `design` and `doctor`.
- Rung two does not work: a `Skill(<name>)` deny rule did not remove any skill from the list the model sees, and the init event also does not list three of the names the model sees, so a list pinned from the init event would be incomplete.
- The refined rung one works and is kept: the documented `skillOverrides` setting, which hides a skill from the model's list when set to "off", takes care of the three skills that `disableBundledSkills` leaves. It uses the mechanism the plan names for rung one (`--settings`), and it needs no new `--setting-sources` value. The registered skill is a plugin skill, which `skillOverrides` does not affect, so it stays listed and loadable (P3, P1 final). The JSON is pinned in `scripts/eval/arms.ts` as `ATLAS_SETTINGS` to the registered Claude Code version.
- The guard against drift: `checkInit` now fails an atlas session whose init event lists any skill other than the registered one (`unexpected skill: <name>`). A Claude Code version that adds a skill stops the run as a contaminated session instead of leaking a second skill listing into the atlas arm. The grep arm's check is unchanged.
- The rung does not make the model's own `Skill` call fail (P3) and does not touch the grep arm (its argv has no `--settings`; asserted in `scripts/eval/harness.test.ts`).

## What the atlas arm now costs (counted, never subtracted: D-06)

Input plus cache tokens of a one-turn probe with the same prompt, no tool use:

| Configuration | Input + cache tokens | Difference from P4 |
| --- | --- | --- |
| P4, registered (A), no skill visible | 9,268 | 0 |
| C, final (the Skill tool and the registered skill's description in the list) | 10,245 | +977 |
| B, without the settings (Claude Code's own skills in the list too) | 12,597 | +3,329 |

So the visible skill adds about 1,000 input tokens to every turn of every atlas session, and the skill body adds its own size (P3's loaded body) in every session that loads it. Designing Claude Code's own skills out of the list removes about 2,350 tokens per turn from the atlas arm that would otherwise be a second, unrelated cost. The grep arm carries none of this. These tokens count toward the atlas arm's billable tokens in the scored comparison: the criterion was already the stricter `upper-bound`, and this makes it harder for atlas, not easier. Cache effects make a single probe approximate; the difference is for orientation, not a registered number.

## The three wording choices of plan 03-33 (decided before the smoke run; D-23)

Plan 03-33 left three wording choices in `skills/gsd-atlas/SKILL.md` open. They were decided before the smoke run so that nothing is tuned on its behaviour: keep all three as built. Each is routing content of the kind D-23 asks for, and none states a repository fact.

1. The `code_context` row says the tool also tells what a TypeScript file compiles to. This states a capability of a tool (the `file.emittedAs` field), not a fact about the repository, and no answer-key file path appears in the skill (the test `no answer key item is named in the skill` in `scripts/skills.test.ts` checks every file path of the 75 keys against both skills).
2. The line "confirm with one grep before you conclude" after an empty atlas answer is routing advice about a stale or uncovered index. It may add a tool call to an atlas session.
3. The line "use `code_impact` once, before the edit, instead of several greps" is routing advice. It may replace several greps with one call, or add one call.

The cost of each is counted: each may add a tool call or tokens to atlas sessions, and every token is billable to the atlas arm (D-06). `skills/gsd-atlas/SKILL.md` was not edited in this plan: the file the probes and the smoke run used is the one committed by plan 03-33 (`ae7ac92`), sha256 `00ce2dc7ab33fe087a5ace67409a161c557c99a658f5c2a4527c7efc60bc48cb`.

## Smoke run

Six unscored sessions: the pilot questions `p-001` (references), `p-003` (impact) and `p-004` (definition) times both arms times one run, concurrency 1, the registered model `claude-sonnet-5-5`, Claude Code 2.1.302 (started by its path), the approved per-session bounds (`--max-budget-usd 3`, wall clock 900000 ms), a stated smoke ceiling of 2 USD with the harness stopping new sessions at 1.6 USD. The prepared gsd-core checkout is at the registered corpus sha `10ac3a7a947903ba50f538a907af036744d759d5` (`npm ci --ignore-scripts`). The atlas binary was built from this tree (the Phase 3 precise tier included). The result rows and the session records are not committed (counts and names only below).

| Session | Arm | Status | Init matches the arm | Skills in the init event | Tool calls by name | Atlas calls | Skill calls | Billable tokens | Cost USD |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p-004, run 1 | atlas | ok | yes | `gsd-atlas-eval:gsd-atlas` only | `code_find` 1, `StructuredOutput` 1 | 1 | 0 | 22,577 | 0.0492 |
| p-004, run 1 | grep | ok | yes | 19, all Claude Code's own (no Skill tool, so none is visible) | `Bash` 2, `StructuredOutput` 1 | 0 | 0 | 19,168 | 0.0303 |
| p-001, run 1 | atlas | ok | yes | `gsd-atlas-eval:gsd-atlas` only | `code_refs` 1, `Bash` 1, `StructuredOutput` 1 | 1 | 0 | 24,936 | 0.0312 |
| p-001, run 1 | grep | ok | yes | 19, as above | `Bash` 1, `StructuredOutput` 1 | 0 | 0 | 14,491 | 0.0236 |
| p-003, run 1 | atlas | ok | yes | `gsd-atlas-eval:gsd-atlas` only | `code_impact` 1, `Bash` 5, `StructuredOutput` 1 | 1 | 0 | 113,632 | 0.0658 |
| p-003, run 1 | grep | ok | yes | 19, as above | `Bash` 5, `StructuredOutput` 1 | 0 | 0 | 57,160 | 0.0587 |

Total cost: 0.2588 USD (ceiling 2 USD, stop line 1.6 USD, never approached). No session was contaminated: `checkInit` returned nothing for any of the six, so the atlas sessions listed the Skill tool and the registered skill and no other skill, and the grep sessions listed neither the Skill tool nor the atlas skill. Every answer parsed. The atlas arm made at least one `mcp__gsd-atlas__` call in all three of its sessions. The grep arm's init event lists Claude Code's own skills, as it did before Revision 1 and in the 03-14 pilot; without the Skill tool the model cannot see them (P2).

Findings, recorded and not acted on (D-23, EVL-03: no tuning of the skill or the harness on behaviour seen here):

- The skill body was never loaded: all three atlas sessions made zero `Skill` calls. The model routed from the description alone, which is what it sees on every turn. The scored run will therefore mostly pay for the description (about 1,000 input tokens a turn, see above), not for the body.
- Unscored and on one run of three easy pilot questions, the atlas sessions used more billable tokens than the grep sessions in all three pairs (161,145 against 90,819 in total). This is a smoke fact, not an estimate: it is one run per cell, the questions are not the scored set, and the atlas arm carries the seven tool definitions, and now the skill description, on every turn. It is the cost Revision 1 declares and the registered token criterion counts.
- `p-003` was answered incorrectly in both arms; `p-001` and `p-004` correctly in both. The correctness flags are recorded for completeness and nothing is read from three questions.
