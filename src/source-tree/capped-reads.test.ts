/**
 * WR-08: `readMany` asks for sizes first (`cat-file --batch-check`) and buffers only the blobs it will keep, and
 * `read` caps the bytes it will buffer. Run against a real temporary repository through a recording runner, so
 * the process shape (how many git runs, what each was fed, what output cap each carried) is observable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowAll, createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { RecordedSpec } from '../command-runner/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import { createSourceTree } from './index.ts';

const setupRunner = createRealRunner({ decide: allowAll });

const CAP = 1024;
const FILES: Record<string, string> = {
  'small.txt': 's'.repeat(100),
  'exact.txt': 'e'.repeat(CAP),
  'over.txt': 'o'.repeat(CAP + 1),
  'huge.txt': 'h'.repeat(5000),
  'sp ace/é & q.txt': 'odd name\n',
};

/** The git subcommand of a recorded spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommand = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};
const catFileRuns = (starts: readonly RecordedSpec[]): RecordedSpec[] => starts.filter((s) => subcommand(s) === 'cat-file');
const stdinOf = (spec: RecordedSpec | undefined): string => (typeof spec?.stdin === 'string' ? spec.stdin : '');

async function fixture(t: { after(fn: () => void): void }) {
  const repo = await createTempGitRepo({ runner: setupRunner, files: FILES });
  t.after(() => repo.cleanup());
  const recording = createRecordingRunner({ delegate: createRealRunner() });
  const tree = createSourceTree({ runner: recording, repoDir: repo.dir, envOverlay: repo.envOverlay });
  const head = await tree.resolveCommit('HEAD');
  assert.ok(head !== null);
  recording.reset();
  return { repo, recording, tree, head };
}

const text = (bytes: Uint8Array | null | undefined): string | null => (bytes === null || bytes === undefined ? null : Buffer.from(bytes).toString('utf8'));

describe('readMany size check first (WR-08)', () => {
  it('at the cap: a blob exactly at the cap is returned, one byte over is not, a missing path is null without a diagnostic', async (t) => {
    const { tree, head } = await fixture(t);
    const { blobs, diagnostics } = await tree.readMany(head, ['small.txt', 'exact.txt', 'over.txt', 'huge.txt', 'nope.txt'], { maxBlobBytes: CAP });
    assert.equal(text(blobs.get('small.txt')), FILES['small.txt']);
    assert.equal(blobs.get('exact.txt')?.length, CAP);
    assert.equal(blobs.get('over.txt'), null);
    assert.equal(blobs.get('huge.txt'), null);
    assert.equal(blobs.get('nope.txt'), null);
    assert.equal(blobs.size, 5);
    assert.deepEqual(
      diagnostics.map((d) => `${d.code}:${d.subject ?? ''}`).sort(),
      ['source_too_large:huge.txt', 'source_too_large:over.txt'],
    );
  });

  it('two runs: a size check, then a batch of only the allowed blobs whose output cap follows their sizes', async (t) => {
    const { repo, recording, tree, head } = await fixture(t);
    await tree.readMany(head, ['small.txt', 'exact.txt', 'over.txt', 'huge.txt', 'nope.txt'], { maxBlobBytes: CAP });
    const runs = catFileRuns(recording.starts);
    assert.equal(runs.length, 2, runs.map((r) => r.args.join(' ')).join(' | '));
    const [check, batch] = runs;
    assert.ok(check?.args.includes('--batch-check'));
    assert.ok(batch?.args.includes('--batch'));
    assert.equal(batch?.args.includes('--batch-check'), false);
    assert.equal(stdinOf(check), `${head}^{commit}\n${['small.txt', 'exact.txt', 'over.txt', 'huge.txt', 'nope.txt'].map((p) => `${head}:${p}\n`).join('')}`);
    // The batch reads from the peeled commit id the size check reported, only for the allowed blobs.
    assert.equal(stdinOf(batch), `${head}\n${head}:small.txt\n${head}:exact.txt\n`);
    const commitSize = Number((await repo.git(['cat-file', '-s', head])).trim());
    const allowed = 100 + CAP;
    assert.ok((batch?.maxStdoutBytes ?? Infinity) >= commitSize + allowed, 'the cap holds the selected bytes');
    assert.ok((batch?.maxStdoutBytes ?? Infinity) <= commitSize + allowed + 128 * 3, 'plus the per-record allowance, no more');
    assert.ok((batch?.maxStdoutBytes ?? Infinity) < 64 * 1024, 'far below the old 512 MiB');
    assert.equal(typeof check?.timeoutMs, 'number');
    assert.equal(typeof batch?.timeoutMs, 'number');
  });

  it('all oversize: only the size check starts', async (t) => {
    const { recording, tree, head } = await fixture(t);
    const { blobs, diagnostics } = await tree.readMany(head, ['over.txt', 'huge.txt', 'nope.txt'], { maxBlobBytes: CAP });
    assert.equal(catFileRuns(recording.starts).length, 1);
    assert.ok(catFileRuns(recording.starts)[0]?.args.includes('--batch-check'));
    assert.deepEqual([...blobs.values()], [null, null, null]);
    assert.equal(diagnostics.length, 2);
  });

  it('empty list: no git starts at all', async (t) => {
    const { recording, tree, head } = await fixture(t);
    const { blobs } = await tree.readMany(head, []);
    assert.equal(blobs.size, 0);
    assert.equal(recording.starts.length, 0);
  });

  it('a path with spaces, a non-ASCII letter and an ampersand is matched by position and read', async (t) => {
    const { tree, head } = await fixture(t);
    const odd = 'sp ace/é & q.txt';
    const { blobs } = await tree.readMany(head, ['nope.txt', odd, 'small.txt'], { maxBlobBytes: CAP });
    assert.equal(blobs.get('nope.txt'), null);
    assert.equal(text(blobs.get(odd)), 'odd name\n');
    assert.equal(text(blobs.get('small.txt')), FILES['small.txt']);
  });

  it('unknown commit: commit_not_found from the size check, and the batch never starts', async (t) => {
    const { recording, tree } = await fixture(t);
    await assert.rejects(() => tree.readMany('f'.repeat(40), ['small.txt']), { code: 'commit_not_found' });
    assert.equal(catFileRuns(recording.starts).length, 1);
  });
});

describe('read cap (WR-08)', () => {
  it('read over the cap throws source_too_large; at the cap it returns the bytes; a missing path is still null', async (t) => {
    const { recording, tree, head } = await fixture(t);
    await assert.rejects(() => tree.read(head, 'huge.txt', { maxBytes: 100 }), { code: 'source_too_large' });
    await assert.rejects(() => tree.read(head, 'over.txt', { maxBytes: CAP }), { code: 'source_too_large' });
    assert.equal((await tree.read(head, 'exact.txt', { maxBytes: CAP }))?.length, CAP);
    assert.equal(await tree.read(head, 'nope.txt', { maxBytes: CAP }), null);
    // The output cap is the limit plus one byte: the buffer is bounded where the bytes arrive.
    const blobRuns = recording.starts.filter((s) => subcommand(s) === 'cat-file' && s.args.includes('blob'));
    assert.ok(blobRuns.length >= 4);
    assert.ok(blobRuns.every((s) => s.maxStdoutBytes === (s.args.some((a) => a.endsWith(':huge.txt')) ? 101 : CAP + 1)));
  });

  it('read without options uses the default 2 MiB cap', async (t) => {
    const { recording, tree, head } = await fixture(t);
    assert.equal(text(await tree.read(head, 'small.txt')), FILES['small.txt']);
    const run = recording.starts.find((s) => s.args.includes('blob'));
    assert.equal(run?.maxStdoutBytes, 2 * 1024 * 1024 + 1);
  });
});
