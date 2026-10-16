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
