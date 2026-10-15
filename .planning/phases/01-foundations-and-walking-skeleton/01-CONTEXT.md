# Phase 1: Foundations and Walking Skeleton - Context

**Gathered:** 2026-10-15
**Status:** Ready for planning

<domain>
## Phase Boundary

A developer can build and test the repo on macOS, Linux and Windows and run `gsd-atlas lang test` on a fixture language module end to end, with every module seam (Fact Store, Source Tree, CommandRunner, Grammar Engine, PreciseResolver, Governor) frozen behind an interface and a test double or conformance suite. Also: boundary lint from day one, reproducible grammar WASM, a pinned corpus manifest, and the 8 Phase 1 ADRs ratified with the five research-gap amendments.

Requirements: FND-01..FND-11, LNG-01, LNG-06. No indexing, watching, queries, MCP tools or real fact tables in this phase (Phase 2).

</domain>

<decisions>
## Implementation Decisions

### Fixture module and `lang test`
- **D-01:** The fixture module uses a **tiny purpose-built toy grammar** that we own, not a real upstream grammar. It is deterministic, builds fast on all 3 OSes, and has no upstream licence or ERROR noise. Phase 2's "second, non-TypeScript fixture language" Grammar Engine test (Success Criterion 2.1) should reuse it. Real grammars (TypeScript, JS, Python, Swift) arrive in later phases.
- **D-02:** `gsd-atlas lang test` validates the manifest, loads the WASM, compiles and runs the queries over fixture files, and **compares produced spans/captures to checked-in golden files**. Fixtures must include UTF-16 column cases (emoji), CRLF and BOM. Mismatch gives a non-zero exit and a diagnostic. The parse-quality number is **not** part of `lang test` output in Phase 1; it is measured by the CI budget job (see D-06).
- **D-03:** Source resolution (repo > user > npm > built-in) is proven by a test harness that **places the same fixture module in all 4 locations on disk** and asserts precedence, that `lang list` shows each module's source and active tiers (including shadowed copies), and that a module with an invalid manifest is **skipped with a diagnostic, never a crash**.

### Manifest schema
- **D-04:** The manifest Zod schema is **complete for v1 and versioned**: `name`, `schemaVersion`, `extensions`, `grammar` (wasm file + `grammar.lock` ref), `queries`, `tiers`, `parseBudget`, optional `precise` (command). Unknown fields are rejected. Changes after Phase 1 require a `schemaVersion` bump. — **Reversibility:** costly — third-party and user modules (Phase 9 bring-your-own proof) will depend on the shape.
- **D-05:** The JSON Schema generated via `z.toJSONSchema(schema, {target: 'draft-2020-12'})` is **committed under `schemas/`**; CI regenerates and fails on drift. An Ajv (2020) dev-only conformance test asserts the Zod parser and the JSON Schema accept/reject the same manifest fixtures.

### Grammar build and parse budget
- **D-06:** Parse quality = **bytes inside ERROR nodes**, declared **per module in the manifest** (`parseBudget`, default 0.5% of source bytes per STACK A48). A CI job measures over the module's fixtures and fails when exceeded. Swift later declares its own measured number (Phase 5) rather than an exception to a global threshold.
- **D-07:** **Built grammar WASM is committed** next to the module, with its sha256 pinned. A CI job on **all three OSes** rebuilds from pinned source with the pinned `tree-sitter-cli` (0.27.1, must equal `web-tree-sitter` 0.27.1) and fails if the hash differs. Installs and normal tests never need wasi-sdk. Cache `~/.cache/tree-sitter` only in the grammar job.
- **D-08:** Grammar pins live in a **per-module `grammar.lock`** inside the module folder: upstream source URL, pinned tag/commit, patch list, licence id, expected wasm sha256. One shared build script reads it. This keeps modules self-describing ("languages are data") so user/npm modules can use the same mechanism.

### Seam interfaces, doubles and conformance
- **D-09:** **Fact Store:** ship the frozen TypeScript interface, a thin **driver layer over `node:sqlite` and `better-sqlite3`** (supplying what `node:sqlite` lacks: pragma helper, transactions via `BEGIN IMMEDIATE`/`SAVEPOINT`, null-prototype row normalisation, bigint handling), and the **driver conformance suite green on both drivers in 3-OS CI**. **No fake FactStore** (per fact-store-interface ADR); tests use real SQLite in a temp dir with a fake clock and fake `gitHas`. Fact tables, writer lease and maintenance are Phase 2 (STO-*). — **Reversibility:** costly — the interface is the external seam every later module codes against.
- **D-10:** **Other seams** (Source Tree, Grammar Engine, PreciseResolver, Governor): each gets a frozen interface, a fake, and **one shared contract test file run against both the fake and the real implementation where one exists**, so fakes cannot drift. The Grammar Engine is real in Phase 1 (it powers `lang test`); PreciseResolver and Governor are fake/no-op only. CommandRunner gets the recording fake required by its ADR.
- **D-11:** **CommandRunner full surface now:** `CommandSpec` as an argv array (never a shell), timeout and kill, streaming stdout, **batched stdin** (one `git hash-object --stdin-paths` over a whole snapshot), output caps, and real-executable resolution on Windows (no `.cmd`/`.bat` spawns, no npm shims). The hostile-repo test uses the recording fake to assert zero starts outside the runner, and exercises real `git` only through the runner. — **Reversibility:** costly — every child-process call site in later phases depends on the spec shape.

### Lint, CI and layout
- **D-12:** Boundary rules are enforced with **ESLint only** (`no-restricted-imports`/`no-restricted-syntax` plus import path patterns in `eslint.config`). Rules: `child_process` only in the CommandRunner; `sqlite/` only for the Fact Store, Metrics and SDK stores; cross-module imports only via `index.ts`; Policy imports only `facts/`; adapters import only `HostClient`. A **fixture test per rule** proves a deliberate violation fails lint. No dependency-cruiser.
- **D-13:** CI matrix: **ubuntu, macos, windows x Node 24.15.0 (floor) + Node 26 latest.** Lint and typecheck run once on Linux. The grammar rebuild-hash job runs on all 3 OSes. The `xcode-27` lane is deferred to Phase 6. Actions pinned to commit SHAs with a version comment (as gsd-core does).
- **D-14:** Layout: **`src/<seam>/index.ts`** per seam (`fact-store`, `source-tree`, `command-runner`, `grammar-engine`, `precise-resolver`, `governor`), exporting only through `index.ts`; `src/cli` and `src/mcp-shim` as adapters; **`modules/<lang>/`** for language modules; tests colocated as `*.test.ts`. npm scripts: `build`, `typecheck`, `lint`, `test`, `grammar:build`, `grammar:verify`. Follow STACK.md rules (native type stripping, `.ts` import extensions, `erasableSyntaxOnly`, `verbatimModuleSyntax`, tsc emit to `dist/`, no bundler).

### ADR ratification (FND-09, FND-10)
- **D-15:** The GitHub repo/remote does not exist yet. A plan task has the user create or confirm the remote, then **opens one issue per ADR with `gh`** (outward-facing: confirm with the user before each batch), renames each `draft-<slug>.md` to `<issue#>-<slug>.md`, moves Proposed to Accepted, and applies the five research-gap amendments as **dated amendment sections** (ADRs are append-only per `docs/adr/README.md`). Phase 1 ADRs: product-boundary, trust-boundaries, command-runner, language-modules, fact-model, fact-store-interface, sqlite-store, tenant-composition. Update the README table links and statuses in the same change.
- **D-16:** Amendments to apply: ProjectModel seam (language-modules); read-triggered cache write and SQLite-access wording (fact-store-interface, sqlite-store). Writer contention (worktree-lifecycle) and metrics migrations (value-dashboard) belong to Phase 2's ratification.
- **D-17:** Open questions resolved as part of ratification:
  - **Fact Store `warm()`:** no `warm(worktree)`. First-call resolver latency is bounded by `timeoutMs` and returns `degraded: ['resolver_timeout']` on overrun; the interface documents the cost.
  - **File watcher location:** inside the **Indexer** (events are its input); Source Tree only supplies git events.
  - **Governor / `ensureFresh`:** takes **one `fresh` priority slot per request**, not per call; the compiler-program LRU keys on the **file set**, not (tenant, overlay) (compiler programs are per file set, A25).

### Claude's Discretion
- Exact toy-grammar design, fixture file contents beyond the required CRLF/BOM/emoji cases, internal naming inside each seam, and CI workflow file organisation, provided D-01..D-17 hold.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project-level
- `.planning/PROJECT.md` — constraints (Node >= 24, three OSes, privacy, no host coupling) and Key Decisions
- `.planning/REQUIREMENTS.md` — FND-01..FND-11, LNG-01, LNG-06
- `.planning/ROADMAP.md` — Phase 1 goal, success criteria, ADR ratification schedule, research flags
- `.planning/STATE.md` — blockers (Windows/Linux unverified, three-OS CI is the only check)
- `.planning/research/STACK.md` — pinned versions, grammar pins, platform gotchas, packaging rules
- `.planning/research/ARCHITECTURE.md` — module/wave structure
- `.planning/research/PITFALLS.md` — cross-platform and tooling pitfalls

### Design docs
- `docs/PRD.md` — milestones M0 acceptance
- `docs/DESIGN.md` — assumptions A1..A63 referenced by ADRs
- `docs/DESIGN-REVIEW.md` — adversarial review that shaped the ADRs
- `docs/adr/README.md` — ADR naming, status vocabulary, append-only rule
- `docs/GLOSSARY.md` — project vocabulary (see also `GLOSSARY.md` at repo root)

### ADRs to ratify in this phase (`docs/adr/`)
- `docs/adr/draft-product-boundary.md`
- `docs/adr/draft-trust-boundaries.md`
- `docs/adr/draft-command-runner.md` — CommandSpec, two adapters (real + recording fake), hostile-repo test
- `docs/adr/draft-language-modules.md` — manifest, tiers, grammar build, parse budget, ProjectModel seam amendment
- `docs/adr/draft-fact-model.md`
- `docs/adr/draft-fact-store-interface.md` — no fake store; open questions resolved in D-17
- `docs/adr/draft-sqlite-store.md`
- `docs/adr/draft-tenant-composition.md` — Source Tree, Indexer, Governor; open questions resolved in D-17

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None. The repo is docs-only: `package.json`, `package-lock.json` and `node_modules/` exist but are untracked and there is no `src/`.

### Established Patterns
- No code conventions yet. STACK.md "Conventions" are the source of truth: ESM, native type stripping, `tsc` emit, `node:test` + `c8`, ESLint 10 + typescript-eslint 8.71.2 (pins TS to `~6.0.3`).
- gsd-core is the model for CI action pinning and `node --test` / `c8` usage.

### Integration Points
- New code connects to nothing existing; Phase 1 creates the seams that Phases 2+ build on. `bin` entries `gsd-atlas` and `gsd-atlas-mcp` must exist and run (mcp shim may be a stub).

</code_context>

<specifics>
## Specific Ideas

- Fixture and toy grammar should be reusable as Phase 2's second-language Grammar Engine test.
- Windows hygiene to test from Phase 1: close DB handles before deleting temp dirs (EBUSY), compare paths with `fs.realpathSync.native`, pin `.gitattributes` in fixtures for CRLF.
- Unix socket path length limits are a Phase 2/4 concern but test temp dirs should stay short.

</specifics>

<deferred>
## Deferred Ideas

- `xcode-27` CI lane: Phase 6 (SDK facts).
- Real fact tables, writer lease, maintenance, `warm()` if ever measured as needed: Phase 2+.
- Writer-contention and metrics-migration ADR amendments: Phase 2 ratification.
- Real-grammar parse budgets (TypeScript, JavaScript, Swift): Phases 2, 3 and 5.

</deferred>

---

*Phase: 1-Foundations and Walking Skeleton*
*Context gathered: 2026-10-15*
