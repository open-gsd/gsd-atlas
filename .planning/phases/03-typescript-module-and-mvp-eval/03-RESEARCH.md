# Phase 3: TypeScript Module and MVP Eval - Research

**Researched:** 2026-10-17
**Domain:** TypeScript 6.x compiler worker behind the PreciseResolver seam, compiler-free ProjectModel, emit mapping, ADR citations, `explain`, command approvals, ratings and `bug`, and a pre-registered Claude Code headless eval
**Confidence:** HIGH on the seams and measurements (read in code and measured on the pinned corpora this session); MEDIUM on eval power and cost (depends on a pilot); LOW on Windows and Linux behaviour (no hardware here, CI is the only check)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Eval design and cost**
- **D-01:** The 50+ gsd-core questions, including the abstain cases, are drafted by an agent from gsd-core source and ADRs **without running atlas**, reviewed and approved by the user, then committed and frozen before any precise-tier code is written.
- **D-02:** The oracle is a compiler-derived answer key plus a script that **never imports atlas**. Expected answers come from the TypeScript compiler symbol table and git/ripgrep checks; every cited file:line is verified by that script. An abstain case is a question with no answer in the repo. Never grade tree-sitter against tree-sitter.
- **D-03:** The eval runs through **Claude Code headless** (`claude -p`). The atlas arm uses the `gsd-atlas` skill plus the atlas MCP tools; the baseline arm has grep and read tools only. Sizing is about 300 sessions on gsd-core (50 questions x 3 runs x 2 arms); the cost and rate limits of that run are a known risk to plan for.
- **D-04:** Accuracy non-inferiority margin is **5 percentage points**, judged on the lower bound of a paired cluster bootstrap (resample questions, keep all runs per question), AND atlas must use fewer tokens overall. It is a **hard gate**: a miss means the MVP is not met, and the work is diagnosed and iterated before Phase 4 starts. The margin and the analysis are committed before the first run. - **Reversibility:** costly - a pre-registered margin that is changed after seeing results voids the claim, so changing it means a new registered run.
- **D-05:** The free-alternatives evaluation (EVL-01) is a desk review plus **one live run of each free tool** on 5 to 10 gsd-core questions (LSP-wrapping MCP servers, an agent repo-map, colbymchenry/codegraph, Claude Code LSP), recording the gap each leaves. Memtrace is desk-only (paid, its quota is exhausted). It is not an eval arm.
- **D-06:** "Tokens consumed" is **total billable tokens per session**: input, output, cache-creation and cache-read from the session usage report, summed. Cache reads are reported separately so a cache effect cannot hide a real difference. Tool-call count and wall time are logged. The size of atlas tool results counts, since they enter the context.

**Build order and first slice**
- **D-07:** The first tracer slice is **precise `code_refs` on one gsd-core tsconfig**: ProjectModel to the 6.x worker to resolved `calls`/`references` edges to `code_refs` through the real MCP server, with the `degraded` fallback in place. It proves the riskiest path (worker, memory bound, `.cts` to `.cjs`) first.
- **D-08:** Wave 0 is the free-alternatives scan, then the questions, oracle script, margin and analysis are **frozen before any precise-tier code**. The scored run happens last.
- **D-09:** The atlas arm runs with the skill. The skill is written and frozen before the scored run and its sha256 is recorded in the pre-registration.
- **D-10:** The TSM-06 budgets (full gsd-core build under 30 s, one-file precise update under 5 s, warm queries under 2 s) are gated **two-tier on all three OSes**, as freshness is: a looser ceiling in the pull-request gates job (hosted runners are noisy), the strict roadmap figures in `nightly.yml`. Any ceiling looser than the roadmap figure needs the user's approval.
- **D-11:** Ratings, diagnostics, `gsd-atlas bug` and the command approvals (SKL-02 to SKL-04, SEC-01, SEC-02) proceed **in parallel with the precise tier** and land before the scored run. The phase closes only when all of it plus the eval is done.

**TypeScript 7.x adapter scope**
- **D-12:** Phase 3 ships **detection and fallback only** (TSM-02). The resolver probes `typescript/unstable/sync`, then `typescript/sync`; if the project has 7.x it reports that, uses the bundled `typescript@6.0.3`, and flags the answer `degraded` with the reason. A real 7.x resolver waits for a stable 7.1 API.
- **D-13:** The 6.x compiler loaded is the **project's own installed `typescript` if it is 6.x, otherwise the bundled 6.0.3**. This is a recorded trust-boundary decision: the worker loads JavaScript from the repo's `node_modules`. The worker is killable, started through the CommandRunner, with a scrubbed environment; `explain` shows which compiler and version was used.
- **D-14:** 7.x detection is tested with a real dev alias `typescript-7` (7.0.2) plus fixture packages that mimic the 7.1 `typescript/sync` layout and a missing or changed layout. They run in the normal test suite on all three OSes.

**Approvals, ratings, bug report and explain**
- **D-15:** A non-built-in `precise.command` is approved with an explicit CLI command, `gsd-atlas allow <command>`, run from the repo. It shows the exact argv and working directory, asks yes/no on a terminal, and writes a per-repo, per-command entry (repo identity plus a hash of the command) to user-level config under `~/.config/gsd-atlas/`. It never prompts from MCP; the MCP path only reports `needs_approval` unless `--allow-build` is passed. Committed repo config can never enable a command (SEC-01). - **Reversibility:** costly - the user-config entry format is user data that later versions must keep reading.
- **D-16:** Ratings: `gsd-atlas rate up|meh|down [--session | --feature <name> | --last]` appends a row to the local metrics database with the answer's id, not its content. Local only. There is no MCP rating tool (users rate, not agents).
- **D-17:** `gsd-atlas bug` writes a **local bundle** (flight recorder, versions, config, store health, the failing answer; names and paths hashed by default) under the user cache, prints a redacted preview of exactly what it contains, and tells the user where to attach it to a GitHub issue. atlas itself never uploads. There is no intake endpoint until Phase 4.
- **D-18:** `explain` is exposed as a **CLI command and an MCP tool (`code_explain`)** taking a fact or answer id. Every answer envelope carries fact ids. It reports the extractor, tier, grammar version, resolution context and overlay, is read-only, and uses the same JSON envelope as other tools. - **Reversibility:** costly - it adds fields to the published MCP contract (ADR 13) and a seventh tool.

**ADR citations**
- **D-19:** `cites_adr` facts come from `ADR-<n>`, `ADR <n>` and `ADR #<n>` in **code comments only** (the grammar's comment nodes), case-insensitive, with an optional section suffix such as `ADR-2143 §3` kept as a detail. The number matches by value, ignoring leading zeros (`ADR-1` matches `0001-...md`).
- **D-20:** The ADR directory is found from a **convention list in the TypeScript module manifest** (`docs/adr`, `docs/adrs`, `doc/adr`, `adr`), overridable in repo config. An id with no matching file is still recorded as a `cites_adr` fact marked `unresolved`, not dropped.

**Memory budget and degrade**
- **D-21:** The memory budget carries forward from DESIGN A25: an LRU compiler pool under one machine-wide budget, 25% of RAM by default. In Phase 3 it is enforced by starting the worker with `--max-old-space-size` derived from the budget **and** a parent RSS watch that kills it past the limit; answers then fall back to grammar facts flagged `degraded: memory_budget`. Tested with a small budget on a fixture.
- **D-22:** gsd-core is required; **gsd-pi must not break** (no crash, no budget breach; falls back to grammar facts flagged `degraded` where it cannot resolve). Resolved cross-package edges on gsd-pi are not a Phase 3 criterion.

**Skills**
- **D-23:** The `gsd-atlas` skill is **one short routing `SKILL.md`** under `skills/`: when to use atlas vs grep (symbol, caller, implementer, impact questions), how to read `degraded` and the freshness watermark, and to cite file:line. Its sha256 is recorded in the pre-registration; tuning it after seeing results means a new registered run.
- **D-24:** `gsd-atlas-module-author` covers the **grammar tier plus how the TypeScript module is built** (manifest, `tags`/`imports`/`refs` queries, golden tests with `gsd-atlas lang test`), with the TypeScript module as the worked example. The precise-tier section stays short and marked provisional until the Phase 9 bring-your-own-language proof.

### Claude's Discretion
- File and module names, config key names, the worker message protocol, the bundle file format for `bug`, and the question categories beyond the required ones. The question set must at minimum cover callers, implementers, `.cts` to `.cjs` emit mapping, ADR citations and abstain cases.
- How the eval harness reads usage from `claude -p`, and the exact cluster-bootstrap implementation, provided D-04 holds.

### Deferred Ideas (OUT OF SCOPE)
- A working TypeScript 7.x resolver - when the 7.1 API is stable.
- A third eval arm for the skill ablation or the strongest free alternative - if the main result is unclear.
- ADR citations from markdown docs - after the comment-only rule has been measured for false positives.
- An MCP rating tool, and a post-answer rating prompt via hooks - Phase 7 (agent integration).
- A prefilled GitHub issue URL, and an optional diagnostics upload - Phase 4 (intake endpoint).
- Resolved cross-package edges on gsd-pi (project references, pnpm workspaces) - Phase 9 and EVL-04.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TSM-01 | TS 6.x adapter produces resolved `calls`, `references`, `extends`, `implements`, `overrides` over the tsconfig(s); bundled `typescript@6.0.3` fallback marked `degraded` | Persistent compiler process (Pattern 1); identity mapping measured at 100% for function declarations (Measured Baselines); relation storage gap (Seam Gaps G3) |
| TSM-02 | 7.x subpaths feature-detected, degrade to 6.x | Detection reads the project's `package.json` `version` and `exports` without loading it (Pattern 5); registry facts for 7.0.2 and `next` |
| TSM-03 | `rootDir`/`outDir`/extension rules give `emitted_as` edges, no fact under `outDir`, `require`s of emitted paths resolve to `.cts` | Emit-map reverse lookup in the specifier rule (Pattern 4, Seam Gap G6); corpus facts: 274 `.cts`, 1,361 tracked `.cjs`, 17 tracked files inside `outDir` |
| TSM-04 | ADR ids in comments become `cites_adr` facts resolved against the ADR directory | Pattern 6; corpus census (102 distinct ids cited, 59 in `.cts`, duplicate ids `0010` and `0011`) |
| TSM-05 | Bounded, killable worker started through the CommandRunner; memory fallback `degraded` | Pattern 1 (duplex over `stream()` with an async-iterable stdin); in-process RSS sampler thread verified; V8 OOM abort verified |
| TSM-06 | Full build under 30 s, one-file update under 5 s, warm query under 2 s | Measured on pinned gsd-core: grammar build 5.9 s, `createProgram` 0.46 s, 28,466 call sites resolved in 0.39 s, incremental program 0.29 to 0.39 s; two-tier gating (Validation Architecture) |
| TSM-07 | Compiler-free ProjectModel seam | Pattern 3; ADR 5 amendment 2026-10-15; differential test against `ts.parseJsonConfigFileContent` |
| QRY-07 | `explain` reports extractor, tier, grammar version, resolution context, overlay | Pattern 7; debug handle formats verified |
| EVL-01 | Free-alternatives evaluation recorded before the eval | Candidate list and protocol (Eval Section A); `codegraph` 1.6.0 is installed locally |
| EVL-02 | Pre-registered eval design | Eval Sections B to E: question categories, oracle, harness flags, statistics, freeze check |
| EVL-03 | Fewer tokens at non-inferior accuracy on gsd-core, citations >= 80% | Harness isolation findings, usage fields verified, power arithmetic, pilot-first plan |
| SKL-01 | `gsd-atlas` skill and `gsd-atlas-module-author` | Skill format facts; plugin-dir loading verified; package `files` change |
| SKL-02 | Ratings up, meh, down | Pattern 9 (answer id, persisted recent-answer log, metrics migration) |
| SKL-03 | Diagnostics off by default, approved per data type, previewed | DIAGNOSTICS.md catalog v1; ADR draft must be ratified at the start of the phase (ROADMAP Planning Notes) |
| SKL-04 | `gsd-atlas bug` | Flight recorder must be persisted across processes (Seam Gap G9); HMAC hashing recommendation |
| SEC-01 | Committed config and `precise.command` run nothing | Existing `decide` gate; `userAllows` read; hostile-repo test pattern |
| SEC-02 | Built-ins run by default, others need per-repo per-command approval, never via MCP without `--allow-build` | Pattern 8; user-config schema is strict and must be extended |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Read from `/Users/trekkie/projects/gsd-atlas/.claude/CLAUDE.md` and `/Users/trekkie/.claude/CLAUDE.md`. [VERIFIED: files supplied in session context]

- TypeScript, Node >= 24 (floor 24.16.0), SQLite via `node:sqlite` with `better-sqlite3` as fallback; single npm package `@opengsd/gsd-atlas`, bins `gsd-atlas` and `gsd-atlas-mcp`.
- macOS, Linux and Windows are 1.0 platforms in every budget's CI run. Windows CI cost is a known pain point.
- No network by default, no telemetry; permissions only from user-level config (`~/.config/gsd-atlas/`); repo text fenced as untrusted.
- No dependency on gsd-core, gsd-graph or `.planning/`; gsd-core is a validation corpus only.
- Pin each eval corpus to a commit SHA.
- TypeScript 7 `unstable/sync` API and `node:sqlite` are pinned and tested per minor release.
- Stack rules: no bundler for 1.0; native type stripping in dev and tests (`.ts` extensions in imports, `import type`, no `enum`/`namespace`/parameter properties; `erasableSyntaxOnly`); use `@types/node` 24; `child_process.spawn` never through `npx`/`.cmd`/`.bat`; no `piscina`; MCP SDK v2 (stateless, no sessions or roots); worker entry files need one `resolveWorkerUrl()` helper.
- GSD workflow enforcement: file changes go through a GSD command.
- User-level: CodeGraph is the lookup route for indexed repos (a PreToolUse guard enforces it in this environment; see Pitfall 14 for why that matters to the eval).

## Summary

The riskiest unknowns are now measured. On the pinned gsd-core commit `10ac3a7`, TypeScript 6.0.3 builds the 274-file `.cts` program in 0.46 s, resolves all 28,466 call sites in 0.39 s, and sits at 430 MB RSS (296 MB heap). A one-file incremental program is 0.29 to 0.39 s but pushes RSS to 600-700 MB while the old program is alive. The grammar-tier build of the same repo is 5.9 s. TSM-06 is therefore about compute headroom on a Mac; the risk is hosted Windows spawn and disk cost, not the compiler. The largest gsd-pi program (`tsconfig.extensions.json`, 2,389 files, no `node_modules` installed) peaks at 1.45 GB RSS in 3.3 s, which is the case D-21 and D-22 must degrade cleanly.

Most of the work is not the compiler; it is seams that do not yet carry what Phase 3 needs. Seven are load-bearing (Seam Gaps G1 to G9): the injected `Resolver` port has no worktree or overlay; `SymbolLookup` returns identities without spans, so a compiler declaration cannot be matched to a grammar symbol reliably; `ResolvedEdge` and `resolved_edges` have no relation (`extends`, `implements`, `overrides`) and there is no way to express a symbol-to-symbol edge; the resolution context is one global function, not per overlay; the CommandRunner has no builtin for the worker and its default stdout cap would kill a long-lived worker after 16 MiB; the user-config permission schema is strict and has no command hash; and the CLI and the MCP server run in separate processes with no shared record of the last answer, which `rate --last` and `bug` both need. The Phase 2 convention for each gap is an additive change plus an ADR amendment, planned as early Wave 1 tasks.

The eval is the other half of the risk. At 50 questions the 5-point non-inferiority gate on the lower bound is hard to pass unless atlas is genuinely a little more accurate or the question-level disagreement with grep is low (arithmetic in Eval Section D). Plan a cheap pilot first to estimate disagreement and per-session cost, then fix N (the requirement says "at least 50"). Run isolation also matters: in this environment the user-level hooks and CLAUDE.md would otherwise reach both arms; `--setting-sources ""` plus `--strict-mcp-config` removed them in a verified run, and parallel atlas sessions on one checkout would turn all but one into read-only followers.

**Primary recommendation:** Build the TS resolver as one persistent child process (`node --max-old-space-size=N worker`) driven through `CommandRunner.stream()` with an async-iterable stdin and newline JSON, with an in-process RSS sampler thread that kills the process past the budget; keep ProjectModel, ADR citations and the emit map compiler-free and cached by resolution context; do the Wave 0 human gates (ADR ratification, `03-CONSTANTS.md`, question approval, pre-registration freeze) before any precise-tier code.

## Architectural Responsibility Map

atlas is a local process family, so the tiers are its own modules rather than web tiers.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| tsconfig chain, file sets, emit map, 7.x detection | ProjectModel (new, compiler-free) | Source Tree (confined reads) | ADR 5 amendment 2026-10-15: the Grammar Engine never reads tsconfig; works with no compiler installed |
| Reference resolution (calls, references, heritage, overrides) | Compiler process (new `precise-resolver` adapter) | Fact Store (validates, caches, supersedes) | `PreciseResolver` is the only code a module may add (ADR 5 decision 3) |
| Starting, bounding and killing the compiler | CommandRunner (child process) | Governor (admission, memory budget) | ADR 4: the runner alone starts processes and decides permission |
| Symbol identity reconciliation (compiler declaration to grammar symbol) | Adapter, with store-supplied spans | Fact Store `SymbolLookup` | The store owns identities; the resolver must not read the store |
| `cites_adr` extraction | Grammar Engine (comment nodes) | Fact Store (local fact), Query (resolve to files) | Local fact from one file; ADR directory is cross-file so resolution is read-time |
| `emitted_as` and output-to-source path mapping | ProjectModel | Fact Store specifier rule, Indexer (skip emit outputs) | Config-derived, keyed by resolution context, not by file hash |
| `explain` | Query (new request kind) | Fact Store (handle lookup) | ADR 12: Query owns `explain` |
| Command approval (`allow`) | CLI prompt, Host request for the write | Command-runner `decide` | CLI adapters import only host-client (lint); permission rule stays in one place |
| Ratings, recent-answer log, `bug` bundle | Host-side recorder (new) | Metrics (ratings table), CLI | Cross-process: the CLI must read what the MCP process recorded |
| Eval harness, oracle, statistics | `scripts/eval/` (dev-only, never imports atlas for the oracle) | Claude Code headless | Independence of the oracle is the whole point (D-02) |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `typescript` | exact `6.0.3` | The bundled fallback compiler, loaded by the worker | Last classic-API release; currently a devDependency and must become a runtime `dependencies` entry (about 24.3 MB unpacked) [VERIFIED: npm registry, `npm view typescript@6.0.3 dist.unpackedSize` = 24346827; package.json devDependencies] |
| `node:worker_threads` (inside the compiler process) | built in | RSS sampler thread | Verified: a worker thread sees process-wide RSS and can kill the process while the main thread is blocked [VERIFIED: local experiment, Node 26.11.1] |
| `zod` | 4.6.7 (installed) | Worker protocol, user-config schema, new tool schema | Already the single validation library [VERIFIED: package.json] |
| `node:crypto` | built in | HMAC-SHA256 for hashed names in `bug`; sha256 for command hash and pre-registration hashes | Never hand-roll crypto |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `jsonc-parser` | 3.3.1 (MIT, 213 KB unpacked, no install script) | tsconfig parsing in ProjectModel | Recommended over a hand tokenizer; needs the user's package approval (Phase 2 precedent). Legitimacy check returned OK [VERIFIED: gsd-tools package-legitimacy, npm view] |
| `typescript-7` alias | `npm:typescript@7.0.2`, dev only | Real 7.x layout for detection tests (D-14) | Same package as `typescript`; its platform packages are optional dependencies (27.5 MB for darwin-arm64) |
| `ripgrep` (`rg`) | 15.2.0 installed | Oracle cross-check and a baseline-arm tool | Dev machine only; not a package dependency |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `jsonc-parser` | Hand-written JSONC reader | Zero new dependency, but comments inside strings, trailing commas and BOM are exactly the edge cases that bite; differential test against TS's own parser makes either safe |
| Persistent worker over `stream()` | One process per resolve batch | Cold `createProgram` every call (0.35 to 0.46 s here, far more on Windows) and no warm program for the 5 s update budget |
| In-worker RSS sampler (self kill) | Parent polls child RSS with `ps`/`tasklist` | Parent polling needs a new builtin per OS and spawns on Windows; D-21 literally says "parent RSS watch" so this is a deviation to confirm (Open Question 2) |
| `--permission` model for the worker | none | Not recommended in Phase 3: with read access limited to the corpus plus atlas folders, resolved call sites fell from 28,100 to 23,901 and diagnostics rose from 7 to 1,263, because symlink and ancestor reads were denied. A hardening that silently lowers precision is worse than none; `--allow-net` also exists only on newer Node (Node 26 lists it, Node 24 behaviour [ASSUMED]) |

**Installation:**
```bash
# runtime: move typescript from devDependencies to dependencies, exact
npm install --save-exact typescript@6.0.3
# ProjectModel (needs approval)
npm install --save-exact jsonc-parser@3.3.1
# dev alias for D-14
npm install --save-dev --save-exact typescript-7@npm:typescript@7.0.2
```

**Version verification:** `typescript` dist-tags on 2026-10-17: `latest` 7.0.2, `next` 7.1.0-dev.20261017.1, `rc` 7.0.1-rc; 7.0.2 was published 2026-07-08 and 6.0.3 on 2026-04-16 [VERIFIED: npm registry]. `typescript@7.0.2` exports `./unstable/sync`, `./unstable/async`, `./unstable/proto`, `./unstable/ast`; the `next` build exports `./sync`, `./async`, `./proto`, `./ast`, `./path`, `./vscode` and no `unstable/` prefix [VERIFIED: `npm view typescript@7.0.2 exports`, `npm view typescript@7.1.0-dev.20261017.1 exports`]. In 7.0.2 the package root `"."` is `./lib/version.cjs`, so `require('typescript')` returns a version stub with no `createProgram`.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| typescript | npm | years | 184M/wk | github.com/microsoft/TypeScript | OK | Approved (move to `dependencies`; add `typescript-7` alias for dev) |
| jsonc-parser | npm | years (3.3.1 published 2024-06-24) | 42.9M/wk | github.com/microsoft/node-jsonc-parser | OK | Approved by the seam; install still needs the user's package approval |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
Both rows come from `gsd-tools query package-legitimacy check --ecosystem npm` and `npm view` this session; neither has a `postinstall` script [VERIFIED: seam output `postinstall: null`]. No other new third-party package is recommended: the bootstrap statistics, the oracle, the JSONC fallback, the recent-answer log and the bundle writer are small enough to write against Node built-ins and are covered by tests.

## Architecture Patterns

### System Architecture Diagram

```
 agent / user
   |  MCP tool call (code_refs ...)            CLI: gsd-atlas refs|explain|rate|allow|bug
   v                                              v
 mcp-shim / cli  --(Request, identical JSON)--> HostClient --> Host --> Tenant(repo)
                                                                           |
        +-------------------+---------------------------+------------------+--------------+
        |                   |                           |                  |              |
   Query (ranking,     Indexer (grammar facts,     ProjectModel       Governor        Recorder
   budget, fence,      cites_adr, skip emit        (tsconfig chain,   (admission,     (answer ring
   explain)            outputs)                     file sets, emit    memory          file, ratings)
        |                   |                       map, TS-7 probe)   budget)
        v                   v                           |
   Fact Store <---- local facts by blob hash            | context (config hashes + compiler id)
   (resolved_edges keyed by snapshot + context)         v
        ^                                         PreciseTier adapter  --- Resolver port (needs worktree, overlay)
        |  edges (EXTRACTED) / relations                |
        |                                               | CommandRunner.stream(spec: node --max-old-space-size=N worker.js)
        +-----------------------------------------------+   stdin: async-iterable queue of JSON lines
                                                            stdout: JSON lines (zod-validated)
                                                            worker: loads project typescript 6.x or bundled 6.0.3,
                                                                    createProgram per owner tsconfig, oldProgram reuse,
                                                                    RSS sampler thread -> SIGKILL self past budget
   failure paths (all flagged degraded, never silent):
     worker exit / OOM abort -> memory_budget or resolver_failed ; timeout -> resolver_timeout ;
     project TS 7.x -> bundled 6.0.3 + compiler_fallback ; no tsconfig/compiler -> grammar facts + precise_unavailable ;
     non-built-in precise.command not approved -> needs_approval
```

### Recommended Project Structure
```
src/
├── project-model/           # NEW module (add to MODULES in eslint.config.js): tsconfig, emit map, ADR dir, ts probe
├── precise-resolver/        # existing seam; add typescript/ adapter: client.ts, worker.ts, protocol.ts, identity.ts
├── command-runner/          # add one builtin entry + interactive-worker spec helper (reviewed change)
├── fact-store/              # additive: relations table, cites table, per-overlay context, Resolver port arg
├── query/                   # code_explain request kind; relation-aware refs/impact
├── host/ tenant/            # wire resolver + ProjectModel; allow/rate/bug request kinds; recorder
├── metrics/                 # ratings migration + event; TOOL_NAMES += code_explain
scripts/eval/                # questions/, oracle.ts (no atlas imports), harness.ts, stats.ts, prereg verify
skills/gsd-atlas/SKILL.md
skills/gsd-atlas-module-author/SKILL.md
docs/eval/                   # free-alternatives.md, preregistration.md
```

### Pattern 1: One persistent compiler process driven through `CommandRunner.stream()`
**What:** `stream(spec)` already accepts `stdin` as an `AsyncIterable`, which `feedStdin` consumes chunk by chunk with backpressure and closes only when the iterable ends. So a duplex JSON-lines session needs no runner change: push request lines into an async queue used as stdin, read response lines from `stdout`, call `kill()` to end it. [VERIFIED: src/command-runner/real.ts:123-141 `feedStdin`, :295-299 returns `{stdout, result, kill}`; src/command-runner/spec.ts:20-21 `StdinSource`]
**When to use:** the only way to keep a Program warm between queries, which the 5 s update budget needs.
**Constraints found in the runner (must be handled):**
- `maxStdoutBytes` defaults to `DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024` and counts the whole life of the child, then SIGKILLs it (real.ts:246-262). A full resolve of gsd-core yields roughly 11,000 project edges; at a few hundred bytes each that is a few MB, so a long-lived worker dies after a handful of batches. Set `maxStdoutBytes` to a safe large value in the spec or recycle the worker by count. [VERIFIED: real.ts]
- `stream()` never gets a default timeout (real.ts:281-282), so request deadlines live in the adapter, and a hung worker is ended with `kill()`.
- `decide` allows only a built-in git spec or a user-allowed executable (decide.ts:227-263). The worker needs one new reviewed `BUILTINS` entry. Because `decide.ts` cannot import other modules, give the runner an injected table of exact builtin shapes built by the composition root (executable `process.execPath`, args exactly `['--max-old-space-size=<digits>', '<known worker path>']`, a fixed env key set). The project's `typescript` location goes in the first stdin message, not argv. Add a decide test for each rejected deviation, as the git gate has.
- The worker must exit when stdin ends, so a dead host leaves no orphan.
**Protocol sketch (validated with zod on both ends):** `init {worktreeRoot, configs, compilerPath|null, budget}` then `resolve {id, sites[]}` / `update {changedPaths}` / `relations {id, files[]}` / `ping`; responses `edge`, `done {id}`, `error {id, code}`, `ready {compiler:{version, source:'project'|'bundled'}, rssMb}`. Never let the child choose paths outside the worktree; validate every returned path against the overlay (the store already drops edges whose target it does not hold, resolve.ts `validate`).
**Example:**
```typescript
// Source: pattern assembled from src/command-runner/spec.ts and real.ts (this repo)
const queue = createAsyncQueue<string>();           // yields JSON lines; end() closes the worker's stdin
const run = runner.stream(
  { executable: process.execPath, args: ['--max-old-space-size=' + heapMb, workerPath], builtinId: 'typescript-resolver',
    stdin: queue, maxStdoutBytes: Number.MAX_SAFE_INTEGER },
  { repo: worktreeRoot },
);
queue.push(JSON.stringify({ t: 'init', worktreeRoot, compilerPath }) + '\n');
for await (const chunk of run.stdout) { /* split on \n, zod.parse each line */ }
```

### Pattern 2: Map compiler declarations to grammar symbols by span, and drop what has no symbol
**What:** The store validates every edge target with `findSymbol` and drops the rest (resolve.ts `validate`), so the resolver must produce `SymbolIdentity` values that equal the grammar tier's `(repo, path, qualifiedName, kind, discriminator)`. Matching by name alone is ambiguous; matching by "the grammar symbol in the declaring file whose span contains the declaration's name token" is not.
**Measured on pinned gsd-core (11,271 call sites whose compiler declaration is inside the project, matched against the Phase 2 store):**

| Compiler declaration kind | Sites | Match a unique grammar symbol by containment |
|---|---|---|
| FunctionDeclaration | 6,333 | 6,333 (100%) |
| MethodDeclaration | 11 | 11 (100%) |
| MethodSignature | 488 | 455 |
| VariableDeclaration (const-bound functions) | 1,181 | 955 (153 same name in file but not containing, 73 none) |
| PropertySignature | 221 | 118 |
| BindingElement (destructured `require`) | 2,756 | 0 (no grammar definition exists) |
| Parameter, ShorthandPropertyAssignment, ExportAssignment, PropertyAssignment | 262 | 0 |

Overall 7,881 of 11,271 (69.9%) map, 392 are same-name-different-position, 2,998 have no definition. The 2,998 are correct to leave unresolved: they are local alias bindings, not project definitions. [VERIFIED: local experiment against `.git/gsd-atlas/facts.db` of the pinned checkout; script in the session scratchpad]
**Consequences for the plan:** (a) the adapter returns no edge when no grammar symbol contains the declaration; (b) it follows import aliases (`getAliasedSymbol`) but should not try to chase destructured `require` bindings; (c) `SymbolLookup` must be extended to return spans (Seam Gap G2); (d) report an "edges resolved / sites asked" ratio in `explain` and in the gate so a drop is visible.

### Pattern 3: ProjectModel (compiler-free) with a differential test
**What:** A new module, registered by id and named by the manifest's `project.model` (already in the schema: `project: z.strictObject({ markers: ..., model: kebabName.optional() })`, src/lang/manifest.ts:71-76). It reads tsconfig files through Source Tree `readText` (confined, no symlink escape), resolves `extends` (relative path, array form), computes `include`/`exclude`/`files` sets (TypeScript semantics: `*`, `?`, `**/`, supported extensions only, default excludes), `rootDir`, `outDir`, `references`, and returns: the config hash list for `ResolutionContext.configHashes`, owner tsconfig per file, the emit map, and the project's installed `typescript` version and `exports` keys.
**Owner rule (needed because several tsconfigs cover the same file):** gsd-core has `tsconfig.json` (extends `tsconfig.build.json`) with the identical file set; gsd-pi has 24 tracked tsconfigs, 20 of them in `packages/*`, root and `web/`, with overlapping sets. Pick the owner deterministically: nearest tsconfig directory, then non-test and non-build names first, then lexical. Run one program per owner config, never one per tsconfig. [VERIFIED: `git ls-files '*tsconfig*.json'` on pinned gsd-pi; gsd-core tsconfig files read]
**Validation:** a differential test that compares ProjectModel's file set to `ts.parseJsonConfigFileContent(...).fileNames` for gsd-core (274 files), for every gsd-pi tsconfig, and for fixture configs with comments, trailing commas, `extends` arrays and `exclude`. This is the cheapest way to prove "compiler-free" is also "compiler-equal". `typescript` is already a dev dependency.

### Pattern 4: Emit mapping and what "no fact under outDir" should mean
**Facts of the corpus (pinned gsd-core):** `rootDir: "src"`, `outDir: "gsd-core/bin/lib"`, 274 tracked `.cts` in `src/`, 1,361 tracked `.cjs` in the repo, and 17 tracked files inside `gsd-core/bin/lib` (hand-written or vendored: `vendor/js-yaml.cjs`, `exit-code-registry.cjs`, `re2js.d.cts`, ...), none of whose stems match a `.cts` source. The emitted outputs are gitignored (`.gitignore:132: /gsd-core/bin/lib/semver-compare.cjs`), so a normal checkout never indexes them. [VERIFIED: pinned checkout, `git ls-files`, `git check-ignore -v`]
**Current behaviour:** `refs semver compareSemverCore` returns 4 references, all inside `src/`. The `.cjs` consumers are missed: `gsd-core/bin/lib/capability-command-router.cjs` does `require('./semver-compare.cjs')`, which resolves to `gsd-core/bin/lib/semver-compare.cjs`, a path that is not in the overlay. The specifier rule only strips the extension within the same directory (`resolveSpecifier`, src/fact-store/specifier.ts:82-104) and its header says "Phase 3's ProjectModel replaces this rule for path aliases and packages". [VERIFIED: ran the built CLI on the pinned checkout; read specifier.ts]
**Recommendation:** ProjectModel exports `emitMap(path) -> outputPath` and the reverse. The specifier rule asks the reverse map first: if the joined path is an emit output of an in-project source and no tracked file sits at that path, the candidate is the source. If both exist, report the ambiguity as the rule already does. For "no fact points under `outDir`", define it as: **a file that is the emit output of an included source never receives facts and is skipped by the Indexer** (covers a repo that tracks its build output). Do not skip the 17 tracked hand-written files; excluding them would remove real code. The literal reading ("nothing under `outDir`") conflicts with that, so confirm it (Open Question 3).
**Extension rules to implement and test:** `.ts`/`.tsx` to `.js` (`.jsx` when `jsx: preserve`), `.cts` to `.cjs`, `.mts` to `.mjs`, declaration files never emit, `declarationDir`, `rootDir` default (common source directory) when unset, `outDir` relative to the config that declares it (an inherited value resolves against its own config file). Store the map by resolution context (a config-derived table), not per file hash.

### Pattern 5: TypeScript 7 detection is a file read, not a load
**What:** Detect 7.x by reading `<resolved>/node_modules/typescript/package.json` (`version`, `exports`) and never `require`-ing it. Probe order from the decision: `./unstable/sync`, then `./sync`; any other layout (neither subpath, a stub-only root) is "changed". In every 7.x case the answer is `degraded` with a reason, the bundled 6.0.3 does the resolving (D-12). A project with 6.x uses its own copy (D-13).
**Resolution of the project package:** walk up from the owner tsconfig directory for `node_modules/typescript/package.json`; for pnpm layouts (gsd-pi) the top-level link is a symlink, so use `realpath` and still confine to the repo root. When none exists (the pinned corpus checkout has no `node_modules`), use the bundled copy and flag `compiler_fallback` once per answer.
**Cache key:** the compiler identity (`version` and `bundled|project`) must be part of the resolution context, otherwise edges computed by 6.0.2 serve a 6.0.3 question (Pitfall 9).
**Tests (D-14):** the real `typescript-7` alias plus three fixture packages: a 7.1-style `./sync` layout, a layout with neither subpath, and a 6.x copy. Running a worker is not needed for the detection tests.

### Pattern 6: ADR citations are local facts, resolved at read time
**Measured on pinned gsd-core:** 3,780 `ADR-` mentions in tracked JS/TS files (plus 87 `adr-`, 12 `ADR `, 1 `ADR #`), 102 distinct numbers cited across code and tests, 59 in `.cts`. 100 files in `docs/adr`, named `<number>-<slug>.md` with zero-padded early ones (`0001` to `0012`) and issue numbers later; numbers `10` and `11` each have two or three files (`0010-file-operation-engine-module.md`, `0010-skill-surface-budget-module.md`, `0011-skill-surface-budget-module.md`, `0011-review-default-reviewers*.md`). Many mentions are inside string literals (lint rule messages such as `'... (ADR-456 typed-surface mandate)'`), which D-19 correctly excludes by taking comment nodes only. [VERIFIED: grep census on the pinned checkout]
**Design:** extraction adds an optional `citations` array to `FileFacts` (additive, like the Phase 2 fields) from `comment` nodes, keyed by blob hash; the number is stored as an integer and the section suffix as a short normalised detail. Resolution against the ADR directory happens in Query/Fact Store at read time over the overlay's paths (match the leading digits of file names by value; several files for one id yields several `cites_adr` candidates with `INFERRED`, per ADR 6 decision 8; none yields `unresolved`). This keeps local facts shareable across branches while the ADR directory can differ per branch. The grammar query needs a `comment` capture; the extractor's capture vocabulary and `FileFacts` validation must accept it.
**Edge cases to test:** `ADR-2143 §3`, `ADR #3473`, `adr-0001`, `ADR-1` against `0001-...md`, a citation in a string literal (must not count), a block comment spanning lines (span must start at the match, not the comment), `ADR-5057 Phase 10`.

### Pattern 7: `explain`
**What exists:** Citations carry `debug` handles: `sym/<encoded path>/<blob hash>/<ord>`, `ref/<encoded path>/<blob hash>/<ord>`, with `imp/` and `exp/` composed in Query for `code_context` [VERIFIED: src/fact-store/snapshot.ts and resolve.ts:388 ``debug: `ref/${encodeURIComponent(hit.path)}/${file.hash}/${hit.ord}` ``; observed in CLI output `"debug":"ref/src%2Fsemver-compare.cts/98c0e9e2.../16"`]. The Phase 2 summary flags `imp/` and `exp/` as an open item for this phase.
**Design:** a Query request kind `code_explain {handle}` (CLI `explain <handle>`), read-only. For `sym`/`ref` handles it returns: extractor string (`grammar:typescript@<version>` from `extractorOf`, or `precise:typescript@<compiler version>`), tier (`grammar`, `precise`, `base_commit`), grammar version, the resolution context key (config hashes, compiler identity), the overlay snapshot id and watermark, whether a cached edge exists for that site under the current snapshot and context, and the module and tier state (including `needs_approval`). Handles are opaque to callers; only the store parses them, and a malformed handle is a `not_found`-style diagnostic, never an exception. Add an `answer_id` to the envelope for D-16 (Seam Gap G9).
**Contract impact:** a seventh tool. `TOOL_NAMES` exists twice (src/query/tools.ts:12 and src/metrics/types.ts:13-20), the MCP instructions text and the "exactly six tools" tests must change together, and ADR 13 gets an amendment (its 2026-10-16 amendment says `explain` "arrives in Phase 3").

### Pattern 8: Command approval
**What exists:** `UserPermissions.allow: ReadonlyArray<{ repo: string; executable: string; argsPrefix?: readonly string[] }>` (src/command-runner/spec.ts:101-110), compared exactly in `userAllows` (decide.ts:245-253); `loadUserConfig` validates the file with a strict zod object and ignores the whole file on any error (host/config.ts:51-66, :105-133); the real runner is built once at compose time with `user: config.permissions` (bin/compose.ts:88). There is no `--allow-build` flag, no hash, and no writer.
**D-15 needs:** an exact-argv entry. Recommend adding `sha256` over a canonical JSON of `[executable, ...args]` (optionally `cwd`), kept next to the existing fields so old entries keep working, and making `decide` require the hash match for any entry that carries one. The `allow` command: the CLI shows argv and working directory and asks on a TTY (the CLI adapter may use injected io); the write is a Host request so the adapter imports only host-client. Write with `0600`, temp file plus rename, size under the 64 KiB cap, and re-validate the whole file after the edit.
**Process boundary:** the MCP server and the CLI are different processes and the runner captured `permissions` at start, so a new approval is not seen by a running MCP server until it restarts. State that in the message `allow` prints, or re-read the file per decision (cheap, bounded).
**`--allow-build`:** implement as a Host option for the MCP entry: when absent, compose the runner without `user` permissions for MCP-origin requests (so the user list cannot match) and map the resulting `command_denied` to `needs_approval`. This needs no new field on `RunContext`.
**SEC-01 test shape:** reuse the recording runner and the hostile-repo pattern (`src/command-runner/hostile-repo.test.ts`): a fixture repo with committed config naming a command, plus a module with `precise.command`, asserts the recorder saw no start except built-ins.
**Scope guard:** Phase 3 has no consumer that ingests a command's output (SCIP is Phase 9). Keep it to the gate: an approved command runs through the runner during `maintain resolve`, and its exit status is recorded; do not build an importer (Open Question 5).

### Pattern 9: Ratings, last answer, flight recorder, `bug`
**Gap:** the Metrics module accepts only counters and histograms and says so in its header ("There is no free-text field in any event type") [VERIFIED: src/metrics/types.ts:5-10]; the envelope carries no answer id; the MCP process and a later `gsd-atlas rate --last` or `bug` are different processes with no channel until Phase 4. The flight recorder in DIAGNOSTICS.md §9.1 is "capped, local-only, per tenant, 2,000 events or 5 MB".
**Recommendation:** (1) add `answer_id` (random, no content) as an additive envelope field; (2) a Host-side recorder appends one JSON line per answer (tool, argument shape, outcome code, latency bucket, degraded codes, fact handles, answer_id) to a capped ring file in the user state or cache directory, one per tenant, written by whichever process answered; (3) `rate --last` reads the newest line; `bug` reads an excerpt; (4) ratings go to `metrics.db` through a new migration and event kind holding `{answer_id|feature|session, value}`, with value in a closed set; (5) the 2,000-event and 5 MB caps are already specified in DIAGNOSTICS.md, so they are locked rather than new constants.
**`bug` hashing:** use HMAC-SHA256 with a random per-bundle key that stays on the machine, so names are stable inside one bundle (sequences and repeats stay visible) but cannot be recovered by a dictionary of likely symbol names and are unlinkable across bundles; offer redacted and raw modes only on explicit choice with a marked preview, per DIAGNOSTICS.md §9.2. [ASSUMED: design recommendation, not in the docs]
**Diagnostics (SKL-03):** `diagnostics.json` under the user directory, catalog v1 shipped as `diagnostics/catalog.v1.json`, commands `enable|types|preview|disable|history`; Phase 3 stops at preview and a local saved report (upload and the pre-filled URL are Phase 4). The draft ADR must be ratified at the start of the phase (ROADMAP Planning Notes table, row 3).

### Pattern 10: The resolver's work in a build
`maintain resolve` currently returns `{ complete: true, spentMs: 0, processed: 0, note: 'no precise tier is active' }` (src/tenant/create.ts, `case 'resolve'`) [VERIFIED]. It is the natural home for the eager pass: ask the resolver for every call/new/read/type/heritage/member site of files in an owner config, in the Governor `indexing` class, and write the cache. Without it, the first `code_refs` after a build pays worker start plus resolution inside `query.resolveTimeoutMs` (1500 ms in 02-CONSTANTS.md) and degrades to `resolver_timeout`. TSM-06's "full build under 30 s" should be defined as build plus this pass; say so in the plan.

### Suggested plan order (planner decides the split)
1. **Wave 0, human gates and registration:** ratify the diagnostics ADR; write and get approval of `03-CONSTANTS.md` and the package installs; EVL-01 scan; question drafting, user approval, oracle script, statistics, pilot and the frozen pre-registration (D-01, D-02, D-04, D-08). Seam-gap ADR amendments in the same wave.
2. **Wave 1, seams:** additive kernel and store changes (G1 to G6, G9), CommandRunner builtin and stdout-cap handling, ProjectModel, new module boundaries in lint. In parallel: SEC, ratings, diagnostics, `bug` (D-11).
3. **Wave 2, tracer (D-07):** one gsd-core tsconfig through worker, edges, `code_refs` over the real MCP server with the `degraded` fallbacks.
4. **Wave 3, breadth:** relations (`extends`, `implements`, `overrides`), emit map in the specifier rule, ADR citations, `explain`, 7.x detection, memory budget, gsd-pi no-break test, eager resolve.
5. **Wave 4, gates and skills:** two-tier TSM-06 gates on three OSes, skill authoring and freeze, scored run, analysis, verification.

### Anti-Patterns to Avoid
- **One worker or process per `resolve()` call:** pays `createProgram` every time and cannot meet the update budget on slow disks.
- **Loading the compiler in the host process:** the project's `typescript` is repo-controlled JavaScript (D-13); keep it in the killable child.
- **Using `ts.createLanguageService` or tsserver:** plugins load there; `createProgram` does not load tsconfig `plugins`, which satisfies ADR 4 decision 5 by construction. [CITED: ADR 4 decision 5; behaviour of `createProgram` is [ASSUMED] from TypeScript's design, not re-verified here]
- **Converting `(line, column)` through the compiler's line map:** it breaks lines at U+2028, U+2029 and lone CR, which the grammar's rows do not (Phase 2 note 02-13). Compute offsets from the engine's own line model.
- **Grading the eval with atlas code:** the oracle must not import anything from `src/`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Reference resolution | A name- or import-matching resolver for `EXTRACTED` edges | TypeScript `createProgram` + checker in the worker | That is the definition of `EXTRACTED`; the grammar tier already does the name-matching |
| Emit paths for oracle checks | Re-deriving `.cts` to `.cjs` by regex in the oracle | `ts.getOutputFileNames` in the oracle (dev, independent) | The oracle should use the compiler's own rule; ProjectModel is what is under test |
| JSONC | Comment stripping with regex | `jsonc-parser` (or a tokenizer proven by the differential test) | Comments in strings, trailing commas and BOM |
| Hashing | A custom hash or keyed mix | `node:crypto` `createHmac('sha256')` and `createHash('sha256')` | Boring and audited |
| Config file writes | In-place edit of `config.json` | temp file + `rename`, mode `0600`, whole-file re-validation | A half-written permission file is a security bug (the loader already ignores a bad file whole) |
| Bootstrap statistics | A library for one function | A short seeded implementation (`mulberry32` plus index resampling) with unit tests against hand-computed cases | No dependency needed, but test it: this number decides the gate |
| Usage accounting | Counting tokens yourself | The `usage` object from `claude -p --output-format json` | Verified fields below |
| Worker supervision | A new pool framework | The existing killable-pool pattern in `src/grammar-engine/pool` (load timeout, terminate grace) as the model | Same lifecycle questions, already reviewed (STACK.md forbids `piscina`) |

**Key insight:** the expensive mistakes here are in identity, versioning and gating, not in the compiler calls. A resolver that returns plausible but unmatched targets looks fine in a demo and silently vanishes in the store.

## Seam Gaps (existing code versus what Phase 3 needs)

| # | Gap | Evidence | Recommended change |
|---|-----|----------|--------------------|
| G1 | The injected `Resolver` port has no worktree, overlay or content source. It is `(sites, context, symbols) => AsyncIterable<ResolvedEdge>` while `PreciseResolver.resolve(overlay, context, sites)` has the overlay; the store holds the worktree in `collectEdges` but does not pass it | src/fact-store/types.ts:375-379; resolve.ts `collectEdges` call `parts.deps.resolver(sites, context, lookup)`; src/precise-resolver/index.ts:26-38 | Additive fourth parameter `{worktree, snapshotId, pathToHash}`; one adapter turns a `PreciseResolver` into the port |
| G2 | `SymbolLookup.find(name)` returns identities only, no spans | src/facts/resolution.ts:48-50 | Add `findIn(path, name)` returning identity plus span, and use it for containment matching |
| G3 | `ResolvedEdge` and `resolved_edges` carry no relation; `overrides` has no reference site at all; the resolver contract says "Only edges for the requested sites are yielded" | src/facts/resolution.ts:40-45; schema.ts:150-166; precise-resolver/index.ts:18-19 | Optional `relation` on `ResolvedEdge` (calls/references/extends/implements from the site kind and the checker); a separate optional `relations(overlay, context, files)` method and a `resolved_relations` table for symbol-to-symbol `overrides` and `implements`. Needs ADR 6 and 7 amendments. `resolved_edges` is derived data, so a column change is a rebuild, not a migration |
| G4 | The resolution context is one global function, not per overlay | src/fact-store/parts.ts:38 `resolutionContext: () => ResolutionContext`; resolve.ts `prepareResolution` calls `snap.parts.resolutionContext()`; default `{id:'grammar', configHashes: []}` at open.ts:396 | Make it a function of the overlay's path to hash map (config files are already in the overlay); include compiler identity |
| G5 | The runner has no entry for the worker, and its stdout cap is cumulative | decide.ts:227-228 `BUILTINS = [{ id: 'git', match: matchGit }]`; real.ts:246-262 | Injected exact builtin shape; set `maxStdoutBytes` per spec |
| G6 | The specifier rule cannot see emit mapping | specifier.ts header and `resolveSpecifier` | Pass an optional `outputToSource` lookup from ProjectModel |
| G7 | `FileFacts` has no citations; `FACT_PREDICATES` already lists `emitted_as` and `cites_adr` | file-facts.ts:10-27 | Optional `citations` array validated like the Phase 2 fields; schema table keyed by `file_id` |
| G8 | The store schema is version 1 and a stale store is refused until `build` | schema.ts:4; ADR 13 amendment 2026-10-17 | Bump `SCHEMA_VERSION` for the new tables and column; tell users to rebuild; Phase 2 dev stores become `not_indexed` |
| G9 | No answer id, no cross-process record of answers | request.ts Envelope has `schema, ok, data, diagnostics, citations, watermark, ...` and no id | `answer_id` extra and the recorder of Pattern 9 |
| G10 | The user-config schema is strict and has no hash field | host/config.ts:55-65 | Optional `sha256` per allow entry; keep old entries valid |
| G11 | `DEGRADED_CODES` has eleven codes | src/facts/degraded.ts:11-23 (below) | Add `memory_budget`, `compiler_fallback`, `needs_approval`; the doc says unknown codes must be treated as "degraded, reason unknown" |
| G12 | Module manifest is strict; no ADR directory field | manifest.ts:43-84 | Add an optional `project.adrDirs` (or similar) and bump `schemaVersion` as the file's header requires; regenerate `schemas/` (`npm run schema:build`) and keep the Ajv parity test green |

Quoted source values (verbatim), for the planner's schemas:

`src/facts/degraded.ts:11-23`: `export const DEGRADED_CODES = [ 'resolver_failed', 'resolver_timeout', 'fresh_timeout', 'precise_base_commit', 'precise_unavailable', 'stale', 'follower', 'cache_unavailable', 'reconciling', 'rebuilding', 'watermark_moved', ] as const;`

`src/facts/file-facts.ts:39`: `export const REF_KINDS = ['call', 'new', 'read', 'type', 'heritage', 'member'] as const;`

`src/facts/file-facts.ts:10-27` predicates include `'extends'`, `'extension_of'`, `'implements'`, `'conforms_to'`, `'overrides'`, `'emitted_as'`, `'cites_adr'`.

`src/query/ranking.ts:157`: `export type ImpactVia = 'import' | 'call' | 'reference';` (extend with `extends`, `implements`, `overrides`; the rank table at :159 changes with it).

`src/tenant/types.ts:23`: `export const MAINTAIN_TASKS = ['reconcile', 'resolve', 'refresh', 'collect', 'compact', 'check', 'all'] as const;`

`src/tenant/create.ts:105`: `{ resolver: noPreciseTier, clock, gitHas: (hash) => tree.hasObject(hash) },` (the production resolver is the no-op from `src/host/history.ts:91`).

## Measured Baselines (pinned corpora, macOS arm64, Node 26.11.1, TS 6.0.3)

| Measurement | Result | Source |
|---|---|---|
| gsd-core pin | `10ac3a7d5...`; 274 `.cts`, 1 `.ts`, 1,361 tracked `.cjs` | [VERIFIED: `corpus-fetch.ts` checkout, `git ls-files`] |
| Grammar-tier `build` of gsd-core | 1,689 files, 5.9 s wall (13.7 s CPU) | [VERIFIED: ran `gsd-atlas build`] |
| `createProgram`, 274 files | 463 ms (348 to 364 ms in later runs) | [VERIFIED: experiment] |
| Resolve all call sites | 28,466 sites, 28,100 resolved to some symbol, 11,271 to a project declaration, 390 ms | [VERIFIED: experiment] |
| Memory, gsd-core program | RSS 430 MB, heap 296 MB; after full pre-emit check 498 MB | [VERIFIED: experiment] |
| Incremental program (1 file edited, `oldProgram`) plus one checker query | 286 to 388 ms; RSS 602 to 704 MB while the old program lives | [VERIFIED: experiment] |
| Missing `@types/node` | project-internal resolved sites 11,271 to 11,252 (0.17% loss); 4,200 builtin calls become unresolved | [VERIFIED: permission-restricted run behaved like missing types] |
| `--max-old-space-size=200` on gsd-core | process dies with V8 "heap out of memory" abort mid-`createProgram`; the parent sees an exit, not a message | [VERIFIED: experiment] |
| In-process sampler thread | killed the process (exit 137) while the main thread spun synchronously | [VERIFIED: experiment] |
| gsd-pi pin: 24 tracked tsconfigs, 3,886 `.ts` | per config 0.08 to 1.6 s; peak RSS 1,447 MB for `tsconfig.extensions.json` (2,389 files); others 99 to 717 MB; no `node_modules` installed | [VERIFIED: experiment] |
| gsd-core heritage census | 17 classes, 16 `extends Error`, 0 `implements`, 31 `interface ... extends`, 0 `override` | [VERIFIED: scripted count on `src/*.cts`] |
| Identity mapping | see Pattern 2 (100% for function declarations) | [VERIFIED: experiment] |

Implication for tests: gsd-core cannot exercise `implements` or `overrides` at all, so those two relations are proved on fixtures (a small TypeScript repo with classes, interfaces and an abstract method), and eval questions about "implementers" must be about `extends Error` subclasses and interface heritage that actually exist.

Single-machine evidence: none of this is generalisable to Windows or Linux until CI runs it. Treat the numbers as a floor for headroom, not as the gate.

## Eval Design (EVL-01 to EVL-03)

### A. Free-alternatives evaluation (EVL-01), Wave 0
Candidates found this session (secondary sources; confirm versions from each repo when the scan is written): LSP-wrapping MCP servers `isaacphi/mcp-language-server` (Go; definition, references, rename, diagnostics, hover) and Serena (`oraios`; LSP-backed, TypeScript via typescript-language-server); `agent-lsp` (formerly `lsp-mcp`) as another LSP bridge; an agent repo-map such as Aider's; `colbymchenry/codegraph` (MIT, tree-sitter SQLite graph, local MCP, installed here as the `codegraph` CLI 1.6.0, which is the same tool this environment's guard routes to); the official Claude Code `typescript-lsp` plugin (needs `typescript-language-server` installed separately); Memtrace desk-only. [CITED: web search results from glama.ai, alguidelines.dev, sourcepulse.org, claude.com marketplace listing, circleci.com blog; third-party descriptions, marked MEDIUM-LOW]
**Protocol:** one table row per tool with: what it answers well, what it cannot (freshness across worktrees, ADR links, `.cts` to `.cjs`, degraded honesty, citations as file:line), install cost, and one live run on the same 5 to 10 gsd-core questions with the same model. Record outputs and token cost. Not an eval arm (D-05). Write it into `docs/eval/free-alternatives.md` and commit before the question freeze.

### B. Question set (D-01, D-02)
Required categories: callers, implementers, `.cts` to `.cjs` emit mapping, ADR citations, abstain. Suggested mix for 50: callers 12, references 6, extends/heritage 6, emit mapping 8, ADR citations 8, impact 5, definition/where 5, abstain 6 (12%). Draft from gsd-core source and ADRs only, never from atlas output. Every question gets a machine-checkable answer key: an expected set of `{file, symbol}` or `{file, line}` entries, an equality rule (exact set, or superset with a stated allowance), and for abstain a rule for what counts as an acceptable "not found".
**Content notes from the corpus:** (a) `.cjs` consumers are the interesting caller population: `require('./lib/x.cjs')` from `.cjs` files reaches `.cts` definitions only through the emit map, and the atlas grammar tier misses them today (4 references where `.cjs` callers exist); (b) ADR duplicates (`0010`, `0011`) are good "ambiguous" questions; (c) cited ADR ids with no file (cited numbers not among the 100 files) are natural abstain candidates; (d) the pinned SHA is recent, which limits memorisation, but gsd-core is public, so also include questions about code changed late in the history.

### C. Oracle (D-02)
`scripts/eval/oracle.ts`: imports `typescript` (dev) and `node:child_process` only through its own small use, never anything from `src/`. It builds its own program from the repo's tsconfig, derives callers/heritage/emit output via the checker and `getOutputFileNames`, cross-checks with `git grep`/`rg`, and verifies every cited `file:line` by reading the line from disk at the pinned SHA. Note the honest limit: the oracle and the atlas resolver share the TypeScript compiler, so a compiler quirk is shared; the independent parts are ProjectModel, identity mapping, positions and the cross-checks. PRD criterion 1 also asks for a hand-verified sample of `EXTRACTED` edges at 98% or better; budget a hand-verified sample of about 100 edges in the plan (it is not in the 17 requirement ids, but it is the M2 gate in PRD §11 and A50).

### D. Statistics (D-04) and power
Design: paired by question, cluster bootstrap resampling questions and keeping all k runs per question (PITFALLS C4). Pre-register: the accuracy statistic (mean over runs per question, then mean over questions), the number of bootstrap resamples, the seed, the interval level (state whether the 5-point margin is judged on a 90% two-sided / 95% one-sided bound), the token statistic (per-session total billable tokens, paired by question, tested on the same bootstrap), and the handling of failed sessions (count as incorrect, never drop).
**Arithmetic to put in front of the user:** the one-sided 95% lower bound of the paired accuracy difference is about `mean - 1.645 * sd_d / sqrt(N)`. With question-level paired SD `sd_d` of 0.30 to 0.45 and N = 50 the bound sits 7 to 10 points below the observed difference, so a true difference of zero fails a 5-point margin and atlas needs to be roughly 2 to 5 points more accurate (or the arms need to disagree on few questions). At N = 100 the offsets are about 5 to 7 points. These are illustrative; the pilot estimates `sd_d` for real. [ASSUMED: arithmetic with assumed SD, not a power simulation; my quick Monte Carlo used unrealistic noise and is not relied on]. The requirement says "at least 50", so N is a lever the plan can pull (each extra 50 questions costs 300 more sessions). The citation criterion (EVL-03: verifiable file:line at least 80%) is not covered by D-04; pre-register whether it is judged on the point estimate or a lower bound (C4: 46 of 50 for a Wilson lower bound over 80%). Recommend the point estimate with the interval reported (Open Question 4).

### E. Harness facts verified on Claude Code 2.1.302
- `claude -p ... --output-format json` returns `usage.input_tokens`, `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens`, `usage.output_tokens`, `total_cost_usd`, `num_turns`, `duration_ms`, `modelUsage`. A bare "Reply ok" with `--tools ""` already costs about 2.9k input tokens, so a fixed overhead exists in both arms. [VERIFIED: ran it]
- `--output-format stream-json --verbose` emits a `system/init` event listing `tools`, `mcp_servers`, `skills`, `plugins`, `agents`; log it per session and assert the arm's tool set against the pre-registration. [VERIFIED]
- This version exposes no `Grep` or `Glob` tool (the init list has `Bash`, `Read`, `Edit`, `Write`, `Task`, `WebFetch`, `WebSearch`, `Skill`, ...). "Grep and read tools only" therefore means `--tools "Bash,Read"` with Bash limited by `--allowedTools` patterns to read-only search, or an equivalent pinned set; the atlas arm keeps the same plus the atlas MCP tools and the skill. Disable `Task` (sub-agents), `WebSearch`, `WebFetch`, `Edit`, `Write` in both arms. [VERIFIED: init event; remaining flag semantics from `claude --help`]
- Isolation: with `--setting-sources ""` a `Read` of a file the user's PreToolUse guard normally blocks succeeded, and the user-level `CLAUDE.md` (which mentions CodeGraph) was not loaded, but the repo's own `CLAUDE.md` was (3,124 vs 2,859 input tokens). `--strict-mcp-config` keeps the user's CodeGraph MCP server out. `--bare` would remove project CLAUDE.md too but requires `ANTHROPIC_API_KEY`. Decide and record whether gsd-core's own `CLAUDE.md`/`AGENTS.md` stay in both arms (they do by default). [VERIFIED: local runs]
- Skill loading: `--plugin-dir` loads a skill as `<plugin>:<skill>` (`gsd-atlas-eval:gsd-atlas` in the test). The name the agent sees therefore differs from an installed `~/.claude/skills/gsd-atlas`. A skill body loads only when invoked; always-loaded cost is the description (listing cap 1,536 characters). Record the sha256 of the skill file, and log whether the agent invoked it. [VERIFIED: init event; CITED: code.claude.com/docs/en/skills]
- No `--max-turns` flag in this version; bound a session with `--max-budget-usd` and a wall-clock kill in the harness. `--json-schema` exists for structured final answers; whichever answer format is used must be identical in both arms. [VERIFIED: `claude --help`]
- Concurrency: sessions that share one checkout share one atlas store, and only one MCP process can lead the writer lease; the rest are followers (`degraded: ['follower']`, no cache writes). Give each concurrent session its own copy of the checkout with its own `GSD_ATLAS_STORE_DIR` seeded from a pre-built store, or run atlas sessions sequentially. Prompt caching also makes later sessions cheaper than earlier ones: interleave and randomise arm order, and keep cache reads as their own column (D-06).
- Prepare the corpus the way a developer has it: decide whether `npm ci --ignore-scripts` runs in the checkout (then the project's own `typescript@^6.0.3` is used, D-13) and pre-register it. Build the atlas index and warm the resolved-edge cache before the clock starts, and report build time separately.
- Cost: sessions = N questions x 3 runs x 2 arms. Run a 6 to 10 session pilot, read `total_cost_usd` and token totals, then compute the full-run cost before committing; put a `--max-budget-usd` ceiling per session in the pre-registration. Rate limits argue for 2 to 3 concurrent workers; make the runner idempotent per `(question, arm, run)` so an interrupted run resumes.

### F. Freeze and verification
`docs/eval/preregistration.md` records: question-set hash, oracle-script hash, skill hash, margin, interval level, bootstrap parameters, run configuration (model id, flags, tool sets, corpus SHA and whether `npm ci` ran), N, and the failure-handling rule. A script `scripts/eval/verify-prereg.ts`, run in CI, recomputes the hashes of the committed files and fails when they differ from the registered ones, so the freeze is mechanical. Changing any value after the first scored run means a new registered run (D-04, D-23). The 300-session scored run is local, not CI.

## Common Pitfalls

### Pitfall 1: The worker dies after a few resolves
**What goes wrong:** `stream()` caps cumulative stdout at 16 MiB and SIGKILLs the child; the adapter sees a crash that looks like a bug in the worker.
**How to avoid:** set `maxStdoutBytes` explicitly; test with a loop of 50 full resolves on a fixture.
**Warning signs:** `output_cap_exceeded` diagnostic; worker exits after a predictable number of batches.

### Pitfall 2: Edges vanish because identity does not match
**What goes wrong:** the resolver returns a target the store cannot find, so `validate` drops it silently. A demo on function declarations passes (100%) while const-bound functions, interface methods and property signatures lose 20% to 55%.
**How to avoid:** span containment through an extended `SymbolLookup`; per-kind resolved-over-asked counters in a test on the pinned corpus.
**Warning signs:** `code_refs` results that are only grammar tier although the worker is healthy.

### Pitfall 3: Position conversion off by lines or columns
**What goes wrong:** the grammar spans are 0-based lines and UTF-16 columns with its own line-break rule; the compiler treats U+2028, U+2029 and lone CR as line breaks. Files containing them, CRLF files and BOM files give wrong offsets.
**How to avoid:** compute offsets from the file text using the engine's rule, and pass offsets to the checker. Fixtures: CRLF, BOM, emoji, U+2028.

### Pitfall 4: Memory reported by the wrong party
**What goes wrong:** a parent cannot read a child's RSS portably without a platform tool, and a child blocked in `createProgram` cannot report. **How to avoid:** sampler thread in the child (verified) plus `--max-old-space-size` as a hard V8 backstop; map exit by signal (137) or V8 abort (134) to `memory_budget`. Remember the transient double program during incremental updates (602 to 704 MB against 430 MB steady): budget for 2x or drop `oldProgram` reuse when the budget is tight.

### Pitfall 5: Resolver cold start eats the 1.5 s query bound
**What goes wrong:** the first `code_refs` after a start has to spawn the worker and create the program, exceeds `query.resolveTimeoutMs`, and answers `resolver_timeout`. The store keeps the resolver running and fills the cache, so the second ask is right, which makes the first-ask failure look flaky. **How to avoid:** eager `maintain resolve` after build, warm the worker on tenant start, and measure cold first-query on hosted Windows early (Windows spawn is far slower than macOS).

### Pitfall 6: A negative result is re-asked forever
**What goes wrong:** the Phase 2 summary notes "A site with no cached edge is re-asked (no negative marker): Phase 3 should add one before a real compiler resolver ships". With 17,000 of 28,000 sites legitimately unresolvable (builtins, aliases), every read would re-ask them. **How to avoid:** store a negative marker keyed like an edge, or a per-snapshot "asked" set.

### Pitfall 7: Context key misses the compiler and the owner config
**What goes wrong:** a branch switch that changes a tsconfig, or a project upgrading `typescript` 6.0.2 to 6.0.3, serves stale edges. **How to avoid:** `configHashes` = hashes of every config in the chain for the owner config plus the compiler identity; test the two-branch fixture from PRD criterion 7 for precise edges.

### Pitfall 8: Multi-tsconfig repos build many programs
**What goes wrong:** gsd-pi has overlapping configs; naive "one program per tsconfig" multiplies memory (four of its programs total about 3 GB). **How to avoid:** owner config per file, LRU of programs under the budget, `degraded: memory_budget` for the rest (D-21, D-22). Test with an artificially small budget on a fixture and once on gsd-pi.

### Pitfall 9: Treating the `typescript` import as always present
**What goes wrong:** in 7.0.2 `require('typescript')` is a version stub; in a checkout without `node_modules` there is no compiler at all. **How to avoid:** probe by reading `package.json` and `exports`; fall back to the bundled copy; always flag `degraded` with a code and a diagnostic naming which case.

### Pitfall 10: `--permission` hardening that lowers precision
**What goes wrong:** it denied ancestor and symlink reads and silently lost 4,200 resolved sites. **How to avoid:** do not use it in Phase 3 unless a differential test proves identical results.

### Pitfall 11: Stale dev stores after the schema bump
**What goes wrong:** stores built in Phase 2 are refused (`not_indexed`) after the version bump. **How to avoid:** say so in the changelog and the error text; the build path already recreates them.

### Pitfall 12: Parallel atlas sessions become followers
See Eval Section E. A follower answers `degraded: ['follower']` and does not write the resolved-edge cache, which would lower atlas arm quality for a harness reason.

### Pitfall 13: The CLI cannot see the last answer
Covered by Pattern 9: without a persisted record, `rate --last` and `bug` have nothing to read in a new process.

### Pitfall 14: The eval environment is not clean
The user-level guard hook blocks `Read` and `Bash` on indexed source files in an interactive session, and user `CLAUDE.md` directs agents to CodeGraph. Without `--setting-sources ""`, `--strict-mcp-config` and an `init`-event assertion, the baseline arm could be blocked or could reach CodeGraph. Verified fixes in Eval Section E.

### Pitfall 15: Windows process and file costs
Hosted Windows has 13 to 14 times the Linux cost for fsync-bearing temp file operations unless `TEMP` is moved to the runner temp folder (`.planning/debug/windows-ci-diag.md`, already applied in ci.yml). A worker process start plus program creation per test file would multiply that: share one worker per test file, create fixtures in the runner temp folder, close databases before deleting directories (EBUSY), and compare real paths with `fs.realpathSync.native`.

## Code Examples

### Cluster bootstrap for the paired accuracy difference
```typescript
// Source: design for D-04 (PITFALLS.md C4 recipe); test against hand-computed cases
// perQuestion[q] = { atlas: number[]  /* 1/0 per run */, grep: number[] }
export function pairedClusterBootstrap(
  perQuestion: readonly { atlas: readonly number[]; grep: readonly number[] }[],
  resamples: number,
  seed: number,
): { diff: number; lowerBound: number } {
  const rand = mulberry32(seed);
  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const d = perQuestion.map((q) => mean(q.atlas) - mean(q.grep)); // all runs of a question stay together
  const stats: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    let sum = 0;
    for (let i = 0; i < d.length; i += 1) sum += d[Math.floor(rand() * d.length)] as number;
    stats.push(sum / d.length);
  }
  stats.sort((x, y) => x - y);
  const at = (p: number): number => stats[Math.floor(p * (resamples - 1))] as number;
  return { diff: mean(d), lowerBound: at(0.05) }; // 5th percentile = one-sided 95% = two-sided 90% lower end
}
```
Pre-register the level in words ("the 5th percentile of the bootstrap distribution, judged against -0.05") so the sentence and the code cannot drift.

### Declaration to grammar-symbol match
```typescript
// Source: experiment script in this research (identity mapping), to become identity.ts in the adapter
const nameStart = decl.getSourceFile().getLineAndCharacterOfPosition(nameNode.getStart(sf)); // use the engine's line rule, not this
const hit = symbolsInFile(declPath, symbol.name).filter(
  (s) => within(s.span, nameStart),        // grammar symbol span contains the declaration name token
);
if (hit.length !== 1) return;              // none or ambiguous: yield no edge (never guess)
yield { site, target: hit[0].identity, confidence: 'EXTRACTED', resolver: 'typescript' };
```

### Using the usage report (verified field names)
```typescript
// Source: output of `claude -p --output-format json` on 2.1.302
type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
const billable = (u: Usage): number => u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens + u.output_tokens;
```

### Detecting the TypeScript layout without loading it
```typescript
// Source: registry exports of typescript@7.0.2 and typescript@7.1.0-dev.20261017.1
const pkg = JSON.parse(readConfined(join(tsDir, 'package.json')));
const major = Number(String(pkg.version).split('.')[0]);
const subpaths = Object.keys(pkg.exports ?? {});
if (major === 6) use('project');
else if (major >= 7) fallback(subpaths.includes('./unstable/sync') ? '7.0-unstable' : subpaths.includes('./sync') ? '7.1-sync' : 'unknown-layout');
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `require('typescript')` always has the compiler | 7.x root is a version stub; API at `./unstable/sync` (7.0.x) then `./sync` (7.1 dev) | July 2026 | Detection must read `exports`; bundle 6.0.3 |
| `ts.createProgram` for every project | Same for 6.x; 7.x has no supported programmatic API yet | 2026-07-08 | 7.x resolver deferred (D-12) |
| Eval claims "higher accuracy than grep" | Non-inferiority margin plus a token win | PITFALLS A3 | The gate in D-04 |
| Skills as loose prompt files | `SKILL.md` with frontmatter, listed by description, body loaded on invoke | current | Description must carry the routing; body is not always in context |
| Hook and settings inheritance in headless runs | `--setting-sources ""`, `--strict-mcp-config`, `--plugin-dir` | CC 2.1.x | Required for a clean A/B |

**Deprecated/outdated:**
- `@typescript/typescript6`: stops at 6.0.2; do not use as the fallback (STACK.md).
- MCP roots and sessions: not usable; repository identity arrives as `repo`/`cwd` (ADR 13 amendment).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `ts.createProgram` loads no tsconfig `plugins`, so ADR 4 decision 5 holds by construction | Anti-Patterns | A plugin path would run repo code in the worker; the worker already runs under a scrubbed environment, but confirm with a fixture tsconfig carrying a `plugins` entry |
| A2 | Node 24.16 lacks `--allow-net` for the permission model | Alternatives | Only affects optional hardening, which is not recommended anyway |
| A3 | `process.kill(process.pid, 'SIGKILL')` from a worker thread terminates the process on Windows | Pattern 1, Pitfall 4 | The memory kill would not fire on Windows; the V8 heap limit is still the backstop; verify on CI |
| A4 | An in-worker sampler satisfies D-21's "parent RSS watch" | Pattern 1 | The user may require a parent-side watch; see Open Question 2 |
| A5 | HMAC with a local per-bundle key is the right hashing for `bug` | Pattern 9 | A plain hash would be dictionary-recoverable; the user may prefer something simpler |
| A6 | Proposed constants in the table below | Constants | Each needs approval; values are starting points from measured headroom |
| A7 | Power arithmetic with SD of 0.30 to 0.45 | Eval D | The pilot may show much lower or higher disagreement; N and the feasibility of the gate depend on it |
| A8 | The free-alternatives candidate list and their capabilities | Eval A | Descriptions came from third-party pages; verify against each project's repo when running them |
| A9 | Interpreting "no fact points under `outDir`" as "emit outputs of included sources get no facts" | Pattern 4 | The literal reading would exclude 17 tracked real files; confirm |
| A10 | `jsonc-parser` is preferred over a hand tokenizer | Standard Stack | A package approval may be refused; the hand tokenizer plus the differential test is the fallback |

**Proposed constants for `03-CONSTANTS.md` (a human must approve each; the Phase 2 guard refuses an agent writing these values):**

| Key | Proposed | Basis |
|-----|----------|-------|
| `precise.memoryBudgetPercent` | 25 | D-21, DESIGN A25 (locked) |
| `precise.heapShareOfBudget` | 0.8 | RSS exceeds heap by 130 MB on gsd-core (430 vs 296) |
| `precise.rssSampleMs` | 250 | cheap, well under the 5 s update budget |
| `precise.startTimeoutMs` | 20000 | spawn plus init; measured 0.35 to 0.46 s on a Mac, Windows unknown |
| `precise.requestTimeoutMs` | 25000 | below the 30 s build budget so a hang fails before the gate |
| `precise.idleExitMs` | 300000 | release 400 MB when unused |
| `precise.maxStdoutBytes` | `Number.MAX_SAFE_INTEGER` | Pitfall 1 |
| `gate.buildPrCeilingMs` / `gate.updatePrCeilingMs` / `gate.warmQueryPrCeilingMs` | 90000 / 15000 / 6000 | 3x the roadmap figures, the ratio Phase 2 used for freshness (3 s vs 1 s); D-10 needs approval |
| `eval.intervalLevel` | 90% two-sided (95% one-sided) | Eval D; must be registered |
| `eval.maxBudgetUsdPerSession` | set from the pilot | cost control |

## Open Questions (RESOLVED)

1. **Relation storage design (G3).** RESOLVED: see 03-DECISIONS.md OQ1.
   - Known: `overrides` has no reference site; `ResolvedEdge` has no relation; ADR 7 treats the Fact Store interface as frozen.
   - Unclear: whether the user prefers an optional `relations()` method plus a new table, or declaration-name pseudo-sites emitted by the grammar tier.
   - Recommendation: the optional method and table; both need an ADR amendment in Wave 0 or 1.
2. **Memory watch location (D-21).** In-worker sampler (portable, verified on macOS) versus parent polling via `/proc`, `ps` and a Windows tool (needs new builtins). Recommend the sampler and ask the user to confirm it satisfies "parent RSS watch that kills it". RESOLVED: see 03-DECISIONS.md OQ2.
3. **"No fact points under `outDir`" (TSM-03).** Recommend: emit outputs of included sources get no facts; keep the 17 tracked hand-written files in `gsd-core/bin/lib`. Confirm. RESOLVED: see 03-DECISIONS.md OQ3.
4. **EVL-03 citation criterion.** Point estimate at or above 80% with the interval reported, or a lower bound above 80%? Not covered by D-04. RESOLVED: see 03-DECISIONS.md OQ4.
5. **Scope of `precise.command` in Phase 3.** Gate and run an approved command through the runner, record its exit status, build no importer. Confirm that is enough for SEC-02. RESOLVED: see 03-DECISIONS.md OQ5.
6. **Skill distribution.** The package needs `skills` in `files`; whether `init` installs it, and under which name, is unspecified. The eval loads it by `--plugin-dir`, which namespaces the name. RESOLVED: see 03-DECISIONS.md OQ6.
7. **Number of questions.** Fifty meets the requirement; a pilot should decide whether the gate is reachable at that N or N should rise. RESOLVED: see 03-DECISIONS.md OQ7.
8. **Corpus preparation for the eval.** Run `npm ci --ignore-scripts` in the pinned gsd-core checkout (project TypeScript used) or not (bundled fallback, answers flagged `degraded` throughout)? Recommend yes, and register it. RESOLVED: see 03-DECISIONS.md OQ8.
9. **Edge-precision sample.** PRD criterion 1 (hand-verified `EXTRACTED` edges at least 98%) is an M2 gate but has no requirement id here; confirm it belongs in this phase. RESOLVED: see 03-DECISIONS.md OQ9.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | yes | 26.11.1 (floor 24.16.0; Node 24 not installed locally) | CI runs 24.16.0 and 26 |
| git | Source Tree, corpus fetch, oracle | yes | 2.54.0 | none (hard dependency) |
| ripgrep | oracle cross-check, baseline arm | yes | 15.2.0 | `git grep` |
| `claude` CLI | eval harness | yes | 2.1.302 (OAuth auth works; `--bare` would need `ANTHROPIC_API_KEY`) | none |
| `codegraph` CLI | EVL-01 live run | yes | 1.6.0 | desk review only |
| `gh` CLI | corpus tools, docs | yes | 2.102.0 | none needed |
| Network | corpus fetch, registry checks, eval | yes | - | atlas itself needs none |
| Windows and Linux machines | TSM-06 gates, 3-OS tests | no | - | three-OS CI is the only check |
| LSP-based tools (`typescript-language-server`, `mcp-language-server`, Serena) | EVL-01 live runs | not checked | - | install per tool during the scan; record cost |
| `node_modules` in the pinned gsd-core checkout | project compiler path | no (fetch gives a clean checkout) | - | `npm ci --ignore-scripts` in a throwaway checkout |

**Missing dependencies with no fallback:** none for planning. **With fallback:** Node 24 locally (CI), LSP tools (install during Wave 0).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` with native type stripping, `c8` 12.0.0 |
| Config file | none; scripts in package.json (`test`, `coverage`) |
| Quick run command | `node --test "src/<module>/*.test.ts"` |
| Full suite command | `npm test && npm run lint && npm run typecheck && npm run build` |
| Estimated runtime | seconds per module; the worker tests add process starts, so share one worker per file |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TSM-07 | ProjectModel file sets equal `ts.parseJsonConfigFileContent` on gsd-core, all gsd-pi tsconfigs, JSONC fixtures | differential | `node --test "src/project-model/*.test.ts"` | no, Wave 0 |
| TSM-03 | `.cts` to `.cjs` map and reverse; `require` of emitted path resolves to `.cts`; emit outputs skipped | unit + corpus gate | `node --test "src/project-model/*.test.ts" "src/fact-store/*.test.ts"`, `node scripts/corpus-gates.ts` | no |
| TSM-01 | Resolved `calls`/`references`/`extends` edges on a fixture and one gsd-core tsconfig; `implements`/`overrides` on a fixture | contract + integration | `node --test "src/precise-resolver/*.test.ts"` (reuses `definePreciseResolverContract`) | contract exists, adapter no |
| TSM-02 | 7.x layouts detected, answer `degraded` with a reason | unit | `node --test "src/precise-resolver/typescript/detect.test.ts"` | no |
| TSM-05 | worker killable, start through runner, OOM abort and sampler kill give `memory_budget`, orphan exit on stdin end | integration | `node --test "src/precise-resolver/typescript/worker.test.ts"` | no |
| TSM-06 | build, one-file update, warm query within ceilings, PR and nightly tiers | gate | `node scripts/precise-gate.ts --pr` / `--strict` | no (model on `scripts/freshness-gate.ts`) |
| TSM-04 | citations extracted from comments only, resolved by value, ambiguity and `unresolved` | unit + golden | `node --test "src/grammar-engine/*.test.ts" "src/query/*.test.ts"` | partly |
| QRY-07 | `code_explain` for sym/ref handles; CLI and MCP parity | e2e | `node --test src/cli/*.test.ts "src/mcp-shim/*.test.ts"` | tests exist, update counts |
| SEC-01, SEC-02 | hostile fixture runs nothing; `allow` writes a valid entry; MCP without `--allow-build` reports `needs_approval` | integration with recording runner | `node --test src/command-runner/hostile-repo.test.ts "src/host/*.test.ts"` | extend |
| SKL-02 | rating written with answer id and no content; `--last` reads the recorder | unit + e2e | `node --test "src/metrics/*.test.ts" "src/cli/*.test.ts"` | extend |
| SKL-03, SKL-04 | DIAGNOSTICS §8 and §9.6 acceptance tests: nothing by default, per-type consent, fixture secrets absent in hashed mode | integration | `node --test "src/diagnostics/*.test.ts"` | no |
| SKL-01 | skills present, frontmatter valid, packaged | unit | `node --test scripts/package.test.ts` | extend `files` |
| EVL-01 | scan document exists with the required rows | doc check | `node --test scripts/eval/*.test.ts` | no |
| EVL-02 | prereg hashes match committed files; questions parse; oracle never imports `src/` | unit | `node scripts/eval/verify-prereg.ts` | no |
| EVL-03 | stats functions on known cases; usage parsing on recorded fixtures; scoring rules; the scored run is local | unit (CI), local run | `node --test scripts/eval/*.test.ts` | no |

### Sampling Rate
- **Per task commit:** the module's quick command.
- **Per wave merge:** `npm test`.
- **Phase gate:** full suite plus the PR-tier TSM-06 gate green on three OSes, `verify-prereg` green, and the scored run's analysis committed before `/gsd-verify-work`.

### Wave 0 Gaps
- [ ] `docs/eval/free-alternatives.md` and its live-run notes (EVL-01)
- [ ] `scripts/eval/` questions, oracle, stats, harness skeleton, pilot results, `docs/eval/preregistration.md` (EVL-02)
- [ ] `03-CONSTANTS.md` approved; package installs approved
- [ ] ADR ratifications and amendments (diagnostics ADR; ADR 5, 6, 7, 13 for the seam changes)
- [ ] Fixture repos: TypeScript repo with classes/interfaces/abstract methods, CRLF/BOM/U+2028 files, a `.cts` emit repo, a two-branch precise repo, fake `typescript` 7.1-layout packages, a hostile-config repo
- [ ] `eslint.config.js` MODULES entries for each new module plus one boundary test each
- [ ] Framework install: none new

## Security Domain

`security_enforcement` is enabled in `.planning/config.json` (ASVS level 1, block on high). [VERIFIED: config.json]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | local process family, no accounts |
| V3 Session Management | no | stateless MCP |
| V4 Access Control | yes | permissions only from user-level config; per-repo, per-command exact approval; `--allow-build` for MCP |
| V5 Input Validation | yes | zod on the worker protocol, user config, tool schemas, handles; confined reads for tsconfig, `extends`, ADR directories |
| V6 Cryptography | yes | `node:crypto` HMAC and sha256 only |
| V7/V8 Logging and data protection | yes | flight recorder and metrics hold shapes, ids and codes, never source, paths or names; bundles hashed by default |
| V12 Files | yes | no reads outside the worktree; symlink and `..` confinement; `0600` writes with rename |
| V14 Configuration | yes | repo config can never enable commands or diagnostics |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Hostile repo supplies `typescript` in `node_modules` (repo-controlled code in the worker) | Elevation | Accepted by ADR 4 decision 5 and D-13; scrubbed environment, killable child, no repo-supplied args, record the compiler path in `explain`; document the residual risk |
| tsconfig `extends` or `include` pointing outside the repo | Information disclosure | resolve through Source Tree confined reads; refuse escapes with a diagnostic |
| Worker output spoofs edges or paths | Tampering | zod-validate every line; store already drops targets not in the overlay; cap line length and count |
| Module manifest declares `precise.command`; repo config "enables" it | Elevation | `decide` has no input from repo data (decide.ts header); SEC-01 test with the recording runner |
| Approval replayed after the command changed | Tampering | exact-argv sha256 in the entry; approval keyed to canonical repo path |
| User-config tampering or partial write | Tampering | atomic write, `0600`, whole-file validation, size cap |
| ADR text or comment injection into answers | Spoofing / prompt injection | only the integer id and a normalised short detail leave the store; any comment text stays inside `untrusted_text` fences |
| `bug` bundle leaks names or paths | Information disclosure | HMAC-hashed by default, redacted preview of the exact bytes, fixture-secret test, never upload |
| Eval agent with `Bash` modifies or exfiltrates | Tampering | throwaway checkout, read-only search patterns, no network tools, budget cap per session, assert the tool set from the `init` event |
| Runaway worker memory | Denial of service | V8 heap limit + sampler kill + exit-code mapping to `memory_budget` |

## Sources

### Primary (HIGH confidence)
- This repository, read via `codegraph node` and the built CLI this session: src/precise-resolver/{index,contract,stub}.ts; src/command-runner/{spec,decide,real,exec-resolve,env}.ts; src/fact-store/{types,schema,cache,resolve,specifier}.ts; src/facts/{resolution,file-facts,degraded,request}.ts; src/query/{tools,cite,ranking}.ts; src/mcp-shim/server.ts; src/host/{config,route}.ts; src/tenant/{types,create}.ts; src/metrics/types.ts; src/lang/manifest.ts; src/bin/compose.ts; eslint.config.js; .github/workflows/{ci,nightly}.yml; docs/adr/{4,5,6,12,13}; docs/DIAGNOSTICS.md; docs/PRD.md; docs/DESIGN.md; .planning/research/PITFALLS.md.
- Measured experiments on pinned `gsd-core` (`10ac3a7`) and `gsd-pi` (`bb86b6c`) fetched with `scripts/corpus-fetch.ts` (scripts kept in the session scratchpad).
- npm registry (`npm view`), 2026-10-17: typescript dist-tags and exports, jsonc-parser; `gsd-tools query package-legitimacy check`.
- Claude Code 2.1.302 local runs (`--help`, JSON and stream-json output, plugin-dir, setting-sources isolation).

### Secondary (MEDIUM confidence)
- code.claude.com/docs/en/skills (SKILL.md frontmatter, locations, context budget) via WebFetch; first 100,000 characters read.

### Tertiary (LOW confidence, for validation)
- Web search results on mcp-language-server, Serena, agent-lsp, colbymchenry/codegraph, and the Claude Code `typescript-lsp` plugin (glama.ai, alguidelines.dev, sourcepulse.org, claude.com marketplace, circleci.com): third-party descriptions, no benchmark claim is relied on.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH; one runtime dependency move and one approved-on-request parser, both audited.
- Architecture: HIGH for the persistent-process design and the seam gaps (read and measured); MEDIUM for relation storage (design choice with ADR impact).
- Pitfalls: HIGH for those reproduced here (stdout cap read in code, OOM abort, identity mapping, permission loss); MEDIUM for Windows items.
- Eval: MEDIUM; mechanics verified, power and cost depend on the pilot.

**Research date:** 2026-10-17
**Valid until:** 2026-11-14 for repo facts; 7 days for TypeScript 7.1 status (a stable 7.1 changes D-12's premise) and for the Claude Code flags.
