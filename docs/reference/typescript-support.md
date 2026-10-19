# gsd-atlas TypeScript support reference

What gsd-atlas resolves for TypeScript in this release. The shapes of the answers are in [the MCP reference](mcp.md), the commands in [the CLI reference](cli.md).

## Modules and files

| Module | Extensions | Tiers |
| --- | --- | --- |
| `typescript` | `.ts`, `.cts`, `.mts` | `grammar`, `precise` |
| `javascript` | `.js`, `.cjs`, `.mjs`, `.jsx` | `grammar` |

Both modules name the ADR directories `docs/adr`, `docs/adrs`, `doc/adr` and `adr` (see [ADR citations](adr-citations.md)). The parse-error budget of each module is 0.005, half a percent of the bytes of its fixtures.

`gsd-atlas lang list` shows the modules and their tiers. `gsd-atlas health` shows, for each module, whether each tier is active.

## Project configuration

The `typescript` module reads project files itself and never loads the TypeScript package for this.

| Aspect | Behaviour |
| --- | --- |
| Files read | `tsconfig.json` and `jsconfig.json`, in the directory of every source file and in every directory above it up to the repository root, and every config that a found config lists in `references`. Comments are allowed. |
| Inheritance | `extends` is followed up to 16 links. A target above the repository root, a link that leaves the repository, a missing target and a cycle are ignored; the rest of the config still loads. |
| File sets | `files`, `include` and `exclude` as the compiler reads them. An entry that points outside the repository or that the compiler rejects is dropped. |
| Limit | At most 200 configs are described, the first 200 in lexical order. |
| Owner of a file | Of the configs that cover a file, the one in the nearest ancestor directory; then a plain name (`tsconfig.json`) before a name with `test`, `spec`, `build`, `dist`, `prod` or `production` in it; then lexical order of the path. One compiler program runs per owner. |
| A config that cannot be used | A config that cannot be read or is not valid JSON with comments is skipped. A file that no usable config covers has no project: its answers carry `precise_unavailable`. |

## Tiers

The grammar tier is always active. It answers from syntax alone: definitions, imports and exports, and name-matched references (`INFERRED`).

The precise tier asks the TypeScript compiler. It is on by default for the `typescript` module. Nothing a repository contains creates or enables a tier: the Host picks it from its own table by the id the module manifest names, and the user can turn it off with `providers.disabled` in [the user configuration](cli.md#environment-and-user-configuration).

`data.tiers.precise` of `code_explain` has one of these states:

| State | Reason (fixed text) | Code the answer carries |
| --- | --- | --- |
| `active` | none | none |
| `degraded` | `the compiler worker failed on its last use; answers fall back to grammar facts` | `resolver_failed` |
| `degraded` | `the compiler worker reached its memory limit on its last use; answers fall back to grammar facts` | `memory_budget` |
| `inactive` | `no TypeScript project configuration was found in this repository` | `precise_unavailable` |
| `inactive` | `no language module declares a precise tier` | none stated |
| `inactive` | `the precise adapter a language module names is not available in this installation` | none stated |
| `needs_approval` | `the precise command of a language module is not approved for this repository` | `needs_approval` (on `code_explain`) |
| `disabled` | `the typescript provider is turned off in the user configuration` | `precise_unavailable` |

A `degraded` state also carries the degraded code of the failure, and a state other than `active` carries its reason. `maintain resolve` forgets a memory stop, so a project that ran out of memory is tried again once.

## Relations

A relation is stored when both ends are declarations inside the repository that have an identifier name. A base type in a library or under `node_modules` gives no relation.

| Relation | From | To |
| --- | --- | --- |
| `calls` | a call site | the declaration called |
| `references` | any other reference site | the declaration referred to |
| `extends` | a class, to its base class; an interface, to each base interface | the base |
| `implements` | a class, to each interface or class in its `implements` clause | the interface or class |
| `overrides` | an instance member of a class, abstract members included | the member of the nearest base class that declares it |

- The type that a heritage clause names is asked of the compiler, so an alias, a namespace import, `Base<T>` and a mixin that returns a class resolve to the declared types. An expression the compiler cannot resolve to a declaration gives no relation and no error.
- A class member that only implements an interface member is not an override: the class has an `implements` relation to the interface.
- Where each relation appears: `edge` of an item of `code_refs` (`calls`, `references`, `extends`, `implements` for a heritage clause that names the target, `overrides`); `supertypes` and `subtypes` of `code_context`; `via` of an item of `code_impact` (`call`, `reference`, `import`, `extends`, `implements`, `overrides`). The fields are in [the MCP reference](mcp.md).
- An item from the grammar tier has no `edge`: a name match is never presented as one of these relations.

## Confidence

| Source | Confidence |
| --- | --- |
| A definition, import or export read from the file | `EXTRACTED` |
| A reference matched by name (grammar tier) | `INFERRED` |
| An edge or relation found by the compiler | `EXTRACTED` |
| A chain through several edges | `INFERRED` as soon as one edge is |

A compiler declaration is mapped to the grammar symbol that is that declaration: same name, a kind the grammar tier records for that kind of declaration, a span that starts no earlier than the declaration and ends where it ends. Among the symbols that pass, the innermost wins; two equally tight ones are ambiguous. A declaration with no such symbol (a destructured binding, a parameter, a member of a type literal) produces no edge.

## Compiler selection

The host never loads a compiler. It reads `node_modules/typescript/package.json` as data, in the directory of the first config that owns a source file and in each directory above it, nearest first, and sends the worker the directory to load.

| Case | The package | Compiler used | Reason in `code_explain` | Text of the `compiler_fallback` diagnostic |
| --- | --- | --- | --- | --- |
| `project-6` | version 6.x | the project's own | none | none |
| `none` | none found, not readable, no valid version, or reached through a link that leaves the repository | bundled 6.0.3 | `no project compiler` | `the project has no TypeScript compiler; the bundled 6.0.3 was used` |
| `project-7-unstable` | 7.x with an `exports` key `./unstable/sync` (the subpath `typescript/unstable/sync`) | bundled 6.0.3 | `project compiler is 7.x with the unstable layout` | `the project TypeScript is 7.x with the unstable API; the bundled 6.0.3 was used` |
| `project-7-sync` | 7.x with an `exports` key `./sync` | bundled 6.0.3 | `project compiler is 7.x with the sync layout` | `the project TypeScript is 7.x with the sync API; the bundled 6.0.3 was used` |
| `project-7-unknown-layout` | 7.x with neither key | bundled 6.0.3 | `project compiler is 7.x with an unknown layout` | `the project TypeScript is 7.x with an unknown layout; the bundled 6.0.3 was used` |
| `project-other` | another major version | bundled 6.0.3 | `project compiler is not 6.x` | `the project TypeScript is not 6.x; the bundled 6.0.3 was used` |

- Any case other than `project-6` makes the answer `degraded` with `compiler_fallback`, and adds an `info` diagnostic of that code with the text above. The texts carry no version string and no path from the repository.
- There is no resolver for TypeScript 7.x: a 7.x project is answered by the bundled 6.0.3.
- The project's own compiler is JavaScript from the repository's `node_modules`, loaded by the worker. `code_explain` reports the compiler used as `name`, `version`, `source` (`project` or `bundled`), `case` and, for a bundled one, `reason`.

## Emit mapping

The project model restates TypeScript's own output rules (`ts.getOutputFileNames`) for the configs it reads: the extension map, `rootDir`, `outDir`, `declarationDir`, declaration files that never emit, and JavaScript inputs under `allowJs`.

| Source | Code output | Declaration output |
| --- | --- | --- |
| `.ts`, `.js` | `.js` | `.d.ts` |
| `.tsx`, `.jsx` | `.js`, or `.jsx` when `jsx` is `preserve` | `.d.ts` |
| `.mts`, `.mjs` | `.mjs` | `.d.mts` |
| `.cts`, `.cjs` | `.cjs` | `.d.cts` |

- The output tree is rooted at `rootDir`, or at the directory of the config when `rootDir` is not set. A declaration is written to `declarationDir`, else to `outDir`. With `declaration` off there is no declaration output; with `emitDeclarationOnly` there is no code output. A config with `outFile` maps nothing. A `noEmit` config with no `outDir` maps nothing.
- A file that is the emit output of an included source receives no facts and is not indexed. A build then reports the `info` diagnostic `emit_output_not_indexed` with a count.
- A file that is not the emit output of a source keeps its facts, even when it sits in an output folder.
- A requirer of an emitted path resolves to the source: an import of `./lib.cjs` links to `src/lib.cts` when `lib.cjs` is the output of `lib.cts`.
- `code_context` answers `data.file` as `{ path, emittedAs[] }` for a source whose project says what it compiles to; `emittedAs` lists the repository-relative output paths, for example `src/lib.cts` to `out/lib.cjs` and `out/lib.d.cts`. It is absent for a file in no project and for a repository with no `tsconfig.json`.
- Not mapped, and the output stays an ordinary source: an output that is also a source of some config; an output that two sources both emit to (it maps to none of them); an output that would leave the repository, or a `rootDir`, `outDir` or `declarationDir` that leaves it (none of that config's outputs is mapped).

## Resource bounds

| Bound | Value |
| --- | --- |
| Worker | One compiler worker per worktree, a child process started through the command runner with a scrubbed environment, started on first use. It can be killed. |
| Memory budget | 25 percent of RAM, machine-wide, shared by every worker (`precise.memoryBudgetPercent`). |
| Heap limit of a worker | 0.8 of the budget (`precise.heapShareOfBudget`), set with `--max-old-space-size`. |
| Memory watch | A sampler thread inside the worker reads its resident set every 250 ms (`precise.rssSampleMs`) and ends the process past the budget; the heap limit is the backstop. |
| Smallest usable budget | 512 MB (`precise.minBudgetMb`); below it no worker starts and answers say `memory_budget`. |
| Idle worker | Released after 300000 ms (`precise.idleExitMs`). |
| Start | 20000 ms (`precise.startTimeoutMs`). |
| Request | 25000 ms (`precise.requestTimeoutMs`), at most 2000 sites per request (`precise.sitesPerRequest`), one JSON line at most 4194304 bytes. |
| Stop | 2000 ms between ending the worker's input and killing it (`precise.killGraceMs`). |
| Pool | When the budget cannot hold another worker, the least recently used idle worker is stopped. A worker with a request in flight is never stopped; the newcomer is answered `memory_budget`. |

After a memory stop the tier answers `memory_budget` for that project without starting a worker, until `gsd-atlas maintain resolve` is run.

## Degraded codes of the tier

| Code | When |
| --- | --- |
| `resolver_failed` | The worker exited without answering, or broke the protocol. The next call starts a new worker. |
| `memory_budget` | The worker was stopped for memory, or refused because the budget could not hold it. |
| `resolver_timeout` | The compiler did not answer within its bound; the answer is the grammar-tier chain. |
| `compiler_fallback` | A compiler other than the project's own did the resolving. |
| `precise_unavailable` | The tier is off, or no `tsconfig.json` covers a TypeScript file in the answer. |
| `needs_approval` | A command the module declares is not approved. |

The full table is in [the MCP reference](mcp.md#degraded-codes).

## See also

- [gsd-atlas ADR citations reference](adr-citations.md)
- [gsd-atlas MCP reference](mcp.md)
- [gsd-atlas command-line reference](cli.md)
