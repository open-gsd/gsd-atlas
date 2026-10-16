import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeClock } from '../test-kit/index.ts';
import { DEFAULT_INDEXER_CONFIG } from './defaults.ts';
import { createCoalescingQueue } from './queue.ts';

const { debounceMs, maxWaitMs } = DEFAULT_INDEXER_CONFIG;

/** A FakeClock that counts the timers armed through `after` that have neither fired nor been cancelled. */
class SpyClock extends FakeClock {
  live = 0;

  override after(ms: number, fn: () => void): () => void {
    this.live += 1;
    let open = true;
    const settle = (): void => {
      if (open) {
        open = false;
        this.live -= 1;
      }
    };
    const cancel = super.after(ms, () => {
      settle();
      fn();
    });
    return () => {
      settle();
      cancel();
    };
  }
}

interface Batch {
  readonly worktree: string;
  readonly paths: readonly string[];
  readonly at: number;
  readonly firstAt: ReadonlyMap<string, number>;
}

function recorder(clock: FakeClock, hold?: () => Promise<void>) {
  const batches: Batch[] = [];
  return {
    batches,
    onBatch: async (worktree: string, paths: readonly string[], firstAt: ReadonlyMap<string, number>): Promise<void> => {
      batches.push({ worktree, paths: [...paths], at: clock.now(), firstAt });
      if (hold !== undefined) await hold();
    },
  };
}

describe('coalescing queue: burst', () => {
  it('burst: 50 events for one path inside one debounce window are one batch, after the window', async () => {
    const clock = new SpyClock(1000);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    for (let i = 0; i < 50; i += 1) queue.submit('main', 'a.toy');
    assert.equal(queue.pending(), 1, 'one entry however many events');
    await clock.advance(debounceMs - 1);
    assert.equal(seen.batches.length, 0);
    await clock.advance(1);
    assert.equal(seen.batches.length, 1);
    assert.deepEqual(seen.batches[0]?.paths, ['a.toy']);
    assert.equal(seen.batches[0]?.at, 1000 + debounceMs);
    assert.equal(queue.pending(), 0);
  });

  it('burst: an event just before the window ends restarts the window', async () => {
    const clock = new SpyClock(0);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    queue.submit('main', 'a.toy');
    await clock.advance(debounceMs - 1);
    queue.submit('main', 'a.toy');
    await clock.advance(1);
    assert.equal(seen.batches.length, 0, 'the first window was superseded');
    await clock.advance(debounceMs - 1);
    assert.equal(seen.batches.length, 1);
    assert.equal(seen.batches[0]?.at, debounceMs - 1 + debounceMs);
  });
});

describe('coalescing queue: max wait', () => {
  it('max wait: a stream of events inside every window flushes at the maximum wait, then starts a fresh entry', async () => {
    const clock = new SpyClock(0);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    const step = debounceMs - 10;
    let t = 0;
    queue.submit('main', 'a.toy');
    while (t + step < maxWaitMs) {
      await clock.advance(step);
      t += step;
      queue.submit('main', 'a.toy');
    }
    await clock.advance(maxWaitMs - t);
    assert.equal(seen.batches.length, 1, 'flushed although events never paused for a full debounce window');
    assert.equal(seen.batches[0]?.at, maxWaitMs, 'at the maximum wait, not later');

    queue.submit('main', 'a.toy');
    assert.equal(queue.pending(), 1, 'a fresh entry with a fresh first-event time');
    await clock.advance(debounceMs);
    assert.equal(seen.batches.length, 2);
    assert.equal(seen.batches[1]?.firstAt.get('a.toy'), maxWaitMs, 'lag is measured from the first event of this entry');
  });
});

describe('coalescing queue: batches', () => {
  it('two paths submitted together flush as one batch with the paths sorted; the same path in two worktrees is two batches', async () => {
    const clock = new SpyClock(0);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    queue.submit('main', 'b.toy');
    queue.submit('main', 'a.toy');
    queue.submit('other', 'a.toy');
    await clock.advance(debounceMs);
    assert.deepEqual(
      seen.batches.map((b) => [b.worktree, b.paths]),
      [
        ['main', ['a.toy', 'b.toy']],
        ['other', ['a.toy']],
      ],
    );
  });

  it('paths with different deadlines flush separately', async () => {
    const clock = new SpyClock(0);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    queue.submit('main', 'a.toy');
    await clock.advance(40);
    queue.submit('main', 'b.toy');
    await clock.advance(debounceMs);
    assert.deepEqual(
      seen.batches.map((b) => [b.at, b.paths]),
      [
        [debounceMs, ['a.toy']],
        [40 + debounceMs, ['b.toy']],
      ],
    );
  });

  it('events arriving in reverse path order for coinciding deadlines are delivered in code-unit path order', async () => {
    const clock = new SpyClock(0);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    for (const path of ['z.toy', 'b.toy', 'B.toy', 'a/c.toy', 'a.toy']) queue.submit('main', path);
    await clock.advance(debounceMs);
    assert.deepEqual(seen.batches[0]?.paths, ['B.toy', 'a.toy', 'a/c.toy', 'b.toy', 'z.toy']);
  });
});

describe('coalescing queue: in flight', () => {
  it('in flight: an event for a path being processed is processed again afterwards, once, never at the same time', async () => {
    const clock = new SpyClock(0);
    let release: () => void = () => {};
    let running = 0;
    let overlapped = false;
    const batches: string[][] = [];
    const queue = createCoalescingQueue({
      clock,
      debounceMs,
      maxWaitMs,
      onBatch: async (_worktree, paths) => {
        running += 1;
        if (running > 1) overlapped = true;
        batches.push([...paths]);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        running -= 1;
      },
    });
    queue.submit('main', 'a.toy');
    await clock.advance(debounceMs);
    assert.equal(batches.length, 1);
    for (let i = 0; i < 5; i += 1) queue.submit('main', 'a.toy');
    await clock.advance(debounceMs * 3);
    assert.equal(batches.length, 1, 'not started while the first run is still going');

    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.pending(), 1, 'exactly one extra entry, however many events arrived meanwhile');
    await clock.advance(debounceMs);
    assert.equal(batches.length, 2);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await clock.advance(debounceMs * 3);
    assert.equal(batches.length, 2, 'no third run');
    assert.equal(overlapped, false);
  });
});

describe('coalescing queue: flushNow and close', () => {
  it('flushNow takes the pending entry at once, hands back its first-event time and leaves no timer', async () => {
    const clock = new SpyClock(500);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    queue.submit('main', 'a.toy');
    await clock.advance(30);
    assert.equal(clock.live, 1);
    const taken = queue.flushNow('main', ['a.toy', 'unknown.toy']);
    assert.deepEqual([...taken], [['a.toy', 500]], 'only entries that were pending are handed back');
    assert.equal(queue.pending(), 0);
    assert.equal(clock.live, 0, 'its timer was cancelled');
    await clock.advance(maxWaitMs * 2);
    assert.equal(seen.batches.length, 0, 'the queue does not process what flushNow handed back');
  });

  it('flushNow of one path leaves the other entries and their deadline in place', async () => {
    const clock = new SpyClock(0);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    queue.submit('main', 'a.toy');
    queue.submit('main', 'b.toy');
    queue.flushNow('main', ['a.toy']);
    await clock.advance(debounceMs);
    assert.deepEqual(seen.batches.map((b) => b.paths), [['b.toy']]);
    assert.equal(clock.live, 0);
  });

  it('close cancels every timer, drops pending entries and ignores later events', async () => {
    const clock = new SpyClock(0);
    const seen = recorder(clock);
    const queue = createCoalescingQueue({ clock, debounceMs, maxWaitMs, onBatch: seen.onBatch });
    queue.submit('main', 'a.toy');
    queue.submit('other', 'b.toy');
    assert.equal(clock.live, 1);
    queue.close();
    assert.equal(clock.live, 0);
    assert.equal(queue.pending(), 0);
    queue.submit('main', 'c.toy');
    assert.equal(queue.pending(), 0);
    await clock.advance(maxWaitMs * 2);
    assert.equal(seen.batches.length, 0);
  });
});
