import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Answer, FileFacts, SymbolIdentity } from '../facts/index.ts';
import { IDLE_MAINTENANCE, SchemaTooNew, StoreClosed, UnknownWorktree, WriterBusy } from './index.ts';
import type { FactStore, OpenStore, Reader, RefRecord, StoreDeps, SymbolRecord, WorktreeId } from './index.ts';

const here = import.meta.dirname;

describe('fact-store errors', () => {
  it('are Error subclasses with stable names', () => {
    const errors = [new SchemaTooNew('2.1.0'), new WriterBusy(), new UnknownWorktree('wt-1'), new StoreClosed()];
    for (const error of errors) assert.ok(error instanceof Error);
    assert.deepStrictEqual(
      errors.map((e) => e.name),
      ['SchemaTooNew', 'WriterBusy', 'UnknownWorktree', 'StoreClosed'],
    );
    assert.equal(new Set(errors.map((e) => e.constructor)).size, 4);
    assert.ok(!(errors[1] instanceof SchemaTooNew));
  });

  it('SchemaTooNew names the host version needed', () => {
    const error = new SchemaTooNew('2.1.0');
    assert.equal(error.hostVersion, '2.1.0');
    assert.match(error.message, /2\.1\.0/);
  });

  it('UnknownWorktree carries the worktree', () => {
    assert.equal(new UnknownWorktree('wt-1').worktree, 'wt-1');
  });
});

// Compile-time proof that the frozen signatures type-check. This function is never called: the runtime
// behaviour of every member is proven by the contract suite (contract.ts) against the real store.
async function typeCheckedUsage(store: FactStore, w: WorktreeId, id: SymbolIdentity, facts: FileFacts): Promise<void> {
  const refs: Answer<readonly RefRecord[]> = await store.at(w).refs(id, { timeoutMs: 1500 });
  const hops = await store.at(w).callers(id, { hops: 2, timeoutMs: 1500 });
  const found: Answer<readonly SymbolRecord[]> = await store.at(w).find('getUserName', { mode: 'fuzzy', limit: 10 });
  const one: Answer<SymbolRecord | null> = await store.at(w).symbol(id);
  const file: Answer<FileFacts | null> = await store.at(w).fileFacts('src/a.ts');
  const importers = await store.at(w).importers('src/a.ts', { depth: 1, limit: 5 });
  const writer = store.writer();
  const result = await writer.commitFile({ worktree: w, path: 'src/a.ts', hash: 'abc', facts });
  await writer.commitFile({ worktree: w, path: 'src/gone.ts', hash: 'def', facts: null });
  await writer.link(w, 'src/copy.ts', 'abc');
  await writer.setOverlay(w, 'refs/heads/main', new Map([['src/a.ts', 'abc']]));
  await writer.dropOverlay(w);
  await writer.markStale({ module: 'typescript', grammarVersion: '0.23.2' });
  writer.release();
  await store.reconcile({ worktree: w, pathToHash: new Map() });
  await store.collect({ budgetMs: 50 });
  await store.compact({ budgetMs: 50 });
  await store.check();
  await store.maintain(50);
  await store.maintain(50, IDLE_MAINTENANCE);
  const status = await store.status();
  void status.leaseHolder?.pid;
  await store.close();
  void [refs, hops, found, one, file, importers, result];
}

// A `Reader` literal must return `Answer` values. Type-level only; it is not a store and nothing uses it.
const readerShape = {
  find: async () => ({ data: [], watermark: { seq: 0, stalePaths: [] } }),
  refs: async () => ({ data: [], watermark: { seq: 0, stalePaths: [] }, degraded: ['resolver_timeout'] }),
  callers: async () => ({ data: [], watermark: { seq: 0, stalePaths: [] }, degraded: ['cache_unavailable'] }),
  symbol: async () => ({ data: null, watermark: { seq: 0, stalePaths: [] } }),
  fileFacts: async () => ({ data: null, watermark: { seq: 0, stalePaths: [] } }),
  importers: async () => ({ data: [], watermark: { seq: 0, stalePaths: [] } }),
} satisfies Reader;

describe('fact-store interface', () => {
  it('type-checks the documented signatures (compile-time; see typeCheckedUsage)', () => {
    assert.equal(typeof typeCheckedUsage, 'function');
    assert.equal(typeof readerShape.refs, 'function');
    const deps: StoreDeps | undefined = undefined;
    const open: OpenStore | undefined = undefined;
    assert.equal(deps, undefined);
    assert.equal(open, undefined);
  });

  it('exports the four error classes, openFactStore, the store-location functions and the specifier rule as values, and nothing else (no fake store)', async () => {
    const mod = await import('./index.ts');
    assert.deepStrictEqual(Object.keys(mod).sort(), [
      'IDLE_MAINTENANCE',
      'SchemaTooNew',
      'StoreClosed',
      'UnknownWorktree',
      'WriterBusy',
      'candidatePaths',
      'decideStoreLocation',
      'defaultCacheRoot',
      'findExistingStore',
      'isSyncedFolderPath',
      'openFactStore',
      'probeStore',
      'resolveSpecifier',
      'resolveStoreLocation',
    ]);
    assert.equal(typeof mod.openFactStore, 'function');
    assert.deepStrictEqual({ ...mod.IDLE_MAINTENANCE }, { full: true });
    assert.equal(Object.isFrozen(mod.IDLE_MAINTENANCE), true);
  });

  it('names a driver option only in open.ts, and reaches the SQLite kit only through its index', () => {
    const production = fs
      .readdirSync(here)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'contract.ts');
    assert.ok(production.includes('open.ts'));
    for (const file of production) {
      const text = fs.readFileSync(path.join(here, file), 'utf8');
      if (file !== 'open.ts') {
        assert.doesNotMatch(text, /\bdriver\??\s*:|\bDriverName\b/, `${file} names a driver option`);
      }
      for (const match of text.matchAll(/from\s+['"]([^'"]*sqlite[^'"]*)['"]/g)) {
        assert.equal(match[1], '../sqlite/index.ts', `${file} imports the SQLite kit by a path other than its index`);
      }
    }
  });

  it('keeps types.ts, errors.ts and index.ts free of the SQLite kit (the interface owns no engine)', () => {
    for (const file of ['errors.ts', 'index.ts', 'types.ts']) {
      const text = fs.readFileSync(path.join(here, file), 'utf8');
      assert.doesNotMatch(text, /from\s+['"][^'"]*sqlite[^'"]*['"]/, `${file} imports a SQLite module`);
      assert.doesNotMatch(text, /import\(\s*['"][^'"]*sqlite/, `${file} dynamically imports a SQLite module`);
    }
  });

  it('documents the resolver_timeout and cache_unavailable resolutions (D-17, D-16) and the absence of warm', () => {
    const text = fs.readFileSync(path.join(here, 'types.ts'), 'utf8');
    assert.match(text, /resolver_timeout/);
    assert.match(text, /cache_unavailable/);
    assert.match(text, /no `warm\(worktree\)`/);
    assert.match(text, /writer-lease holder/);
  });
});
