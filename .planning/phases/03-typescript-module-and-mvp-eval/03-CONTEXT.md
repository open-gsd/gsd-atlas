# Phase 3: TypeScript Module and MVP Eval - Context

**Gathered:** 2026-10-17
**Status:** Ready for planning

<domain>
## Phase Boundary

A developer working on gsd-core gets compiler-precise, cited answers (callers, implementers, `.cts` to `.cjs` emit mapping, ADR citations) with `explain`, and agents using atlas consume fewer tokens than a grep-only baseline at non-inferior accuracy. This is the MVP (PRD M2).

In scope (17 requirements): TSM-01 to TSM-07 (TypeScript module, ProjectModel, bounded worker, emit mapping, ADR citations, budgets), QRY-07 (`explain`), EVL-01 to EVL-03 (free-alternatives evaluation, pre-registered eval, token win on gsd-core), SKL-01 to SKL-04 (skill, ratings, diagnostics, `gsd-atlas bug`), SEC-01 and SEC-02 (command approvals).

Out of scope for this phase: a working TypeScript 7.x resolver, resolved cross-package edges on gsd-pi, the four-corpus pooled eval (EVL-04, Phase 9), the Host hardening and diagnostics intake endpoint (Phase 4), hooks and enforcement (Phase 7).

</domain>

<decisions>
## Implementation Decisions

### Eval design and cost
- **D-01:** The 50+ gsd-core questions, including the abstain cases, are drafted by an agent from gsd-core source and ADRs **without running atlas**, reviewed and approved by the user, then committed and frozen before any precise-tier code is written.
- **D-02:** The oracle is a compiler-derived answer key plus a script that **never imports atlas**. Expected answers come from the TypeScript compiler symbol table and git/ripgrep checks; every cited file:line is verified by that script. An abstain case is a question with no answer in the repo. Never grade tree-sitter against tree-sitter.
- **D-03:** The eval runs through **Claude Code headless** (`claude -p`). The atlas arm uses the `gsd-atlas` skill plus the atlas MCP tools; the baseline arm has grep and read tools only. Sizing is about 300 sessions on gsd-core (50 questions x 3 runs x 2 arms); the cost and rate limits of that run are a known risk to plan for.
- **D-04:** Accuracy non-inferiority margin is **5 percentage points**, judged on the lower bound of a paired cluster bootstrap (resample questions, keep all runs per question), AND atlas must use fewer tokens overall. It is a **hard gate**: a miss means the MVP is not met, and the work is diagnosed and iterated before Phase 4 starts. The margin and the analysis are committed before the first run. — **Reversibility:** costly — a pre-registered margin that is changed after seeing results voids the claim, so changing it means a new registered run.
- **D-05:** The free-alternatives evaluation (EVL-01) is a desk review plus **one live run of each free tool** on 5 to 10 gsd-core questions (LSP-wrapping MCP servers, an agent repo-map, colbymchenry/codegraph, Claude Code LSP), recording the gap each leaves. Memtrace is desk-only (paid, its quota is exhausted). It is not an eval arm.
- **D-06:** "Tokens consumed" is **total billable tokens per session**: input, output, cache-creation and cache-read from the session usage report, summed. Cache reads are reported separately so a cache effect cannot hide a real difference. Tool-call count and wall time are logged. The size of atlas tool results counts, since they enter the context.

### Build order and first slice
- **D-07:** The first tracer slice is **precise `code_refs` on one gsd-core tsconfig**: ProjectModel to the 6.x worker to resolved `calls`/`references` edges to `code_refs` through the real MCP server, with the `degraded` fallback in place. It proves the riskiest path (worker, memory bound, `.cts` to `.cjs`) first.
- **D-08:** Wave 0 is the free-alternatives scan, then the questions, oracle script, margin and analysis are **frozen before any precise-tier code**. The scored run happens last.
- **D-09:** The atlas arm runs with the skill. The skill is written and frozen before the scored run and its sha256 is recorded in the pre-registration.
- **D-10:** The TSM-06 budgets (full gsd-core build under 30 s, one-file precise update under 5 s, warm queries under 2 s) are gated **two-tier on all three OSes**, as freshness is: a looser ceiling in the pull-request gates job (hosted runners are noisy), the strict roadmap figures in `nightly.yml`. Any ceiling looser than the roadmap figure needs the user's approval.
- **D-11:** Ratings, diagnostics, `gsd-atlas bug` and the command approvals (SKL-02 to SKL-04, SEC-01, SEC-02) proceed **in parallel with the precise tier** and land before the scored run. The phase closes only when all of it plus the eval is done.

### TypeScript 7.x adapter scope
- **D-12:** Phase 3 ships **detection and fallback only** (TSM-02). The resolver probes `typescript/unstable/sync`, then `typescript/sync`; if the project has 7.x it reports that, uses the bundled `typescript@6.0.3`, and flags the answer `degraded` with the reason. A real 7.x resolver waits for a stable 7.1 API.
- **D-13:** The 6.x compiler loaded is the **project's own installed `typescript` if it is 6.x, otherwise the bundled 6.0.3**. This is a recorded trust-boundary decision: the worker loads JavaScript from the repo's `node_modules`. The worker is killable, started through the CommandRunner, with a scrubbed environment; `explain` shows which compiler and version was used.
- **D-14:** 7.x detection is tested with a real dev alias `typescript-7` (7.0.2) plus fixture packages that mimic the 7.1 `typescript/sync` layout and a missing or changed layout. They run in the normal test suite on all three OSes.

### Approvals, ratings, bug report and explain
- **D-15:** A non-built-in `precise.command` is approved with an explicit CLI command, `gsd-atlas allow <command>`, run from the repo. It shows the exact argv and working directory, asks yes/no on a terminal, and writes a per-repo, per-command entry (repo identity plus a hash of the command) to user-level config under `~/.config/gsd-atlas/`. It never prompts from MCP; the MCP path only reports `needs_approval` unless `--allow-build` is passed. Committed repo config can never enable a command (SEC-01). — **Reversibility:** costly — the user-config entry format is user data that later versions must keep reading.
- **D-16:** Ratings: `gsd-atlas rate up|meh|down [--session | --feature <name> | --last]` appends a row to the local metrics database with the answer's id, not its content. Local only. There is no MCP rating tool (users rate, not agents).
- **D-17:** `gsd-atlas bug` writes a **local bundle** (flight recorder, versions, config, store health, the failing answer; names and paths hashed by default) under the user cache, prints a redacted preview of exactly what it contains, and tells the user where to attach it to a GitHub issue. atlas itself never uploads. There is no intake endpoint until Phase 4.
- **D-18:** `explain` is exposed as a **CLI command and an MCP tool (`code_explain`)** taking a fact or answer id. Every answer envelope carries fact ids. It reports the extractor, tier, grammar version, resolution context and overlay, is read-only, and uses the same JSON envelope as other tools. — **Reversibility:** costly — it adds fields to the published MCP contract (ADR 13) and a seventh tool.

### ADR citations
- **D-19:** `cites_adr` facts come from `ADR-<n>`, `ADR <n>` and `ADR #<n>` in **code comments only** (the grammar's comment nodes), case-insensitive, with an optional section suffix such as `ADR-2143 §3` kept as a detail. The number matches by value, ignoring leading zeros (`ADR-1` matches `0001-...md`).
- **D-20:** The ADR directory is found from a **convention list in the TypeScript module manifest** (`docs/adr`, `docs/adrs`, `doc/adr`, `adr`), overridable in repo config. An id with no matching file is still recorded as a `cites_adr` fact marked `unresolved`, not dropped.

### Memory budget and degrade
- **D-21:** The memory budget carries forward from DESIGN A25: an LRU compiler pool under one machine-wide budget, 25% of RAM by default. In Phase 3 it is enforced by starting the worker with `--max-old-space-size` derived from the budget **and** a parent RSS watch that kills it past the limit; answers then fall back to grammar facts flagged `degraded: memory_budget`. Tested with a small budget on a fixture.
- **D-22:** gsd-core is required; **gsd-pi must not break** (no crash, no budget breach; falls back to grammar facts flagged `degraded` where it cannot resolve). Resolved cross-package edges on gsd-pi are not a Phase 3 criterion.

### Skills
- **D-23:** The `gsd-atlas` skill is **one short routing `SKILL.md`** under `skills/`: when to use atlas vs grep (symbol, caller, implementer, impact questions), how to read `degraded` and the freshness watermark, and to cite file:line. Its sha256 is recorded in the pre-registration; tuning it after seeing results means a new registered run.
- **D-24:** `gsd-atlas-module-author` covers the **grammar tier plus how the TypeScript module is built** (manifest, `tags`/`imports`/`refs` queries, golden tests with `gsd-atlas lang test`), with the TypeScript module as the worked example. The precise-tier section stays short and marked provisional until the Phase 9 bring-your-own-language proof.

### Claude's Discretion
- File and module names, config key names, the worker message protocol, the bundle file format for `bug`, and the question categories beyond the required ones. The question set must at minimum cover callers, implementers, `.cts` to `.cjs` emit mapping, ADR citations and abstain cases.
- How the eval harness reads usage from `claude -p`, and the exact cluster-bootstrap implementation, provided D-04 holds.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` (Phase 3 section) — goal, success criteria 1 to 5, requirement ids
- `.planning/REQUIREMENTS.md` — TSM-01..07, QRY-07, EVL-01..03, SKL-01..04, SEC-01..02
- `.planning/PROJECT.md` — core value, constraints, "beat means fewer tokens"

### Design and decisions
- `docs/PRD.md` — M2 (the MVP), acceptance criteria, section 1.1 (why build it)
- `docs/DESIGN.md` — A25 (bounded heavy resources), A32 (cheaper path), A48 (grammar pins), A50 (evidence standard), A54 (argument arrays, compiler probing), A61 (Governor)
- `docs/DESIGN-REVIEW.md` — E-2 and the eval findings (pre-written questions, 3+ runs, intervals, abstain cases)
- `docs/DIAGNOSTICS.md` and `docs/adr/draft-user-controlled-diagnostics.md` — diagnostics model (off by default, approved per data type, previewed)
- `docs/AGENT-INTEGRATION.md` — skill and agent routing model
- `docs/adr/3-trust-boundaries.md` — repo text is untrusted; user-level config only
- `docs/adr/4-command-runner.md` — how the worker is started
- `docs/adr/5-language-modules.md` — module manifest and tiers
- `docs/adr/6-fact-model.md` — fact kinds, provenance (`cites_adr`, `emitted_as`)
- `docs/adr/12-query-and-policy.md` and `docs/adr/13-mcp-contract.md` — envelopes and the MCP contract that `code_explain` extends
- `docs/adr/14-value-dashboard.md` — how ratings and metrics are consumed later

### Research
- `.planning/research/PITFALLS.md` — eval pitfalls: circular oracle, direction of effect, non-inferiority with a pre-registered margin, paired cluster bootstrap (around lines 45 to 52 and 308 to 314)
- `.planning/research/STACK.md` — TypeScript 6.x adapter, 7.x subpath probing (`unstable/sync` then `sync`), bundled `typescript@6.0.3`, `typescript-7` alias for tests
- `.planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md` — approved constants, and the rule that loosening a bound needs user approval

### Corpus
- `corpora/corpora.json` — pinned gsd-core commit and the other corpora
- gsd-core's own ADR layout (external, `~/projects/gsd-core/docs/adr/`): about 99 files named `<number>-<slug>.md` (early ones zero-padded, later ones use the issue number), cited in comments as `ADR-3473`, `ADR-2143 §3`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/precise-resolver/` — the existing precise-tier seam from Phases 1 and 2; its exact contract must be confirmed in research before the worker is designed.
- `src/command-runner/` — the per-subcommand allowlist, scrubbed environment and timeouts the worker must be started through.
- `src/grammar-engine/pool/` — the existing killable worker pool pattern (load timeout, terminate grace) to model the precise worker on.
- `src/governor/` — the Governor seam that owns memory budgets and admission.
- `modules/typescript/` (manifest, queries, fixtures, `grammar.lock`) — the grammar-tier module the precise tier extends.
- `scripts/recall-oracle.ts` and `scripts/recall.ts` — a compiler-as-oracle pattern already used for recall; the eval oracle script reuses the idea but must not import atlas.
- `scripts/freshness-gate.ts`, `.github/workflows/ci.yml` (gates job) and `nightly.yml` — the two-tier budget gating pattern for TSM-06.
- `src/metrics/` — the local metrics database where ratings land.
- `src/query/`, `src/mcp-shim/`, `src/cli/` — where `code_explain`, `explain`, `rate`, `allow` and `bug` attach.

### Established Patterns
- One JSON envelope on stdout, reasons on stderr; exit codes 0/1/2/3 (documented in `docs/reference/cli.md`).
- Anything degraded is flagged `degraded` with a reason, never silent.
- No network by default and no telemetry; permissions only from user-level config.
- Windows CI cost: keep per-save process spawns low and use the runner temp folder (see `.planning/debug/windows-ci-diag.md`); the precise worker adds process starts, so measure it on hosted Windows early.

### Integration Points
- The MCP server registers the tools in `src/mcp-shim`; `code_explain` is a new tool alongside the six that exist.
- The Fact Store holds the new fact kinds (`emitted_as`, `cites_adr`, resolved edges) and the `unresolved` marker for dangling ADR ids.

</code_context>

<specifics>
## Specific Ideas

- The eval claim is two-part: accuracy non-inferiority (the correctness claim) and fewer tokens at equal accuracy (the benefit claim). Do not require higher accuracy than grep.
- Citation verification is part of the score: at least 80% of answers with a verifiable file:line citation (EVL-03).
- The pre-registration is a committed document: question set hash, oracle script hash, skill hash, margin, analysis plan, run configuration.

</specifics>

<deferred>
## Deferred Ideas

- A working TypeScript 7.x resolver — when the 7.1 API is stable.
- A third eval arm for the skill ablation or the strongest free alternative — if the main result is unclear.
- ADR citations from markdown docs — after the comment-only rule has been measured for false positives.
- An MCP rating tool, and a post-answer rating prompt via hooks — Phase 7 (agent integration).
- A prefilled GitHub issue URL, and an optional diagnostics upload — Phase 4 (intake endpoint).
- Resolved cross-package edges on gsd-pi (project references, pnpm workspaces) — Phase 9 and EVL-04.

</deferred>

---

*Phase: 3-TypeScript Module and MVP Eval*
*Context gathered: 2026-10-17*
