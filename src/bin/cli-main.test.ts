import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CliIo } from '../cli/index.ts';
import type { HostClient } from '../host-client/index.ts';
import type { Host } from '../host/index.ts';
import { runCliMain } from './cli-main.ts';
import type { CliMainDeps } from './cli-main.ts';
import type { Composed } from './compose.ts';

type Envelope = Awaited<ReturnType<HostClient['handle']>>;
type Request = Parameters<HostClient['handle']>[0];

const REQUEST: Request = { protocol: 1, kind: 'atlas_status', args: {} } as unknown as Request;
const ENVELOPE = { ok: true } as unknown as Envelope;

interface Probe {
  readonly deps: CliMainDeps;
  readonly out: string[];
  readonly err: string[];
  readonly counts: { composed: number; disposed: number; handled: number };
  readonly shutdownDisposers: Array<() => Promise<void>>;
}

/** `runCli` is given by the test; everything else is a recording fake. */
function probe(runCli: CliMainDeps['runCli'], compose?: () => Composed): Probe {
  const out: string[] = [];
  const err: string[] = [];
  const counts = { composed: 0, disposed: 0, handled: 0 };
  const shutdownDisposers: Array<() => Promise<void>> = [];
  const deps: CliMainDeps = {
    argv: ['health'],
    compose:
      compose ??
      ((): Composed => {
        counts.composed += 1;
        return {
          host: {} as Host,
          client: {
            handle(): Promise<Envelope> {
              counts.handled += 1;
              return Promise.resolve(ENVELOPE);
            },
          },
          dispose(): Promise<void> {
            counts.disposed += 1;
            return Promise.resolve();
          },
        };
      }),
    runCli,
    version: () => '0.0.0',
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
    cwd: '/somewhere',
    init: { home: '/home', cwd: '/somewhere', platform: 'linux', env: {}, mcp: { command: 'node', args: ['mcp.js'] } },
    installShutdown: (dispose) => shutdownDisposers.push(dispose),
  };
  return { deps, out, err, counts, shutdownDisposers };
}

describe('runCliMain', () => {
  it('compose failure is internal_error: exit 2, the one error line, nothing disposed', async () => {
    const failing = probe(
      async (_argv, io: CliIo) => {
        await io.client.handle(REQUEST);
        return 0;
      },
      () => {
        throw new Error('the engine would not start');
      },
    );
    const code = await runCliMain(failing.deps);
    assert.equal(code, 2);
    assert.match(failing.err.join(''), /^gsd-atlas: error internal_error: the engine would not start\n$/);
    assert.equal(failing.counts.disposed, 0, 'nothing was composed, so nothing is disposed');
  });

  it('a throw from runCli itself is reported the same way', async () => {
    const throwing = probe(() => Promise.reject(new Error('boom')));
    assert.equal(await runCliMain(throwing.deps), 2);
    assert.equal(throwing.err.join(''), 'gsd-atlas: error internal_error: boom\n');
    assert.equal(throwing.counts.composed, 0);
  });

  it('composed once across several requests, and disposed once', async () => {
    const used = probe(async (_argv, io: CliIo) => {
      await io.client.handle(REQUEST);
      await io.client.handle(REQUEST);
      await io.client.handle(REQUEST);
      return 0;
    });
    assert.equal(await runCliMain(used.deps), 0);
    assert.equal(used.counts.composed, 1);
    assert.equal(used.counts.handled, 3);
    assert.equal(used.counts.disposed, 1);
  });

  it('a command that never asks the client never composes the Host', async () => {
    const idle = probe(() => Promise.resolve(1));
    assert.equal(await runCliMain(idle.deps), 1, "the CLI's own exit code passes through");
    assert.equal(idle.counts.composed, 0);
    assert.equal(idle.counts.disposed, 0);
  });

  it('the shutdown disposer disposes only what has been composed', async () => {
    let release: (() => void) | undefined;
    const held = probe(async (_argv, io: CliIo) => {
      await io.client.handle(REQUEST);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 0;
    });
    const running = runCliMain(held.deps);
    assert.equal(held.shutdownDisposers.length, 1, 'installed once, before the command runs');
    await held.shutdownDisposers[0]?.();
    assert.equal(held.counts.disposed, 1, 'a signal mid-command disposes the composed Host');
    release?.();
    assert.equal(await running, 0);

    const never = probe(() => Promise.resolve(0));
    await runCliMain(never.deps);
    await never.shutdownDisposers[0]?.();
    assert.equal(never.counts.disposed, 0, 'nothing composed, nothing to dispose');
  });
});
