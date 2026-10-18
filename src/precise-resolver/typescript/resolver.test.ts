/**
 * The TypeScript precise tier end to end (plan 03-23): a real Host over a temporary git repository, the real runner with the
 * exact worker shape, the real worker file run by Node's type stripping and the bundled compiler. Plus the identity mapping,
 * the PreciseResolver contract suite and the compiler, memory, notice and wiring cases of Task 2.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, compilerWorkerShape, createRealRunner } from '../../command-runner/index.ts';
import type { CommandRunner } from '../../command-runner/index.ts';
import { PROTOCOL_VERSION } from '../../facts/index.ts';
import type { Envelope, LocatedSymbol, OverlaySnapshot, PreciseFacts, RefSiteKey, ResolutionContext, SymbolLookup } from '../../facts/index.ts';
import { createGrammarEngine } from '../../grammar-engine/index.ts';
import { createHost } from '../../host/index.ts';
import type { Host, HostOptions } from '../../host/index.ts';
import { createManualEventSource } from '../../indexer/index.ts';
import { createTempGitRepo, makeTempDir, realPath } from '../../test-kit/index.ts';
import type { TempDir, TempGitRepo } from '../../test-kit/index.ts';
import { definePreciseResolverContract } from '../contract.ts';
import type { PreciseResolverSubject } from '../contract.ts';
import { createTypeScriptResolver, createTypeScriptTier, mapTarget, resolveWorkerPath } from './index.ts';
import type { PreciseTier, TypeScriptResolver } from './index.ts';

const MODULES = path.resolve(import.meta.dirname, '..', '..', '..', 'modules');
const WORKER = resolveWorkerPath();
const setupRunner = createRealRunner({ decide: allowAll });

const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);

const LIB = [
  'export function compute(n: number): number {',
  '  return n + 1;',
  '}',
  '',
  'export class Base {',
  '  greet(): string {',
  "    return 'hi';",
  '  }',
  '}',
  '',
  'export function useBase(): string {',
  '  return new Base().greet();',
  '}',
  '',
].join('\n');

const USER = [
  "import { compute } from './lib.cjs';",
  "import { compute as calc } from './lib.cjs';",
  "import * as lib from './lib.cjs';",
  "import * as other from './other.cjs';",
  '',
  'export function run(): number {',
  '  return compute(1) + calc(2) + other.compute(3);',
  '}',
  '',
  'export const keep = lib;',
  '',
].join('\n');

const OTHER = ['export function compute(n: number): number {', '  return n * 2;', '}', ''].join('\n');

/** The fixture project: a library, a user with an alias import and a namespace member call, and an unrelated `compute`. */
export const FIXTURE: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'src/lib.cts': LIB,
  'src/user.cts': USER,
  'src/other.cts': OTHER,
};

export interface World {
  readonly host: Host;
  readonly repo: TempGitRepo;
  readonly tmp: TempDir;
  readonly runner: CommandRunner;
  /** The precise tier the Host built, once a tenant exists. */
  tier(): PreciseTier | undefined;
  ask(kind: string, args?: unknown): Promise<Envelope>;
  build(): Promise<Envelope>;
  close(): Promise<void>;
}

export interface WorldOptions {
  readonly host?: Partial<HostOptions>;
  /** Runner options for the worker's environment tests. */
  readonly runner?: CommandRunner;
  /** Files written to the working tree after the commit (a string edits or adds, null deletes). */
  readonly working?: Readonly<Record<string, string | null>>;
  /**
   * Wire the tier through the test-only `resolverFactory` hook instead of the module manifest (the tracer of Task 1): the
   * Host's tier table is not involved. Default false: the manifest names the adapter and the Host builds the tier.
   */
  readonly hook?: boolean;
}

export function workerRunner(env?: Readonly<Record<string, string | undefined>>): CommandRunner {
  return createRealRunner({
    builtinShapes: [compilerWorkerShape({ execPath: process.execPath, workerPath: WORKER })],
    ...(env === undefined ? {} : { env }),
  });
}

/** A real repository, a Host over it with the TypeScript tier known, and everything cleaned up when the test ends. */
export async function makeWorld(t: TestContext, files: Readonly<Record<string, string>> = FIXTURE, options: WorldOptions = {}): Promise<World> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: files, ...(options.working === undefined ? {} : { working: options.working }) } });
  const tmp = makeTempDir();
  const engine = createGrammarEngine();
  const runner = options.runner ?? workerRunner();
  let tier: PreciseTier | undefined;
  const hooked = options.hook === true ? createTypeScriptTier({ runner }) : undefined;
  if (hooked !== undefined) tier = hooked;
  const hostOptions: HostOptions = {
    roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: MODULES, npmRoots: [] },
    engine,
    runner,
    cwd: repo.dir,
    userDir: path.join(tmp.path, 'user'),
    cacheRoot: path.join(tmp.path, 'cache'),
    gitEnv: repo.envOverlay,
    eventSource: () => createManualEventSource().source,
    metrics: false,
    ...(hooked === undefined
      ? {
          knownAdapters: ['typescript'],
          tierHook: (built: PreciseTier) => {
            tier = built;
          },
        }
      : { resolverFactory: () => hooked.resolver }),
    ...options.host,
  };
  const host = createHost(hostOptions);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await host.close();
    await hooked?.close();
    await engine.dispose();
    tmp.cleanup();
    repo.cleanup();
  };
  t.after(close);
  const ask = (kind: string, args?: unknown): Promise<Envelope> => host.handle({ protocol: PROTOCOL_VERSION, kind, ...(args === undefined ? {} : { args }) });
  return { host, repo, tmp, runner, tier: () => tier, ask, build: () => ask('build'), close };
}

interface RefRow {
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly tier: string;
  readonly confidence: string;
  readonly [key: string]: unknown;
}

export const refRows = (envelope: Envelope): RefRow[] => (envelope.data as { results: RefRow[] }).results;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `code_refs` until the answer has no `resolver_timeout`: the first precise read after a start may exceed
 * `query.resolveTimeoutMs` (the worker keeps running and fills the cache), so the answer that matters is the next one.
 */
export async function refsSettled(world: World, args: unknown, maxReads = 12): Promise<{ readonly envelope: Envelope; readonly reads: number }> {
  let envelope = await world.ask('code_refs', args);
  for (let reads = 1; reads < maxReads; reads += 1) {
    if (!(envelope.degraded ?? []).includes('resolver_timeout')) return { envelope, reads };
    await sleep(300);
    envelope = await world.ask('code_refs', args);
  }
  return { envelope, reads: maxReads };
}

const at = (rows: readonly RefRow[], file: string): RefRow[] => rows.filter((row) => row.path === file);

describe('TypeScript precise tier: a real worker over a fixture project', () => {
  it('precise refs on a fixture: two call sites in user.cts come back precise and EXTRACTED', async (t) => {
    const world = await makeWorld(t, FIXTURE, { hook: true });
    assert.equal((await world.build()).ok, true);
    const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.equal(envelope.ok, true);
    const inUser = at(refRows(envelope), 'src/user.cts');
    assert.equal(inUser.length, 2, JSON.stringify(refRows(envelope)));
    for (const row of inUser) {
      assert.equal(row.tier, 'precise');
      assert.equal(row.confidence, 'EXTRACTED');
    }
    // `compute(1)` and `calc(2)` on line 7 (1-based), at columns 10 and 23.
    assert.deepEqual(inUser.map((row) => [row.line, row.col]).sort(), [[7, 10], [7, 23]]);
  });

  it('unrelated same-name function removed: the namespace member call that only matches other.cts by name is gone', async (t) => {
    const control = await makeWorld(t, FIXTURE, { host: { knownAdapters: [] } });
    assert.equal((await control.build()).ok, true);
    const grammar = refRows(await control.ask('code_refs', { name: 'compute', path: 'src/lib.cts' }));
    const colsOf = (rows: readonly RefRow[]): number[] => at(rows, 'src/user.cts').map((row) => row.col).sort((a, b) => a - b);
    // The grammar tier alone over-approximates: it also lists `other.compute(3)` (col 39), reachable through `lib`'s namespace.
    assert.deepEqual(colsOf(grammar), [10, 23, 39], 'the control must show the name-only match');
    assert.ok(at(grammar, 'src/user.cts').every((row) => row.tier === 'grammar'));

    const world = await makeWorld(t, FIXTURE, { hook: true });
    assert.equal((await world.build()).ok, true);
    const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.deepEqual(colsOf(refRows(envelope)), [10, 23]);
  });

  it('a method call in the defining file is precise too (the identity maps to the method symbol)', async (t) => {
    const world = await makeWorld(t, FIXTURE, { hook: true });
    assert.equal((await world.build()).ok, true);
    const { envelope } = await refsSettled(world, { name: 'greet', path: 'src/lib.cts' });
    const rows = at(refRows(envelope), 'src/lib.cts');
    assert.equal(rows.length, 1, JSON.stringify(refRows(envelope)));
    assert.equal(rows[0]?.tier, 'precise');
  });

  it('CRLF BOM emoji U+2028: positions resolve the right declaration', async (t) => {
    const crlf = [
      '﻿import { compute } from "./lib.cjs";',
      'export const note = "line separator";',
      'export function run(): number {',
      '  const smile = "\u{1F600}"; return compute(1) + smile.length;',
      '}',
      '',
    ].join('\r\n');
    const world = await makeWorld(t, { ...FIXTURE, 'src/user.cts': crlf }, { hook: true });
    assert.equal((await world.build()).ok, true);
    const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    const rows = at(refRows(envelope), 'src/user.cts');
    assert.equal(rows.length, 1, JSON.stringify(refRows(envelope)));
    assert.equal(rows[0]?.tier, 'precise');
    assert.equal(rows[0]?.confidence, 'EXTRACTED');
    // Line 4 (1-based): `  const smile = "<emoji>"; return compute(1)` - the emoji is two UTF-16 units, so the column is 1-based 40.
    assert.equal(rows[0]?.line, 4);
    const column = '  const smile = "\u{1F600}"; return '.length + 1;
    assert.equal(rows[0]?.col, column);
  });

  it('stale file yields no edge: a file changed after indexing gives no precise record and no error', async (t) => {
    const world = await makeWorld(t, FIXTURE, { hook: true });
    assert.equal((await world.build()).ok, true);
    // Shift every position by adding a line at the top; the overlay still holds the old positions.
    world.repo.write('src/user.cts', `// a new first line\n${USER}`);
    const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.equal(envelope.ok, true);
    assert.equal((envelope.degraded ?? []).includes('resolver_failed'), false);
    const inUser = at(refRows(envelope), 'src/user.cts');
    assert.ok(inUser.length > 0, 'the grammar tier still lists the sites');
    assert.ok(inUser.every((row) => row.tier === 'grammar'), 'a site whose text moved is not guessed: ' + JSON.stringify(inUser));
  });

  it('second read is precise: the worker is alive between the reads and gone after close', async (t) => {
    const world = await makeWorld(t, FIXTURE, { hook: true });
    assert.equal((await world.build()).ok, true);
    const first = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    // The first answer is either precise or says `resolver_timeout`; it is never a failure.
    assert.equal((first.degraded ?? []).includes('resolver_failed'), false);
    const { envelope: second } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.ok(at(refRows(second), 'src/user.cts').every((row) => row.tier === 'precise'));
    const tier = world.tier();
    assert.ok(tier !== undefined, 'a precise tier was built');
    const [info] = tier.info();
    assert.ok(info?.pid !== undefined, 'the worker reported its pid');
    const pid = info.pid;
    assert.doesNotThrow(() => process.kill(pid, 0), 'the worker is alive between the reads');
    await world.close();
    await waitGone(pid);
  });
});

/** True once no process has `pid`. */
async function waitGone(pid: number, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    assert.ok(Date.now() < until, `process ${String(pid)} is still alive`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Identity mapping (research Pitfall 2), against a scripted lookup.

const span = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({ startLine, startColumn, endLine, endColumn });

function located(qualifiedName: string, s: ReturnType<typeof span>, kind = 'function'): LocatedSymbol {
  return { repo: 'r', path: 'src/lib.cts', qualifiedName, kind, span: s };
}

const lookupOf = (symbols: readonly LocatedSymbol[]): SymbolLookup => ({
  find: async () => [],
  findIn: async (p, name) => symbols.filter((symbol) => symbol.path === p && symbol.qualifiedName.split('.').pop() === name),
});

describe('identity mapping', () => {
  const target = { path: 'src/lib.cts', row: 4, col: 8, name: 'run', kind: 'MethodDeclaration' };

  it('identity innermost: a declaration inside two overlapping grammar symbols maps to the innermost one', async () => {
    const outer = located('run', span(0, 0, 10, 1));
    const inner = located('Box.run', span(3, 2, 6, 3), 'method');
    const identity = await mapTarget(target, lookupOf([outer, inner]));
    assert.equal(identity?.qualifiedName, 'Box.run');
    assert.equal(identity?.kind, 'method');
    assert.equal('span' in (identity ?? {}), false, 'the edge names the identity, not the span');
  });

  it('two equally tight symbols are ambiguous and map to nothing', async () => {
    const a = located('run', span(3, 2, 6, 3));
    const b = located('Other.run', span(3, 2, 6, 3), 'method');
    assert.equal(await mapTarget(target, lookupOf([a, b])), null);
  });

  it('a declaration outside every symbol, or with no symbol of that name, maps to nothing', async () => {
    assert.equal(await mapTarget(target, lookupOf([located('run', span(0, 0, 2, 1))])), null);
    assert.equal(await mapTarget(target, lookupOf([])), null);
  });

  it('a symbol that ends exactly at the name token does not contain it (the end is exclusive)', async () => {
    assert.equal(await mapTarget(target, lookupOf([located('run', span(0, 0, 4, 8))])), null);
    assert.notEqual(await mapTarget(target, lookupOf([located('run', span(0, 0, 4, 9))])), null);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The adapter on its own (no store): the destructured binding, and the PreciseResolver contract suite.

const NO_OVERLAY: OverlaySnapshot = { id: 'overlay-1', pathToHash: new Map() };
const CONTEXT: ResolutionContext = { id: 'ctx-1', configHashes: [] };

function factsFor(configs: readonly string[] = ['tsconfig.json']): PreciseFacts {
  return {
    ownerOf: (p) => (/\.[cm]?[jt]sx?$/.test(p) ? configs[0] : undefined),
    requiresOwner: (p) => /\.(?:[cm]?ts|tsx)$/.test(p),
    compiler: { source: 'bundled', version: '6.0.3', reason: 'no project compiler', case: 'none' },
    configs,
  };
}

function writeProject(files: Readonly<Record<string, string>>): { readonly dir: string; cleanup(): void } {
  const tmp = makeTempDir();
  const dir = realPath(tmp.path);
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return { dir, cleanup: () => tmp.cleanup() };
}

const site = (file: string, line: number, column: number, name: string): RefSiteKey => ({
  path: file,
  span: span(line, column, line, column + name.length),
  name,
});

describe('the adapter without a store', () => {
  it('destructured require dropped: a binding that is no grammar symbol gives no edge and is counted under its kind', async (t) => {
    const project = writeProject({
      'tsconfig.json': TSCONFIG,
      'src/consumer.cts': ['declare const pair: { compute: (n: number) => number };', 'const { compute } = pair;', 'export const viaPattern = compute(2);', ''].join('\n'),
    });
    t.after(() => project.cleanup());
    const resolver = createTypeScriptResolver({ runner: workerRunner(), worktree: project.dir, project: () => factsFor() });
    t.after(() => resolver.close());
    const noSymbols = lookupOf([]);
    const edges: unknown[] = [];
    for await (const edge of resolver.resolve(NO_OVERLAY, CONTEXT, [site('src/consumer.cts', 2, 26, 'compute')], noSymbols)) edges.push(edge);
    assert.deepEqual(edges, []);
    const stats = resolver.stats();
    assert.equal(stats.dropped['BindingElement'], 1, JSON.stringify(stats));
    assert.equal(stats.byKind['BindingElement']?.edges, 0);
    assert.equal(stats.sites.asked, 1);
    assert.equal(stats.sites.answered, 1);
  });
});

const live: TypeScriptResolver[] = [];
const projects: Array<{ cleanup(): void }> = [];
after(async () => {
  await Promise.all(live.map((resolver) => resolver.close()));
  for (const project of projects) project.cleanup();
});

/** A subject over the fixture project: the real worker, and a lookup that knows a symbol spanning every file. */
function contractSubject(): PreciseResolverSubject {
  const project = writeProject(FIXTURE);
  projects.push(project);
  let closes = 0;
  const resolver = createTypeScriptResolver({
    runner: workerRunner(),
    worktree: project.dir,
    project: () => factsFor(),
    onCleanup: () => {
      closes += 1;
    },
  });
  live.push(resolver);
  const everything: SymbolLookup = {
    find: async () => [],
    findIn: async (p, name) => [{ repo: 'r', path: p, qualifiedName: name, kind: 'function', span: span(0, 0, 1000, 0) }],
  };
  return {
    // The subject's environment supplies the lookup the store would pass, whatever the contract passes.
    resolver: { id: resolver.id, resolve: (overlay, context, sites) => resolver.resolve(overlay, context, sites, everything) },
    overlay: NO_OVERLAY,
    context: CONTEXT,
    resolvable: [site('src/user.cts', 6, 9, 'compute'), site('src/user.cts', 6, 22, 'calc')],
    unresolvable: site('src/user.cts', 0, 0, 'nothing'),
    closeCount: () => closes,
  };
}

definePreciseResolverContract('typescript adapter (real worker)', contractSubject);

describe('contract suite', () => {
  it('contract suite ran against the real worker: every subject started its own resolver', () => {
    assert.ok(live.length >= 10, `${String(live.length)} subjects`);
  });
});
