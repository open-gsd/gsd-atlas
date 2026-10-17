/**
 * Idle eviction (WR-10, plan 02-41): a tenant, and a history module host, with no request and none in flight for the
 * approved `host.idleEvictMs` is closed and forgotten, which releases the repository's writer lease, its SQLite
 * connections and its watcher. The Host runs on a fake clock; the only real waiting is for the asynchronous close to
 * finish, which the cases poll for.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { openFactStore } from '../fact-store/index.ts';
import { PROTOCOL_VERSION, systemClock } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { createGovernor } from '../governor/index.ts';
import type { Governor } from '../governor/index.ts';
import { createModuleHost } from '../indexer/index.ts';
import type { ModuleHost } from '../indexer/index.ts';
import { FakeClock, makeTempDir, realPath } from '../test-kit/index.ts';
import { HOST_DEFAULTS } from './defaults.ts';
import { makeWorld, storeIdOf } from './harness.test.ts';
import type { World } from './harness.test.ts';
import type { HostOptions } from './index.ts';

const IDLE = 60_000;
const START = 1_000_000;

async function eventually(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 15000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * A Governor on the system clock (a request held for a long fake time must not hit the Governor's own deadline) that
 * can hold the next interactive job until released: a request in flight at the idle deadline.
 */
function gatedGovernor(): { readonly governor: Governor; hold(): { readonly entered: Promise<void>; release(): void } } {
  const real = createGovernor({ clock: systemClock });
  let gate: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const governor: Governor = {
    run: (job, work) =>
      real.run(job, async (signal) => {
        const waiting = job.class === 'interactive' ? gate : undefined;
        if (waiting !== undefined) {
          gate = undefined;
          entered?.();
          await waiting;
        }
        return work(signal);
      }),
    lease: (key, bytes, onEvict) => real.lease(key, bytes, onEvict),
    status: () => real.status(),
  };
  return {
    governor,
    hold() {
      let release: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { entered: enteredPromise, release };
    },
  };
}

interface Evicting {
  readonly world: World;
  readonly clock: FakeClock;
  readonly gate: ReturnType<typeof gatedGovernor>;
  readonly storeDir: string;
}

async function evictingWorld(t: TestContext, host: Partial<HostOptions> = {}): Promise<Evicting> {
  const clock = new FakeClock(START);
  const gate = gatedGovernor();
  const world = await makeWorld(t, {
    governor: gate.governor,
    host: { clock, idleEvictMs: IDLE, metrics: false, tuning: { idleAfterMs: 1_000_000_000 }, ...host },
  });
  return { world, clock, gate, storeDir: path.join(world.repo.dir, '.git', 'gsd-atlas') };
}

/** True when a process that opens the store with the lease becomes the leader, that is, nothing else holds the lease. */
async function leaseIsFree(storeDir: string): Promise<boolean> {
  if (!fs.existsSync(path.join(storeDir, 'facts.db'))) return false;
  const store = await openFactStore(
    storeDir,
    { resolver: async function* () {}, clock: new FakeClock(0), gitHas: async () => true },
    { repo: 'repo', lease: 'acquire' },
  );
  try {
    return (await store.status()).writerLeaseHeld;
  } finally {
    await store.close();
  }
}

const find = (world: World): Promise<Envelope> => world.ask('code_find', { name: 'helper', repo: world.repo.dir });

const leads = async (world: World, host = world.host): Promise<boolean> => {
  const status = await host.handle({ protocol: PROTOCOL_VERSION, kind: 'atlas_status', args: { repo: world.repo.dir } });
  return (status.data as { store: { writerLeaseHeld: boolean } }).store.writerLeaseHeld;
};

describe('Host: idle eviction of tenants (WR-10)', () => {
  it('idle tenant is closed: the lease, the watcher and the connections are released', async (t) => {
    const { world, clock, storeDir } = await evictingWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    assert.equal((await find(world)).ok, true);
    assert.ok(world.manual.subscriptions() > 0, 'the leader watches');
    assert.equal(await leaseIsFree(storeDir), false, 'this host holds the writer lease');

    await clock.advance(IDLE - 1);
    assert.equal(await leaseIsFree(storeDir), false, 'one millisecond short of the idle period');

    await clock.advance(1);
    await eventually(() => leaseIsFree(storeDir), 'the idle tenant to release the writer lease');
    assert.equal(world.manual.subscriptions(), 0, 'the watcher is gone with the tenant');
  });

  it('in flight defers: a request running at the deadline keeps its tenant until it ends', async (t) => {
    const { world, clock, gate, storeDir } = await evictingWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);

    const held = gate.hold();
    const running = find(world);
    await held.entered;
    await clock.advance(IDLE * 3);
    assert.equal(await leaseIsFree(storeDir), false, 'the tenant is still open under the running request');
    assert.ok(world.manual.subscriptions() > 0);

    held.release();
    const reply = await running;
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));

    await clock.advance(IDLE - 1);
    assert.equal(await leaseIsFree(storeDir), false, 'the idle period restarts when the request ends');
    await clock.advance(1);
    await eventually(() => leaseIsFree(storeDir), 'the tenant to be evicted once the request ended');
  });

  it('reopens on demand: a request after eviction opens the tenant again and answers correctly', async (t) => {
    const { world, clock, storeDir } = await evictingWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    await clock.advance(IDLE);
    await eventually(() => leaseIsFree(storeDir), 'eviction');
    assert.equal(world.manual.subscriptions(), 0);

    const again = await find(world);
    assert.equal(again.ok, true, JSON.stringify(again.diagnostics));
    assert.equal((again.data as { results: unknown[] }).results.length, 1);
    assert.equal(await leads(world), true, 'the reopened tenant leads again');
    assert.ok(world.manual.subscriptions() > 0, 'and watches again');
  });

  it('leader handover: another process takes the lease within its takeover interval after the leader is evicted', async (t) => {
    const { world, clock } = await evictingWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    const other = world.anotherHost({ clock: systemClock, idleEvictMs: undefined, tuning: { takeoverRetryMinMs: 20, takeoverRetryMaxMs: 40 } });
    const answer = await other.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name: 'helper', repo: world.repo.dir } });
    assert.equal(answer.ok, true, JSON.stringify(answer.diagnostics));
    assert.equal(await leads(world, other), false, 'the second host is a follower while the first leads');

    await clock.advance(IDLE);
    await eventually(() => leads(world, other), 'the follower to take the writer lease over');
  });

  it('uses the approved host.idleEvictMs when no option is given', async (t) => {
    assert.equal(HOST_DEFAULTS.idleEvictMs, 1_800_000, '02-CONSTANTS.md addendum 2026-10-17, host.idleEvictMs');
    const clock = new FakeClock(START);
    const world = await makeWorld(t, { host: { clock, metrics: false, tuning: { idleAfterMs: 1_000_000_000 } } });
    const storeDir = path.join(world.repo.dir, '.git', 'gsd-atlas');
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    await clock.advance(HOST_DEFAULTS.idleEvictMs - 1);
    assert.equal(await leaseIsFree(storeDir), false);
    await clock.advance(1);
    await eventually(() => leaseIsFree(storeDir), 'eviction after the default idle period');
  });

  it('host.close leaves zero active timers on the clock', async (t) => {
    const { world, clock } = await evictingWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    assert.equal((await find(world)).ok, true);
    assert.ok(clock.pending() > 0, 'an idle timer is armed while the tenant is open');
    await world.host.close();
    assert.equal(clock.pending(), 0);
  });

  it('closeTenant forgets the idle timer of that tenant', async (t) => {
    const { world, clock } = await evictingWorld(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    const before = clock.pending();
    assert.ok(before > 0);
    await world.host.closeTenant(await storeIdOf(world.repo));
    assert.equal(clock.pending(), 0, 'closing the tenant cancelled its idle timer and everything else it armed');
  });
});

describe('Host: idle eviction of history module hosts (WR-10)', () => {
  it('history module host: disposed after the idle period, deferred while a history request runs, made again on demand', async (t) => {
    const { world, clock, gate } = await evictingWorld(t);
    const tmp = makeTempDir();
    t.after(() => {
      tmp.cleanup();
    });
    const tmpRoot = realPath(tmp.path);
    let created = 0;
    let disposed = 0;
    const host = world.anotherHost({
      history: { tmpRoot, nonce: () => 'NONCE' },
      moduleHostFactory: (repoDir): ModuleHost => {
        created += 1;
        const real = createModuleHost({ engine: world.engine, roots: { ...world.options.roots, repoRoot: repoDir } });
        return {
          extensions: () => real.extensions(),
          extract: (file, text, hash) => real.extract(file, text, hash),
          dispose: async () => {
            disposed += 1;
            await real.dispose();
          },
        };
      },
    });
    const ask = (): Promise<Envelope> =>
      host.handle({ protocol: PROTOCOL_VERSION, kind: 'history', args: { repo: world.repo.dir, tool: 'find', name: 'helper', at: 'HEAD' } });

    const first = await ask();
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    assert.equal(created, 1);
    assert.equal(disposed, 0);
    const second = await ask();
    assert.equal(second.ok, true);
    assert.equal(created, 1, 'the module host is shared by later history questions');

    // A history request in flight at the deadline defers the disposal.
    const held = gate.hold();
    const running = ask();
    await held.entered;
    await clock.advance(IDLE * 3);
    assert.equal(disposed, 0, 'not disposed under a running request');
    held.release();
    assert.equal((await running).ok, true);

    await clock.advance(IDLE - 1);
    assert.equal(disposed, 0);
    await clock.advance(1);
    await eventually(() => disposed === 1, 'the idle module host to be disposed');

    const third = await ask();
    assert.equal(third.ok, true, JSON.stringify(third.diagnostics));
    assert.equal(created, 2, 'a later history request makes a new module host');
    await host.close();
    assert.equal(disposed, 2, 'close disposes the one still open');
    assert.equal(clock.pending(), 0, 'and cancels its idle timer');
  });
});
