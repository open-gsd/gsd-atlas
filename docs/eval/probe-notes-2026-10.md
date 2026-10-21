# Exploratory probes on the token gate (2026-10)

**Nothing here is scored or registered.** No verdict is computed. The registered verdict `OVERALL: MVP not met` stands. No registered file, key, question, result or skill was touched. No decision record is described as ratified. These are four cheap probes (P1 to P4) run locally with headless Claude Code on the signed-in claude.ai Max subscription, to see whether the token criterion is attainable before any new registration. n is small everywhere; no test of significance is attempted; answer-vs-key equality is descriptive only.

## Conditions that make absolute numbers non-comparable with the registered runs

- Claude Code on this machine is **2.1.305** (`claude --version`); the registered gate pins 2.1.302. Model `claude-sonnet-5-5`, as registered. Compare only within these probes.
- Corpus: gsd-core at the pinned commit `10ac3a7a947903ba50f538a907af036744d759d5`, exported with `git archive` into a scratch directory, `npm ci --ignore-scripts`, then a throwaway `git init` + one commit so the atlas index can read blob ids (the tree is byte-identical to the pinned one; no CLAUDE.md, AGENTS.md, `.claude` or `.mcp.json`). Each session gets a fresh copy-on-write clone, a fresh store, and for atlas sessions that call tools `gsd-atlas build` then `maintain resolve`, as the harness does. One-turn sessions (P1, P2a) skip the index build (no tool is called).
- Auth: `claude auth status` four-field filter: loggedIn true, authMethod claude.ai, apiProvider firstParty, subscriptionType max. Every stream's init reported `apiKeySource: none`. All ANTHROPIC* and CLAUDE* environment variables (and ENABLE_TOOL_SEARCH) were removed from the child environment by the driver; no auth variable was set.
- Questions: 16 fresh unregistered questions (`pq-001` to `pq-016`), symbols not used by the 75 registered or the pilot questions (checked by a test), keys derived by the v2 oracle (`scripts/key-oracle/build-v2.ts` `deriveQuestion`), v2 wording style. Kinds: callers 5, references 4, impact 3, emit 4 (2 compiled-path, 2 consumers). Files: `docs/eval/probes/probe-questions.json`, `probe-answers.json`. A key is the v2 oracle's output; it was not audited by hand. The v2 keys are themselves a proposal.

## Design and commands

Driver `scripts/probes/driver.ts` builds each session from the registered pieces (`buildClaudeArgs`, `runClaudeSession`, `buildMcpConfig`, `buildPluginDir`, `cloneCheckout`, `buildPrompt`, `ARMS`, `allowedToolsFor`; read-only use, the harness is unchanged). Registered flags kept in every configuration: `-p --output-format stream-json --verbose --setting-sources "" --strict-mcp-config --mcp-config <file> [--plugin-dir] [--settings] --tools <list> --allowedTools <list> --max-budget-usd N --json-schema <answer schema> --model claude-sonnet-5-5 --no-session-persistence`, run under `nice -n 10`, one session at a time. Differences per configuration (`scripts/probes/configs.ts`):

| config | difference from the registered atlas arm |
| --- | --- |
| grep | registered grep arm |
| atlas | the registered atlas arm (7 tools, skill plugin, Skill tool, `ATLAS_SETTINGS`) |
| atlas-noskill | `--tools Bash,Read`, no plugin, no Skill allow rule |
| atlas-3tools-deny | noskill plus `--disallowedTools` for code_context, code_explain, atlas_status, lang_list |
| atlas-3tools | noskill, scratch copy of the server registering only code_find, code_refs, code_impact |
| atlas-noinstr | noskill, scratch server copy with the server instructions removed |
| atlas-shortdesc | noskill, scratch server copy with the fence note dropped from every tool description (extra, not briefed) |
| atlas-ts | registered arm with `ToolSearch` added to `--tools` and `--allowedTools` |
| atlas-ts-env | atlas-ts plus `ENABLE_TOOL_SEARCH=true` in the child environment only |
| atlas-noskill-ts | noskill plus ToolSearch |
| atlas-routed | registered arm plus a PreToolUse hook on Bash passed as inline `--settings` JSON (merged into `ATLAS_SETTINGS`); `scripts/probes/route-hook.ts` denies commands whose programs include grep, egrep, fgrep, rg, git grep, find or cat, with a reason that names the four code tools |
| atlas-routed-ts | atlas-routed plus ToolSearch |
| atlas-routed-capped | atlas-routed with a scratch server copy that adds a default `budget_tokens` of 1500 to code_find/refs/context/impact (an explicit argument still wins) |

The scratch server copies are built from this worktree's `dist/` into the session scratch directory with `node_modules` linked (`scripts/probes/patch-server.ts`); `src/` and `dist/` were not edited. Prompts: one-turn probes use `Reply with the single word ok.` with the answer schema (as the clean-room probes did); question sessions use the harness `buildPrompt`. Per-session budget caps: 0.25 USD one-turn, 0.8 to 1.0 USD questions.

**Forced routing changes what is measured.** In atlas-routed the grep arm's only search route is closed on purpose; it measures how atlas behaves when used, not whether the model would choose it.

## P1 Fixed context (first-request tokens, input + cache creation + cache read; 3 repeats each)

First-request values were identical across the three repeats of every configuration (spread 0).

| config | first request | vs grep | init tools (MCP) | note |
| --- | --- | --- | --- | --- |
| grep | 6,034 | 0 | 3 (0) | registered clean-room figure was 6,073 |
| atlas (registered) | 10,814 | +4,780 | 12 (7) | same gap as the appendix of `reevaluation-options.md` (4,780) |
| atlas-noskill | 9,849 | +3,815 | 11 (7) | skill description plus Skill tool: 965 tokens |
| atlas-3tools-deny | 8,427 | +2,393 | 7 (3 allowed) | `--disallowedTools` does remove the definitions from the request (1,422 fewer for 4 tools) |
| atlas-3tools (scratch server) | 8,421 | +2,387 | | same within 6 tokens: both mechanisms work |
| atlas-noinstr (scratch server) | 9,536 | +3,502 | | server instructions: 313 tokens |

Full means/medians and the token split are in `records-p1.jsonl` and the table output (sessions are one-turn, billable about equal to first request plus roughly 100). Cost: 0.321 USD (18 sessions).

Reading: of the 4,780, about 965 is the skill (description plus Skill tool), about 313 the server instructions, about 3,500 the seven tool definitions (about 1,420 for code_context, code_explain, atlas_status, lang_list together). The fence note in each description is small: shortening descriptions (P2a, atlas-shortdesc) saved 258 tokens (9,591 vs 9,849).

## P2 Deferred tools (MCP tool search)

Finding: **tool search can be switched on in headless mode, and in the registered harness it is off only because `ToolSearch` is not in `--tools`.** The Claude Code docs (https://code.claude.com/docs/en/mcp, "Configure tool search") say it is on by default for Sonnet 4 and later, and: "If you deny `ToolSearch` or leave it out of `--tools`, MCP tools load upfront instead". The registered `--tools Bash,Read,Skill` leaves it out. `ENABLE_TOOL_SEARCH` is not needed; setting it to `true` gave the same numbers (8,073 vs 8,069).

P2a, first request (3 repeats each, identical within a configuration):

| config | first request | vs grep |
| --- | --- | --- |
| atlas (registered) | 10,814 | +4,780 |
| atlas-ts | 8,069 | +2,035 |
| atlas-ts-env | 8,073 | +2,039 |
| atlas-noskill-ts | 7,104 | +1,070 |

In atlas-ts the init event still lists all seven atlas tools by name (12 tools with ToolSearch and StructuredOutput); the definitions are deferred. Deferral saves 2,745 tokens per request. The residual 1,070 over grep (without skill) is the ToolSearch tool itself, the deferred-name list and the server instructions.

P2b, 4-question mini-run (pq-001, pq-005, pq-002, pq-014; atlas-ts; 1 run each): **0 of 4 sessions called ToolSearch or any atlas tool**; all four searched with Bash. Mean billable 57,010. With description-only routing and deferred tools, the model did not look for the tools (on the natural-adoption rate this is 0/4 against 7/32 with tools loaded upfront, small n).

P2c, same four questions with atlas-routed-ts (hook denies grep): 4 of 4 sessions called ToolSearch once, loaded the tools and then used them (6 to 15 atlas calls each); the model can find and call deferred atlas tools when its other route is closed. Mean billable 270,100 (high: see P3/P4 on call counts and payload). Answers equal the key 0/4. Cost of P2: 1.528 USD (P2a 0.236, P2b 0.263, P2c 1.028).

## P3 Routing and adoption (16 questions x 2 runs x 3 conditions = 96 sessions)

Run 1 (48) and run 2 (48) were run as briefed (the second only because cost allowed). All 96 sessions status ok. Means over the 32 sessions per condition; medians in the second number.

| condition | n | first request | billable mean / median | in / cache-create / cache-read / out (mean) | tool calls (mean, excl. final answer) | sessions with an atlas call | skill loaded | answer set = v2 key | wall s | cost USD mean / sum |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| grep | 32 | 6,188 | 45,242 / 38,259 | 8 / 10,119 / 34,158 / 957 | 3.16 | 0/32 | 0/32 | 18/32 | 13.4 | 0.053 / 1.711 |
| atlas (registered) | 32 | 10,968 | 67,846 / 63,335 | 9 / 11,520 / 55,272 / 1,045 | 3.59 | 7/32 (22%) | 0/32 | 18/32 | 13.1 | 0.062 / 1.986 |
| atlas-routed | 32 | 10,974 | 156,115 / 101,023 | 13 / 24,067 / 129,858 / 2,178 | 7.09 | 32/32 | 0/32 | 12/32 | 25.5 | 0.131 / 4.194 |

Run 1 alone: grep 42,156, atlas 60,918, routed 164,258 (means); run 2: 48,328, 74,773, 147,972. Atlas/grep billable ratio on this question set: 1.50 (mean), 1.66 (median); routed/grep 3.45. Mean assistant requests per session (distinct message ids): grep 4.09, atlas 4.34, routed 6.34.

By question kind (both runs; billable mean; atlas sessions with a call; answer = key):

| kind | n per cond. | grep | atlas | atlas calls | atlas-routed | key: grep / atlas / routed |
| --- | --- | --- | --- | --- | --- | --- |
| callers | 10 | 43,940 | 71,816 | 3/10 | 237,992 | 6 / 6 / 0 |
| references | 8 | 24,049 | 39,714 | 0/8 | 136,926 | 6 / 6 / 6 |
| impact | 6 | 66,171 | 108,536 | 4/6 | 92,585 | 0 / 0 / 0 |
| emit (path) | 4 | 17,119 | 27,011 | 0/4 | 47,411 | 2 / 2 / 2 |
| emit (consumers) | 4 | 87,612 | 93,980 | 0/4 | 193,804 | 4 / 4 / 4 |

Findings, descriptive only:
- Adoption without forcing: 7 of 32 atlas sessions (22%) made an atlas call, all in callers or impact questions (the registered run saw 34 to 38%). The skill body was loaded 0 of 96 times in every condition.
- Atlas sessions that used an atlas tool cost 100,894 (n=7) against 58,592 for those that did not (n=25); matched grep sessions on the same questions cost 61,181 and 40,779. So the sessions without a call carry a 1.44x ratio that is pure fixed context; the sessions with a call carry 1.65x.
- Forced routing made every session use atlas, tripled billable tokens relative to grep and cut agreement with the key from 18/32 to 12/32 (callers 6/10 to 0/10). The model calls code_refs repeatedly (mean 7 tool calls, 6.3 requests) and the results (see P4) stay in context. impact is the one kind where routing was not more expensive than grep (92.6k vs 66.2k) and it is 0 equal in all three conditions (the v2 depth-two keys were not matched by any arm).
- Answer equality is descriptive (v2 keys derived after the earlier results; the keys are a proposal).
- Cost of P3: 7.891 USD.

## P4 Payload size

**Offline** (`scripts/probes/run-payload.ts`, output `p4-payload-offline.json`; the 225 atlas sessions of the clean-room replication streams). A result is sized by the growth of the next request over the previous one, minus the previous output (estimates, not billing); "carried" = result tokens x later requests that re-send it.

| tool | calls | median bytes | max bytes | calls > 4 KB | > 8 KB | > 16 KB | share of session tokens carried |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code_impact | 21 | 7,836 | 31,759 | 21 | 3 | 3 | 5.7% |
| code_refs | 38 | 4,777 | 7,941 | 20 | 0 | 0 | 1.9% |
| code_find | 31 | 386 | 1,399 | 0 | 0 | 0 | 0.2% |
| code_context | 0 | | | | | | 0 |
| (Bash, for comparison) | 425 | 810 | 29,817 | 85 | 41 | 12 | 13.4% |

Atlas results together carried about 7.7% of the atlas sessions' 9.65 M tokens; 90 atlas calls over 225 sessions. The fixed tool-definition cost (4,780 x 3.04 requests) is about 34% of them. So on the registered mix the payload is a minor share; the definitions are the major one. When atlas is forced (this probe's P3), payload matters much more.

**Live, capped payload** (6 fresh questions, atlas-routed-capped = routed plus a default `budget_tokens` of 1500 in a scratch server copy; the tools accept `budget_tokens`, `limit` and a `more` cursor, so no change to `src/` was needed for this test). Compared with the same questions in atlas-routed run 1:

| | routed | routed-capped |
| --- | --- | --- |
| atlas result bytes (sum, 6 sessions) | 283,034 | 20,244 (-93%) |
| billable tokens (sum) | 1,807,749 | 1,929,485 (+7%) |
| tool calls (mean) | 10.5 | 19.2 |
| answer = key | 1/6 | 1/6 |

Capping cut the bytes by 93% but not the tokens: results came back truncated with a `more` cursor and the model compensated with more atlas calls plus Read and Bash calls (tool calls 10.5 to 19.2). Result: a default cap is not a lever on its own; a cap would need to be paired with results that stay complete for the question (for example a grouped file-level summary), which needs `src/` changes that were not made. Estimated effect if the 7.7% payload share were halved on the registered mix: about 4 points of tokens (arithmetic, not measured). Cost of P4 live: 1.082 USD.

## What this means for the token gate (projection, labelled)

Method: atlas billable mean minus (4,780 - X) x requests per session, where X is the atlas-minus-grep first-request gap of a configuration from P1/P2, assuming the number of requests, the adoption and the payload are unchanged. Projection, not measurement.

| fixed-context gap X (tokens per request) | configuration | P3 mix (grep 45,242, atlas 67,846, 4.34 requests) atlas/grep | replication mix (grep 23,990, atlas 42,940, 3.04 requests) atlas/grep |
| --- | --- | --- | --- |
| 4,780 | registered | 1.50 | 1.79 |
| 3,815 | no skill | 1.41 | 1.67 |
| 2,393 | no skill, 3 tools | 1.27 | 1.49 |
| 2,035 | tool search, with skill | 1.24 | 1.44 |
| 1,070 | tool search, no skill | 1.14 | 1.32 |
| 0 | impossible floor | 1.04 | 1.18 |

Reading: cutting the fixed context alone does not reach parity on either mix; the best realistic configuration measured (tool search without the skill) leaves atlas at about 1.14x (P3 mix) to 1.32x (replication mix) of grep. Parity needs atlas to replace grep turns, and the data says it does so rarely: unforced adoption was 22% and fell to 0/4 under tool search, while forcing adoption raised tokens 3.45x. The registered token criterion therefore looks out of reach by tool-definition trimming alone; closing the remainder needs sessions that finish in fewer requests with atlas than with grep (the impact questions are the candidate, but there every arm was wrong against the v2 key). Tool search would also remove most of the skill's routing value unless the model is led to search (P2b vs P2c). These are exploratory readings on 16 questions and one model, not a result.

## Costs and rate limits

Notional cost (sum of `costUsd`; the subscription was used, no API key): smoke 0.025, P1 0.321, P2 1.528, P3 7.891, P4 1.082; **total 10.848 USD** (cap 12). Rate-limit readings from the stream events (fractions of the window): first session five-hour 0.03, seven-day 0.11; last session five-hour 0.09, seven-day 0.12; `isUsingOverage` false and `overageStatus` rejected in every reading; the stop thresholds (0.60) were never approached. Readings were checked after every session by the driver (`scripts/probes/limits.ts`).

## Deviations from the brief and things not done

- One avoidable overlap: after a background-task timeout looked like a crash, a second driver was started while the first was still alive; for about two minutes two sessions ran concurrently (within the concurrency 2 limit, but two drivers). The second driver was killed and its orphan session killed; no duplicate records resulted (96 unique P3 jobs); wall-clock figures of the two sessions in that window may be slightly affected.
- The hook's "denied" counter in the records is a text match on the stream and is unreliable; not used.
- The v2 oracle ran on the scratch `git init` copy of the pinned tree (same file contents), not on the user's gsd-core clone, which was only read by `git archive`.
- Index was built per session for atlas sessions that call tools; skipped for one-turn probes.
- Extra beyond the brief: atlas-shortdesc, atlas-routed-ts, atlas-routed-capped, a second P3 run.
- Not done: P1(e) was done with a scratch server copy only; no `--bare` or other flag variants; no run on the pinned 2.1.302; nothing was done on Windows or Linux; keys were not audited by hand; no second corpus; the cap experiment did not try a different cap value or a grouped result format; hook compliance beyond one deny/redirect was not inspected per session.
- Files: records per probe in `docs/eval/probes/records-*.jsonl` (counts, names, numbers and file-list comparisons only; no answer prose, no tool-result text); raw streams stayed in the session scratch directory.
- Verification at finish: `node scripts/eval/verify-prereg.ts` ok; the guarded paths unchanged against `main`.
