import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import type {
  FileFacts,
  LocatedSymbol,
  ProjectContextProvider,
  RefSiteKey,
  ResolutionContext,
  ResolveScope,
  Span,
  SymbolIdentity,
} from '../facts/index.ts';
import { asStoreResolver, createScriptedResolver } from '../precise-resolver/index.ts';
import { openDatabase } from '../sqlite/index.ts';
import type { Db, DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import { contextKey, overlaySnapshotId, siteId } from './cache.ts';
import { openFactStore } from './open.ts';
import type { OpenFactStoreOptions } from './open.ts';
import { STORE_FILE_NAME } from './schema.ts';
import { candidatePaths, resolveSpecifier } from './specifier.ts';
import type { FactStore, Resolver, StoreDeps, Writer } from './types.ts';

describe('overlaySnapshotId', () => {
  it('is the sha256 of the sorted path and hash pairs, in hex, whatever the map order', () => {
    const expected = createHash('sha256')
      .update('src/a.ts\u0000aaa\u0000src/b.ts\u0000bbb\u0000')
      .digest('hex');
    assert.equal(overlaySnapshotId(new Map([['src/a.ts', 'aaa'], ['src/b.ts', 'bbb']])), expected);
    assert.equal(overlaySnapshotId(new Map([['src/b.ts', 'bbb'], ['src/a.ts', 'aaa']])), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
  });

  it('differs when a hash or a path changes, and two overlays with identical contents share an id', () => {
    const base = new Map([['src/a.ts', 'aaa'], ['src/b.ts', 'bbb']]);
    const id = overlaySnapshotId(base);
    assert.equal(overlaySnapshotId(new Map(base)), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.ts', 'aaa'], ['src/b.ts', 'ccc']])), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.ts', 'aaa'], ['src/c.ts', 'bbb']])), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.ts', 'aaa']])), id);
    assert.notEqual(overlaySnapshotId(new Map([['src/a.tsaaa', '']])), overlaySnapshotId(new Map([['src/a.ts', 'aaa']])));
  });

  it('gives an overlay with no files an id of its own', () => {
    assert.equal(overlaySnapshotId(new Map()), createHash('sha256').digest('hex'));
  });
});

describe('contextKey', () => {
  it('is the JSON of the id and the sorted config hashes, so the order of hashes does not matter', () => {
    const key = contextKey({ id: 'ctx', configHashes: ['b', 'a'] });
    assert.equal(key, '{"id":"ctx","configHashes":["a","b"]}');
    assert.equal(contextKey({ id: 'ctx', configHashes: ['a', 'b'] }), key);
  });

  it('accepts an empty context: an id and no config hashes', () => {
    assert.equal(contextKey({ id: 'grammar', configHashes: [] }), '{"id":"grammar","configHashes":[]}');
  });
});

const paths = (...list: string[]): ReadonlySet<string> => new Set(list);

describe('resolveSpecifier', () => {
  it('resolves ./b to src/b.ts, to src/b/index.ts when only that exists, and to both, sorted, when both exist', () => {
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './b', paths('src/main.ts', 'src/b.ts')), ['src/b.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './b', paths('src/main.ts', 'src/b/index.ts')), ['src/b/index.ts']);
    assert.deepStrictEqual(
      resolveSpecifier('src/main.ts', './b', paths('src/b/index.ts', 'src/main.ts', 'src/b.ts')),
      ['src/b.ts', 'src/b/index.ts'],
    );
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './missing', paths('src/main.ts', 'src/b.ts')), []);
  });

  it('resolves nothing for a package name, a scoped package, an absolute path or a node: built-in', () => {
    const overlay = paths('src/main.ts', 'lodash.ts', 'lodash/index.ts', 'src/lodash.ts');
    for (const specifier of ['lodash', '@scope/pkg', '/abs', 'node:fs', 'src/lodash', '']) {
      assert.deepStrictEqual(resolveSpecifier('src/main.ts', specifier, overlay), [], specifier);
    }
  });

  it('matches both foo.cts and foo.cjs for ../lib/x.cjs from src/a/main.ts', () => {
    const overlay = paths('src/a/main.ts', 'src/lib/x.cts', 'src/lib/x.cjs', 'src/lib/y.cjs');
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../lib/x.cjs', overlay), ['src/lib/x.cjs', 'src/lib/x.cts']);
  });

  it('matches src/a.b.ts for a specifier with an extra dot in the base name (./a.b)', () => {
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './a.b', paths('src/main.ts', 'src/a.b.ts')), ['src/a.b.ts']);
  });

  it('matches by exact path, by extension-stripped path and by extension-stripped specifier', () => {
    const overlay = paths('src/main.ts', 'src/util.js', 'src/util.ts');
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util.js', overlay), ['src/util.js', 'src/util.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util.ts', paths('src/main.ts', 'src/util.ts')), ['src/util.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util', overlay), ['src/util.js', 'src/util.ts']);
  });

  it('a specifier that ends in a slash, a dot or two dots names a directory index only', () => {
    const overlay = paths('src/main.ts', 'src/util.ts', 'src/util/index.ts', 'src/index.ts', 'index.ts');
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util/', overlay), ['src/util/index.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', '.', overlay), ['src/index.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', '..', overlay), ['index.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/main.ts', './util/', paths('src/main.ts', 'src/util.ts')), []);
  });

  it('a specifier that climbs above the root resolves to nothing, and ordinary .. hops resolve', () => {
    const overlay = paths('src/a/main.ts', 'src/lib/util.ts', 'util.ts');
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../../../util', overlay), []);
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../../util', overlay), ['util.ts']);
    assert.deepStrictEqual(resolveSpecifier('src/a/main.ts', '../lib/util', overlay), ['src/lib/util.ts']);
    assert.deepStrictEqual(resolveSpecifier('main.ts', './util', overlay), ['util.ts']);
  });
});

describe('candidatePaths', () => {
  it('lists the resolved base, the base with each claimed extension and the directory index files, in code-unit order', () => {
    assert.deepStrictEqual(candidatePaths('src/main.ts', './b', ['.ts', '.cts']), [
      'src/b',
      'src/b.cts',
      'src/b.ts',
      'src/b/index.cts',
      'src/b/index.ts',
    ]);
  });

  it('adds the extension-stripped variants for a specifier that ends in an extension', () => {
    assert.deepStrictEqual(candidatePaths('src/a/main.ts', '../lib/x.cjs', ['.cts', '.ts']), [
      'src/lib/x',
      'src/lib/x.cjs',
      'src/lib/x.cjs.cts',
      'src/lib/x.cjs.ts',
      'src/lib/x.cjs/index.cts',
      'src/lib/x.cjs/index.ts',
      'src/lib/x.cts',
      'src/lib/x.ts',
    ]);
  });

  it('names only the index file for a specifier that is a directory, and nothing for non-relative or escaping ones', () => {
    assert.deepStrictEqual(candidatePaths('src/main.ts', './util/', ['.ts']), ['src/util/index.ts']);
    assert.deepStrictEqual(candidatePaths('src/main.ts', '.', ['.ts']), ['src/index.ts']);
    assert.deepStrictEqual(candidatePaths('src/main.ts', '..', ['.ts']), ['index.ts']);
    for (const specifier of ['lodash', '@scope/pkg', '/abs', 'node:fs', '', '../../x']) {
      assert.deepStrictEqual(candidatePaths('src/main.ts', specifier, ['.ts']), [], specifier);
    }
  });

  it('has no duplicates and is sorted whatever the extensions repeat', () => {
    const list = candidatePaths('src/main.ts', './b', ['.ts', '.ts', '.js']);
    assert.deepStrictEqual(list, [...new Set(list)].sort());
  });

  it('contains every path the rule can match: resolving over the candidates that exist gives the rule\'s answer', () => {
    const everything = [
      'src/main.ts',
      'src/b.ts',
      'src/b.js',
      'src/b/index.ts',
      'src/b.cjs',
      'src/b.cts',
      'src/a.b.ts',
      'src/util/index.js',
      'src/util.ts',
      'index.ts',
      'src/index.ts',
      'src/other.ts',
    ];
    const extensions = ['.cjs', '.cts', '.js', '.ts'];
    const specifiers = ['./b', './b.js', './b.cjs', './a.b', './util', './util/', '.', '..', './missing', './other.ts'];
    for (const specifier of specifiers) {
      const universe = paths(...everything);
      const probed = paths(...everything.filter((p) => candidatePaths('src/main.ts', specifier, extensions).includes(p)));
      assert.deepStrictEqual(resolveSpecifier('src/main.ts', specifier, probed), resolveSpecifier('src/main.ts', specifier, universe), specifier);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// The resolver seam (plan 03-20): scope and a symbol lookup with spans, a per-overlay asynchronous project
// context, and the negative marker for asked sites. Real stores on a temp directory, both SQLite drivers.
// ---------------------------------------------------------------------------------------------------------

const DRIVERS: readonly DriverName[] = ['node:sqlite', 'better-sqlite3'];

/** The resolver of a store that has no precise resolver: it resolves nothing. */
const noResolver: Resolver = async function* () {
  // a resolver that resolves nothing
};

interface Rig {
  readonly store: FactStore;
  readonly clock: FakeClock;
  /** Close the store and open the same directory again, with these options added. */
  reopen(extra?: Partial<OpenFactStoreOptions>): Promise<FactStore>;
  /** A read-only connection on the store file; closed before the directory goes. */
  peek(): Promise<Db>;
  /** A writable connection on the store file (tests that delete derived rows). */
  tamper(): Promise<Db>;
}

async function withRig(
  driver: DriverName,
  run: (rig: Rig) => Promise<void>,
  options: Partial<OpenFactStoreOptions> = {},
  resolver: Resolver = noResolver,
): Promise<void> {
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const deps: StoreDeps = { resolver, clock, gitHas: async () => true };
  const dir = path.join(tmp.path, 'store');
  const file = path.join(dir, STORE_FILE_NAME);
  const opened: FactStore[] = [];
  const open = async (extra: Partial<OpenFactStoreOptions> = {}): Promise<FactStore> => {
    const store = await openFactStore(dir, deps, { driver, repo: 'repo', version: '9.9.9', ...options, ...extra });
    opened.push(store);
    return store;
  };
  try {
    let current = await open();
    await run({
      get store() {
        return current;
      },
      clock,
      reopen: async (extra) => {
        await current.close();
        current = await open(extra);
        return current;
      },
      peek: async () => tmp.adopt(await openDatabase(file, { readOnly: true, driver })),
      tamper: async () => tmp.adopt(await openDatabase(file, { driver })),
    });
  } finally {
    for (const store of opened) await store.close(); // close the handles before the directory goes (EBUSY on Windows)
    tmp.cleanup();
  }
}

const span = (startLine: number, startColumn: number, endLine = startLine, endColumn = startColumn + 1): Span => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});

/** A 40-hex blob id built from a number, so fixtures read as H(1), H(2). */
const H = (n: number): string => n.toString(16).padStart(40, '0');

function fileOf(filePath: string, n: number, parts: Partial<FileFacts>): FileFacts {
  return {
    path: filePath,
    contentHash: H(n),
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: [],
    refSites: [],
    imports: [],
    exports: [],
    parse: { errorBytes: 0, totalBytes: 100 },
    ...parts,
  };
}

const identity = (filePath: string, qualifiedName: string, kind = 'function'): SymbolIdentity => ({
  repo: 'repo',
  path: filePath,
  qualifiedName,
  kind,
});

/** The two sites in src/use.ts that call `run` from src/lib.ts, and `run` itself. */
const SITE_A: RefSiteKey = { path: 'src/use.ts', span: span(3, 2, 3, 5), name: 'run' };
const SITE_B: RefSiteKey = { path: 'src/use.ts', span: span(6, 2, 6, 5), name: 'run' };
const RUN = identity('src/lib.ts', 'run');

/** The overlay of `seed`, as a path to hash map. */
const SEEDED = new Map([
  ['src/a.ts', H(3)],
  ['src/lib.ts', H(1)],
  ['src/use.ts', H(2)],
]);

/**
 * src/lib.ts defines `run`; src/use.ts imports it and calls it at SITE_A and SITE_B inside `main`; src/a.ts
 * defines two symbols called `parse` (a function and the method `Box.parse`).
 */
async function seed(writer: Writer, worktree = 'main'): Promise<void> {
  await writer.commitFile({
    worktree,
    path: 'src/lib.ts',
    hash: H(1),
    facts: fileOf('src/lib.ts', 1, {
      symbols: [{ name: 'run', kind: 'function', span: span(1, 0, 3, 1), exported: true }],
      exports: [{ name: 'run', span: span(1, 0, 3, 1) }],
    }),
  });
  await writer.commitFile({
    worktree,
    path: 'src/use.ts',
    hash: H(2),
    facts: fileOf('src/use.ts', 2, {
      symbols: [{ name: 'main', kind: 'function', span: span(1, 0, 9, 1) }],
      imports: [{ path: './lib', span: span(0, 0, 0, 22), style: 'es', bindings: [{ imported: 'run', local: 'run' }] }],
      refSites: [
        { name: 'run', span: SITE_A.span, kind: 'call', enclosing: 0, importPath: './lib' },
        { name: 'run', span: SITE_B.span, kind: 'call', enclosing: 0, importPath: './lib' },
      ],
    }),
  });
  await writer.commitFile({
    worktree,
    path: 'src/a.ts',
    hash: H(3),
    facts: fileOf('src/a.ts', 3, {
      symbols: [
        { name: 'parse', kind: 'function', span: span(1, 0, 3, 1) },
        { name: 'Box', kind: 'class', qualifiedName: 'Box', span: span(5, 0, 10, 1) },
        { name: 'parse', kind: 'method', qualifiedName: 'Box.parse', span: span(6, 2, 8, 3), parent: 1 },
      ],
    }),
  });
}

/** What a probing resolver saw on one call. */
interface Seen {
  readonly sites: readonly RefSiteKey[];
  readonly context: ResolutionContext;
  readonly scope: ResolveScope | undefined;
  readonly found: ReadonlyMap<string, readonly LocatedSymbol[]>;
}

const lookupKey = (filePath: string, name: string): string => `${filePath}\u0000${name}`;

/** A store resolver that asks `findIn` for each query, records what it was given, then delegates to `inner`. */
function probing(
  queries: ReadonlyArray<readonly [string, string]>,
  inner?: Resolver,
): { readonly resolver: Resolver; readonly seen: Seen[] } {
  const seen: Seen[] = [];
  const resolver: Resolver = async function* (sites, context, symbols, scope) {
    const found = new Map<string, readonly LocatedSymbol[]>();
    for (const [filePath, name] of queries) found.set(lookupKey(filePath, name), await symbols.findIn(filePath, name));
    seen.push({ sites, context, scope, found });
    if (inner !== undefined) yield* inner(sites, context, symbols, scope);
  };
  return { resolver, seen };
}

const identityOnly = (symbol: LocatedSymbol): SymbolIdentity => ({
  repo: symbol.repo,
  path: symbol.path,
  qualifiedName: symbol.qualifiedName,
  kind: symbol.kind,
  ...(symbol.discriminator === undefined ? {} : { discriminator: symbol.discriminator }),
});

const tiers = (data: ReadonlyArray<{ readonly span: Span; readonly tier: string; readonly confidence: string }>): unknown[] =>
  data.map((record) => [record.span.startLine, record.tier, record.confidence]);

for (const driver of DRIVERS) {
  describe(`resolver seam: scope and symbol lookup (${driver})`, () => {
    it('findIn returns spans: every symbol of that name in the overlay file, with identity and span as find reports them', async () => {
      const { resolver, seen } = probing([['src/a.ts', 'parse']]);
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const reader = rig.store.at('main');
          await reader.refs(RUN);
          assert.equal(seen.length, 1);
          const located = seen[0]?.found.get(lookupKey('src/a.ts', 'parse')) ?? [];
          const expected = (await reader.find('parse')).data.filter((record) => record.source_path === 'src/a.ts');
          assert.equal(expected.length, 2, 'the fixture defines a function and a method called parse');
          assert.deepStrictEqual(located.map(identityOnly), expected.map((record) => record.identity));
          assert.deepStrictEqual(located.map((symbol) => symbol.span), expected.map((record) => record.span));
          assert.deepStrictEqual(located.map((symbol) => symbol.kind), ['function', 'method']);
          writer.release();
        },
        {},
        resolver,
      );
    });

    it('findIn empty for unknown: an unknown path, an unknown name, an empty name and a path outside the overlay', async () => {
      const queries = [
        ['src/missing.ts', 'parse'],
        ['src/a.ts', 'nope'],
        ['src/a.ts', ''],
        ['../outside/a.ts', 'parse'],
        ['/abs/src/a.ts', 'parse'],
        ['src/./a.ts', 'parse'],
      ] as const;
      const { resolver, seen } = probing(queries);
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          await rig.store.at('main').refs(RUN);
          assert.equal(seen.length, 1);
          for (const [filePath, name] of queries) {
            assert.deepStrictEqual(seen[0]?.found.get(lookupKey(filePath, name)), [], `${filePath} ${name}`);
          }
          writer.release();
        },
        {},
        resolver,
      );
    });

    it('identical bytes at two paths: each path gets its own identities and spans from the overlay version of the file', async () => {
      const { resolver, seen } = probing([
        ['src/a.ts', 'parse'],
        ['src/copy.ts', 'parse'],
      ]);
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const linked = await writer.link('main', 'src/copy.ts', H(3));
          assert.equal(linked.status, 'committed');
          await rig.store.at('main').refs(RUN);
          const original = seen[0]?.found.get(lookupKey('src/a.ts', 'parse')) ?? [];
          const copy = seen[0]?.found.get(lookupKey('src/copy.ts', 'parse')) ?? [];
          assert.equal(original.length, 2);
          assert.equal(copy.length, 2);
          assert.deepStrictEqual(original.map((symbol) => symbol.path), ['src/a.ts', 'src/a.ts']);
          assert.deepStrictEqual(copy.map((symbol) => symbol.path), ['src/copy.ts', 'src/copy.ts']);
          assert.deepStrictEqual(copy.map((symbol) => symbol.span), original.map((symbol) => symbol.span));
          writer.release();
        },
        {},
        resolver,
      );
    });

    it('resolver receives scope: the sites asked, the context, a working lookup, the worktree and the overlay snapshot', async () => {
      const scripted = asStoreResolver(createScriptedResolver({ id: 'scripted', edges: [{ site: SITE_B, target: RUN }] }));
      const { resolver, seen } = probing([['src/lib.ts', 'run']], scripted);
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const refs = await rig.store.at('main').refs(RUN);
          assert.equal(seen.length, 1);
          const call = seen[0];
          assert.ok(call?.scope !== undefined, 'the store passes a scope as the fourth argument');
          assert.deepStrictEqual(call.sites, [SITE_A, SITE_B]);
          assert.deepStrictEqual(call.context, { id: 'grammar', configHashes: [] });
          assert.equal(call.scope.worktree, 'main');
          assert.equal(call.scope.overlay.id, overlaySnapshotId(SEEDED));
          assert.deepStrictEqual(call.scope.overlay.pathToHash, SEEDED);
          assert.deepStrictEqual(call.scope.project.context, call.context);
          assert.deepStrictEqual(call.found.get(lookupKey('src/lib.ts', 'run'))?.map(identityOnly), [RUN]);
          assert.deepStrictEqual(tiers(refs.data), [[3, 'grammar', 'INFERRED'], [6, 'precise', 'EXTRACTED']]);
          assert.equal(refs.data[1]?.extractor, 'precise:scripted');
          assert.equal(refs.degraded, undefined);
          writer.release();
        },
        {},
        resolver,
      );
    });

    it('three-argument resolver still works: a plain generator written for the earlier shape is taken as is', async () => {
      const old: Resolver = async function* (sites, context) {
        assert.equal(context.id, 'grammar');
        for (const site of sites) {
          if (siteId(site) === siteId(SITE_B)) yield { site, target: RUN, confidence: 'EXTRACTED', resolver: 'old' };
        }
      };
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const refs = await rig.store.at('main').refs(RUN);
          assert.deepStrictEqual(tiers(refs.data), [[3, 'grammar', 'INFERRED'], [6, 'precise', 'EXTRACTED']]);
          assert.equal(refs.data[1]?.extractor, 'precise:old');
          writer.release();
        },
        {},
        old,
      );
    });
  });
}

function deferred(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Row count of a table, read through a second connection. */
const count = (db: Db, table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);

/**
 * A resolver that binds both sites to `run` and records every call (`seen`), so call counts and arguments can be
 * asserted. Both sites are answered, so a settled read asks nothing (a site with no edge is the negative marker's case).
 */
function binding(): { readonly resolver: Resolver; readonly seen: Seen[] } {
  const inner = asStoreResolver(
    createScriptedResolver({
      id: 'scripted',
      edges: [
        { site: SITE_A, target: RUN },
        { site: SITE_B, target: RUN },
      ],
    }),
  );
  return probing([], inner);
}

const BOTH_PRECISE = [[3, 'precise', 'EXTRACTED'], [6, 'precise', 'EXTRACTED']];
const BOTH_GRAMMAR = [[3, 'grammar', 'INFERRED'], [6, 'grammar', 'INFERRED']];

/** A file with no symbols, added to change the overlay (and so the snapshot id) without touching the sites. */
async function addNoise(writer: Writer, n: number): Promise<void> {
  const filePath = `src/noise${n}.ts`;
  await writer.commitFile({ worktree: 'main', path: filePath, hash: H(100 + n), facts: fileOf(filePath, 100 + n, {}) });
}

for (const driver of DRIVERS) {
  describe(`resolver seam: per-overlay project context (${driver})`, () => {
    it('no provider is grammar: the resolver gets id grammar and no config hashes, as in Phase 2', async () => {
      const { resolver, seen } = binding();
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const peek = await rig.peek();
          const refs = await rig.store.at('main').refs(RUN);
          assert.deepStrictEqual(seen[0]?.context, { id: 'grammar', configHashes: [] });
          assert.deepStrictEqual(seen[0]?.scope?.project, { context: { id: 'grammar', configHashes: [] } });
          assert.deepStrictEqual(tiers(refs.data), BOTH_PRECISE);
          assert.deepStrictEqual(
            peek.prepare('SELECT ctx FROM resolution_contexts').all().map((row) => row.ctx),
            ['{"id":"grammar","configHashes":[]}'],
          );
          writer.release();
        },
        {},
        resolver,
      );
    });

    it('provider context reaches the resolver and keys the cache: a second read asks nothing', async () => {
      const { resolver, seen } = binding();
      const asked: string[] = [];
      const projectContext: ProjectContextProvider = async (scope) => {
        asked.push(`${scope.worktree}:${scope.overlay.id}`);
        return { context: { id: 'ts:test', configHashes: ['aa'] } };
      };
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const peek = await rig.peek();
          const reader = rig.store.at('main');
          const first = await reader.refs(RUN);
          const second = await reader.refs(RUN);
          assert.equal(seen.length, 1, 'the second read is served from the cache');
          assert.deepStrictEqual(seen[0]?.context, { id: 'ts:test', configHashes: ['aa'] });
          assert.deepStrictEqual(seen[0]?.scope?.project.context, { id: 'ts:test', configHashes: ['aa'] });
          assert.deepStrictEqual(asked, [`main:${overlaySnapshotId(SEEDED)}`], 'the provider was told the worktree and the snapshot');
          assert.deepStrictEqual(second.data, first.data);
          assert.deepStrictEqual(
            peek.prepare('SELECT ctx FROM resolution_contexts').all().map((row) => row.ctx),
            ['{"id":"ts:test","configHashes":["aa"]}'],
          );
          assert.equal(count(peek, 'resolved_edges'), 2);
          writer.release();
        },
        { projectContext },
        resolver,
      );
    });

    it('changed config hashes miss: another configuration asks the resolver again and both sets of rows coexist', async () => {
      const { resolver, seen } = binding();
      let hash = 'aa';
      const projectContext: ProjectContextProvider = async () => ({ context: { id: 'ts:test', configHashes: [hash] } });
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const peek = await rig.peek();
          const first = await rig.store.at('main').refs(RUN);
          assert.equal(seen.length, 1);
          assert.equal(count(peek, 'resolved_edges'), 2);

          hash = 'bb';
          writer.release();
          const reopened = await rig.reopen(); // a fresh store asks the provider again; the overlay is unchanged
          const second = await reopened.at('main').refs(RUN);
          assert.equal(seen.length, 2, 'the cache key includes the config hashes, so the new configuration misses');
          assert.deepStrictEqual(seen[1]?.context, { id: 'ts:test', configHashes: ['bb'] });
          assert.deepStrictEqual(second.data, first.data);
          assert.equal(count(peek, 'resolved_edges'), 4, 'both contexts keep their rows while the snapshot is current');
          assert.equal(count(peek, 'resolution_contexts'), 2);

          await reopened.at('main').refs(RUN);
          assert.equal(seen.length, 2, 'the new configuration is now cached too');
        },
        { projectContext },
        resolver,
      );
    });

    it('provider called once per snapshot: reads of an unchanged overlay share one call, a commit asks again', async () => {
      const { resolver } = binding();
      let calls = 0;
      const projectContext: ProjectContextProvider = async () => {
        calls += 1;
        return { context: { id: 'ts:test', configHashes: [] } };
      };
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const reader = rig.store.at('main');
          for (let read = 0; read < 3; read += 1) await reader.refs(RUN);
          await reader.callers(RUN);
          await Promise.all([reader.refs(RUN), reader.callers(RUN)]);
          assert.equal(calls, 1, 'five reads of an unchanged overlay');
          await addNoise(writer, 1);
          await reader.refs(RUN);
          assert.equal(calls, 2, 'a commit that changes the overlay computes the context again');
          writer.release();
        },
        { projectContext },
        resolver,
      );
    });

    it('commit during provider: the read retries once and its cache rows match the snapshot and context it finally used', async () => {
      const { resolver, seen } = binding();
      const gate = deferred();
      const asked: string[] = [];
      const projectContext: ProjectContextProvider = async (scope) => {
        asked.push(scope.overlay.id);
        if (asked.length === 1) await gate.promise;
        return { context: { id: `ts:${scope.overlay.id}`, configHashes: [] } };
      };
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const peek = await rig.peek();
          const pending = rig.store.at('main').refs(RUN);
          assert.equal(asked.length, 1, 'the provider is waiting on the gate');
          await addNoise(writer, 1); // the overlay moves while the provider waits
          gate.open();
          const refs = await pending;

          const moved = new Map([...SEEDED, ['src/noise1.ts', H(101)]]);
          const finalId = overlaySnapshotId(moved);
          assert.deepStrictEqual(asked, [overlaySnapshotId(SEEDED), finalId], 'the provider was asked again for the snapshot the read used');
          assert.equal(seen.length, 1);
          assert.equal(seen[0]?.scope?.overlay.id, finalId);
          assert.deepStrictEqual(seen[0]?.context, { id: `ts:${finalId}`, configHashes: [] });
          assert.equal(refs.degraded, undefined);
          assert.deepStrictEqual(tiers(refs.data), BOTH_PRECISE);
          const rows = peek
            .prepare('SELECT e.snapshot AS snapshot, c.ctx AS ctx FROM resolved_edges e JOIN resolution_contexts c ON c.id = e.context_id')
            .all()
            .map((row) => [row.snapshot, row.ctx]);
          const ctx = `{"id":"ts:${finalId}","configHashes":[]}`;
          assert.deepStrictEqual(rows, [[finalId, ctx], [finalId, ctx]], 'one row per site, all under the final snapshot and context');
          writer.release();
        },
        { projectContext },
        resolver,
      );
    });

    it('provider always loses: the answer is grammar-tier with resolver_failed and no cached rows', async () => {
      const { resolver, seen } = binding();
      let calls = 0;
      let writerRef: Writer | undefined;
      const projectContext: ProjectContextProvider = async () => {
        calls += 1;
        if (writerRef !== undefined) await addNoise(writerRef, calls); // the overlay moves on every call
        return { context: { id: 'ts:test', configHashes: [] } };
      };
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          writerRef = writer;
          const peek = await rig.peek();
          const refs = await rig.store.at('main').refs(RUN);
          assert.equal(calls, 2, 'one try and one retry, no more');
          assert.deepStrictEqual(refs.degraded, ['resolver_failed']);
          assert.deepStrictEqual(tiers(refs.data), BOTH_GRAMMAR);
          assert.equal(seen.length, 0, 'the resolver is not asked under a context computed for another snapshot');
          assert.equal(count(peek, 'resolved_edges'), 0);
          assert.equal(count(peek, 'resolution_contexts'), 0);
          writer.release();
        },
        { projectContext },
        resolver,
      );
    });

    it('provider throws: resolver_failed and the grammar answer, never an error, and a later success is used', async () => {
      const { resolver, seen } = binding();
      let mode: 'reject' | 'throw' | 'ok' = 'reject';
      const projectContext = ((): Promise<{ context: ResolutionContext }> => {
        if (mode === 'throw') throw new Error('provider threw on the call');
        if (mode === 'reject') return Promise.reject(new Error('provider rejected'));
        return Promise.resolve({ context: { id: 'ts:test', configHashes: [] } });
      }) satisfies ProjectContextProvider;
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const reader = rig.store.at('main');
          for (const failing of ['reject', 'throw'] as const) {
            mode = failing;
            const refs = await reader.refs(RUN);
            assert.deepStrictEqual(refs.degraded, ['resolver_failed'], failing);
            assert.deepStrictEqual(tiers(refs.data), BOTH_GRAMMAR, failing);
            const callers = await reader.callers(RUN);
            assert.deepStrictEqual(callers.degraded, ['resolver_failed'], failing);
          }
          assert.equal(seen.length, 0);
          mode = 'ok';
          const recovered = await reader.refs(RUN);
          assert.equal(recovered.degraded, undefined, 'a failure is not remembered');
          assert.deepStrictEqual(tiers(recovered.data), BOTH_PRECISE);
          writer.release();
        },
        { projectContext },
        resolver,
      );
    });

    it('old resolutionContext option: still read on every resolving read, and a change misses the cache', async () => {
      const { resolver, seen } = binding();
      let id = 'ctx-a';
      await withRig(
        driver,
        async (rig) => {
          const writer = rig.store.writer();
          await seed(writer);
          const peek = await rig.peek();
          const reader = rig.store.at('main');
          await reader.refs(RUN);
          await reader.refs(RUN);
          assert.equal(seen.length, 1);
          assert.deepStrictEqual(seen[0]?.context, { id: 'ctx-a', configHashes: ['h2', 'h1'] });
          assert.deepStrictEqual(seen[0]?.scope?.project.context, { id: 'ctx-a', configHashes: ['h2', 'h1'] });
          id = 'ctx-b';
          await reader.refs(RUN);
          assert.equal(seen.length, 2, 'the same overlay under another context misses');
          assert.equal(count(peek, 'resolved_edges'), 4);
          assert.equal(count(peek, 'resolution_contexts'), 2);
          writer.release();
        },
        { resolutionContext: () => ({ id, configHashes: ['h2', 'h1'] }) },
        resolver,
      );
    });
  });
}
