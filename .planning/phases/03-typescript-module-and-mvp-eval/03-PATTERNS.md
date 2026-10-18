# Phase 3: TypeScript Module and MVP Eval - Pattern Map

**Mapped:** 2026-10-17
**Files analyzed:** 22 (new or modified groups)
**Analogs found:** 19 / 22
All analog paths below are git-tracked (checked via `git ls-files`). `skills/` does not exist yet.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/precise-resolver/typescript/worker.ts` | worker (child process) | request-response over stdin/stdout JSON lines | `src/grammar-engine/pool/worker.ts` (1-77) | role-match (thread vs process) |
| `src/precise-resolver/typescript/protocol.ts` | protocol types (zod both ends) | request-response | `src/grammar-engine/pool/protocol.ts` (1-35) | role-match |
| `src/precise-resolver/typescript/client.ts` | service (supervisor) | streaming | `src/grammar-engine/pool/pool.ts` (load timeout, terminate grace) + `src/command-runner/real.ts:123-141,295-299` | role-match |
| worker URL helper | utility | file-I/O | `src/grammar-engine/pool/worker-url.ts` (1-10, `resolveWorkerUrl`) | exact (copy) |
| `src/precise-resolver/typescript/identity.ts` | utility | transform | `src/precise-resolver/index.ts` (interface 1-38), `src/facts/resolution.ts:40-50` | role-match |
| `src/command-runner/decide.ts` builtin + spec helper | middleware (gate) | request-response | `decide.ts:227-263` (`BUILTINS`, git matcher), `git-spec.ts`; tests `git-allowlist.test.ts` | exact |
| `src/project-model/*` | service | file-I/O, transform | `src/lang/manifest.ts:71-76` (`project.model`), `src/source-tree/read-text.ts`, `src/fact-store/specifier.ts:82-104` | partial |
| `src/fact-store/*` (relations, cites, per-overlay context) | model/store | CRUD | `src/fact-store/schema.ts:150-166`, `resolve.ts`, `parts.ts:38` | exact (additive) |
| `src/facts/degraded.ts`, `file-facts.ts` additions | model | n/a | same files, `degraded.ts:11-23`, `file-facts.ts:10-27,39` | exact |
| `src/query/*` (`code_explain`, relation-aware refs/impact) | controller | request-response | `src/query/refs.ts`, `src/query/impact.ts`, `src/query/tools.ts:12` | exact |
| `src/mcp-shim/server.ts` (seventh tool) | controller | request-response | existing six tool registrations in same file | exact |
| `src/cli/tool-commands.ts` (`explain`, `rate`, `allow`, `bug`) | route/adapter | request-response | same file `FLAGS` 21-41, `buildRequest` use | exact |
| `src/host/config.ts` (sha256 on allow entries) + writer | config | file-I/O | `config.ts:51-66` strict zod `permissions.allow` | exact |
| `src/metrics/migrations.ts`, `types.ts` (ratings, `TOOL_NAMES`) | migration/model | CRUD | `src/metrics/migrations.ts` (76 lines), `types.ts:13-20` | exact |
| Host recorder (capped ring file) | service | event-driven append | `src/host/history.ts` | role-match |
| `modules/typescript/atlas-lang.json` + `queries/tags.scm` (`comment` capture, `adrDirs`), `schemas/` | config | transform | `modules/typescript/*`, `src/lang/manifest.ts:43-84` | exact |
| `scripts/eval/oracle.ts` (no atlas imports) | utility/script | batch | `scripts/recall-oracle.ts`, `scripts/recall.ts` (idea only; strip `../src` imports) | role-match |
| `scripts/eval/harness.ts`, `stats.ts` | script | batch | `scripts/corpus-gates.ts`, `scripts/freshness-gate.ts` (parseArgs, exit codes) | partial |
| TSM-06 gate script (build/update/warm) | script | batch | `scripts/freshness-gate.ts` (1-45) | exact |
| `.github/workflows/ci.yml` gates job + `nightly.yml` | config | batch | same files; `scripts/ci-config.test.ts` | exact |
| `skills/gsd-atlas*/SKILL.md`, `docs/eval/*` | docs | n/a | none | no analog |
| Tests: SEC-01 hostile config, worker, ProjectModel differential | test | n/a | `src/command-runner/hostile-repo.test.ts`, `grammar-engine/pool/pool.test.ts` + `pool/__fixtures__/*-worker.ts` | exact |

## Pattern Assignments

### Precise worker (`src/precise-resolver/typescript/worker.ts`)
**Analog:** `src/grammar-engine/pool/worker.ts`.
- Fail fast when run in the wrong context (lines 13-16), build the engine once, and keep a startup error to answer every request with a coded error rather than die (20-28).
- Each request answered exactly once through one `handle` that maps errors to `{type:'error', id, code, message}` (32-38, 68-70). Copy this shape; replace `port.on('message')` (73-77) with line-split stdin reading, and exit on stdin end (research Pattern 1: no orphan).
- Messages: copy the discriminated-union style of `pool/protocol.ts:16-34` (`readonly` fields, one reply per `id`), but validate with zod on both ends (research sketch: `init`, `resolve`, `update`, `relations`, `ping`; replies `edge`, `done`, `error`, `ready`).
- Test fixtures for hang/spin/silent workers: `pool/__fixtures__/{spin,silent,echo-start}-worker.ts`; reuse for kill and timeout tests.
- `resolveWorkerUrl(moduleUrl)` in `pool/worker-url.ts` is the one helper for `.ts` vs `.js` layouts; reuse, do not duplicate.

### CommandRunner builtin (`src/command-runner/decide.ts`)
- `BUILTINS = [{ id: 'git', match: matchGit }]` at decide.ts:227-228; user allow compare in `userAllows` 245-253. `decide.ts` cannot import other modules: inject the exact builtin shape table from the composition root (`src/bin/compose.ts:88` builds the runner). Exact shape: executable `process.execPath`, args exactly `['--max-old-space-size=<digits>', '<worker path>']`, fixed env keys.
- `stream()` with `stdin: AsyncIterable` already works (`real.ts:123-141` `feedStdin`, 295-299 returns `{stdout, result, kill}`). `maxStdoutBytes` is cumulative (real.ts:246-262): set it per spec.
- Add a rejected-deviation decide test per case, modelled on `git-allowlist.test.ts`.

### SEC-01 test (hostile committed config)
**Analog:** `src/command-runner/hostile-repo.test.ts:1-40`: `createTempGitRepo`, `createRecordingRunner`, assert the recorder saw no start except built-ins. Header comment style (criterion plus ADR decision) is the project convention.

### Command approval `allow` (`src/host/config.ts` + CLI)
```ts
// src/host/config.ts:55-65
permissions: z.strictObject({
  allow: z.array(z.strictObject({
    repo: absolutePath,
    executable: z.string().min(1),
    argsPrefix: z.array(z.string()).optional(),
  })),
}).optional(),
```
Add `sha256: z.string().optional()`; `decide` must require match when present. The loader ignores the whole file on any error (config.ts:105-133), so re-validate the full file after writing (temp file plus rename, mode 0600, under the 64 KiB cap). The CLI adapter imports only host-client; the write is a Host request kind.

### CLI commands (`explain`, `rate`, `allow`, `bug`)
**Analog:** `src/cli/tool-commands.ts`. Imports only `../host-client/index.ts` and `node:path` (adapter rule, lines 10-15). Add new names to the `FLAGS` table once (21-41) and list per command. `explain` is a tool command (same zod schema as MCP via `buildRequest`); `rate`/`allow`/`bug` are index-style commands with Host-own request kinds. Output contract: one JSON envelope on stdout, reasons on stderr, exit codes 0/1/2/3 (`src/cli/exit.ts`, `docs/reference/cli.md`).

### Seventh tool `code_explain`
Touch together: `src/query/tools.ts:12` `TOOL_NAMES`, `src/metrics/types.ts:13-20` (duplicate list), `src/mcp-shim/server.ts` registration, MCP instructions text, the "exactly six tools" tests, ADR 13 amendment (research Pattern 7). Handle formats `sym/<enc path>/<hash>/<ord>`, `ref/...` come from `fact-store/snapshot.ts` and `resolve.ts:388`.

### Fact Store additions
Additive columns/tables in `src/fact-store/schema.ts` (`resolved_edges` at 150-166; bump `SCHEMA_VERSION` line 4). `Resolver` port is at `fact-store/types.ts:375-379`; context fn at `parts.ts:38`, default at `open.ts:396`. Edge validation: `resolve.ts` `validate` drops edges whose target `findSymbol` lacks. Extend `SymbolLookup` (`facts/resolution.ts:48-50`) with `findIn(path, name)` returning span.

### Two-tier gate script (TSM-06)
**Analog:** `scripts/freshness-gate.ts:1-45`. Copy: header doc (what, clock start/stop, percentile rule), `parseArgs` flags, exported constants `*_PR_CEILING_MS` and `*_NIGHTLY_*_MS` named after the approved 03-CONSTANTS keys, `composeHost` from `../src/bin/compose.ts`, exit 1 on breach. Wire in `ci.yml` (gates job, loose) and `nightly.yml` (strict); `scripts/ci-config.test.ts` asserts the workflow text, update it. A looser ceiling needs user approval (Phase 2 rule in `02-CONSTANTS.md`).

### Eval oracle (`scripts/eval/oracle.ts`)
**Analog:** `scripts/recall-oracle.ts` (compiler as oracle). Constraint: must NOT import from `src/` (freshness-gate imports `../src/...`, so do not copy that part). Use `ts.getOutputFileNames` for emit paths (research Don't Hand-Roll); `typescript` is already a dev dependency.

### Metrics ratings
**Analog:** `src/metrics/migrations.ts` (add a numbered migration), `types.ts` header says no free-text fields: store `{answer_id|feature|session, value}` with `value` a closed set.

## Shared Patterns
- **Degraded, never silent:** add `memory_budget`, `compiler_fallback`, `needs_approval` to `src/facts/degraded.ts:11-23`; every fallback path sets one.
- **Module boundaries:** new `src/project-model/` must be added to `MODULES` in `eslint.config.js`; adapters import only the seam index (`host-client`, `precise-resolver/index.ts`).
- **Native type stripping rules:** `.ts` import extensions, `import type`, no enums/namespaces/parameter properties.
- **Strict zod objects** for config, manifest and protocol (`host/config.ts:51`, `lang/manifest.ts`). Manifest change requires `npm run schema:build` and the Ajv parity test.
- **Tests:** `node:test` + `node:assert/strict`, colocated `*.test.ts`; Windows: close handles before temp deletion, use `realpath.native`.

## No Analog Found
| File | Reason |
|---|---|
| `skills/gsd-atlas/SKILL.md`, `skills/gsd-atlas-module-author/SKILL.md` | no `skills/` directory exists; follow `docs/AGENT-INTEGRATION.md` |
| `docs/eval/{free-alternatives,preregistration}.md` | no prior eval docs; use RESEARCH.md Eval Design A-F |
| `scripts/eval/stats.ts` (cluster bootstrap) | none; RESEARCH.md Code Examples 474-499 (seeded mulberry32) |
| `src/project-model/` tsconfig/emit-map logic | only `specifier.ts` partial; use RESEARCH Pattern 3/4 and a differential test vs `ts.parseJsonConfigFileContent` |

## Metadata
**Analog search scope:** `src/`, `scripts/`, `modules/`, `.github/`
**Files scanned:** ~170 tracked; 8 read. Some excerpts rely on RESEARCH.md verified line refs rather than re-reading (a MEMTRACE guard blocked direct Read; used `codegraph node`).
**Date:** 2026-10-17
