import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { installShutdownHandlers, signalExitCode } from './shutdown.ts';
import type { ShutdownSignal, SignalSource } from './shutdown.ts';

/** A fake process: records listeners and lets the test raise a signal. */
class FakeProcess implements SignalSource {
  readonly listeners = new Map<ShutdownSignal, Array<() => void>>();
  readonly unsupported = new Set<ShutdownSignal>();

  on(signal: ShutdownSignal, listener: () => void): this {
    if (this.unsupported.has(signal)) throw new Error(`no ${signal} here`);
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener]);
    return this;
  }

  removeListener(signal: ShutdownSignal, listener: () => void): this {
    this.listeners.set(signal, (this.listeners.get(signal) ?? []).filter((each) => each !== listener));
    return this;
  }

  count(signal: ShutdownSignal): number {
    return this.listeners.get(signal)?.length ?? 0;
  }

  raise(signal: ShutdownSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

/** A promise settled from outside, for a dispose the test holds open. */
function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('installShutdownHandlers', () => {
  it('first SIGTERM disposes once, then exits 143', async () => {
    const fake = new FakeProcess();
    const events: string[] = [];
    installShutdownHandlers({
      process: fake,
      dispose: () => {
        events.push('dispose');
        return Promise.resolve();
      },
      exit: (code) => events.push(`exit ${String(code)}`),
    });
    fake.raise('SIGTERM');
    await settle();
    assert.deepEqual(events, ['dispose', 'exit 143']);
  });

  it('first SIGINT exits 130', async () => {
    const fake = new FakeProcess();
    const codes: number[] = [];
    installShutdownHandlers({ process: fake, dispose: () => Promise.resolve(), exit: (code) => codes.push(code) });
    fake.raise('SIGINT');
    await settle();
    assert.deepEqual(codes, [130]);
    assert.equal(signalExitCode('SIGINT'), 130);
    assert.equal(signalExitCode('SIGTERM'), 143);
  });

  it('exit waits for the dispose to finish', async () => {
    const fake = new FakeProcess();
    const gate = deferred();
    const codes: number[] = [];
    installShutdownHandlers({ process: fake, dispose: () => gate.promise, exit: (code) => codes.push(code) });
    fake.raise('SIGTERM');
    await settle();
    assert.deepEqual(codes, [], 'not yet: the dispose is pending');
    gate.resolve();
    await settle();
    assert.deepEqual(codes, [143]);
  });

  it('second signal forces exit at once with its own code, and does not dispose again', async () => {
    const fake = new FakeProcess();
    const gate = deferred();
    let disposes = 0;
    const codes: number[] = [];
    installShutdownHandlers({
      process: fake,
      dispose: () => {
        disposes += 1;
        return gate.promise;
      },
      exit: (code) => codes.push(code),
    });
    fake.raise('SIGTERM');
    await settle();
    fake.raise('SIGINT');
    assert.deepEqual(codes, [130], 'the second signal exits immediately, with the code of the second signal');
    assert.equal(disposes, 1);
    gate.resolve();
    await settle();
    assert.equal(disposes, 1);
  });

  it('dispose rejects: the process still exits with the signal code', async () => {
    const fake = new FakeProcess();
    const codes: number[] = [];
    installShutdownHandlers({
      process: fake,
      dispose: () => Promise.reject(new Error('close failed')),
      exit: (code) => codes.push(code),
    });
    fake.raise('SIGTERM');
    await settle();
    assert.deepEqual(codes, [143]);
  });

  it('registers each signal once, and uninstall removes the listeners', () => {
    const fake = new FakeProcess();
    const handle = installShutdownHandlers({ process: fake, dispose: () => Promise.resolve(), exit: () => undefined });
    assert.equal(fake.count('SIGTERM'), 1);
    assert.equal(fake.count('SIGINT'), 1);
    handle.uninstall();
    assert.equal(fake.count('SIGTERM'), 0);
    assert.equal(fake.count('SIGINT'), 0);
  });

  it('a signal the platform cannot listen for is skipped and the others still work', async () => {
    const fake = new FakeProcess();
    fake.unsupported.add('SIGTERM');
    const codes: number[] = [];
    installShutdownHandlers({ process: fake, dispose: () => Promise.resolve(), exit: (code) => codes.push(code) });
    assert.equal(fake.count('SIGTERM'), 0);
    fake.raise('SIGINT');
    await settle();
    assert.deepEqual(codes, [130]);
  });

  it('an uninstalled handler no longer reacts', async () => {
    const fake = new FakeProcess();
    const codes: number[] = [];
    const handle = installShutdownHandlers({ process: fake, dispose: () => Promise.resolve(), exit: (code) => codes.push(code) });
    handle.uninstall();
    fake.raise('SIGTERM');
    await settle();
    assert.deepEqual(codes, []);
  });
});
