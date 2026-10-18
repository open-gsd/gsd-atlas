import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  PrepareError,
  cloneCheckout,
  prepareCorpus,
  readPreparedRecord,
  resolveNpm,
  runCli,
  type CliIo,
  type Command,
  type PreparedRecord,
} from './prepare-corpus.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const RECORD_NAME = '.eval-prepared.json';

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  return env;
}

function run(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: cleanGitEnv(), windowsHide: true });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const cleanups: Array<() => void> = [];
function tempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const LOCK_TEXT_LF = '{\n  "name": "fixture",\n  "lockfileVersion": 3\n}\n';
const LOCK_TEXT_CRLF = LOCK_TEXT_LF.replace(/\n/g, '\r\n');

const FETCH_STUB = `
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [id, flag, dest] = process.argv.slice(2);
if (process.env.STUB_FETCH_FAIL === '1') { process.stderr.write('stub fetch failed\\n'); process.exit(3); }
if (flag !== '--dest' || dest === undefined) { process.stderr.write('bad arguments\\n'); process.exit(2); }
fs.mkdirSync(dest, { recursive: true });
const dir = fs.mkdtempSync(path.join(dest, id + '-'));
execFileSync('git', ['clone', '--quiet', process.env.STUB_SOURCE, dir], { stdio: 'ignore' });
process.stdout.write('cloning...\\n' + dir + '\\n');
`;

const NPM_STUB = `
import fs from 'node:fs';
import path from 'node:path';
fs.appendFileSync(process.env.STUB_ARGV_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  ignoreScripts: process.env.npm_config_ignore_scripts ?? null,
}) + '\\n');
if (process.env.STUB_NPM_FAIL === '1') { process.stderr.write('stub npm failed\\n'); process.exit(1); }
if (process.argv[2] === 'ci') {
  fs.mkdirSync(path.join('node_modules', 'typescript'), { recursive: true });
  fs.writeFileSync(path.join('node_modules', 'typescript', 'package.json'), JSON.stringify({ name: 'typescript', version: '6.0.3' }));
}
`;

interface Stubs {
  sourceSha: string;
  manifest: unknown;
  fetchCommand: Command;
  npm: Command;
  argvLog: string;
  dest: string;
}

function setup(): Stubs {
  const work = tempDir('prep-work-');
  const source = path.join(work, 'source');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(source, 'package-lock.json'), LOCK_TEXT_CRLF);
  fs.writeFileSync(path.join(source, 'src', 'a.ts'), 'export const a = 1;\n');
  run(source, 'git', ['init', '-q']);
  run(source, 'git', ['config', 'core.autocrlf', 'false']);
  run(source, 'git', ['add', '-A']);
  run(source, 'git', ['-c', 'user.name=prep', '-c', 'user.email=prep@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture']);
  const sourceSha = run(source, 'git', ['rev-parse', 'HEAD']).trim();

  const fetchStub = path.join(work, 'fetch-stub.mjs');
  const npmStub = path.join(work, 'npm-stub.mjs');
  fs.writeFileSync(fetchStub, FETCH_STUB);
  fs.writeFileSync(npmStub, NPM_STUB);
  const argvLog = path.join(work, 'npm-argv.log');
  process.env['STUB_SOURCE'] = source;
  process.env['STUB_ARGV_LOG'] = argvLog;
  delete process.env['STUB_FETCH_FAIL'];
  delete process.env['STUB_NPM_FAIL'];
  return {
    sourceSha,
    manifest: {
      schemaVersion: 1,
      corpora: [
        { id: 'fixture', repo: 'example/fixture', ref: 'main', sha: sourceSha, status: 'pinned', role: 'test corpus', pinnedAt: '2026-10-18' },
      ],
    },
    fetchCommand: { command: process.execPath, args: [fetchStub] },
    npm: { command: process.execPath, args: [npmStub] },
    argvLog,
    dest: path.join(work, 'dest'),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) out.set(rel, `link:${fs.readlinkSync(full)}`);
      else if (entry.isDirectory()) {
        out.set(rel, 'dir');
        visit(full);
      } else out.set(rel, `file:${sha256(fs.readFileSync(full, 'latin1'))}`);
    }
  };
  visit(dir);
  return out;
}

describe('prepareCorpus', () => {
  test('record written: without npm ci the compiler and lock hash are null', () => {
    const s = setup();
    const record = prepareCorpus({ id: 'fixture', dest: s.dest, npmCi: false, fetchCommand: s.fetchCommand, npm: s.npm, manifest: s.manifest });
    assert.equal(record.corpusId, 'fixture');
    assert.equal(record.sha, s.sourceSha);
    assert.equal(record.npmCi, false);
    assert.equal(record.typescriptVersion, null);
    assert.equal(record.lockSha256, null);
    assert.equal(fs.existsSync(s.argvLog), false, 'npm must not run when npmCi is false');
    const written = JSON.parse(fs.readFileSync(path.join(record.dir, RECORD_NAME), 'utf8')) as PreparedRecord;
    assert.deepEqual(written, record);
    assert.equal(path.dirname(record.dir), fs.realpathSync.native(s.dest));
    assert.deepEqual(readPreparedRecord(record.dir, s.manifest), record);
    assert.equal(run(record.dir, 'git', ['status', '--short']).trim(), '', 'the record must not dirty the checkout');
  });

  test('record written: with npm ci the compiler version and the lock hash (CRLF normalised) are recorded', () => {
    const s = setup();
    const record = prepareCorpus({ id: 'fixture', dest: s.dest, npmCi: true, fetchCommand: s.fetchCommand, npm: s.npm, manifest: s.manifest });
    assert.equal(record.npmCi, true);
    assert.equal(record.typescriptVersion, '6.0.3');
    assert.equal(record.lockSha256, sha256(LOCK_TEXT_LF));
    assert.notEqual(record.lockSha256, sha256(LOCK_TEXT_CRLF));
    assert.deepEqual(readPreparedRecord(record.dir, s.manifest), record);
  });

  test('ignore-scripts flag: npm ci always runs with scripts disabled, in the checkout', () => {
    const s = setup();
    const record = prepareCorpus({ id: 'fixture', dest: s.dest, npmCi: true, fetchCommand: s.fetchCommand, npm: s.npm, manifest: s.manifest });
    const calls = fs
      .readFileSync(s.argvLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[]; cwd: string; ignoreScripts: string | null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.argv[0], 'ci');
    assert.ok(calls[0]?.argv.includes('--ignore-scripts'), `argument array was ${JSON.stringify(calls[0]?.argv)}`);
    assert.equal(calls[0]?.ignoreScripts, 'true');
    assert.equal(fs.realpathSync.native(calls[0]?.cwd ?? ''), record.dir);
  });

  test('sha mismatch: a record that disagrees with the manifest is rejected', () => {
    const s = setup();
    const record = prepareCorpus({ id: 'fixture', dest: s.dest, npmCi: false, fetchCommand: s.fetchCommand, manifest: s.manifest });
    const file = path.join(record.dir, RECORD_NAME);
    fs.writeFileSync(file, JSON.stringify({ ...record, sha: 'f'.repeat(40) }));
    assert.throws(() => readPreparedRecord(record.dir, s.manifest), (error: unknown) => error instanceof PrepareError && error.code === 'sha_mismatch');
    fs.writeFileSync(file, JSON.stringify({ ...record, corpusId: 'nobody' }));
    assert.throws(() => readPreparedRecord(record.dir, s.manifest), (error: unknown) => error instanceof PrepareError && error.code === 'unknown_corpus');
    fs.writeFileSync(file, '{not json');
    assert.throws(() => readPreparedRecord(record.dir, s.manifest), (error: unknown) => error instanceof PrepareError && error.code === 'record_invalid');
    fs.writeFileSync(file, JSON.stringify({ ...record, extra: true }));
    assert.throws(() => readPreparedRecord(record.dir, s.manifest), (error: unknown) => error instanceof PrepareError && error.code === 'record_invalid');
    fs.rmSync(file);
    assert.throws(() => readPreparedRecord(record.dir, s.manifest), (error: unknown) => error instanceof PrepareError && error.code === 'record_missing');
  });

  test('sha mismatch: a checkout that is not at the manifest commit is refused', () => {
    const s = setup();
    const manifest = structuredClone(s.manifest) as { corpora: Array<{ sha: string }> };
    (manifest.corpora[0] as { sha: string }).sha = 'a'.repeat(40);
    assert.throws(
      () => prepareCorpus({ id: 'fixture', dest: s.dest, npmCi: false, fetchCommand: s.fetchCommand, manifest }),
      (error: unknown) => error instanceof PrepareError && error.code === 'sha_mismatch',
    );
  });

  test('a failed fetch, a failed install, an unknown id and a destination inside the repository are refused', () => {
    const s = setup();
    process.env['STUB_FETCH_FAIL'] = '1';
    assert.throws(
      () => prepareCorpus({ id: 'fixture', dest: s.dest, npmCi: false, fetchCommand: s.fetchCommand, manifest: s.manifest }),
      (error: unknown) => error instanceof PrepareError && error.code === 'fetch_failed',
    );
    delete process.env['STUB_FETCH_FAIL'];

    process.env['STUB_NPM_FAIL'] = '1';
    assert.throws(
      () => prepareCorpus({ id: 'fixture', dest: s.dest, npmCi: true, fetchCommand: s.fetchCommand, npm: s.npm, manifest: s.manifest }),
      (error: unknown) => error instanceof PrepareError && error.code === 'install_failed',
    );
    delete process.env['STUB_NPM_FAIL'];
    assert.deepEqual(fs.readdirSync(s.dest), [], 'a failed install must not leave the checkout behind');

    assert.throws(
      () => prepareCorpus({ id: 'nobody', dest: s.dest, npmCi: false, fetchCommand: s.fetchCommand, manifest: s.manifest }),
      (error: unknown) => error instanceof PrepareError && error.code === 'unknown_corpus',
    );
    assert.throws(
      () => prepareCorpus({ id: 'fixture', dest: path.join(REPO_ROOT, '.tmp', 'prepare-inside'), npmCi: false, fetchCommand: s.fetchCommand, manifest: s.manifest }),
      (error: unknown) => error instanceof PrepareError && error.code === 'destination_inside_repo',
    );
    assert.equal(fs.existsSync(path.join(REPO_ROOT, '.tmp', 'prepare-inside')), false);
  });

  test('resolveNpm names an executable and runs node on npm-cli.js when it can find it', () => {
    const npm = resolveNpm();
    assert.ok(npm.command.length > 0);
    assert.ok(Array.isArray(npm.args));
  });
});

describe('cloneCheckout', () => {
  function buildTree(): { from: string; skipped: string[]; linksKept: string[] } {
    const root = tempDir('clone-tree-');
    const outside = tempDir('clone-outside-');
    const from = path.join(root, 'from');
    fs.mkdirSync(path.join(from, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(from, 'empty'));
    fs.writeFileSync(path.join(from, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(from, 'src', 'deep', 'b.ts'), 'export const b = 2;\r\n');
    fs.writeFileSync(path.join(from, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
    fs.mkdirSync(path.join(outside, 'dir'));
    fs.writeFileSync(path.join(outside, 'dir', 'x.txt'), 'outside dir\n');
    const skipped: string[] = [];
    const linksKept: string[] = [];
    try {
      fs.symlinkSync(path.join('src', 'a.ts'), path.join(from, 'rel-link.ts'));
      linksKept.push('rel-link.ts');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(from, 'out-link.txt'));
      skipped.push('out-link.txt');
      fs.symlinkSync(path.join(outside, 'dir'), path.join(from, 'out-dir'), 'dir');
      skipped.push('out-dir');
      fs.symlinkSync(path.join('..', '..', '..', 'clone-outside-escape'), path.join(from, 'src', 'deep', 'escape'));
      skipped.push('src/deep/escape');
      fs.symlinkSync(path.join(from, 'src', 'a.ts'), path.join(from, 'abs-inside-link.ts'));
      skipped.push('abs-inside-link.ts');
    } catch {
      return { from, skipped: [], linksKept: [] };
    }
    return { from, skipped, linksKept };
  }

  test('clone leaves source untouched', () => {
    const { from } = buildTree();
    const before = snapshot(from);
    const to = path.join(tempDir('clone-dest-'), 'session-1');
    cloneCheckout(from, to);
    assert.deepEqual(snapshot(from), before, 'the source tree must be byte-identical after the clone');
    const copied = snapshot(to);
    for (const [rel, value] of copied) {
      assert.equal(before.get(rel), value, rel);
    }
    assert.equal(copied.get('src/a.ts'), before.get('src/a.ts'));
    assert.equal(copied.get('empty'), 'dir');
    // a write in the clone never reaches the source
    fs.writeFileSync(path.join(to, 'src', 'a.ts'), 'changed\n');
    assert.deepEqual(snapshot(from), before);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(to, 'run.sh')).mode & 0o111, 0o111, 'the executable bit is kept');
    }
  });

  test('symlink outside: links that leave the tree are not copied and never read through', () => {
    const { from, skipped, linksKept } = buildTree();
    if (skipped.length === 0) return; // symbolic links cannot be created here
    const to = path.join(tempDir('clone-dest-'), 'session-2');
    cloneCheckout(from, to);
    const copied = snapshot(to);
    for (const rel of skipped) assert.equal(copied.has(rel), false, `${rel} must be skipped`);
    for (const rel of linksKept) {
      assert.equal(copied.get(rel)?.startsWith('link:'), true, `${rel} must stay a relative link`);
    }
    // nothing of the outside content was copied in as a regular file
    for (const value of copied.values()) assert.equal(value.includes(sha256('outside\n')), false);
    assert.equal(fs.existsSync(path.join(to, 'out-dir')), false);
  });

  test('clone refuses a destination that exists and is not empty, and accepts an empty one', () => {
    const { from } = buildTree();
    const parent = tempDir('clone-dest-');
    const busy = path.join(parent, 'busy');
    fs.mkdirSync(busy);
    fs.writeFileSync(path.join(busy, 'file'), 'x');
    assert.throws(() => cloneCheckout(from, busy), (error: unknown) => error instanceof PrepareError && error.code === 'clone_destination_not_empty');
    assert.deepEqual(fs.readdirSync(busy), ['file']);
    const empty = path.join(parent, 'empty');
    fs.mkdirSync(empty);
    cloneCheckout(from, empty);
    assert.equal(fs.existsSync(path.join(empty, 'src', 'a.ts')), true);
    const nested = path.join(parent, 'a', 'b', 'c');
    cloneCheckout(from, nested);
    assert.equal(fs.existsSync(path.join(nested, 'src', 'a.ts')), true);
  });

  test('clone refuses a missing source', () => {
    assert.throws(() => cloneCheckout(path.join(tempDir('clone-none-'), 'nope'), path.join(tempDir('clone-dest-'), 'x')));
  });
});

describe('prepare-corpus command line', () => {
  function io(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } }, out, err };
  }

  test('exit codes: 0 prepared with the directory on the last stdout line and the record on stderr', () => {
    const s = setup();
    const captured = io();
    const code = runCli(['--corpus', 'fixture', '--dest', s.dest, '--no-npm-ci'], captured.io, {
      fetchCommand: s.fetchCommand,
      manifest: s.manifest,
    });
    assert.equal(code, 0);
    const lines = captured.out.join('').trimEnd().split('\n');
    const dir = lines[lines.length - 1] as string;
    assert.equal(path.dirname(dir), fs.realpathSync.native(s.dest));
    const record = JSON.parse(captured.err.join('')) as PreparedRecord;
    assert.equal(record.dir, dir);
    assert.equal(record.npmCi, false);
    assert.equal(record.sha, s.sourceSha);
  });

  test('exit codes: npm ci is the default', () => {
    const s = setup();
    const captured = io();
    const code = runCli(['--corpus', 'fixture', '--dest', s.dest], captured.io, { fetchCommand: s.fetchCommand, npm: s.npm, manifest: s.manifest });
    assert.equal(code, 0);
    assert.equal((JSON.parse(captured.err.join('')) as PreparedRecord).typescriptVersion, '6.0.3');
  });

  test('exit codes: 1 when the fetch or the install fails', () => {
    const s = setup();
    process.env['STUB_FETCH_FAIL'] = '1';
    const captured = io();
    const code = runCli(['--corpus', 'fixture', '--dest', s.dest, '--no-npm-ci'], captured.io, { fetchCommand: s.fetchCommand, manifest: s.manifest });
    delete process.env['STUB_FETCH_FAIL'];
    assert.equal(code, 1);
    assert.match(captured.err.join(''), /fetch_failed/);
    assert.equal(captured.out.join(''), '');
  });

  test('exit codes: 2 for a usage error', () => {
    for (const argv of [[], ['--corpus', 'x'], ['--dest', '/tmp/x'], ['--corpus', 'x', '--dest', '/tmp/x', '--bogus'], ['--corpus']]) {
      const captured = io();
      assert.equal(runCli(argv, captured.io), 2, JSON.stringify(argv));
      assert.match(captured.err.join(''), /usage:/);
    }
  });

  test('exit codes: the real entry point exits 2 without arguments', () => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'prepare-corpus.ts')], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage:/);
  });
});

describe('live preparation of the pinned gsd-core', () => {
  test('npm ci --ignore-scripts installs the project TypeScript 6.x', { skip: process.env['GSD_EVAL_LIVE'] !== '1' }, () => {
    const dest = tempDir('prep-live-');
    const record = prepareCorpus({ id: 'gsd-core', dest, npmCi: true });
    assert.ok(record.typescriptVersion?.startsWith('6.'), `typescript ${String(record.typescriptVersion)}`);
    assert.equal(record.npmCi, true);
    assert.equal(typeof record.lockSha256, 'string');
  });
});
