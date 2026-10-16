import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineCommandRunnerContract, SCENARIOS } from './contract.ts';
import type { Scenario } from './contract.ts';
import { createRealRunner, createRecordingRunner, decide } from './index.ts';
import type { CommandSpec, DecideFn, ScriptedResult } from './index.ts';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Allows exactly process.execPath (the child of every portable test); everything else goes through the real rules. */
const nodeOnly: DecideFn = (spec, ctx) =>
  spec.executable === process.execPath ? { allowed: true, via: 'user' } : decide(spec, ctx);

const node = (script: string, args: readonly string[] = [], extra: Partial<CommandSpec> = {}): CommandSpec => ({
  executable: process.execPath,
  args: ['-e', script, '--', ...args],
  ...extra,
});

/** The fake scripts the outcome each scenario's real child produces, keyed by the scenario's argv. */
function scriptedFor(scenarios: readonly Scenario[]): (spec: CommandSpec) => ScriptedResult | undefined {
  const table = scenarios
    .filter((s) => !s.expect.denied)
    .map((s) => ({ key: JSON.stringify(s.build({ tmp: '', node: process.execPath }).spec), expect: s.expect }));
  return (spec) => {
    const hit = table.find((t) => t.key === JSON.stringify(spec));
    return hit === undefined
      ? undefined
      : { ok: hit.expect.ok, exitCode: hit.expect.exitCode, stdout: hit.expect.stdout };
  };
}

defineCommandRunnerContract('fake', (scenarios) =>
  createRecordingRunner({ decide: nodeOnly, respond: scriptedFor(scenarios) }),
);
defineCommandRunnerContract('real', () => createRealRunner({ decide: nodeOnly }));

describe('real runner: built-in git --version through decide (tracer)', () => {
  it('runs git --version by default and returns the version bytes', async () => {
    const result = await createRealRunner().run({ executable: 'git', args: ['--version'], builtinId: 'git' });
    assert.equal(result.ok, true, JSON.stringify(result.spawnError ?? result.denied));
    assert.equal(result.exitCode, 0);
    assert.ok(text(result.stdout).startsWith('git version'), text(result.stdout));
    assert.equal(result.denied, undefined);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
  });

  it('denies a spec for process.execPath under the default decide, and starts nothing', async () => {
    const result = await createRealRunner().run(node("process.stdout.write('x')"), { repo: '/some/repo' });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.denied?.code, 'command_denied');
    assert.ok(result.denied?.message.includes('permissions.commands'));
    assert.equal(text(result.stdout), '');
  });

  it('runs the same spec under a decide that allows exactly process.execPath', async () => {
    const result = await createRealRunner({ decide: nodeOnly }).run(node("process.stdout.write('x')"));
    assert.equal(result.ok, true);
    assert.equal(text(result.stdout), 'x');
  });

  it('honours injected user permissions for the named repo only', async () => {
    const runner = createRealRunner({ user: { allow: [{ repo: '/repo/a', executable: process.execPath }] } });
    assert.equal((await runner.run(node("process.stdout.write('ok')"), { repo: '/repo/a' })).ok, true);
    assert.equal((await runner.run(node("process.stdout.write('ok')"), { repo: '/repo/b' })).denied?.code, 'command_denied');
  });

  it('overlays the spec env on the inherited environment', async () => {
    const runner = createRealRunner({ decide: nodeOnly, env: { INHERITED: 'from-parent', PATH: process.env.PATH ?? '' } });
    const result = await runner.run(
      node('process.stdout.write(String(process.env.INHERITED) + "|" + String(process.env.OVERLAY))', [], { env: { OVERLAY: 'from-spec' } }),
    );
    assert.equal(text(result.stdout), 'from-parent|from-spec');
  });
});

describe('recording fake', () => {
  it('records every allowed spec in starts and every denied spec in denials', async () => {
    const fake = createRecordingRunner();
    await fake.run({ executable: 'git', args: ['--version'], builtinId: 'git' });
    const denied = await fake.run({ executable: 'sh', args: ['-c', 'id'] });
    assert.equal(fake.starts.length, 1);
    assert.equal(fake.denials.length, 1);
    assert.equal(fake.starts[0]?.executable, 'git');
    assert.equal(fake.denials[0]?.executable, 'sh');
    assert.equal(denied.denied?.code, 'command_denied');
    assert.equal(denied.ok, false);
  });

  it('returns scripted results in order, then a default success', async () => {
    const fake = createRecordingRunner({
      decide: () => ({ allowed: true, via: 'user' }),
      script: [{ stdout: 'one' }, { ok: false, exitCode: 2, stderr: 'boom' }],
    });
    const spec: CommandSpec = { executable: 'tool', args: [] };
    const a = await fake.run(spec);
    const b = await fake.run(spec);
    const c = await fake.run(spec);
    assert.equal(text(a.stdout), 'one');
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.exitCode, 2);
    assert.equal(text(b.stderr), 'boom');
    assert.equal(c.ok, true);
    assert.equal(c.exitCode, 0);
    assert.equal(fake.starts.length, 3);
  });

  it('respond takes precedence over the script', async () => {
    const fake = createRecordingRunner({
      decide: () => ({ allowed: true, via: 'user' }),
      script: [{ stdout: 'scripted' }],
      respond: (spec) => (spec.args[0] === 'x' ? { stdout: 'responded' } : undefined),
    });
    assert.equal(text((await fake.run({ executable: 't', args: ['x'] })).stdout), 'responded');
    assert.equal(text((await fake.run({ executable: 't', args: ['y'] })).stdout), 'scripted');
  });

  it('with a delegate, forwards allowed specs and still records them', async () => {
    const real = createRealRunner({ decide: nodeOnly });
    const fake = createRecordingRunner({ decide: nodeOnly, delegate: real });
    const result = await fake.run(node("process.stdout.write('through')"));
    assert.equal(text(result.stdout), 'through');
    assert.equal(fake.starts.length, 1);
    assert.equal(fake.denials.length, 0);
    const denied = await fake.run({ executable: 'sh', args: [] });
    assert.equal(denied.denied?.code, 'command_denied');
    assert.equal(fake.denials.length, 1);
  });

  it('reset clears the records and rewinds the script', async () => {
    const fake = createRecordingRunner({ decide: () => ({ allowed: true, via: 'user' }), script: [{ stdout: 'first' }] });
    await fake.run({ executable: 't', args: [] });
    fake.reset();
    assert.equal(fake.starts.length, 0);
    assert.equal(fake.denials.length, 0);
    assert.equal(text((await fake.run({ executable: 't', args: [] })).stdout), 'first');
  });

  it('records stdin: the value for strings and bytes, the byte length for iterables', async () => {
    const fake = createRecordingRunner({ decide: () => ({ allowed: true, via: 'user' }) });
    async function* chunks(): AsyncGenerator<string | Uint8Array> {
      yield 'ab';
      yield new Uint8Array([1, 2, 3]);
    }
    await fake.run({ executable: 't', args: [], stdin: 'text' });
    await fake.run({ executable: 't', args: [], stdin: new Uint8Array([9, 9]) });
    await fake.run({ executable: 't', args: [], stdin: chunks() });
    assert.equal(fake.starts[0]?.stdin, 'text');
    assert.deepEqual(fake.starts[1]?.stdin, new Uint8Array([9, 9]));
    assert.deepEqual(fake.starts[2]?.stdin, { iterableBytes: 5 });
  });

  it('records stream() starts and denials and yields the scripted stdout', async () => {
    const fake = createRecordingRunner({ decide: nodeOnly, script: [{ stdout: 'streamed' }] });
    const stream = fake.stream(node('1'));
    let seen = '';
    for await (const chunk of stream.stdout) seen += text(chunk);
    const result = await stream.result;
    assert.equal(seen, 'streamed');
    assert.equal(result.ok, true);
    assert.equal(fake.starts.length, 1);

    const denied = fake.stream({ executable: 'sh', args: [] });
    for await (const chunk of denied.stdout) assert.fail('a denied stream yields nothing: ' + text(chunk));
    assert.equal((await denied.result).denied?.code, 'command_denied');
    assert.equal(fake.denials.length, 1);
  });

  it('scripted results can carry timeouts and truncation', async () => {
    const fake = createRecordingRunner({
      decide: () => ({ allowed: true, via: 'user' }),
      script: [{ timedOut: true }, { truncated: true }],
    });
    const a = await fake.run({ executable: 't', args: [] });
    const b = await fake.run({ executable: 't', args: [] });
    assert.equal(a.timedOut, true);
    assert.equal(a.ok, false);
    assert.equal(b.truncated, true);
  });

  it('the shared SCENARIOS list is non-empty and every scenario has a name', () => {
    assert.ok(SCENARIOS.length >= 5);
    for (const s of SCENARIOS) assert.ok(s.name.length > 0);
  });
});
