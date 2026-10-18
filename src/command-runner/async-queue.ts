/**
 * An unbounded, in-order async queue for feeding `stream()` stdin line by line (plan 03-19).
 *
 * `push` hands a value to a waiting consumer or stores it; `end` closes the queue: a consumer drains what was
 * pushed and then finishes, which makes the real runner close the child's stdin. One consumer is expected (the
 * runner's `feedStdin`); a second concurrent consumer would share the values, never duplicate them.
 */
export interface AsyncQueue<T> extends AsyncIterable<T> {
  /** Appends a value. Throws a `TypeError` once the queue has ended. */
  push(value: T): void;
  /** Ends the queue. Safe to call more than once. */
  end(): void;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;

  return {
    push(value: T): void {
      if (ended) throw new TypeError('cannot push to an async queue that has ended');
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter({ value, done: false });
      else items.push(value);
    },
    end(): void {
      if (ended) return;
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: (): Promise<IteratorResult<T>> => {
          if (items.length > 0) return Promise.resolve({ value: items.shift() as T, done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
        return: (): Promise<IteratorResult<T>> => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}
