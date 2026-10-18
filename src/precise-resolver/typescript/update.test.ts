/**
 * The incremental update and the warm start (plan 03-29, TSM-06): the client tells the worker which paths changed, the worker
 * rebuilds only the programs those paths belong to, reusing the old program and re-reading only the changed files, and a Tenant
 * that starts over an indexed worktree starts the worker in the background. Real workers and the real compiler throughout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, compilerWorkerShape, createRealRunner } from '../../command-runner/index.ts';
import type { CommandRunner, CommandSpec } from '../../command-runner/index.ts';
import { PROTOCOL_VERSION } from '../../facts/index.ts';
import type { Envelope, LocatedSymbol, OverlaySnapshot, PreciseFacts, RefSiteKey, ResolutionContext, ResolvedEdge, SymbolLookup } from '../../facts/index.ts';
import { createGrammarEngine } from '../../grammar-engine/index.ts';
import { createHost } from '../../host/index.ts';
import { createManualEventSource } from '../../indexer/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../../test-kit/index.ts';
import { PROGRAM_EVICT_FRACTION } from './budget.ts';
import { createTypeScriptResolver, resolveWorkerPath } from './index.ts';
import type { TypeScriptResolver, TypeScriptResolverDeps, WireEvent } from './index.ts';

const WORKER = resolveWorkerPath();
const MODULES = path.resolve(import.meta.dirname, '..', '..', '..', 'modules');
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The exact worker shape, and a record of every worker the runner was asked to start. */
interface CountingRunner extends CommandRunner {
  readonly workers: CommandSpec[];
}

function countingRunner(inner: CommandRunner = createRealRunner({ builtinShapes: [compilerWorkerShape({ execPath: process.execPath, workerPath: WORKER })] })): CountingRunner {
  const workers: CommandSpec[] = [];
  const note = (spec: CommandSpec): void => {
    if (spec.builtinId === 'typescript-resolver') workers.push(spec);
  };
  return {
    workers,
    run: (spec, ctx) => {
      note(spec);
      return inner.run(spec, ctx);
    },
    stream: (spec, ctx) => {
      note(spec);
      return inner.stream(spec, ctx);
    },
  };
}

const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);
const LIB = 'export function compute(n: number): number {\n  return n + 1;\n}\n';
// `lib.added` does not exist yet: the site `added` resolves to nothing until the library gains it.
const USER = "import { compute } from './lib.cjs';\nimport * as lib from './lib.cjs';\nimport * as other from './other.cjs';\n\nexport function run(): number {\n  return compute(1) + lib.added(2) + other.twice(3);\n}\n";
const OTHER = 'export function twice(n: number): number {\n  return n * 2;\n}\n';
const FIXTURE: Readonly<Record<string, string>> = { 'tsconfig.json': TSCONFIG, 'src/lib.cts': LIB, 'src/user.cts': USER, 'src/other.cts': OTHER };

const span = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ startLine, startColumn, endLine, endColumn });

/**
 * The store's lookup for the project on disk: each `function name(...) { ... }` of a file with the extent the grammar tier stores
 * (from the keyword `function`, which leaves out `export`, to the closing brace). A symbol that is not the declaration maps to
 * nothing, so a lookup that claims a span for everything would hide the answers these tests are about.
 */
function functionsOn(dir: string): SymbolLookup {
  return {
    find: async () => [],
    findIn: async (p, name) => {
      const file = path.join(dir, p);
      if (!fs.existsSync(file)) return [];
      const text = fs.readFileSync(file, 'utf8');
      const found: LocatedSymbol[] = [];
      const keyword = new RegExp(`function\\s+${name}\\b`, 'g');
      for (let match = keyword.exec(text); match !== null; match = keyword.exec(text)) {
        const open = text.indexOf('{', match.index);
        let depth = 0;
        let close = open;
        for (let at = open; at < text.length; at += 1) {
          if (text[at] === '{') depth += 1;
          if (text[at] === '}') depth -= 1;
          if (depth === 0) {
            close = at;
            break;
          }
        }
        const position = (offset: number): [number, number] => {
          const before = text.slice(0, offset).split('\n');
          return [before.length - 1, (before[before.length - 1] ?? '').length];
        };
        const [startLine, startColumn] = position(match.index);
        const [endLine, endColumn] = position(close + 1);
        found.push({ repo: 'r', path: p, qualifiedName: name, kind: 'function', span: span(startLine, startColumn, endLine, endColumn) });
      }
      return found;
    },
  };
}

/** The site of the first `name(` call in `file`'s text: row, column of the identifier. */
function siteIn(file: string, text: string, name: string): RefSiteKey {
  const lines = text.split('\n');
  const row = lines.findIndex((line) => line.includes(`${name}(`));
  assert.ok(row >= 0, `${name}( is in ${file}`);
  const column = (lines[row] ?? '').indexOf(`${name}(`);
  return { path: file, span: span(row, column, row, column + name.length), name };
}

const SITE_COMPUTE = siteIn('src/user.cts', USER, 'compute');
const SITE_ADDED = siteIn('src/user.cts', USER, 'added');
const SITE_TWICE = siteIn('src/user.cts', USER, 'twice');

function factsFor(configs: readonly string[] = ['tsconfig.json']): PreciseFacts {
  return {
    ownerOf: (p) => (/\.[cm]?[jt]sx?$/.test(p) && configs.length > 0 ? (configs.length === 1 ? configs[0] : configs.find((config) => p.startsWith(`${path.posix.dirname(config)}/`))) : undefined),
    requiresOwner: (p) => /\.(?:[cm]?ts|tsx)$/.test(p),
    compiler: { source: 'bundled', version: '6.0.3', reason: 'no project compiler', case: 'none' },
    configs,
  };
}

const contextOf = (id: string, configHashes: readonly string[] = []): ResolutionContext => ({ id, configHashes: [...configHashes] });

function writeProject(files: Readonly<Record<string, string>>): { readonly dir: string; write(rel: string, text: string): void; remove(rel: string): void; cleanup(): void } {
  const tmp = makeTempDir();
  const dir = realPath(tmp.path);
  const write = (rel: string, text: string): void => {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return { dir, write, remove: (rel) => fs.rmSync(path.join(dir, rel)), cleanup: () => tmp.cleanup() };
}

const cleanups: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Rig {
  readonly project: ReturnType<typeof writeProject>;
  readonly resolver: TypeScriptResolver;
  readonly wire: WireEvent[];
  readonly runner: CountingRunner;
  /** The overlay the next read is given: the hash of every path, changed by `touch`. */
  readonly hashes: Map<string, string>;
  /** One read: the targets (by path) of each requested site, in a map keyed by the site's name. */
  read(sites: readonly RefSiteKey[], context?: ResolutionContext, facts?: PreciseFacts): Promise<Map<string, string[]>>;
  /** Mark `rel` as changed in the overlay (a new hash), as the Indexer would after it stored the new version. */
  touch(rel: string): void;
  updates(): Array<{ readonly changed: readonly string[]; readonly removed: readonly string[] }>;
  /** The `reads` the worker reported for the request that followed the `n`-th (1-based) message of kind `t`. */
  readsAfterUpdate(): number | undefined;
  lastDone(): { readonly programs?: number; readonly reads?: number; readonly rssMb?: number } | undefined;
}

function rig(files: Readonly<Record<string, string>> = FIXTURE, deps: Partial<TypeScriptResolverDeps> = {}, facts: PreciseFacts = factsFor()): Rig {
  const project = writeProject(files);
  cleanups.push(() => project.cleanup());
  const wire: WireEvent[] = [];
  const runner = countingRunner();
  const resolver = createTypeScriptResolver({ runner, worktree: project.dir, project: () => facts, onWire: (event) => wire.push(event), ...deps });
  cleanups.push(() => resolver.close());
  const hashes = new Map<string, string>(Object.keys(files).map((rel) => [rel, `h0:${rel}`]));
  let version = 0;
  return {
    project,
    resolver,
    wire,
    runner,
    hashes,
    async read(sites, context = contextOf('ctx-1'), given = facts) {
      const overlay: OverlaySnapshot = { id: `overlay-${String((version += 1))}`, pathToHash: new Map(hashes) };
      const targets = new Map<string, string[]>();
      for await (const item of resolver.resolveScoped(given, overlay, context, sites, functionsOn(project.dir))) {
        if ('kind' in item && item.kind === 'notice') continue;
        const edge = item as ResolvedEdge;
        const list = targets.get(edge.site.name) ?? [];
        list.push(edge.target.path);
        targets.set(edge.site.name, list);
      }
      return targets;
    },
    touch(rel) {
      hashes.set(rel, `h${String((version += 1))}:${rel}`);
    },
    updates() {
      return wire.flatMap((event) => (event.dir === 'out' && event.message.t === 'update' ? [{ changed: event.message.changed, removed: event.message.removed }] : []));
    },
    readsAfterUpdate() {
      const at = wire.findIndex((event) => event.dir === 'out' && event.message.t === 'update');
      if (at < 0) return undefined;
      // The update itself is acknowledged first; the rebuild happens in the request that uses the program.
      for (const event of wire.slice(at + 1)) {
        if (event.dir === 'in' && event.message.t === 'done' && event.message.reads !== undefined && event.message.asked > 0) return event.message.reads;
      }
      return undefined;
    },
    lastDone() {
      for (let at = wire.length - 1; at >= 0; at -= 1) {
        const event = wire[at];
        if (event?.dir === 'in' && event.message.t === 'done') return event.message;
      }
      return undefined;
    },
  };
}

describe('the incremental update (TSM-06, T-03-254)', () => {
  it('update sends only changed paths: one message listing exactly the file that changed, before the resolve, and the answer reflects the new code', async () => {
    const r = rig();
    const first = await r.read([SITE_COMPUTE, SITE_ADDED, SITE_TWICE]);
    assert.deepStrictEqual(first.get('compute'), ['src/lib.cts']);
    assert.equal(first.get('added'), undefined, 'the library has no `added` yet');
    assert.deepStrictEqual(first.get('twice'), ['src/other.cts']);
    assert.deepStrictEqual(r.updates(), [], 'the first read has nothing to tell the worker');

    // Rename `compute` and add the exported `added` that user.cts already calls.
    r.project.write('src/lib.cts', 'export function computeNext(n: number): number {\n  return n + 1;\n}\nexport function added(n: number): number {\n  return n;\n}\n');
    r.touch('src/lib.cts');
    const second = await r.read([SITE_COMPUTE, SITE_ADDED, SITE_TWICE]);
    assert.deepStrictEqual(r.updates(), [{ changed: ['src/lib.cts'], removed: [] }]);
    const kinds = r.wire.filter((event) => event.dir === 'out').map((event) => event.message.t);
    assert.deepStrictEqual(kinds.slice(-2), ['update', 'resolve'], 'the update goes first');
    assert.equal(second.get('compute'), undefined, 'the renamed function resolves to nothing');
    assert.deepStrictEqual(second.get('added'), ['src/lib.cts'], 'the new function resolves');
    assert.deepStrictEqual(second.get('twice'), ['src/other.cts'], 'an unchanged file still resolves');
    assert.equal(r.runner.workers.length, 1, 'one worker for the whole session');
  });

  it('worker re-reads only changed files: the rebuild reads one source file, not the project', async () => {
    const r = rig();
    await r.read([SITE_COMPUTE, SITE_ADDED, SITE_TWICE]);
    const coldReads = r.lastDone()?.reads;
    assert.ok(coldReads !== undefined && coldReads >= 4, `the first program reads the project and the libraries: ${String(coldReads)}`);
    r.project.write('src/lib.cts', `// edited\n${LIB}`);
    r.touch('src/lib.cts');
    await r.read([SITE_COMPUTE]);
    assert.equal(r.readsAfterUpdate(), 1, 'only src/lib.cts was read again');
    assert.equal(r.lastDone()?.programs, 1);
  });

  it('removed file: its path is listed under removed and a site that referenced it no longer resolves to it', async () => {
    const r = rig();
    assert.deepStrictEqual((await r.read([SITE_TWICE])).get('twice'), ['src/other.cts']);
    r.project.remove('src/other.cts');
    r.hashes.delete('src/other.cts');
    const after = await r.read([SITE_TWICE]);
    assert.deepStrictEqual(r.updates(), [{ changed: [], removed: ['src/other.cts'] }]);
    assert.equal(after.get('twice'), undefined, 'the removed file is no declaration any more');
  });

  it('a file added to the project is found: a new path under include is read and a site that needs it resolves', async () => {
    const userText = "import * as third from './third.cjs';\n\nexport const out = third.go(1);\n";
    const r = rig({ 'tsconfig.json': TSCONFIG, 'src/user.cts': userText });
    const site = siteIn('src/user.cts', userText, 'go');
    assert.equal((await r.read([site])).get('go'), undefined, 'there is no third.cts yet');
    r.project.write('src/third.cts', 'export function go(n: number): number {\n  return n;\n}\n');
    r.hashes.set('src/third.cts', 'h-third');
    const after = await r.read([site]);
    assert.deepStrictEqual(r.updates(), [{ changed: ['src/third.cts'], removed: [] }]);
    assert.deepStrictEqual(after.get('go'), ['src/third.cts'], 'the unchanged importer resolves the module that now exists');
  });

  it('no update when nothing changed: reads over an unchanged overlay, and a changed hash of a file that is not a compiler source, send nothing', async () => {
    const r = rig({ ...FIXTURE, 'README.md': '# readme\n' });
    await r.read([SITE_COMPUTE]);
    await r.read([SITE_COMPUTE]);
    r.touch('README.md');
    await r.read([SITE_COMPUTE]);
    assert.deepStrictEqual(r.updates(), []);
    const out = r.wire.filter((event) => event.dir === 'out').map((event) => event.message.t);
    assert.ok(!out.includes('update'));
  });

  it('a path outside every program is ignored without error: the worker answers and rebuilds nothing', async () => {
    const r = rig({ ...FIXTURE, 'scripts/tool.cjs': 'module.exports = 1;\n' });
    assert.deepStrictEqual((await r.read([SITE_TWICE])).get('twice'), ['src/other.cts']);
    r.touch('scripts/tool.cjs');
    const again = await r.read([SITE_TWICE]);
    assert.deepStrictEqual(r.updates(), [{ changed: ['scripts/tool.cjs'], removed: [] }], 'the client lists it; the worker decides it belongs to no program');
    assert.deepStrictEqual(again.get('twice'), ['src/other.cts']);
    assert.equal(r.runner.workers.length, 1);
    assert.equal(r.readsAfterUpdate(), 0, 'no source file was read for it');
  });

  it('an update for a program the worker does not hold marks nothing and the program is built fresh when it is needed', async () => {
    const files = {
      'a/tsconfig.json': TSCONFIG,
      'a/src/lib.cts': LIB,
      'a/src/user.cts': "import { compute } from './lib.cjs';\nexport const out = compute(1);\n",
      'b/tsconfig.json': TSCONFIG,
      'b/src/lib.cts': LIB,
      'b/src/user.cts': "import { compute } from './lib.cjs';\nexport const out = compute(1);\n",
    };
    const facts = factsFor(['a/tsconfig.json', 'b/tsconfig.json']);
    const r = rig(files, {}, facts);
    const siteA = siteIn('a/src/user.cts', files['a/src/user.cts'], 'compute');
    const siteB = siteIn('b/src/user.cts', files['b/src/user.cts'], 'compute');
    assert.deepStrictEqual((await r.read([siteA], contextOf('ctx-1'), facts)).get('compute'), ['a/src/lib.cts']);
    // Program b was never built: the edit of its library is only a hash difference the worker has nothing to apply to.
    r.project.write('b/src/lib.cts', 'export function computeB(n: number): number {\n  return n;\n}\n');
    r.touch('b/src/lib.cts');
    assert.deepStrictEqual((await r.read([siteA], contextOf('ctx-1'), facts)).get('compute'), ['a/src/lib.cts']);
    assert.equal(r.lastDone()?.programs, 1, 'still the one program of a');
    const b = await r.read([siteB], contextOf('ctx-1'), facts);
    assert.equal(b.get('compute'), undefined, 'b is built from the files as they are now');
  });

  it('a config whose hash changed is read again: the program follows the new include', async () => {
    const useText = "import { compute } from '../src/lib.cjs';\nexport const out = compute(1);\n";
    const files = { ...FIXTURE, 'extra/use.cts': useText };
    const r = rig(files);
    const site = siteIn('extra/use.cts', useText, 'compute');
    assert.equal((await r.read([site], contextOf('ctx-1', ['aa']))).get('compute'), undefined, 'extra/ is not in the config yet');
    r.project.write('tsconfig.json', TSCONFIG.replace('"src"', '"src", "extra"'));
    const after = await r.read([site], contextOf('ctx-1', ['bb']));
    assert.deepStrictEqual(r.updates(), [{ changed: ['tsconfig.json'], removed: [] }]);
    assert.deepStrictEqual(after.get('compute'), ['src/lib.cts']);
  });

  it('old program dropped under pressure: past 70 percent of the limit the rebuild starts from scratch, and the answer is still right', async () => {
    // Calibrate on this machine: the worker's resident memory after one program, with room to spare.
    const calibrate = rig(FIXTURE, { rssLimitMb: 16_384, sampleMs: 3_600_000 });
    await calibrate.read([SITE_COMPUTE]);
    const rss = calibrate.resolver.info()?.lastRssMb ?? 0;
    assert.ok(rss > 0);
    await calibrate.resolver.close();
    // A limit just above it: the process is over 70 percent of the limit once the program is built, and below the limit itself.
    const limitMb = Math.ceil((rss * 1.1));
    assert.ok(rss > limitMb * PROGRAM_EVICT_FRACTION);
    const r = rig(FIXTURE, { rssLimitMb: limitMb, sampleMs: 3_600_000 });
    assert.deepStrictEqual((await r.read([SITE_COMPUTE, SITE_ADDED])).get('compute'), ['src/lib.cts']);
    r.project.write('src/lib.cts', 'export function computeNext(n: number): number {\n  return n;\n}\nexport function added(n: number): number {\n  return n;\n}\n');
    r.touch('src/lib.cts');
    const after = await r.read([SITE_COMPUTE, SITE_ADDED]);
    assert.equal(after.get('compute'), undefined);
    assert.deepStrictEqual(after.get('added'), ['src/lib.cts']);
    const reads = r.readsAfterUpdate();
    assert.ok(reads !== undefined && reads > 1, `the old program was dropped, so the project was read again: ${String(reads)}`);
    assert.equal(r.lastDone()?.programs, 1, 'one program, the new one');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The warm start, through a Host: a Tenant over a worktree that is already indexed starts the worker in the background.

interface World {
  ask(kind: string, args?: unknown): Promise<Envelope>;
  readonly runner: CountingRunner;
  readonly repoDir: string;
  write(rel: string, text: string): void;
  /** Close this Host and open another over the same repository and store (a new process). */
  restart(next?: { readonly runner?: CountingRunner }): Promise<void>;
}

async function makeWorld(t: TestContext, files: Readonly<Record<string, string>>, inner?: CommandRunner): Promise<World> {
  const repo = await createTempGitRepo({ runner: createRealRunner({ decide: allowAll }), world: { committed: files } });
  const tmp = makeTempDir();
  const engine = createGrammarEngine();
  let runner = countingRunner(inner);
  let host = open(runner);
  function open(using: CountingRunner) {
    return createHost({
      roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: MODULES, npmRoots: [] },
      engine,
      runner: using,
      cwd: repo.dir,
      userDir: path.join(tmp.path, 'user'),
      cacheRoot: path.join(tmp.path, 'cache'),
      gitEnv: repo.envOverlay,
      eventSource: () => createManualEventSource().source,
      metrics: false,
      knownAdapters: ['typescript'],
    });
  }
  t.after(async () => {
    await host.close();
    await engine.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  const world: World = {
    ask: (kind, args) => host.handle({ protocol: PROTOCOL_VERSION, kind, ...(args === undefined ? {} : { args }) }),
    get runner() {
      return runner;
    },
    repoDir: repo.dir,
    write: (rel, text) => repo.write(rel, text),
    async restart(next) {
      await host.close();
      runner = next?.runner ?? countingRunner();
      host = open(runner);
    },
  };
  return world;
}

const refRows = (envelope: Envelope): Array<{ path: string; tier: string }> => (envelope.data as { results: Array<{ path: string; tier: string }> }).results;

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < until, `timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe('the warm start (Pitfall 5)', () => {
  const HOST_FILES: Readonly<Record<string, string>> = {
    'tsconfig.json': TSCONFIG,
    'src/lib.cts': LIB,
    'src/user.cts': "import { compute } from './lib.cjs';\n\nexport function run(): number {\n  return compute(1);\n}\n",
  };

  it('warm start: a Tenant over an indexed worktree starts the worker before any question asks the compiler, and the first question needs no second start', async (t) => {
    const world = await makeWorld(t, HOST_FILES);
    assert.equal((await world.ask('build')).ok, true);
    // A new process: the file changed meanwhile, so the start-up Reconcile makes every cached answer a miss.
    world.write('src/lib.cts', `// edited\n${LIB}`);
    await world.restart();
    assert.equal(world.runner.workers.length, 0, 'nothing has started yet');
    const found = await world.ask('code_find', { name: 'compute' });
    assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
    await waitFor(() => world.runner.workers.length === 1, 'the warm worker to start');
    const refs = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    assert.equal(refs.ok, true, JSON.stringify(refs.diagnostics));
    assert.equal((refs.degraded ?? []).includes('resolver_timeout'), false, JSON.stringify(refs.degraded));
    assert.equal(refRows(refs).filter((row) => row.path === 'src/user.cts').every((row) => row.tier === 'precise'), true, JSON.stringify(refRows(refs)));
    assert.equal(world.runner.workers.length, 1, 'the question used the worker the Tenant had warmed');
  });

  it('warm failure is silent: a worker that cannot start leaves no output on stdout or stderr and the first question behaves as it did before', async (t) => {
    const world = await makeWorld(t, HOST_FILES);
    assert.equal((await world.ask('build')).ok, true);
    let failed = false;
    const broken: CommandRunner = {
      run: (spec, ctx) => inner().run(spec, ctx),
      stream(spec, ctx) {
        if (failed || spec.builtinId !== 'typescript-resolver') return inner().stream(spec, ctx);
        failed = true;
        return {
          stdout: (async function* (): AsyncGenerator<Uint8Array> {})(),
          result: Promise.resolve({ ok: false, exitCode: 1, signal: null, stdout: new Uint8Array(0), stderr: new Uint8Array(0), truncated: false, timedOut: false, diagnostics: [] }),
          kill() {},
        };
      },
    };
    const real = createRealRunner({ builtinShapes: [compilerWorkerShape({ execPath: process.execPath, workerPath: WORKER })] });
    function inner(): CommandRunner {
      return real;
    }
    world.write('src/lib.cts', `// edited\n${LIB}`);
    const written: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    // Everything is passed on; what a failed warm start would say (the typed failure, the worker's words, the marker names) is kept.
    const LEAK = /stopped before it answered|compiler worker|resolver_failed|ResolverFailure|GSD_ATLAS|typescript worker/i;
    const spy = (forward: (chunk: never) => boolean) => (chunk: unknown): boolean => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      if (LEAK.test(text)) written.push(text);
      return forward(chunk as never);
    };
    await world.restart({ runner: countingRunner(broken) });
    process.stdout.write = spy(originalOut as (chunk: never) => boolean) as typeof process.stdout.write;
    process.stderr.write = spy(originalErr as (chunk: never) => boolean) as typeof process.stderr.write;
    try {
      const found = await world.ask('code_find', { name: 'compute' });
      assert.equal(found.ok, true, JSON.stringify(found.diagnostics));
      await waitFor(() => world.runner.workers.length >= 1, 'the warm start to be attempted');
      await sleep(200);
    } finally {
      process.stdout.write = originalOut as typeof process.stdout.write;
      process.stderr.write = originalErr as typeof process.stderr.write;
    }
    assert.deepStrictEqual(written, [], 'nothing about the failed warm start reached stdout or stderr');
    // The first question behaves as before: it starts a worker of its own and is answered.
    const refs = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    assert.equal(refs.ok, true, JSON.stringify(refs.diagnostics));
    for (let again = 0; again < 8 && (refs.degraded ?? []).includes('resolver_timeout'); again += 1) await sleep(300);
    assert.equal(world.runner.workers.length, 2, 'the failed warm start, then the start of the first question');
  });
});
