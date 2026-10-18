/**
 * Plan 03-26: handles and `Reader.provenance`. A handle is opaque to callers and parsed only here: a strict grammar for the
 * five shapes the store and Query issue (`sym/`, `ref/`, `imp/`, `exp/` and the compiler relation `rel/`), and a lookup by
 * (path, file content hash, ordinal) in the overlay the reader sees. Real stores on a temp directory, both SQLite drivers.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FileFacts, PreciseFacts, ProjectContextProvider, RefSiteKey, Span, SymbolIdentity } from '../facts/index.ts';
import { asStoreResolver, createScriptedResolver } from '../precise-resolver/index.ts';
import type { DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import { openFactStore } from './open.ts';
import type { OpenFactStoreOptions } from './open.ts';
import { MAX_HANDLE_CHARS, formatHandle, parseHandle } from './provenance.ts';
import type { Handle } from './provenance.ts';
import { STORE_FILE_NAME } from './schema.ts';
import type { FactExplanation, FactStore, Resolver, Writer } from './types.ts';

const DRIVERS: readonly DriverName[] = ['node:sqlite', 'better-sqlite3'];

/** A 40-hex blob id built from a number. */
const H = (n: number): string => n.toString(16).padStart(40, '0');
const H64 = (n: number): string => n.toString(16).padStart(64, '0');

describe('parseHandle and formatHandle', () => {
  it('parse and format round trip', () => {
    const cases: Array<readonly [string, Handle]> = [
      [`sym/src%2Fa.ts/${H(1)}/0`, { kind: 'sym', path: 'src/a.ts', hash: H(1), ord: 0 }],
      [`ref/src%2Fa.cts/${H(2)}/16`, { kind: 'ref', path: 'src/a.cts', hash: H(2), ord: 16 }],
      [`imp/src%2Fapp%2Fmain.ts/${H64(3)}/4`, { kind: 'imp', path: 'src/app/main.ts', hash: H64(3), ord: 4 }],
      [`exp/index.ts/${H(4)}/12`, { kind: 'exp', path: 'index.ts', hash: H(4), ord: 12 }],
      [
        `rel/extends/src%2Fsub.ts/${H(5)}/2/src%2Fbase.ts/0`,
        { kind: 'rel', relation: 'extends', path: 'src/sub.ts', hash: H(5), ord: 2, toPath: 'src/base.ts', toOrd: 0 },
      ],
    ];
    for (const [text, expected] of cases) {
      assert.deepStrictEqual(parseHandle(text), expected, text);
      assert.equal(formatHandle(expected), text);
    }
  });

  it('rejects malformed handles', () => {
    const good = `ref/src%2Fa.ts/${H(1)}/3`;
    assert.notEqual(parseHandle(good), null);
    const bad: unknown[] = [
      '',
      'nonsense',
      `${good}/extra`,
      `ref/${H(1)}/3`,
      `ref//${H(1)}/3`,
      `ref/src%2Fa.ts/${H(1)}/-1`,
      `ref/src%2Fa.ts/${H(1)}/1.5`,
      `ref/src%2Fa.ts/${H(1)}/01`,
      `ref/src%2Fa.ts/${H(1)}/abc`,
      `ref/src%2Fa.ts/${H(1)}/99999999999999999999`,
      `ref/src%2Fa.ts/${H(1)}/`,
      `ref/src%2Fa.ts/${H(1).toUpperCase()}/3`,
      `ref/src%2Fa.ts/${H(1).slice(1)}/3`,
      `ref/src%2Fa.ts/${H(1)}0/3`,
      `ref/%2E%2E%2Fetc%2Fpasswd/${H(1)}/3`,
      `ref/src%2F..%2Fa.ts/${H(1)}/3`,
      `ref/%2Fetc%2Fpasswd/${H(1)}/3`,
      `ref/C%3A%5Cwindows/${H(1)}/3`,
      `ref/src%5Ca.ts/${H(1)}/3`,
      `ref/src%00a.ts/${H(1)}/3`,
      `ref/src%2fa.ts/${H(1)}/3`,
      `ref/src%ZZa.ts/${H(1)}/3`,
      `ref/src a.ts/${H(1)}/3`,
      `zzz/src%2Fa.ts/${H(1)}/3`,
      `rel/inherits/src%2Fsub.ts/${H(5)}/2/src%2Fbase.ts/0`,
      `rel/extends/src%2Fsub.ts/${H(5)}/2/src%2Fbase.ts`,
      `rel/extends/src%2Fsub.ts/${H(5)}/2/..%2Fbase.ts/0`,
      `sym/${'a'.repeat(MAX_HANDLE_CHARS)}/${H(1)}/0`,
      null,
      undefined,
      42,
      {},
    ];
    for (const text of bad) assert.equal(parseHandle(text as string), null, JSON.stringify(text));
  });

  it('unicode and percent paths', () => {
    for (const filePath of ['src/café.ts', 'src/100%.ts', 'src/a b.ts', 'src/\u{1F600}.ts', 'src/a#b?c.ts', "src/it's.ts", 'src/a%2Fb.ts', 'src/(x)!~*.ts']) {
      const handle: Handle = { kind: 'sym', path: filePath, hash: H(7), ord: 3 };
      const text = formatHandle(handle);
      assert.equal(text, `sym/${encodeURIComponent(filePath)}/${H(7)}/3`);
      assert.deepStrictEqual(parseHandle(text), handle, filePath);
    }
  });

  it('is at most 2,048 characters', () => {
    assert.equal(MAX_HANDLE_CHARS, 2048);
    const long = formatHandle({ kind: 'sym', path: `${'d/'.repeat(500)}a.ts`, hash: H(1), ord: 0 });
    assert.ok(long.length > MAX_HANDLE_CHARS);
    assert.equal(parseHandle(long), null);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Reader.provenance over real stores.
// ---------------------------------------------------------------------------------------------------------

const span = (startLine: number, startColumn: number, endLine = startLine, endColumn = startColumn + 1): Span => ({ startLine, startColumn, endLine, endColumn });

const noResolver: Resolver = async function* () {
  // resolves nothing
};

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

const SITE_A: RefSiteKey = { path: 'src/use.ts', span: span(3, 2, 3, 5), name: 'run' };
const SITE_B: RefSiteKey = { path: 'src/use.ts', span: span(6, 2, 6, 5), name: 'run' };
const RUN: SymbolIdentity = { repo: 'repo', path: 'src/lib.ts', qualifiedName: 'run', kind: 'function' };

/** src/lib.ts defines `run`; src/use.ts imports and exports it, and calls it at SITE_A and SITE_B. */
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
      exports: [{ name: 'main', span: span(1, 0, 9, 1) }],
      refSites: [
        { name: 'run', span: SITE_A.span, kind: 'call', enclosing: 0, importPath: './lib' },
        { name: 'run', span: SITE_B.span, kind: 'call', enclosing: 0, importPath: './lib' },
      ],
    }),
  });
}

async function withStore(
  driver: DriverName,
  run: (store: FactStore) => Promise<void>,
  options: Partial<OpenFactStoreOptions> = {},
  resolver: Resolver = noResolver,
): Promise<void> {
  const tmp = makeTempDir();
  const store = await openFactStore(
    path.join(tmp.path, 'store'),
    { resolver, clock: new FakeClock(1000), gitHas: async () => true },
    { driver, repo: 'repo', version: '9.9.9', ...options },
  );
  try {
    await run(store);
  } finally {
    await store.close();
    tmp.cleanup();
  }
  void STORE_FILE_NAME;
}

const explanation = (data: FactExplanation | 'stale' | null): FactExplanation => {
  assert.ok(data !== null && data !== 'stale', `an explanation, got ${String(data)}`);
  return data;
};

for (const driver of DRIVERS) {
  describe(`Reader.provenance (${driver})`, () => {
    it('a symbol handle: the definition, EXTRACTED, grammar tier, the file version and the overlay, no resolution', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await seed(writer);
        const reader = store.at('main');
        const record = (await reader.find('run')).data[0];
        assert.ok(record !== undefined);
        const answer = await reader.provenance(record.debug);
        const found = explanation(answer.data);
        assert.equal(found.kind, 'symbol');
        assert.equal(found.handle, record.debug);
        assert.equal(found.fact.extractor, 'grammar:typescript@0.23.2');
        assert.equal(found.fact.tier, 'grammar');
        assert.equal(found.fact.confidence, 'EXTRACTED');
        assert.equal(found.fact.module, 'typescript');
        assert.equal(found.fact.grammarVersion, '0.23.2');
        assert.equal(found.fact.stale, false);
        assert.equal(found.fact.path, 'src/lib.ts');
        assert.equal(found.fact.contentHash, H(1));
        assert.deepStrictEqual(found.fact.span, span(1, 0, 3, 1));
        assert.equal(typeof found.fact.firstSeen, 'number');
        assert.equal(typeof found.fact.lastSeen, 'number');
        assert.equal(found.resolution, null);
        assert.equal(found.overlay.worktree, 'main');
        assert.equal(found.overlay.seq, answer.watermark.seq);
        assert.equal(found.overlay.stalePaths, 0);
        writer.release();
      });
    });

    it('a reference handle in a store with no precise tier: INFERRED, grammar, the cache is not applicable', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await seed(writer);
        const reader = store.at('main');
        const refs = (await reader.refs(RUN)).data;
        assert.equal(refs.length, 2);
        const found = explanation((await reader.provenance(refs[0]?.debug ?? '')).data);
        assert.equal(found.kind, 'reference');
        assert.equal(found.fact.tier, 'grammar');
        assert.equal(found.fact.confidence, 'INFERRED');
        assert.equal(found.fact.path, 'src/use.ts');
        assert.deepStrictEqual(found.fact.span, SITE_A.span);
        assert.ok(found.resolution !== null);
        assert.equal(found.resolution.cache, 'not_applicable');
        assert.equal(found.resolution.contextId, 'grammar');
        assert.equal(found.resolution.configHashCount, 0);
        assert.match(found.resolution.snapshot, /^[0-9a-f]{64}$/);
        writer.release();
      });
    });

    it('import and export handles describe the statement itself: EXTRACTED, grammar, no resolution', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await seed(writer);
        const reader = store.at('main');
        const imported = explanation((await reader.provenance(formatHandle({ kind: 'imp', path: 'src/use.ts', hash: H(2), ord: 0 }))).data);
        assert.equal(imported.kind, 'import');
        assert.equal(imported.fact.confidence, 'EXTRACTED');
        assert.equal(imported.fact.tier, 'grammar');
        assert.equal(imported.resolution, null);
        assert.deepStrictEqual(imported.fact.span, span(0, 0, 0, 22));
        const exported = explanation((await reader.provenance(formatHandle({ kind: 'exp', path: 'src/lib.ts', hash: H(1), ord: 0 }))).data);
        assert.equal(exported.kind, 'export');
        assert.equal(exported.fact.extractor, 'grammar:typescript@0.23.2');
        assert.equal(exported.resolution, null);
        writer.release();
      });
    });

    it('stale hash: a handle whose file changed since it was issued is stale, not unknown', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await seed(writer);
        const reader = store.at('main');
        const old = (await reader.find('run')).data[0]?.debug ?? '';
        assert.equal(typeof explanation((await reader.provenance(old)).data).kind, 'string');
        // The file is edited: the overlay now maps the path to another version.
        await writer.commitFile({
          worktree: 'main',
          path: 'src/lib.ts',
          hash: H(9),
          facts: fileOf('src/lib.ts', 9, { symbols: [{ name: 'run', kind: 'function', span: span(2, 0, 4, 1), exported: true }] }),
        });
        const after = await reader.provenance(old);
        assert.equal(after.data, 'stale');
        const fresh = (await reader.find('run')).data[0]?.debug ?? '';
        assert.notEqual(fresh, old);
        assert.equal(explanation((await reader.provenance(fresh)).data).fact.contentHash, H(9));
        writer.release();
      });
    });

    it('an unknown path, an ordinal out of range, a malformed or oversized handle and a handle that reaches outside the overlay are all null', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await seed(writer);
        const reader = store.at('main');
        const unknown = [
          formatHandle({ kind: 'sym', path: 'src/nowhere.ts', hash: H(1), ord: 0 }),
          formatHandle({ kind: 'sym', path: 'src/lib.ts', hash: H(1), ord: 7 }),
          formatHandle({ kind: 'ref', path: 'src/use.ts', hash: H(2), ord: 2 }),
          formatHandle({ kind: 'imp', path: 'src/use.ts', hash: H(2), ord: 1 }),
          formatHandle({ kind: 'exp', path: 'src/lib.ts', hash: H(1), ord: 1 }),
          `sym/${encodeURIComponent('../../etc/passwd')}/${H(1)}/0`,
          `sym/%2E%2E%2Fsecret/${H(1)}/0`,
          'not a handle',
          '',
          `sym/${'x'.repeat(5000)}/${H(1)}/0`,
        ];
        for (const handle of unknown) {
          const answer = await reader.provenance(handle);
          assert.equal(answer.data, null, handle.slice(0, 80));
        }
        writer.release();
      });
    });

    it('a stale grammar marker is reported on the fact', async () => {
      await withStore(driver, async (store) => {
        const writer = store.writer();
        await seed(writer);
        const reader = store.at('main');
        const handle = (await reader.find('run')).data[0]?.debug ?? '';
        assert.equal(explanation((await reader.provenance(handle)).data).fact.stale, false);
        assert.equal(await writer.markStale({ module: 'typescript', grammarVersion: '0.24.0' }), 2);
        const found = await reader.provenance(handle);
        const marked = explanation(found.data);
        assert.equal(marked.fact.stale, true);
        assert.equal(marked.fact.grammarVersion, '0.23.2');
        assert.ok((found.degraded ?? []).includes('stale'));
        assert.equal(marked.overlay.stalePaths, 2);
        writer.release();
      });
    });

    it('never asks the resolver and never writes: a precise store answers from what the cache holds', async () => {
      let asked = 0;
      const scripted = createScriptedResolver({
        id: 'typescript',
        edges: [{ site: SITE_A, target: RUN }],
        onClose: () => {
          asked += 1;
        },
      });
      const facts: PreciseFacts = {
        ownerOf: () => 'tsconfig.json',
        requiresOwner: () => true,
        compiler: { source: 'project', version: '6.0.2', dir: 'node_modules/typescript', case: 'project-6' },
        configs: ['tsconfig.json'],
      };
      const projectContext: ProjectContextProvider = async () => ({ context: { id: 'ts:test', configHashes: ['aa', 'bb'] }, precise: facts });
      await withStore(
        driver,
        async (store) => {
          const writer = store.writer();
          await seed(writer);
          const reader = store.at('main');
          const siteHandle = formatHandle({ kind: 'ref', path: 'src/use.ts', hash: H(2), ord: 0 });
          const siteOther = formatHandle({ kind: 'ref', path: 'src/use.ts', hash: H(2), ord: 1 });
          // Nobody asked yet: explaining does not ask either.
          const before = explanation((await reader.provenance(siteHandle)).data);
          assert.equal(before.resolution?.cache, 'not_asked');
          assert.equal(before.fact.tier, 'grammar');
          assert.equal(before.resolution?.contextId, 'ts:test');
          assert.equal(before.resolution?.configHashCount, 2);
          assert.equal(asked, 0, 'explain never runs the resolver');
          // A read resolves both sites: one has an edge, the other was asked and has none.
          await reader.refs(RUN);
          assert.equal(asked, 1);
          const hit = explanation((await reader.provenance(siteHandle)).data);
          assert.equal(hit.resolution?.cache, 'hit');
          assert.equal(hit.resolution?.resolver, 'typescript');
          assert.deepStrictEqual(hit.resolution?.target, { name: 'run', kind: 'function', path: 'src/lib.ts' });
          assert.equal(hit.fact.tier, 'precise');
          assert.equal(hit.fact.confidence, 'EXTRACTED');
          assert.equal(hit.fact.extractor, 'precise:typescript');
          const none = explanation((await reader.provenance(siteOther)).data);
          assert.equal(none.resolution?.cache, 'asked_no_edge');
          assert.equal(none.fact.tier, 'grammar');
          assert.equal(none.fact.confidence, 'INFERRED');
          assert.equal(asked, 1, 'still one resolver call');
          writer.release();
        },
        { projectContext },
        asStoreResolver(scripted),
      );
    });
  });
}
