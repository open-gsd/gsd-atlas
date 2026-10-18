/**
 * Behaviour only the real adapter can honour: timeouts and kill, output caps, batched stdin,
 * streaming, spawn errors, and the "no shell, no shim" prohibitions (FND-06). Every child is
 * `process.execPath` with an `-e` script so the tests are identical on every OS; none spawns npm,
 * npx, a .cmd file or a shell.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from '../test-kit/index.ts';
import { compilerWorkerShape } from './builtins.ts';
import { allowAll, createAsyncQueue, createRealRunner } from './index.ts';
import type { BuiltinShape, CommandSpec } from './index.ts';
import { bufferedStdoutBytes, DEFAULT_RUN_TIMEOUT_MS } from './real.ts';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const runner = createRealRunner({ decide: allowAll });

const node = (script: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({
  executable: process.execPath,
  args: ['-e', script],
  ...extra,
});

/** Counts non-empty lines on stdin and prints the count. */
const COUNT_LINES =
  "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write(String(b.split('\\n').filter(Boolean).length)))";

const LINE = 'line of text\n';
const TEN_THOUSAND = LINE.repeat(10_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('timeout and kill', () => {
  it('kills a sleeping child at timeoutMs and reports timedOut with a timeout diagnostic', async () => {
    const began = Date.now();
    const result = await runner.run(node('process.stdout.write(String(process.pid)); setTimeout(() => {}, 10000)', { timeoutMs: 800 }));
    const elapsed = Date.now() - began;
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((d) => d.code === 'timeout'), true);
    assert.ok(elapsed < 3000, `returned after ${elapsed} ms`);
    const pid = Number(text(result.stdout));
    assert.ok(Number.isInteger(pid) && pid > 0, 'the child printed its pid before it was stopped: ' + text(result.stdout));
    assert.equal(alive(pid), false, 'the child is gone');
  });

  it('does not time out a child that finishes in time', async () => {
    const result = await runner.run(node("process.stdout.write('quick')", { timeoutMs: 20_000 }));
    assert.equal(result.timedOut, false);
    assert.equal(result.ok, true);
  });
});

describe('default run timeout (WR-07, runner.defaultTimeoutMs)', () => {
  const SLEEP_THEN_WRITE = "setTimeout(() => process.stdout.write('late'), 1200)";

  it('the production default equals the approved value', () => {
    assert.equal(DEFAULT_RUN_TIMEOUT_MS, 60000);
  });

  it('default timeout applies to run', async () => {
    const short = createRealRunner({ decide: allowAll, defaultTimeoutMs: 400 });
    const began = Date.now();
    const result = await short.run(node('setInterval(() => {}, 1000)'));
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.some((d) => d.code === 'timeout'), true);
    assert.ok(Date.now() - began < 5000, 'the default ended the run');
  });

  it('explicit timeout wins', async () => {
    const short = createRealRunner({ decide: allowAll, defaultTimeoutMs: 300 });
    const result = await short.run(node(SLEEP_THEN_WRITE, { timeoutMs: 20_000 }));
    assert.equal(result.timedOut, false);
    assert.equal(result.ok, true);
    assert.equal(text(result.stdout), 'late');
  });

  it('stream has no default', async () => {
    const short = createRealRunner({ decide: allowAll, defaultTimeoutMs: 300 });
    const stream = short.stream(node(SLEEP_THEN_WRITE));
    let out = '';
    for await (const chunk of stream.stdout) out += text(chunk);
    const result = await stream.result;
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.equal(out, 'late');
  });

  it('rejects a default that is not a positive finite number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => createRealRunner({ decide: allowAll, defaultTimeoutMs: bad }), RangeError, String(bad));
    }
  });
});

describe('output caps', () => {
  it('stdout over the cap: truncated, not ok, output_cap_exceeded, exactly the cap in bytes, child killed', async () => {
    const began = Date.now();
    // Writes 1 MiB, then stays alive so only the cap can end it.
    const result = await runner.run(
      node('process.stdout.write(Buffer.alloc(1 << 20, 97)); setInterval(() => {}, 1000)', { maxStdoutBytes: 65536, timeoutMs: 20_000 }),
    );
    assert.equal(result.truncated, true);
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout.length, 65536);
    assert.equal(result.diagnostics.some((d) => d.code === 'output_cap_exceeded' && d.severity === 'error'), true);
    assert.ok(Date.now() - began < 10_000, 'the cap ended the run');
  });

  it('stderr over the cap is truncated without killing the child', async () => {
    const result = await runner.run(
      node("process.stderr.write('e'.repeat(200000)); setTimeout(() => process.stdout.write('done'), 100)", { maxStderrBytes: 1000 }),
    );
    assert.equal(result.truncated, true);
    assert.equal(result.stderr.length, 1000);
    assert.equal(result.exitCode, 0);
    assert.equal(text(result.stdout), 'done');
    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.some((d) => d.code === 'output_cap_exceeded' && d.severity === 'warning'), true);
  });

  it('output exactly at the cap is not truncated', async () => {
    const result = await runner.run(node("process.stdout.write('x'.repeat(100))", { maxStdoutBytes: 100 }));
    assert.equal(result.truncated, false);
    assert.equal(result.stdout.length, 100);
    assert.equal(result.ok, true);
  });
});

describe('batched stdin', () => {
  it('a string of ten thousand lines reaches the child', async () => {
    const result = await runner.run(node(COUNT_LINES, { stdin: TEN_THOUSAND }));
    assert.equal(text(result.stdout), '10000');
  });

  it('a Uint8Array of ten thousand lines reaches the child', async () => {
    const result = await runner.run(node(COUNT_LINES, { stdin: new TextEncoder().encode(TEN_THOUSAND) }));
    assert.equal(text(result.stdout), '10000');
  });

  it('an async iterable of chunks reaches the child and the child printed 10000', async () => {
    async function* chunks(): AsyncGenerator<string | Uint8Array> {
      for (let i = 0; i < 10; i += 1) {
        const block = LINE.repeat(1000);
        yield i % 2 === 0 ? block : new TextEncoder().encode(block);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const result = await runner.run(node(COUNT_LINES, { stdin: chunks() }));
    assert.equal(text(result.stdout), '10000');
  });

  it('a child that exits before reading its input does not make the runner throw (EPIPE ignored)', async () => {
    const huge = 'x'.repeat(1023) + '\n';
    const result = await runner.run(node('process.exit(0)', { stdin: huge.repeat(8 * 1024) }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.spawnError, undefined);
  });

  it('an async iterable that outlives the child is abandoned without throwing', async () => {
    async function* endless(): AsyncGenerator<string> {
      for (;;) {
        yield 'x'.repeat(65536);
      }
    }
    const result = await runner.run(node('process.exit(0)', { stdin: endless(), timeoutMs: 20_000 }));
    assert.equal(result.exitCode, 0);
  });

  it('no stdin closes the pipe so a reading child terminates', async () => {
    const result = await runner.run(node(COUNT_LINES, { timeoutMs: 20_000 }));
    assert.equal(text(result.stdout), '0');
  });
});

describe('streaming', () => {
  it('delivers the first chunk while the result is still pending, then the rest', async () => {
    const script = "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 300)";
    const stream = runner.stream(node(script));
    let settled = false;
    void stream.result.then(() => {
      settled = true;
    });
    const iterator = stream.stdout[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.ok(text(first.value as Uint8Array).startsWith('first'));
    assert.equal(settled, false, 'the result must still be pending when the first chunk arrives');
    let rest = '';
    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      rest += text(next.value);
    }
    assert.ok(rest.includes('second'));
    const result = await stream.result;
    assert.equal(result.ok, true);
    assert.equal(result.stdout.length, 0, 'streamed bytes are delivered through the iterable only');
  });

  it('kill() ends the child', async () => {
    const stream = runner.stream(node("process.stdout.write('up'); setInterval(() => {}, 1000)", { timeoutMs: 20_000 }));
    const iterator = stream.stdout[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);
    const began = Date.now();
    stream.kill();
    stream.kill();
    const result = await stream.result;
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.ok(Date.now() - began < 5000);
    assert.equal((await iterator.next()).done, true);
  });

  it('a denied stream yields nothing and carries the denial', async () => {
    const strict = createRealRunner();
    const stream = strict.stream({ executable: 'sh', args: ['-c', 'id'] });
    for await (const chunk of stream.stdout) assert.fail('unexpected output: ' + text(chunk));
    const result = await stream.result;
    assert.equal(result.denied?.code, 'command_denied');
  });
});

describe('spawn errors are results, not exceptions', () => {
  it('an absolute path that does not exist returns ok false with spawnError spawn_failed', async () => {
    const tmp = makeTempDir();
    try {
      const result = await runner.run({ executable: path.join(tmp.path, 'does-not-exist'), args: [] });
      assert.equal(result.ok, false);
      assert.equal(result.spawnError?.code, 'spawn_failed');
      assert.equal(result.exitCode, null);
      assert.equal(result.denied, undefined);
    } finally {
      tmp.cleanup();
    }
  });

  it('a working directory that does not exist is a spawn_failed result', async () => {
    const tmp = makeTempDir();
    try {
      const result = await runner.run(node('1', { cwd: path.join(tmp.path, 'nope') }));
      assert.equal(result.ok, false);
      assert.equal(result.spawnError?.code, 'spawn_failed');
    } finally {
      tmp.cleanup();
    }
  });

  it('an argument that cannot be passed to a process (NUL byte) is a result, not a throw', async () => {
    const result = await runner.run(node('1', { args: ['-e', '1', 'bad\0arg'] }));
    assert.equal(result.ok, false);
    assert.equal(result.spawnError?.code, 'spawn_failed');
  });

  it('a bare name that is not on PATH is spawn_failed', async () => {
    const result = await createRealRunner({ decide: allowAll, env: { PATH: '' } }).run({ executable: 'definitely-not-installed', args: [] });
    assert.equal(result.spawnError?.code, 'spawn_failed');
  });
});

describe('no shell and no shim (FND-06)', () => {
  it('a .cmd or .bat executable is rejected with shim_rejected before anything starts (win32 rules injected)', async () => {
    const win = createRealRunner({ decide: allowAll, platform: 'win32', env: { PATH: 'C:\\x' } });
    for (const executable of ['npm.cmd', 'build.bat', 'npx']) {
      const result = await win.run({ executable, args: ['--version'] });
      assert.equal(result.ok, false, executable);
      assert.equal(result.spawnError?.code, 'shim_rejected', executable);
    }
  });

  it('real.ts spawns with shell false, windowsHide true and an argument array, and uses no string-command API', () => {
    const source = fs.readFileSync(new URL('./real.ts', import.meta.url), 'utf8');
    assert.ok(source.includes('shell: false'));
    assert.ok(source.includes('windowsHide: true'));
    assert.ok(source.includes('SIGKILL'));
    assert.equal(/shell:\s*true/.test(source), false, 'shell: true');
    assert.equal(/\bexec(?:Sync|File|FileSync)?\s*\(/.test(source), false, 'exec-style string command API');
    const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g)].map((m) => (m[1] ?? '').trim());
    assert.deepEqual(imports, ['spawn']);
  });

  it('no source file outside this module imports the process module (the lint proves it; this spot-checks the tree)', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full !== path.join(root, 'command-runner')) walk(full);
        } else if (entry.name.endsWith('.ts') && /from\s+'(?:node:)?child_process'/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    assert.deepEqual(offenders, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A long-lived duplex child started through an exact-shape built-in (plan 03-19, TSM-05). The child is the echo
// worker: a plain `.mjs` file run by the running Node, no shim and no shell.
// ---------------------------------------------------------------------------------------------------------------

const WORKER = path.join(import.meta.dirname, '__fixtures__', 'echo-worker.mjs');
const productionShape = compilerWorkerShape({ execPath: process.execPath, workerPath: WORKER });
/** The production shape plus the fixture's own mode switches, so tests can ask the echo worker for behavior. */
const workerShape: BuiltinShape = {
  ...productionShape,
  env: { ...productionShape.env, ECHO_PRINT_PID: '^1$', ECHO_PRINT_ENV: '^1$', ECHO_BURST_MB: '^[0-9]{1,3}$', ECHO_STDERR_MB: '^[0-9]{1,3}$' },
};
const workerRunner = createRealRunner({ builtinShapes: [workerShape] });

function workerSpec(extra: Partial<CommandSpec> = {}, env: Readonly<Record<string, string>> = {}): CommandSpec {
  return {
    executable: process.execPath,
    args: ['--max-old-space-size=256', WORKER],
    builtinId: 'typescript-resolver',
    env: { GSD_ATLAS_WORKER: '1', ...env },
    ...extra,
  };
}

/** Reads from a stream's stdout until the text collected so far satisfies `done`. */
async function readUntil(iterator: AsyncIterator<Uint8Array>, done: (collected: string) => boolean, start = ''): Promise<string> {
  let collected = start;
  while (!done(collected)) {
    const next = await iterator.next();
    if (next.done === true) break;
    collected += text(next.value);
  }
  return collected;
}

describe('a long-lived worker through the runner (exact-shape built-in)', () => {
  it('streams lines through the worker and ends it when stdin ends', { timeout: 30_000 }, async () => {
    const queue = createAsyncQueue<string>();
    const stream = workerRunner.stream(workerSpec({ stdin: queue }));
    const iterator = stream.stdout[Symbol.asyncIterator]();
    queue.push('one\n');
    queue.push('two\n');
    const out = await readUntil(iterator, (s) => s.length >= 8);
    assert.equal(out, 'ONE\nTWO\n');
    queue.end();
    const result = await stream.result;
    assert.equal(result.denied, undefined);
    assert.equal(result.ok, true, text(result.stderr));
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
  });

  it('kill() ends a worker that is still reading, with a signal and ok false', { timeout: 30_000 }, async () => {
    const queue = createAsyncQueue<string>();
    const stream = workerRunner.stream(workerSpec({ stdin: queue }));
    const iterator = stream.stdout[Symbol.asyncIterator]();
    queue.push('alive\n');
    assert.equal(await readUntil(iterator, (s) => s.length >= 6), 'ALIVE\n');
    stream.kill();
    const result = await stream.result;
    assert.equal(result.ok, false);
    assert.notEqual(result.signal, null);
    assert.equal(result.exitCode, null);
  });

  it('a deviation from the shape starts nothing, even with the same worker file', async () => {
    const result = await workerRunner.run(workerSpec({ args: ['--inspect', WORKER] }));
    assert.equal(result.denied?.code, 'command_denied');
    assert.equal(result.exitCode, null);
  });
});

/** precise.killGraceMs in 03-CONSTANTS.md (approved): the wait after ending stdin before the worker is killed. */
const KILL_GRACE_MS = 2000;
const MIB = 1024 * 1024;

/** Resolves true when the process is gone within `withinMs`, polling `process.kill(pid, 0)` (ESRCH). */
async function goneWithin(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

const pidOf = (line: string): number => Number(/^PID (\d+)\n/.exec(line)?.[1]);

describe('long-lived behavior of a worker through the runner (plan 03-19, Pitfall 1)', () => {
  it('default cap kills a 20 MiB talker', { timeout: 60_000 }, async () => {
    const result = await workerRunner.run(workerSpec({ stdin: 'hi\n' }, { ECHO_BURST_MB: '20' }));
    assert.equal(result.truncated, true);
    assert.equal(result.ok, false);
    assert.equal(result.stdout.length, 16 * MIB, 'exactly the default cap was kept');
    assert.equal(result.diagnostics.some((d) => d.code === 'output_cap_exceeded' && d.severity === 'error'), true);
  });

  it('raised cap receives 20 MiB and still echoes later input', { timeout: 60_000 }, async () => {
    const result = await workerRunner.run(workerSpec({ stdin: 'hello\n', maxStdoutBytes: Number.MAX_SAFE_INTEGER }, { ECHO_BURST_MB: '20' }));
    assert.equal(result.truncated, false);
    assert.equal(result.ok, true, text(result.stderr));
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.stdout.length, 20 * MIB + 'HELLO\n'.length);
    assert.equal(text(result.stdout.subarray(result.stdout.length - 6)), 'HELLO\n');
  });

  it('fifty round trips on one worker complete with no buffered growth and no cap kill', { timeout: 60_000 }, async () => {
    const queue = createAsyncQueue<string>();
    const stream = workerRunner.stream(workerSpec({ stdin: queue, maxStdoutBytes: Number.MAX_SAFE_INTEGER }));
    const iterator = stream.stdout[Symbol.asyncIterator]();
    let worstBuffered = 0;
    for (let i = 0; i < 50; i += 1) {
      queue.push(`request ${String(i)}\n`);
      const reply = await readUntil(iterator, (s) => s.endsWith('\n'));
      assert.equal(reply, `REQUEST ${String(i)}\n`);
      worstBuffered = Math.max(worstBuffered, bufferedStdoutBytes(stream) ?? Number.NaN);
    }
    assert.equal(worstBuffered, 0, 'every reply was consumed as it arrived; nothing piled up in the runner');
    queue.end();
    const result = await stream.result;
    assert.equal(result.ok, true, text(result.stderr));
    assert.equal(result.truncated, false);
    assert.equal(result.diagnostics.length, 0);
  });

  it('ends when stdin ends: exits 0 by itself within the kill grace and leaves no process', { timeout: 30_000 }, async () => {
    const queue = createAsyncQueue<string>();
    const stream = workerRunner.stream(workerSpec({ stdin: queue }, { ECHO_PRINT_PID: '1' }));
    const iterator = stream.stdout[Symbol.asyncIterator]();
    const pid = pidOf(await readUntil(iterator, (s) => s.endsWith('\n')));
    assert.ok(Number.isInteger(pid) && pid > 0, 'the worker printed its pid');
    queue.end();
    const outcome = await Promise.race([stream.result, new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), KILL_GRACE_MS))]);
    assert.notEqual(outcome, 'late', `the worker did not exit within ${String(KILL_GRACE_MS)} ms of stdin ending`);
    const result = await stream.result;
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(await goneWithin(pid, 2000), true, 'no worker process is left');
  });

  it('kill leaves no process', { timeout: 30_000 }, async () => {
    const queue = createAsyncQueue<string>();
    const stream = workerRunner.stream(workerSpec({ stdin: queue }, { ECHO_PRINT_PID: '1' }));
    const iterator = stream.stdout[Symbol.asyncIterator]();
    const pid = pidOf(await readUntil(iterator, (s) => s.endsWith('\n')));
    assert.ok(Number.isInteger(pid) && pid > 0, 'the worker printed its pid');
    assert.equal(alive(pid), true);
    stream.kill();
    const result = await stream.result;
    assert.equal(result.ok, false);
    assert.equal(await goneWithin(pid, 2000), true, 'ESRCH: no worker process is left');
  });

  it('environment is minimal: injection variables and secrets in the parent environment never reach the worker', { timeout: 30_000 }, async () => {
    const parentEnv = {
      ...process.env,
      NODE_OPTIONS: '--no-warnings',
      NODE_PATH: '/tmp/evil',
      LD_PRELOAD: '/tmp/evil.so',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      SECRET_TOKEN: 'hunter2',
      ECHO_BURST_MB: '5', // not part of this spec: an inherited mode switch must not leak either
    };
    const result = await workerRunner.run(workerSpec({ stdin: 'x\n' }, { ECHO_PRINT_ENV: '1' }), { env: parentEnv });
    assert.equal(result.ok, true, text(result.stderr));
    const out = text(result.stdout);
    const line = out.split('\n').find((l) => l.startsWith('ENV '));
    assert.ok(line !== undefined, `the worker printed its environment: ${out.slice(0, 200)}`);
    const keys = JSON.parse(line.slice('ENV '.length)) as string[];
    for (const forbidden of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'SECRET_TOKEN', 'ECHO_BURST_MB']) {
      assert.equal(keys.includes(forbidden), false, `${forbidden} reached the worker`);
    }
    assert.equal(keys.includes('GSD_ATLAS_WORKER'), true);
    assert.equal(out.endsWith('X\n'), true, 'the worker still echoes');
  });

  it('GSD_ATLAS_WORKER is 1 in the worker', { timeout: 30_000 }, async () => {
    const probe = createRealRunner({
      builtinShapes: [{ ...workerShape, args: [{ literal: '-p' }, { literal: 'process.env.GSD_ATLAS_WORKER' }] }],
    });
    const result = await probe.run({ executable: process.execPath, args: ['-p', 'process.env.GSD_ATLAS_WORKER'], builtinId: 'typescript-resolver', env: { GSD_ATLAS_WORKER: '1' } });
    assert.equal(result.denied, undefined);
    assert.equal(text(result.stdout).trim(), '1');
  });

  it('stderr is capped at its default and does not kill the worker', { timeout: 30_000 }, async () => {
    const result = await workerRunner.run(workerSpec({ stdin: 'still here\n' }, { ECHO_STDERR_MB: '2' }));
    assert.equal(result.truncated, true);
    assert.equal(result.stderr.length, 1 * MIB);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(text(result.stdout), 'STILL HERE\n');
    assert.equal(result.diagnostics.some((d) => d.code === 'output_cap_exceeded' && d.severity === 'warning'), true);
  });

  it('parent killed: a worker whose parent dies with SIGKILL and never ended stdin exits when its stdin closes', { timeout: 60_000 }, async () => {
    const parentScript = [
      'const [runnerUrl, builtinsUrl, worker] = process.argv.slice(1);',
      'const { createRealRunner } = await import(runnerUrl);',
      'const { compilerWorkerShape } = await import(builtinsUrl);',
      'const base = compilerWorkerShape({ execPath: process.execPath, workerPath: worker });',
      "const shape = { ...base, env: { ...base.env, ECHO_PRINT_PID: '^1$' } };",
      'const runner = createRealRunner({ builtinShapes: [shape] });',
      "const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };",
      "const stream = runner.stream({ executable: process.execPath, args: ['--max-old-space-size=256', worker], builtinId: 'typescript-resolver', env: { GSD_ATLAS_WORKER: '1', ECHO_PRINT_PID: '1' }, stdin: never });",
      'for await (const chunk of stream.stdout) { process.stdout.write(chunk); break; }',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const parent = runner.stream({
      executable: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        parentScript,
        new URL('./real.ts', import.meta.url).href,
        new URL('./builtins.ts', import.meta.url).href,
        WORKER,
      ],
    });
    const iterator = parent.stdout[Symbol.asyncIterator]();
    const first = await readUntil(iterator, (s) => s.endsWith('\n'));
    const pid = pidOf(first);
    try {
      assert.ok(Number.isInteger(pid) && pid > 0, `the parent reported the worker pid: ${first}`);
      assert.equal(alive(pid), true, 'the worker is running while its parent lives');
      parent.kill();
      await parent.result;
      assert.equal(await goneWithin(pid, 15_000), true, 'the worker exited when its stdin closed');
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
