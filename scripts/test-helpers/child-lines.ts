/**
 * Test support shared by the child-process tests of plan 02-12: read a child's stdout line by line, and wait for
 * a condition with a ceiling. Lives outside `src` so it is neither built nor run as a test.
 */

export interface LineReader {
  /** The next stdout line without its newline, or `undefined` once the stream ended. */
  next(): Promise<string | undefined>;
}

export function lineReader(stream: AsyncIterable<Uint8Array>): LineReader {
  const iterator = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  return {
    async next() {
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return line.endsWith('\r') ? line.slice(0, -1) : line;
        }
        if (finished) return undefined;
        const chunk = await iterator.next();
        if (chunk.done === true) {
          finished = true;
        } else {
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    },
  };
}

/** Reject after `ms` real milliseconds; a test-only ceiling so a hung child fails the test instead of the run. */
export async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms waiting for ${label}`));
    }, ms);
  });
  try {
    return await Promise.race([work, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `check` on real timers until it returns true, or fail after `ms`. */
export async function pollUntil(ms: number, label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}
