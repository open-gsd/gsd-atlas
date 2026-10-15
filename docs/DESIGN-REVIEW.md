# gsd‑atlas — Adversarial design review

**Date:** 2026‑10‑15 · **Reviews:** PRD 0.1.0, DESIGN.md (A1–A43), SDK‑PROVIDERS.md, AGENT‑INTEGRATION.md, the seven draft ADRs, gsd‑graph Atlas bridge PRD

Every section below assumes the design is wrong and tries to prove it. Severity:
- **Blocker:** the design as written produces wrong answers, loses data, or opens a security hole. Fix before the MVP.
- **Major:** a stated goal or budget probably won't hold. Fix or re‑scope before the milestone that needs it.
- **Minor:** a gap to close in the docs.

New evidence gathered for this review is marked **[measured]**.

---

## Verdict

The core bets hold up: SQLite, a shared host, languages as data, content‑addressed facts and local SDK data. The blockers fall into four groups:

1. **Wrong answers.** Resolved references can't be keyed by one file's content (F‑1), and symbol ids change on every edit (F‑2). Sharing edges across branches by file hash would cite the wrong targets.
2. **A logic bug.** The retire‑then‑collect rule never collects uncommitted content, which is exactly the churn case (L‑1).
3. **Security.** A cloned repo can turn on command execution (S‑1); the localhost HTTP endpoint is reachable from web pages (S‑2); repo and package text flows into agent context unfenced (S‑3).
4. **Product gaps.** The Apple SDK headline is off by default (SDK‑1); one host can't serve repos pinned to different gsd‑atlas versions (H‑1); strict mode can deny greps atlas can't answer (M‑1).

Beyond those, the MVP is too wide for its first milestone (P‑2), and several headline numbers come from synthetic or simplified benchmarks (E‑1).

| Severity | Count |
|----------|-------|
| Blocker | 9 |
| Major | 20 |
| Minor | 18 |

---

## 1. Product and scope

**P‑1 (Major) — No scan of free alternatives.** The case for building is "the tools I use cost money". Free, open‑source tools already cover parts of this; for example, MCP servers that wrap language servers for symbol lookup and references. If one of them covers 70 % of `code_find`/`code_refs`, gsd‑atlas's value is the rest: SDK facts, ADR links, multi‑repo, enforcement, freshness. The PRD should say which free tools were evaluated and why they fall short, or the team discussion will ask.
*Fix:* add a short "Alternatives" section to the PRD with the gap each free tool leaves.

**P‑2 (Major) — The MVP is too big for one person's first milestone.** M1 alone carries the WebAssembly runtime, query engine, store, a multi‑tenant host with priority queues, HTTP MCP, a stdio shim, a watcher, a CLI and the read tools. The ADRs freeze the multi‑tenant and swarm design before a single real agent has used the tool.
*Fix:* keep the tenant boundary in the code but ship M1 with one tenant, one read thread and stdio MCP. Add HTTP, queues and the governor in a hardening milestone driven by measured load. The ADRs stay; the build order changes.

**P‑3 (Minor) — Success depends on agent behaviour, but the only usage signal is local.** There is no telemetry by design, which is right, but then the team has no way to learn whether atlas helps anyone but you.
*Fix:* an opt‑in `gsd-atlas report` that writes a local anonymised summary the user can choose to paste into an issue.

---

## 2. Fact model and identity

**F‑1 (Blocker) — Resolved references aren't a function of one file's content.** A20 and A19 key facts by the file's git blob id and share them across branches and worktrees. That is right for local facts (definitions, imports as written, call sites by name). It is wrong for resolved edges: `calls foo → src/a.ts#foo` depends on what `src/a.ts`, tsconfig paths, `node_modules` and the other files say *in that worktree*. The same file content on two branches can resolve to different targets. The draft worktree‑lifecycle ADR claims a new worktree "is live from `git ls-tree` with no re‑indexing", which is only true for local facts.
*Fix:* split facts into two layers.
- **Local facts** are keyed by blob id and shared freely: definitions, reference sites with the name and import path as written.
- **Resolved edges** are keyed by (overlay snapshot, resolution context hash), where the context covers the module's config files and the dependency lockfile. Resolve lazily per overlay at query time, cached per snapshot.

This changes the fact‑model and worktree‑lifecycle ADRs.

**F‑2 (Blocker) — Symbol ids change on every edit.** Symbol id = content hash + qualified name + kind, so editing one line of a file gives every symbol in it a new id. Edges in other files that point at the old ids break; ledger entries (R2 "has this agent seen `parseDecisions`?") stop matching.
*Fix:* stable symbol identity = (repo, path, qualified name, kind, overload discriminator), with the content hash as a version, not part of the identity. Edges point at the stable identity.

**F‑3 (Major) — `git hash-object` isn't the raw file content.** It applies clean filters: CRLF normalisation, `.gitattributes` filters, and Git LFS (which hashes the pointer, not the content). LFS‑tracked source or generated files would be "indexed" as pointers.
*Fix:* hash with the same filters git uses (so ids match git objects), but read content from the working tree; skip LFS pointers with a diagnostic; record the line‑ending mode so spans line up on Windows.

**F‑4 (Major) — `code_context` promises "tests that touch it" but there is no predicate for tests.** The fixed vocabulary has no `tests` relation and no rule for what a test is.
*Fix:* add a `tested_by` predicate derived from test‑file globs per module (with `features.json`‑style config) plus call references from those files; mark it `INFERRED`.

**F‑5 (Minor) — Missing predicates for common constructs:** Swift extensions (`extends` is overloaded for inheritance), TypeScript type‑only imports, re‑exports (`export * from`), decorators and Python dynamic imports.
*Fix:* review the vocabulary against the three launch languages before freezing it; add `reexports` and `extension_of`.

**F‑6 (Minor) — ADR id pattern `ADR-\d+` is ambiguous in gsd‑core.** gsd‑core's own ADR README notes legacy files where `0010` appears twice and `0011` three times. A bare "ADR‑0011" maps to three files.
*Fix:* resolve ADR ids against the repo's ADR directory; emit `cites_adr` to all candidates with `INFERRED` confidence when ambiguous, and report it.

---

## 3. Store

**ST‑1 (Major) — The benchmarks don't cover the queries agents actually run.** The 1M‑LOC test used random references and exact‑prefix name lookups. `code_find` promises fuzzy names. **[measured]** `node:sqlite` supports FTS5 with the trigram tokenizer, so fuzzy search is available, but its index size and latency are unmeasured. Name‑matched references to common names (`get`, `init`, `render`) create very high fan‑out that random data never shows.
*Fix:* benchmark on gsd‑pi and gsd‑core with FTS5 and real reference distributions before freezing the budgets.

**ST‑2 (Major) — Refusing synced folders strands common setups.** Many developers keep repos in `~/Documents` or `~/Desktop`, which macOS often syncs to iCloud. A17 says refuse; the store location (A4) is inside `.git`, which is inside the synced folder.
*Fix:* detect it and fall back to the cache location automatically, with one notice. Never refuse.

**ST‑3 (Minor) — Schema change means rebuild everything.** Fine for one repo; with the multi‑repo host, one upgrade triggers a rebuild of every repo at once.
*Fix:* rebuild lazily per repo on first use, lowest priority, and serve stale‑but‑valid facts marked as such until done.

**ST‑4 (Minor) — `node:sqlite` stability.** Node 24 stopped warning, but the module's stability level and API can still change in minor releases.
*Fix:* pin the driver interface tests to each supported Node minor in CI; keep `better-sqlite3` working, not just listed.

---

## 4. Language modules and launch modules

**LM‑1 (Major) — Grammar drift is already real.** **[measured]** The tree‑sitter TypeScript grammar from `tree-sitter-wasms` 0.1.13 produced parse errors in 8 of 285 gsd‑core files and 36 of 3,982 gsd‑pi files. Examples in gsd‑core: regex literals containing `<!--` (`/<!--[\s\S]*?-->/g`) and `import('./x.cjs').Type` type queries. Those files lose definitions after the error point.
*Fix:* build grammars from upstream at pinned versions (not a third‑party WASM bundle); add a per‑module parse‑error budget in CI on the reference corpora; record partial‑parse files in `status` and fall back to the precise tier for them.

**LM‑2 (Major) — Swift's headline quality isn't specified.** On Linux with no build, Swift references are name‑matched only, and Swift has overloads, extensions, protocol witnesses and implicit members. Acceptance criterion 5 checks that definitions and references *exist*, not that they're right. The only precise path needs a Mac, a build and a community SCIP indexer with 0–1 stars.
*Fix:* set a precision/recall target for Swift grammar‑tier references on a reference app; spike a small first‑party Swift helper over IndexStoreDB on macOS instead of depending on a community indexer.

**LM‑3 (Major) — A TypeScript compiler per worktree doesn't share memory.** A25 says compiler services are shared per base commit "with each worktree's dirty files as an overlay". The TypeScript compiler builds one program per file set; a program with different dirty files is a different program. **[measured earlier]** one gsd‑core program is 357 MB. Fifty worktrees with dirty files can't share one.
*Fix:* state honestly that the precise tier runs for a bounded number of worktrees (most recent first) under the budget, and other worktrees get grammar facts plus precise facts from their base commit. Spike TypeScript 7's native server, which may be cheaper.

**LM‑4 (Minor) — Parse throughput.** **[measured]** tree‑sitter parsed 304 TypeScript files/s single‑threaded on gsd‑pi (44 MB, 13.1 s, parse only). A full gsd‑pi grammar build is fine with a parser pool; the budget table has no grammar‑tier build target.
*Fix:* add one (gsd‑pi grammar tier ≤ 15 s on a laptop with the parser pool).

**LM‑5 (Minor) — Generated and vendored code.** gsd‑pi has a 2,381‑file extension tree under `src/resources` and committed `.db` files. Nothing says how atlas decides what is source.
*Fix:* index `git ls-files` plus untracked‑not‑ignored only; honour `linguist-generated` and `linguist-vendored` attributes; per‑repo excludes in user config.

---

## 5. SDK facts

**SDK‑1 (Blocker) — The headline feature is off by default.** Apple SDK extraction runs `swift symbolgraph-extract`, which A9 treats as an external command, off unless allowed. Out of the box, `platform_card` can't do what the pitch promises.
*Fix:* distinguish built‑in first‑party providers (shipped with atlas, fixed commands, allowed by default, user can turn off) from module‑supplied commands (always opt‑in, user‑level config only; see S‑1).

**SDK‑2 (Major) — SDK id `ios-27.0` is too coarse.** Xcode betas and releases share a version; symbol graphs differ between device, simulator, Mac Catalyst and architecture.
*Fix:* id = platform + SDK version + SDK build (e.g. `ios-27.0-27A266a`) + variant.

**SDK‑3 (Major) — Package facts keyed by version leak and collide.** `pkg.db` keys by ecosystem + name + version, shared across repos (A39). Private or scoped packages from a client repo would then be visible to other repos' agents, breaking A42 isolation. Patched packages (patch‑package, git dependencies, workspace packages) share a version string but not content.
*Fix:* key by the lockfile integrity hash; share across repos only packages from a public registry; keep private, git, workspace and patched packages in the repo's own store.

**SDK‑4 (Minor) — Doc comments from packages are untrusted text.** See S‑3.

---

## 6. Lifecycle

**L‑1 (Blocker) — The grace rule never collects uncommitted content.** A20 keeps a retired version until "24 hours have passed **and** its content exists as a git object". Overwritten uncommitted content never becomes a git object, so it is never collected, which is exactly the churn case the store must survive.
*Fix:* collect when (content exists as a git object) **or** (grace has expired). Committed versions can go right away (git has them); uncommitted ones wait 24 hours.

**L‑2 (Major) — History replay cost is understated.** `history --at <commit>` re‑indexes "the requested files" from git. Grammar facts for one file are cheap; resolved references at that commit need the whole project at that commit (F‑1), and a TypeScript program over gsd‑core took 5.4 s.
*Fix:* define history answers as grammar‑tier by default, precise on request with a stated cost; keep the ≤ 2 s budget for grammar only.

**L‑3 (Minor) — Submodules and nested repos.** A submodule has its own git common dir, so A43 makes it a separate tenant and A42 isolates it from its parent. The parent repo's agents then can't see code they import from the submodule.
*Fix:* treat submodules of a repo as part of its workspace automatically.

**L‑4 (Minor) — Repo id includes the path, but the store lives in `.git`.** Moving the repo moves its store, yet the id changes, so the host treats it as new.
*Fix:* id = root commit + a random id written into the store on first index; path is only a lookup key.

---

## 7. Host, scale and multi‑repo

**H‑1 (Blocker) — Version skew between repos and one host.** Each repo can pin a different gsd‑atlas version (devDependency, `npx`), but there is one host per user. Which version runs? A repo pinned to an older module set, schema or tool contract would get answers from a newer host, or the reverse.
*Fix:* the host speaks a versioned protocol; the client checks compatibility on connect; one host per major version (`~/.cache/gsd-atlas/host-<major>`); stores carry their schema version, and an older host refuses newer stores with a clear message.

**H‑2 (Major) — "Constant cost, no extra processes" is true only for HTTP hosts.** Per‑agent costs that remain:
- the stdio shim (one process per agent for stdio‑only clients);
- the command‑hook forwarder (one process per tool call on hosts without HTTP hooks);
- MCP Streamable HTTP sessions, which are stateful per client;
- the session ledger.

The 0.04 MB‑per‑connection figure came from a JSON‑lines prototype, not the MCP SDK.
*Fix:* restate A23 as "small, bounded cost per agent; zero extra processes on hosts with HTTP MCP and HTTP hooks"; re‑measure with the real MCP SDK over HTTP.

**H‑3 (Major) — The hook transport needs a known address.** Claude Code HTTP hooks are configured with a URL and headers in settings. A host that picks a random port at start can't be written into static settings, and the token must be readable by the hook config.
*Fix:* a fixed per‑user port (configurable) or a Unix socket where the host supports it; the plugin's hook config reads the token through an allowed environment variable or a file path.

**H‑4 (Major) — One host is one point of failure for every repo and session.** A crash or a hung writer thread takes atlas away from every agent on the machine. Hooks fail open, so work continues, but silently without atlas.
*Fix:* a supervisor that restarts the host; per‑tenant watchdogs so one stuck repo is unloaded instead of hanging the host; `status` and the SessionStart brief say when atlas is down.

**H‑5 (Minor) — Fairness under a 500‑agent swarm is a target with no mechanism detail.** "≤ 2× idle p99" needs per‑tenant queues with weighted round‑robin and a per‑tenant concurrency cap, not just priority classes.
*Fix:* specify the scheduler in the host ADR.

**H‑6 (Minor) — Linux file‑watch limits.** inotify watch limits can be exhausted by ten repos with many worktrees. macOS FSEvents doesn't have this problem; Windows has its own.
*Fix:* watch only tracked directories; fall back to Reconcile polling when watches run out, and say so in `status`.

---

## 8. MCP, skill and hooks

**M‑1 (Blocker) — Strict mode can deny greps atlas can't answer.** Atlas doesn't index string literals, comments, logs, config values or non‑code files. R1 in strict mode denies a grep when the pattern "looks like a symbol". A search for an error message or a config key that happens to look like an identifier would be refused with an atlas answer that's wrong or empty.
*Fix:* R1 may deny only when atlas has an exact, complete answer for that query (a definition or reference match on an indexed symbol). Everything else is allowed, with any atlas answer attached as context.

**M‑2 (Major) — The edit gate is noisy on whole‑file writes.** A `Write` replaces a whole file, touching every symbol in it; R2 would demand context for all of them.
*Fix:* gate only symbols whose signature or removal changes callers (compare before/after definitions), and only above a caller threshold.

**M‑3 (Major) — Gates depend on host‑specific ids.** The ledger needs `session_id` and `agent_id`. Claude Code provides them; other hosts may not.
*Fix:* without ids, gates run in advise mode only; document this per host.

**M‑4 (Minor) — Ranking under the 2,000‑token budget is the product.** Truncated answers must lead with what matters, but there is no ranking spec (callers by confidence? by proximity? by recency of change?).
*Fix:* define ranking per tool in the MCP contract ADR, and evaluate it.

**M‑5 (Minor) — `code_impact` on name‑matched edges explodes.** Transitive callers through `INFERRED` edges to common names will return most of the repo.
*Fix:* transitive expansion follows `EXTRACTED` edges only by default; `INFERRED` hops are shown but not expanded.

---

## 9. Security and trust (missing as a section)

**S‑1 (Blocker) — Repo config can enable code execution.** `languages.allow_commands`, per‑module allow‑lists and `.gsd-atlas/languages/` modules with `precise.command` can all live in the repo. Cloning a hostile repo and letting atlas index it would run its commands.
*Fix:* command permission comes only from user‑level config (`~/.config/gsd-atlas/`), never from the repo. Repo modules may ship grammars and queries (sandboxed data) but their commands need an explicit user approval per repo and per command.

**S‑2 (Blocker) — Localhost HTTP is reachable from web pages.** A malicious page can send requests to `127.0.0.1` (DNS rebinding, or simple POSTs). The token helps only if every endpoint, including hooks and health, requires it.
*Fix:* require the token on every route; validate `Host` and `Origin`; reject browser‑style requests; prefer a Unix socket where the client supports it.

**S‑3 (Blocker) — Repo and package text goes straight into agent context.** `code_context`, ADR text, doc comments from `node_modules` and SDK prose are returned to agents and injected by hooks as context. Any of them can carry prompt‑injection text. gsd‑core already ships a read‑injection scanner hook for this reason.
*Fix:* fence all repo‑ and package‑derived prose in responses (marked untrusted data), cap its length, and never put it into hook `additionalContext` unfenced; reuse gsd‑core's injection scanner patterns.

**S‑4 (Minor) — Secret redaction scope.** "No source text" helps, but doc comments, ADR excerpts and identifier names can still carry secrets.
*Fix:* apply gsd‑graph's redaction to every stored prose field.

---

## 10. Evidence and evaluation

**E‑1 (Major) — Several headline numbers are from simplified setups.**
- 1M‑LOC store: synthetic random references.
- 1,000‑agent test: JSON‑lines over a Unix socket, not MCP over HTTP, with a 2‑core container shared with the load generator.
- Multi‑repo memory: stores of 30,000 symbols, no compilers.
- None ran on macOS, which is where the Apple features live.

They show the architecture isn't a dead end; they don't prove the budgets.
*Fix:* label them "prototype evidence" in the ADRs (done for most), and make the M1 gate a re‑run on real corpora with the MCP SDK on a Mac and on Linux.

**E‑2 (Major) — The answer‑quality eval is too small to decide anything.** 20 questions per repo, one run, against a model that varies run to run, can't show "beats grep" with any confidence.
*Fix:* at least 50 questions per corpus written before the build starts, 3+ runs per configuration, report intervals; include questions atlas should abstain on.

**E‑3 (Minor) — No tests for wrong answers.** Every criterion checks presence or speed; none checks that atlas never returns a confidently wrong reference.
*Fix:* a precision gate: sampled `EXTRACTED` edges hand‑verified at ≥ 98 % on each corpus.

---

## 11. Operations

**O‑1 (Major) — Windows is barely addressed.** gsd‑core's Windows CI is already a known pain point. Open questions: path case‑insensitivity, CRLF and spans, Unix socket availability, file watching, the store under `.git` with antivirus scanning, and the command‑hook forwarder without `curl`.
*Fix:* decide whether Windows is a 1.0 platform; if yes, add Windows to every budget's CI run from M1.

**O‑2 (Minor) — No way to ask "why did atlas say that?"** When an answer is wrong, a user needs the provenance chain: extractor, tier, grammar version, resolution context.
*Fix:* `gsd-atlas explain <fact id>` and a `debug` field on every citation.

**O‑3 (Minor) — Install and upgrade story is missing.** How the host gets installed (global npm, per repo, plugin), how plugins register hooks and MCP for each host, and how an upgrade replaces a running host.
*Fix:* an install/upgrade section in the PRD; ties to H‑1.

---

## What to change before the MVP

| # | Change | Docs affected |
|---|--------|---------------|
| 1 | Split local facts (by blob id) from resolved edges (by overlay and resolution context) | Fact‑model and worktree‑lifecycle ADRs, DESIGN A2/A5/A19/A20 |
| 2 | Stable symbol identity independent of content hash | Fact‑model ADR |
| 3 | Fix the collect rule: in git **or** grace expired | Worktree‑lifecycle ADR, DESIGN A20 |
| 4 | Command permission only from user‑level config; built‑in providers on by default | Language‑modules ADR, DESIGN A9, SDK‑PROVIDERS |
| 5 | Token on every route, Host/Origin checks, Unix socket preferred | Host ADR, DESIGN A27 |
| 6 | Fence untrusted prose in responses and hook context | MCP‑contract ADR, AGENT‑INTEGRATION |
| 7 | Versioned host protocol, one host per major version | Host ADR |
| 8 | Strict search gate only on exact, complete atlas answers | AGENT‑INTEGRATION |
| 9 | Narrow M1: one tenant, stdio, no queues; harden later | PRD roadmap |
| 10 | Grammars built from pinned upstream, with a parse‑error budget on the reference corpora | Language‑modules ADR |

Items 1–8 change ADRs that are still Proposed, which is the cheapest moment to change them.

---

## Resolution (2026‑10‑15)

All findings were addressed in the design before any code, per the goal of designing up front. The MVP is defined as **working with gsd‑core development**.

| Finding | Resolution | Where |
|---------|------------|-------|
| F‑1 | Two layers: local facts by content hash; resolved edges by overlay snapshot + resolution context, computed lazily and cached | DESIGN A2, A5; fact‑model and worktree‑lifecycle ADRs |
| F‑2 | Stable symbol identity (repo, path, qualified name, kind, discriminator); content hash is the version | DESIGN A45; fact‑model ADR |
| F‑3 | Hash with git's clean filters, record line endings, skip LFS pointers | DESIGN A19; fact‑model ADR |
| F‑4, F‑5 | Added `tested_by`, `reexports`, `extension_of`; test globs in module manifests | PRD §4.7; fact‑model ADR |
| F‑6 | ADR ids resolved against the ADR directory; ambiguous ids → all candidates, `INFERRED` | Fact‑model ADR; PRD §4.7 |
| ST‑1 | FTS5 trigram for fuzzy names; budgets gated on real corpora with the MCP SDK | DESIGN A50, budgets; SQLite‑store ADR |
| ST‑2 | Synced or network paths move the store to the cache location, never refuse | DESIGN A4, A17; SQLite‑store ADR |
| ST‑3 | Lazy per‑repo rebuild at low priority, serving still‑valid facts marked stale | DESIGN A17; SQLite‑store ADR |
| ST‑4 | Driver tested per Node minor; `better-sqlite3` kept working | DESIGN A13; SQLite‑store ADR |
| LM‑1 | Grammars built from pinned upstream; parse‑error budget ≤ 0.5 % in CI | DESIGN A48; language‑modules ADR |
| LM‑2 | Swift precision target ≥ 85 %; first‑party IndexStoreDB helper spike | PRD §6, criteria 5; language‑modules ADR |
| LM‑3 | Precise resolution bounded to active overlays; others flagged `degraded` | DESIGN A25; language‑modules and MCP‑contract ADRs |
| LM‑4 | Grammar‑tier build budget (gsd‑pi ≤ 15 s) | DESIGN budgets |
| LM‑5 | Source = `git ls-files` + untracked non‑ignored; linguist attributes honoured | DESIGN A47; language‑modules ADR |
| SDK‑1 | Built‑in first‑party providers on by default | DESIGN A9; trust‑boundaries ADR; PRD §7.2 |
| SDK‑2 | SDK id includes build and variant | DESIGN A10; PRD §7.2; SDK‑PROVIDERS |
| SDK‑3 | Packages keyed by integrity hash; only public‑registry packages shared | DESIGN A39; host ADR; SDK‑PROVIDERS |
| SDK‑4, S‑3, S‑4 | Untrusted prose fenced, capped, redacted, scanned | DESIGN A44; trust‑boundaries and MCP‑contract ADRs |
| L‑1 | Collect when in git **or** grace expired | DESIGN A20; worktree‑lifecycle ADR |
| L‑2 | History is local facts by default; resolved edges only with `--precise` | DESIGN lifecycle; worktree‑lifecycle ADR |
| L‑3 | Submodules join the parent's workspace automatically | DESIGN A43; worktree‑lifecycle ADR |
| L‑4 | Repo id = root commit + random store id; path only a lookup key | DESIGN A43; host ADR |
| H‑1 | Versioned protocol; one host per major version; store schema checks | DESIGN A46; host ADR; PRD criterion 18 |
| H‑2 | Per‑agent cost restated honestly; MCP SDK re‑measurement at M2.5 | DESIGN A23; host ADR |
| H‑3 | Fixed per‑user address (socket, pipe or port); token via allowed env var | DESIGN A27; AGENT‑INTEGRATION |
| H‑4 | Supervisor, per‑tenant watchdogs, degraded status in SessionStart brief | DESIGN A22; host ADR |
| H‑5 | Weighted round‑robin per tenant with a concurrency cap | DESIGN A49; host ADR |
| H‑6 | Watch tracked dirs only; poll via Reconcile when watches run out | Worktree‑lifecycle ADR |
| M‑1 | Strict search denial only on exact, complete atlas answers | DESIGN A34; AGENT‑INTEGRATION; PRD §8.3 |
| M‑2 | Edit gate on signature change or removal above a caller threshold | AGENT‑INTEGRATION; PRD §8.3 |
| M‑3 | No session/agent ids → advise mode only | AGENT‑INTEGRATION; PRD §8.3 |
| M‑4 | Ranking specified per tool | MCP‑contract ADR |
| M‑5 | Impact expands `EXTRACTED` edges only by default | MCP‑contract ADR |
| S‑1 | Permissions only from user‑level config | DESIGN A9, A44; trust‑boundaries ADR; PRD criterion 17 |
| S‑2 | Socket/pipe preferred; token on every route; Host/Origin checks | DESIGN A27; trust‑boundaries and host ADRs |
| E‑1 | Benchmarks labelled prototype; gates on real corpora, MCP SDK, three OSes | DESIGN A50 |
| E‑2 | ≥ 50 questions per corpus, ≥ 3 runs, intervals, abstain cases | DESIGN A50; PRD §2 |
| E‑3 | Precision gate ≥ 98 % on sampled `EXTRACTED` edges | DESIGN A50, budgets; PRD criterion 1 |
| O‑1 | macOS, Linux and Windows are 1.0 platforms, in CI from M0 | DESIGN A13; product‑boundary ADR; PRD criterion 19 |
| O‑2 | `explain` tool and `debug` handles | DESIGN A51; MCP‑contract ADR |
| O‑3 | Install and upgrade section | PRD §11.1 |
| P‑1 | Alternatives section added; evaluation to run before 1.0 | PRD §1.1; product‑boundary ADR |
| P‑2 | MVP narrowed to gsd‑core development: single tenant, stdio; hardening moved to M2.5 | PRD §1, §14; product‑boundary ADR |
| P‑3 | User‑controlled diagnostics: off by default, approved per data type with a full explanation of each, submitted as GitHub issues with ↑ ↔ ↓ ratings and automatic repo intake | DESIGN A52; DIAGNOSTICS.md; user‑controlled‑diagnostics ADR |

**Still open (needs work, not design):** the free‑alternatives evaluation (P‑1), the Swift IndexStoreDB helper spike (LM‑2), and re‑running the benchmarks on real corpora with the MCP SDK (E‑1).
