import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { FakeClock, makeTempDir, realPath } from './index.ts';

describe('FakeClock', () => {
  it('starts at 0 or at a given time', () => {
    assert.equal(new FakeClock().now(), 0);
    assert.equal(new FakeClock(1000).now(), 1000);
  });

  it('keeps sleep pending until advance reaches its due time', async () => {
    const clock = new FakeClock();
    let woke = false;
    const p = clock.sleep(100).then(() => {
      woke = true;
    });
    await clock.advance(99);
    assert.equal(woke, false);
    assert.equal(clock.now(), 99);
    await clock.advance(1);
    await p;
    assert.equal(woke, true);
    assert.equal(clock.now(), 100);
  });

  it('resolves due sleepers in due-time order', async () => {
    const clock = new FakeClock();
    const order: number[] = [];
    const a = clock.sleep(30).then(() => order.push(30));
    const b = clock.sleep(10).then(() => order.push(10));
    const c = clock.sleep(20).then(() => order.push(20));
    await clock.advance(50);
    await Promise.all([a, b, c]);
    assert.deepEqual(order, [10, 20, 30]);
    assert.equal(clock.now(), 50);
  });

  it('lets a woken sleeper schedule another sleep inside the same advance', async () => {
    const clock = new FakeClock();
    const hits: number[] = [];
    const run = (async () => {
      await clock.sleep(10);
      hits.push(clock.now());
      await clock.sleep(10);
      hits.push(clock.now());
    })();
    await clock.advance(25);
    await run;
    assert.deepEqual(hits, [10, 20]);
  });

  it('advance(0) resolves sleep(0)', async () => {
    const clock = new FakeClock();
    let woke = false;
    const p = clock.sleep(0).then(() => {
      woke = true;
    });
    await Promise.resolve();
    assert.equal(woke, false);
    await clock.advance(0);
    await p;
    assert.equal(woke, true);
  });

  it('after does not fire until advance reaches its due time, then fires once', async () => {
    const clock = new FakeClock();
    let calls = 0;
    clock.after(100, () => {
      calls += 1;
    });
    await clock.advance(99);
    assert.equal(calls, 0);
    await clock.advance(1);
    assert.equal(calls, 1);
    await clock.advance(500);
    assert.equal(calls, 1);
  });

  it('after fires in due-time order together with sleepers, ties in call order', async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    const sleeper = clock.sleep(20).then(() => order.push('sleep20'));
    clock.after(30, () => order.push('after30'));
    clock.after(20, () => order.push('after20'));
    clock.after(10, () => order.push('after10'));
    await clock.advance(50);
    await sleeper;
    assert.deepEqual(order, ['after10', 'sleep20', 'after20', 'after30']);
  });

  it('cancelling an after timer prevents its callback', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const cancel = clock.after(100, () => {
      calls += 1;
    });
    cancel();
    await clock.advance(200);
    assert.equal(calls, 0);
  });

  it('cancel twice, or after the callback ran, does nothing and throws nothing', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const cancel = clock.after(10, () => {
      calls += 1;
    });
    await clock.advance(10);
    assert.equal(calls, 1);
    assert.doesNotThrow(() => {
      cancel();
      cancel();
    });
    const early = clock.after(10, () => {
      calls += 1;
    });
    early();
    assert.doesNotThrow(early);
    await clock.advance(10);
    assert.equal(calls, 1);
  });

  it('lets an after callback schedule another after inside the same advance', async () => {
    const clock = new FakeClock();
    const hits: number[] = [];
    clock.after(10, () => {
      hits.push(clock.now());
      clock.after(10, () => {
        hits.push(clock.now());
      });
    });
    await clock.advance(25);
    assert.deepEqual(hits, [10, 20]);
  });

  it('one timer cancelling another that is due in the same advance wins', async () => {
    const clock = new FakeClock();
    let secondCalls = 0;
    const cancelSecond = clock.after(20, () => {
      secondCalls += 1;
    });
    clock.after(10, cancelSecond);
    await clock.advance(30);
    assert.equal(secondCalls, 0);
  });
});

describe('makeTempDir', () => {
  it('creates a short ga- directory under os.tmpdir()', () => {
    const dir = makeTempDir();
    try {
      assert.ok(fs.statSync(dir.path).isDirectory());
      const base = path.basename(dir.path);
      assert.ok(base.startsWith('ga-'), base);
      assert.ok(base.length <= 12, base);
      assert.equal(path.dirname(realPath(dir.path)), realPath(os.tmpdir()));
    } finally {
      dir.cleanup();
    }
  });

  it('closes adopted handles in reverse order, then removes the directory', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir.path, 'f.txt'), 'x');
    fs.mkdirSync(path.join(dir.path, 'sub'));
    fs.writeFileSync(path.join(dir.path, 'sub', 'g.txt'), 'y');
    const closed: string[] = [];
    const first = dir.adopt({ close: () => closed.push('first') });
    dir.adopt({ close: () => closed.push('second') });
    assert.equal(typeof first.close, 'function');
    dir.cleanup();
    assert.deepEqual(closed, ['second', 'first']);
    assert.equal(fs.existsSync(dir.path), false);
  });

  it('cleanup twice is safe and does not close handles again', () => {
    const dir = makeTempDir();
    let closes = 0;
    dir.adopt({ close: () => closes++ });
    dir.cleanup();
    dir.cleanup();
    assert.equal(closes, 1);
    assert.equal(fs.existsSync(dir.path), false);
  });

  it('still removes the directory when a handle fails to close, then reports it', () => {
    const dir = makeTempDir();
    dir.adopt({
      close: () => {
        throw new Error('boom');
      },
    });
    assert.throws(() => dir.cleanup(), /boom/);
    assert.equal(fs.existsSync(dir.path), false);
  });
});

describe('realPath', () => {
  it('returns fs.realpathSync.native', () => {
    const tmp = os.tmpdir();
    assert.equal(realPath(tmp), fs.realpathSync.native(tmp));
  });
});
