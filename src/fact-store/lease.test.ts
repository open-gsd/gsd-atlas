/**
 * The cross-process writer lease (STO-08, plan 02-12): one writer per store directory, enforced by an exclusive
 * lock on `lease.db` that the operating system releases when the holder dies. Unit cases on the lease itself, the
 * store's leader and follower behaviour, takeover on a fake clock, and real child processes (one killed with
 * SIGKILL, ten concurrent starts).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lineReader, pollUntil, within } from '../../scripts/test-helpers/child-lines.ts';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import type { CommandStream } from '../command-runner/index.ts';
import type { Clock, FileFacts, Span, SymbolIdentity } from '../facts/index.ts';
import { createScriptedResolver } from '../precise-resolver/index.ts';
import { DbError, loadDriver, openDatabase } from '../sqlite/index.ts';
import type { DriverModule, DriverName } from '../sqlite/index.ts';
import { FakeClock, makeTempDir } from '../test-kit/index.ts';
import { WriterBusy } from './errors.ts';
import { createLease, startTakeover } from './lease.ts';
import type { Lease } from './lease.ts';
import { DEFAULT_LEASE_RETRY_MAX_MS, DEFAULT_LEASE_RETRY_MIN_MS, openFactStore } from './open.ts';
import type { StoreOpenOptions } from './open.ts';
import type { FactStore, Resolver, StoreDeps } from './types.ts';

const CHILD = fileURLToPath(new URL('../../scripts/test-helpers/lease-child.ts', import.meta.url));
const runner = createRealRunner({ decide: allowAll });

/** Test-only ceiling on how long a child may take to boot or react. */
const CHILD_CEILING_MS = 20_000;

const span = (startLine: number, startColumn: number, endLine = startLine, endColumn = startColumn + 1): Span => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});
const H = (n: number): string => n.toString(16).padStart(40, '0');

const CALL_SPAN = span(3, 2, 3, 5);
const RUN: SymbolIdentity = { repo: 'repo', path: 'src/a.ts', qualifiedName: 'run', kind: 'function' };

/** `src/a.ts` defines and exports `run`. */
const definitionFacts = (): FileFacts => ({
  path: 'src/a.ts',
  contentHash: H(1),
  module: 'typescript',
  grammarVersion: '0.23.2',
  symbols: [{ name: 'run', kind: 'function', span: span(1, 0, 3, 1), exported: true }],
  refSites: [],
  imports: [],
  exports: [{ name: 'run', span: span(1, 0, 3, 1) }],
  parse: { errorBytes: 0, totalBytes: 50 },
});

/** `src/b.ts` imports `run` from './a' and calls it inside `main`. */
const callerFacts = (): FileFacts => ({
  path: 'src/b.ts',
  contentHash: H(2),
  module: 'typescript',
  grammarVersion: '0.23.2',
  symbols: [{ name: 'main', kind: 'function', span: span(1, 0, 5, 1) }],
  refSites: [{ name: 'run', span: CALL_SPAN, kind: 'call', enclosing: 0, importPath: './a' }],
  imports: [{ path: './a', span: span(0, 0, 0, 22), style: 'es', bindings: [{ imported: 'run', local: 'run' }] }],
  exports: [],
  parse: { errorBytes: 0, totalBytes: 60 },
});

/** A resolver that binds the call site in `src/b.ts` to `run`, so a `refs` read has a precise edge to cache. */
const bindingResolver = (): Resolver => {
  const inner = createScriptedResolver({
    id: 'scripted',
    edges: [{ site: { path: 'src/b.ts', span: CALL_SPAN, name: 'run' }, target: RUN }],
  });
  return (sites, context) => inner.resolve({ id: 'overlay', pathToHash: new Map() }, context, sites);
};

/** A clock whose sleeps return at once and are recorded; `after` is never used by the lease itself. */
function recordingClock(start = 0): Clock & { readonly sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => start,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    after: () => () => {},
  };
}

async function withTmp(run: (dir: string) => Promise<void>): Promise<void> {
  const tmp = makeTempDir();
  try {
    await run(path.join(tmp.path, 'store'));
  } finally {
    tmp.cleanup();
  }
}

/** Wrap a real driver so its first `failures` opens throw SQLITE_BUSY. */
async function flakyDriver(failures: number): Promise<{ readonly driver: DriverModule; readonly opens: () => number }> {
  const real = await loadDriver('node:sqlite');
  let opens = 0;
  const driver: DriverModule = {
    name: real.name,
    open(file, options) {
      if (file === ':memory:') return real.open(file, options); // the kit's own open-time self-test
      opens += 1;
      if (opens <= failures) throw new DbError('busy', 'database is locked', 5);
      return real.open(file, options);
    },
  };
  return { driver, opens: () => opens };
}

describe('writer lease', () => {
  it('takes the lease in a fresh directory and records the holder in lease.json', async () => {
    await withTmp(async (dir) => {
      const clock = new FakeClock(5000);
      const lease = createLease({ dir, clock, version: '1.2.3' });
      try {
        assert.equal(lease.held, false);
        assert.equal(await lease.tryAcquire(), true);
        assert.equal(lease.held, true);
        const written = JSON.parse(fs.readFileSync(path.join(dir, 'lease.json'), 'utf8')) as unknown;
        assert.deepStrictEqual(written, { pid: process.pid, startedAt: 5000, version: '1.2.3' });
        assert.deepStrictEqual(lease.info(), { pid: process.pid, startedAt: 5000, version: '1.2.3' });
        assert.equal(await lease.tryAcquire(), true, 'taking a lease that is already held stays true');
      } finally {
        await lease.release();
      }
    });
  });

  it('a second lease on the same directory is a follower, and sees the leader through info()', async () => {
    await withTmp(async (dir) => {
      const leader = createLease({ dir, clock: new FakeClock(7000), version: 'leader' });
      const follower = createLease({ dir, clock: new FakeClock(9000), version: 'follower' });
      try {
        assert.equal(await leader.tryAcquire(), true);
        assert.equal(await follower.tryAcquire(), false);
        assert.equal(follower.held, false);
        assert.deepStrictEqual(follower.info(), { pid: process.pid, startedAt: 7000, version: 'leader' });
      } finally {
        await follower.release();
        await leader.release();
      }
    });
  });

  it('release hands the lease to the next taker, is safe twice, and removes lease.json', async () => {
    await withTmp(async (dir) => {
      const first = createLease({ dir, clock: new FakeClock(1), version: 'a' });
      const second = createLease({ dir, clock: new FakeClock(2), version: 'b' });
      try {
        assert.equal(await first.tryAcquire(), true);
        assert.equal(await second.tryAcquire(), false);
        await first.release();
        await first.release();
        assert.equal(first.held, false);
        assert.equal(fs.existsSync(path.join(dir, 'lease.json')), false, 'the owner removes its diagnostics');
        assert.equal(await second.tryAcquire(), true);
        assert.deepStrictEqual(second.info(), { pid: process.pid, startedAt: 2, version: 'b' });
      } finally {
        await second.release();
      }
    });
  });

  it('a stale lease.json never decides ownership', async () => {
    await withTmp(async (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'lease.json'), JSON.stringify({ pid: 1, startedAt: 1, version: 'ghost' }));
      const lease = createLease({ dir, clock: new FakeClock(3), version: 'real' });
      try {
        assert.equal(await lease.tryAcquire(), true);
        assert.deepStrictEqual(lease.info(), { pid: process.pid, startedAt: 3, version: 'real' });
      } finally {
        await lease.release();
      }
    });
  });

  it('an open that is busy is retried with a short jittered pause before the lease concludes it is a follower', async () => {
    await withTmp(async (dir) => {
      const jitter: number[] = [];
      const { driver, opens } = await flakyDriver(2);
      const lease = createLease({
        dir,
        clock: recordingClock(),
        version: 'v',
        openDb: (file) => openDatabase(file, { timeoutMs: 0, driver }),
        random: () => {
          jitter.push(0.5);
          return 0.5;
        },
      });
      try {
        assert.equal(await lease.tryAcquire(), true, 'the third open succeeded');
        assert.equal(opens(), 3);
        assert.equal(jitter.length, 2, 'one jittered pause per retry');
      } finally {
        await lease.release();
      }
    });
  });

  it('gives up after one try and four retries when every open is busy', async () => {
    await withTmp(async (dir) => {
      const { driver, opens } = await flakyDriver(Number.POSITIVE_INFINITY);
      const lease = createLease({
        dir,
        clock: recordingClock(),
        version: 'v',
        openDb: (file) => openDatabase(file, { timeoutMs: 0, driver }),
        random: () => 0,
      });
      assert.equal(await lease.tryAcquire(), false);
      assert.equal(opens(), 5);
      assert.equal(lease.held, false);
      await lease.release();
    });
  });
});

describe('startTakeover', () => {
  /** A lease that refuses `refusals` times and then grants. */
  function scriptedLease(refusals: number): Lease & { readonly attempts: () => number } {
    let attempts = 0;
    let held = false;
    return {
      get held() {
        return held;
      },
      attempts: () => attempts,
      async tryAcquire() {
        attempts += 1;
        if (attempts > refusals) held = true;
        return held;
      },
      info: () => null,
      release: async () => {},
    };
  }

  const settle = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  it('retries after a jittered delay between the approved minimum and maximum, then stops once it holds the lease', async () => {
    const clock = new FakeClock();
    const lease = scriptedLease(1);
    const draws = [0, 0.999];
    let acquired = 0;
    startTakeover(
      lease,
      clock,
      { retryMinMs: DEFAULT_LEASE_RETRY_MIN_MS, retryMaxMs: DEFAULT_LEASE_RETRY_MAX_MS, random: () => draws.shift() ?? 0 },
      () => {
        acquired += 1;
      },
    );
    await clock.advance(DEFAULT_LEASE_RETRY_MIN_MS - 1);
    await settle();
    assert.equal(lease.attempts(), 0, 'random 0 waits exactly the minimum');
    await clock.advance(1);
    await settle();
    assert.equal(lease.attempts(), 1, 'the first try is refused');
    assert.equal(acquired, 0);

    const longest = DEFAULT_LEASE_RETRY_MIN_MS + Math.floor(0.999 * (DEFAULT_LEASE_RETRY_MAX_MS - DEFAULT_LEASE_RETRY_MIN_MS));
    await clock.advance(longest - 1);
    await settle();
    assert.equal(lease.attempts(), 1, 'a draw near 1 waits close to the maximum');
    await clock.advance(DEFAULT_LEASE_RETRY_MAX_MS);
    await settle();
    assert.equal(lease.attempts(), 2);
    assert.equal(acquired, 1, 'onAcquired fires once');

    await clock.advance(10 * DEFAULT_LEASE_RETRY_MAX_MS);
    await settle();
    assert.equal(lease.attempts(), 2, 'no further tries once the lease is held');
    assert.equal(acquired, 1);
  });

  it('cancel stops the retries', async () => {
    const clock = new FakeClock();
    const lease = scriptedLease(Number.POSITIVE_INFINITY);
    const cancel = startTakeover(
      lease,
      clock,
      { retryMinMs: DEFAULT_LEASE_RETRY_MIN_MS, retryMaxMs: DEFAULT_LEASE_RETRY_MAX_MS, random: () => 0 },
      () => {},
    );
    await clock.advance(DEFAULT_LEASE_RETRY_MIN_MS);
    await settle();
    assert.equal(lease.attempts(), 1);
    cancel();
    cancel();
    await clock.advance(10 * DEFAULT_LEASE_RETRY_MAX_MS);
    await settle();
    assert.equal(lease.attempts(), 1);
  });
});

for (const driver of ['node:sqlite', 'better-sqlite3'] as const satisfies readonly DriverName[]) {
  describe(`store leader and follower (${driver})`, () => {
    interface Rig {
      readonly clock: FakeClock;
      readonly dir: string;
      open(extra?: Partial<StoreOpenOptions>, resolver?: Resolver): Promise<FactStore>;
    }

    async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
      const tmp = makeTempDir();
      const clock = new FakeClock(1000);
      const dir = path.join(tmp.path, 'store');
      const opened: FactStore[] = [];
      const rig: Rig = {
        clock,
        dir,
        async open(extra = {}, resolver = bindingResolver()) {
          const deps: StoreDeps = { resolver, clock, gitHas: async () => true };
          const store = await openFactStore(dir, deps, { driver, repo: 'repo', version: '9.9.9', lease: 'acquire', ...extra });
          opened.push(store);
          return store;
        },
      };
      try {
        await run(rig);
      } finally {
        for (const store of opened) await store.close();
        tmp.cleanup();
      }
    }

    async function seed(store: FactStore): Promise<void> {
      const writer = store.writer();
      await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(1), facts: definitionFacts() });
      await writer.commitFile({ worktree: 'main', path: 'src/b.ts', hash: H(2), facts: callerFacts() });
      writer.release();
    }

    it('the first store holds the lease and writes; its reads carry no follower code', async () => {
      await withRig(async (rig) => {
        const leader = await rig.open();
        assert.equal((await leader.status()).writerLeaseHeld, true);
        await seed(leader);
        const found = await leader.at('main').find('run');
        assert.equal(found.data.length, 1);
        assert.equal(found.degraded?.includes('follower') ?? false, false);
        const refs = await leader.at('main').refs(RUN);
        assert.equal(refs.degraded?.includes('cache_unavailable') ?? false, false, 'the leader may fill the cache');
        assert.equal(refs.data.some((record) => record.tier === 'precise'), true);
      });
    });

    it('a second store is a follower: it reads the leader\'s facts, says so, and never writes', async () => {
      await withRig(async (rig) => {
        const leader = await rig.open();
        await seed(leader);
        const follower = await rig.open();

        const status = await follower.status();
        assert.equal(status.writerLeaseHeld, false);
        assert.throws(() => follower.writer(), WriterBusy);

        const reader = follower.at('main');
        const found = await reader.find('run');
        assert.deepStrictEqual(found.data.map((record) => record.source_path), ['src/a.ts']);
        assert.equal(found.degraded?.includes('follower'), true);
        const facts = await reader.fileFacts('src/b.ts');
        assert.equal(facts.data?.refSites.length, 1);
        assert.equal(facts.degraded?.includes('follower'), true);
        const importers = await reader.importers('src/a.ts');
        assert.equal(importers.data.length, 1);
        assert.equal(importers.degraded?.includes('follower'), true);

        assert.equal((await leader.status()).writerLeaseHeld, true, 'the leader is unaffected');
      });
    });

    it('a follower returns precise edges uncached with cache_unavailable (canCache follows the lease)', async () => {
      await withRig(async (rig) => {
        const leader = await rig.open();
        await seed(leader);
        const follower = await rig.open();
        const refs = await follower.at('main').refs(RUN);
        assert.equal(refs.data.some((record) => record.tier === 'precise'), true, 'the answer still has the precise edge');
        assert.equal(refs.degraded?.includes('cache_unavailable'), true);
        assert.equal(refs.degraded?.includes('follower'), true);
        // Nothing was cached by the follower: a leader read computes the edge afresh and may now store it.
        const again = await leader.at('main').refs(RUN);
        assert.equal(again.degraded?.includes('cache_unavailable') ?? false, false);
      });
    });

    it('a follower takes over when the leader closes: onLeaseChange(true) fires once and the follower code disappears', async () => {
      await withRig(async (rig) => {
        const leader = await rig.open();
        await seed(leader);
        const changes: boolean[] = [];
        const follower = await rig.open({
          takeover: { retryMinMs: DEFAULT_LEASE_RETRY_MIN_MS, retryMaxMs: DEFAULT_LEASE_RETRY_MAX_MS, random: () => 0.5 },
          onLeaseChange: (held) => changes.push(held),
        });
        assert.equal((await follower.status()).writerLeaseHeld, false);
        await leader.close();

        const delay = (DEFAULT_LEASE_RETRY_MIN_MS + DEFAULT_LEASE_RETRY_MAX_MS) / 2;
        await rig.clock.advance(delay - 1);
        assert.equal((await follower.status()).writerLeaseHeld, false, 'the retry timer has not fired yet');
        assert.deepStrictEqual(changes, []);
        await rig.clock.advance(1);
        await pollUntil(10_000, 'the takeover', () => changes.length > 0);
        assert.deepStrictEqual(changes, [true]);

        assert.equal((await follower.status()).writerLeaseHeld, true);
        const found = await follower.at('main').find('run');
        assert.equal(found.degraded?.includes('follower') ?? false, false);
        const writer = follower.writer();
        const result = await writer.commitFile({ worktree: 'main', path: 'src/a.ts', hash: H(3), facts: { ...definitionFacts(), contentHash: H(3) } });
        assert.equal(result.status, 'committed');
        writer.release();

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
        assert.deepStrictEqual(changes, [true], 'fires exactly once');
      });
    });

    it('close gives the lease up so another store can take it at once', async () => {
      await withRig(async (rig) => {
        const first = await rig.open();
        await first.close();
        const second = await rig.open();
        assert.equal((await second.status()).writerLeaseHeld, true);
      });
    });
  });
}

describe('lease across processes', () => {
  async function stop(stream: CommandStream): Promise<void> {
    stream.kill();
    await stream.result;
  }

  it('a child process holds the lease, the parent is a follower, and SIGKILL of the child frees it', async () => {
    await withTmp(async (dir) => {
      const stream = runner.stream({ executable: process.execPath, args: [CHILD, dir] });
      const lease = createLease({ dir, clock: new FakeClock(1), version: 'parent' });
      try {
        const lines = lineReader(stream.stdout);
        assert.equal(await within(CHILD_CEILING_MS, 'the child to take the lease', lines.next()), 'held');
        assert.equal(await lease.tryAcquire(), false, 'the child is the leader');
        assert.equal(lease.held, false);
        assert.equal(lease.info()?.version, 'child', 'the parent can read who holds it');

        stream.kill();
        await stream.result;
        await pollUntil(CHILD_CEILING_MS / 2, 'the lease to be free after the child was killed', () => lease.tryAcquire());
        assert.equal(lease.held, true);
      } finally {
        await stop(stream);
        await lease.release();
      }
    });
  });

  it('[edge STO-08/concurrency] two processes starting at the same moment: exactly one leader, no crash, ten times over', async () => {
    const tmp = makeTempDir();
    try {
      for (let round = 0; round < 10; round += 1) {
        const dir = path.join(tmp.path, `store-${round}`);
        let open: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const goLine = async function* (): AsyncGenerator<string> {
          await gate;
          yield 'go\n';
        };
        const a = runner.stream({ executable: process.execPath, args: [CHILD, dir, 'race'], stdin: goLine() });
        const b = runner.stream({ executable: process.execPath, args: [CHILD, dir, 'race'], stdin: goLine() });
        try {
          const linesA = lineReader(a.stdout);
          const linesB = lineReader(b.stdout);
          assert.equal(await within(CHILD_CEILING_MS, 'child A to be ready', linesA.next()), 'ready');
          assert.equal(await within(CHILD_CEILING_MS, 'child B to be ready', linesB.next()), 'ready');
          open();
          const outcomes = [
            await within(CHILD_CEILING_MS, 'child A to decide', linesA.next()),
            await within(CHILD_CEILING_MS, 'child B to decide', linesB.next()),
          ];
          assert.deepStrictEqual([...outcomes].sort(), ['follower', 'leader'], `round ${round}: ${outcomes.join(', ')}`);
        } finally {
          await stop(a);
          await stop(b);
        }
      }
    } finally {
      tmp.cleanup();
    }
  });
});
