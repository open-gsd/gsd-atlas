/**
 * ROADMAP success criterion 4 / command-runner ADR decision 4: a hostile repository runs nothing.
 *
 * The poisoned repository carries a clean/smudge filter driver (via `.gitattributes`), a `core.fsmonitor`
 * command and a `core.hooksPath` folder of hooks, each of which writes a marker file OUTSIDE the repo.
 * A positive control first proves the poison fires when git runs unprotected on this platform; then the
 * Source Tree snapshot runs under the built-in `decide` and the markers must not exist. Further groups
 * cover filter driver names that are unusual: ones the environment channel cannot carry must fail the
 * snapshot closed (CR-01), and valid unusual ones must still snapshot (no over-refusal).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { createFakeSourceTree, createSourceTree } from '../source-tree/index.ts';
import { createTempGitRepo } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { GitConfigError, allowAll, createRealRunner, createRecordingRunner, gitSpec } from './index.ts';
import type { RecordedSpec } from './index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const setup = createRealRunner({ decide: allowAll });

const slash = (p: string): string => p.replaceAll('\\', '/');
const blobId = (content: string): string => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};
const subcommand = (spec: { readonly args: readonly string[] }): string | undefined => {
  const a = spec.args;
  let i = 0;
  while (a[i] === '-C' || a[i] === '-c') i += 2;
  return a[i];
};

const FILES: Record<string, string> = {
  '.gitattributes': '* filter=evil\n',
  'a.txt': 'alpha\n',
  'dir/b.ts': 'export const b = 1;\n',
};

interface Poisoned {
  readonly repo: TempGitRepo;
  /** Written by the filter driver. */
  readonly m1: string;
  /** Written by core.fsmonitor. */
  readonly m2: string;
  /** Written by a hook in core.hooksPath. */
  readonly m3: string;
}

/**
 * A repository whose own config tries to run code. The commit is made BEFORE the poison is configured, so
 * building the fixture itself runs nothing. Markers and scripts live next to the repo, not in it.
 */
async function poisonedRepo(t: { after(fn: () => void): void }, extraFiles: Record<string, string> = {}): Promise<Poisoned> {
  const repo = await createTempGitRepo({ runner: setup, files: { ...FILES, ...extraFiles } });
  t.after(() => repo.cleanup());
  const base = path.dirname(repo.dir);
  const m1 = path.join(base, 'M1');
  const m2 = path.join(base, 'M2');
  const m3 = path.join(base, 'M3');

  const touch = path.join(base, 'touch.cjs');
  fs.writeFileSync(touch, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");
  const filter = path.join(base, 'filter.cjs');
  fs.writeFileSync(filter, "require('node:fs').writeFileSync(process.argv[2], 'ran');\nprocess.stdin.pipe(process.stdout);\n");
  const command = (script: string, marker: string): string => `'${slash(process.execPath)}' '${slash(script)}' '${slash(marker)}'`;

  const hooks = path.join(base, 'hooks');
  fs.mkdirSync(hooks);
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction']) {
    const file = path.join(hooks, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec ${command(touch, m3)}\n`);
    fs.chmodSync(file, 0o755);
  }

  await repo.setConfig('filter.evil.clean', command(filter, m1));
  await repo.setConfig('filter.evil.smudge', command(filter, m1));
  await repo.setConfig('core.fsmonitor', command(touch, m2));
  await repo.setConfig('core.hooksPath', slash(hooks));
  repo.write('untracked.txt', 'not committed\n');
  return { repo, m1, m2, m3 };
}

const exists = (p: string): boolean => fs.existsSync(p);

interface Promisor {
  readonly repo: TempGitRepo;
  /** Written by core.sshCommand, which a lazy fetch of a missing promisor object would start. */
  readonly m4: string;
  /** The blob of kept.txt, deleted from the object database after the config is poisoned. */
  readonly blob: string;
}

/** A well-formed object id that is in no object database (the fixture repository is SHA-1). */
const UNKNOWN_ID = '1234567890abcdef1234567890abcdef12345678';

/**
 * A repository that declares a promisor remote and a `core.sshCommand` (verification gap CR-01). When an
 * object is missing locally git lazily fetches it from the promisor remote by starting the transport the
 * repository configures; here that transport is a marker-writing command outside the repo. The commit is
 * made BEFORE the poison is configured, then the loose blob of kept.txt is deleted so that `HEAD:kept.txt`
 * names an object that is absent locally, which is how a partial clone looks.
 */
async function promisorRepo(t: { after(fn: () => void): void }): Promise<Promisor> {
  const repo = await createTempGitRepo({ runner: setup, files: { 'kept.txt': 'kept\n' } });
  t.after(() => repo.cleanup());
  const base = path.dirname(repo.dir);
  const m4 = path.join(base, 'M4');
  const touch = path.join(base, 'touch4.cjs');
  fs.writeFileSync(touch, "require('node:fs').writeFileSync(process.argv[2], 'ran');\n");

  await repo.setConfig('core.repositoryformatversion', '1');
  await repo.setConfig('extensions.partialClone', 'origin');
  await repo.setConfig('remote.origin.promisor', 'true');
  await repo.setConfig('remote.origin.url', 'ssh://example.invalid/x.git');
  await repo.setConfig('core.sshCommand', `'${slash(process.execPath)}' '${slash(touch)}' '${slash(m4)}'`);

  const blob = blobId('kept\n');
  const loose = path.join(repo.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  assert.ok(exists(loose), 'the fixture blob must be a loose object');
  fs.chmodSync(loose, 0o644);
  fs.rmSync(loose);
  return { repo, m4, blob };
}

describe('hostile repository: promisor remote with core.sshCommand (CR-01, T-01-43)', () => {
  it('positive control: hasObject on an unknown id starts the repo-configured transport when git runs unprotected', async (t) => {
    const p = await promisorRepo(t);
    await setup.run({ executable: 'git', args: ['-C', p.repo.dir, 'cat-file', '-e', UNKNOWN_ID], env: p.repo.envOverlay });
    if (!exists(p.m4)) t.skip('poison did not fire unprotected on this platform: hasObject trigger (cat-file -e <unknown id>)');
  });

  it('positive control: read of a locally absent blob starts the repo-configured transport when git runs unprotected', async (t) => {
    const p = await promisorRepo(t);
    await setup.run({ executable: 'git', args: ['-C', p.repo.dir, 'cat-file', 'blob', 'HEAD:kept.txt'], env: p.repo.envOverlay });
    if (!exists(p.m4)) t.skip('poison did not fire unprotected on this platform: read trigger (cat-file blob HEAD:kept.txt)');
  });

  it('hasObject and read through the default decide start no transport, only built-in git specs', async (t) => {
    const p = await promisorRepo(t);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

    assert.equal(await tree.hasObject(UNKNOWN_ID), false);
    assert.equal(exists(p.m4), false, 'core.sshCommand ran during hasObject (lazy fetch of a missing object)');

    // The answer for an absent blob is not asserted (null or a git_failed error are both acceptable);
    // what matters is that nothing outside git was started.
    await tree.read('HEAD', 'kept.txt').catch(() => null);
    assert.equal(exists(p.m4), false, 'core.sshCommand ran during read (lazy fetch of a missing blob)');

    assert.equal(recording.denials.length, 0);
    assert.ok(recording.starts.length >= 2);
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'), 'a start was not a built-in git spec');
    assert.deepEqual(recording.starts.map(subcommand), ['cat-file', 'cat-file']);
  });
});

/** Driver names a `-c filter.<name>.clean=` pair cannot express (CR-02, T-01-46): git splits `-c` at the first `=`. */
const ODD_DRIVERS: ReadonlyArray<{ readonly name: string; readonly file: string; readonly marker: string }> = [
  { name: 'a=b', file: 'eq.txt', marker: 'M5' },
  { name: 'a=b=c', file: 'eq2.txt', marker: 'M6' },
  { name: 'my.driver', file: 'dot.txt', marker: 'M7' },
  { name: '', file: 'empty.txt', marker: 'M8' },
];

interface OddDrivers {
  readonly repo: TempGitRepo;
  readonly markers: ReadonlyMap<string, string>;
}

/** The commit is made BEFORE the drivers are configured, so building the fixture runs nothing. */
async function oddDriverRepo(t: { after(fn: () => void): void }): Promise<OddDrivers> {
  const attributes = ODD_DRIVERS.map((d) => `${d.file} filter=${d.name}\n`).join('');
  const files = Object.fromEntries(ODD_DRIVERS.map((d) => [d.file, `content of ${d.file}\n`]));
  const repo = await createTempGitRepo({ runner: setup, files: { '.gitattributes': attributes, ...files } });
  t.after(() => repo.cleanup());
  const base = path.dirname(repo.dir);
  const filter = path.join(base, 'filter-odd.cjs');
  fs.writeFileSync(filter, "require('node:fs').writeFileSync(process.argv[2], 'ran');\nprocess.stdin.pipe(process.stdout);\n");
  const markers = new Map<string, string>();
  for (const d of ODD_DRIVERS) {
    const marker = path.join(base, d.marker);
    markers.set(d.name, marker);
    await repo.setConfig(`filter.${d.name}.clean`, `'${slash(process.execPath)}' '${slash(filter)}' '${slash(marker)}'`);
  }
  return { repo, markers };
}

describe('hostile repository: filter driver names that a -c pair cannot express (CR-02, T-01-46)', () => {
  it('positive control: each odd-named driver fires when git hashes its file unprotected', async (t) => {
    const p = await oddDriverRepo(t);
    await setup.run({
      executable: 'git',
      args: ['-C', p.repo.dir, 'hash-object', '--stdin-paths'],
      env: p.repo.envOverlay,
      stdin: ODD_DRIVERS.map((d) => `${d.file}\n`).join(''),
    });
    const silent = ODD_DRIVERS.filter((d) => !exists(p.markers.get(d.name) as string));
    if (silent.length > 0) {
      t.skip(`poison did not fire unprotected on this platform: ${silent.map((d) => JSON.stringify(d.name)).join(', ')}`);
    }
  });

  it('a snapshot through the default decide runs none of them and hashes the plain content', async (t) => {
    const p = await oddDriverRepo(t);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

    const { files, diagnostics } = await tree.snapshot(p.repo.dir);

    for (const d of ODD_DRIVERS) {
      assert.equal(exists(p.markers.get(d.name) as string), false, `the filter driver ${JSON.stringify(d.name)} ran`);
      assert.equal(files.get(d.file), blobId(`content of ${d.file}\n`), d.file);
    }
    assert.deepEqual(diagnostics, []);
    assert.equal(recording.denials.length, 0);
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'), 'a start was not a built-in git spec');
    assert.equal(recording.starts.filter((s) => subcommand(s) === 'hash-object').length, 1);
  });
});

/** One driver in a raw-config fixture: its name as bytes, the data file that references it (if any) and its marker. */
interface RawDriver {
  readonly label: string;
  readonly name: Buffer;
  /** The committed data file `.gitattributes` points at the driver; `null` for a driver that is only configured. */
  readonly file: string | null;
  readonly marker: string;
}

interface RawDrivers {
  readonly repo: TempGitRepo;
  readonly markers: ReadonlyMap<string, string>;
}

const bytes = (...b: number[]): Buffer => Buffer.from(b);
const text = (s: string): Buffer => Buffer.from(s, 'utf8');

/**
 * A repository whose filter driver names are raw bytes (CR-01, T-01-50). The data files are committed first,
 * `.gitattributes` is written as bytes (a file name, a space, `filter=`, the raw name, LF) and committed, and
 * only THEN is one `[filter "<raw name>"]` section appended to `.git/config` per driver, so building the
 * fixture runs nothing. Each driver's `clean` command writes its marker outside the repo.
 */
async function rawDriverRepo(t: { after(fn: () => void): void }, drivers: readonly RawDriver[]): Promise<RawDrivers> {
  const files = Object.fromEntries(drivers.flatMap((d) => (d.file === null ? [] : [[d.file, `content of ${d.file}\n`] as const])));
  const repo = await createTempGitRepo({ runner: setup, files });
  t.after(() => repo.cleanup());
  const base = path.dirname(repo.dir);
  const filter = path.join(base, 'filter-raw.cjs');
  fs.writeFileSync(filter, "require('node:fs').writeFileSync(process.argv[2], 'ran');\nprocess.stdin.pipe(process.stdout);\n");

  repo.write(
    '.gitattributes',
    Buffer.concat(drivers.flatMap((d) => (d.file === null ? [] : [text(`${d.file} filter=`), d.name, text('\n')]))),
  );
  await repo.commitAll('attributes');

  const markers = new Map<string, string>();
  const sections: Buffer[] = [];
  for (const d of drivers) {
    const marker = path.join(base, d.marker);
    markers.set(d.label, marker);
    sections.push(text('[filter "'), d.name, text(`"]\n\tclean = "'${slash(process.execPath)}' '${slash(filter)}' '${slash(marker)}'"\n`));
  }
  fs.appendFileSync(path.join(repo.dir, '.git', 'config'), Buffer.concat(sections));
  return { repo, markers };
}

/** The unprotected hash-object call that fires every referenced driver; returns the labels whose marker is absent. */
async function silentDrivers(p: RawDrivers, drivers: readonly RawDriver[]): Promise<string[]> {
  const referenced = drivers.filter((d) => d.file !== null);
  await setup.run({
    executable: 'git',
    args: ['-C', p.repo.dir, 'hash-object', '--stdin-paths'],
    env: p.repo.envOverlay,
    stdin: referenced.map((d) => `${d.file}\n`).join(''),
  });
  return referenced.filter((d) => !exists(p.markers.get(d.label) as string)).map((d) => d.label);
}

/** Driver names the environment channel cannot carry byte for byte, each referenceable from `.gitattributes`. */
const UNREPRESENTABLE: readonly RawDriver[] = [
  { label: 'a lone 0xFF byte', name: bytes(0x61, 0xff, 0x62), file: 'ff.txt', marker: 'M9' },
  { label: 'an invalid continuation 0xC3 0x28', name: bytes(0x61, 0xc3, 0x28, 0x62), file: 'c328.txt', marker: 'M10' },
  { label: 'an encoded surrogate 0xED 0xA0 0x80', name: bytes(0x61, 0xed, 0xa0, 0x80, 0x62), file: 'eda080.txt', marker: 'M11' },
  { label: 'a genuine U+FFFD', name: bytes(0x61, 0xef, 0xbf, 0xbd, 0x62), file: 'fffd.txt', marker: 'M12' },
  { label: 'a 1025 code unit name', name: text('x'.repeat(1025)), file: 'long1025.txt', marker: 'M13' },
];

describe('hostile repository: filter driver names the environment channel cannot carry (CR-01, T-01-50)', () => {
  it('positive control: each of these drivers fires when git hashes its file unprotected', async (t) => {
    const p = await rawDriverRepo(t, UNREPRESENTABLE);
    const silent = await silentDrivers(p, UNREPRESENTABLE);
    if (silent.length > 0) t.skip(`poison did not fire unprotected on this platform: ${silent.join(', ')}`);
  });

  for (const driver of UNREPRESENTABLE) {
    it(`a snapshot is refused with filter_enumeration_failed for ${driver.label}, and its clean command never runs`, async (t) => {
      const p = await rawDriverRepo(t, [driver]);
      const recording = createRecordingRunner({ delegate: createRealRunner() });
      const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

      await assert.rejects(() => tree.snapshot(p.repo.dir), (error: unknown) => {
        assert.ok(error instanceof GitConfigError, String(error));
        assert.equal(error.code, 'filter_enumeration_failed');
        return true;
      });

      assert.equal(exists(p.markers.get(driver.label) as string), false, `the driver with ${driver.label} ran`);
      assert.deepEqual(recording.starts.map(subcommand), ['config']);
      assert.equal(recording.denials.length, 0);
      assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'), 'a start was not a built-in git spec');
    });
  }

  // No positive control: an attribute value ends at whitespace, so a driver named with a CR cannot be
  // referenced from .gitattributes (an unprotected hash-object over `filter=a<CR>b` ran nothing, verified on
  // git 2.54.0). The case pins the failure type: a typed enumeration error, not a denial at the hash step.
  it('a driver named with a carriage return is refused with the typed enumeration error, not a denial at the hash step', async (t) => {
    const drivers: readonly RawDriver[] = [
      { label: 'a CR name', name: text('a\rb'), file: null, marker: 'M17' },
      { label: 'a plain name', name: text('plain'), file: 'plain.txt', marker: 'M18' },
    ];
    const p = await rawDriverRepo(t, drivers);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

    await assert.rejects(() => tree.snapshot(p.repo.dir), (error: unknown) => {
      assert.ok(error instanceof GitConfigError, String(error));
      assert.equal(error.code, 'filter_enumeration_failed');
      assert.match(error.message, /carriage return/);
      return true;
    });

    assert.deepEqual(recording.starts.map(subcommand), ['config']);
    assert.equal(recording.denials.length, 0);
    assert.equal(exists(p.markers.get('a plain name') as string), false);
  });
});

/** Driver names that are unusual but that the environment channel carries byte for byte. */
const REPRESENTABLE: readonly RawDriver[] = [
  { label: 'a non-ASCII letter', name: text('café'), file: 'cafe.txt', marker: 'M14' },
  { label: 'an emoji', name: text('\u{1F600}'), file: 'emoji.txt', marker: 'M15' },
  { label: 'exactly 1024 code units', name: text('x'.repeat(1024)), file: 'long1024.txt', marker: 'M16' },
  { label: 'a tab', name: text('a\tb'), file: null, marker: 'M19' },
  { label: 'a leading space', name: text(' lead'), file: null, marker: 'M20' },
  { label: 'a trailing space', name: text('trail '), file: null, marker: 'M21' },
];

describe('hostile repository: unusual but representable filter driver names still snapshot (no over-refusal)', () => {
  it('positive control: the referenced drivers fire when git hashes their files unprotected', async (t) => {
    const p = await rawDriverRepo(t, REPRESENTABLE);
    const silent = await silentDrivers(p, REPRESENTABLE);
    if (silent.length > 0) t.skip(`poison did not fire unprotected on this platform: ${silent.join(', ')}`);
  });

  it('a snapshot through the default decide neutralises all of them, hashes the plain content and starts one hash-object', async (t) => {
    const p = await rawDriverRepo(t, REPRESENTABLE);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

    const { files, diagnostics } = await tree.snapshot(p.repo.dir);

    for (const d of REPRESENTABLE) {
      assert.equal(exists(p.markers.get(d.label) as string), false, `the driver with ${d.label} ran`);
      if (d.file !== null) assert.equal(files.get(d.file), blobId(`content of ${d.file}\n`), d.file);
    }
    assert.deepEqual(diagnostics, []);
    assert.equal(recording.denials.length, 0);
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'), 'a start was not a built-in git spec');
    assert.equal(recording.starts.filter((s) => subcommand(s) === 'hash-object').length, 1);
  });
});

describe('hostile repository (ROADMAP SC4)', () => {
  it('positive control: the poison fires when git runs unprotected', async (t) => {
    const p = await poisonedRepo(t);
    const dir = p.repo.dir;
    const env = p.repo.envOverlay;
    await setup.run({ executable: 'git', args: ['-C', dir, 'ls-files', '-o', '--exclude-standard'], env });
    await setup.run({ executable: 'git', args: ['-C', dir, 'hash-object', '--stdin-paths'], env, stdin: 'a.txt\n' });
    await setup.run({ executable: 'git', args: ['-C', dir, 'commit', '--quiet', '--allow-empty', '-m', 'control'], env });
    const silent = [
      ['M1 (filter driver)', p.m1],
      ['M2 (core.fsmonitor)', p.m2],
      ['M3 (core.hooksPath)', p.m3],
    ].filter(([, marker]) => !exists(marker as string));
    if (silent.length > 0) {
      t.skip(`poison did not fire unprotected on this platform: ${silent.map(([name]) => name).join(', ')}`);
    }
  });

  it('a snapshot through the default decide runs none of it, starting only built-in git specs', async (t) => {
    const p = await poisonedRepo(t);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });

    const { files, diagnostics } = await tree.snapshot(p.repo.dir);

    assert.equal(exists(p.m1), false, 'the filter driver ran');
    assert.equal(exists(p.m2), false, 'core.fsmonitor ran');
    assert.equal(exists(p.m3), false, 'a core.hooksPath hook ran');

    assert.deepEqual(diagnostics, []);
    assert.deepEqual([...files.keys()].sort(), ['.gitattributes', 'a.txt', 'dir/b.ts', 'untracked.txt']);
    // The neutralised filter did not transform anything: ids are those of the plain content.
    assert.equal(files.get('a.txt'), blobId('alpha\n'));

    assert.equal(recording.denials.length, 0);
    assert.ok(recording.starts.length > 0);
    assert.ok(recording.starts.every((s) => s.executable === 'git' && s.builtinId === 'git'), 'a start was not a built-in git spec');
    assert.deepEqual(recording.starts.map(subcommand).sort(), ['config', 'hash-object', 'ls-files', 'ls-files']);
    const hashes = recording.starts.filter((s) => subcommand(s) === 'hash-object');
    assert.equal(hashes.length, 1);
    const stdin = (hashes[0] as RecordedSpec).stdin;
    assert.equal(typeof stdin, 'string');
    assert.equal(String(stdin).split('\n').filter((l) => l !== '').length, files.size);
  });

  it('still yields exactly one hash-object start for a repository with 150 files', async (t) => {
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`src/f${i}.txt`, `file ${i}\n`]));
    const p = await poisonedRepo(t, many);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const tree = createSourceTree({ runner: recording, repoDir: p.repo.dir, envOverlay: p.repo.envOverlay });
    const { files } = await tree.snapshot(p.repo.dir);
    assert.equal(files.size, 150 + 4);
    assert.equal(recording.starts.filter((s) => subcommand(s) === 'hash-object').length, 1);
    assert.equal(exists(p.m1) || exists(p.m2) || exists(p.m3), false);
  });

  it('denies a spec built for git status and starts nothing', async (t) => {
    const p = await poisonedRepo(t);
    const recording = createRecordingRunner({ delegate: createRealRunner() });
    const result = await recording.run(gitSpec(['status', '--porcelain'], { worktree: p.repo.dir, filterNames: ['evil'], env: p.repo.envOverlay }));
    assert.ok(result.denied !== undefined);
    assert.equal(result.ok, false);
    assert.equal(recording.starts.length, 0);
    assert.equal(recording.denials.length, 1);
    assert.equal(exists(p.m1) || exists(p.m2) || exists(p.m3), false);
  });

  it('the fake Source Tree starts nothing at all', async () => {
    const tree = createFakeSourceTree({ committed: { 'a.txt': 'alpha\n' }, working: {}, ignored: [] });
    const { files } = await tree.snapshot('/anywhere');
    assert.deepEqual([...files], [['a.txt', blobId('alpha\n')]]);
  });

  it('no module outside src/command-runner can start a process (lintFiles over src reports no boundary violations)', async () => {
    const eslint = new ESLint({ cwd: root });
    const results = await eslint.lintFiles(['src/**/*.ts']);
    const boundary = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax')
        .map((m) => `${path.relative(root, r.filePath)}:${m.line} ${m.ruleId}: ${m.message}`),
    );
    assert.ok(results.length > 50, 'lintFiles must actually cover src');
    assert.deepEqual(boundary, []);
    const fatal = results.flatMap((r) => r.messages.filter((m) => m.fatal));
    assert.deepEqual(fatal, []);
  });
});
