# How to see why atlas gave an answer

This guide shows why gsd-atlas gave one answer or one fact: which tier produced it, how sure it is, and which compiler was used. It assumes a built index and an answer in hand. Run the commands from inside the repository; `gsd-atlas` below stands for `node /path/to/gsd-atlas/dist/bin/gsd-atlas.js`.

1. Take the identifier of what you want explained:

   - the `answer_id` at the end of an answer, to explain the whole answer;
   - the `debug` value of a citation in the answer, to explain one fact.

2. Ask for the explanation:

   ```sh
   gsd-atlas explain <answer id or handle>
   ```

   An argument of the form `a_` and 16 hexadecimal digits is read as an answer id; anything else is read as a handle. An agent asks the same question with the `code_explain` tool and the argument `answer_id` or `handle`. The command reads what is already stored: it runs no resolver and starts no compiler.

3. Read the fields that answer your question.

   For an answer id:

   - `data.answer.tool` and `data.answer.outcome` say which tool answered and how it ended;
   - `data.answer.degraded` lists the codes the answer carried;
   - each entry of `data.facts` gives a handle with its `tier` and `confidence`, or the status `stale` or `unknown`.

   For a handle:

   - `data.explanation.fact.extractor` and `tier` say who produced the fact, `grammar:typescript@<version>` for the grammar tier or `precise:typescript` for the compiler;
   - `data.explanation.resolution` says, for a reference or a relation, whether a compiler edge is stored (`cache`), which `resolver` found it and what it `target`s;
   - `data.tiers.compiler` says which compiler resolved it: `name`, `version`, `source` (`project` or `bundled`) and `case`.

## If the handle is stale

The answer is `stale_handle`: the file behind the handle has changed since the handle was issued. Ask the original question again and use the new handle.

## If the handle is not accepted

The answer is `invalid_handle`. Pass the `debug` value of a citation unchanged. The handle of an ADR file, `adr/<path>`, is not accepted; the `cit/` handle of a citation is.

## If the answer id is not found

The answer is `answer_not_found`. The recorder keeps only the newest answers of a repository, on this machine. Ask the question again and use the new `answer_id`.

## If the answer carries `compiler_fallback`

A compiler other than the project's own did the resolving. `data.tiers.compiler.case` says why: `none` (the project has no TypeScript in `node_modules`), `project-7-unstable`, `project-7-sync` or `project-7-unknown-layout` (the project's TypeScript is 7.x), or `project-other`. To have the project's own compiler used, the project needs TypeScript 6.x installed; there is no resolver for 7.x. See [Compiler selection](../reference/typescript-support.md#compiler-selection).

## If it carries `memory_budget`

The compiler worker was stopped or not started because of the memory budget, and the answer comes from the grammar tier. `gsd-atlas maintain resolve` forgets the memory stop and tries the project again once.

## If it carries `precise_unavailable`

The precise tier did not answer. Read `data.tiers.reason`: `no TypeScript project configuration was found in this repository` means no `tsconfig.json` covers the file, so add one; `the typescript provider is turned off in the user configuration` means the id `typescript` is in `providers.disabled` of your user configuration, so remove it.

## If the tier says `needs_approval`

A command a language module declares is not approved for this repository. A person approves it with `gsd-atlas allow` in a terminal; see [How to approve a precise command for one repository](approve-a-precise-command.md).

For every field of the answer, see [the MCP reference](../reference/mcp.md#code_explain); for the compiler cases and tier states, see [the TypeScript support reference](../reference/typescript-support.md). For why the tier is built this way, see [About how the precise TypeScript tier works](../explanation/how-the-precise-tier-works.md).
