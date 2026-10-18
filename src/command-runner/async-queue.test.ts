import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAsyncQueue } from './async-queue.ts';

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}

describe('createAsyncQueue', () => {
  it('delivers values pushed before iteration, in order', async () => {
    const q = createAsyncQueue<string>();
    q.push('a');
    q.push('b');
    q.push('c');
    q.end();
    assert.deepEqual(await collect(q), ['a', 'b', 'c']);
  });

  it('delivers values pushed while a consumer awaits', async () => {
    const q = createAsyncQueue<number>();
    const consumer = collect(q);
    await new Promise((resolve) => setImmediate(resolve));
    q.push(1);
    await new Promise((resolve) => setImmediate(resolve));
    q.push(2);
    q.end();
    assert.deepEqual(await consumer, [1, 2]);
  });

  it('lets the consumer drain what was pushed before end() and then finish', async () => {
    const q = createAsyncQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    q.push('x');
    q.end();
    assert.deepEqual(await iterator.next(), { value: 'x', done: false });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  });

  it('end() resolves a consumer that is already waiting', async () => {
    const q = createAsyncQueue<string>();
    const consumer = collect(q);
    await new Promise((resolve) => setImmediate(resolve));
    q.end();
    assert.deepEqual(await consumer, []);
  });

  it('end() twice is fine', async () => {
    const q = createAsyncQueue<string>();
    q.push('only');
    q.end();
    assert.doesNotThrow(() => q.end());
    assert.deepEqual(await collect(q), ['only']);
  });

  it('push after end throws a TypeError', () => {
    const q = createAsyncQueue<string>();
    q.end();
    assert.throws(() => q.push('late'), TypeError);
  });
});
