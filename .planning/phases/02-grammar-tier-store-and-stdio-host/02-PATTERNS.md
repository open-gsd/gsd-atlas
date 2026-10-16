# Phase 2: Grammar Tier, Store and stdio Host - Pattern Map

**Mapped:** 2026-10-16
**Files analyzed:** ~45 new/modified (grouped by module)
**Analogs found:** all modules have an in-repo analog except where listed under "No Analog Found"
**Note:** All analog paths below were checked as git-tracked (`git ls-files`). Excerpts were taken via CodeGraph; line numbers are from the on-disk source. Where a file was not re-read, the entry says "read before editing".

## Cross-cutting conventions (from existing code)

- Native type stripping: relative imports end in `.ts`; `import type` for types; no enum/namespace/parameter properties. Example import block: `src/source-tree/real.ts:9-18`.
- Every module has an `index.ts` barrel; adapters import only `../host-client/index.ts` (`src/cli/index.ts:14-15`, `src/host-client/index.ts:1-17`).
- Factory functions, no classes or singletons: `createNoopGovernor()` (`src/governor/noop.ts:10`), `createSourceTree(options)` (`src/source-tree/real.ts:50`), `createInProcessHostClient(options)` (`src/host-client/in-process.ts:102`).
- Injected deps (runner, clock, gitHas, roots) instead of globals: `SourceTreeOptions` (`src/source-tree/real.ts:20-25`), `StoreDeps` (`src/fact-store/types.ts`, `OpenStore` at :294).
- Contract-suite pattern: `defineXContract(...)` in `contract.ts`, run by each implementation's test file (`src/governor/contract.ts:11`, `src/sqlite/contract.ts:250`, `src/source-tree/contract.ts`, `src/precise-resolver/contract.ts`). Real impls must pass the EXISTING contract.
- Envelope helpers: `okEnvelope(schema, data, diagnostics)` / `failEnvelope(schema, diagnostics)` / `diagnostic(code, severity, message)` from `src/facts` (`src/facts/request.ts:23-39`; use at `src/host-client/in-process.ts:88-96`).
- Lint boundaries: `eslint.config.js` `MODULES` (lines 10-28) lacks `indexer`, `query`, `tenant`, `host`; `SQLITE_OWNERS` at line 31; `.parse` confinement at lines 113-116. `child_process` only in command-runner; tests needing child processes go through CommandRunner `allowAll`.

## File Classification

| New/Modified File(s) | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/facts/{file-facts,degraded,request}.ts` (additive fields/codes) | model | transform | same files, Phase 1 shape (`file-facts.ts:35-55`, `degraded.ts:8-17`, `request.ts:23-29`) | exact |
| `src/sqlite/driver.ts` (pragma allowlist, :39-55) | utility | request-response | itself | exact |
| `src/command-runner/decide.ts` (allowlist :24-31; add `ls-tree`, `worktree list --porcelain -z`) | config/guard | request-response | itself + `decide.test.ts` | exact |
| `src/source-tree/real.ts` + `types.ts` + `fake.ts` + `contract.ts` (hashPaths, sourceSet, worktrees, listTree, readMany, readText) | service | file-I/O, batch | `createSourceTree` helpers `spec`/`gitText`/`probe` (`real.ts:55-65,173-180`) | exact |
| `src/fact-store/{schema,open,lease,writer,reader,lifecycle,location}.ts` | service/store | CRUD | `src/sqlite/open.ts:120-144` (open policy), `src/fact-store/types.ts` (frozen interface), `src/sqlite/contract.ts` | role-match |
| `src/fact-store/contract.ts` (+ test on both drivers) | test | CRUD | `src/sqlite/contract.ts` + `node-sqlite.test.ts` / `better-sqlite3.test.ts` | exact |
| `src/grammar-engine/{extract,pool/*}.ts`, `normalize.ts`/`collect` changes | service | transform, batch | existing `src/grammar-engine/*` (`normalize.ts:37` toCapture) | exact |
| `modules/{typescript,javascript}/` (manifest, lock, wasm, queries, fixtures) | config/data | transform | `test/fixtures/modules/toy/` (atlas-lang.json, grammar.lock, queries/{tags,refs,imports}.scm, fixtures/*.golden.json) | exact |
| `scripts/grammar-build.ts` (support `source.type: "upstream"` w/o `generate`) | utility | batch | itself | exact |
| `scripts/recall.ts`, size/perf gates | utility/test | batch | `scripts/grammar-budget.ts` + `grammar-budget.test.ts` | role-match |
| `scripts/adr-ratify.ts`, `adr.ts`, `adr.test.ts` (hard-coded Phase 1 slugs, "exactly 6 drafts") | utility | file-I/O | themselves | exact |
| `docs/adr/*.md` (rename drafts to `<issue#>-<slug>.md`, amendments) | doc | - | `docs/adr/7-fact-store-interface.md`, `8-sqlite-store.md` (dated amendments) | exact |
| `src/governor/real.ts` (createGovernor) | service | request-response | `src/governor/noop.ts` (shape), `fake.ts` (bounded behaviour), `contract.ts` | exact |
| `src/indexer/*` (queue, event sources, reconcile, ensure-fresh, build) | service | event-driven | `src/governor/fake.ts` for queue/timeouts; `FakeClock` in `src/test-kit/fake-clock.ts` | partial |
| `src/query/*` (tools, ranking, budget, cursor, fence, envelope, kinds/*) | service | request-response | `src/host-client/in-process.ts` switch + envelope helpers | partial |
| `src/metrics/*` | service | CRUD (own db) | `src/sqlite/open.ts` + `src/sqlite/index.ts` kit | partial |
| `src/tenant/`, `src/host/` | composition | request-response | `src/bin/gsd-atlas.ts:52-65` (composition root), `in-process.ts` | role-match |
| `src/host-client/in-process.ts`, `index.ts` | provider | request-response | itself (:102-141) | exact |
| `src/cli/index.ts` (+ commands, exit 3) | controller | request-response | itself (:17-19, :99-150) | exact |
| `src/mcp-shim/index.ts`, `src/bin/gsd-atlas-mcp.ts` (4-5 line stubs today) | controller | request-response | `src/bin/gsd-atlas.ts` + `src/cli/index.ts` | role-match |
| `src/cli/init` (HST-04) | utility | file-I/O | none good (gsd-graph flawed, see research Pattern 12) | none |
| `.github/workflows/ci.yml` (three OS, new jobs) | config | - | itself; guarded by `scripts/ci-config.test.ts` | exact |

## Pattern Assignments

### Governor real impl (`src/governor/real.ts`)
**Analog:** `src/governor/noop.ts` (whole file, 50 lines) + `src/governor/fake.ts` (257 lines, pins bounded behaviour) + `src/governor/contract.ts:11`.
Copy the surface exactly: `run<T>(job, fn(signal)) -> GovernorResult<T>` (`{kind:'ok', value}`), `lease(key, estimatedBytes, onEvict) -> LeaseResult`, `status() -> {queued, running, leases, leasedBytes}`. Reuse `assertJob`/`assertEstimatedBytes` from `./validate.ts` (noop.ts:2, 17, 28). Wire in `governor.test.ts` via `defineGovernorContract`. `JobClass` = interactive|fresh|indexing|maintenance (`types.ts:16`). Add `busy` with `retry_after` per `types.ts` (read before editing; fake.ts shows the expected semantics).

### Source Tree additions (`src/source-tree/real.ts`)
**Analog:** same file. Spec builder and error mapping to reuse:
```typescript
const spec = (sub, worktree, extra = {}) => gitSpec(sub, { worktree, ...(env === undefined ? {} : { env }), ...extra });   // real.ts:55-56
async function gitText(s, label) { const result = await runner.run(s, ctx); if (!result.ok) { ... throw new SourceTreeError('git_failed', `git ${label} failed: ...`) } return decoder.decode(result.stdout); }  // :58-65
```
For read-with-expected-nonzero exit (e.g. `check-attr`, `cat-file -e`) copy `probe()` (:173-180). New methods must be added to `types.ts`, `fake.ts` and `contract.ts` together. New diagnostics go through `SOURCE_TREE_CODES`/`SourceTreeError` (`types.ts`). Allowlist must be extended first in `src/command-runner/decide.ts:24-31` with `decide.test.ts` cases.

### Fact Store implementation (`src/fact-store/*`)
**Analog for open policy:** `src/sqlite/open.ts:120-144` (`openDatabase`: driver select, `selfTest`, WAL/NORMAL/foreign_keys only if writable, close-on-failure try/catch). Error classes follow `src/fact-store/errors.ts` (`SchemaTooNew`, `StoreClosed`, `UnknownWorktree`, `WriterBusy` already exist, exported from `index.ts`). Interface to satisfy: `FactStore` / `Reader` / `Writer` in `src/fact-store/types.ts` (usage shape at `fact-store.test.ts:36-57`: `store.at(w).find/refs/callers/symbol/fileFacts`, `writer().commitFile/setOverlay/dropOverlay/markStale/release`, `reconcile/collect/compact/check/maintain/status/close`). Every Reader result is `Answer<T>` = `{data, watermark:{seq, stalePaths}, degraded?}` (`fact-store.test.ts:60-66`). `OpenStore = (dir, deps: StoreDeps) => Promise<FactStore>` (`types.ts:294`). Pragmas needed beyond the kit allowlist (`driver.ts:39-55`) must be added there with a conformance case in `src/sqlite/contract.ts`. Tests: real SQLite in short temp dir via `src/test-kit/tmpdir.ts`, `FakeClock`, fake `gitHas` (no fake store).

### Grammar modules (`modules/typescript`, `modules/javascript`)
**Analog:** `test/fixtures/modules/toy/` layout: `atlas-lang.json` (strict, schemaVersion 1; do not add fields, `src/lang/manifest.ts:43`), `grammar.lock`, `grammar.wasm`, `queries/{tags,refs,imports}.scm`, `fixtures/*.{ext,golden.json}` incl. `bom`, `crlf`, `emoji` cases, `fixtures-negative/broken.*`. Validate with `gsd-atlas lang test` (`src/lang/test-runner.ts`). Build via `scripts/grammar-build.ts`; the pipeline must skip `tree-sitter generate` for `source.type: "upstream"` (research: typescript fails without it). Goldens in toy must be regenerated deliberately (`scripts/toy-goldens.ts`) if engine capture grouping changes.

### Engine/extractor (`src/grammar-engine`)
**Analog:** `normalize.ts:37` `toCapture` (cap `text`), `collectCaptures` (flat `query.captures`; add `matches`). Extractor `extract.ts` maps `@definition.<kind>` + `@name`, `@export`, `@import.*`, `@reference.<kind>` to `FileFacts`; run against toy module for LNG-08. `.parse` only inside `with-tree.ts` (lint). Release every Parser/Tree/Query with `.delete()`.

### Host-client / Tenant / Host
**Analog:** `src/host-client/in-process.ts:102-141`: `handle(request)` checks `request.protocol !== PROTOCOL_VERSION` first, then `switch (request.kind)`, default returns `failEnvelope(ERROR_SCHEMA, [diagnostic('unknown_kind', ...)])`; arg validation returns `invalidArgs(msg)` (`:94-96`). Extend the switch with the six tool kinds, delegating to the host; keep `lang_list`/`lang_test` as-is. Re-export tool definitions (zod) from `host-client/index.ts` like the existing `export {...} from './in-process.ts'` (`index.ts:15-17`). Tenant registry keyed by `SourceTree.identity().storeId`; no module-level state.

### CLI (`src/cli/index.ts`)
**Analog:** same file. Pattern: `parseArgs({strict:true, allowPositionals:true, options})` in try/catch -> `usageError` (:99-117); `send(io, kind, args)` builds a Request, calls `io.client.handle`, writes JSON, returns `exitCodeFor(envelope)` (:82-96, :47). Add `export const EXIT_LEASE_HELD = 3` next to :17-19, new subcommands in the group/action dispatch (:129-149), extend `USAGE` (:29-36). Relative path flags are resolved with `path.resolve` in the CLI before reaching the host (:65-80). Tests in `src/cli/cli.test.ts` with a stub `HostClient`.

### Bins (`src/bin/gsd-atlas.ts`, `gsd-atlas-mcp.ts`)
**Analog:** `src/bin/gsd-atlas.ts:52-65`: build deps once, `process.exitCode = await runCli(...)` in try, catch writes `gsd-atlas: error internal_error: ...` to stderr with exit 2, `finally` disposes the engine. Mirror it for the MCP bin: lazy tenant creation, stdout reserved for protocol frames (no `console.log`), dispose on stdin EOF. Roots default logic at `:40-50` (`GSD_ATLAS_USER_DIR`, `~/.config/gsd-atlas`). `src/mcp-shim/index.ts` is a 4-line stub today; build `McpServer` + `registerTool` there from the shared tool definitions, calling only `HostClient.handle`.

### Metrics
**Analog:** SQLite kit only (`openDatabase`, `PRAGMA user_version` allowlisted). Migrations are new; no in-repo precedent (see below).

### Test conventions
`node:test` with `describe/it`; `import.meta.dirname` for fixtures (`fact-store.test.ts:9`); git repos via `src/test-kit/git-repo.ts`; temp dirs via `tmpdir.ts`; time via `fake-clock.ts`; contract suites per implementation.

## Shared Patterns
- **Envelope/diagnostic**: use `okEnvelope`/`failEnvelope`/`diagnostic` everywhere; never hand-build envelopes.
- **Error to exit code**: `exitCodeFor(envelope)` (`cli/index.ts:47`) inspects `diagnostics[].code`; add `lease_held`/`busy` -> 3, `not_indexed`/`not_a_repo` -> 2.
- **git access**: only through `SourceTree` -> `gitSpec` -> CommandRunner; arguments as arrays, never shell.
- **Closing resources**: open-then-try/catch-close (`open.ts:133-142`); engine/store `dispose`/`close` in `finally` (`bin/gsd-atlas.ts:63-65`).

## No Analog Found
| File | Role | Reason |
|---|---|---|
| `src/fact-store/lease.ts` | lease | no lock/lease code exists; follow research Pattern 3 (SQLite `BEGIN EXCLUSIVE`) |
| `src/indexer/event-source.ts`, `parcel-source.ts`, `reconcile.ts` | event-driven | no watcher or debounce exists; use `FakeClock` + a `ManualEventSource` port for tests |
| `src/metrics/migrations/` | migration | no numbered-migration code exists |
| `src/query/{ranking,cursor,fence}.ts` | pure logic | greenfield; research Pattern 9 gives the spec |
| `src/cli/init` | file-I/O | none; research Pattern 12 (user scope, atomic write, refuse unparseable) |
| MCP server wiring | adapter | no `@modelcontextprotocol/server` use yet; install gated by `checkpoint:human-verify` |

## Metadata
**Analog search scope:** `src/**`, `scripts/**`, `test/fixtures/modules/toy`, `docs/adr`, `eslint.config.js`
**Not re-read (read before editing):** `src/governor/{fake,types}.ts`, `src/grammar-engine/*`, `scripts/adr-ratify.ts`, `scripts/grammar-build.ts`, `src/sqlite/driver.ts` body.
**Pattern extraction date:** 2026-10-16
