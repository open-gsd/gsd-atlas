/**
 * The exact-shape built-in for the compiler worker (plan 03-19, TSM-05, D-13; command-runner ADR, Phase 3 amendment).
 * One test per kind of deviation, modelled on the git allowlist tests: every deviation is a denial with nothing started.
 * The shape is built from `process.execPath` and a plain `.mjs` file, so the cases are identical on every OS.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { compilerWorkerShape, matchShape } from './builtins.ts';
import { createRealRunner, createRecordingRunner, decide } from './index.ts';
import type { CommandSpec } from './index.ts';
import type { BuiltinShape } from './spec.ts';

const WORKER = path.join(import.meta.dirname, '__fixtures__', 'echo-worker.mjs');
const SHAPE: BuiltinShape = compilerWorkerShape({ execPath: process.execPath, workerPath: WORKER });
const SHAPES: readonly BuiltinShape[] = [SHAPE];
const CTX = { repo: path.join(import.meta.dirname, 'no-such-repo') };

/** The one spec the shape accepts; each deviation test changes exactly one thing about it. */
function good(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    executable: process.execPath,
    args: ['--max-old-space-size=256', WORKER],
    builtinId: 'typescript-resolver',
    env: { GSD_ATLAS_WORKER: '1' },
    ...overrides,
  };
}

function deniedBy(spec: CommandSpec, shapes: readonly BuiltinShape[] | 'none-passed' = SHAPES): void {
  const decision = shapes === 'none-passed' ? decide(spec, CTX) : decide(spec, CTX, undefined, shapes);
  assert.equal(decision.allowed, false, JSON.stringify(spec));
  if (!decision.allowed) assert.equal(decision.diagnostic.code, 'command_denied');
}

describe('compilerWorkerShape', () => {
  it('has the id typescript-resolver, the heap flag pattern, the worker path as a literal and one env key', () => {
    assert.equal(SHAPE.id, 'typescript-resolver');
    assert.equal(SHAPE.executable, process.execPath);
    assert.deepEqual(SHAPE.args, [{ pattern: '--max-old-space-size=[0-9]{1,6}' }, { literal: WORKER }]);
    assert.deepEqual(SHAPE.env, { GSD_ATLAS_WORKER: '^1$' });
  });

  it('refuses an empty executable or worker path', () => {
    assert.throws(() => compilerWorkerShape({ execPath: '', workerPath: WORKER }), TypeError);
    assert.throws(() => compilerWorkerShape({ execPath: process.execPath, workerPath: '' }), TypeError);
  });
});

describe('matchShape', () => {
  it('matches the exact spec', () => {
    assert.equal(matchShape(SHAPE, good()), true);
  });

  it('does not match a spec that does not claim the shape id', () => {
    assert.equal(matchShape(SHAPE, good({ builtinId: undefined })), false);
  });

  it('treats a malformed pattern in a shape as a non-match, not an exception', () => {
    const broken: BuiltinShape = { id: 'x', executable: 'node', args: [{ pattern: '(' }], env: {} };
    assert.equal(matchShape(broken, { executable: 'node', args: ['('], builtinId: 'x' }), false);
  });

  it('anchors a pattern to the whole argument', () => {
    const shape: BuiltinShape = { id: 'x', executable: 'node', args: [{ pattern: 'a|b' }], env: {} };
    assert.equal(matchShape(shape, { executable: 'node', args: ['a'], builtinId: 'x' }), true);
    assert.equal(matchShape(shape, { executable: 'node', args: ['ab'], builtinId: 'x' }), false);
    assert.equal(matchShape(shape, { executable: 'node', args: ['xb'], builtinId: 'x' }), false);
  });
});

describe('decide with the compiler worker shape', () => {
  it('allows the exact shape via builtin typescript-resolver', () => {
    const decision = decide(good(), CTX, undefined, SHAPES);
    assert.deepEqual(decision, { allowed: true, via: 'builtin', builtinId: 'typescript-resolver' });
  });

  it('allows the exact shape with other heap sizes of one to six digits', () => {
    for (const size of ['1', '256', '4096', '999999']) {
      const decision = decide(good({ args: [`--max-old-space-size=${size}`, WORKER] }), CTX, undefined, SHAPES);
      assert.equal(decision.allowed, true, size);
    }
  });

  it('allows the exact shape with no environment at all (the keys are an upper bound, not a requirement)', () => {
    assert.equal(decide(good({ env: undefined }), CTX, undefined, SHAPES).allowed, true);
  });

  it('allows the exact shape without a repo in the context', () => {
    assert.equal(decide(good(), undefined, undefined, SHAPES).allowed, true);
  });

  describe('denies', () => {
    it('denies a different executable', () => {
      deniedBy(good({ executable: path.join(path.dirname(process.execPath), 'other-node') }));
    });

    it('denies the bare name node (the exact string the composition root passed is compared)', () => {
      deniedBy(good({ executable: 'node' }));
    });

    it('denies a missing heap flag', () => {
      deniedBy(good({ args: [WORKER] }));
    });

    it('denies an extra argument', () => {
      deniedBy(good({ args: ['--max-old-space-size=256', WORKER, '--extra'] }));
    });

    it('denies an extra argument before the heap flag', () => {
      deniedBy(good({ args: ['--no-warnings', '--max-old-space-size=256', WORKER] }));
    });

    it('denies a non-numeric heap size', () => {
      deniedBy(good({ args: ['--max-old-space-size=abc', WORKER] }));
    });

    it('denies a seven digit heap size', () => {
      deniedBy(good({ args: ['--max-old-space-size=1234567', WORKER] }));
    });

    it('denies an empty heap size', () => {
      deniedBy(good({ args: ['--max-old-space-size=', WORKER] }));
    });

    it('denies a heap size with a sign, a space or a trailing newline', () => {
      for (const arg of ['--max-old-space-size=-1', '--max-old-space-size= 1', '--max-old-space-size=1\n', '--max-old-space-size=1 ']) {
        deniedBy(good({ args: [arg, WORKER] }));
      }
    });

    it('denies a flag other than the heap flag', () => {
      deniedBy(good({ args: ['--inspect', WORKER] }));
    });

    it('denies a heap flag with a prefix or a suffix', () => {
      deniedBy(good({ args: ['x--max-old-space-size=256', WORKER] }));
      deniedBy(good({ args: ['--max-old-space-size=256;', WORKER] }));
    });

    it('denies a worker path altered by one character', () => {
      deniedBy(good({ args: ['--max-old-space-size=256', WORKER.slice(0, -1) + 'x'] }));
    });

    it('denies a worker path with a trailing slash', () => {
      deniedBy(good({ args: ['--max-old-space-size=256', WORKER + '/'] }));
    });

    it('denies a different worker file and a relative worker path', () => {
      deniedBy(good({ args: ['--max-old-space-size=256', path.join(path.dirname(WORKER), 'other.mjs')] }));
      deniedBy(good({ args: ['--max-old-space-size=256', path.relative(process.cwd(), WORKER)] }));
    });

    it('denies the heap flag after the path (order)', () => {
      deniedBy(good({ args: [WORKER, '--max-old-space-size=256'] }));
    });

    it('denies an environment key NODE_OPTIONS', () => {
      deniedBy(good({ env: { GSD_ATLAS_WORKER: '1', NODE_OPTIONS: '--require /tmp/evil.js' } }));
    });

    it('denies LD_PRELOAD, DYLD_INSERT_LIBRARIES, PATH and any other key outside the shape', () => {
      for (const key of ['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PATH', 'HOME', 'constructor', '__proto__']) {
        const env = Object.defineProperty({ GSD_ATLAS_WORKER: '1' }, key, { value: '1', enumerable: true });
        deniedBy(good({ env }));
      }
    });

    it('denies the environment key GSD_ATLAS_WORKER with value 0, an empty value or a longer value', () => {
      for (const value of ['0', '', '11', '1\n', ' 1']) deniedBy(good({ env: { GSD_ATLAS_WORKER: value } }));
    });

    it('denies a spec with no builtinId', () => {
      deniedBy(good({ builtinId: undefined }));
    });

    it('denies a different builtinId', () => {
      deniedBy(good({ builtinId: 'typescript-resolver2' }));
      deniedBy(good({ builtinId: 'other' }));
    });

    it('denies builtinId git claimed with this shape argv', () => {
      deniedBy(good({ builtinId: 'git' }));
    });

    it('denies the shape argv when no shapes were passed at all', () => {
      deniedBy(good(), 'none-passed');
    });

    it('denies the shape argv when an empty table was passed', () => {
      deniedBy(good(), []);
    });

    it('denies the shape when the table holds a shape with another id', () => {
      deniedBy(good(), [{ ...SHAPE, id: 'other' }]);
    });

    it('a shape cannot claim the id git', () => {
      const git: BuiltinShape = { ...SHAPE, id: 'git' };
      deniedBy(good({ builtinId: 'git' }), [git]);
    });

    it('is not rescued by user permissions for a different repo', () => {
      const decision = decide(good({ args: ['--inspect', WORKER] }), CTX, { allow: [{ repo: '/other', executable: process.execPath }] }, SHAPES);
      assert.equal(decision.allowed, false);
    });
  });

  it('the runner started nothing for a denied deviation (real runner with the shape table)', async () => {
    const runner = createRealRunner({ builtinShapes: SHAPES });
    const result = await runner.run(good({ args: ['--inspect', WORKER] }), CTX);
    assert.equal(result.denied?.code, 'command_denied');
    assert.equal(result.exitCode, null);
    assert.equal(result.ok, false);
  });

  it('a real runner built without shapes behaves exactly as before: the shape argv is denied', async () => {
    const runner = createRealRunner();
    const result = await runner.run(good(), CTX);
    assert.equal(result.denied?.code, 'command_denied');
    assert.equal(result.exitCode, null);
  });

  it('the recording runner passes the table through: allowed with shapes, denied without', async () => {
    const withShapes = createRecordingRunner({ builtinShapes: SHAPES });
    await withShapes.run(good(), CTX);
    assert.equal(withShapes.starts.length, 1);
    assert.equal(withShapes.denials.length, 0);

    const without = createRecordingRunner();
    await without.run(good(), CTX);
    assert.equal(without.starts.length, 0);
    assert.equal(without.denials.length, 1);
  });

  it('does not make the table module state: two tables in one process do not leak into each other', () => {
    const other = compilerWorkerShape({ execPath: process.execPath, workerPath: path.join(path.dirname(WORKER), 'other.mjs') });
    assert.equal(decide(good(), CTX, undefined, [other]).allowed, false);
    assert.equal(decide(good(), CTX, undefined, SHAPES).allowed, true);
    assert.equal(decide(good(), CTX, undefined, undefined).allowed, false);
  });
});
