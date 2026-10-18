import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_PROJECT_CONTEXT } from '../facts/index.ts';
import type { OverlaySnapshot } from '../facts/index.ts';
import { createTypeScriptProjectModel } from '../project-model/index.ts';
import type { DescribeInput, ProjectModel } from '../project-model/index.ts';
import type { ReadTextResult } from '../source-tree/index.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { createOutputFilter, createProjectContextProvider, modelIdsByExtension } from './project.ts';
import type { ProjectProvider } from './project.ts';

// ---------------------------------------------------------------------------------------------
// A repository as data, editable between calls, with counters for what the provider read and described.

const WORKTREE = '/work/repo';

interface World {
  files: Record<string, string>;
  readonly reads: string[];
  describes: number;
  provider: ProjectProvider;
}

const tsModuleFor = (p: string): string | undefined => (/\.(?:ts|cts|mts)$/.test(p) ? 'typescript' : undefined);

function makeWorld(files: Record<string, string>, options: { moduleForPath?: (p: string) => string | undefined; throwOnDescribe?: boolean } = {}): World {
  const world: World = { files, reads: [], describes: 0, provider: undefined as unknown as ProjectProvider };
  const real = createTypeScriptProjectModel();
  const counting: ProjectModel = {
    id: 'typescript',
    async describe(input: DescribeInput) {
      world.describes += 1;
      if (options.throwOnDescribe === true) throw new Error('describe failed');
      return real.describe(input);
    },
  };
  const tree = {
    async readText(worktree: string, p: string): Promise<ReadTextResult> {
      assert.equal(worktree, WORKTREE, 'every read names the worktree it belongs to');
      world.reads.push(p);
      const text = world.files[p];
      return text === undefined ? { kind: 'missing' } : { kind: 'ok', text };
    },
  };
  world.provider = createProjectContextProvider({
    tree,
    models: new Map([['typescript', counting]]),
    moduleForPath: options.moduleForPath ?? tsModuleFor,
  });
  return world;
}

const cfg = (compilerOptions: Record<string, unknown>, rest: Record<string, unknown> = {}): string => JSON.stringify({ compilerOptions, ...rest });

const BUILD = cfg({ rootDir: 'src', outDir: 'out', module: 'nodenext' }, { include: ['src/**/*.cts'] });

/** An overlay whose files all have the hash `rev` (so an "edit" changes the hash and keeps the path set). */
function overlayOf(paths: readonly string[], rev = 'h1'): OverlaySnapshot {
  return { id: `${paths.join(',')}@${rev}`, pathToHash: new Map(paths.map((p) => [p, `${rev}:${p}`])) };
}

const ask = (world: World, paths: readonly string[], rev?: string) => world.provider({ worktree: WORKTREE, overlay: overlayOf(paths, rev) });

describe('createProjectContextProvider (TSM-03)', () => {
  it('builds the project context from the model the module manifest names: compiler identity, config hashes and the emit lookup', async () => {
    const world = makeWorld({ 'tsconfig.json': BUILD });
    const project = await ask(world, ['src/lib.cts', 'src/user.cts', 'consumer.cjs']);
    assert.match(project.context.id, /^typescript:\d+\.\d+\.\d+:(?:project|bundled)$/);
    assert.equal(project.context.configHashes.length, 1);
    assert.equal(project.emit?.outputToSource('out/lib.cjs'), 'src/lib.cts');
    assert.deepStrictEqual(project.emit?.sourceToOutputs('src/user.cts'), ['out/user.cjs']);
  });

  it('a repository whose module declares no project model, or that has no tsconfig, gets the grammar-tier context of Phase 2', async () => {
    const none = makeWorld({ 'tsconfig.json': BUILD }, { moduleForPath: () => undefined });
    assert.deepStrictEqual(await ask(none, ['src/lib.cts']), DEFAULT_PROJECT_CONTEXT);
    assert.equal(none.describes, 0, 'no model applies, so nothing is described');
    assert.deepStrictEqual(none.reads, [], 'and nothing is read');

    const noConfig = makeWorld({});
    assert.deepStrictEqual(await ask(noConfig, ['src/lib.cts']), DEFAULT_PROJECT_CONTEXT);
    assert.equal(noConfig.provider.isOutput(WORKTREE, 'out/lib.cjs'), false);
  });

  it('a model that throws makes the provider reject (the store answers resolver_failed) while the output filter fails open', async () => {
    const broken = makeWorld({ 'tsconfig.json': BUILD }, { throwOnDescribe: true });
    await assert.rejects(ask(broken, ['src/lib.cts']), /describe failed/, 'the store treats this as resolver_failed');
    const filter = createOutputFilter(broken.provider);
    assert.deepStrictEqual([...(await filter.exclude(WORKTREE, ['src/lib.cts', 'out/lib.cjs']))], [], 'the filter fails open: nothing is dropped');
    assert.equal(filter.isOutput(WORKTREE, 'out/lib.cjs'), false);
  });

  it('is cheap on an unchanged project: ten edits of one source file describe once and read only the config', async () => {
    const world = makeWorld({ 'tsconfig.json': BUILD });
    const paths = ['src/lib.cts', 'src/user.cts', 'consumer.cjs'];
    for (let edit = 0; edit < 10; edit += 1) await ask(world, paths, `rev${String(edit)}`);
    assert.equal(world.describes, 1, 'one description for ten overlay snapshots with one path set');
    const afterFirst = world.reads.filter((p) => p !== 'tsconfig.json');
    assert.deepStrictEqual(afterFirst, [], 'the only file ever read is the config');
    assert.ok(world.reads.length <= 1 + 9, 'the first call reads the config while describing, each later call at most one small re-check');
  });

  it('describes again when the set of overlay paths changes', async () => {
    const world = makeWorld({ 'tsconfig.json': BUILD });
    await ask(world, ['src/lib.cts']);
    await ask(world, ['src/lib.cts', 'src/user.cts']);
    assert.equal(world.describes, 2);
    const project = await ask(world, ['src/lib.cts', 'src/user.cts']);
    assert.equal(world.describes, 2, 'the same path set again is served from the memo');
    assert.equal(project.emit?.outputToSource('out/user.cjs'), 'src/user.cts', 'and it knows the newer source');
  });

  it('describes again when the content of a discovered config changes, and the context hashes follow', async () => {
    const world = makeWorld({ 'tsconfig.json': BUILD });
    const before = await ask(world, ['src/lib.cts']);
    world.files['tsconfig.json'] = cfg({ rootDir: 'src', outDir: 'dist' }, { include: ['src/**/*.cts'] });
    const after = await ask(world, ['src/lib.cts']);
    assert.equal(world.describes, 2);
    assert.notDeepStrictEqual(after.context.configHashes, before.context.configHashes);
    assert.equal(after.emit?.outputToSource('dist/lib.cjs'), 'src/lib.cts');
    assert.equal(after.emit?.isOutput('out/lib.cjs'), false);
  });

  it('a config an extends chain reaches counts: changing the base re-describes', async () => {
    const world = makeWorld({
      'tsconfig.json': cfg({}, { extends: './base.json', include: ['src/**/*.cts'] }),
      'base.json': cfg({ rootDir: 'src', outDir: 'out' }),
    });
    await ask(world, ['src/lib.cts']);
    world.files['base.json'] = cfg({ rootDir: 'src', outDir: 'built' });
    const after = await ask(world, ['src/lib.cts']);
    assert.equal(world.describes, 2);
    assert.equal(after.emit?.outputToSource('built/lib.cjs'), 'src/lib.cts');
  });

  it('keeps one memo per worktree', async () => {
    const world = makeWorld({ 'tsconfig.json': BUILD });
    await ask(world, ['src/lib.cts']);
    await world.provider({ worktree: WORKTREE, overlay: overlayOf(['src/lib.cts', 'src/other.cts']) });
    assert.equal(world.describes, 2);
  });
});

describe('createOutputFilter (OQ3: no fact under an emit output of an included source)', () => {
  const FILES = { 'tsconfig.json': cfg({ rootDir: 'src', outDir: 'lib' }, { include: ['src/**/*.cts'] }) };
  const CANDIDATES = ['src/a.cts', 'lib/a.cjs', 'lib/vendor.cjs', 'consumer.cjs'];

  it('excludes a tracked output of an included source and keeps hand-written files under the output directory', async () => {
    const world = makeWorld({ ...FILES });
    const filter = createOutputFilter(world.provider);
    const dropped = await filter.exclude(WORKTREE, CANDIDATES);
    assert.deepStrictEqual([...dropped], ['lib/a.cjs']);
    assert.equal(filter.isOutput(WORKTREE, 'lib/a.cjs'), true, 'the event path asks the memo built by the same call');
    assert.equal(filter.isOutput(WORKTREE, 'lib/vendor.cjs'), false);
    assert.equal(filter.isOutput(WORKTREE, 'src/a.cts'), false);
    assert.equal(filter.isOutput(WORKTREE, 'elsewhere/never-seen.cjs'), false);
  });

  it('follows a tsconfig change at the next exclude: the output stops being an output, and the reverse', async () => {
    const world = makeWorld({ ...FILES });
    const filter = createOutputFilter(world.provider);
    assert.deepStrictEqual([...(await filter.exclude(WORKTREE, CANDIDATES))], ['lib/a.cjs']);
    world.files['tsconfig.json'] = cfg({ rootDir: 'src', outDir: 'elsewhere' }, { include: ['src/**/*.cts'] });
    assert.deepStrictEqual([...(await filter.exclude(WORKTREE, CANDIDATES))], [], 'lib/a.cjs is hand-written now');
    assert.equal(filter.isOutput(WORKTREE, 'lib/a.cjs'), false);
    world.files['tsconfig.json'] = FILES['tsconfig.json'];
    assert.deepStrictEqual([...(await filter.exclude(WORKTREE, CANDIDATES))], ['lib/a.cjs']);
  });

  it('notices a tsconfig that appears next to the sources at the next exclude', async () => {
    const world = makeWorld({});
    const filter = createOutputFilter(world.provider);
    assert.deepStrictEqual([...(await filter.exclude(WORKTREE, CANDIDATES))], []);
    world.files['tsconfig.json'] = FILES['tsconfig.json'];
    assert.deepStrictEqual([...(await filter.exclude(WORKTREE, CANDIDATES))], ['lib/a.cjs']);
  });

  it('an exclude of the candidates and the provider call for the resulting overlay share one description', async () => {
    const world = makeWorld({ ...FILES });
    const filter = createOutputFilter(world.provider);
    const dropped = await filter.exclude(WORKTREE, CANDIDATES);
    const overlay = CANDIDATES.filter((p) => !dropped.has(p));
    const project = await ask(world, overlay);
    assert.equal(world.describes, 1);
    assert.equal(project.emit?.outputToSource('lib/a.cjs'), 'src/a.cts');
  });

  it('never drops a path that is a source of some config (T-03-221)', async () => {
    const world = makeWorld({
      'tsconfig.json': cfg({ rootDir: 'src', outDir: 'src' }, { include: ['src/**/*.cts', 'src/**/*.cjs'], allowJs: true }),
    });
    const filter = createOutputFilter(world.provider);
    const dropped = await filter.exclude(WORKTREE, ['src/a.cts', 'src/a.cjs']);
    assert.deepStrictEqual([...dropped], [], 'src/a.cjs is a source of the config, so it is never an output');
  });
});

describe('modelIdsByExtension', () => {
  const builtinDir = path.resolve(import.meta.dirname, '..', '..', 'modules');

  it('maps the extensions of a module whose manifest names project.model to that model, and no other', () => {
    const tmp = makeTempDir();
    try {
      const map = modelIdsByExtension({ repoRoot: tmp.path, userDir: path.join(tmp.path, 'user'), builtinDir, npmRoots: [] });
      assert.equal(map.get('.cts'), 'typescript');
      assert.equal(map.get('.ts'), 'typescript');
      assert.equal(map.get('.mts'), 'typescript');
      assert.equal(map.get('.cjs'), undefined, 'the javascript module declares no project model');
      assert.equal(map.get('.py'), undefined);
    } finally {
      tmp.cleanup();
    }
  });

  it('follows the module that wins the precedence: a user copy without a project block removes the model', () => {
    const tmp = makeTempDir();
    try {
      const userDir = path.join(tmp.path, 'user');
      const copy = path.join(userDir, 'languages', 'typescript');
      fs.cpSync(path.join(builtinDir, 'typescript'), copy, { recursive: true });
      const manifestPath = path.join(copy, 'atlas-lang.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      delete manifest['project'];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const map = modelIdsByExtension({ repoRoot: tmp.path, userDir, builtinDir, npmRoots: [] });
      assert.equal(map.get('.cts'), undefined);
    } finally {
      tmp.cleanup();
    }
  });
});
