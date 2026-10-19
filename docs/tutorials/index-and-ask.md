<!-- replayed: 2026-10-18 at a26fe40 -->

# Index a repository and ask it questions

In this tutorial we will build gsd-atlas, index a small repository of our own, and ask where a function is defined, who uses it and what would break if we changed it. Then we will ask gsd-atlas why it gave one of its answers, and at the end we will save a new file and see the next question find it.

Everything happens in two folders side by side: `gsd-atlas`, the program, and `atlas-demo`, a scratch repository we create. gsd-atlas keeps its index inside `atlas-demo/.git`, so none of our files or history change. The commands below are for a POSIX shell.

## Step 1: check Node

Windows is not supported in the alpha; Linux and macOS are.

First, check the Node version:

```sh
node --version
```

The output should be `v24.16.0` or newer, for example:

```
v26.11.1
```

## Step 2: build gsd-atlas

Now, from the folder where you want the two folders to live, clone and build gsd-atlas:

```sh
git clone https://github.com/open-gsd/gsd-atlas.git
cd gsd-atlas
npm ci --ignore-scripts
npm run build
```

The install ends with a line like `found 0 vulnerabilities`. The build prints only npm's two banner lines and then returns to the prompt:

```
> @opengsd/gsd-atlas@0.0.0 build
> tsc -p tsconfig.build.json
```

Check that the program runs:

```sh
node dist/bin/gsd-atlas.js --version
```

The output should be:

```
gsd-atlas 0.0.0
```

## Step 3: create a repository to index

Now go back up one folder and create the repository:

```sh
cd ..
git init atlas-demo
```

The output should look something like this, with your own path:

```
Initialized empty Git repository in /path/to/atlas-demo/.git/
```

With your editor, create the file `atlas-demo/src/config.ts` with this content:

```ts
export interface Config {
  name: string;
  retries: number;
}

export function parseConfig(text: string): Config {
  const data = JSON.parse(text) as Partial<Config>;
  return { name: data.name ?? "demo", retries: data.retries ?? 3 };
}
```

And the file `atlas-demo/src/main.ts`:

```ts
import { parseConfig } from "./config.ts";

export function start(text: string): string {
  const config = parseConfig(text);
  return `starting ${config.name}`;
}
```

## Step 4: index it

Now move into the demo repository and build its index:

```sh
cd atlas-demo
node ../gsd-atlas/dist/bin/gsd-atlas.js build
```

The command prints one line of JSON:

<!-- verified-by: cli: gsd-atlas build -->
```json
{"schema":"gsd-atlas.build/1","ok":true,"data":{"worktree":"/path/to/atlas-demo","files":2,"parsed":2,"linked":0,"removed":0,"skipped":0,"failed":0,"failedCodes":{}},"diagnostics":[]}
```

Notice that `ok` is `true` and `files` is 2: the two files we wrote are indexed. The path in `worktree` is your own.

## Step 5: ask where a function is defined

Now ask where `parseConfig` is defined:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js find parseConfig
```

The output should look like this. The `nonce` and the `answer_id` differ on every answer, so yours will not match them:

<!-- verified-by: cli: gsd-atlas find parseConfig -->
```json
{"schema":"gsd-atlas.code-find/1","ok":true,"data":{"results":[{"name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"col":8,"exported":true,"confidence":"EXTRACTED","citation":"c1"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/config.ts","line":6,"col":8,"endLine":9,"endCol":2,"confidence":"EXTRACTED","debug":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","text_ref":"ut1"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"e901526e5faa2a586469b7e70f5077c6","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-e901526e5faa2a586469b7e70f5077c6\nexport function parseConfig(text: string): Config {\nEND-UNTRUSTED-e901526e5faa2a586469b7e70f5077c6"}]},"answer_id":"a_c086aed6ac8ab6ee"}
```

Notice three things. The answer is cited: citation `c1` gives the path `src/config.ts`, line 6 and column 8. Its `confidence` is `EXTRACTED`, because a definition is read straight from the file. And the source line itself arrives in `untrusted_text`, between the `BEGIN-UNTRUSTED` and `END-UNTRUSTED` lines that carry the nonce. The long hexadecimal id in `debug` depends on the exact bytes of your file, so it matches ours only if your file does.

## Step 6: ask who uses it and what depends on it

Now ask who refers to `parseConfig`:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js refs parseConfig
```

<!-- verified-by: cli: gsd-atlas refs parseConfig -->
```json
{"schema":"gsd-atlas.code-refs/1","ok":true,"data":{"targets":[{"name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"handle":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3"}],"results":[{"target":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","path":"src/main.ts","line":4,"col":18,"kind":"call","enclosing":"start","tier":"grammar","confidence":"INFERRED","ambiguous":false,"candidates":1,"citation":"c1"}]},"diagnostics":[{"code":"precise_unavailable","severity":"info","message":"no tsconfig.json covers a TypeScript file in this answer; it was answered from grammar facts"}],"citations":[{"id":"c1","path":"src/main.ts","line":4,"col":18,"endLine":4,"endCol":29,"confidence":"INFERRED","debug":"ref/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut1"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"e3bf6ce45bf467447c67bb911d612b09","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-e3bf6ce45bf467447c67bb911d612b09\n  const config = parseConfig(text);\nEND-UNTRUSTED-e3bf6ce45bf467447c67bb911d612b09"}]},"degraded":["precise_unavailable"],"answer_id":"a_84566c63b6dfac1a"}
```

Notice that the one reference is a `call` inside `start`, in `src/main.ts` at line 4. Its `confidence` is `INFERRED`: the match was made by name, and gsd-atlas says so. Notice also the `degraded` field: it names why this answer is weaker than it could be. Here `precise_unavailable` says that our demo repository has no `tsconfig.json`, so no compiler was asked ([what the tiers are](../reference/typescript-support.md#tiers)).

Now ask what surrounds the function:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js context parseConfig
```

<!-- verified-by: cli: gsd-atlas context parseConfig -->
```json
{"schema":"gsd-atlas.code-context/1","ok":true,"data":{"results":[{"section":"definition","name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"col":8,"exported":true,"confidence":"EXTRACTED","citation":"c1"},{"section":"export","name":"Config","kind":"export","path":"src/config.ts","line":1,"col":1,"local":"Config","confidence":"EXTRACTED","citation":"c2"},{"section":"export","name":"parseConfig","kind":"export","path":"src/config.ts","line":6,"col":1,"local":"parseConfig","confidence":"EXTRACTED","citation":"c3"},{"section":"reference","name":"parseConfig","kind":"call","path":"src/main.ts","line":4,"col":18,"target":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","enclosing":"start","tier":"grammar","confidence":"INFERRED","ambiguous":false,"candidates":1,"citation":"c4"}],"alternatives":[]},"diagnostics":[{"code":"precise_unavailable","severity":"info","message":"no tsconfig.json covers a TypeScript file in this answer; it was answered from grammar facts"}],"citations":[{"id":"c1","path":"src/config.ts","line":6,"col":8,"endLine":9,"endCol":2,"confidence":"EXTRACTED","debug":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","text_ref":"ut1"},{"id":"c2","path":"src/config.ts","line":1,"col":1,"endLine":4,"endCol":2,"confidence":"EXTRACTED","debug":"exp/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/0","text_ref":"ut2"},{"id":"c3","path":"src/config.ts","line":6,"col":1,"endLine":9,"endCol":2,"confidence":"EXTRACTED","debug":"exp/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/1","text_ref":"ut3"},{"id":"c4","path":"src/main.ts","line":4,"col":18,"endLine":4,"endCol":29,"confidence":"INFERRED","debug":"ref/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut4"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"ad0c8aa975fdae188f75d7dd897d4580","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580\nexport function parseConfig(text: string): Config {\nEND-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580"},{"ref":"ut2","text":"BEGIN-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580\nexport interface Config {\nEND-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580"},{"ref":"ut3","text":"BEGIN-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580\nexport function parseConfig(text: string): Config {\nEND-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580"},{"ref":"ut4","text":"BEGIN-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580\n  const config = parseConfig(text);\nEND-UNTRUSTED-ad0c8aa975fdae188f75d7dd897d4580"}]},"degraded":["precise_unavailable"],"answer_id":"a_7d9563fe65dfba63"}
```

Notice that `results` is one list, and each item has a `section`: the `definition`, the `export` entries of its file and the `reference` we just saw.

Finally, ask what would break if we changed `parseConfig`:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js impact parseConfig
```

<!-- verified-by: cli: gsd-atlas impact parseConfig -->
```json
{"schema":"gsd-atlas.code-impact/1","ok":true,"data":{"seeds":[{"name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"handle":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3"}],"results":[{"hop":1,"via":"call","kind":"function","name":"start","path":"src/main.ts","line":3,"col":8,"confidence":"INFERRED","chain_confidence":"INFERRED","handle":"sym/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","from":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","citation":"c1"},{"hop":1,"via":"import","kind":"file","name":"src/main.ts","path":"src/main.ts","line":1,"col":1,"confidence":"EXTRACTED","chain_confidence":"EXTRACTED","handle":"imp/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","from":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","citation":"c2"}]},"diagnostics":[{"code":"precise_unavailable","severity":"info","message":"no tsconfig.json covers a TypeScript file in this answer; it was answered from grammar facts"}],"citations":[{"id":"c1","path":"src/main.ts","line":3,"col":8,"endLine":6,"endCol":2,"confidence":"INFERRED","debug":"sym/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut1"},{"id":"c2","path":"src/main.ts","line":1,"col":1,"endLine":1,"endCol":43,"confidence":"EXTRACTED","debug":"imp/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut2"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"479954d600d00ddbb22e509ab15693a7","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-479954d600d00ddbb22e509ab15693a7\nexport function start(text: string): string {\nEND-UNTRUSTED-479954d600d00ddbb22e509ab15693a7"},{"ref":"ut2","text":"BEGIN-UNTRUSTED-479954d600d00ddbb22e509ab15693a7\nimport { parseConfig } from \"./config.ts\";\nEND-UNTRUSTED-479954d600d00ddbb22e509ab15693a7"}]},"degraded":["precise_unavailable"],"answer_id":"a_552e48c067c0b8d7"}
```

Notice that two things at distance one hop depend on `parseConfig`: the function `start`, which calls it, and the file `src/main.ts`, which imports it. Each item carries `chain_confidence`, the confidence of the whole path from `parseConfig`.

## Step 7: ask why it answered that way

Every answer ends with an `answer_id`. Copy the value from the output of the `impact` command you just ran (ours was `a_552e48c067c0b8d7`; yours is different) and ask gsd-atlas about that answer:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js explain a_552e48c067c0b8d7
```

Replace the id in the command with your own. The output should look like this:

<!-- verified-by: cli: gsd-atlas explain a_552e48c067c0b8d7 -->
```json
{"schema":"gsd-atlas.code-explain/1","ok":true,"data":{"answer":{"id":"a_552e48c067c0b8d7","tool":"code_impact","outcome":"ok","latency":"le100","degraded":["precise_unavailable"],"results":2},"facts":[{"handle":"sym/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","status":"ok","kind":"symbol","tier":"grammar","confidence":"EXTRACTED"},{"handle":"imp/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","status":"ok","kind":"import","tier":"grammar","confidence":"EXTRACTED"}],"tiers":{"grammar":"active","precise":"inactive","reason":"no TypeScript project configuration was found in this repository"}},"diagnostics":[],"watermark":{"seq":3,"stalePaths":[]},"answer_id":"a_2dc468971656152b"}
```

Notice that `data.answer` names the tool that gave the answer, `code_impact`, and that `data.facts` lists the two facts it rests on, both from the `grammar` tier. And notice `tiers`: the `precise` tier is `inactive`, and the `reason` says no TypeScript project configuration was found. That is why the answers of Step 6 carried `precise_unavailable`.

## Step 8: save a new file and ask again

Now create the file `atlas-demo/src/queue.ts` with your editor:

```ts
export class JobQueue {
  private jobs: string[] = [];

  add(job: string): void {
    this.jobs.push(job);
  }
}
```

Without building again, ask for the new class:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js find JobQueue
```

The output should look like this:

<!-- verified-by: cli: gsd-atlas find JobQueue -->
```json
{"schema":"gsd-atlas.code-find/1","ok":true,"data":{"results":[{"name":"JobQueue","kind":"class","path":"src/queue.ts","line":1,"col":8,"exported":true,"confidence":"EXTRACTED","citation":"c1"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/queue.ts","line":1,"col":8,"endLine":7,"endCol":2,"confidence":"EXTRACTED","debug":"sym/src%2Fqueue.ts/1cc096c07663be2eab21aa3eb18d17ec8e570f0e/0","text_ref":"ut1"}],"watermark":{"seq":4,"stalePaths":[]},"untrusted_text":{"nonce":"4d621c53db65852d05371031d2aa357b","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-4d621c53db65852d05371031d2aa357b\nexport class JobQueue {\nEND-UNTRUSTED-4d621c53db65852d05371031d2aa357b"}]},"answer_id":"a_38cd6da9fc7d5a62"}
```

Notice that the new class is found, a `class` this time, and that we did not run `build` again. The `seq` in `watermark` went from 3 to 4: the index recorded our change.

We have built an index, asked it all four kinds of question, asked why it answered as it did and watched it follow our edit. Well done.

## Next

- Register the server with your coding agent: [How to register the MCP server with Claude Code, Cursor and Codex](../how-to/register-the-mcp-server.md).
- Explain any other answer the same way: [How to see why atlas gave an answer](../how-to/see-why-atlas-gave-an-answer.md).
- Look up every command and option: [the CLI reference](../reference/cli.md).
- Find out why the index stays current and why only one process may write to it: [About how freshness and the writer lease work](../explanation/how-freshness-and-the-writer-lease-work.md).
- See what this alpha does and does not do: [gsd-atlas alpha limitations reference](../reference/alpha-limitations.md).
