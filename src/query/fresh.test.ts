import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Reader } from '../fact-store/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { createHarness } from './harness.test.ts';
import type { Harness } from './harness.test.ts';
import type { FreshPort, FreshReport, QueryDeps } from './index.ts';

async function world(t: TestContext): Promise<Harness> {
  const harness = await createHarness();
  t.after(() => harness.cleanup());
  await harness.addFile('src/a.ts', 'export function parse(input) {}\n', [{ name: 'parse', line: 0, col: 16, exported: true }]);
  return harness;
}

interface Call {
  readonly worktree: string;
  readonly paths: readonly string[];
  readonly waitMs: number;
}

/** A port that records its calls and answers `report` (or throws `failure`). */
function stubPort(report: FreshReport, calls: Call[], failure?: Error): FreshPort {
  return {
    ensureFresh: (worktree, paths, waitMs) => {
      calls.push({ worktree, paths, waitMs });
      return failure === undefined ? Promise.resolve(report) : Promise.reject(failure);
    },
  };
}

const COMPLETE: FreshReport = { complete: true, stalePaths: [], invalid: [] };

const findWith = (h: Harness, fresh: readonly string[] | undefined): Request => ({
  protocol: 1,
  kind: 'code_find',
  args: { name: 'parse', repo: h.dir },
  worktree: h.dir,
  ...(fresh === undefined ? {} : { fresh }),
});

const resultCount = (envelope: Envelope): number => (envelope.data as { results: unknown[] }).results.length;

describe('fresh paths: read your own writes, or degrade', () => {
  it('calls the port once with the request worktree, the paths and the approved wait', async (t) => {
    const h = await world(t);
    const calls: Call[] = [];

    const envelope = await h.query({ fresh: stubPort(COMPLETE, calls) }).ask(findWith(h, ['src/a.ts', 'src/b.ts']));

    assert.equal(envelope.ok, true);
    assert.deepEqual(calls, [{ worktree: h.dir, paths: ['src/a.ts', 'src/b.ts'], waitMs: 2000 }]);
    assert.equal('degraded' in envelope, false);
    assert.deepEqual(envelope.diagnostics, []);
  });

  it('uses the configured wait when one is set', async (t) => {
    const h = await world(t);
    const calls: Call[] = [];

    await h.query({ fresh: stubPort(COMPLETE, calls), config: { ensureFreshWaitMs: 777 } }).ask(findWith(h, ['src/a.ts']));

    assert.equal(calls[0]?.waitMs, 777);
  });

  it('does not call the port when the request names no fresh paths', async (t) => {
    const h = await world(t);
    const calls: Call[] = [];
    const query = h.query({ fresh: stubPort(COMPLETE, calls) });

    await query.ask(findWith(h, undefined));
    await query.ask(findWith(h, []));

    assert.deepEqual(calls, []);
  });

  it('reads after the port answers, so a file the Indexer just stored is found', async (t) => {
    const h = await world(t);
    const port: FreshPort = {
      ensureFresh: async () => {
        await h.addFile('src/new.ts', 'export function brandNew() {}\n', [{ name: 'brandNew', line: 0, col: 16, exported: true }]);
        return COMPLETE;
      },
    };

    const envelope = await h
      .query({ fresh: port })
      .ask({ protocol: 1, kind: 'code_find', args: { name: 'brandNew', repo: h.dir }, worktree: h.dir, fresh: ['src/new.ts'] });

    assert.equal(resultCount(envelope), 1);
  });

  it('answers from the store with degraded fresh_timeout when the port reports it did not finish', async (t) => {
    const h = await world(t);
    const calls: Call[] = [];

    const envelope = await h
      .query({ fresh: stubPort({ complete: false, stalePaths: ['a.ts'], invalid: [] }, calls) })
      .ask(findWith(h, ['a.ts']));

    assert.equal(envelope.ok, true);
    assert.equal(resultCount(envelope), 1, 'still answers from the store');
    assert.deepEqual(envelope.degraded, ['fresh_timeout']);
    assert.ok(envelope.watermark !== undefined, 'with the old watermark');
  });

  it('adds an invalid_fresh_path warning when the port refused some of the paths', async (t) => {
    const h = await world(t);

    const envelope = await h
      .query({ fresh: stubPort({ complete: true, stalePaths: [], invalid: ['../x', '/etc/passwd'] }, []) })
      .ask(findWith(h, ['../x', '/etc/passwd']));

    assert.equal(envelope.ok, true);
    const warning = envelope.diagnostics.find((d) => d.code === 'invalid_fresh_path');
    assert.ok(warning !== undefined, 'an invalid_fresh_path diagnostic');
    assert.equal(warning.severity, 'warning');
    assert.equal('degraded' in envelope, false, 'a refused path is not a timeout');
  });

  it('degrades with fresh_timeout instead of failing when the port throws', async (t) => {
    const h = await world(t);

    const envelope = await h
      .query({ fresh: stubPort(COMPLETE, [], new Error('the indexer is gone')) })
      .ask(findWith(h, ['src/a.ts']));

    assert.equal(envelope.ok, true);
    assert.equal(resultCount(envelope), 1);
    assert.deepEqual(envelope.degraded, ['fresh_timeout']);
  });

  it('degrades with fresh_timeout when fresh paths are named but no port is configured', async (t) => {
    const h = await world(t);

    const envelope = await h.query().ask(findWith(h, ['src/a.ts']));

    assert.equal(envelope.ok, true);
    assert.equal(resultCount(envelope), 1);
    assert.deepEqual(envelope.degraded, ['fresh_timeout']);
  });

  it('drops the line text of a path the port could not finish, because the file on disk is newer than its facts', async (t) => {
    const h = await world(t);

    const envelope = await h
      .query({ fresh: stubPort({ complete: false, stalePaths: ['src/a.ts'], invalid: [] }, []) })
      .ask(findWith(h, ['src/a.ts']));

    assert.equal(resultCount(envelope), 1);
    assert.equal('untrusted_text' in envelope, false);
    assert.equal(envelope.citations?.[0]?.text_ref, undefined);
    assert.deepEqual(envelope.degraded, ['fresh_timeout', 'stale']);
  });
});

describe('fresh paths: one Reader per request', () => {
  it('reads every code tool through the Reader the fresh port returned and never asks the store for one', async (t) => {
    const h = await world(t);
    let storeAsked = 0;
    const store: QueryDeps['store'] = {
      at: (worktree) => {
        storeAsked += 1;
        return h.store.at(worktree);
      },
    };
    const real = h.store.at(h.dir);
    const calls: string[] = [];
    const counting: Reader = {
      find: (name, options) => {
        calls.push('find');
        return real.find(name, options);
      },
      refs: (id, options) => {
        calls.push('refs');
        return real.refs(id, options);
      },
      callers: (id, options) => {
        calls.push('callers');
        return real.callers(id, options);
      },
      symbol: (id) => {
        calls.push('symbol');
        return real.symbol(id);
      },
      fileFacts: (path) => {
        calls.push('fileFacts');
        return real.fileFacts(path);
      },
      importers: (path, options) => {
        calls.push('importers');
        return real.importers(path, options);
      },
      emittedAs: (path) => {
        calls.push('emittedAs');
        return real.emittedAs(path);
      },
      relations: (id, options) => {
        calls.push('relations');
        return real.relations(id, options);
      },
      provenance: (handle) => {
        calls.push('provenance');
        return real.provenance(handle);
      },
      citations: (query, options) => {
        calls.push('citations');
        return real.citations(query, options);
      },
      citationGaps: (options) => {
        calls.push('citationGaps');
        return real.citationGaps(options);
      },
    };
    const port: FreshPort = { ensureFresh: () => Promise.resolve({ ...COMPLETE, reader: counting }) };
    const query = h.query({ store, fresh: port });

    for (const kind of ['code_find', 'code_refs', 'code_context', 'code_impact']) {
      calls.length = 0;
      const envelope = await query.ask({ protocol: 1, kind, args: { name: 'parse', repo: h.dir }, worktree: h.dir, fresh: ['src/a.ts'] });
      assert.equal(envelope.ok, true, `${kind}: ${JSON.stringify(envelope.diagnostics)}`);
      assert.ok(calls.includes('find'), `${kind} read through the overlay Reader`);
    }
    assert.equal(storeAsked, 0, 'the store was never asked for a Reader of an overlay request');

    // Without an overlay the store's own Reader is the one request Reader.
    await h.query({ store }).ask(findWith(h, undefined));
    assert.equal(storeAsked, 1, 'exactly one Reader is asked for per request');
  });
});
