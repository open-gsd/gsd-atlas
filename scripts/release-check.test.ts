import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHANNELS,
  PACKED_SIZE_CAP_BYTES,
  channelOf,
  checkChangelog,
  checkManifest,
  checkPack,
  checkShebang,
  checkToolVersions,
  checkVersion,
  compareVersions,
  distTagFor,
  scanText,
} from './release-check.ts';
import type { PackInfo, PackageManifest } from './release-check.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'release-check.ts');

const goodManifest = (): PackageManifest => ({
  name: '@opengsd/gsd-atlas',
  version: '0.1.0-alpha.0',
  description: 'A local map of a codebase.',
  license: 'MIT',
  type: 'module',
  engines: { node: '>=24.16.0' },
  bin: { 'gsd-atlas': 'dist/bin/gsd-atlas.js', 'gsd-atlas-mcp': 'dist/bin/gsd-atlas-mcp.js' },
  files: ['dist', 'schemas', 'modules', 'skills', 'diagnostics'],
  keywords: ['mcp'],
  repository: { type: 'git', url: 'git+https://github.com/open-gsd/gsd-atlas.git' },
  bugs: { url: 'https://github.com/open-gsd/gsd-atlas/issues' },
  homepage: 'https://github.com/open-gsd/gsd-atlas#readme',
  publishConfig: { access: 'public', provenance: true },
});

const goodPack = (): PackInfo => ({
  name: '@opengsd/gsd-atlas',
  version: '0.1.0-alpha.0',
  size: 800_000,
  unpackedSize: 4_000_000,
  files: [
    { path: 'package.json', size: 2000, mode: 420 },
    { path: 'README.md', size: 3000, mode: 420 },
    { path: 'LICENSE', size: 1000, mode: 420 },
    { path: 'CHANGELOG.md', size: 1000, mode: 420 },
    { path: 'dist/bin/gsd-atlas.js', size: 500, mode: 493 },
    { path: 'dist/bin/gsd-atlas-mcp.js', size: 500, mode: 493 },
    { path: 'dist/cli/main.js', size: 500, mode: 420 },
    { path: 'dist/cli/main.d.ts', size: 50, mode: 420 },
    { path: 'schemas/atlas-lang.schema.json', size: 500, mode: 420 },
    { path: 'modules/typescript/grammar.wasm', size: 1_000_000, mode: 420 },
    { path: 'modules/javascript/grammar.wasm', size: 1_000_000, mode: 420 },
    { path: 'skills/gsd-atlas/SKILL.md', size: 500, mode: 420 },
    { path: 'diagnostics/catalog.v1.json', size: 500, mode: 420 },
  ],
});

const withFiles = (extra: PackInfo['files']): PackInfo => ({ ...goodPack(), files: [...goodPack().files, ...extra] });
const without = (name: string): PackInfo => ({ ...goodPack(), files: goodPack().files.filter((file) => file.path !== name) });

// ---------------------------------------------------------------- channels and versions

test('channels are alpha, next and latest, and the npm dist-tag is the channel', () => {
  assert.deepEqual([...CHANNELS], ['alpha', 'next', 'latest']);
  for (const channel of CHANNELS) assert.equal(distTagFor(channel), channel);
});

test('channelOf: the channel a version belongs to', () => {
  assert.equal(channelOf('0.1.0-alpha.0'), 'alpha');
  assert.equal(channelOf('1.2.3-alpha.12'), 'alpha');
  assert.equal(channelOf('0.2.0-next.3'), 'next');
  assert.equal(channelOf('0.2.0-rc.1'), 'next');
  assert.equal(channelOf('1.0.0'), 'latest');
  assert.equal(channelOf('1.0.0-beta.1'), undefined);
  assert.equal(channelOf('not a version'), undefined);
});

test('checkVersion: alpha accepts X.Y.Z-alpha.N only', () => {
  assert.deepEqual(checkVersion('alpha', '0.1.0-alpha.0'), []);
  assert.deepEqual(checkVersion('alpha', '1.4.2-alpha.17'), []);
  for (const bad of ['0.1.0', '0.1.0-next.1', '0.1.0-rc.1', '0.1.0-alpha', '0.1.0-alpha.01', '0.1.0-alpha.1.2', '0.1.0-alpha.0+build.5', 'v0.1.0-alpha.0', '0.0.0']) {
    assert.notDeepEqual(checkVersion('alpha', bad), [], `${bad} must not be accepted on alpha`);
  }
});

test('checkVersion: next accepts X.Y.Z-next.N and X.Y.Z-rc.N', () => {
  assert.deepEqual(checkVersion('next', '0.2.0-next.0'), []);
  assert.deepEqual(checkVersion('next', '0.2.0-rc.4'), []);
  for (const bad of ['0.2.0', '0.2.0-alpha.1', '0.2.0-next', '0.2.0-rc', '0.2.0-beta.1']) {
    assert.notDeepEqual(checkVersion('next', bad), [], `${bad} must not be accepted on next`);
  }
});

test('checkVersion: latest accepts a version with no prerelease and rejects every prerelease', () => {
  assert.deepEqual(checkVersion('latest', '1.0.0'), []);
  assert.deepEqual(checkVersion('latest', '0.3.7'), []);
  for (const bad of ['1.0.0-alpha.0', '1.0.0-next.1', '1.0.0-rc.1', '1.0.0-beta.2']) {
    const problems = checkVersion('latest', bad);
    assert.ok(problems.some((problem) => /latest/.test(problem) && /prerelease/.test(problem)), `${bad}: ${problems.join('; ')}`);
  }
});

test('checkVersion: a message names the version, the channel and the rule', () => {
  const [problem] = checkVersion('alpha', '0.1.0');
  assert.match(problem ?? '', /0\.1\.0/);
  assert.match(problem ?? '', /alpha/);
  assert.match(problem ?? '', /X\.Y\.Z-alpha\.N/);
});

test('checkVersion: an unknown channel is a problem, not a default', () => {
  assert.notDeepEqual(checkVersion('stable', '1.0.0'), []);
});

// ---------------------------------------------------------------- changelog

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.1.0-alpha.0] - 2026-10-18

### Added

- Something.

## [0.0.1] - 2026-01-01

- Older.
`;

test('checkChangelog: an entry with the exact version and a date passes', () => {
  assert.deepEqual(checkChangelog(CHANGELOG, '0.1.0-alpha.0'), []);
});

test('checkChangelog: a missing, undated or empty entry fails', () => {
  assert.notDeepEqual(checkChangelog(CHANGELOG, '0.1.0-alpha.1'), []);
  assert.notDeepEqual(checkChangelog(CHANGELOG, '0.1.0'), [], 'a prefix of the version is not the version');
  assert.notDeepEqual(checkChangelog('## [0.1.0-alpha.0]\n\n- x\n', '0.1.0-alpha.0'), [], 'no date');
  assert.notDeepEqual(checkChangelog('## [0.1.0-alpha.0] - 2026-10-18\n\n## [0.0.1] - 2026-01-01\n- x\n', '0.1.0-alpha.0'), [], 'empty entry');
  assert.notDeepEqual(checkChangelog('## [Unreleased]\n\n- a thing\n', '0.1.0-alpha.0'), [], 'unreleased is not a release');
});

// ---------------------------------------------------------------- manifest

test('checkManifest: the good manifest has no problem', () => {
  assert.deepEqual(checkManifest(goodManifest()), []);
});

test('checkManifest: each wrong field is reported by name', () => {
  const cases: ReadonlyArray<readonly [string, Partial<PackageManifest>, RegExp]> = [
    ['name', { name: 'gsd-atlas' }, /name/],
    ['license', { license: 'ISC' }, /license/],
    ['engines', { engines: { node: '>=22' } }, /engines\.node/],
    ['repository url', { repository: { type: 'git', url: 'git+https://github.com/someone/else.git' } }, /repository/],
    ['repository missing', { repository: undefined }, /repository/],
    ['bugs', { bugs: { url: 'https://example.com/issues' } }, /bugs/],
    ['homepage', { homepage: 'https://example.com' }, /homepage/],
    ['access', { publishConfig: { access: 'restricted', provenance: true } }, /publishConfig\.access/],
    ['provenance', { publishConfig: { access: 'public', provenance: false } }, /publishConfig\.provenance/],
    ['bin', { bin: { 'gsd-atlas': 'dist/bin/gsd-atlas.js' } }, /bin/],
    ['private', { private: true }, /private/],
    ['description', { description: '' }, /description/],
    ['keywords', { keywords: [] }, /keywords/],
  ];
  for (const [label, patch, pattern] of cases) {
    const problems = checkManifest({ ...goodManifest(), ...patch });
    assert.ok(problems.some((problem) => pattern.test(problem)), `${label}: ${problems.join('; ')}`);
  }
});

// ---------------------------------------------------------------- the packed file list

test('checkPack: the good pack has no problem', () => {
  assert.deepEqual(checkPack(goodPack(), goodManifest()), []);
});

test('checkPack: only the allow-listed top-level directories and files ship', () => {
  for (const stray of ['.planning/x.md', '.github/workflows/ci.yml', 'scripts/release-check.ts', 'src/index.ts', 'test/a.ts', 'docs/PRD.md', 'corpora/x', 'node_modules/a/index.js', 'tsconfig.json', '.env', '.npmrc', 'package-lock.json']) {
    const problems = checkPack(withFiles([{ path: stray, size: 1, mode: 420 }]), goodManifest());
    assert.ok(problems.some((problem) => problem.includes(stray)), `${stray}: ${problems.join('; ')}`);
  }
});

test('checkPack: source maps, TypeScript sources and test output do not ship', () => {
  for (const stray of ['dist/cli/main.js.map', 'dist/cli/main.ts', 'dist/cli/main.test.js', 'dist/cli/main.test.d.ts', 'dist/test-kit/index.js']) {
    const problems = checkPack(withFiles([{ path: stray, size: 1, mode: 420 }]), goodManifest());
    assert.ok(problems.some((problem) => problem.includes(stray)), `${stray}: ${problems.join('; ')}`);
  }
  assert.deepEqual(checkPack(withFiles([{ path: 'dist/cli/other.d.ts', size: 1, mode: 420 }]), goodManifest()), [], 'declaration files are fine');
  assert.deepEqual(checkPack(withFiles([{ path: 'modules/typescript/fixtures/basic.ts', size: 1, mode: 420 }]), goodManifest()), [], 'module fixtures are shipped on purpose');
});

test('checkPack: both grammar .wasm files must be present and non-empty', () => {
  for (const wasm of ['modules/typescript/grammar.wasm', 'modules/javascript/grammar.wasm']) {
    assert.ok(checkPack(without(wasm), goodManifest()).some((problem) => problem.includes(wasm)), `${wasm} missing`);
  }
  const empty: PackInfo = { ...goodPack(), files: goodPack().files.map((file) => (file.path === 'modules/typescript/grammar.wasm' ? { ...file, size: 0 } : file)) };
  assert.ok(checkPack(empty, goodManifest()).some((problem) => problem.includes('modules/typescript/grammar.wasm')));
});

test('checkPack: README, LICENSE, CHANGELOG and package.json are required', () => {
  for (const name of ['README.md', 'LICENSE', 'CHANGELOG.md', 'package.json']) {
    assert.ok(checkPack(without(name), goodManifest()).some((problem) => problem.includes(name)), `${name} missing`);
  }
});

test('checkPack: each bin target is packed', () => {
  assert.ok(checkPack(without('dist/bin/gsd-atlas.js'), goodManifest()).some((problem) => problem.includes('dist/bin/gsd-atlas.js')));
  assert.ok(checkPack(without('dist/bin/gsd-atlas-mcp.js'), goodManifest()).some((problem) => problem.includes('dist/bin/gsd-atlas-mcp.js')));
});

test('checkShebang: a bin must start with a node shebang (npm makes it executable on install; the tarball keeps mode 644)', () => {
  assert.deepEqual(checkShebang('dist/bin/gsd-atlas.js', '#!/usr/bin/env node\nimport "x";\n'), []);
  assert.notDeepEqual(checkShebang('dist/bin/gsd-atlas.js', 'import "x";\n'), []);
  assert.notDeepEqual(checkShebang('dist/bin/gsd-atlas.js', '#!/bin/sh\n'), []);
  assert.ok(checkShebang('dist/bin/gsd-atlas.js', '').some((problem) => problem.includes('dist/bin/gsd-atlas.js')));
});

test('checkPack: the packed size cap is 5 MB', () => {
  assert.equal(PACKED_SIZE_CAP_BYTES, 5 * 1024 * 1024);
  assert.deepEqual(checkPack({ ...goodPack(), size: PACKED_SIZE_CAP_BYTES }, goodManifest()), []);
  const problems = checkPack({ ...goodPack(), size: PACKED_SIZE_CAP_BYTES + 1 }, goodManifest());
  assert.ok(problems.some((problem) => /size/.test(problem)), problems.join('; '));
});

test('checkPack: the pack must be for this name and version', () => {
  assert.ok(checkPack({ ...goodPack(), version: '9.9.9' }, goodManifest()).some((problem) => /version/.test(problem)));
});

// ---------------------------------------------------------------- packed text

test('scanText: absolute home paths are reported', () => {
  assert.ok(scanText('dist/a.js', 'const p = "/Users/alice/project/x";').some((problem) => problem.includes('dist/a.js')));
  assert.ok(scanText('dist/a.js', 'at /home/bob/src/x.ts:1').length > 0);
  assert.ok(scanText('dist/a.js', 'C:\\Users\\carol\\x').length > 0);
  assert.deepEqual(scanText('dist/a.js', 'const home = os.homedir(); join(home, ".cache")'), []);
  assert.deepEqual(scanText('dist/a.js', '// a drive-letter path (`C:/Users/x`) and /home/user/ are placeholders'), []);
});

test('scanText: secret-looking strings are reported without echoing them', () => {
  const samples = [
    'ghp_' + 'a'.repeat(36),
    'github_pat_' + 'A'.repeat(30),
    'npm_' + 'b'.repeat(36),
    'AKIA' + 'C'.repeat(16),
    'sk-ant-' + 'd'.repeat(20),
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'Bearer ' + 'e'.repeat(30),
    '//registry.npmjs.org/:_authToken=' + 'f'.repeat(20),
  ];
  for (const sample of samples) {
    const problems = scanText('dist/a.js', `x = "${sample}"`);
    assert.ok(problems.length > 0, `not detected: ${sample.slice(0, 8)}`);
    for (const problem of problems) assert.ok(!problem.includes(sample), 'the message must not repeat the secret');
  }
  assert.deepEqual(scanText('dist/a.js', 'process.env.NODE_AUTH_TOKEN and npm_config_registry'), []);
});

// ---------------------------------------------------------------- tool versions (npm trusted publishing)

test('compareVersions orders dotted versions numerically', () => {
  assert.ok(compareVersions('11.5.1', '11.5.1') === 0);
  assert.ok(compareVersions('11.13.0', '11.5.1') > 0);
  assert.ok(compareVersions('10.9.9', '11.5.1') < 0);
  assert.ok(compareVersions('22.14.0', '22.9.0') > 0);
  assert.ok(compareVersions('v24.16.0', '22.14.0') > 0, 'a leading v is ignored');
});

test('checkToolVersions: trusted publishing needs npm 11.5.1 and Node 22.14.0 or newer', () => {
  assert.deepEqual(checkToolVersions('24.16.0', '11.13.0'), []);
  assert.deepEqual(checkToolVersions('v22.14.0', '11.5.1'), []);
  assert.ok(checkToolVersions('24.16.0', '10.9.2').some((problem) => /npm/.test(problem) && /11\.5\.1/.test(problem)));
  assert.ok(checkToolVersions('20.19.0', '11.13.0').some((problem) => /Node/.test(problem) && /22\.14\.0/.test(problem)));
  assert.equal(checkToolVersions('20.19.0', '10.0.0').length, 2);
});

test('command: --tool-versions judges the running Node and npm and needs no channel', () => {
  const result = run(['--tool-versions']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-check: ok \(node /);
});

// ---------------------------------------------------------------- the command

function fixtureRoot(manifest: PackageManifest, changelog: string | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  if (changelog !== undefined) fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  return dir;
}

function run(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('command: a passing run prints ok, the channel, the version and the dist-tag, and exits 0', () => {
  const dir = fixtureRoot(goodManifest(), CHANGELOG);
  try {
    const result = run(['--channel', 'alpha', '--root', dir, '--skip-pack']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release-check: ok/);
    assert.match(result.stdout, /0\.1\.0-alpha\.0/);
    assert.match(result.stdout, /tag alpha/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('command: every failure is listed on stderr, one line each, and the exit code is 1', () => {
  const dir = fixtureRoot({ ...goodManifest(), version: '0.1.0', license: 'ISC' }, '# Changelog\n');
  try {
    const result = run(['--channel', 'alpha', '--root', dir, '--skip-pack']);
    assert.equal(result.status, 1);
    const lines = result.stderr.split('\n').filter((line) => line.startsWith('  - '));
    assert.ok(lines.length >= 3, result.stderr);
    assert.match(result.stderr, /release-check: FAILED/);
    assert.ok(lines.some((line) => /version/.test(line)));
    assert.ok(lines.some((line) => /CHANGELOG/.test(line)));
    assert.ok(lines.some((line) => /license/.test(line)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('command: latest is refused for a prerelease', () => {
  const dir = fixtureRoot(goodManifest(), CHANGELOG);
  try {
    const result = run(['--channel', 'latest', '--root', dir, '--skip-pack']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /latest/);
    assert.match(result.stderr, /prerelease/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('command: a usage error exits 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--channel', 'stable']).status, 2);
  assert.equal(run(['--channel', 'alpha', '--bogus']).status, 2);
});

test('command: with --pack-json the packed list is judged and the files are scanned for secrets and home paths', () => {
  const dir = fixtureRoot(goodManifest(), CHANGELOG);
  try {
    fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT License\n\nCopyright\n');
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'a.js'), 'const leak = "/Users/alice/x";\n');
    const pack: PackInfo = { ...goodPack(), files: [...goodPack().files, { path: 'dist/a.js', size: 30, mode: 420 }] };
    const packFile = path.join(dir, 'pack.json');
    fs.writeFileSync(packFile, JSON.stringify([pack]));
    const result = run(['--channel', 'alpha', '--root', dir, '--pack-json', packFile]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dist\/a\.js/);
    assert.match(result.stderr, /home path/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('this repository: package.json and CHANGELOG.md pass the channel that the version names', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest;
  const channel = channelOf(manifest.version ?? '');
  assert.ok(channel !== undefined, `package.json version ${manifest.version ?? ''} belongs to no channel`);
  const result = run(['--channel', channel, '--root', root, '--skip-pack']);
  assert.equal(result.status, 0, result.stderr);
});
