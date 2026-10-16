import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { RecordedSpec } from '../command-runner/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import { createSourceTree } from './index.ts';

/** Independent oracle: the git blob id of `content` in a SHA-1 repository. */
const blobId = (content: string | Uint8Array): string => {
  const body = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

/** The git subcommand of a recorded spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommand = (spec: RecordedSpec): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

describe('Source Tree tracer: one batched hash-object over a whole snapshot', () => {
  it('hashes tracked and untracked files to the git blob ids, in exactly four git starts', async (t) => {
    const setup = createRealRunner({ decide: allowAll });
    const repo = await createTempGitRepo({
      runner: setup,
      files: { 'a.txt': 'alpha\n', 'dir/b.ts': 'export const b = 1;\n', 'sp ace.txt': 'space\n' },
    });
    t.after(() => repo.cleanup());
    repo.write('untracked.txt', 'not committed\n');

    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: repo.dir, envOverlay: repo.envOverlay });
    const snapshot = await tree.snapshot(repo.dir);

    assert.deepEqual(snapshot.diagnostics, []);
    assert.deepEqual(
      [...snapshot.files].sort(([x], [y]) => (x < y ? -1 : 1)),
      [
        ['a.txt', blobId('alpha\n')],
        ['dir/b.ts', blobId('export const b = 1;\n')],
        ['sp ace.txt', blobId('space\n')],
        ['untracked.txt', blobId('not committed\n')],
      ],
    );

    assert.equal(recording.denials.length, 0);
    assert.equal(recording.starts.length, 4, recording.starts.map((s) => subcommand(s)).join(','));
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'));
    const hashes = recording.starts.filter((s) => subcommand(s) === 'hash-object');
    assert.equal(hashes.length, 1);
    const [hash] = hashes;
    assert.ok(hash?.args.includes('--stdin-paths'));
    assert.equal(typeof hash?.stdin, 'string');
    const lines = String(hash?.stdin).split('\n').filter((l) => l !== '');
    assert.deepEqual([...lines].sort(), ['a.txt', 'dir/b.ts', 'sp ace.txt', 'untracked.txt']);
  });
});
