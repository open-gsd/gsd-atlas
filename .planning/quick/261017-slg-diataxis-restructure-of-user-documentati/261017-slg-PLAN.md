---
phase: quick-261017-slg
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - docs/reference/cli.md
  - docs/reference/mcp.md
  - docs/explanation/how-freshness-and-the-writer-lease-work.md
  - docs/how-to/register-the-mcp-server.md
  - docs/how-to/answer-a-question-about-an-older-commit.md
  - docs/how-to/keep-the-store-healthy.md
  - docs/how-to/run-the-measured-gates-locally.md
  - docs/how-to/contribute-a-change.md
  - docs/tutorials/index-and-ask.md
  - README.md
autonomous: true
requirements: [QUICK-261017-slg]

estimate:
  tokens: 160000
  raw_tokens: 160000
  tasks: 11
  confidence: low

must_haves:
  truths:
    - "README.md is a short front door (at most 70 lines): what gsd-atlas is, today's status (TypeScript/JavaScript repositories, macOS/Linux/Windows, Node >=24.16.0), one pointer per need, the Documentation links (docs/adr/README.md, docs/PRD.md) and the licence."
    - "README.md still passes the repo's own README test (scripts/package.test.ts, 'README npm scripts exist'): it keeps the heading 'Developer quickstart' and the pinned commands, and every 'npm run X' it mentions exists in package.json."
    - "A reader who follows docs/tutorials/index-and-ask.md from a clone reaches a cited find, refs, context and impact answer and then sees a newly saved file found by the next question, with the expected output shown at each step; the executor replayed it end to end in a pristine scratch area."
    - "docs/reference/cli.md lists every command in COMMANDS and every flag in FLAGS of src/cli/tool-commands.ts, the one-JSON-envelope output contract, exit codes 0/1/2/3 with their precedence, and degraded: follower."
    - "docs/reference/mcp.md documents every tool the server registers (six: code_find, code_refs, code_context, code_impact, atlas_status and lang_list, confirmed by a live tools/list call), each tool's inputs and result shape, the not_indexed and store_unavailable envelopes and the writer lease."
    - "Every command, flag, exit code, tool name, envelope, error code and default stated in any new page was checked against the code or the built CLI; anything that could not be checked is absent."
    - "No page states a later-phase capability as shipped; the single permitted mention is one sentence in README.md."
    - "Each page is one Diataxis type: tutorial, how-to ('How to ...'), reference, explanation ('About ...'); pages link to each other instead of repeating explanation; no empty skeleton directory exists."
    - "Every relative link in README.md and docs/ resolves (scripts/adr.ts checkRelativeLinks reports zero broken links) at every task's commit."
    - "Only README.md and new files under docs/tutorials, docs/how-to, docs/reference and docs/explanation changed; docs/PRD.md, docs/DESIGN*.md, every ADR, src/, scripts/ and package.json are untouched."
  artifacts:
    - path: "docs/reference/cli.md"
      provides: "CLI reference: commands, flags, output contract, exit codes, degraded codes, defaults, environment and configuration"
      contains: "gsd-atlas history"
    - path: "docs/reference/mcp.md"
      provides: "MCP reference: server, six tools with inputs and result shapes, error envelopes, writer lease"
      contains: "store_unavailable"
    - path: "docs/explanation/how-freshness-and-the-writer-lease-work.md"
      provides: "About page on build-only index creation, writer lease and followers, freshness, idle-only compaction, citations and worktree correctness"
      contains: "writer lease"
    - path: "docs/how-to/register-the-mcp-server.md"
      provides: "How to register the MCP server with Claude Code, Cursor and Codex"
      contains: "--dry-run"
    - path: "docs/how-to/answer-a-question-about-an-older-commit.md"
      provides: "How to answer a question about an older commit"
      contains: "--at"
    - path: "docs/how-to/keep-the-store-healthy.md"
      provides: "How to keep the store healthy"
      contains: "maintain compact --full"
    - path: "docs/how-to/run-the-measured-gates-locally.md"
      provides: "How to run the measured gates locally and read their output"
      contains: "gates:freshness"
    - path: "docs/how-to/contribute-a-change.md"
      provides: "How to contribute a change"
      contains: "grammar:verify"
    - path: "docs/tutorials/index-and-ask.md"
      provides: "Tutorial: one safe path from clone and build to a first cited answer"
      contains: "In this tutorial we will"
    - path: "README.md"
      provides: "Front door with one pointer per need"
      contains: "Developer quickstart"
  key_links:
    - from: "README.md"
      to: "docs/tutorials/index-and-ask.md, the five docs/how-to pages, docs/reference/cli.md, docs/reference/mcp.md, docs/explanation/how-freshness-and-the-writer-lease-work.md"
      via: "relative markdown links, one pointer per need"
    - from: "docs/tutorials/index-and-ask.md"
      to: "docs/reference/cli.md and the how-to pages"
      via: "one-clause links at the end of steps and in the closing line"
    - from: "docs/how-to pages"
      to: "docs/reference/cli.md, docs/reference/mcp.md and docs/explanation/how-freshness-and-the-writer-lease-work.md"
      via: "links for options and rationale instead of repeated text"
    - from: "docs/explanation/how-freshness-and-the-writer-lease-work.md"
      to: "docs/DESIGN.md and docs/adr/7-fact-store-interface.md, 9-tenant-composition.md, 11-worktree-lifecycle.md, 12-query-and-policy.md, 13-mcp-contract.md"
      via: "links instead of restating decisions"
    - from: "docs/reference/cli.md and docs/reference/mcp.md"
      to: "the guides and the explanation page"
      via: "a closing See also list added in task 10"
---

<objective>
Update the user-facing documentation to match what Phase 2 shipped, restructured with the Diataxis method: split the 101-line README (overview, developer quickstart, Phase 2 quickstart, exit codes, MCP tool list and measured-gate commands on one page) by user need into a short README front door, one tutorial, five how-to guides, two reference pages and one explanation page. Create only pages that have real content.

Purpose: each reader (learner, worker, consulter, thinker) finds one page of one type that serves them, and every statement on it is true of the code today.

Output: the ten files listed in files_modified, eleven commits (one per task, docs files only) and a SUMMARY.md with a verification ledger.

Task order follows link dependency so every commit passes the link check: reference pages first (they fix the facts), then the explanation page, then the how-to guides, then the tutorial, then the outward links on the reference pages, then README last. This is the brief's suggested order with the tutorial moved after the guides and the explanation, because the tutorial and guides link to both. Tracer-first and TDD ordering do not apply to a documentation-only plan; each task is instead gated by an automated drift check that compares the page with the code's own tables (FLAGS, COMMANDS, TOOLS, DEGRADED_CODES, DEFAULT_QUERY_CONFIG).

Hard rules (apply to every task; tasks cite them as H1 to H10):

H1 Verify, never invent. Every command, flag, exit code, tool name, envelope, error code and default must be checked against the code (read through codegraph, see H8) or against the built CLI (`node dist/bin/gsd-atlas.js ...`, `node dist/bin/gsd-atlas-mcp.js`). If something cannot be verified, leave it out. Record each checked fact in the SUMMARY.md ledger as: statement, page, evidence (file:line or the command run).

H2 Scope. Create or edit only README.md and new files under docs/tutorials, docs/how-to, docs/reference and docs/explanation. Do not touch docs/PRD.md, docs/DESIGN*.md, any ADR, GLOSSARY.md, src/, scripts/, package.json or any other docs file. Commits contain docs files only, are made one per task, and are never pushed. The SUMMARY.md is a planning artifact and is not staged into the page commits.

H3 Present state only. State only what exists today. Nothing about the precise compiler tier, SDK packs, the Agent Skill, a daemon transport or Swift support as if shipped; no hand-off of a build to the lease holder exists today and no page may imply one. The only permitted mention of later work is one sentence in README.md. A field such as a tier flag that appears in real output may be shown as the observed value (false or inactive) without comment.

H4 No invented rationale. The explanation page states reasons only where an ADR, docs/DESIGN.md or a code comment states them, and links there instead of restating the decision. Product claims are limited to what the code does; the no-network and no-telemetry claim is made only after the check in task 11.

H5 Privacy hygiene. No absolute path, user name, host name or home directory from the machine that ran the probes may appear in any page. Use the neutral path /path/to/atlas-demo (and /path/to/gsd-atlas) in sample output. Sample output keeps real field names and values, with per-run values (nonce, process ids, timestamps) shown as obviously illustrative and named as varying in the surrounding text.

H6 Safe probing. Run `gsd-atlas init` only with the home directory redirected to a temporary directory (set HOME on macOS and Linux) so the real agent configuration files are never read for writing; never run it without --dry-run against the real home. The corpus gates download a pinned checkout; run them once if the network allows and otherwise rely on the scripts' own printed formats. Run size-gate and freshness-gate with reduced parameters for samples. Never push, never publish.

H7 Diataxis discipline. One type per page. Tutorial: states its destination, a visible result at each step, expected output, almost no explanation, a single path, no options. How-to: title starts "How to", names a user goal, action only, forks as "If ...", links for options and rationale. Reference: neutral, austere, same shape per entry, mirrors the product's structure, describes and only describes. Explanation: title starts "About", bounded by a "why" question, no step lists or option tables, links instead of restating. Read ~/.claude/skills/writing-docs-with-diataxis/SKILL.md and references/types.md before the first page. No empty skeleton directories. Match the repository's spelling (README uses "Licence").

H8 Source access. A repo hook blocks Read and Bash on indexed source files. Read source with `codegraph node -f FILE --offset N --limit M`, `codegraph explore "SYMBOLS"` or the codegraph MCP tool, and take CLI facts from the built CLI. In the linked worktree make sure the worktree has its own current index (`codegraph sync`, or `codegraph init -y`, run at the worktree root) before trusting line numbers. The hook also refuses a Bash command that names an indexed source file (anything under src or scripts) as an operand, for example `node --test FILE` or `node scripts/X.ts`; use npm scripts (they carry no such operand) or the inline `node -e` drift gates in the verify blocks, and never rephrase a refused command to get past the hook. If a verify gate is refused, compare the page with the table read through codegraph instead and record in SUMMARY.md that the automated gate could not run.

H9 Drift gates. Pages are checked against the importable tables, not by eye: FLAGS, COMMANDS, MAINTAIN_TASKS and HISTORY_TOOLS in src/cli/tool-commands.ts; TOOLS in src/query/tools.ts; DEGRADED_CODES in src/facts/degraded.ts; DEFAULT_QUERY_CONFIG in src/query/defaults.ts.

H10 Pinned README. scripts/package.test.ts ('README npm scripts exist') requires README.md to keep a heading "Developer quickstart", the literal commands `npm ci --ignore-scripts`, `node scripts/ensure-tree-sitter.ts`, `node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy` and `node dist/bin/gsd-atlas.js lang list`, an `npm run` mention of build, lint, typecheck, schema:check, grammar:budget and grammar:verify, `npm test`, and no `npm run` name that is missing from package.json. Editing that test is out of scope, so the README keeps a compact Developer quickstart block of exactly those commands and points to the contribute guide for the rest.

Findings from planning that the tasks rely on:
- The MCP server registers six tools, not five: lang_list is the sixth (src/query/tools.ts TOOL_NAMES; confirmed by a live tools/list call). The reference documents all six.
- The origin repository is private today (GitHub API: private) and local main is ahead of origin. The tutorial may show the clone command with the origin URL but must not call the repository public and must not mention installing from npm (package version is 0.0.0 and nothing says it is published).
- By default a store lives at the git common directory under a gsd-atlas folder, so indexing a repository writes nothing into the working tree and nothing is committed (src/fact-store/location.ts). A saved, even untracked, file is found by the next CLI question without any flag (confirmed on a probe repository).
- The repo's only link checker is checkRelativeLinks/collectLinkFiles in scripts/adr.ts (no npm script); it covers docs/**, README.md and GLOSSARY.md and works as a node one-liner.
- package.json's description also mentions SDKs; it is out of scope and left alone.
- Coverage audit (GOAL, REQ, RESEARCH, CONTEXT): GOAL = brief goal, covered by tasks 1 to 11. REQ: none (quick task). RESEARCH: none. CONTEXT: no CONTEXT.md, so no D-NN decisions. Brief items: 1 README = task 11; 2 tutorial = task 9; 3 how-tos = tasks 4 to 8; 4 reference = tasks 1, 2 and 10; 5 explanation = task 3. Hard rules = H1 to H10, enforced by the verify gates.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@README.md
@docs/adr/README.md
@GLOSSARY.md
@.planning/STATE.md
@.claude/CLAUDE.md

Method (outside the repo, read first): ~/.claude/skills/writing-docs-with-diataxis/SKILL.md and ~/.claude/skills/writing-docs-with-diataxis/references/types.md.

Classification of the current README.md with the Diataxis compass (informs the split):
- Opening two paragraphs and the Node requirement: overview and status, stays in README.
- "Developer quickstart" block: how-to for contributors (action, work), moves to docs/how-to/contribute-a-change.md; a compact pinned copy stays in README (H10).
- "Phase 2 quickstart" command block: mixed. The ordered sequence build, find, refs, context, impact is a tutorial; the history, health, status, maintain and init lines are separate how-to goals; the flag and command meanings are reference.
- Exit codes paragraph and the MCP tool list paragraph: reference.
- "While it runs it holds the writer lease ... degraded: follower" sentence: explanation (why) with reference facts.
- Measured-gate command block: how-to (run the gates), with the output meaning as part of that guide.
- Documentation links and Licence: stay in README.

Relative link forms (from the file that holds the link): from docs/how-to/x.md to the reference is ../reference/cli.md, to the explanation ../explanation/how-freshness-and-the-writer-lease-work.md, to an ADR ../adr/9-tenant-composition.md, to the design ../DESIGN.md, to the glossary ../../GLOSSARY.md. A page may link only to files that already exist when its task commits.

Ratified ADR file names to link: docs/adr/7-fact-store-interface.md, 8-sqlite-store.md, 9-tenant-composition.md, 11-worktree-lifecycle.md, 12-query-and-policy.md, 13-mcp-contract.md, 3-trust-boundaries.md, 6-fact-model.md.

Link check command used by every verify block (no npm script exists): run a node one-liner that imports collectLinkFiles and checkRelativeLinks from ./scripts/adr.ts, calls checkRelativeLinks(root, collectLinkFiles(root)) with root set to the current directory and exits 1 when any link is broken.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write docs/reference/cli.md (and prepare the worktree and probe area)</name>
  <files>docs/reference/cli.md</files>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/SKILL.md and references/types.md (Reference and Checklists sections)
    - README.md (the page being split), package.json (bin, engines, scripts), .github/workflows/ci.yml (Node and OS matrix)
    - src/cli/index.ts (USAGE text, parse rules, stdout/stderr contract), src/cli/tool-commands.ts (FLAGS, COMMANDS, MAINTAIN_TASKS, HISTORY_TOOLS, SINCE pattern, default window, FULL_TASKS rule, how --repo and --cwd resolve), src/cli/exit.ts (exit mapping and precedence), src/cli/init.ts and src/cli/init-targets.ts (init envelope, actions, agent ids and file locations), src/bin/gsd-atlas.ts, src/bin/cli-main.ts, src/bin/compose.ts (roots, user dir, cache root, config)
    - src/host/route.ts and src/host/host.ts (request kinds, error codes, busy and retry_after), src/host/history.ts (history result), src/host/lang.ts (lang list and lang test results), src/host/config.ts (user configuration file and keys), src/fact-store/location.ts (store location rules)
    - src/query/defaults.ts, src/query/envelope.ts (schema ids), src/query/status.ts (health data and reasons), src/facts/degraded.ts, src/facts/request.ts (Envelope fields)
    - scripts/cli-e2e.test.ts (real invocations and the outputs they expect)
  </read_first>
  <action>
Setup (no commit). (a) Work only in the isolated linked worktree you were given; the current directory is its root, `git status` is clean and `git branch --show-current` is not main. (b) Run `npm ci --ignore-scripts` and `npm run build`; both bins under dist/bin must exist afterwards. (c) Apply H8: make sure this worktree has a current codegraph index before reading source. (d) Create a probe area outside the checkout with `mktemp -d` and write its absolute path to a file named gsd-atlas-docs-probe-path.txt in the operating system's temporary directory, because later tasks start new shells. In the probe area create a git repository named atlas-demo (set a local user name and email so commits work) with three TypeScript files: one exporting a function parseConfig, one importing and calling it, one declaring a small class. Make two commits, the second changing the signature of parseConfig. Also create an empty directory named home in the probe area (used by tasks 4 and 5 for HOME overrides).

Probe the CLI (save outputs to the probe area, not the checkout): run `--version`, `--help`, `-h`, every command name with a wrong argument shape (no symbol name, unknown task, `--full` on a task it does not apply to, `--since` with a bad value, `history` without `--at`, a flag that does not apply to the command, an unknown command, no command), and a successful run of each command against atlas-demo (`build` first, then find, refs, context, impact, history find with --at HEAD~1, health, maintain, maintain compact --full, status, lang list, lang test with the toy module folder test/fixtures/modules/toy, and init --dry-run with HOME pointing at the probe home directory per H6). For each, record stdout schema id, the top-level keys of `data`, stderr lines and the exit code. To observe exit 3 and degraded: follower, drive a real stdio session with a short temporary node script kept in the probe area: spawn dist/bin/gsd-atlas-mcp.js with cwd set to atlas-demo, send initialize (protocol version 2025-06-18), the initialized notification and one tools/call of code_find (this opens the repository and takes the writer lease), keep stdin open, then run the CLI `find` (expect degraded containing follower) and the CLI `build` and `maintain` (expect error code lease_held and exit 3) from atlas-demo, then close stdin. Also run `find` in a directory that has no index (expect not_indexed, exit 2) and in a directory that is not a repository (expect not_a_repo).

Write docs/reference/cli.md as neutral reference, in this order, every entry the same shape, no instructions and no rationale (link out later, see task 10):
1. Title "gsd-atlas command-line reference" and a requirements line: Node 24.16.0 or newer (24.15.0 truncates TEXT at an embedded NUL in node:sqlite; cite package.json engines and the CI comment), macOS, Linux and Windows, git on the path. State the bin names from package.json (gsd-atlas, gsd-atlas-mcp) and their paths in a built clone (dist/bin/gsd-atlas.js, dist/bin/gsd-atlas-mcp.js). State that the CLI runs the Host inside its own process.
2. Output contract: exactly one JSON envelope on stdout, printed as the Host returned it; stderr carries one line per error or warning diagnostic in the form `gsd-atlas: severity code: message`, a busy answer adds the retry interval; `init` prints its own envelope with schema gsd-atlas.init/1 whose data is always present.
3. Exit codes: a table for 0, 1, 2 and 3 with the diagnostic codes that map to each and the precedence (usage, then lease held or busy, then any other failure, then ok), taken from src/cli/exit.ts and confirmed by the probes.
4. Options: --version/-v and --help/-h; selection options --repo and --cwd (relative values resolve against the process working directory; what happens when neither is given; that `health` ignores --cwd); paging options --budget, --more, --fresh (repeatable), --limit; history options --at, --path; the remaining option flags (--kind, --mode with its four values, --depth, --full, --since with its pattern and default window, --agent repeatable with its three values, --dry-run); the module root options --repo-root, --user-dir, --builtin-dir, --npm-root (repeatable, each replaces its default). Give each option's value form, which commands accept it, constraints and default, all from FLAGS, COMMANDS and the argument checks.
5. Commands, one subsection each in USAGE order: find, refs, context, impact, history, health, build, maintain, status, init, lang list, lang test. Each has the exact usage line from `--help`, arguments, accepted options, result schema id, the data fields observed, and the notable error outcomes. maintain lists its seven tasks and which accept --full. history lists its four tools and states that it reads git objects only, never writes to the index and never contacts a remote. init lists the three agents, the config file each one targets, the per-host actions (created, updated, unchanged, skipped, refused) and the refusal reasons that init.ts defines, including config_in_use and config_changed_during_init.
6. The result envelope: its fields (schema, ok, data, diagnostics, citations, watermark, untrusted_text, truncated, more, hints, retry_after, degraded) with the meaning each has in src/facts/request.ts and the diagnostic shape.
7. Degraded codes: all codes in DEGRADED_CODES, with a meaning only where the code's own comments give one; follower described precisely (the answer came from a process that does not hold the writer lease).
8. Defaults and limits: every DEFAULT_QUERY_CONFIG value with its meaning (default and ceiling budget in estimated tokens, line width, default and maximum limit, cursor length, fresh wait, resolve timeout, impact default and maximum depth, per-hop row cap).
9. Environment and user configuration, verified entries only: GSD_ATLAS_USER_DIR and its default, GSD_ATLAS_STORE_DIR (absolute path only), XDG_CACHE_HOME (absolute only, default under the home directory), the config.json keys and size cap that src/host/config.ts accepts, the warning given when the file is ignored; and where the index lives (git common directory by default, cache directory when the listed conditions hold, override wins).
Use tables for options, exit codes, defaults and codes; short fenced examples only where they illustrate a result line (paths per H5). Do not describe the guides; links to them are added in task 10.

Quality check against the Reference checklist in types.md, then run the verify command, then commit with `git add docs/reference/cli.md` and a message of the form `docs(quick-261017-slg): add CLI reference` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; test -f docs/reference/cli.md; node --input-type=module -e "import fs from 'node:fs'; import { FLAGS, COMMANDS, MAINTAIN_TASKS, HISTORY_TOOLS } from './src/cli/tool-commands.ts'; import { DEGRADED_CODES } from './src/facts/index.ts'; import { DEFAULT_QUERY_CONFIG } from './src/query/defaults.ts'; const t = fs.readFileSync('docs/reference/cli.md','utf8'); const need = [...Object.keys(FLAGS).map(f=>'--'+f), ...COMMANDS.map(c=>'gsd-atlas '+c.name), ...MAINTAIN_TASKS, ...HISTORY_TOOLS, ...DEGRADED_CODES, '--version', '--help', 'lease_held', 'not_indexed', 'gsd-atlas.init/1', 'config_in_use', 'config_changed_during_init']; const miss = need.filter(s=>!t.includes(s)); const defs = Object.values(DEFAULT_QUERY_CONFIG).filter(v=>v>9).filter(v=>!t.includes(String(v))).filter(v=>!t.includes(v.toLocaleString('en-US'))); console.log(JSON.stringify({miss, defs})); process.exit(miss.length||defs.length?1:0)"; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' docs/reference/cli.md; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>docs/reference/cli.md exists and is committed alone; the drift gate shows every FLAGS key, COMMANDS name, maintain task, history tool, degraded code and query default above 9 appears in it; the page states exit codes 0/1/2/3 and degraded follower from observed probes; no machine-specific path or later-phase capability appears; zero broken relative links; the probe area and atlas-demo exist for later tasks.</done>
</task>

<task type="auto">
  <name>Task 2: Write docs/reference/mcp.md</name>
  <files>docs/reference/mcp.md</files>
  <precondition>test -f dist/bin/gsd-atlas-mcp.js and the probe area from task 1 exists (path in gsd-atlas-docs-probe-path.txt in the temporary directory)</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (Reference section)
    - src/query/tools.ts (six tool definitions, strict schemas, fixed descriptions, buildRequest), src/query/types.ts, src/query/query.ts (dispatch and request-level errors), src/query/find.ts, refs.ts, context.ts, impact.ts, status.ts (result data shapes), cite.ts, fence.ts, page.ts, cursor.ts, budget.ts, text.ts, envelope.ts
    - src/mcp-shim/server.ts (server name, capabilities, SERVER_INSTRUCTIONS, FAILURE_TEXT, isError rule), src/mcp-shim/index.ts (stdio runner, exit codes, stderr lines), src/mcp-shim/stdout-guard.ts, src/bin/gsd-atlas-mcp.ts, src/bin/shutdown.ts (signal exit codes)
    - src/host/host.ts and src/host/route.ts (not_a_repo, invalid_args, schema_too_new, busy and retry_after, timeout, the build-only store creation rule), src/tenant/messages.ts (not_indexed, lease_held and store_unavailable texts), src/tenant/create.ts (failure mapping, lease handling), src/tenant/follower-overlay.ts (header comment), src/fact-store/lease.ts (lease files and holder info)
    - scripts/mcp-stdio.test.ts and scripts/test-helpers/mcp-process.ts (how the repo drives a real stdio session)
    - docs/adr/13-mcp-contract.md (link target only; do not restate it)
  </read_first>
  <action>
Drive a real stdio session with a short temporary node script kept in the probe area (never in the checkout): spawn dist/bin/gsd-atlas-mcp.js with cwd set to the atlas-demo repository from task 1 (indexed with `build` beforehand), send initialize with protocol version 2025-06-18, the initialized notification, tools/list, and one tools/call for each of code_find, code_refs, code_context, code_impact, atlas_status and lang_list. Also call code_find against a directory with no index (expect not_indexed) and with a repo argument that is not a repository (expect not_a_repo), and one call with an argument the schema does not allow (expect invalid_args). Record serverInfo, capabilities, the instructions text, each tool's title, description and inputSchema, each result's schema id, data keys, isError value and a trimmed example envelope. Confirm that the tools/list result has exactly six tools, including lang_list (the brief names five; the code registers six and the reference documents all six).

Write docs/reference/mcp.md as neutral reference, in this order, same shape per entry:
1. Title "gsd-atlas MCP reference". Server: name gsd-atlas, version source, stdio transport, how it is launched (the gsd-atlas-mcp bin; path in a built clone), capabilities (tools only), statelessness (no session; the repository is chosen on each call by the repo or cwd argument, defaulting to the server's working directory), the Host is composed on the first tool call, protocol frames only on stdout, stderr line form for warnings and errors, exit codes at end of input and on SIGTERM and SIGINT, and the fixed server instructions text.
2. Tools: a summary table of the six tools, each marked read-only.
3. One subsection per tool in the same shape: title, fixed description, an input table (name, type, required, default, meaning) built from the tool's strict schema (unknown keys are refused), the result schema id, the fields of data, and one trimmed example (paths per H5, a varying nonce named as varying). atlas_status documents every field of the snapshot and the health reasons; lang_list documents what the probe returned.
4. The result envelope as an MCP tool result: one text content item holding the JSON envelope, isError equal to not ok, the fixed failure text when the Host cannot answer. Link cli.md (same folder) for the shared envelope fields and the degraded code table instead of repeating them.
5. Untrusted text: the untrusted_text object, the per-response nonce, the BEGIN and END fence lines, and the rule that repository text appears only there and each entry is tied to a citation by ref.
6. Paging and budgets: budget_tokens, limit and its clamp, more cursor, truncated, fresh and the watermark; the numeric defaults come from src/query/defaults.ts and must match what cli.md states.
7. Error envelopes: schema gsd-atlas.error/1 and every error code the probes or the code show for the tools, each with its condition and exact text where the text is fixed. not_indexed has its two texts (no index at all; worktree not built while another process holds the writer); store_unavailable has its condition (the store closed itself after a failed recovery or was closed under a request) and its text; also lease_held, busy with retry_after, invalid_args, not_a_repo, unavailable, schema_too_new, timeout, unknown_worktree and tenant_closed, each only if verified.
8. Writer lease: what holds it (the process that opened the repository first), what it permits (indexing, watching, maintenance), that other processes answer read-only with degraded follower, the lease files and lease.json fields, how atlas_status shows it (writerLeaseHeld and the follower health reason), what build and maintain return from a non-holder (lease_held, CLI exit 3), and that no hand-off to the holder exists today. Do not explain why; that belongs to the explanation page (linked in task 10).

Quality check against the Reference checklist, run the verify command, then commit `git add docs/reference/mcp.md` with message `docs(quick-261017-slg): add MCP reference` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; test -f docs/reference/mcp.md; node --input-type=module -e "import fs from 'node:fs'; import { TOOLS } from './src/query/tools.ts'; const t = fs.readFileSync('docs/reference/mcp.md','utf8'); const need = [...TOOLS.map(x=>x.name), ...TOOLS.flatMap(x=>Object.keys(x.inputSchema.shape)), 'not_indexed', 'store_unavailable', 'lease_held', 'follower', 'untrusted_text', 'writer lease', 'gsd-atlas.error/1', 'isError']; const miss = [...new Set(need)].filter(s=>!t.includes(s)); console.log(JSON.stringify(miss)); process.exit(miss.length?1:0)"; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' docs/reference/mcp.md; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>docs/reference/mcp.md is committed alone and documents all six registered tools with every input property of their schemas, result shapes from a live session, the not_indexed and store_unavailable envelopes, untrusted-text fencing and the writer lease; the drift gate and hygiene gate pass; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 3: Write docs/explanation/how-freshness-and-the-writer-lease-work.md</name>
  <files>docs/explanation/how-freshness-and-the-writer-lease-work.md</files>
  <precondition>docs/reference/cli.md and docs/reference/mcp.md exist (tasks 1 and 2 committed)</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (Explanation section)
    - docs/DESIGN.md (the sections "Lifecycle, compaction & self-healing", "Maintenance tasks (A21)", "Concurrency & scale" and the decisions table; confirm any A-number you cite exists), docs/adr/7-fact-store-interface.md, 8-sqlite-store.md, 9-tenant-composition.md, 11-worktree-lifecycle.md, 12-query-and-policy.md, 13-mcp-contract.md, 3-trust-boundaries.md, 6-fact-model.md (read the parts that give reasons), GLOSSARY.md (use its terms: Host, Tenant, Overlay, Watermark, Fact Store, Indexer, Query)
    - src/host/host.ts (the build-only store creation rule and its WR-01 and WR-02 comments), src/tenant/messages.ts (header comment states the honest limit), src/tenant/create.ts (lease change handling, takeover, start-up reconcile, idle round, maintenanceSlice), src/tenant/idle.ts, src/tenant/defaults.ts, src/host/defaults.ts, src/indexer/defaults.ts, src/fact-store/lease.ts, src/fact-store/maintain.ts (IDLE_MAINTENANCE), src/query/cite.ts, src/query/fence.ts, scripts/size-gate.ts (header comment on idle-only size)
  </read_first>
  <action>
Write one explanation page, "About how freshness and the writer lease work", whose title line starts with "About". It answers five bounded "why" questions as five sections, in prose with reasons, context and alternatives where an ADR, DESIGN.md or a code comment records them, and links to those documents instead of restating decisions (H4):
1. Why only `build` creates an index: questions never write or create anything, so an asking tool cannot change a repository's index by accident, and the not_indexed answer names the exact command; cover why a store that exists but holds nothing to read is also not opened by a question (opening it as the leader would take the lease and make the advertised build fail).
2. What the writer lease is and why followers exist: one process per repository indexes, watches and maintains; others answer read-only and say so with degraded follower; a follower can still answer for paths named in a fresh argument by overlay; a follower retries the lease on a jittered interval so that it takes over when the holder ends; the consequence that a terminal build collides with an agent's running server and what the honest limit is today (end the holder, build, restart it), taken from the header comment in src/tenant/messages.ts.
3. How the index stays fresh: the file watcher (native, poll or reconcile-only watch modes), debounce and maximum wait, the start-up reconcile with its deadline after which an answer is marked reconciling, the periodic idle reconcile, read-your-writes through the fresh argument with its bounded wait, and the watermark that tells a caller what the answer is as of. Use the approved default values only as they appear in src/indexer/defaults.ts and src/tenant/defaults.ts, stated inline once each, not as an option table.
4. Why compaction waits for idle: maintenance runs in slices when no request has arrived for the idle period, yields at once when a request arrives and resumes after the next quiet period; the single exception of a full compaction that cannot be interrupted once it has started; why the size gate asserts the idle-only size rather than the size after a manual full compaction (scripts/size-gate.ts header).
5. Why answers are cited and worktree-correct: every result carries a citation (path, line, column, confidence, a debug handle) and repository text travels only inside nonce-fenced untrusted_text; the index is shared by all worktrees of a repository through the git common directory but each worktree has its own overlay, and the repo argument selects the worktree; history questions are answered from git alone. Link ../adr/6-fact-model.md, ../adr/11-worktree-lifecycle.md, ../adr/13-mcp-contract.md and ../adr/3-trust-boundaries.md for the decisions.
Link to the reference pages for every fact a reader may want to look up (../reference/cli.md, ../reference/mcp.md) and to ../DESIGN.md and the ADRs for decisions. The page contains no step lists, no option tables and no commands to run; it does not describe any capability beyond H3. Keep it to roughly 120 to 200 lines.

Quality check against the Explanation checklist, run the verify command, then commit `git add docs/explanation/how-freshness-and-the-writer-lease-work.md` with message `docs(quick-261017-slg): add explanation of freshness and the writer lease` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; f=docs/explanation/how-freshness-and-the-writer-lease-work.md; test -f $f; head -1 $f | grep -q '^# About '; for k in 'writer lease' follower reconcil idle compaction citation worktree 'not_indexed' 'DESIGN.md' '7-fact-store-interface' '9-tenant-composition' '11-worktree-lifecycle' '13-mcp-contract' '../reference/cli.md' '../reference/mcp.md'; do grep -q -- "$k" $f || { echo "missing: $k"; exit 1; }; done; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>The explanation page is committed alone; its title starts "About"; it covers the five questions with reasons sourced from ADRs, DESIGN.md or code comments and links to them; it has no step list or option table; every cited A-number or ADR exists; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 4: Write docs/how-to/register-the-mcp-server.md</name>
  <files>docs/how-to/register-the-mcp-server.md</files>
  <precondition>test -f dist/bin/gsd-atlas.js; all init runs use HOME set to the probe area's home directory (H6)</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (How-to guides and Tutorial vs how-to)
    - src/cli/init.ts, src/cli/init-targets.ts (TARGETS: file path, detection rule, whether init creates the file, JSON versus TOML rendering, manual command), src/cli/init-files.ts (ConfigChangedError, ConfigInUseError, atomic write), src/cli/index.ts (the init handler and its flag checks), src/bin/gsd-atlas.ts (home comes from the operating system home directory; launch command is the node executable plus the absolute path of the gsd-atlas-mcp file)
    - src/cli/init.test.ts and src/cli/init-files.test.ts (outcomes the repo itself expects)
  </read_first>
  <action>
Write one how-to whose first line is "# How to register the MCP server with Claude Code, Cursor and Codex". One goal, action only, for a reader who already has a built clone. Probe every outcome first with HOME redirected to the probe home directory (H6): an empty home (every host skipped as not detected), a home in which each host is made detectable the way src/cli/init-targets.ts detects it (a folder or a file), a second run (unchanged), a changed launch path (updated), a config file containing invalid JSON (refused, file left untouched), and a host that does not create its own file (skipped with the manual command printed). Never write under the real home.

Content, in order: a one-line precondition (`npm run build` done in the clone; Node 24.16.0 or newer); preview with `node dist/bin/gsd-atlas.js init --dry-run` and what to read in the output (the per-host action and file); apply with `init`, or limit it with `--agent` (repeatable: claude, cursor, codex); the table of per-host config files and what init writes there (command: the node executable; argument: the absolute path of the gsd-atlas-mcp file; the entry name); build the repository (init prints a hint on stderr when a repository without an index is around the working directory; `build` is the only command that creates an index); then check the registration took (re-running init reports unchanged). Forks as "If ..." lines: a host is skipped as not_detected; a host reports config_not_found and prints the manual command; a host is refused because its file is not valid or has the wrong shape (fix the file; init leaves it untouched); `config_in_use` (close the program that holds the file or fix folder permissions, run init again); `config_changed_during_init` (nothing was written, run init again); the clone moved or the Node executable changed (run init again, it updates the entry). Link ../reference/cli.md for every flag and the init envelope, ../reference/mcp.md for the tools the server offers, and ../explanation/how-freshness-and-the-writer-lease-work.md for why the server cannot build. Do not explain the agents' own settings screens or restart behaviour (not verifiable here). No teaching, no digression.

Quality check against the How-to checklist, run the verify command, then commit `git add docs/how-to/register-the-mcp-server.md` with message `docs(quick-261017-slg): add how-to register the MCP server` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; f=docs/how-to/register-the-mcp-server.md; test -f $f; head -1 $f | grep -q '^# How to register the MCP server'; for k in 'init --dry-run' '--agent' config_in_use config_changed_during_init not_detected 'gsd-atlas build' '../reference/cli.md' '../explanation/how-freshness-and-the-writer-lease-work.md'; do grep -q -- "$k" $f || { echo "missing: $k"; exit 1; }; done; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>The how-to is committed alone with a "How to" title and one goal; every outcome and error name in it appears in init.ts and was observed or read from the tests; no real agent configuration file was touched; it links to the reference and explanation instead of repeating them; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 5: Write docs/how-to/answer-a-question-about-an-older-commit.md</name>
  <files>docs/how-to/answer-a-question-about-an-older-commit.md</files>
  <precondition>test -f dist/bin/gsd-atlas.js and the atlas-demo repository from task 1 has two commits</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (How-to guides)
    - src/cli/tool-commands.ts (the history command, its flags and the --at checks), src/host/history.ts (what history reads, result data, error codes, bounds), src/host/route.ts, src/query/cite.ts
    - scripts/cli-e2e.test.ts and src/host/history.test.ts (the outcomes the repo itself expects)
  </read_first>
  <action>
Write one how-to titled "# How to answer a question about an older commit" for a reader who has a repository (indexed or not) and wants a symbol question answered as of an earlier revision. Probe in atlas-demo: `history find parseConfig --at HEAD~1`, the same with a branch name, a tag and a full commit id; each of refs, context and impact through history; `--path` to read one file of that commit; `--limit` and `--budget`; a revision that does not exist; a revision that starts with a dash; a missing --at; a repository with no index at all (does history still answer, or does it return not_indexed); and confirm history leaves the index unchanged (compare the health watermark seq and store size before and after).

Content: the command with its four tools and `--at`; what the answer is (the code as of that commit, answered from git objects alone, never written to the index, no remote contacted, citations that name the revision if the result says so); steps: pick the revision, run the command, read the citation and the as-of information in the envelope (only fields the probe shows). Forks as "If ..." lines: you only need one file (use --path); the answer is too large (--limit, --budget, --more if the history result supports paging; state it only if verified); the revision is not found or is unusable (the exact error code and exit code the probe returned); the repository was never built (what happens, verified); the clone is shallow and lacks the commit (include only if reproduced). Link ../reference/cli.md for every flag and exit code, ../reference/mcp.md for the result envelope, and nothing else. Action only: no explanation of how history works internally.

Quality check against the How-to checklist, run the verify command, then commit `git add docs/how-to/answer-a-question-about-an-older-commit.md` with message `docs(quick-261017-slg): add how-to answer a question about an older commit` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; f=docs/how-to/answer-a-question-about-an-older-commit.md; test -f $f; head -1 $f | grep -q '^# How to answer a question about an older commit'; for k in 'history' '--at' '--path' 'git' '../reference/cli.md'; do grep -q -- "$k" $f || { echo "missing: $k"; exit 1; }; done; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>The how-to is committed alone with a "How to" title and one goal; each fork and error it names was reproduced or read in src/host/history.ts; it states that history never writes to the index (confirmed by the before-and-after probe); zero broken links.</done>
</task>

<task type="auto">
  <name>Task 6: Write docs/how-to/keep-the-store-healthy.md</name>
  <files>docs/how-to/keep-the-store-healthy.md</files>
  <precondition>test -f dist/bin/gsd-atlas.js and atlas-demo is built</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (How-to guides)
    - src/cli/tool-commands.ts (maintain tasks, the --full rule, status window), src/query/status.ts (HEALTH_REASONS and the snapshot), src/tenant/create.ts (maintain task execution, lease requirement, idle round, maintenanceSlice), src/tenant/idle.ts, src/tenant/defaults.ts, src/fact-store/maintain.ts (IDLE_MAINTENANCE), src/fact-store/lifecycle.ts (what collect, compact and check do), src/host/host.ts (maintain and status routing)
    - docs/DESIGN.md "Maintenance tasks (A21)" (link target, not to be restated)
  </read_first>
  <action>
Write one how-to titled "# How to keep the store healthy" for a reader who runs gsd-atlas regularly and wants to check and tidy the index. Probe in atlas-demo: `health` (read data.health, data.reasons, data.store.sizeBytes, data.store.writerLeaseHeld, data.indexer.watchMode), `status` and `status --since 24h`, `maintain` with no task, each of the seven tasks, `maintain compact`, `maintain compact --full`, `--full` on a task it does not apply to (usage error), and maintain while another process holds the writer lease (drive the stdio session as in task 1: expect lease_held and exit 3). Read the code for what each task does and for the idle behaviour; state in the guide only what those show.

Content, in order: check the index with `health` and how to read ok versus degraded and each reason in HEALTH_REASONS (follower, rebuilding, reconciling, stale_files, watch_fallback, indexer_failures) with the single action each calls for, stated only where the code or probe supports one; see local usage numbers with `status` (and the `--since` form; token figures are estimates); run upkeep with `maintain` (all tasks) or one named task; reclaim space with `maintain compact --full` and the caution that a full compaction in progress cannot be interrupted (from src/tenant/create.ts and DESIGN.md); the idle-only behaviour as a practical fact (a running server compacts by itself after a quiet period, so an explicit full compaction is rarely needed; one clause plus a link, no explanation). Forks as "If ..." lines: maintain returns lease_held with exit 3 (another process, such as an agent's server, holds the writer: end that session, run maintain, start the session again; no hand-off exists); health says follower; the store was rebuilt after corruption (data.store.rebuilt); the index was written by a newer version (schema_too_new, the error text says what to do). Link ../reference/cli.md for flags and exit codes, ../reference/mcp.md for the atlas_status fields and ../explanation/how-freshness-and-the-writer-lease-work.md for why compaction waits for idle and what the lease is. No teaching, no digression.

Quality check against the How-to checklist, run the verify command, then commit `git add docs/how-to/keep-the-store-healthy.md` with message `docs(quick-261017-slg): add how-to keep the store healthy` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; f=docs/how-to/keep-the-store-healthy.md; test -f $f; head -1 $f | grep -q '^# How to keep the store healthy'; for k in 'health' 'maintain' 'maintain compact --full' 'lease_held' 'exit 3' 'status' '../reference/cli.md' '../explanation/how-freshness-and-the-writer-lease-work.md'; do grep -q -- "$k" $f || { echo "missing: $k"; exit 1; }; done; node --input-type=module -e "import fs from 'node:fs'; import { HEALTH_REASONS } from './src/query/status.ts'; const t = fs.readFileSync('docs/how-to/keep-the-store-healthy.md','utf8'); const miss = HEALTH_REASONS.filter(s=>!t.includes(s)); console.log(JSON.stringify(miss)); process.exit(miss.length?1:0)"; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>The how-to is committed alone with a "How to" title; every health reason in HEALTH_REASONS is covered; maintain, maintain compact --full, the lease-held fork with exit 3 and the idle-only point (with a link) are present and were observed or read in the code; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 7: Write docs/how-to/run-the-measured-gates-locally.md</name>
  <files>docs/how-to/run-the-measured-gates-locally.md</files>
  <precondition>test -f dist/bin/gsd-atlas.js; git can reach the corpus repository named in corpora/corpora.json (check with git ls-remote) if the corpus gates are to be run</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (How-to guides)
    - package.json (script names), scripts/recall.ts (header comment, parseArgs options, DEFAULT_MIN_RECALL, DEFAULT_SAMPLE_SIZE, the printed table and exit rule), scripts/corpus-gates.ts (header, options --corpus and --keep, checks, STORE_MAX_BYTES, PARSE_ERROR_RATIO_MAX, printed lines, exit rule), scripts/size-gate.ts (options, DEFAULTS, DEFAULT_MAX_RATIO, printed figures, OVER and exit rule), scripts/freshness-gate.ts (options, DEFAULTS, the two ceilings, printed percentiles, exit rule), scripts/corpus-fetch.ts and corpora/corpora.json and corpora/README.md (what is fetched, from where, temporary directory and cleanup), .github/workflows/ci.yml and nightly.yml (which gate runs where with which arguments)
  </read_first>
  <action>
Write one how-to titled "# How to run the measured gates locally". The four gates are npm scripts: recall:corpus, gates:corpus, size-gate and gates:freshness. Run each for real to capture its printed output: size-gate and gates:freshness with reduced parameters (for example a few hundred edits and a handful of saves; use the script's own options) and the corpus gates once with defaults if the network allows. If a corpus gate cannot be run, document only its command, options, pass rule and printed format as the script's code defines them, and say nothing about numbers.

Content: a one-line precondition (built clone; the corpus gates download a pinned checkout of the repository named in corpora/corpora.json into a temporary directory and remove it afterwards, so they need git access to that repository; the other two gates need no network); then one numbered step per gate with the exact command (copy from package.json, including the existing README form `npm run gates:freshness -- --saves 30 --max-ms 3000`), what the output lines mean in the order the script prints them, the pass or fail rule and the exit code, and the defaults (minimum recall, sample size, store ceiling, parse-error ratio, edits, files, maximum ratio, saves, the nightly and pull-request freshness ceilings), each taken from the scripts. Forks as "If ..." lines: a corpus fetch fails; a gate fails (which line names the failing check); you want to keep the corpus checkout (`--keep` on gates:corpus, if verified); a hosted-runner-noise choice between the two freshness ceilings (state the two values and which job uses which, from the workflows). Link ../reference/cli.md where a CLI command is named. Do not link the contribute guide: it does not exist when this task commits, and it links here instead. No teaching.

Quality check against the How-to checklist, run the verify command, then commit `git add docs/how-to/run-the-measured-gates-locally.md` with message `docs(quick-261017-slg): add how-to run the measured gates locally` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; f=docs/how-to/run-the-measured-gates-locally.md; test -f $f; head -1 $f | grep -q '^# How to run the measured gates locally'; for k in 'recall:corpus' 'gates:corpus' 'size-gate' 'gates:freshness' '--max-ms' 'corpora/corpora.json'; do grep -q -- "$k" $f || { echo "missing: $k"; exit 1; }; done; node --input-type=module -e "import fs from 'node:fs'; const pkg = JSON.parse(fs.readFileSync('package.json','utf8')); const t = fs.readFileSync('docs/how-to/run-the-measured-gates-locally.md','utf8'); const names = [...t.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map(m=>m[1]); const bad = names.filter(n=>typeof pkg.scripts[n] !== 'string'); console.log(JSON.stringify({names: [...new Set(names)], bad})); process.exit(bad.length?1:0)"; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>The how-to is committed alone with a "How to" title; all four gates appear with commands that exist in package.json, defaults and pass rules taken from the scripts, and output meaning taken from a real run or from the script's print code; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 8: Write docs/how-to/contribute-a-change.md</name>
  <files>docs/how-to/contribute-a-change.md</files>
  <precondition>test -f dist/bin/gsd-atlas.js</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (How-to guides)
    - README.md (the Developer quickstart block being moved), package.json (scripts, engines), .github/workflows/ci.yml (static job, Node and OS matrix, grammar job), scripts/ensure-tree-sitter.ts (header comment: what it downloads), scripts/grammar-budget.ts, scripts/grammar-verify.ts, scripts/grammar-build.ts and scripts/schema-build.ts (headers), scripts/package.test.ts (what npm test packs and whether the pack test uses the network), test/fixtures/modules/toy (the lang test target)
  </read_first>
  <action>
Write one how-to titled "# How to contribute a change" for a reader who already has a clone and has edited code. Run each command from the Developer quickstart yourself and note its real behaviour: `npm ci --ignore-scripts`, `npm run build`, `npm test` (note that it builds and packs the tarball and read scripts/package.test.ts to see whether the pack step uses the network; keep the README's statement only if confirmed), `npm run lint`, `npm run typecheck`, `npm run schema:check`, `npm run grammar:budget`, `node scripts/ensure-tree-sitter.ts` then `npm run grammar:verify` (the first downloads the wasi-sdk toolchain used by tree-sitter-cli; confirm from the script), `node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy` and `node dist/bin/gsd-atlas.js lang list`. Also confirm how to run one test file with the node test runner from the `test` script's form.

Content: a short precondition (Node 24.16.0 or newer, git); the commands in the order a change is checked, each with one clause saying what it proves and the expected success signal (exit 0; lang test and lang list print one JSON envelope on stdout, exit 1 for usage errors or an unknown module, exit 2 for a failed check, verified); a note on running a single test file; the CI matrix (Node 24.16.0 and 26 on macOS, Linux and Windows) from ci.yml as the bar a change must clear. Forks as "If ..." lines: grammar:verify reports a mismatch with grammar.lock (what it compares, from the script header); schema:check reports drift (the command that regenerates is schema:build, if the script says so); a Windows-specific failure (only if the repo's own docs or workflow comments describe one that this guide needs; otherwise omit). Link ../reference/cli.md for the lang commands and exit codes, and run-the-measured-gates-locally.md (same folder) for the measured gates. No teaching, no digression.

Guard note for this task: the repo hook blocks a Bash command that names an indexed source file as an operand, so `node scripts/ensure-tree-sitter.ts` cannot be run from your shell. Do not work around the hook. Establish what that script does (what it downloads, where, when it is needed) by reading it through codegraph, run `npm run grammar:verify` and the other npm scripts (they carry no path operand), and state in the guide only what the script's code and those runs show. Record in SUMMARY.md that this one command was verified by reading, not by running.

Quality check against the How-to checklist, run the verify command, then commit `git add docs/how-to/contribute-a-change.md` with message `docs(quick-261017-slg): add how-to contribute a change` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; f=docs/how-to/contribute-a-change.md; test -f $f; head -1 $f | grep -q '^# How to contribute a change'; for k in 'npm ci --ignore-scripts' 'npm run build' 'npm test' 'npm run lint' 'npm run typecheck' 'npm run schema:check' 'npm run grammar:budget' 'npm run grammar:verify' 'node scripts/ensure-tree-sitter.ts' 'lang test test/fixtures/modules/toy' 'lang list' 'run-the-measured-gates-locally.md'; do grep -q -- "$k" $f || { echo "missing: $k"; exit 1; }; done; node --input-type=module -e "import fs from 'node:fs'; const pkg = JSON.parse(fs.readFileSync('package.json','utf8')); const t = fs.readFileSync('docs/how-to/contribute-a-change.md','utf8'); const names = [...t.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map(m=>m[1]); const bad = names.filter(n=>typeof pkg.scripts[n] !== 'string'); console.log(JSON.stringify(bad)); process.exit(bad.length?1:0)"; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>The how-to is committed alone with a "How to" title and the full set of contributor commands from the brief plus the lang test and lang list checks; every npm run name exists in package.json; claims about network use and the toolchain download are confirmed from the scripts or omitted; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 9: Write docs/tutorials/index-and-ask.md and replay it end to end</name>
  <files>docs/tutorials/index-and-ask.md</files>
  <precondition>docs/reference/cli.md, docs/reference/mcp.md, the explanation page and the five how-to pages exist (tasks 1 to 8 committed)</precondition>
  <read_first>
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (Tutorials, Tutorial vs how-to, Checklists)
    - README.md (the Phase 2 quickstart being turned into a lesson), package.json (engines, scripts, bin), docs/reference/cli.md (the verified output facts you will quote)
    - src/query/find.ts, refs.ts, context.ts, impact.ts (result fields to point out), src/source-tree (how untracked files count; confirmed by the replay)
  </read_first>
  <action>
Write the tutorial, then replay it exactly as written in a pristine area and correct the page until the replay and the page agree.

Design (fixed): the lesson clones and builds gsd-atlas, then indexes a small scratch repository that the lesson itself creates, so the expected output is exact and independent of how gsd-atlas's own code changes later, and nothing is written into the clone's working tree or history. Use two sibling folders: gsd-atlas (the clone) and atlas-demo (the scratch repository). The destination sentence starts "In this tutorial we will". Steps, one visible result each, almost no explanation (a clause and a link at most), a single path with no options or alternatives, second step onward written as "First, do x. Now, do y.":
1. Check the toolchain: `node --version` prints a version of 24.16.0 or newer.
2. Clone and build: `git clone https://github.com/open-gsd/gsd-atlas.git`, `cd gsd-atlas`, `npm ci --ignore-scripts`, `npm run build`; the expected result is that the build prints nothing and `node dist/bin/gsd-atlas.js --version` prints the version line (use the real output). Make no claim about who can reach the repository and do not describe installing from the package registry (see the objective's findings).
3. Create the scratch repository next to the clone: a folder atlas-demo with two or three small TypeScript files whose full contents are shown in code blocks for the reader to create with an editor (no shell here-documents, so it works on Windows), then `git init`, plus `git add` and `git commit` only if the replay proves they are required.
4. Index it: from inside atlas-demo run `node ../gsd-atlas/dist/bin/gsd-atlas.js build`; show the real envelope (counts of files parsed) and say what to notice (ok is true, the files count).
5. Ask where it is defined: `find parseConfig` (or the demo's symbol); show the real envelope and point out the citation (path, line, column), confidence EXTRACTED, and that the source line arrives inside untrusted_text between fence lines.
6. Ask who uses it, what surrounds it and what breaks if it changes: `refs`, `context` and `impact` (with `--depth 2` if the replay shows it is the default and `impact` accepts it; otherwise omit the flag), each with its real output and one thing to notice.
7. Save a new file in atlas-demo (contents shown), then ask `find` for the new symbol: the answer includes it, with no re-run of `build` (confirmed on a probe repository: the next question found a saved untracked file).
8. Close with one line that mildly admires what was achieved and a short "Next" list of links: ../how-to/register-the-mcp-server.md, ../reference/cli.md, ../explanation/how-freshness-and-the-writer-lease-work.md.
Output blocks: show the real single-line JSON the replay produced. Replace the machine's absolute path with /path/to/atlas-demo (H5) and tell the reader in one sentence which parts vary from run to run (the nonce and the path). Keep every command in a block labelled for a POSIX shell, using only the commands whose spelling is identical on Windows (node, git, npm, cd); do not use rm or cat.

Replay (mandatory): in a fresh probe folder outside the checkout, clone this worktree with `git clone PATH-TO-THIS-WORKTREE gsd-atlas` (local clone instead of the network), run every command from the page in order, compare each output with the page, and fix whichever side is wrong. Cover a restart: delete atlas-demo and the clone's dist, run the lesson again and confirm it works from the top (the lesson must be safe to restart). Do not leave the tutorial depending on any state from tasks 1 to 8.

Quality check against the Tutorial checklist in types.md (destination stated, visible result each step, expected output, no options, explanation reduced to a clause and a link), run the verify command, then commit `git add docs/tutorials/index-and-ask.md` with message `docs(quick-261017-slg): add tutorial index-and-ask` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; f=docs/tutorials/index-and-ask.md; test -f $f; grep -q 'In this tutorial we will' $f; for k in 'npm ci --ignore-scripts' 'npm run build' 'gsd-atlas.js build' 'find ' 'refs ' 'context ' 'impact ' 'untrusted_text' 'EXTRACTED' '../reference/cli.md' '../how-to/register-the-mcp-server.md'; do grep -q -- "$k" $f || { echo "missing: $k"; exit 1; }; done; if grep -niE 'you will learn|npm install|is public' $f; then echo TUTORIAL-FAIL; exit 1; fi; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo HYGIENE-FAIL; exit 1; fi; node --input-type=module -e "import fs from 'node:fs'; import { COMMANDS } from './src/cli/tool-commands.ts'; const names = new Set(COMMANDS.map(c=>c.name)); const t = fs.readFileSync('docs/tutorials/index-and-ask.md','utf8'); const used = [...t.matchAll(/gsd-atlas\.js ([a-z]+)/g)].map(m=>m[1]); const bad = used.filter(u=>!names.has(u)); console.log(JSON.stringify({used: [...new Set(used)], bad})); process.exit(bad.length?1:0)"; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>The tutorial is committed alone; it states its destination, shows real expected output after every command, contains no options or alternatives and almost no explanation; the executor replayed it from a fresh local clone, including a restart, and the page matches the replay; the page makes no claim about repository visibility and does not describe registry installation; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 10: Add outward links to the reference pages</name>
  <files>docs/reference/cli.md, docs/reference/mcp.md</files>
  <precondition>every how-to page, the explanation page and the tutorial exist (tasks 3 to 9 committed)</precondition>
  <read_first>
    - docs/reference/cli.md and docs/reference/mcp.md (the closing section of each)
    - ~/.claude/skills/writing-docs-with-diataxis/references/types.md (Reference: describe and link out)
  </read_first>
  <action>
Append one closing "See also" section to each reference page. It is a bare list of links, one line each, with a few words naming what the target does and no instruction or explanation of its own. In docs/reference/cli.md link: the tutorial (../tutorials/index-and-ask.md), the five how-to pages by their titles, mcp.md (same folder), and the explanation page. In docs/reference/mcp.md link: cli.md (same folder), ../how-to/register-the-mcp-server.md, ../how-to/keep-the-store-healthy.md, the explanation page, and docs/adr/13-mcp-contract.md (../adr/13-mcp-contract.md) as the decision record. Use Edit (scoped append), not a whole-file rewrite, so nothing else in either page changes. Re-run the task 1 and task 2 drift gates after the edit and confirm the diff of each file is only the appended section. Commit both files with message `docs(quick-261017-slg): link reference pages to guides and explanation` plus the harness attribution lines.
  </action>
  <verify>
    <automated>set -e; for f in docs/reference/cli.md docs/reference/mcp.md; do grep -q '^## See also' $f || { echo "no See also in $f"; exit 1; }; done; for k in '../tutorials/index-and-ask.md' '../how-to/register-the-mcp-server.md' '../how-to/answer-a-question-about-an-older-commit.md' '../how-to/keep-the-store-healthy.md' '../how-to/run-the-measured-gates-locally.md' '../how-to/contribute-a-change.md' '../explanation/how-freshness-and-the-writer-lease-work.md' 'mcp.md'; do grep -q -- "$k" docs/reference/cli.md || { echo "cli.md missing: $k"; exit 1; }; done; for k in 'cli.md' '../how-to/register-the-mcp-server.md' '../explanation/how-freshness-and-the-writer-lease-work.md' '../adr/13-mcp-contract.md'; do grep -q -- "$k" docs/reference/mcp.md || { echo "mcp.md missing: $k"; exit 1; }; done; node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>Both reference pages end with a links-only See also section reaching the tutorial, guides, explanation and (for the MCP page) the contract ADR; nothing else in either page changed; zero broken links.</done>
</task>

<task type="auto">
  <name>Task 11: Rewrite README.md as the front door and run the final checks</name>
  <files>README.md</files>
  <precondition>every page from tasks 1 to 10 is committed</precondition>
  <read_first>
    - README.md (current), package.json (engines, bin, scripts), .github/workflows/ci.yml (Node and OS matrix)
    - scripts/package.test.ts lines 451 to 471 (the pinned README test, H10) via codegraph
    - docs/adr/README.md and docs/PRD.md (existing link targets), docs/reference/cli.md (so README states nothing the reference does not)
    - ~/.claude/skills/writing-docs-with-diataxis/SKILL.md (README section-to-quadrant guidance)
  </read_first>
  <action>
Before writing, verify the privacy claim (H4): use codegraph to check that nothing under src (excluding tests) opens a network connection or sends telemetry: no use of the node network modules (http, https, net, tls, dgram, dns), no global fetch call, and the MCP runner imports only the stdio entry of the MCP SDK. If every check holds, the README may say that answering questions and indexing use no network and send no telemetry (the corpus gates and the pack test are development tooling and are not part of this claim). If any check fails, state only what is true or omit the sentence.

Rewrite README.md (a full rewrite of a file you have already read) as a front door of at most 70 lines:
1. Title and a first paragraph that describes only what ships: gsd-atlas builds a local index of a code repository and answers cited, fresh, worktree-correct questions for coding agents (where a symbol is defined, who refers to it, what surrounds it, what depends on it) through the gsd-atlas command and a stdio MCP server. Rewrite the old opening so no present-tense claim covers anything beyond H3.
2. Status: TypeScript and JavaScript repositories, macOS, Linux and Windows, Node 24.16.0 or newer (CI runs Node 24.16.0 and 26 on all three); the verified no-network and no-telemetry sentence if allowed; then exactly one sentence that names every capability listed in H3 and says each arrives in a subsequent phase. This is the only place any page may name them.
3. Where to go, one pointer per need, as links: learn (docs/tutorials/index-and-ask.md); do (one line per how-to: register the MCP server, answer a question about an older commit, keep the store healthy, run the measured gates locally, contribute a change); look up (docs/reference/cli.md, docs/reference/mcp.md); understand (docs/explanation/how-freshness-and-the-writer-lease-work.md).
4. A compact Developer quickstart under the exact heading "## Developer quickstart" (H10): a single shell block containing only `npm ci --ignore-scripts`, `npm run build`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run schema:check`, `npm run grammar:budget`, `node scripts/ensure-tree-sitter.ts`, `npm run grammar:verify`, `node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy` and `node dist/bin/gsd-atlas.js lang list` with at most one short comment per line, followed by one sentence linking docs/how-to/contribute-a-change.md for what each proves. Keep the commands in the order of the old block that remain correct.
5. "## Documentation" with the two existing links unchanged in target: Architecture decisions docs/adr/README.md and Product requirements docs/PRD.md.
6. "## Licence" with "MIT. See [LICENSE](LICENSE)." unchanged.
Do not describe installing from the package registry. Do not repeat explanation or reference content; link to it.

Then the final checks across the whole change: run every verify below, including the inline replica of the pinned README test (it mirrors lines 454 to 470 of scripts/package.test.ts exactly; the hook refuses naming that test file in a Bash command, so the replica is the gate; if the environment allows, `npm test` also runs the real test but it builds, packs and may need the network); confirm no empty directories under docs; confirm the scope (only README.md and the new docs files changed since the branch point; planning files under .planning/quick are allowed); remove the probe area and any temporary HOME directory (the path is in gsd-atlas-docs-probe-path.txt); write SUMMARY.md with the verification ledger (H1) and the decisions below, but do not stage it with the README commit. Commit README.md alone with message `docs(quick-261017-slg): make README a front door with one pointer per need` plus the harness attribution lines. Do not push.

Record in SUMMARY.md as decisions for the user: (1) README keeps a compact Developer quickstart because scripts/package.test.ts pins it and editing that test was out of scope; moving it fully needs a one-line change to that test pointing at docs/how-to/contribute-a-change.md; (2) the MCP reference documents six tools because lang_list is registered; (3) the repository is private today so the tutorial's clone line works only for readers with access; (4) package.json's description still mentions SDKs (out of scope).
  </action>
  <verify>
    <automated>set -e; node --input-type=module -e "import fs from 'node:fs'; const readme = fs.readFileSync('README.md','utf8'); const pkg = JSON.parse(fs.readFileSync('package.json','utf8')); const fails = []; if (!/^#{1,6} Developer quickstart\$/m.test(readme)) fails.push('heading'); for (const c of ['npm ci --ignore-scripts','node scripts/ensure-tree-sitter.ts','node dist/bin/gsd-atlas.js lang test test/fixtures/modules/toy','node dist/bin/gsd-atlas.js lang list']) if (!readme.includes(c)) fails.push(c); const names = [...readme.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map(m=>m[1]); for (const r of ['build','lint','typecheck','schema:check','grammar:budget','grammar:verify']) if (!names.includes(r)) fails.push('npm run '+r); if (!/npm test\b/.test(readme)) fails.push('npm test'); for (const n of names) if (typeof pkg.scripts[n] !== 'string') fails.push('unknown script '+n); console.log(JSON.stringify(fails)); process.exit(fails.length?1:0)"; awk 'END{exit (NR > 70)}' README.md; for k in docs/tutorials/index-and-ask.md docs/how-to/register-the-mcp-server.md docs/how-to/answer-a-question-about-an-older-commit.md docs/how-to/keep-the-store-healthy.md docs/how-to/run-the-measured-gates-locally.md docs/how-to/contribute-a-change.md docs/reference/cli.md docs/reference/mcp.md docs/explanation/how-freshness-and-the-writer-lease-work.md docs/adr/README.md docs/PRD.md; do grep -q -- "($k)" README.md || { echo "README does not link $k"; exit 1; }; done; grep -q '^## Developer quickstart$' README.md; grep -q '^## Licence' README.md; if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|npm install' README.md; then echo README-HYGIENE-FAIL; exit 1; fi; for f in docs/tutorials/index-and-ask.md docs/how-to/register-the-mcp-server.md docs/how-to/answer-a-question-about-an-older-commit.md docs/how-to/keep-the-store-healthy.md docs/how-to/run-the-measured-gates-locally.md docs/how-to/contribute-a-change.md docs/reference/cli.md docs/reference/mcp.md docs/explanation/how-freshness-and-the-writer-lease-work.md; do if grep -nE '/Users/|/private/tmp|/var/folders|/home/[a-z]|[A-Za-z]:[\\]Users|TODO|TBD|FIXME|daemon|Swift|SDK pack|Agent Skill' $f; then echo "HYGIENE-FAIL $f"; exit 1; fi; done; if find docs -type d -empty | grep .; then echo EMPTY-DIR; exit 1; fi; 
base=$(git merge-base HEAD main)
changed=$(git diff --name-only "$base" HEAD)
if printf '%s\n' "$changed" | grep -vE '^(README\.md|docs/(tutorials|how-to|reference|explanation)/[^/]+\.md|\.planning/quick/.*)$'; then echo SCOPE-FAIL; exit 1; fi
node --input-type=module -e "import { collectLinkFiles, checkRelativeLinks } from './scripts/adr.ts'; const r = process.cwd(); const b = checkRelativeLinks(r, collectLinkFiles(r)); console.log(r.length + ' ok; broken: ' + JSON.stringify(b)); process.exit(b.length ? 1 : 0)"</automated>
  </verify>
  <done>README.md is at most 70 lines, links every new page and both Documentation targets, keeps the pinned Developer quickstart so the README test passes, mentions later phases in exactly one sentence, makes the privacy claim only if verified; the whole-change gates pass (hygiene, no empty directories, scope limited to README.md and the new docs files, zero broken links); the probe area is removed; SUMMARY.md exists with the ledger and the four recorded decisions; nothing was pushed.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| executor probes to user machine | Verification runs real commands (init, build, gates) on the developer's machine and home directory |
| probe output to committed docs | Real command output is pasted into pages that become public documentation |
| code to documentation | Pages assert behaviour; a wrong or over-broad assertion misleads users and agents |
| network to local disk | Corpus gates fetch a pinned checkout into a temporary directory |

## STRIDE Threat Register

Threat IDs are unique within a phase; the phase here is quick-261017-slg, so IDs use the slg tag.

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-slg-01 | I | Sample output pasted into pages | medium | mitigate | H5: neutral path /path/to/atlas-demo, varying values named as varying; every task verify greps the page for home-directory, temporary-directory and Windows user-profile path patterns and fails on a match. |
| T-slg-02 | T | `gsd-atlas init` executed during probing | high | mitigate | H6: init runs only with HOME redirected to a probe directory, so ~/.claude.json, ~/.cursor and ~/.codex are never written; tasks 1 and 4 state this; the done criteria require that no real agent config was touched. |
| T-slg-03 | T | Documentation integrity (claims beyond the code, invented rationale) | high | mitigate | H1, H3, H4: facts verified against code or the built CLI, ledger in SUMMARY.md, drift gates compare pages with FLAGS, COMMANDS, TOOLS, DEGRADED_CODES and DEFAULT_QUERY_CONFIG, later-phase terms are grepped out of every page but one README sentence. |
| T-slg-04 | D | Heavy gates run during verification (20,000-edit size gate, corpus download) | low | mitigate | H6: reduced parameters for size-gate and freshness-gate samples; corpus gates run once at most and only when the network allows. |
| T-slg-05 | E | Scope creep into code, tests or other docs | medium | mitigate | H2 and the final scope gate (git diff against the merge base lists only README.md and the new docs files plus planning files). |
| T-slg-06 | R | Over-claiming privacy (no network, no telemetry) | medium | mitigate | Task 11 verifies the claim against src before README states it, and limits it to indexing and answering. |
| T-slg-SC | T | npm/pip/cargo installs | high | mitigate | No package is added or changed; the only install is `npm ci --ignore-scripts` against the committed lockfile in the worktree; no [ASSUMED] or [SUS] package exists, so no legitimacy checkpoint is needed. |
</threat_model>

<verification>
Per-task automated gates are in each task's verify block. Whole-change gates (all run in task 11): an inline replica of the pinned README test (scripts/package.test.ts, 'README npm scripts exist'); link check via the checkRelativeLinks one-liner (zero broken links); hygiene grep over every page; no empty directory under docs; git diff against the merge base limited to README.md, docs/tutorials, docs/how-to, docs/reference, docs/explanation (plus planning files). Manual review items recorded in SUMMARY.md: each page passes the Diataxis checklist for its type in references/types.md; the tutorial replay transcript matches the page; any mention of a tier flag in sample output is the observed value only.
</verification>

<success_criteria>
- README.md is a front door of at most 70 lines with one pointer per need, today's status, the Documentation links and the licence, and the repo's README test still passes.
- One tutorial, five how-to guides, two reference pages and one explanation page exist, each a single Diataxis type, each true of the code today and verified (ledger in SUMMARY.md).
- Every relative link resolves at every commit; docs hygiene gates pass; the change touches only README.md and the new docs pages; nothing is pushed.
</success_criteria>

<output>
Create `.planning/quick/261017-slg-diataxis-restructure-of-user-documentati/261017-slg-SUMMARY.md` when done, including the verification ledger and the four decisions listed in task 11.
</output>
