/**
 * Plan 02-46, option 2: `check-attr` runs beside the clean-filter enumeration. These tests drive the real Indexer
 * over a real temporary repository through a gate that withholds every process result until the test releases it,
 * so the number of SEQUENTIAL stages is counted without reading a clock: an edit is 2 stages (3 spawns), a new file
 * 3 (4 spawns). They also pin the error semantics of the two concurrent calls and the T-01-50 rule that the filter
 * list is enumerated on every hash and never cached.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createRecordingRunner } from '../command-runner/index.ts';
import type { CommandResult, CommandRunner, CommandSpec, RecordedSpec, RecordingRunner, RunContext } from '../command-runner/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { collectStages, createRunGate } from '../test-kit/index.ts';
import { THREE_FILES, makeWorld } from './harness.test.ts';
import type { World } from './harness.test.ts';
import type { IndexerNotice } from './index.ts';

/** The git subcommand of a spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommandOf = (spec: { readonly args: readonly string[] }): string => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i] ?? '?';
};

const encoder = new TextEncoder();

/** A failed run, as the real runner reports a git that exited 128. */
const exit128 = (): CommandResult => ({
  ok: false,
  exitCode: 128,
  signal: null,
  stdout: new Uint8Array(0),
  stderr: encoder.encode('fatal: injected failure'),
  truncated: false,
  timedOut: false,
  diagnostics: [],
});

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}
function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Rig {
  readonly world: World;
  readonly recorder: RecordingRunner;
  readonly notices: IndexerNotice[];
  /** Sequential stages (sorted subcommands per stage) of `operation`, with every result held until its stage is released. */
  stagesOf(operation: () => Promise<unknown>): Promise<string[][]>;
  /** Subcommands of the specs the recorder saw since the last reset, in start order. */
  starts(): string[];
}

interface RigOptions {
  /** Makes every run of this subcommand answer exit 128 (it is still counted as started). */
  readonly fail?: readonly string[];
  /** Holds every run of this subcommand until the deferred resolves (the real run happens after). */
  readonly hold?: { readonly subcommand: string; readonly until: Deferred };
  readonly wrapTree?: (tree: SourceTree) => SourceTree;
}

async function rig(t: TestContext, options: RigOptions = {}): Promise<Rig> {
  const notices: IndexerNotice[] = [];
  let recorder: RecordingRunner | undefined;
  let gating = false;
  let armed = false;
  const gate = createRunGate<CommandSpec, RunContext, CommandResult>((spec, ctx) => (recorder as RecordingRunner).run(spec, ctx));
  const world = await makeWorld(t, {
    files: THREE_FILES,
    onNotice: (n) => notices.push(n),
    ...(options.wrapTree === undefined ? {} : { wrapTree: options.wrapTree }),
    wrapRunner: (real): CommandRunner => {
      // real <- faulty (hold, injected failure) <- recorder (counts every start) <- gate (stage counting)
      const faulty: CommandRunner = {
        stream: (spec, ctx) => real.stream(spec, ctx),
        run: async (spec, ctx) => {
          const sub = subcommandOf(spec);
          if (armed && options.hold !== undefined && sub === options.hold.subcommand) await options.hold.until.promise;
          if (armed && options.fail?.includes(sub) === true) return exit128();
          return real.run(spec, ctx);
        },
      };
      const counted = createRecordingRunner({ delegate: faulty });
      recorder = counted;
      return {
        stream: (spec, ctx) => counted.stream(spec, ctx),
        run: (spec, ctx) => (gating ? gate.run(spec, ctx) : counted.run(spec, ctx)),
      };
    },
  });
  assert.ok(recorder !== undefined);
  await world.indexer.build(world.dir);
  recorder.reset();
  notices.length = 0;
  armed = true; // the injected failures and holds start after the build
  const ready = recorder;
  return {
    world,
    recorder: ready,
    notices,
    async stagesOf(operation) {
      gating = true;
      try {
        const stages = await collectStages(gate, operation());
        return stages.map((specs) => specs.map(subcommandOf).sort());
      } finally {
        gating = false;
      }
    },
    starts: () => ready.starts.map(subcommandOf),
  };
}

describe('sequential spawn stages per save (plan 02-46)', () => {
  it('edit is two stages', async (t) => {
    const { world, stagesOf, starts } = await rig(t);
    world.repo.write('a.toy', 'fn main {\n}\nfn edited_one {\n}\n');
    const stages = await stagesOf(() => world.indexer.ensureFresh(world.dir, ['a.toy']));
    // config and check-attr together, then hash-object: three spawns in two stages.
    assert.deepEqual(stages, [['check-attr', 'config'], ['hash-object']]);
    assert.equal(starts().length, 3);
    assert.equal((await world.reader.find('edited_one')).data.length, 1, 'the facts were committed');
  });

  it('new file is three stages', async (t) => {
    const { world, stagesOf, starts } = await rig(t);
    world.repo.write('d.toy', 'fn brand_new {\n}\n');
    const stages = await stagesOf(() => world.indexer.ensureFresh(world.dir, ['d.toy']));
    // The ignore listing first, then config with check-attr, then hash-object: four spawns in three stages.
    assert.deepEqual(stages, [['ls-files'], ['check-attr', 'config'], ['hash-object']]);
    assert.equal(starts().length, 4);
    assert.equal((await world.reader.find('brand_new')).data.length, 1, 'the facts were committed');
  });

  it('deleting a file starts no git and has no stage', async (t) => {
    const { world, stagesOf } = await rig(t);
    world.repo.remove('b.toy');
    const stages = await stagesOf(() => world.indexer.ensureFresh(world.dir, ['b.toy']));
    assert.deepEqual(stages, []);
  });
});

describe('error semantics of the two concurrent calls (plan 02-46)', () => {
  it('config failure is reported first', async (t) => {
    // check-attr is held, so the filter enumeration fails while the attribute query is still in flight.
    const hold = deferred();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    t.after(() => process.off('unhandledRejection', listener));

    const { world, notices } = await rig(t, { fail: ['config'], hold: { subcommand: 'check-attr', until: hold } });
    world.repo.write('a.toy', 'fn main {\n}\nfn edited_one {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, ['a.toy']);

    // Reported at once, while the attribute query has not answered, with the error the old flow raised.
    assert.deepEqual(notices.filter((n) => n.kind === 'failed').map((n) => (n.kind === 'failed' ? [n.path, n.code] : [])), [
      ['a.toy', 'filter_enumeration_failed'],
    ]);
    assert.deepEqual(result.stalePaths, ['a.toy']);
    // The abandoned attribute query now answers (and, in the next case, fails) without anyone left to hear it.
    hold.resolve();
    for (let pass = 0; pass < 20; pass += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  });

  it('check-attr failure is reported', async (t) => {
    const { world, notices } = await rig(t, { fail: ['check-attr'] });
    world.repo.write('a.toy', 'fn main {\n}\nfn edited_one {\n}\n');
    world.repo.write('b.toy', 'fn helper {\n}\nfn edited_two {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, ['a.toy', 'b.toy']);
    // The old sourceSet call raised git_failed for the whole batch; every path of the batch is reported with it.
    assert.deepEqual(
      notices.flatMap((n) => (n.kind === 'failed' ? [[n.path, n.code]] : [])).sort(),
      [
        ['a.toy', 'git_failed'],
        ['b.toy', 'git_failed'],
      ],
    );
    assert.deepEqual(result.stalePaths, ['a.toy', 'b.toy']);
    assert.equal((await world.reader.find('edited_one')).data.length, 0, 'nothing was committed for a failed batch');
  });

  it('both fail', async (t) => {
    const { world, notices } = await rig(t, { fail: ['config', 'check-attr'] });
    world.repo.write('a.toy', 'fn main {\n}\nfn edited_one {\n}\n');
    await world.indexer.ensureFresh(world.dir, ['a.toy']);
    // The filter enumeration is the earlier stage in the old order, so its error is the one reported.
    assert.deepEqual(
      notices.flatMap((n) => (n.kind === 'failed' ? [[n.path, n.code]] : [])),
      [['a.toy', 'filter_enumeration_failed']],
    );
  });

  it('check-attr failure with nothing hashed is ignored', async (t) => {
    // Every candidate is gone by the time it is hashed: the attribute query is abandoned, and its failure is not an error.
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    t.after(() => process.off('unhandledRejection', listener));

    const { world, notices, starts } = await rig(t, {
      fail: ['check-attr'],
      wrapTree: (tree) => ({
        ...tree,
        hashPaths: () => Promise.resolve({ files: new Map<string, string>(), diagnostics: [] }),
      }),
    });
    world.repo.write('a.toy', 'fn main {\n}\nfn edited_one {\n}\n');
    const result = await world.indexer.ensureFresh(world.dir, ['a.toy']);
    for (let pass = 0; pass < 20; pass += 1) await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(starts().includes('check-attr'), 'the attribute query was started and failed');
    assert.deepEqual(notices.filter((n) => n.kind === 'failed'), []);
    assert.deepEqual(result, { complete: true, stalePaths: [], invalid: [] });
    assert.deepEqual(unhandled, []);
  });
});

describe('the clean-filter list is enumerated on every hash (T-01-50)', () => {
  it('filter list is never cached', async (t) => {
    const { world, recorder } = await rig(t);
    const configRuns = (): number => recorder.starts.filter((s) => subcommandOf(s) === 'config').length;
    const hashSpecs = (): RecordedSpec[] => recorder.starts.filter((s) => subcommandOf(s) === 'hash-object');

    world.repo.write('a.toy', 'fn main {\n}\nfn one {\n}\n');
    await world.indexer.ensureFresh(world.dir, ['a.toy']);
    assert.equal(configRuns(), 1);

    // A driver added between two batches is neutralised in the second one.
    await world.repo.setConfig('filter.latecomer.clean', 'cat');
    world.repo.write('a.toy', 'fn main {\n}\nfn two {\n}\n');
    await world.indexer.ensureFresh(world.dir, ['a.toy']);
    assert.equal(configRuns(), 2);
    const second = hashSpecs()[1];
    assert.ok(second !== undefined);
    assert.ok(Object.values(second.env ?? {}).includes('filter.latecomer.clean'), 'the new driver is in the neutralisation overlay');

    world.repo.write('a.toy', 'fn main {\n}\nfn three {\n}\n');
    await world.indexer.ensureFresh(world.dir, ['a.toy']);
    assert.equal(configRuns(), 3, 'one enumeration per hashPaths call, three batches');
    assert.equal(hashSpecs().length, 3);
  });
});
