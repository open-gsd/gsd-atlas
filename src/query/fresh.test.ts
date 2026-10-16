import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Envelope, Request } from '../facts/index.ts';
import { createHarness } from './harness.test.ts';
import type { Harness } from './harness.test.ts';
import type { FreshPort, FreshReport } from './index.ts';

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
