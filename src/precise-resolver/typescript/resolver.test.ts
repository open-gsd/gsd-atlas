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
import type { CommandRunner, CommandSpec } from '../../command-runner/index.ts';
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
import { bundledCompilerDir, createTypeScriptResolver, createTypeScriptTier, mapTarget, resolveWorkerPath, resolveWorkerUrl } from './index.ts';
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
  /** Repo-relative paths kept out of the commit and the index (a trailing slash makes it a directory). */
  readonly ignored?: readonly string[];
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
  const repo = await createTempGitRepo({
    runner: setupRunner,
    world: {
      committed: files,
      ...(options.working === undefined ? {} : { working: options.working }),
      ...(options.ignored === undefined ? {} : { ignored: options.ignored }),
    },
  });
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

// ---------------------------------------------------------------------------------------------------------------------
// Task 2: compiler selection, typed failures, memory, notices, no owner, providers off, the manifest.
// ---------------------------------------------------------------------------------------------------------------------

/** A runner that records what it was asked to start, then delegates. */
export interface CountingRunner extends CommandRunner {
  /** Every worker start (a spec that claims the compiler worker built-in). */
  readonly workers: CommandSpec[];
  /** Every other spec the Host ran (git). */
  readonly others: CommandSpec[];
}

export function countingRunner(env?: Readonly<Record<string, string | undefined>>): CountingRunner {
  const inner = workerRunner(env);
  const workers: CommandSpec[] = [];
  const others: CommandSpec[] = [];
  const note = (spec: CommandSpec): void => {
    (spec.builtinId === 'typescript-resolver' ? workers : others).push(spec);
  };
  return {
    workers,
    others,
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

const FIXED = {
  none: 'the project has no TypeScript compiler; the bundled 6.0.3 was used',
  unstable: 'the project TypeScript is 7.x with the unstable API; the bundled 6.0.3 was used',
  sync: 'the project TypeScript is 7.x with the sync API; the bundled 6.0.3 was used',
  unknown: 'the project TypeScript is 7.x with an unknown layout; the bundled 6.0.3 was used',
} as const;

const diagnosticsOf = (envelope: Envelope, code: string): string[] => envelope.diagnostics.filter((entry) => entry.code === code).map((entry) => entry.message);

/**
 * The files of a project `typescript` package under `node_modules` (written after the commit, and ignored), whose main file
 * is `code`. The package re-exports the bundled compiler so that a run with it behaves like a real 6.x.
 */
function projectCompiler(version: string, code: string, exportsField?: Record<string, unknown>): Record<string, string> {
  return {
    'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version, main: './lib/typescript.js', ...(exportsField === undefined ? {} : { exports: exportsField }) }),
    'node_modules/typescript/lib/typescript.js': code,
  };
}

const requireBundled = `const ts = require(${JSON.stringify(path.join(bundledCompilerDir(), 'lib', 'typescript.js'))});\n`;

function precise(envelope: Envelope): boolean {
  const rows = at(refRows(envelope), 'src/user.cts');
  return rows.length === 2 && rows.every((row) => row.tier === 'precise');
}

describe('compiler selection (D-12, D-13, TSM-02)', () => {
  it('no project compiler uses bundled: compiler_fallback and one fixed diagnostic', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await world.build()).ok, true);
    const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.ok(precise(envelope), JSON.stringify(refRows(envelope)));
    assert.deepStrictEqual(envelope.degraded, ['compiler_fallback']);
    assert.deepStrictEqual(diagnosticsOf(envelope, 'compiler_fallback'), [FIXED.none]);
    const [info] = world.tier()?.info() ?? [];
    assert.equal(info?.compiler.source, 'bundled');
    assert.equal(info?.compiler.version, '6.0.3');
    // A later read, served from the cache, still says it (the cache does not hide a fallback).
    const again = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    assert.deepStrictEqual(again.degraded, ['compiler_fallback']);
    assert.deepStrictEqual(diagnosticsOf(again, 'compiler_fallback'), [FIXED.none]);
  });

  it('project 6.x compiler used and env is minimal: no fallback, no secret, no NODE_OPTIONS in the worker', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const marker = path.join(tmp.path, 'env.log');
    const code = `${requireBundled}require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify(Object.keys(process.env)) + '\\n');\nmodule.exports = ts;\n`;
    const runner = countingRunner({
      ...process.env,
      NODE_OPTIONS: '--no-warnings',
      MY_API_TOKEN: 'secret-one',
      AWS_ACCESS_KEY_ID: 'secret-two',
      UNRELATED_NAME: 'x',
      DYLD_INSERT_LIBRARIES: '',
    });
    const world = await makeWorld(t, { ...FIXTURE, '.gitignore': 'node_modules/\n' }, { runner, working: projectCompiler('6.0.2', code), ignored: ['node_modules/'] });
    assert.equal((await world.build()).ok, true);
    const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.ok(precise(envelope), JSON.stringify(refRows(envelope)));
    assert.equal(envelope.degraded, undefined, 'a project 6.x compiler is no fallback');
    const [info] = world.tier()?.info() ?? [];
    assert.equal(info?.compiler.source, 'project');
    assert.ok(fs.existsSync(marker), 'the project compiler file was loaded by the worker');
    const keys = fs
      .readFileSync(marker, 'utf8')
      .trim()
      .split('\n')
      .flatMap((line) => JSON.parse(line) as string[]);
    assert.ok(keys.includes('GSD_ATLAS_WORKER'), 'the worker marker variable is present');
    for (const key of keys) {
      assert.ok(!/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(key), `a secret-looking variable reached the worker: ${key}`);
    }
    for (const forbidden of ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'UNRELATED_NAME', 'DYLD_INSERT_LIBRARIES', 'MY_API_TOKEN', 'AWS_ACCESS_KEY_ID']) {
      assert.ok(!keys.includes(forbidden), `${forbidden} reached the worker`);
    }
    // The worker was started as the exact built-in: Node, a heap flag, the worker file, one environment key.
    assert.equal(runner.workers.length, 1);
    const [spec] = runner.workers;
    assert.deepStrictEqual(Object.keys(spec?.env ?? {}), ['GSD_ATLAS_WORKER']);
    assert.match(spec?.args[0] ?? '', /^--max-old-space-size=\d+$/);
    assert.equal(spec?.args[1], WORKER);
    assert.ok(!spec?.args.some((arg) => arg.includes('node_modules')), 'the compiler location is data in the first message, not an argument');
  });

  for (const [label, version, exportsField, text] of [
    ['7.x unstable falls back', '7.0.2', { '.': './lib/typescript.js', './unstable/sync': './lib/sync.js' }, FIXED.unstable],
    ['7.x sync falls back', '7.1.0', { '.': './lib/typescript.js', './sync': './lib/sync.js' }, FIXED.sync],
    ['unknown layout falls back', '7.2.0', { '.': './lib/typescript.js' }, FIXED.unknown],
  ] as const) {
    it(`${label}: the bundled compiler is used, the project's file is never loaded`, async (t) => {
      const tmp = makeTempDir();
      t.after(() => tmp.cleanup());
      const marker = path.join(tmp.path, 'loaded.log');
      const code = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n${requireBundled}module.exports = ts;\n`;
      const world = await makeWorld(t, { ...FIXTURE, '.gitignore': 'node_modules/\n' }, { working: projectCompiler(version, code, exportsField), ignored: ['node_modules/'] });
      assert.equal((await world.build()).ok, true);
      const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
      assert.ok(precise(envelope), JSON.stringify(refRows(envelope)));
      assert.deepStrictEqual(envelope.degraded, ['compiler_fallback']);
      assert.deepStrictEqual(diagnosticsOf(envelope, 'compiler_fallback'), [text]);
      assert.equal(fs.existsSync(marker), false, 'the project compiler was never loaded');
      const [info] = world.tier()?.info() ?? [];
      assert.equal(info?.compiler.source, 'bundled');
    });
  }
});

describe('typed failures and the worker lifecycle (TSM-05)', () => {
  it('heap abort is memory_budget: grammar edges, no resolver_failed, and the next read starts a fresh worker once', async (t) => {
    const runner = countingRunner();
    const world = await makeWorld(t, FIXTURE, { runner, host: { precise: { heapMb: 24 } } });
    assert.equal((await world.build()).ok, true);
    const first = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    assert.equal(first.ok, true);
    assert.ok((first.degraded ?? []).includes('memory_budget'), JSON.stringify(first.degraded));
    assert.equal((first.degraded ?? []).includes('resolver_failed'), false);
    assert.ok(at(refRows(first), 'src/user.cts').every((row) => row.tier === 'grammar'), 'the grammar edges are still there');
    assert.equal(runner.workers.length, 1);
    // The tier is not stuck: the next read starts a fresh worker, once, and that aborts too.
    const second = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
    assert.ok((second.degraded ?? []).includes('memory_budget'));
    assert.equal(runner.workers.length, 2);
    assert.deepStrictEqual(diagnosticsOf(second, 'memory_budget'), ['the compiler worker reached its memory limit; this answer uses grammar facts']);
  });

  it('killed worker restarts: a SIGKILL gives resolver_failed and the next read starts a new worker', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const flag = path.join(tmp.path, 'kill.flag');
    const code = [
      requireBundled,
      "const fs = require('node:fs');",
      `const flag = ${JSON.stringify(flag)};`,
      'const patched = (...args) => {',
      '  const program = ts.createProgram(...args);',
      '  const getChecker = program.getTypeChecker.bind(program);',
      '  program.getTypeChecker = () => {',
      '    const checker = getChecker();',
      '    const original = checker.getSymbolAtLocation.bind(checker);',
      "    checker.getSymbolAtLocation = (node) => { if (fs.existsSync(flag)) process.kill(process.pid, 'SIGKILL'); return original(node); };",
      '    return checker;',
      '  };',
      '  return program;',
      '};',
      "module.exports = new Proxy(ts, { get: (target, name) => (name === 'createProgram' ? patched : target[name]) });",
      '',
    ].join('\n');
    const runner = countingRunner();
    const world = await makeWorld(t, { ...FIXTURE, '.gitignore': 'node_modules/\n' }, { runner, working: projectCompiler('6.0.2', code), ignored: ['node_modules/'] });
    assert.equal((await world.build()).ok, true);
    const warm = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.ok(precise(warm.envelope), JSON.stringify(refRows(warm.envelope)));
    assert.equal(runner.workers.length, 1);

    fs.writeFileSync(flag, 'kill');
    const killed = await world.ask('code_refs', { name: 'greet', path: 'src/lib.cts' });
    assert.ok((killed.degraded ?? []).includes('resolver_failed'), JSON.stringify(killed.degraded));
    assert.equal((killed.degraded ?? []).includes('memory_budget'), false);

    fs.rmSync(flag);
    const { envelope } = await refsSettled(world, { name: 'greet', path: 'src/lib.cts' });
    assert.equal(at(refRows(envelope), 'src/lib.cts')[0]?.tier, 'precise');
    assert.equal(runner.workers.length, 2, 'the worker was started again, once');
  });
});

describe('no owner and providers off (SEC-02)', () => {
  const SAME_FILE = ['export function f(): number {', '  return 1;', '}', 'export function g(): number {', '  return f();', '}', ''].join('\n');

  it('no owner ts file: precise_unavailable with a fixed diagnostic, and no worker is started', async (t) => {
    const runner = countingRunner();
    const world = await makeWorld(t, { 'src/a.ts': SAME_FILE }, { runner });
    assert.equal((await world.build()).ok, true);
    for (let read = 0; read < 2; read += 1) {
      const envelope = await world.ask('code_refs', { name: 'f', path: 'src/a.ts' });
      assert.equal(envelope.ok, true);
      assert.deepStrictEqual(envelope.degraded, ['precise_unavailable'], `read ${String(read)}`);
      assert.equal(refRows(envelope).length, 1);
      assert.equal(refRows(envelope)[0]?.tier, 'grammar');
      assert.deepStrictEqual(diagnosticsOf(envelope, 'precise_unavailable'), ['no tsconfig.json covers a TypeScript file in this answer; it was answered from grammar facts']);
    }
    assert.equal(runner.workers.length, 0);
  });

  it('no owner js file: a JavaScript file with no config adds nothing and starts nothing', async (t) => {
    const runner = countingRunner();
    const world = await makeWorld(t, { 'src/a.cjs': 'function f() {\n  return 1;\n}\nfunction g() {\n  return f();\n}\nmodule.exports = { f, g };\n' }, { runner });
    assert.equal((await world.build()).ok, true);
    const envelope = await world.ask('code_refs', { name: 'f', path: 'src/a.cjs' });
    assert.equal(envelope.ok, true);
    assert.equal(envelope.degraded, undefined);
    assert.ok(refRows(envelope).length >= 1, 'the grammar tier still answers');
    assert.equal(runner.workers.length, 0);

    // The same inside a TypeScript project: a .cjs outside every config's file set is not a reason to say anything.
    const project = await makeWorld(t, { ...FIXTURE, 'scripts/run.cjs': 'function f() {\n  return 1;\n}\nfunction g() {\n  return f();\n}\nmodule.exports = { f, g };\n' }, { runner });
    assert.equal((await project.build()).ok, true);
    const inProject = await project.ask('code_refs', { name: 'f', path: 'scripts/run.cjs' });
    assert.equal((inProject.degraded ?? []).includes('precise_unavailable'), false, JSON.stringify(inProject.degraded));
  });

  it('providers disabled starts nothing: grammar-tier answers, precise_unavailable and the switched-off text', async (t) => {
    const runner = countingRunner();
    const world = await makeWorld(t, FIXTURE, { runner, host: { config: { providers: { disabled: ['typescript'] } } } });
    assert.equal((await world.build()).ok, true);
    for (let read = 0; read < 2; read += 1) {
      const envelope = await world.ask('code_refs', { name: 'compute', path: 'src/lib.cts' });
      assert.equal(envelope.ok, true);
      assert.deepStrictEqual(envelope.degraded, ['precise_unavailable'], `read ${String(read)}`);
      assert.ok(at(refRows(envelope), 'src/user.cts').length > 0);
      assert.ok(refRows(envelope).every((row) => row.tier === 'grammar'));
      assert.deepStrictEqual(diagnosticsOf(envelope, 'precise_unavailable'), ['the typescript provider is turned off in the user configuration']);
    }
    assert.equal(runner.workers.length, 0, 'no worker is ever started');
    const listed = await world.ask('lang_list');
    const modules = (listed.data as { modules: Array<{ name: string; tiers: Array<{ tier: string; active: boolean; reason?: string }> }> }).modules;
    assert.deepStrictEqual(modules.find((entry) => entry.name === 'typescript')?.tiers.find((tier) => tier.tier === 'precise'), { tier: 'precise', active: false, reason: 'provider_disabled' });
  });

  it('a hostile tsconfig plugin is never loaded and the only processes are git and the worker', async (t) => {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const marker = path.join(tmp.path, 'PWNED');
    const hostile = {
      ...FIXTURE,
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'nodenext', strict: true, plugins: [{ name: './mark.cjs' }] }, include: ['src'] }),
      'mark.cjs': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pwned');\nmodule.exports = () => ({ create: (info) => info.languageService });\n`,
    };
    const runner = countingRunner();
    const world = await makeWorld(t, hostile, { runner });
    assert.equal((await world.build()).ok, true);
    const { envelope } = await refsSettled(world, { name: 'compute', path: 'src/lib.cts' });
    assert.ok(precise(envelope), JSON.stringify(refRows(envelope)));
    assert.equal(fs.existsSync(marker), false, 'a tsconfig plugin was loaded');
    assert.equal(runner.workers.length, 1);
    assert.ok(runner.others.every((spec) => spec.executable === 'git'), 'nothing but git besides the worker');
  });
});

describe('an untrusted worker (T-03-232, T-03-233)', () => {
  const FAKE = [
    "import readline from 'node:readline';",
    "const mode = process.env.FAKE_MODE ?? process.argv[3] ?? 'flood';",
    'const rl = readline.createInterface({ input: process.stdin });',
    'const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
    'rl.on("line", (line) => {',
    '  const m = JSON.parse(line);',
    '  if (m.t === "init") return send({ t: "ready", compiler: { version: "6.0.3", source: "bundled" }, rssMb: 1, pid: process.pid });',
    '  if (m.t !== "resolve") return;',
    '  const s = m.sites[0];',
    '  const target = { path: "src/lib.cts", row: 0, col: 16, name: "compute", kind: "FunctionDeclaration" };',
    '  if (mode === "flood") { for (let i = 0; i < 3; i += 1) send({ t: "edge", id: m.id, site: s, targets: [target] }); return send({ t: "done", id: m.id, asked: 1, answered: 3 }); }',
    '  if (mode === "garbage") return process.stdout.write("this is not json\\n");',
    '  if (mode === "escape") { send({ t: "edge", id: m.id, site: s, targets: [{ ...target, path: "../../etc/passwd" }] }); return send({ t: "done", id: m.id, asked: 1, answered: 1 }); }',
    '  if (mode === "silent") return;',
    '});',
    'rl.on("close", () => process.exit(0));',
    '',
  ].join('\n');

  /** A resolver over the fixture project whose "worker" is the fake script above, started through the same exact shape. */
  function resolverWith(t: TestContext, mode: string, limits: Record<string, number> = {}): TypeScriptResolver {
    const tmp = makeTempDir();
    t.after(() => tmp.cleanup());
    const fake = path.join(tmp.path, `fake-${mode}.mjs`);
    fs.writeFileSync(fake, FAKE.replace("process.env.FAKE_MODE ?? process.argv[3] ?? 'flood'", JSON.stringify(mode)));
    const project = writeProject(FIXTURE);
    t.after(() => project.cleanup());
    const runner = createRealRunner({ builtinShapes: [compilerWorkerShape({ execPath: process.execPath, workerPath: fake })] });
    const resolver = createTypeScriptResolver({ runner, worktree: project.dir, project: () => factsFor(), execPath: process.execPath, workerPath: fake, limits });
    t.after(() => resolver.close());
    return resolver;
  }

  const SITE = site('src/user.cts', 6, 9, 'compute');
  const anyLookup: SymbolLookup = {
    find: async () => [],
    findIn: async (p, name) => [{ repo: 'r', path: p, qualifiedName: name, kind: 'function', span: span(0, 0, 1000, 0) }],
  };

  async function drain(resolver: TypeScriptResolver): Promise<unknown[]> {
    const out: unknown[] = [];
    for await (const item of resolver.resolveScoped(factsFor(), NO_OVERLAY, CONTEXT, [SITE], anyLookup)) out.push(item);
    return out;
  }

  it('a worker that answers more sites than it was asked is stopped and the call fails with resolver_failed', async (t) => {
    const resolver = resolverWith(t, 'flood');
    await assert.rejects(drain(resolver), (error: unknown) => (error as { degradedCode?: string }).degradedCode === 'resolver_failed');
  });

  it('a line that is not a protocol message stops the worker and fails the call', async (t) => {
    const resolver = resolverWith(t, 'garbage');
    await assert.rejects(drain(resolver), (error: unknown) => (error as { degradedCode?: string }).degradedCode === 'resolver_failed');
  });

  it('a worker that never answers is killed at the request timeout', async (t) => {
    const resolver = resolverWith(t, 'silent', { requestTimeoutMs: 400 });
    const started = Date.now();
    await assert.rejects(drain(resolver), (error: unknown) => (error as { degradedCode?: string }).degradedCode === 'resolver_failed');
    assert.ok(Date.now() - started < 10_000);
  });

  it('a target path that leaves the repository is refused before the store is asked about it', async (t) => {
    const resolver = resolverWith(t, 'escape');
    const asked: string[] = [];
    const watching: SymbolLookup = {
      find: async () => [],
      findIn: async (p, name) => {
        asked.push(p);
        return anyLookup.findIn(p, name);
      },
    };
    const out: unknown[] = [];
    for await (const item of resolver.resolveScoped(factsFor(), NO_OVERLAY, CONTEXT, [SITE], watching)) out.push(item);
    assert.deepEqual(out.filter((item) => (item as { kind?: string }).kind !== 'notice'), []);
    assert.deepEqual(asked, []);
    assert.equal(resolver.stats().dropped['FunctionDeclaration'], 1);
  });
});

describe('the manifest and the worker source', () => {
  it('the TypeScript module names tiers grammar and precise and the typescript adapter', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(MODULES, 'typescript', 'atlas-lang.json'), 'utf8')) as { tiers: string[]; precise: { adapter: string } };
    assert.deepStrictEqual(manifest.tiers, ['grammar', 'precise']);
    assert.deepStrictEqual(manifest.precise, { adapter: 'typescript' });
  });

  it('worker.ts calls createProgram and never the language service, tsserver or a plugin loader', () => {
    // Comments explain what the worker does not do; only code counts here.
    const source = fs
      .readFileSync(WORKER, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.match(source, /createProgram/);
    assert.doesNotMatch(source, /createLanguageService|tsserver|loadPlugin|plugins/);
  });

  it('the worker file is worker.ts from source and worker.js from the compiled package', () => {
    assert.equal(resolveWorkerUrl('file:///repo/src/precise-resolver/typescript/worker-url.ts').href, 'file:///repo/src/precise-resolver/typescript/worker.ts');
    assert.equal(resolveWorkerUrl('file:///pkg/dist/precise-resolver/typescript/worker-url.js').href, 'file:///pkg/dist/precise-resolver/typescript/worker.js');
    assert.equal(resolveWorkerPath(), path.join(import.meta.dirname, 'worker.ts'));
  });

  it('no production file outside the worker loads the compiler package', () => {
    const dir = path.dirname(WORKER);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'worker.ts') continue;
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.doesNotMatch(text, /(?:from|import|require)\s*\(?\s*['"]typescript(?:\/[^'"]*)?['"]/, `${name} imports the compiler`);
    }
  });
});
