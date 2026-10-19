# Phase 3 documentation ledger (plan 03-34)

Written with the Claude skill `writing-docs-with-diataxis`, invoked through the Skill tool at the start of plan 03-34 (task 1) before any page was read or changed. `references/types.md` (Reference section and Checklists) and `references/skills-repo.md` (publishing checklist, README as front door) were read. This ledger holds the skill's workflow steps 1 and 2 (the existing pages classified with the compass, then the mixed pages and the unmet needs), the Facts table (every checked statement with its evidence), and the per-page Checklist. Step 5 (what changed, what remains, ranked) is in `03-34-SUMMARY.md`.

Compass questions: action or cognition (does it inform what the reader does, or what the reader knows), and acquisition or application (is the reader at study, or at work). Action and study is a tutorial, action and work a how-to guide, cognition and work reference, cognition and study explanation.

## Pages

Step 1: every page under `docs/tutorials`, `docs/how-to`, `docs/reference`, `docs/explanation` and `README.md` as it stood at the base commit, followed by the pages that plans 03-34 and 03-36 add. "Status" is `existing` (classified at the base commit), `new` (does not exist yet) or `update`. The "Commit" column is filled when the page passes its checklist.

| Page | Quadrant | Action or cognition | Study or work | The reader asks | Status | Plan | Commit |
|------|----------|---------------------|---------------|-----------------|--------|------|--------|
| `docs/reference/cli.md` | reference | cognition | work | What does command X accept and print? | existing, update | 03-34 task 1 | (pending) |
| `docs/reference/mcp.md` | reference | cognition | work | What does tool X accept and return? | existing, update | 03-34 task 1 | (pending) |
| `docs/reference/typescript-support.md` | reference | cognition | work | What exactly does atlas resolve for TypeScript? | new | 03-34 task 2 | (pending) |
| `docs/reference/adr-citations.md` | reference | cognition | work | Which comments count as ADR citations and how are they resolved? | new | 03-34 task 2 | (pending) |
| `docs/explanation/how-the-precise-tier-works.md` | explanation | cognition | study | Why is the precise tier built this way? | new | 03-34 task 2 | (pending) |
| `docs/how-to/see-why-atlas-gave-an-answer.md` | how-to | action | work | How do I see why atlas gave this answer? | new | 03-34 task 2 | (pending) |
| `docs/how-to/find-the-code-that-cites-an-adr.md` | how-to | action | work | How do I find the code that cites ADR N? | new | 03-34 task 2 | (pending) |
| `docs/how-to/approve-a-precise-command.md` | how-to | action | work | How do I let atlas run a module's own command here? | new | 03-34 task 3 | (pending) |
| `docs/how-to/install-the-skills.md` | how-to | action | work | How do I give my agent the atlas skills? | new | 03-34 task 3 | (pending) |
| `docs/how-to/register-the-mcp-server.md` | how-to | action | work | How do I register the server with my agent? | existing, update | 03-34 task 3 | (pending) |
| `docs/tutorials/index-and-ask.md` | tutorial | action | study | Can you teach me to index a repository and ask it questions? | existing, update | 03-34 tasks 1 and 3 | (pending) |
| `docs/how-to/contribute-a-change.md` | how-to | action | work | How do I check a change before I propose it? | existing, update (one sentence) | 03-34 task 1 | (pending) |
| `docs/how-to/answer-a-question-about-an-older-commit.md` | how-to | action | work | How do I ask about an older commit? | existing, unchanged | none | n/a |
| `docs/how-to/keep-the-store-healthy.md` | how-to | action | work | How do I keep the store healthy? | existing, unchanged here | 03-36 (one fork) | n/a |
| `docs/how-to/run-the-measured-gates-locally.md` | how-to | action | work | How do I run the measured gates myself? | existing, unchanged | none | n/a |
| `docs/explanation/how-freshness-and-the-writer-lease-work.md` | explanation | cognition | study | Why does the index stay current, and why may only one process write? | existing, unchanged | none | n/a |
| `docs/reference/alpha-limitations.md` | reference | cognition | work | What does this alpha do and not do, and what is its status? | new | 03-36 task 1 (not written here) | n/a |
| `docs/explanation/how-atlas-decides-what-to-trust.md` | explanation | cognition | study | Why does atlas trust only the user, and why does it send nothing? | new | 03-36 task 2 (not written here) | n/a |
| `docs/how-to/rate-an-answer.md` | how-to | action | work | How do I tell the project an answer was good or bad? | new | 03-36 task 2 (not written here) | n/a |
| `docs/how-to/report-a-bug.md` | how-to | action | work | How do I report a bug without leaking my code? | new | 03-36 task 2 (not written here) | n/a |
| `docs/how-to/turn-diagnostics-on-and-off.md` | how-to | action | work | How do I turn diagnostics on, read a report and turn them off? | new | 03-36 task 2 (not written here) | n/a |
| `README.md` | front door (links by reader goal) | n/a | n/a | What is this, what state is it in, where do I go? | existing | 03-36 task 3 (not written here) | n/a |

## Mixed pages and unmet needs

Step 2. No empty page is created for a missing quadrant; a page is created only when real material goes into it.

Mixed or drifting pages:

- `docs/reference/mcp.md`, section "ADR citations": reference facts (forms, statuses, directories, bounds) are mixed with a recipe-like instruction (remove `facts.db`, run `build`) and the same facts are about to appear in the new ADR reference. Decision: the new `adr-citations.md` owns forms, directory resolution, statuses and the gap diagnostic; the MCP reference keeps the data shapes and links to it (task 2).
- `docs/reference/cli.md` and `docs/reference/mcp.md`: the degraded-code table lives in the CLI reference while the MCP reference only links to it, and it lacks `memory_budget`, `compiler_fallback` and `needs_approval`. Decision: one table in the MCP reference (it is the tool surface that reports them), the CLI reference links to it (task 1).
- `docs/reference/cli.md`: the user configuration table lacks `providers.disabled` and the `sha256` key of `permissions.allow`; the Requirements line names Windows as supported (task 1).
- `docs/how-to/contribute-a-change.md`: the continuous-integration sentence says all three systems block (task 1; one sentence, no other change).
- `docs/tutorials/index-and-ask.md`: the introduction says the commands work in PowerShell and the Windows command prompt; it has no step for `explain`, and its expected output was last replayed before the precise tier (tasks 1 and 3).
- `README.md`: a front door that mixes status claims with the quickstart; owned by plan 03-36.

Unmet needs, by reader question (the first five are filled by plan 03-34, the rest by plan 03-36):

1. What exactly does atlas resolve for TypeScript (reference). Filled by `typescript-support.md`.
2. Which comments are ADR citations and how are they resolved (reference). Filled by `adr-citations.md`.
3. Why is the precise tier built this way (explanation). Filled by `how-the-precise-tier-works.md`.
4. How do I see why atlas answered this way, how do I find the code that cites an ADR (two how-tos). Filled by `see-why-atlas-gave-an-answer.md` and `find-the-code-that-cites-an-adr.md`.
5. How do I approve a command, give my agent the skills (two how-tos), and what are the facts of `explain`, `rate`, `allow`, `bug`, `diagnostics`, `code_explain` (reference). Filled by `approve-a-precise-command.md`, `install-the-skills.md` and the two updated references.
6. Plan 03-36: how do I rate, report a bug, turn diagnostics on and off (three how-tos), why atlas trusts only the user (explanation), what this alpha does and does not do (reference), the front door.

## Facts

Every statement a page makes that could be wrong, with the page it is on and its evidence. Evidence forms: `run: <command>` (the built CLI, `node dist/bin/gsd-atlas.js`, with HOME, XDG_CACHE_HOME, XDG_STATE_HOME, GSD_ATLAS_USER_DIR and GSD_ATLAS_STORE_DIR redirected to a scratch area outside the checkout), `mcp: <call>` (a scratch script driving `dist/bin/gsd-atlas-mcp.js`), `test: <path>`, `code: <path>:<line>`, `decision: <record>`. A fact that could not be checked is not on any page.

| Statement | Page | Evidence |
|-----------|------|----------|
| (rows are added with each page) | | |

## Checklist

Per page, from the skill's publishing checklist: exactly one quadrant; title fits the type (how-to "How to ...", explanation "About ...", tutorial states what will be built); the tutorial was replayed start to finish; commands are copy-pasteable and use placeholder paths; reference rows have one shape and nothing narrative; cross-links replace repeated explanation; the skill catalog matches the skill files; no empty placeholder page.

| Page | One type | Title fits | Links not repeats | Commands real | Marker present | Result |
|------|----------|------------|-------------------|---------------|----------------|--------|
| (rows are added with each page) | | | | | | |

## Findings outside the scope of this plan

Recorded here because `deferred-items.md` is not in this plan's file list; the summary repeats them.

| Finding | Evidence | Why not fixed here |
|---------|----------|--------------------|
| (rows are added when found) | | |
