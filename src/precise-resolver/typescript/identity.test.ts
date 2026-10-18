/**
 * The identity mapping must name the declaration the compiler resolved (plan 03-23 follow-up, 2026-10-18).
 *
 * The defect: `mapTarget` accepted any grammar symbol with the declaration's name whose span merely contained the name token, so
 * `lockMod.withLedgerLock(cwd, fn)` (a property of an inline type, declared inside a module-local function of the same name) was
 * stored as a reference to that function. These tests pin the rule that replaced it: the grammar symbol must be the declaration
 * itself (a compatible kind, starting no earlier than the declaration and ending where it ends), never an enclosing one.
 *
 * Part one is the mapping against a scripted lookup, one case per way a name can be inside another symbol with the same name.
 * Part two runs the real worker, the real compiler and the real grammar tier over a fixture project.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { allowAll, compilerWorkerShape, createRealRunner } from '../../command-runner/index.ts';
import type { CommandRunner } from '../../command-runner/index.ts';
import { PROTOCOL_VERSION } from '../../facts/index.ts';
import type { Envelope, LocatedSymbol, SymbolLookup } from '../../facts/index.ts';
import { createGrammarEngine } from '../../grammar-engine/index.ts';
import { createHost } from '../../host/index.ts';
import type { HostOptions } from '../../host/index.ts';
import { createManualEventSource } from '../../indexer/index.ts';
import { createTempGitRepo, makeTempDir } from '../../test-kit/index.ts';
import { mapTarget, resolveWorkerPath } from './index.ts';

type Span = LocatedSymbol['span'];
type Pos = readonly [row: number, col: number];

const span = (start: Pos, end: Pos): Span => ({ startLine: start[0], startColumn: start[1], endLine: end[0], endColumn: end[1] });

function located(qualifiedName: string, kind: string, s: Span, discriminator?: string): LocatedSymbol {
  const base = { repo: 'r', path: 'src/lib.cts', qualifiedName, kind, span: s };
  return discriminator === undefined ? base : { ...base, discriminator };
}

const lookupOf = (symbols: readonly LocatedSymbol[]): SymbolLookup => ({
  find: async () => [],
  findIn: async (p, name) => symbols.filter((symbol) => symbol.path === p && symbol.qualifiedName.split('.').pop() === name),
});

/** A compiler declaration as the worker reports it: the name token, the kind, and the extent of the declaration node. */
function declaration(kind: string, name: string, at: Pos, start: Pos, end: Pos): Record<string, unknown> {
  return { path: 'src/lib.cts', row: at[0], col: at[1], name, kind, startRow: start[0], startCol: start[1], endRow: end[0], endCol: end[1] };
}

// The mapping is called with the wire shape of a target; the cast keeps these cases independent of how the type spells the extent.
const map = (target: Record<string, unknown>, symbols: readonly LocatedSymbol[]) =>
  (mapTarget as (target: unknown, symbols: SymbolLookup) => ReturnType<typeof mapTarget>)(target, lookupOf(symbols));

describe('identity mapping: the grammar symbol is the declaration itself', () => {
  it('the defect: a property of an inline type inside a function of the same name does not map to the function', async () => {
    // function withLedgerLock(...) {            row 0
    //   let lockMod: {                          row 1
    //     withLedgerLock: (...) => T;           row 2, name at column 4
    //   };
    //   ...
    // }                                         row 8
    const fn = located('withLedgerLock', 'function', span([0, 0], [8, 1]));
    const property = declaration('PropertySignature', 'withLedgerLock', [2, 4], [2, 4], [2, 40]);
    assert.equal(await map(property, [fn]), null);
  });

  it('a method signature of an inline type inside a function of the same name does not map to the function', async () => {
    const fn = located('ping', 'function', span([0, 0], [4, 1]));
    assert.equal(await map(declaration('MethodSignature', 'ping', [1, 21], [1, 21], [1, 29]), [fn]), null);
  });

  it('a parameter, a binding element, an object member and an enum member with the name of their container do not map to it', async () => {
    const fn = located('make', 'function', span([0, 0], [6, 1]));
    assert.equal(await map(declaration('Parameter', 'make', [0, 21], [0, 21], [0, 33]), [fn]), null);
    assert.equal(await map(declaration('BindingElement', 'make', [1, 10], [1, 10], [1, 14]), [fn]), null);
    assert.equal(await map(declaration('ShorthandPropertyAssignment', 'make', [2, 17], [2, 17], [2, 21]), [fn]), null);
    assert.equal(await map(declaration('PropertyAssignment', 'make', [3, 18], [3, 18], [3, 27]), [fn]), null);
    const mode = located('Mode', 'enum', span([0, 0], [3, 1]));
    assert.equal(await map(declaration('EnumMember', 'Mode', [1, 2], [1, 2], [1, 6]), [mode]), null);
  });

  it('a member of an inline type inside a property signature of the same name does not map to that property (same kind, nested)', async () => {
    // interface Cfg {                      row 0
    //   opts: { opts: string };            row 1: the outer property spans columns 2 to 25, the inner one 11 to 23
    // }
    const outer = located('Cfg.opts', 'property', span([1, 2], [1, 25]));
    assert.equal(await map(declaration('PropertySignature', 'opts', [1, 11], [1, 11], [1, 23]), [outer]), null);
  });

  it('a nested member that ends one column before its container ends is still nested: the start rejects it', async () => {
    // interface Cfg { opts:{opts:string} }: the outer member is columns 16 to 34 (with the closing brace), the inner 22 to 33
    const outer = located('Cfg.opts', 'property', span([0, 16], [0, 34]));
    assert.equal(await map(declaration('PropertySignature', 'opts', [0, 22], [0, 22], [0, 33]), [outer]), null);
  });

  it('a symbol of the wrong kind never matches, even when its extent is the declaration', async () => {
    const asFunction = located('run', 'function', span([0, 0], [2, 1]));
    assert.equal(await map(declaration('Parameter', 'run', [0, 9], [0, 0], [2, 1]), [asFunction]), null);
    assert.equal(await map(declaration('PropertySignature', 'run', [0, 9], [0, 0], [2, 1]), [asFunction]), null);
    assert.notEqual(await map(declaration('FunctionDeclaration', 'run', [0, 9], [0, 0], [2, 1]), [asFunction]), null);
  });

  it('a declaration still maps to its own symbol: exact extent, an export wrapper and a trailing separator', async () => {
    const own = located('run', 'function', span([0, 0], [2, 1]));
    assert.equal((await map(declaration('FunctionDeclaration', 'run', [0, 9], [0, 0], [2, 1]), [own]))?.qualifiedName, 'run');
    // `export function run`: the compiler's node starts at `export`, the grammar's definition at `function`.
    const wrapped = located('run', 'function', span([0, 7], [2, 1]));
    assert.equal((await map(declaration('FunctionDeclaration', 'run', [0, 16], [0, 0], [2, 1]), [wrapped]))?.qualifiedName, 'run');
    // A member signature: the compiler's node includes the `;`, the grammar's does not (and the other way round).
    const signature = located('Box.size', 'property', span([1, 2], [1, 14]));
    assert.equal((await map(declaration('PropertySignature', 'size', [1, 2], [1, 2], [1, 15]), [signature]))?.qualifiedName, 'Box.size');
    assert.equal((await map(declaration('PropertySignature', 'size', [1, 2], [1, 2], [1, 13]), [signature]))?.qualifiedName, 'Box.size');
    assert.equal(await map(declaration('PropertySignature', 'size', [1, 2], [1, 2], [1, 16]), [signature]), null, 'two columns apart is not a separator');
    assert.equal(await map(declaration('PropertySignature', 'size', [1, 2], [1, 2], [2, 14]), [signature]), null, 'another row is not a separator');
  });

  it('a recorded member inside a symbol of the same name maps to the member, the innermost compatible symbol', async () => {
    // interface Node { Node: Node }: the member `Node` is a property symbol of its own.
    const container = located('Node', 'interface', span([0, 0], [0, 26]));
    const member = located('Node.Node', 'property', span([0, 17], [0, 24]));
    const identity = await map(declaration('PropertySignature', 'Node', [0, 17], [0, 17], [0, 24]), [container, member]);
    assert.equal(identity?.qualifiedName, 'Node.Node');
    assert.equal(identity?.kind, 'property');
  });

  it('shadowed names: an inner function maps to the inner symbol and the outer one to the outer symbol', async () => {
    const outer = located('run', 'function', span([0, 0], [9, 1]));
    const inner = located('run', 'function', span([2, 2], [4, 3]), '1');
    const outerWithDiscriminator = { ...outer, discriminator: '0' };
    const symbols = [outerWithDiscriminator, inner];
    const innerIdentity = await map(declaration('FunctionDeclaration', 'run', [2, 11], [2, 2], [4, 3]), symbols);
    assert.equal(innerIdentity?.discriminator, '1');
    const outerIdentity = await map(declaration('FunctionDeclaration', 'run', [0, 9], [0, 0], [9, 1]), symbols);
    assert.equal(outerIdentity?.discriminator, '0');
  });

  it('overloads and merged declarations: each declaration maps to the symbol that has its own extent', async () => {
    const first = located('over', 'function', span([0, 7], [0, 40]), '0');
    const second = located('over', 'function', span([1, 7], [1, 40]), '1');
    const implementation = located('over', 'function', span([2, 7], [4, 1]), '2');
    const all = [first, second, implementation];
    assert.equal((await map(declaration('FunctionDeclaration', 'over', [1, 16], [1, 0], [1, 40]), all))?.discriminator, '1');
    assert.equal((await map(declaration('FunctionDeclaration', 'over', [2, 16], [2, 0], [4, 1]), all))?.discriminator, '2');
    const a = located('Merged.b', 'property', span([0, 20], [0, 29]), '0');
    const b = located('Merged.b', 'property', span([2, 20], [2, 29]), '1');
    assert.equal((await map(declaration('PropertySignature', 'b', [2, 20], [2, 20], [2, 30]), [a, b]))?.discriminator, '1');
  });

  it('the kinds the grammar records each map to their own grammar kind', async () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['FunctionDeclaration', 'function'],
      ['VariableDeclaration', 'constant'],
      ['VariableDeclaration', 'variable'],
      ['VariableDeclaration', 'function'],
      ['ClassDeclaration', 'class'],
      ['InterfaceDeclaration', 'interface'],
      ['TypeAliasDeclaration', 'type'],
      ['EnumDeclaration', 'enum'],
      ['ModuleDeclaration', 'namespace'],
      ['MethodDeclaration', 'method'],
      ['MethodSignature', 'method'],
      ['GetAccessor', 'method'],
      ['SetAccessor', 'method'],
      ['PropertyDeclaration', 'property'],
      ['PropertySignature', 'property'],
    ];
    for (const [compilerKind, grammarKind] of pairs) {
      const symbol = located('thing', grammarKind, span([0, 0], [1, 1]));
      const found = await map(declaration(compilerKind, 'thing', [0, 4], [0, 0], [1, 1]), [symbol]);
      assert.equal(found?.kind, grammarKind, `${compilerKind} maps to a ${grammarKind} symbol`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The real worker, compiler and grammar tier.

const MODULES = path.resolve(import.meta.dirname, '..', '..', '..', 'modules');
const WORKER = resolveWorkerPath();
const setupRunner = createRealRunner({ decide: allowAll });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TSCONFIG = JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true, target: 'es2022' }, include: ['src'] }, null, 2);

const workerRunner = (): CommandRunner => createRealRunner({ builtinShapes: [compilerWorkerShape({ execPath: process.execPath, workerPath: WORKER })] });

interface RefRow {
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly tier: string;
  readonly confidence: string;
}

interface World {
  readonly files: Readonly<Record<string, string>>;
  ask(kind: string, args?: unknown): Promise<Envelope>;
  /** The rows of `code_refs` for the definition `name` in `file`, once the answer no longer says `resolver_timeout`. */
  refs(name: string, file: string): Promise<RefRow[]>;
}

async function makeWorld(t: TestContext, files: Readonly<Record<string, string>>): Promise<World> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: files } });
  const tmp = makeTempDir();
  const engine = createGrammarEngine();
  const runner = workerRunner();
  const options: HostOptions = {
    roots: { repoRoot: repo.dir, userDir: path.join(tmp.path, 'user'), builtinDir: MODULES, npmRoots: [] },
    engine,
    runner,
    cwd: repo.dir,
    userDir: path.join(tmp.path, 'user'),
    cacheRoot: path.join(tmp.path, 'cache'),
    gitEnv: repo.envOverlay,
    eventSource: () => createManualEventSource().source,
    metrics: false,
    knownAdapters: ['typescript'],
  };
  const host = createHost(options);
  t.after(async () => {
    await host.close();
    await engine.dispose();
    tmp.cleanup();
    repo.cleanup();
  });
  const ask = (kind: string, args?: unknown): Promise<Envelope> => host.handle({ protocol: PROTOCOL_VERSION, kind, ...(args === undefined ? {} : { args }) });
  const built = await ask('build');
  assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
  const refs = async (name: string, file: string): Promise<RefRow[]> => {
    let envelope = await ask('code_refs', { name, path: file, limit: 200 });
    for (let reads = 1; reads < 12 && (envelope.degraded ?? []).includes('resolver_timeout'); reads += 1) {
      await sleep(300);
      envelope = await ask('code_refs', { name, path: file, limit: 200 });
    }
    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    return (envelope.data as { results: RefRow[] }).results;
  };
  return { files, ask, refs };
}

/** The 1-based line and column of the `nth` (0-based) occurrence of `needle` in `file`, counted as `code_refs` reports a site. */
function siteOf(files: Readonly<Record<string, string>>, file: string, needle: string, nth = 0): { line: number; col: number } {
  const lines = (files[file] ?? '').split('\n');
  let seen = 0;
  for (const [index, text] of lines.entries()) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      if (seen === nth) return { line: index + 1, col: at + 1 };
      seen += 1;
    }
  }
  throw new Error(`no occurrence ${String(nth)} of ${needle} in ${file}`);
}

const rowAt = (rows: readonly RefRow[], file: string, site: { line: number; col: number }): RefRow[] =>
  rows.filter((row) => row.path === file && row.line === site.line && row.col === site.col);

/** True when `rows` hold a precise record at the site: the compiler's answer was taken for the definition the rows are about. */
const preciseAt = (rows: readonly RefRow[], file: string, site: { line: number; col: number }): boolean =>
  rowAt(rows, file, site).some((row) => row.tier === 'precise');

const LEDGER = ['export function withLedgerLock<T>(cwd: string, fn: () => T): T {', '  return fn();', '}', ''].join('\n');

/** The shape of src/refactor-trigger-command-router.cts in gsd-core 10ac3a7, lines 417 to 437. */
const ROUTER = [
  'declare function require(id: string): unknown;',
  '',
  'function withLedgerLock<T>(cwd: string, fn: () => T): T {',
  '  let lockMod: {',
  '    withLedgerLock: (cwd: string, fn: () => T) => T;',
  '  };',
  '  try {',
  "    lockMod = require('./ledger.cjs') as {",
  '      withLedgerLock: (cwd: string, fn: () => T) => T;',
  '    };',
  '  } catch {',
  '    return fn();',
  '  }',
  '  return lockMod.withLedgerLock(cwd, fn);',
  '}',
  '',
  'export function run(): number {',
  "  return withLedgerLock('.', () => 1);",
  '}',
  '',
].join('\n');

describe('the defect of gsd-core 10ac3a7, reproduced: lockMod.withLedgerLock', () => {
  const files = { 'tsconfig.json': TSCONFIG, 'src/ledger.cts': LEDGER, 'src/router.cts': ROUTER };

  it('the call through the inline type is not a precise reference to the module-local function of the same name', async (t) => {
    const world = await makeWorld(t, files);
    const rows = await world.refs('withLedgerLock', 'src/router.cts');
    const real = siteOf(files, 'src/router.cts', "withLedgerLock('.'");
    const viaType = siteOf(files, 'src/router.cts', 'lockMod.withLedgerLock(cwd, fn)');
    const member = { line: viaType.line, col: viaType.col + 'lockMod.'.length };
    assert.equal(preciseAt(rows, 'src/router.cts', real), true, 'control: the plain call is a precise reference to the module-local function');
    assert.equal(preciseAt(rows, 'src/router.cts', member), false, `the call through the inline type was claimed: ${JSON.stringify(rowAt(rows, 'src/router.cts', member))}`);
  });

  it('nor is it a precise reference to the exported function of the other file (the compiler resolved it to the inline type)', async (t) => {
    const world = await makeWorld(t, files);
    const rows = await world.refs('withLedgerLock', 'src/ledger.cts');
    const viaType = siteOf(files, 'src/router.cts', 'lockMod.withLedgerLock(cwd, fn)');
    const member = { line: viaType.line, col: viaType.col + 'lockMod.'.length };
    assert.equal(preciseAt(rows, 'src/router.cts', member), false, JSON.stringify(rowAt(rows, 'src/router.cts', member)));
  });
});

const VARIANTS = [
  'export function ping(n: number): number {',
  '  const probe: { ping(): number } = { ping: () => n };',
  '  return probe.ping();',
  '}',
  '',
  'export function make(make: number): number {',
  '  const box = { make };',
  '  return box.make + make;',
  '}',
  '',
  'export function runFn(): number {',
  '  const o = { runFn(): number { return 1; } };',
  '  return o.runFn();',
  '}',
  '',
  'export class Job {',
  '  exec(): number {',
  '    const o = { exec(): number { return 2; } };',
  '    return o.exec();',
  '  }',
  '}',
  '',
  'export interface Cfg {',
  '  opts: { opts: () => number };',
  '}',
  'export interface Tight {',
  '  tight:{tight:() => number};',
  '}',
  'declare const cfg: Cfg;',
  'declare const tight: Tight;',
  'export const deep = cfg.opts.opts() + tight.tight.tight();',
  '',
  'export interface Runner {',
  '  go: () => number;',
  '}',
  'declare const runner: Runner;',
  'export const went = runner.go();',
  '',
  'export function nest(): number {',
  '  function nest(): number {',
  '    return 2;',
  '  }',
  '  return nest();',
  '}',
  '',
  'export class Box {',
  '  handler = (): number => 1;',
  '  grow(): number {',
  '    return 1;',
  '  }',
  '}',
  'export const grown = new Box().grow() + new Box().handler();',
  '',
  'export function over(a: string): string;',
  'export function over(a: number): number;',
  'export function over(a: string | number): string | number {',
  '  return a;',
  '}',
  "export const overUsed = over('x');",
  '',
  'export interface Merged {',
  '  a: () => number;',
  '}',
  'export interface Merged {',
  '  b: () => number;',
  '}',
  'declare const merged: Merged;',
  'export const mergedB = merged.b();',
  '',
].join('\n');

/** The site of `member` inside the first occurrence of `text` in `file`. */
function memberOf(files: Readonly<Record<string, string>>, file: string, text: string, member: string): { line: number; col: number } {
  const site = siteOf(files, file, text);
  return { line: site.line, col: site.col + text.indexOf(member) };
}

describe('the class of the defect: a name inside a declaration of the same name', () => {
  const files = { 'tsconfig.json': TSCONFIG, 'src/variants.cts': VARIANTS };
  const here = 'src/variants.cts';

  it('a method signature of an inline type is not a reference to the function that holds it', async (t) => {
    const world = await makeWorld(t, files);
    const rows = await world.refs('ping', here);
    const site = memberOf(files, here, 'probe.ping()', 'ping');
    assert.equal(preciseAt(rows, here, site), false, JSON.stringify(rowAt(rows, here, site)));
  });

  it('a parameter, read through a shorthand member and by name, is not a reference to the function that holds it', async (t) => {
    const world = await makeWorld(t, files);
    const rows = await world.refs('make', here);
    const claimed = rows.filter((row) => row.tier === 'precise' && row.path === here);
    assert.deepEqual(
      claimed.map((row) => [row.line, row.col]),
      [],
      JSON.stringify(claimed),
    );
  });

  it('a method of an object literal is not a reference to the function (a different kind) or to the class method (the same kind) it sits in', async (t) => {
    const world = await makeWorld(t, files);
    const fn = await world.refs('runFn', here);
    const inFunction = memberOf(files, here, 'o.runFn()', 'runFn');
    assert.equal(preciseAt(fn, here, inFunction), false, JSON.stringify(rowAt(fn, here, inFunction)));
    const method = await world.refs('exec', here);
    const inMethod = memberOf(files, here, 'o.exec()', 'exec');
    assert.equal(preciseAt(method, here, inMethod), false, JSON.stringify(rowAt(method, here, inMethod)));
  });

  it('a member of an inline type inside a member of the same name is not a reference to the outer member', async (t) => {
    const world = await makeWorld(t, files);
    for (const [name, text] of [
      ['opts', 'cfg.opts.opts()'],
      ['tight', 'tight.tight.tight()'],
    ] as const) {
      const rows = await world.refs(name, here);
      const first = siteOf(files, here, text);
      const inner = { line: first.line, col: first.col + text.lastIndexOf(name) };
      assert.equal(preciseAt(rows, here, inner), false, `the inner member ${name} was claimed: ${JSON.stringify(rowAt(rows, here, inner))}`);
    }
  });

  it('controls: a member signature, a shadowing inner function, class members, overloads and merged interfaces stay precise', async (t) => {
    const world = await makeWorld(t, files);
    const cases: ReadonlyArray<readonly [name: string, site: { line: number; col: number }, what: string]> = [
      ['go', memberOf(files, here, 'runner.go()', 'go'), 'a property signature of an interface'],
      ['nest', siteOf(files, here, 'nest();'), 'the inner function that shadows the outer one'],
      ['grow', memberOf(files, here, 'new Box().grow()', 'grow'), 'a method'],
      ['handler', memberOf(files, here, 'new Box().handler()', 'handler'), 'a class field'],
      ['over', siteOf(files, here, "over('x')"), 'an overloaded function'],
      ['b', memberOf(files, here, 'merged.b()', 'b()'), 'a member of a merged interface'],
    ];
    for (const [name, site, what] of cases) {
      const rows = await world.refs(name, here);
      assert.equal(preciseAt(rows, here, site), true, `${what}: ${JSON.stringify(rowAt(rows, here, site))}`);
    }
  });
});
