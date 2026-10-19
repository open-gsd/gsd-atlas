# About how the precise TypeScript tier works

The grammar tier of gsd-atlas reads syntax. It can say where a function is defined, and it can say that a call named `parseConfig` exists, but it can only match that call to the definition by name. The precise tier asks the TypeScript compiler instead, and the compiler knows which declaration a call really reaches. This page discusses why that tier is built the way it is. What it resolves, to the letter, is in [the TypeScript support reference](../reference/typescript-support.md).

## Why does the compiler run in a child process?

A compiler is a large program, and the one a project uses is JavaScript that the project's own `node_modules` supplies. The decision record that covers compiler trust says so plainly: the worker loads code that the repository's dependency tree provides ([trust boundaries](../adr/3-trust-boundaries.md), the amendment on compiler trust). An earlier design loaded the project's `typescript` package inside the atlas process, and the [command runner](../adr/4-command-runner.md) record names that as the problem: it is code the repository influences.

So the host never loads a compiler. It starts a worker as a child process through the command runner, with a scrubbed environment, a bounded heap and a memory sampler, and the worker is killable. That the worker can be ended is what makes the memory limit described below enforceable: the sampler ends the process, and a request that does not answer within its bound is given up on. The host decides which compiler directory the worker should load and sends it in the worker's first message; it does not execute any compiler code itself.

The same record is candid about what this does not do. A compromised `typescript` package inside a repository's `node_modules` runs with the user's rights while the worker is alive, and atlas does not sandbox it further. The record accepts that risk because the user has already installed that package, and it can be removed by turning the compiler tier off with `providers.disabled` in the user configuration. Nothing in a repository can turn the tier on or off.

## Why is the project model written without the compiler?

Before a worker can be started, someone has to decide which compiler to load and which configuration covers which file. The project model answers that by reading `tsconfig.json` and `jsconfig.json` as data, following `extends` and `references`, and reading the `version` and `exports` keys of the project's `typescript/package.json` without importing it. Because it never loads the TypeScript package, it works with no compiler installed, and a hostile repository cannot make it run any of its code.

The model also gives the tier things the compiler would otherwise have to be asked for: the owner config of each file, so that one compiler program runs per owner rather than per config; the hashes that go into a resolution context; and the map from sources to their emit outputs. A test keeps the model's file lists equal to the compiler's own, as the [language modules](../adr/5-language-modules.md) record says.

## How does a compiler declaration become something gsd-atlas stores?

The store accepts an edge only when its target is the identity of a symbol the grammar tier already holds. The compiler speaks in declarations, the grammar tier in symbols, and the worker's job at the end of a request is to map one onto the other. The mapping is strict on purpose: the name must match, the kind must be one the grammar tier records for that kind of declaration, and the span must start no earlier than the declaration and end where it ends.

The first version was looser, and the code comment records what went wrong: it accepted any symbol of the right name whose span merely contained the name, so a property of an inline type, declared inside a function of the same name, was stored as a reference to that function. The rule now is that a declaration with no matching symbol, such as a destructured binding or a parameter, produces no edge. Nothing is guessed. The cost is that some references stay name-matched; the benefit is that an `EXTRACTED` edge can be trusted.

## Why is there a memory budget, and why does the watch live inside the worker?

The decision record measured that one compiler program for a large repository is large, and that programs cannot be shared across different file sets. The recorded decision is one machine-wide budget, a share of RAM, with a pool that stops the least recently used idle worker to make room and restarts it on demand, which costs a cold start and never a wrong answer. A worker with a request in flight is never stopped; the newcomer is answered with `memory_budget` instead. When the budget cannot hold a worker at all, no worker starts and the answer says `memory_budget` and falls back to grammar facts.

The original wording of the decision put the memory watch in the parent, reading the worker's size from outside. The implementation put it inside the worker, as a thread of its own that reads the worker's resident size on a timer and ends the process when it passes the limit, and the project's decision log records this as a deviation that was approved. The code comment gives the reasons. A thread of its own keeps running while the main thread is blocked in a long compiler call, which was verified during research, and it needs no per-system process listing in the parent. The V8 heap limit stays as the backstop in case the thread could not do its job. The parent learns about a memory stop from one marker line on the worker's standard error, which is how `memory_budget` is told apart from an ordinary crash, `resolver_failed`.

## Why may the project's own compiler be used, and why is 7.x answered by 6.x?

The recorded rule is that the worker loads the project's own installed TypeScript when it is a 6.x release, and otherwise the copy gsd-atlas ships, TypeScript 6.0.3. The trust record presents the first half as a trust decision, with the residual risk above, and not as a convenience. A fact resolved by the shipped copy is marked `compiler_fallback`, with a fixed sentence that names the case and carries nothing from the repository, and `explain` says which compiler and which version produced a fact and whether it was the project's or the bundled one.

TypeScript 7.x is detected, not used. The decision record for the project model reads the project's `typescript` package as data, tells apart a 7.x copy that offers the `typescript/unstable/sync` subpath, one that offers `typescript/sync`, and one with neither layout, and in every such case selects the bundled 6.0.3 and says so. A working 7.x resolver waits, in the words of the record, for a stable 7.1 API. The design document makes the same point from the other side: two adapters are planned so that TypeScript 7 does not break the first one.

## Why do `.cjs` requirers link to `.cts` sources?

A gsd-core maintainer writes `src/*.cts` and the build writes `.cjs` files next to it, or under an output folder. The product requirements put the aim in one line: agents should edit source, not build output. So the project model works out, from `rootDir`, `outDir`, `declarationDir` and the extension rules of the compiler itself, where each source is emitted. A file that is the emit output of an included source gets no facts, and a `require` or `import` of an emitted path resolves to the source. `code_context` reports the outputs of a source as `emittedAs`.

The mapping is driven by the tsconfig alone, with no project-specific code. It is also careful about the cases where it cannot be sure. An output that two sources both emit to maps to none of them, and a hand-written file that merely sits in an output folder keeps its facts, so that nothing real drops out of the index.

## Why are the edges filled while building?

A cold compiler takes time to start and to load a program, and the first question after an index is built should not pay for that. So after the index is built, `gsd-atlas build` asks the compiler about every reference site of the indexed files, in batches, and stores the answers; the first `refs` is then answered from the store. The pass has a time bound that is shorter than the budget for a whole build, so that a hang fails before it spoils the build, and a pass that does not finish leaves the build successful with a `resolver_timeout` note. `gsd-atlas maintain resolve` continues it. Because it remembers which sites it has asked, running it again over an unchanged tree asks nothing.

## What does the tier not do?

It does not resolve for TypeScript 7.x; it does not sandbox the compiler beyond running it as a child process; it gives no relation for a base class that lives in a library, because that base is not a declaration inside the repository; and it does not run for a file that no usable `tsconfig.json` covers, where an answer carries `precise_unavailable` and the grammar tier answers instead. In each of these cases the weaker answer says why it is weaker, in the `degraded` field and in a diagnostic, so that the reader of an answer is never left to guess.

## See also

- [gsd-atlas TypeScript support reference](../reference/typescript-support.md)
- [gsd-atlas MCP reference](../reference/mcp.md)
- [How to see why atlas gave an answer](../how-to/see-why-atlas-gave-an-answer.md)
- [About how freshness and the writer lease work](how-freshness-and-the-writer-lease-work.md)
