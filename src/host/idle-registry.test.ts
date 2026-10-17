/**
 * The idle registry (WR-10, plan 02-41): per-key idle timers on the Clock, with in-flight counts. Everything runs on
 * the fake clock, so no case waits in real time.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeClock } from '../test-kit/index.ts';
import { createIdleRegistry } from './idle-registry.ts';

const IDLE = 1000;

function setup(): { clock: FakeClock; idled: string[]; registry: ReturnType<typeof createIdleRegistry> } {
  const clock = new FakeClock(5000);
  const idled: string[] = [];
  const registry = createIdleRegistry({
    clock,
    idleMs: IDLE,
    onIdle: (key) => {
      idled.push(key);
    },
  });
  return { clock, idled, registry };
}

describe('idle registry', () => {
  it('touch arms one timer, and a second touch re-arms it instead of adding another', async () => {
    const { clock, idled, registry } = setup();
    registry.touch('a');
    assert.equal(clock.pending(), 1);
    await clock.advance(600);
    registry.touch('a');
    assert.equal(clock.pending(), 1, 'still one timer for the key');
    await clock.advance(600);
    assert.deepEqual(idled, [], 'the second touch pushed the deadline out');
    await clock.advance(400);
    assert.deepEqual(idled, ['a']);
    assert.equal(clock.pending(), 0);
  });

  it('calls onIdle once per idle period and then forgets the key', async () => {
    const { clock, idled, registry } = setup();
    registry.touch('a');
    await clock.advance(IDLE * 5);
    assert.deepEqual(idled, ['a']);
    registry.touch('a');
    await clock.advance(IDLE);
    assert.deepEqual(idled, ['a', 'a'], 'a new use starts a new idle period');
  });

  it('in flight defers: a timer that fires with work in flight re-arms and does not call onIdle', async () => {
    const { clock, idled, registry } = setup();
    registry.touch('a');
    registry.begin('a');
    registry.begin('a');
    await clock.advance(IDLE * 3);
    assert.deepEqual(idled, [], 'two requests in flight');
    assert.equal(clock.pending(), 1, 'the timer was re-armed');
    registry.end('a');
    await clock.advance(IDLE * 3);
    assert.deepEqual(idled, [], 'one request is still in flight');
    registry.end('a');
    await clock.advance(IDLE - 1);
    assert.deepEqual(idled, [], 'the idle period restarts when the last request ends');
    await clock.advance(1);
    assert.deepEqual(idled, ['a']);
  });

  it('begin alone, without a prior touch, arms the key', async () => {
    const { clock, idled, registry } = setup();
    registry.begin('a');
    await clock.advance(IDLE * 2);
    assert.deepEqual(idled, []);
    registry.end('a');
    await clock.advance(IDLE);
    assert.deepEqual(idled, ['a']);
  });

  it('keys are independent', async () => {
    const { clock, idled, registry } = setup();
    registry.touch('a');
    await clock.advance(500);
    registry.touch('b');
    await clock.advance(500);
    assert.deepEqual(idled, ['a']);
    await clock.advance(500);
    assert.deepEqual(idled, ['a', 'b']);
  });

  it('forget cancels the timer and drops the in-flight count', async () => {
    const { clock, idled, registry } = setup();
    registry.touch('a');
    registry.begin('a');
    registry.forget('a');
    assert.equal(clock.pending(), 0);
    await clock.advance(IDLE * 3);
    assert.deepEqual(idled, []);
    registry.end('a'); // an end after a forget is harmless and arms nothing but a fresh idle period
    registry.forget('a');
    assert.equal(clock.pending(), 0);
  });

  it('close cancels every timer, and nothing arms afterwards', async () => {
    const { clock, idled, registry } = setup();
    registry.touch('a');
    registry.touch('b');
    registry.begin('c');
    registry.close();
    assert.equal(clock.pending(), 0, 'the fake clock reports zero active timers');
    registry.touch('a');
    registry.begin('d');
    registry.end('d');
    assert.equal(clock.pending(), 0);
    await clock.advance(IDLE * 10);
    assert.deepEqual(idled, []);
  });

  it('a throwing or rejecting onIdle does not stop the registry', async () => {
    const clock = new FakeClock(0);
    const seen: string[] = [];
    const registry = createIdleRegistry({
      clock,
      idleMs: IDLE,
      onIdle: (key) => {
        seen.push(key);
        if (key === 'a') throw new Error('boom');
        return Promise.reject(new Error('rejected'));
      },
    });
    registry.touch('a');
    registry.touch('b');
    await clock.advance(IDLE);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ['a', 'b']);
  });

  it('evict reports an idle key at once, and a key with work in flight when that work ends', async () => {
    const { clock, idled, registry } = setup();
    registry.touch('a');
    registry.evict('a');
    assert.deepEqual(idled, ['a'], 'nothing in flight: reported without waiting for the idle period');
    assert.equal(clock.pending(), 0);

    registry.begin('b');
    registry.begin('b');
    registry.evict('b');
    assert.deepEqual(idled, ['a'], 'work in flight: not closed under it');
    registry.end('b');
    assert.deepEqual(idled, ['a'], 'one request is still in flight');
    registry.end('b');
    assert.deepEqual(idled, ['a', 'b'], 'reported when the last request ended');
    assert.equal(clock.pending(), 0);
    await clock.advance(IDLE * 3);
    assert.deepEqual(idled, ['a', 'b'], 'and only once');
  });

  it('a forgotten key loses its eviction mark, and evict after close does nothing', () => {
    const { idled, registry } = setup();
    registry.begin('a');
    registry.evict('a');
    registry.forget('a');
    registry.end('a');
    assert.deepEqual(idled, [], 'forget dropped the mark');
    registry.close();
    registry.evict('b');
    assert.deepEqual(idled, []);
  });

  it('refuses an idle period that is not a positive finite number', () => {
    const clock = new FakeClock(0);
    for (const idleMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createIdleRegistry({ clock, idleMs, onIdle: () => {} }), RangeError, String(idleMs));
    }
  });
});
