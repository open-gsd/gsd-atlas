# Index a repository and ask it questions

In this tutorial we will build gsd-atlas, index a small repository of our own, and ask where a function is defined, who uses it and what would break if we changed it. At the end we will save a new file and see the next question find it.

Everything happens in two folders side by side: `gsd-atlas`, the program, and `atlas-demo`, a scratch repository we create. gsd-atlas keeps its index inside `atlas-demo/.git`, so none of our files or history change. The commands below work in a POSIX shell, in PowerShell and in the Windows command prompt.

## Step 1: check Node

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

```json
{"schema":"gsd-atlas.build/1","ok":true,"data":{"worktree":"/path/to/atlas-demo","files":2,"parsed":2,"linked":0,"removed":0,"skipped":0,"failed":0,"failedCodes":{}},"diagnostics":[]}
```

Notice that `ok` is `true` and `files` is 2: the two files we wrote are indexed. The path in `worktree` is your own.

## Step 5: ask where a function is defined

Now ask where `parseConfig` is defined:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js find parseConfig
```

The output should look like this. The `nonce` differs on every answer, so yours will not match it:

```json
{"schema":"gsd-atlas.code-find/1","ok":true,"data":{"results":[{"name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"col":8,"exported":true,"confidence":"EXTRACTED","citation":"c1"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/config.ts","line":6,"col":8,"endLine":9,"endCol":2,"confidence":"EXTRACTED","debug":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","text_ref":"ut1"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"36e7042184cf77cacc54e61bbd8e406f","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-36e7042184cf77cacc54e61bbd8e406f\nexport function parseConfig(text: string): Config {\nEND-UNTRUSTED-36e7042184cf77cacc54e61bbd8e406f"}]}}
```

Notice three things. The answer is cited: citation `c1` gives the path `src/config.ts`, line 6 and column 8. Its `confidence` is `EXTRACTED`, because a definition is read straight from the file. And the source line itself arrives in `untrusted_text`, between the `BEGIN-UNTRUSTED` and `END-UNTRUSTED` lines that carry the nonce. The long hexadecimal id in `debug` depends on the exact bytes of your file, so it matches ours only if your file does.

## Step 6: ask who uses it and what depends on it

Now ask who refers to `parseConfig`:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js refs parseConfig
```

```json
{"schema":"gsd-atlas.code-refs/1","ok":true,"data":{"targets":[{"name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"handle":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3"}],"results":[{"target":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","path":"src/main.ts","line":4,"col":18,"kind":"call","enclosing":"start","tier":"grammar","confidence":"INFERRED","ambiguous":false,"candidates":1,"citation":"c1"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/main.ts","line":4,"col":18,"endLine":4,"endCol":29,"confidence":"INFERRED","debug":"ref/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut1"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"1af5445ac3811bf7401c96efab3a6a43","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-1af5445ac3811bf7401c96efab3a6a43\n  const config = parseConfig(text);\nEND-UNTRUSTED-1af5445ac3811bf7401c96efab3a6a43"}]}}
```

Notice that the one reference is a `call` inside `start`, in `src/main.ts` at line 4. Its `confidence` is `INFERRED`: the match was made by name, and gsd-atlas says so.

Now ask what surrounds the function:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js context parseConfig
```

```json
{"schema":"gsd-atlas.code-context/1","ok":true,"data":{"results":[{"section":"definition","name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"col":8,"exported":true,"confidence":"EXTRACTED","citation":"c1"},{"section":"export","name":"Config","kind":"export","path":"src/config.ts","line":1,"col":1,"local":"Config","confidence":"EXTRACTED","citation":"c2"},{"section":"export","name":"parseConfig","kind":"export","path":"src/config.ts","line":6,"col":1,"local":"parseConfig","confidence":"EXTRACTED","citation":"c3"},{"section":"reference","name":"parseConfig","kind":"call","path":"src/main.ts","line":4,"col":18,"target":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","enclosing":"start","tier":"grammar","confidence":"INFERRED","ambiguous":false,"candidates":1,"citation":"c4"}],"alternatives":[]},"diagnostics":[],"citations":[{"id":"c1","path":"src/config.ts","line":6,"col":8,"endLine":9,"endCol":2,"confidence":"EXTRACTED","debug":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","text_ref":"ut1"},{"id":"c2","path":"src/config.ts","line":1,"col":1,"endLine":4,"endCol":2,"confidence":"EXTRACTED","debug":"exp/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/0","text_ref":"ut2"},{"id":"c3","path":"src/config.ts","line":6,"col":1,"endLine":9,"endCol":2,"confidence":"EXTRACTED","debug":"exp/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/1","text_ref":"ut3"},{"id":"c4","path":"src/main.ts","line":4,"col":18,"endLine":4,"endCol":29,"confidence":"INFERRED","debug":"ref/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut4"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"c2b43b1ff3e2267e59d33cbd3859b615","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615\nexport function parseConfig(text: string): Config {\nEND-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615"},{"ref":"ut2","text":"BEGIN-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615\nexport interface Config {\nEND-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615"},{"ref":"ut3","text":"BEGIN-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615\nexport function parseConfig(text: string): Config {\nEND-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615"},{"ref":"ut4","text":"BEGIN-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615\n  const config = parseConfig(text);\nEND-UNTRUSTED-c2b43b1ff3e2267e59d33cbd3859b615"}]}}
```

Notice that `results` is one list, and each item has a `section`: the `definition`, the `export` entries of its file and the `reference` we just saw.

Finally, ask what would break if we changed `parseConfig`:

```sh
node ../gsd-atlas/dist/bin/gsd-atlas.js impact parseConfig
```

```json
{"schema":"gsd-atlas.code-impact/1","ok":true,"data":{"seeds":[{"name":"parseConfig","kind":"function","path":"src/config.ts","line":6,"handle":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3"}],"results":[{"hop":1,"via":"call","kind":"function","name":"start","path":"src/main.ts","line":3,"col":8,"confidence":"INFERRED","chain_confidence":"INFERRED","handle":"sym/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","from":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","citation":"c1"},{"hop":1,"via":"import","kind":"file","name":"src/main.ts","path":"src/main.ts","line":1,"col":1,"confidence":"EXTRACTED","chain_confidence":"EXTRACTED","handle":"imp/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","from":"sym/src%2Fconfig.ts/5be21c1961bd854a67afb280adcbb8d86f2f0460/3","citation":"c2"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/main.ts","line":3,"col":8,"endLine":6,"endCol":2,"confidence":"INFERRED","debug":"sym/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut1"},{"id":"c2","path":"src/main.ts","line":1,"col":1,"endLine":1,"endCol":43,"confidence":"EXTRACTED","debug":"imp/src%2Fmain.ts/99b83294d51bd78aafe182ef98363a7c13992586/0","text_ref":"ut2"}],"watermark":{"seq":3,"stalePaths":[]},"untrusted_text":{"nonce":"8649c4506db709ecb3d7ad2c439ad545","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-8649c4506db709ecb3d7ad2c439ad545\nexport function start(text: string): string {\nEND-UNTRUSTED-8649c4506db709ecb3d7ad2c439ad545"},{"ref":"ut2","text":"BEGIN-UNTRUSTED-8649c4506db709ecb3d7ad2c439ad545\nimport { parseConfig } from \"./config.ts\";\nEND-UNTRUSTED-8649c4506db709ecb3d7ad2c439ad545"}]}}
```

Notice that two things at distance one hop depend on `parseConfig`: the function `start`, which calls it, and the file `src/main.ts`, which imports it. Each item carries `chain_confidence`, the confidence of the whole path from `parseConfig`.

## Step 7: save a new file and ask again

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

```json
{"schema":"gsd-atlas.code-find/1","ok":true,"data":{"results":[{"name":"JobQueue","kind":"class","path":"src/queue.ts","line":1,"col":8,"exported":true,"confidence":"EXTRACTED","citation":"c1"}]},"diagnostics":[],"citations":[{"id":"c1","path":"src/queue.ts","line":1,"col":8,"endLine":7,"endCol":2,"confidence":"EXTRACTED","debug":"sym/src%2Fqueue.ts/1cc096c07663be2eab21aa3eb18d17ec8e570f0e/0","text_ref":"ut1"}],"watermark":{"seq":4,"stalePaths":[]},"untrusted_text":{"nonce":"0088e475bfbacc26f533eeff61155454","entries":[{"ref":"ut1","text":"BEGIN-UNTRUSTED-0088e475bfbacc26f533eeff61155454\nexport class JobQueue {\nEND-UNTRUSTED-0088e475bfbacc26f533eeff61155454"}]}}
```

Notice that the new class is found, a `class` this time, and that we did not run `build` again. The `seq` in `watermark` went from 3 to 4: the index recorded our change.

We have built an index, asked it all four kinds of question and watched it follow our edit. Well done.

## Next

- Register the server with your coding agent: [How to register the MCP server with Claude Code, Cursor and Codex](../how-to/register-the-mcp-server.md).
- Look up every command and option: [the CLI reference](../reference/cli.md).
- Find out why the index stays current and why only one process may write to it: [About how freshness and the writer lease work](../explanation/how-freshness-and-the-writer-lease-work.md).
