# gsd‑atlas — Agent integration: skill, MCP and enforcement hooks

**Status:** Draft · 2026‑10‑15 · companion to `PRD.md` §8 and `DESIGN.md` A32–A38, A58 and the query‑and‑policy ADR

gsd‑atlas only helps if agents use it. Left alone, an agent will often decide "I can just do it": grep its way around the repo, edit a function without checking its callers, write iOS 18 code from memory, and declare the job done. This document covers three layers that make atlas the path of least resistance and, where it matters, the required path:

1. **MCP**: the tools, shaped so they are cheaper and better than grep.
2. **Skill**: tells the agent when to use which tool.
3. **Hooks**: watch what the agent actually does, answer for it, gate risky edits, and check work before the agent stops.

---

## 1. Failure modes this targets

| # | "I can just do it" behaviour | Cost | Layer that catches it |
|---|------------------------------|------|-----------------------|
| F1 | Grep/find/read sweeps to locate code | Tokens, missed definitions, wrong overloads | Skill routing; hook answers the search from atlas |
| F2 | Editing a symbol without checking its callers | Broken callers across files | Edit gate (code_context first) |
| F3 | Platform or library API from memory | iOS 18 APIs in an iOS 27 app; invented symbols | Post‑edit `sdk_check`; Stop gate |
| F4 | Syntax newer than the project's language level | Code that doesn't compile | Post‑edit `syntax_check`; Stop gate |
| F5 | Ignoring the ADRs that govern the code | Decisions silently violated | `code_context` returns cited ADRs; edit gate shows them |
| F6 | Declaring done with known problems | Broken work handed back | Stop / SubagentStop gate |
| F7 | Swarm agents re‑exploring the same code | Hundreds of agents paying the same search cost | Shared daemon answers; `atlas-scout` subagent |

---

## 2. MCP surface

### Tools
| Tool | Purpose | Replaces |
|------|---------|----------|
| `code_find` | Definitions by name, fuzzy name or kind | grep for a name |
| `code_refs` | Callers and references with spans | grep for usages |
| `code_context` | One symbol: definition, signature, callers, callees, cited ADRs, tests that touch it, within a token budget | Reading 5–10 files |
| `code_impact` | What a change to a symbol or file reaches: transitive callers, dependent modules, tests | Guessing blast radius |
| `platform_card` | Installed SDKs, project targets, language level | Training‑data assumptions |
| `sdk_lookup` | One API: declaration, availability, deprecation | Memory |
| `sdk_check` | Files or a diff against the installed SDK and package versions | Nothing (missing today) |
| `syntax_check` | Syntax newer than the project's language level | Nothing |
| `atlas_status` | Freshness, watermark, health, policy mode | — |
| `lang_list` | Modules and active tiers | — |
| `atlas_build` | Build or refresh (privileged, `--allow-build`) | — |

### Response envelope (every tool)
```json
{
  "data": { "...": "..." },
  "citations": [{ "file": "src/decisions.cts", "line": 42, "fact": "f:9c1e…" }],
  "watermark": { "worktree": "/repo-wt-3", "indexed_through": "2026-10-15T14:02:11Z", "stale_paths": [] },
  "truncated": false,
  "more": null,
  "hints": ["code_context(\"parseDecisions\") for callers and ADRs"]
}
```

### Rules
- **Token budget per call:** every tool takes `budget_tokens` (default 2,000). Results are ranked and cut to fit, with a `more` cursor. Claude Code warns at 10,000 tokens and moves anything over 25,000 to a file, so atlas never comes near either.
- **Freshness is explicit:** `watermark` and `stale_paths` on every answer; `fresh: [paths]` on any call makes Query bring those paths up to date through `Indexer.ensureFresh` before it reads (A26, A58).
- **Worktree identity:** taken from MCP roots when the client provides them, otherwise from a `worktree` argument or the server's working directory.
- **Read tools are marked read‑only** (`readOnlyHint`); only `atlas_build` writes.
- **Short server instructions** in the MCP initialize result carry the routing table. Whether every client shows them to the model isn't verified, so the same routing also lives in the skill and the SessionStart context.
- **Resources:** `atlas://platform-card`, `atlas://status`.
- **Transport:** Unix socket or named pipe where the client supports it, otherwise loopback HTTP at a fixed per‑user port; token on every route; browser‑style requests rejected; routed to the agent's repo tenant; stdio shim for stdio‑only clients (A27).
- **Untrusted text:** doc comments, ADR excerpts and package or SDK prose come back in a fenced, length‑capped `untrusted_text` field, never mixed into `hints` (A44).

---

## 3. Skill

### `gsd-atlas` (auto‑invoked router)
- **Description** written for auto‑invocation: "Use before searching for code, before editing a function or type, and before writing code that calls platform or library APIs. Finds definitions, callers, impact, governing ADRs and the installed SDK."
- **Body, under 150 lines:**
  - routing table: question → tool;
  - three rules: `code_context` before editing a symbol; `sdk_check` and `syntax_check` before proposing a diff; `fresh` after your own edits;
  - CLI fallback when MCP isn't registered;
  - what the hooks will do, so a gate isn't a surprise.
- **Supporting files**, loaded on demand: `references/tools.md` (arguments and examples), `references/languages.md` (module tiers per language), `references/policy.md` (modes and how to request an override).
- Same banner and structure conventions as the `gsd-graph` skill.

### `gsd-atlas-module-author` (user‑invoked only)
- `disable-model-invocation: true`. Walks a contributor through writing a language module: manifest, queries, `features.json`, fixtures, `gsd-atlas lang test`.

### `atlas-scout` subagent
- A read‑only exploration agent for swarms: atlas MCP tools plus Read, no Grep/Glob/Bash.
- Orchestrators send "find where X happens" questions to it instead of general agents, so a swarm's exploration costs atlas queries, not repeated repo sweeps.

---

## 4. Enforcement hooks

### Principles
- **Answer, don't just refuse.** When the agent greps for something atlas knows, the hook hands it the atlas answer. A refusal costs a round trip; an answer saves one.
- **Gates only demand cheap things.** A gate asks for one atlas call, never something the agent can't do. If atlas can't answer (unsupported language, stale index, daemon down), the gate opens.
- **Never block on stale facts.** Before any gate decides, the hook adapter's Query call passes the touched files as `fresh` (short timeout). Still stale → advise instead of deny.
- **Escalation, not walls.** Modes per repo: `off`, `advise` (default), `enforce`, `strict` (swarms). Each rule can be set on its own.
- **Declared crash policy.** Every hook declares fail‑open or fail‑closed, as gsd‑core's `hook-exit.js` requires. All atlas hooks fail **open**: atlas being down must never stop work.
- **Agents can't override themselves.** Overrides come from the user (`/atlas allow <rule> once`) or the policy file.

### Where the pieces live
Answering and enforcing are separate modules (query‑and‑policy ADR):
1. The **hook adapter** turns a host event into (a) a Query request for the one cheap answer the rule needs and (b) a Policy event.
2. **Query** returns the same envelope MCP and the CLI return, including `watermark` and `degraded`.
3. **Policy** runs the pure `decide(event, ledgerEntry, answer) → allow | deny | attach(text)`. It owns the session ledger, the modes and the loop guards, and it never calls Query.
4. The adapter translates the decision into the host's hook response, or fails open if either call errors or times out.

Rules R1–R4 below are rows in Policy's table; the "attach" text in each is built from the Query answer. R0 (brief) is a Query request kind (`platform_card` + status + routing); Policy only decides whether to inject it.

### Event map
Built on the portable event floor gsd‑core already uses across runtimes (SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd), plus SubagentStart/SubagentStop where the host has them.

| Event | Rule | advise | enforce / strict |
|-------|------|--------|------------------|
| **SessionStart**, **SubagentStart** | R0 Brief | Inject `platform_card`, atlas status (including whether atlas is down or degraded) and the routing table as context (≈1–2K characters; Claude Code caps hook context at 10,000). No repo prose goes into hook context unfenced. | Same |
| **PreToolUse** on Grep, Glob, `Bash(grep *)`, `Bash(rg *)`, `Bash(find *)` | R1 Search assist | If the pattern looks like a symbol or path lookup and atlas has it, attach the `code_find`/`code_refs` answer as context; allow | Same; **strict** denies only when atlas has an exact, complete answer for the query (an indexed symbol's definition or references), with the answer in the reason. Searches for text, strings, log messages, config keys or anything atlas doesn't index always pass. |
| **PreToolUse** on Edit, Write, MultiEdit | R2 Edit gate | If the edit changes a symbol's signature or removes it (definitions compared before and after), the symbol has external callers above a threshold (default 3), and this agent hasn't called `code_context` or `code_impact` for it, attach the context (callers, ADRs); allow. Whole‑file writes are judged the same way, so untouched symbols don't trigger it | Deny with the reason *and* the context: "parseDecisions has 14 callers in 6 files and cites ADR‑1372. Context attached; retry the edit." The retry passes. |
| **PostToolUse** on Edit, Write, MultiEdit | R3 Check after edit | Index the file (`fresh`), run `sdk_check` and `syntax_check` on changed lines, and report findings as context | Same; findings are recorded against the session for R4 |
| **Stop**, **SubagentStop** | R4 Done gate | Summarise open findings as context | Block stopping while this session's changes have open `sdk_check`/`syntax_check` findings or references broken by the edits (a removed or renamed symbol still referenced) |
| **SessionEnd** | R5 Close | Drop the session ledger | Same |

**Loop guards:** R2 allows the retry once context has been delivered, so an agent can never be denied twice for the same symbol. R4 blocks at most 3 times per session, then degrades to advise. This guard is atlas's own (a counter in the Policy ledger), so it doesn't depend on any host's loop‑guard field.

### Hook transport and cost
At hundreds of agents, a hook that starts a Node process per tool call (about 40 ms and 44 MB each) becomes the bottleneck. So:
- **HTTP hooks** (Claude Code `type: "http"`) POST straight to the host (`/hooks/<event>`) at its fixed per‑user address, with the token read from an allowed environment variable: no process per call.
- Runtimes without HTTP hooks use a tiny command hook that forwards stdin to the daemon (`curl`, or a small native binary), not Node.
- Budget: hook p99 ≤ 20 ms; timeout 2 s; failure is non‑blocking.

### Session ledger
- Owned by the Policy module; Query never reads it.
- Per (session, agent): symbols consulted, files edited, open findings, gate counters.
- Small, in memory, and expiring: dropped at SessionEnd or after 1 hour idle, evicted under memory pressure.
- Never needed for correctness: if an entry is gone, gates fall back to advise. This is the one piece of per‑agent state, and it is bounded and disposable, so A23 still holds.
- Entries point at stable symbol identities (A45), so an edit to a file doesn't make the agent's earlier `code_context` call look stale.
- **Hosts without session and agent ids:** gates run in advise mode only; R0, R1 (advise), R3 and the pre‑commit backstop still apply.

### Runtime coverage
| Host capability | Example hosts | What atlas installs |
|-----------------|---------------|---------------------|
| Full hooks with deny reasons, context, Stop gate, HTTP hooks | Claude Code | All rules over HTTP hooks; skill; `atlas-scout` |
| Hooks on the portable floor, command only | Codex, Gemini CLI, Cursor, Windsurf, Kimi, Qwen (per gsd‑core's runtime surfaces) | R0–R4 through a thin forwarder, mapped per host the way gsd‑core maps tool names |
| No hook bus | Cline rules and similar | Rule text (AGENTS.md section) plus the skill or rules equivalent |
| Any agent, and humans | git | `pre-commit` hook running `gsd-atlas check --staged` (sdk, syntax, broken references) as the backstop; same check in CI |

### Local metrics (no telemetry)
`atlas_status` and `gsd-atlas status` show, per session and in total: searches answered by atlas versus raw greps, gates fired, retries after gates, Stop blocks, and overrides. They are kept in the store and never sent anywhere, and are used to tune policy and the skill.

---

## 5. Evaluation
Run the same task set three ways (hooks off, advise, enforce) on gsd‑core and a Swift app, single agent and a 50‑agent swarm:
- tokens and tool calls to the first correct edit;
- broken‑caller rate after edits;
- stale or invented API uses that reach a commit;
- syntax‑level violations that reach a commit;
- time and tokens spent on gates (overhead).

`enforce` becomes the recommended default only if it improves correctness without costing more tokens than it saves.

---

## Sources
- Claude Code docs: [hooks](https://code.claude.com/docs/en/hooks), [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks), [MCP](https://code.claude.com/docs/en/mcp), [skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents), [plugins reference](https://code.claude.com/docs/en/plugins-reference)
- gsd‑core: `hooks/hooks.json`, `hooks/lib/hook-exit.js`, `src/hook-bus.cts`, `src/runtime-hooks-surface.cts`
- gsd‑graph: `skills/gsd-graph/SKILL.md`
