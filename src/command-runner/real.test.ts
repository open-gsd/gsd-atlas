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
import { allowAll, createRealRunner } from './index.ts';
import type { CommandSpec } from './index.ts';

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
