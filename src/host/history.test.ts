import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { createRealRunner, createRecordingRunner } from '../command-runner/index.ts';
import type { RecordingRunner } from '../command-runner/index.ts';
import type { Envelope } from '../facts/index.ts';
import { makeTempDir, realPath } from '../test-kit/index.ts';
import { makeWorld, writeFiles } from './harness.test.ts';
import type { World, WorldOptions } from './harness.test.ts';
import { HISTORY_SCHEMA } from './index.ts';

/** The git subcommand of a recorded spec: the first argument after any leading -C <dir> and -c <kv> pairs. */
const subcommand = (spec: { readonly args: readonly string[] }): string => {
  let i = 0;
  while (spec.args[i] === '-C' || spec.args[i] === '-c') i += 2;
  return spec.args[i] ?? '';
};

const codes = (reply: Envelope): string[] => reply.diagnostics.map((d) => d.code);

interface FindData {
  readonly results: ReadonlyArray<{ readonly name: string; readonly path: string; readonly line: number }>;
}
const names = (reply: Envelope): string[] => ((reply.data as FindData | null)?.results ?? []).map((r) => r.name);

/** Poll until `check` holds; the work behind it runs on real I/O. */
async function eventually(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Every file below `dir`: relative path, size and content hash, sorted. Empty when the directory is absent. */
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const bytes = fs.readFileSync(full);
        out.push(`${path.relative(dir, full)}:${String(bytes.length)}:${createHash('sha256').update(bytes).digest('hex')}`);
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

const COMMIT_1: Readonly<Record<string, string>> = {
  // The grammar tier follows uses inside the defining file (no imports in the toy language), so the call lives beside the definition.
  'a.toy': 'fn parse {\n}\nfn run {\n  parse();\n}\n',
  'b.toy': 'fn helper {\n}\n',
  'README.md': '# history\n',
};

/** Three commits: `parse` is defined in 1, renamed `parseInput` in 2 and a new `render` is added in 3. */
async function threeCommits(
  t: TestContext,
  extra: { readonly files?: WorldOptions['files']; readonly maxFiles?: number } = {},
): Promise<World & { readonly ids: readonly string[]; readonly recording: RecordingRunner }> {
  const recording = createRecordingRunner({ delegate: createRealRunner() });
  const root = makeTempDir();
  t.after(() => root.cleanup());
  const tmpRoot = realPath(root.path);
  const world = await makeWorld(t, {
    files: extra.files ?? COMMIT_1,
    host: {
      runner: recording,
      metrics: false,
      history: { tmpRoot, nonce: () => 'NONCE', ...(extra.maxFiles === undefined ? {} : { maxFiles: extra.maxFiles }) },
    },
  });
  const rev = async (): Promise<string> => (await world.repo.git(['rev-parse', 'HEAD'])).trim();
  const first = await rev();
  writeFiles(world.repo.dir, { 'a.toy': 'fn parseInput {\n}\nfn run {\n  parseInput();\n}\n' });
  await world.repo.commitAll('rename');
  const second = await rev();
  writeFiles(world.repo.dir, { 'c.toy': 'fn render {\n}\n' });
  await world.repo.commitAll('render');
  const third = await rev();
  return Object.assign(world, { ids: [first, second, third], recording });
}

const tmpRootOf = (world: World): string => (world.options.history?.tmpRoot as string);

const history = (world: World, args: Record<string, unknown>, extra?: { readonly budget_tokens?: number }): Promise<Envelope> =>
  world.ask('history', { repo: world.repo.dir, ...args }, extra);

describe('history: questions about a past commit from git alone (STO-09)', () => {
  it('answers find, refs, context and impact as of the commit, with its historical line text and a hint naming the short commit id', async (t) => {
    const world = await threeCommits(t);
    const [one, two] = world.ids as [string, string];
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    // The working tree differs from every commit: history must not read it.
    writeFiles(world.repo.dir, { 'a.toy': 'fn workingTreeEdit {\n}\n' });

    const old = await history(world, { tool: 'find', name: 'parse', at: one });
    assert.equal(old.ok, true, JSON.stringify(old.diagnostics));
    assert.equal(old.schema, HISTORY_SCHEMA);
    assert.deepEqual(names(old), ['parse']);
    assert.equal((old.data as FindData).results[0]?.path, 'a.toy');
    assert.equal((old.data as FindData).results[0]?.line, 1);
    assert.match(old.untrusted_text?.entries[0]?.text ?? '', /fn parse/);
    assert.ok(old.citations !== undefined && old.citations.length === 1);
    assert.ok(old.hints?.[0]?.includes(one.slice(0, 12)), JSON.stringify(old.hints));
    assert.ok(old.watermark !== undefined);

    const live = await world.ask('code_find', { name: 'parse', repo: world.repo.dir });
    assert.ok(!names(live).includes('parse'), 'at HEAD the name `parse` no longer exists (only the renamed one)');

    const renamed = await history(world, { tool: 'find', name: 'parseInput', at: two });
    assert.deepEqual(names(renamed), ['parseInput']);
    const before = await history(world, { tool: 'find', name: 'parseInput', at: one });
    assert.deepEqual(names(before), []);

    const refs = await history(world, { tool: 'refs', name: 'parse', at: one });
    assert.equal(refs.ok, true, JSON.stringify(refs.diagnostics));
    assert.equal(refs.schema, HISTORY_SCHEMA);
    assert.ok(refs.citations?.some((c) => c.path === 'a.toy' && c.line === 4), JSON.stringify(refs.citations));
    assert.match(refs.untrusted_text?.entries.map((e) => e.text).join('\n') ?? '', /parse\(\)/);

    const context = await history(world, { tool: 'context', name: 'parse', at: one });
    assert.equal(context.ok, true, JSON.stringify(context.diagnostics));
    assert.ok(context.citations?.some((c) => c.path === 'a.toy'));

    const impact = await history(world, { tool: 'impact', name: 'parse', at: one, depth: 1 });
    assert.equal(impact.ok, true, JSON.stringify(impact.diagnostics));
    assert.equal(impact.schema, HISTORY_SCHEMA);
  });

  it('leaves the real store untouched: names, sizes and contents are identical before and after, and the temporary directory is gone', async (t) => {
    const world = await threeCommits(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    const storeDir = path.join(world.repo.dir, '.git', 'gsd-atlas');
    assert.ok(fs.existsSync(storeDir), 'the leader built its store here');

    // The store settles (the dirty sentinel goes after its idle time) before it is measured.
    let measured = fingerprint(storeDir);
    await eventually(() => {
      const next = fingerprint(storeDir);
      const same = JSON.stringify(next) === JSON.stringify(measured);
      measured = next;
      return same;
    }, 'the store to settle');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const before = fingerprint(storeDir);

    for (const tool of ['find', 'refs', 'context', 'impact'] as const) {
      const reply = await history(world, { tool, name: 'parse', at: world.ids[0] });
      assert.equal(reply.ok, true, `${tool}: ${JSON.stringify(reply.diagnostics)}`);
    }
    const after = fingerprint(storeDir);
    assert.deepEqual(after, before);
    assert.ok(before.length > 0);
    assert.deepEqual(fs.readdirSync(tmpRootOf(world)), [], 'the throwaway store was removed');
  });

  it('works with no tenant: on a repository nobody built, no store is created, and nothing is watched', async (t) => {
    const world = await threeCommits(t);
    const reply = await history(world, { tool: 'find', name: 'parse', at: world.ids[0] });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.deepEqual(names(reply), ['parse']);
    assert.equal(fs.existsSync(path.join(world.repo.dir, '.git', 'gsd-atlas')), false, 'history created no store for the repository');
    assert.equal(world.manual.subscriptions(), 0);
    const status = await world.ask('atlas_status', { repo: world.repo.dir });
    assert.deepEqual((status.data as { worktrees: unknown[] }).worktrees, []);
  });

  it('works in a follower process while another process holds the writer lease', async (t) => {
    const world = await threeCommits(t);
    assert.equal((await world.ask('build', { repo: world.repo.dir })).ok, true);
    const follower = world.anotherHost();
    const reply = await follower.handle({ protocol: 1, kind: 'history', args: { repo: world.repo.dir, tool: 'find', name: 'parse', at: world.ids[0] } });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.deepEqual(names(reply), ['parse']);
  });

  it('path restricts the tree to one file: only that blob is read, and a path not in the commit is an empty result with a hint', async (t) => {
    const world = await threeCommits(t);
    world.recording.reset();
    const reply = await history(world, { tool: 'find', name: 'parse', at: world.ids[0], path: 'a.toy' });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.deepEqual(names(reply), ['parse']);
    const batches = world.recording.starts.filter((s) => subcommand(s) === 'cat-file');
    assert.equal(batches.length, 1, 'ONE cat-file batch');
    const lines = String(batches[0]?.stdin).split('\n').filter((l) => l !== '');
    const blobLines = lines.filter((l) => !l.endsWith('^{commit}'));
    assert.equal(blobLines.length, 1, JSON.stringify(lines));
    assert.ok(blobLines[0]?.endsWith(':a.toy'));

    const missing = await history(world, { tool: 'find', name: 'parse', at: world.ids[0], path: 'nope/x.toy' });
    assert.equal(missing.ok, true, JSON.stringify(missing.diagnostics));
    assert.deepEqual(names(missing), []);
    assert.ok(missing.hints?.some((h) => /not a source file of this commit/.test(h)), JSON.stringify(missing.hints));

    for (const bad of ['../x.toy', '/etc/passwd', 'a/../b.toy']) {
      const refused = await history(world, { tool: 'find', name: 'parse', at: world.ids[0], path: bad });
      assert.deepEqual(codes(refused), ['invalid_args'], bad);
    }
  });

  it('truncated: a whole-tree question over more claimed files than the cap parses the first ones in path order, says so, and is deterministic', async (t) => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${String(i)}.toy`, `fn name${String(i)} {\n}\n`]));
    const world = await threeCommits(t, { files, maxFiles: 3 });
    const host = world.host;
    const ask = (name: string): Promise<Envelope> =>
      host.handle({ protocol: 1, kind: 'history', args: { repo: world.repo.dir, tool: 'find', name, at: world.ids[0] } });

    const inside = await ask('name1');
    assert.equal(inside.ok, true, JSON.stringify(inside.diagnostics));
    assert.deepEqual(names(inside), ['name1']);
    assert.equal(inside.truncated, true);
    assert.deepEqual(codes(inside), ['history_truncated']);
    assert.equal(inside.diagnostics[0]?.severity, 'warning');
    assert.ok(inside.hints?.some((h) => /first 3 source files/.test(h)), JSON.stringify(inside.hints));

    const outside = await ask('name4');
    assert.deepEqual(names(outside), [], 'a file past the cap is not read');
    assert.deepEqual(await ask('name1'), inside, 'the same files are read each time');

    const narrowed = await host.handle({
      protocol: 1,
      kind: 'history',
      args: { repo: world.repo.dir, tool: 'find', name: 'name4', at: world.ids[0], path: 'f4.toy' },
    });
    assert.deepEqual(names(narrowed), ['name4']);
    assert.notEqual(narrowed.truncated, true);
  });

  it('commit_not_found: an unknown revision, and invalid_args for an option-like one; nothing is fetched and the git pins stay', async (t) => {
    const world = await threeCommits(t);
    world.recording.reset();
    const unknown = await history(world, { tool: 'find', name: 'parse', at: 'nosuchrevision' });
    assert.equal(unknown.ok, false);
    assert.deepEqual(codes(unknown), ['commit_not_found']);
    assert.match(unknown.diagnostics[0]?.message ?? '', /nosuchrevision/);
    const unknownId = await history(world, { tool: 'find', name: 'parse', at: 'f'.repeat(40) });
    assert.deepEqual(codes(unknownId), ['commit_not_found']);

    for (const dash of ['-x', '--output=/tmp/x', 'a\nb']) {
      const refused = await history(world, { tool: 'find', name: 'parse', at: dash });
      assert.deepEqual(codes(refused), ['invalid_args'], JSON.stringify(dash));
    }

    const subs = world.recording.starts.map((s) => subcommand(s));
    assert.ok(subs.every((s) => !['fetch', 'pull', 'clone', 'remote', 'ls-remote', 'push'].includes(s)), subs.join(','));
    for (const spec of world.recording.starts) {
      assert.equal(spec.env?.['GIT_NO_LAZY_FETCH'], '1');
      assert.equal(spec.env?.['GIT_ALLOW_PROTOCOL'], 'none');
    }
  });

  it('commit_not_found: an object removed from the clone is reported, not fetched', async (t) => {
    const world = await threeCommits(t);
    const tree = (await world.repo.git(['rev-parse', `${world.ids[0]}^{tree}`])).trim();
    const loose = path.join(world.repo.dir, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
    assert.ok(fs.existsSync(loose), 'the root tree of the first commit is a loose object');
    fs.chmodSync(loose, 0o600);
    fs.rmSync(loose);
    world.recording.reset();

    const reply = await history(world, { tool: 'find', name: 'parse', at: world.ids[0] });
    assert.equal(reply.ok, false);
    assert.deepEqual(codes(reply), ['commit_not_found']);
    assert.ok(world.recording.starts.every((s) => !s.args.some((a) => ['fetch', 'remote', 'ls-remote'].includes(a))));
    assert.deepEqual(fs.readdirSync(tmpRootOf(world)), []);
    const still = await history(world, { tool: 'find', name: 'parseInput', at: world.ids[1] });
    assert.deepEqual(names(still), ['parseInput'], 'later commits are unaffected');
  });

  it('idempotent: the same request twice returns equal envelopes, and the temporary directory is removed each time, also when Query refuses the arguments', async (t) => {
    const world = await threeCommits(t);
    const request = { tool: 'find', name: 'parse', at: world.ids[0] };
    const first = await history(world, request);
    assert.deepEqual(fs.readdirSync(tmpRootOf(world)), []);
    const second = await history(world, request);
    assert.deepEqual(fs.readdirSync(tmpRootOf(world)), []);
    assert.deepEqual(second, first);
    assert.equal(first.untrusted_text?.nonce, 'NONCE');

    // Query's own strict schema refuses `depth` for find: the store was built by then, and still goes away.
    const refused = await history(world, { ...request, depth: 1 });
    assert.equal(refused.ok, false);
    assert.deepEqual(codes(refused), ['invalid_args']);
    assert.deepEqual(fs.readdirSync(tmpRootOf(world)), []);
  });

  it('a history request issued while the leader is building is unaffected', async (t) => {
    const world = await threeCommits(t);
    const [built, asked] = await Promise.all([
      world.ask('build', { repo: world.repo.dir }),
      history(world, { tool: 'find', name: 'parse', at: world.ids[0] }),
    ]);
    assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
    assert.equal(asked.ok, true, JSON.stringify(asked.diagnostics));
    assert.deepEqual(names(asked), ['parse']);
  });

  it('a commit with no file a module claims, and a repository with no such file at all, give an empty result with a hint, not an error', async (t) => {
    const world = await makeWorld(t, { files: { 'README.md': '# only docs\n' }, host: { metrics: false } });
    const reply = await history(world, { tool: 'find', name: 'anything', at: 'HEAD' });
    assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
    assert.deepEqual(names(reply), []);
    assert.ok(reply.hints?.some((h) => /No source file of this commit is claimed/.test(h)), JSON.stringify(reply.hints));
  });

  it('refuses malformed requests with invalid_args and a path that is not a repository with not_a_repo', async (t) => {
    const world = await threeCommits(t);
    const refused: Array<Record<string, unknown>> = [
      { name: 'parse', at: 'HEAD' },
      { tool: 'find', at: 'HEAD' },
      { tool: 'find', name: 'parse' },
      { tool: 'delete', name: 'parse', at: 'HEAD' },
      { tool: 'find', name: 'parse', at: 'HEAD', fresh: ['a.toy'] },
      { tool: 'find', name: 'parse', at: 'HEAD', surprise: true },
    ];
    for (const args of refused) {
      const reply = await history(world, args);
      assert.equal(reply.ok, false, JSON.stringify(args));
      assert.deepEqual(codes(reply), ['invalid_args'], JSON.stringify(args));
    }
    const plain = fs.mkdtempSync(path.join(world.tmp.path, 'plain-'));
    const nowhere = await world.ask('history', { repo: plain, tool: 'find', name: 'x', at: 'HEAD' });
    assert.deepEqual(codes(nowhere), ['not_a_repo']);
    assert.deepEqual(fs.readdirSync(tmpRootOf(world)), []);
  });
});
