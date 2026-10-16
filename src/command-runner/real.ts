/**
 * The real CommandRunner adapter, and the only file in the repository allowed to import
 * `node:child_process` (FND-06; the boundary lint enforces it).
 *
 * Every run goes: decide -> resolve executable -> spawn with `shell: false` and an argument array.
 * A denied or unresolvable spec starts nothing. Failures to start are results, never exceptions.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { decide as defaultDecide } from './decide.ts';
import { scrubEnv } from './env.ts';
import { resolveExecutable } from './exec-resolve.ts';
import {
  COMMAND_CODES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  deniedResult,
  emptyResult,
  spawnErrorResult,
} from './spec.ts';
import type {
  CommandResult,
  CommandRunner,
  CommandSpec,
  CommandStream,
  DecideFn,
  RunContext,
  StdinChunk,
  StdinSource,
  UserPermissions,
} from './spec.ts';

export interface RealRunnerOptions {
  /** The permission rule. Defaults to {@link defaultDecide} with `user`. Tests inject narrower or wider rules. */
  readonly decide?: DecideFn;
  /** User-level permissions for the default rule. Read from user config by the composition root, never from a repo. */
  readonly user?: UserPermissions;
  /** The parent environment children inherit (minus the denylist). Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

/** After a kill, how long to wait for the child's pipes to close before abandoning them (a grandchild may hold them open). */
const PIPE_GRACE_MS = 1000;

/** An async queue of byte chunks that backs `CommandStream.stdout`. */
class ByteQueue implements AsyncIterable<Uint8Array> {
  private items: Uint8Array[] = [];
  private waiters: Array<(r: IteratorResult<Uint8Array>) => void> = [];
  private ended = false;

  push(chunk: Uint8Array): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value: chunk, done: false });
    else this.items.push(chunk);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: (): Promise<IteratorResult<Uint8Array>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        this.items = [];
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Writes one chunk, waiting for `drain`. Resolves false when the child is gone (EPIPE and friends). */
function writeChunk(w: Writable, chunk: StdinChunk): Promise<boolean> {
  return new Promise((resolve) => {
    if (w.destroyed || w.writableEnded) {
      resolve(false);
      return;
    }
    const done = (ok: boolean): void => {
      w.off('drain', onDrain);
      w.off('close', onGone);
      w.off('error', onGone);
      resolve(ok);
    };
    const onDrain = (): void => done(true);
    const onGone = (): void => done(false);
    w.once('drain', onDrain);
    w.once('close', onGone);
    w.once('error', onGone);
    if (w.write(chunk)) done(true);
  });
}

/** Feeds stdin in full and closes it. A child that exits early is not an error. */
async function feedStdin(w: Writable, source: StdinSource | undefined): Promise<void> {
  w.on('error', () => {});
  try {
    if (source === undefined) {
      w.end();
      return;
    }
    if (typeof source === 'string' || source instanceof Uint8Array) {
      await writeChunk(w, source);
    } else {
      for await (const chunk of source) {
        if (!(await writeChunk(w, chunk))) break;
      }
    }
    if (!w.destroyed) w.end();
  } catch {
    w.destroy();
  }
}

const settled = (result: CommandResult): CommandStream => ({
  stdout: (async function* (): AsyncGenerator<Uint8Array> {})(),
  result: Promise.resolve(result),
  kill: () => {},
});

export function createRealRunner(opts: RealRunnerOptions = {}): CommandRunner {
  const platform = opts.platform ?? process.platform;
  const rule: DecideFn = opts.decide ?? ((spec, ctx) => defaultDecide(spec, ctx, opts.user));

  function start(spec: CommandSpec, ctx: RunContext, streaming: boolean): CommandStream {
    const decision = rule(spec, ctx);
    if (!decision.allowed) return settled(deniedResult(decision.diagnostic));

    const childEnv = scrubEnv(ctx.env ?? opts.env ?? process.env, spec.env);
    const resolved = resolveExecutable(spec.executable, { platform, env: childEnv });
    if (!resolved.ok) return settled(spawnErrorResult(resolved.diagnostic));

    let child: ChildProcess;
    try {
      child = spawn(resolved.path, [...spec.args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: spec.cwd,
        env: childEnv,
      });
    } catch (error) {
      return settled(spawnErrorResult(diagnostic(COMMAND_CODES.spawnFailed, 'error', errorText(error), spec.executable)));
    }
    const { stdin, stdout, stderr } = child;
    if (stdin === null || stdout === null || stderr === null) {
      child.kill('SIGKILL');
      return settled(spawnErrorResult(diagnostic(COMMAND_CODES.spawnFailed, 'error', 'child stdio was not piped', spec.executable)));
    }

    const maxOut = spec.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxErr = spec.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    const queue = streaming ? new ByteQueue() : undefined;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const diagnostics: Diagnostic[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let outCapped = false;
    let errCapped = false;
    let timedOut = false;
    let spawned = false;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let resolveResult: (r: CommandResult) => void = () => {};
    const result = new Promise<CommandResult>((resolve) => {
      resolveResult = resolve;
    });

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Diagnostic): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      queue?.end();
      if (spawnError !== undefined) {
        resolveResult(spawnErrorResult(spawnError));
        return;
      }
      resolveResult(
        emptyResult({
          ok: exitCode === 0 && signal === null && !timedOut && !outCapped,
          exitCode,
          signal,
          stdout: new Uint8Array(Buffer.concat(outChunks)),
          stderr: new Uint8Array(Buffer.concat(errChunks)),
          truncated: outCapped || errCapped,
          timedOut,
          diagnostics,
        }),
      );
    };

    const kill = (): void => {
      if (finished) return;
      child.kill('SIGKILL');
      grace ??= setTimeout(() => {
        // A grandchild can keep the pipes open after the direct child is gone; stop waiting for them.
        stdout.destroy();
        stderr.destroy();
        finish(null, 'SIGKILL');
      }, PIPE_GRACE_MS);
    };

    child.on('spawn', () => {
      spawned = true;
    });
    child.on('error', (error) => {
      if (!spawned) finish(null, null, diagnostic(COMMAND_CODES.spawnFailed, 'error', errorText(error), spec.executable));
    });
    child.on('close', (code, signal) => finish(code, signal));

    stdout.on('data', (chunk: Buffer) => {
      if (outCapped) return;
      const room = maxOut - outBytes;
      const part = chunk.length > room ? chunk.subarray(0, Math.max(room, 0)) : chunk;
      if (part.length > 0) {
        outBytes += part.length;
        if (queue !== undefined) queue.push(new Uint8Array(part));
        else outChunks.push(part);
      }
      if (chunk.length > room) {
        outCapped = true;
        diagnostics.push(
          diagnostic(COMMAND_CODES.outputCapExceeded, 'error', `stdout exceeded ${maxOut} bytes; the command was stopped`, spec.executable),
        );
        kill();
      }
    });
    stderr.on('data', (chunk: Buffer) => {
      if (errCapped) return;
      const room = maxErr - errBytes;
      const part = chunk.length > room ? chunk.subarray(0, Math.max(room, 0)) : chunk;
      if (part.length > 0) {
        errBytes += part.length;
        errChunks.push(part);
      }
      if (chunk.length > room) {
        errCapped = true;
        diagnostics.push(
          diagnostic(COMMAND_CODES.outputCapExceeded, 'warning', `stderr exceeded ${maxErr} bytes and was truncated`, spec.executable),
        );
      }
    });

    const limit = spec.timeoutMs;
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        diagnostics.push(
          diagnostic(COMMAND_CODES.timeout, 'error', `${spec.executable} was stopped after ${limit} ms`, spec.executable),
        );
        kill();
      }, limit);
    }

    void feedStdin(stdin, spec.stdin);

    return {
      stdout: queue ?? (async function* (): AsyncGenerator<Uint8Array> {})(),
      result,
      kill,
    };
  }

  return {
    run: (spec, ctx) => start(spec, ctx ?? {}, false).result,
    stream: (spec, ctx) => start(spec, ctx ?? {}, true),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
