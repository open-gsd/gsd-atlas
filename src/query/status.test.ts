import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { StoreStatus } from '../fact-store/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import type { GovernorStatus } from '../governor/index.ts';
import { createHarness } from './harness.test.ts';
import type { Harness } from './harness.test.ts';
import type { IndexerStatusLike, StatusPort } from './index.ts';
import { BUG_HINT } from './status.ts';

async function world(t: TestContext): Promise<Harness> {
  const harness = await createHarness();
  t.after(() => harness.cleanup());
  return harness;
}

interface Snapshot {
  readonly repo: string | null;
  readonly worktrees: readonly { worktree: string; seq: number; staleCount: number }[];
  readonly store: { schemaVersion: number; sizeBytes: number; writerLeaseHeld: boolean; rebuilt: boolean };
  readonly indexer: {
    watchMode: string;
    queued: number;
    running: number;
    failed: number;
    reconciling: boolean;
    lastReconcileAt: number | null;
    lastIndexedAt: number | null;
  } | null;
  readonly governor: { queued: number; running: number; leases: number };
  readonly citations: { filesWithGaps: number };
  readonly tiers: readonly { module: string; grammar: boolean; precise: boolean; platform: boolean }[];
  readonly policy: string;
  readonly health: string;
  readonly reasons: readonly string[];
}

const snapshotOf = (envelope: Envelope): Snapshot => envelope.data as Snapshot;

function statusRequest(h: Harness, args: Record<string, unknown> = {}): Request {
  return { protocol: 1, kind: 'atlas_status', args: { repo: h.dir, ...args }, worktree: h.dir };
}

interface Overrides {
  readonly store?: Partial<StoreStatus>;
  readonly indexer?: Partial<IndexerStatusLike> | null;
  readonly staleCount?: number;
}

/** A healthy set of ports; each test breaks exactly the part it is about. */
function ports(h: Harness, overrides: Overrides = {}): StatusPort {
  const store: StoreStatus = {
    schemaVersion: 1,
    worktrees: [{ worktree: h.dir, seq: 7, stalePaths: overrides.staleCount ?? 0, files: 3, citationGapFiles: 0 }],
    sizeBytes: 4096,
    writerLeaseHeld: true,
    ...overrides.store,
  };
  const indexer: IndexerStatusLike | null =
    overrides.indexer === null
      ? null
      : {
          queued: 0,
          running: 0,
          failed: [],
          lastIndexedAt: 5000,
          watchMode: 'native',
          reconciling: false,
          lastReconcile: { at: 4000 },
          ...overrides.indexer,
        };
  const governor: GovernorStatus = { queued: 1, running: 2, leases: 3, leasedBytes: 4 };
  return {
    store: () => Promise.resolve(store),
    indexer: () => indexer,
    governor: () => governor,
    tiers: () => [
      {
        module: 'typescript',
        tiers: [
          { tier: 'grammar', active: true },
          { tier: 'precise', active: false },
          { tier: 'platform', active: false },
        ],
      },
    ],
    policy: () => 'off',
  };
}

describe('atlas_status: state from injected ports', () => {
  it('reports the watermark, store, indexer, governor, tiers and the policy mode, with health ok', async (t) => {
    const h = await world(t);

    const envelope = await h.query({ status: ports(h) }).ask(statusRequest(h));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(envelope.schema, 'gsd-atlas.atlas-status/1');
    assert.deepEqual(snapshotOf(envelope), {
      repo: h.dir,
      worktrees: [{ worktree: h.dir, seq: 7, staleCount: 0 }],
      store: { schemaVersion: 1, sizeBytes: 4096, writerLeaseHeld: true, rebuilt: false },
      indexer: { watchMode: 'native', queued: 0, running: 0, failed: 0, reconciling: false, lastReconcileAt: 4000, lastIndexedAt: 5000 },
      governor: { queued: 1, running: 2, leases: 3 },
      citations: { filesWithGaps: 0 },
      tiers: [{ module: 'typescript', grammar: true, precise: false, platform: false }],
      policy: 'off',
      health: 'ok',
      reasons: [],
    });
    assert.equal('degraded' in envelope, false);
  });

  it('citations filesWithGaps: the sum of the files with a citation gap over the listed worktrees, 0 and present when there is none', async (t) => {
    const h = await world(t);
    const two: StoreStatus = {
      schemaVersion: 2,
      worktrees: [
        { worktree: h.dir, seq: 7, stalePaths: 0, files: 9, citationGapFiles: 2 },
        { worktree: `${h.dir}-feature`, seq: 3, stalePaths: 0, files: 4, citationGapFiles: 3 },
        { worktree: `${h.dir}-quiet`, seq: 1, stalePaths: 0, files: 1, citationGapFiles: 0 },
      ],
      sizeBytes: 1,
      writerLeaseHeld: true,
    };
    const summed = await h.query({ status: ports(h, { store: two }) }).ask(statusRequest(h));
    assert.deepEqual(snapshotOf(summed).citations, { filesWithGaps: 5 });

    const none = await h.query({ status: ports(h, { store: { worktrees: [] } }) }).ask(statusRequest(h));
    assert.deepEqual(snapshotOf(none).citations, { filesWithGaps: 0 });
  });

  it('gap does not degrade health: a gap is the only finding, and health stays ok with no reason and no degraded code', async (t) => {
    const h = await world(t);
    const store: StoreStatus = {
      schemaVersion: 2,
      worktrees: [{ worktree: h.dir, seq: 7, stalePaths: 0, files: 3, citationGapFiles: 3 }],
      sizeBytes: 1,
      writerLeaseHeld: true,
    };
    const envelope = await h.query({ status: ports(h, { store }) }).ask(statusRequest(h));
    assert.equal(envelope.ok, true);
    assert.equal(snapshotOf(envelope).health, 'ok');
    assert.deepEqual(snapshotOf(envelope).reasons, []);
    assert.deepEqual(snapshotOf(envelope).citations, { filesWithGaps: 3 });
    assert.equal('degraded' in envelope, false);
    assert.deepEqual(envelope.diagnostics, [], 'a count only: no note, no file name');
  });

  it('a daemon without an Indexer reports indexer null and is still ok', async (t) => {
    const h = await world(t);

    const envelope = await h.query({ status: ports(h, { indexer: null }) }).ask(statusRequest(h));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(snapshotOf(envelope).indexer, null);
    assert.equal(snapshotOf(envelope).health, 'ok');
  });
});

describe('atlas_status health: degraded, with the reasons from a fixed list', () => {
  const CASES: readonly (readonly [string, Overrides, string | undefined])[] = [
    ['follower', { store: { writerLeaseHeld: false } }, 'follower'],
    ['rebuilding', { store: { rebuiltAfterCorruption: { movedTo: '/somewhere/old.db', at: 9 } } }, 'rebuilding'],
    ['reconciling', { indexer: { reconciling: true } }, 'reconciling'],
    ['stale_files', { staleCount: 2 }, 'stale'],
    ['watch_fallback', { indexer: { watchMode: 'reconcile-only' } }, undefined],
    ['indexer_failures', { indexer: { failed: [{ worktree: '/r', path: 'src/secret/failed.ts' }] } }, undefined],
  ];

  for (const [reason, overrides, code] of CASES) {
    it(`${reason}: health is degraded with that reason${code === undefined ? '' : ` and the degraded code ${code}`}`, async (t) => {
      const h = await world(t);

      const envelope = await h.query({ status: ports(h, overrides) }).ask(statusRequest(h));

      assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
      assert.equal(snapshotOf(envelope).health, 'degraded');
      assert.deepEqual(snapshotOf(envelope).reasons, [reason]);
      if (code === undefined) assert.equal('degraded' in envelope, false, 'this reason has no degraded code');
      else assert.deepEqual(envelope.degraded, [code]);
    });
  }

  it('several reasons combine in the fixed order', async (t) => {
    const h = await world(t);
    const broken = ports(h, {
      store: { writerLeaseHeld: false, rebuiltAfterCorruption: { movedTo: '/x', at: 1 } },
      indexer: { reconciling: true, watchMode: 'reconcile-only', failed: [{ worktree: '/r', path: 'a.ts' }] },
      staleCount: 1,
    });

    const envelope = await h.query({ status: broken }).ask(statusRequest(h));

    assert.deepEqual(snapshotOf(envelope).reasons, ['follower', 'rebuilding', 'reconciling', 'stale_files', 'watch_fallback', 'indexer_failures']);
    assert.deepEqual(envelope.degraded, ['stale', 'follower', 'reconciling', 'rebuilding'], 'degraded codes keep the order of the closed vocabulary');
  });
});

describe('atlas_status hints at a bug report (plan 03-32, DIAGNOSTICS 9.1)', () => {
  const HINT = 'something went wrong; run gsd-atlas bug';

  it('hint after corruption rebuild: a store that was rebuilt carries the fixed hint, and health still says why', async (t) => {
    const h = await world(t);

    const envelope = await h.query({ status: ports(h, { store: { rebuiltAfterCorruption: { movedTo: '/private/old-store.db', at: 9 } } }) }).ask(statusRequest(h));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(envelope.hints, [HINT]);
    assert.equal(BUG_HINT, HINT);
    assert.deepEqual(snapshotOf(envelope).reasons, ['rebuilding']);
    assert.equal(JSON.stringify(envelope).includes('old-store'), false, 'the hint is a fixed sentence and names no path');
  });

  it('hint after internal error: the recorder port says one of the last answers was an internal error', async (t) => {
    const h = await world(t);
    const flagged: StatusPort = { ...ports(h), recentInternalError: () => true };

    const envelope = await h.query({ status: flagged }).ask(statusRequest(h));

    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.hints, [HINT]);
    assert.equal(snapshotOf(envelope).health, 'ok', 'the hint does not change health or add a reason');
    assert.equal('degraded' in envelope, false);
  });

  it('no hint when healthy: a store that was not rebuilt and a recorder without an internal error add nothing', async (t) => {
    const h = await world(t);

    const plain = await h.query({ status: ports(h) }).ask(statusRequest(h));
    assert.equal('hints' in plain, false);

    const quiet: StatusPort = { ...ports(h), recentInternalError: () => false };
    const checked = await h.query({ status: quiet }).ask(statusRequest(h));
    assert.equal('hints' in checked, false);
  });

  it('a recorder port that throws is treated as no internal error', async (t) => {
    const h = await world(t);
    const broken: StatusPort = {
      ...ports(h),
      recentInternalError: () => {
        throw new Error('the recorder is gone');
      },
    };

    const envelope = await h.query({ status: broken }).ask(statusRequest(h));

    assert.equal(envelope.ok, true);
    assert.equal('hints' in envelope, false);
  });
});

describe('atlas_status reports state, not benefit or content', () => {
  it('value-statistics scan: no source text, no paths beyond the repository root, none of tokens, saved, avoided or calls', async (t) => {
    const h = await world(t);
    await h.addFile('src/secret/hidden.ts', 'export function hiddenSourceMarker() {}\n', [{ name: 'hiddenSourceMarker', line: 0, col: 16 }]);
    const busy = ports(h, {
      staleCount: 3,
      indexer: { failed: [{ worktree: h.dir, path: 'src/secret/failed.ts' }], reconciling: true },
      store: { rebuiltAfterCorruption: { movedTo: '/private/old-store.db', at: 9 } },
    });

    const envelope = await h.query({ status: busy }).ask(statusRequest(h));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    const serialized = JSON.stringify(envelope.data);
    // As JSON writes it: a Windows path has its backslashes doubled (found by plan 02-26 on Windows CI).
    const rootAsJson = JSON.stringify(h.dir).slice(1, -1);
    assert.equal(serialized.includes(rootAsJson), true, 'the repository root is the one path it names');
    const withoutRoot = serialized.replaceAll(rootAsJson, '<root>');
    for (const word of ['tokens', 'saved', 'avoided', 'calls']) assert.equal(withoutRoot.includes(word), false, word);
    for (const leak of ['hiddenSourceMarker', 'secret', 'failed.ts', 'old-store', '.ts']) assert.equal(withoutRoot.includes(leak), false, leak);
    assert.equal(withoutRoot.includes('/'), false, 'no path other than the repository root appears');
    assert.equal('untrusted_text' in envelope, false);
    assert.equal('citations' in envelope, false);
  });

  it('without a status port the tool answers unavailable instead of throwing', async (t) => {
    const h = await world(t);

    const envelope = await h.query().ask(statusRequest(h));

    assert.equal(envelope.ok, false);
    assert.equal(envelope.schema, 'gsd-atlas.error/1');
    assert.equal(envelope.diagnostics[0]?.code, 'unavailable');
  });

  it('rejects unknown extra arguments with invalid_args', async (t) => {
    const h = await world(t);

    const envelope = await h.query({ status: ports(h) }).ask(statusRequest(h, { surprise: true }));

    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'invalid_args');
  });

  it('a port that throws becomes an unavailable envelope', async (t) => {
    const h = await world(t);
    const broken: StatusPort = { ...ports(h), store: () => Promise.reject(new Error('the store is gone')) };

    const envelope = await h.query({ status: broken }).ask(statusRequest(h));

    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'unavailable');
    assert.equal(JSON.stringify(envelope).includes('the store is gone'), false, 'the port error text is not echoed');
  });
});
