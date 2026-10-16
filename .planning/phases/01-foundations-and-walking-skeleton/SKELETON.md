# Walking Skeleton - gsd-atlas

**Phase:** 1
**Generated:** 2026-10-15

## Capability Proven End-to-End

A developer on macOS, Linux or Windows can build the repo and run `gsd-atlas lang test <fixture module>`: the toy language module's manifest is validated against the Zod schema, its committed WASM grammar is checked against `grammar.lock` and loaded, its queries run over fixtures that include UTF-16 (emoji), CRLF and BOM cases, and the produced spans and captures are compared with checked-in golden files. A mismatch gives a non-zero exit and a named diagnostic. `gsd-atlas lang list` shows where each module came from (repo, user, npm, built-in) and which tiers are active, and a module with an invalid manifest is skipped with a diagnostic instead of crashing.

This project is a CLI and library, not a web app. The "stack" the skeleton touches is: package scaffold, build and type stripping, CLI adapter, HostClient seam, module registry and manifest schema, Grammar Engine over WASM, SQLite driver layer (round-trip proven by the driver conformance suite), CommandRunner and git, and three-OS CI.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime and language | TypeScript, ESM, Node `>=24.16.0` | Floor raised from 24.15.0 by the user on 2026-10-15 because `node:sqlite` on 24.15.0 truncates TEXT at an embedded NUL (verified in research). Supersedes D-13 and FND-02 wording. |
| Build | `tsc` emit to `dist/`, no bundler; dev and tests run `.ts` through native type stripping | STACK.md rules: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`, `module: nodenext`. Published JS cannot rely on stripping under `node_modules`. |
| Package | One package `@opengsd/gsd-atlas`; bins `gsd-atlas` and `gsd-atlas-mcp` at `dist/bin/*.js` | Research recommends `src/bin/` as the composition root (adapters only call HostClient). The MCP bin prints one line and exits 1 until Phase 2. |
| Persistence | SQLite behind the `src/sqlite/` driver layer (`node:sqlite` primary, `better-sqlite3` 13.0.3 optional peer), Fact Store interface frozen with no fact tables | D-09. Only fact-store, metrics and sdk modules may import `sqlite/`. No fake Fact Store. |
| Parsing | `web-tree-sitter` 0.27.1 exact; grammar WASM built by `tree-sitter-cli` 0.27.1 exact, committed next to the module with sha256 in `grammar.lock` | D-07, D-08. Installs and tests never need wasi-sdk; only the grammar CI job rebuilds. |
| Schemas | Zod 4 is the source of truth; JSON Schema is generated with `z.toJSONSchema(schema, {target: 'draft-2020-12', io: 'input'})` and committed under `schemas/`; Ajv 2020 parity test is dev-only | D-04, D-05. |
| Process execution | Only `src/command-runner/` starts child processes: argv arrays, no shell, built-in decision table, recording fake, batched stdin | D-11, FND-06. Git is hardened with `-c` overrides because git runs repo-controlled code. |
| Boundaries | ESLint flat config only (`no-restricted-imports` regex patterns plus `no-restricted-syntax`), one fixture test per rule, including leaf rules (`src/facts` imports no other module; `src/test-kit` imports only `src/facts`) and a production-purity rule (no non-test file imports `node:test`, test-kit or a `contract.ts`) | D-12. No dependency-cruiser. Contract suites sit beside their seam as `contract.ts` and are imported only by that module's own tests, never from a seam `index.ts`, so the compiled package carries no test code. |
| CI | GitHub Actions on ubuntu, macos, windows x Node 24.16.0 and 26; lint and typecheck once on Linux; grammar rebuild-hash job on all three OSes; actions pinned to commit SHAs; `npm ci --ignore-scripts` everywhere | D-13 as amended, D-07. |
| Layout | `src/<seam>/index.ts` per seam; `src/cli` and `src/mcp-shim` adapters; `src/bin` composition roots; `src/test-kit` (never published); fixture modules under `test/fixtures/modules/`; no built-in language ships in Phase 1 | D-14 plus research recommendation (Open Question 8). |
| Spans | 0-based line, 0-based UTF-16 column, end exclusive; leading BOM stripped before parsing and recorded as `hadBom`; CRLF left in place | Matches web-tree-sitter and the TypeScript compiler; documented in `facts/` and golden headers. |
| CLI contract | JSON envelope on stdout, reasons on stderr; exit 0 ok, 1 usage or unknown, 2 failure | Aligns with gsd-graph and QRY-04 so Phase 2 extends rather than changes it. |
| User config dir | `os.homedir()/.config/gsd-atlas` on every OS, overridable by an injected path | Research Open Question 6; docs only say `~/.config/gsd-atlas/`. |

## Stack Touched in Phase 1

- [x] Project scaffold (package, tsconfig pair, ESLint boundaries, node:test runner, lockfile, `.gitattributes` for CRLF and BOM fixtures) - evidence: `scripts/package.test.ts` (identity, exact pins, build output), `src/lint/boundaries.test.ts` (one violation fixture per rule), `npm run lint`, `npm run typecheck`, `npm test`; `.gitattributes` and `package-lock.json` are committed; CI jobs `Static checks` and `Test (...)`.
- [x] Routing: CLI subcommands `lang list` and `lang test` reach the HostClient and nothing else - evidence: `src/cli/cli.test.ts` and `src/host-client/host-client.test.ts` (adapter drives a recording HostClient; lint rule keeps `src/cli` from importing anything but the HostClient seam).
- [x] Database: one real SQLite read and one real write through the driver layer on both drivers (conformance suite), including the NUL round-trip self-test - evidence: `src/sqlite/contract.ts` run by `src/sqlite/node-sqlite.test.ts` and `src/sqlite/better-sqlite3.test.ts`; NUL self-test in `src/sqlite/open.ts` (`open.test.ts`); green on Node 24.16.0 and 26 on all three OSes in CI.
- [x] Interaction: `gsd-atlas lang test` wired from argv to the Grammar Engine to golden comparison and exit code - evidence: `src/lang/lang-test.e2e.test.ts` (real bin through the real CommandRunner, exit codes and envelope), and `scripts/package.test.ts` test `installed tarball runs the bins` (the same command from the installed tarball).
- [x] Deployment: documented local-run commands in `README.md` plus a green three-OS CI run; packed tarball installs and runs both bins - evidence: README "Developer quickstart" (test `README npm scripts exist`); `scripts/package.test.ts` tests `pack contents` and `installed tarball runs the bins`; CI run https://github.com/open-gsd/gsd-atlas/actions/runs/38841954238 on commit 2e59fc7 (all 10 jobs success, including the package tests on Windows, macOS and Linux). Tarball install used the registry only for `web-tree-sitter` and `zod`.

## Out of Scope (Deferred to Later Slices)

- Indexing, watching, Reconcile, queries, MCP tools, real fact tables, writer lease, maintenance (Phase 2)
- Real grammars (TypeScript, JavaScript, Python, Swift) and their parse budgets (Phases 2, 3, 5, 9)
- User-level permission config loading, `--allow-build`, per-repo command approval (Phase 3, SEC-01 and SEC-02)
- Real Governor scheduling, compiler pools, memory budgets, multi-tenant Host (Phases 2 and 4)
- `xcode-27` CI lane (Phase 6)
- Writer-contention and metrics-migration ADR amendments, and ratification of the six remaining ADRs (Phases 2, 3, 4 per the schedule recorded in `docs/adr/README.md`)
- Closing the eight ADR issues, publishing to npm, branch protection

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- Phase 2: build then find over a 3-file temp repo through the real Indexer, store, Query and CLI on all three OSes; the toy module is the second, non-TypeScript fixture language for Grammar Engine tests
- Phase 3: compiler-precise TypeScript answers on gsd-core, `explain`, skill, diagnostics and the token-cost eval
- Phase 4: multi-tenant, authenticated Host with supervisor and full Governor
- Phase 5: Swift module on Linux with no Xcode
- Phase 6: installed-SDK facts for Apple and Node
- Phase 7: Policy module, hooks R0-R4, `atlas-scout`, pre-commit check
- Phase 8: value dashboard and enforcement eval
- Phase 9: SCIP and IndexStoreDB imports, Python module, gsd-graph bridge, 1.0 gate

## Assumptions made without a recorded user decision (flagged)

1. Fixture module lives at `test/fixtures/modules/toy/` and is not shipped; no built-in module ships (research Open Question 8).
2. Minimal in-process HostClient serves `lang_list` and `lang_test`; `src/bin/*` is the composition root exempt from the adapter rule (research Pattern 4).
3. Span and BOM/CRLF conventions above (research A7, A8).
4. User config dir is `~/.config/gsd-atlas` on Windows too (research A10).
5. `gsd-atlas-mcp` prints one line to stderr and exits 1 (research Open Question 9).
6. Corpus manifest allows a `status: "unselected"` entry with no SHA for the Swift reference app until Phase 5 (research Open Question 7).
7. Every configured git filter driver is neutralised by name with no allowlist, including `lfs`, because a repo-controlled config can name any command `lfs` (stricter than the research suggestion of allowing lfs).
