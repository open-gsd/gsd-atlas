// The release gate. Given a channel (alpha | next | latest) and the repository root, it judges, before anything is
// published: the version against the channel, the changelog entry for that exact version, the manifest fields npm and
// provenance rely on, and what `npm pack` would put in the tarball (an allow-list of paths, the grammar .wasm files,
// the bins, a size cap, and a scan of the packed text for absolute home paths and secret-looking strings).
//
//   node scripts/release-check.ts --channel alpha            full check; runs `npm pack --dry-run --json --ignore-scripts`
//   node scripts/release-check.ts --channel alpha --skip-pack  version, changelog and manifest only (no build needed)
//   node scripts/release-check.ts --channel alpha --pack-json pack.json   judge a saved `npm pack --json` output
//
// Exit 0: every rule holds. Exit 1: one or more rules failed (one line each on stderr). Exit 2: usage error.
// It never publishes, never touches the network and never reads a token.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const CHANNELS = ['alpha', 'next', 'latest'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PACKED_SIZE_CAP_BYTES = 5 * 1024 * 1024;
export const UNPACKED_SIZE_CAP_BYTES = 25 * 1024 * 1024;

const REPO = 'open-gsd/gsd-atlas';
const EXPECTED = {
  name: '@opengsd/gsd-atlas',
  license: 'MIT',
  node: '>=24.16.0',
  repositoryUrl: `git+https://github.com/${REPO}.git`,
  bugsUrl: `https://github.com/${REPO}/issues`,
  homepage: `https://github.com/${REPO}#readme`,
  bin: { 'gsd-atlas': 'dist/bin/gsd-atlas.js', 'gsd-atlas-mcp': 'dist/bin/gsd-atlas-mcp.js' } as Readonly<Record<string, string>>,
} as const;

/** Top-level directories and files that may be in the tarball: the `files` list plus what npm always adds, plus the changelog. */
const ALLOWED_DIRECTORIES: ReadonlySet<string> = new Set(['dist', 'schemas', 'modules', 'skills', 'diagnostics']);
const ALLOWED_FILES: ReadonlySet<string> = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const REQUIRED_FILES: readonly string[] = ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'];
const REQUIRED_WASM: readonly string[] = ['modules/typescript/grammar.wasm', 'modules/javascript/grammar.wasm'];

export interface PackageManifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  private?: boolean;
  type?: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  keywords?: string[];
  repository?: { type?: string; url?: string };
  bugs?: { url?: string };
  homepage?: string;
  publishConfig?: { access?: string; provenance?: boolean };
}

export interface PackFile {
  path: string;
  size: number;
  mode?: number;
}

/** The fields of `npm pack --json` that the checks read. */
export interface PackInfo {
  name?: string;
  version?: string;
  size: number;
  unpackedSize?: number;
  files: PackFile[];
}

// ---------------------------------------------------------------- channels and versions

export const distTagFor = (channel: Channel): string => channel;

const NUMBER = '(?:0|[1-9]\\d*)';
const BASE = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`;
const PATTERNS: Readonly<Record<Channel, RegExp>> = {
  alpha: new RegExp(`^${BASE}-alpha\\.${NUMBER}$`),
  next: new RegExp(`^${BASE}-(?:next|rc)\\.${NUMBER}$`),
  latest: new RegExp(`^${BASE}$`),
};
const SHAPE: Readonly<Record<Channel, string>> = {
  alpha: 'X.Y.Z-alpha.N',
  next: 'X.Y.Z-next.N or X.Y.Z-rc.N',
  latest: 'X.Y.Z with no prerelease part',
};

/** The channel a version belongs to, or undefined when it fits none (for example a beta, or build metadata). */
export function channelOf(version: string): Channel | undefined {
  return CHANNELS.find((channel) => PATTERNS[channel].test(version) && version !== '0.0.0');
}

const isChannel = (value: string): value is Channel => (CHANNELS as readonly string[]).includes(value);

export function checkVersion(channel: string, version: string): string[] {
  if (!isChannel(channel)) return [`unknown channel "${channel}"; the channels are ${CHANNELS.join(', ')}`];
  if (version === '0.0.0') return ['version 0.0.0 is the unreleased placeholder and cannot be published'];
  if (PATTERNS[channel].test(version)) return [];
  const prerelease = /^\d+\.\d+\.\d+-/.test(version);
  if (channel === 'latest' && prerelease) {
    return [`version ${version} is a prerelease and cannot go to the latest channel: latest takes only ${SHAPE.latest}, so a prerelease can never become the default install`];
  }
  const others = CHANNELS.filter((other) => other !== channel && PATTERNS[other].test(version));
  const hint = others.length > 0 ? ` (it belongs to the ${others.join(' or ')} channel)` : '';
  return [`version ${version} does not match the ${channel} channel${hint}: expected ${SHAPE[channel]}, with N a whole number without leading zeros and no build metadata`];
}

// ---------------------------------------------------------------- changelog

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The changelog must hold a dated `## [version] - YYYY-MM-DD` entry for the exact version, and the entry must say something. */
export function checkChangelog(text: string, version: string): string[] {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);
  const at = lines.findIndex((line) => heading.test(line));
  if (at === -1) {
    const undated = lines.some((line) => new RegExp(`^## \\[${escapeRegExp(version)}\\]`).test(line));
    return [undated
      ? `CHANGELOG.md has an entry for ${version} without a date; the heading must be "## [${version}] - YYYY-MM-DD"`
      : `CHANGELOG.md has no entry for ${version}; add a heading "## [${version}] - YYYY-MM-DD" with its changes`];
  }
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== '' && !/^\[[^\]]+\]:\s/.test(line));
  return body.length === 0 ? [`the CHANGELOG.md entry for ${version} is empty`] : [];
}

// ---------------------------------------------------------------- manifest

export function checkManifest(pkg: PackageManifest): string[] {
  const problems: string[] = [];
  const expect = (field: string, actual: unknown, wanted: unknown): void => {
    if (actual !== wanted) problems.push(`package.json ${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
  };
  expect('name', pkg.name, EXPECTED.name);
  expect('license', pkg.license, EXPECTED.license);
  expect('engines.node', pkg.engines?.node, EXPECTED.node);
  expect('repository.type', pkg.repository?.type, 'git');
  expect('repository.url', pkg.repository?.url, EXPECTED.repositoryUrl);
  expect('bugs.url', pkg.bugs?.url, EXPECTED.bugsUrl);
  expect('homepage', pkg.homepage, EXPECTED.homepage);
  expect('publishConfig.access', pkg.publishConfig?.access, 'public');
  expect('publishConfig.provenance', pkg.publishConfig?.provenance, true);
  if (pkg.private === true) problems.push('package.json private is true; a private package cannot be published');
  if ((pkg.description ?? '').trim() === '') problems.push('package.json description is empty');
  if (!Array.isArray(pkg.keywords) || pkg.keywords.length === 0) problems.push('package.json keywords is empty');
  const bin = pkg.bin ?? {};
  const names = Object.keys(bin).sort();
  const wantedNames = Object.keys(EXPECTED.bin).sort();
  if (names.join() !== wantedNames.join()) problems.push(`package.json bin names are ${JSON.stringify(names)}, expected ${JSON.stringify(wantedNames)}`);
  for (const name of wantedNames) {
    if (bin[name] !== undefined && bin[name] !== EXPECTED.bin[name]) problems.push(`package.json bin ${name} is ${JSON.stringify(bin[name])}, expected ${JSON.stringify(EXPECTED.bin[name])}`);
  }
  return problems;
}

// ---------------------------------------------------------------- the packed file list

const normalise = (file: string): string => file.split('\\').join('/').replace(/^\.\//, '');

export function checkPack(pack: PackInfo, pkg: PackageManifest): string[] {
  const problems: string[] = [];
  if (pack.name !== undefined && pack.name !== pkg.name) problems.push(`the pack is for ${pack.name}, but package.json names ${String(pkg.name)}`);
  if (pack.version !== undefined && pack.version !== pkg.version) problems.push(`the pack is for version ${pack.version}, but package.json has version ${String(pkg.version)}`);

  const files = pack.files.map((file) => ({ ...file, path: normalise(file.path) }));
  const byPath = new Map(files.map((file) => [file.path, file]));

  for (const required of REQUIRED_FILES) {
    if (!byPath.has(required)) problems.push(`the tarball does not contain ${required}`);
  }
  for (const wasm of REQUIRED_WASM) {
    const found = byPath.get(wasm);
    if (found === undefined) problems.push(`the tarball does not contain ${wasm}`);
    else if (found.size <= 0) problems.push(`${wasm} is empty in the tarball`);
  }

  for (const file of files) {
    const segments = file.path.split('/');
    const top = segments[0] ?? '';
    const base = segments[segments.length - 1] ?? '';
    const allowed = segments.length === 1 ? ALLOWED_FILES.has(top) : ALLOWED_DIRECTORIES.has(top);
    if (!allowed) {
      problems.push(`${file.path}: not on the tarball allow-list (dist, schemas, modules, skills, diagnostics, and package.json, README.md, LICENSE, CHANGELOG.md)`);
      continue;
    }
    if (base.endsWith('.map')) problems.push(`${file.path}: a source map ships in the tarball`);
    if (top === 'dist' && base.endsWith('.ts') && !base.endsWith('.d.ts')) problems.push(`${file.path}: TypeScript source ships in dist/`);
    if (/\.test\.(?:js|d\.ts)$/.test(base) || base === 'contract.js' || base === 'contract.d.ts' || segments.includes('test-kit')) {
      problems.push(`${file.path}: test output ships in the tarball`);
    }
  }

  for (const target of Object.values(pkg.bin ?? {})) {
    const wanted = normalise(target);
    const found = byPath.get(wanted);
    if (found === undefined) problems.push(`bin target ${wanted} is not in the tarball`);
  }

  if (pack.size > PACKED_SIZE_CAP_BYTES) problems.push(`packed size ${pack.size} bytes is over the cap of ${PACKED_SIZE_CAP_BYTES} bytes`);
  if (pack.unpackedSize !== undefined && pack.unpackedSize > UNPACKED_SIZE_CAP_BYTES) {
    problems.push(`unpacked size ${pack.unpackedSize} bytes is over the cap of ${UNPACKED_SIZE_CAP_BYTES} bytes`);
  }
  return problems;
}

/** A bin target must start with a node shebang: npm marks it executable on install, not in the tarball. */
export function checkShebang(file: string, text: string): string[] {
  return text.startsWith('#!/usr/bin/env node') ? [] : [`bin target ${file} does not start with "#!/usr/bin/env node"`];
}

// ---------------------------------------------------------------- packed text

/** User names that are placeholders in a comment or an example ("C:/Users/x"), not a person's home folder. */
const PLACEHOLDER_USERS: ReadonlySet<string> = new Set(['x', 'user', 'username', 'name', 'you', 'me', 'foo', 'example']);

const HOME_PATHS: ReadonlyArray<readonly [string, RegExp]> = [
  ['macOS', /\/Users\/([A-Za-z0-9._-]+)/g],
  ['Linux', /\/home\/([a-z][a-z0-9_-]*)\//g],
  ['Windows', /[A-Za-z]:\\Users\\([A-Za-z0-9._ -]+)/g],
];

const SECRETS: ReadonlyArray<readonly [string, RegExp]> = [
  ['a GitHub token', /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{30,}/],
  ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ['a Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['an npmrc auth token', /_authToken\s*=\s*(?!\$\{)[^\s"'`]{8,}/],
];

/** Problems in one packed text file; a message names the file and the kind of match and never repeats the match. */
export function scanText(file: string, text: string): string[] {
  const problems: string[] = [];
  for (const [kind, pattern] of HOME_PATHS) {
    const real = [...text.matchAll(pattern)].some((match) => !PLACEHOLDER_USERS.has((match[1] ?? '').toLowerCase()));
    if (real) problems.push(`${file}: contains an absolute home path (${kind})`);
  }
  for (const [kind, pattern] of SECRETS) {
    if (pattern.test(text)) problems.push(`${file}: contains what looks like ${kind}`);
  }
  return problems;
}

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.ts', '.txt', '.yml', '.yaml', '.svg', '.html', '.css']);
const isTextFile = (file: string): boolean => TEXT_EXTENSIONS.has(path.extname(file)) || file === 'LICENSE';

// ---------------------------------------------------------------- the command

function findNpmCli(): string | undefined {
  const fromEnv = process.env['npm_execpath'];
  if (fromEnv !== undefined && fromEnv.endsWith('npm-cli.js') && fs.existsSync(fromEnv)) return fromEnv;
  const nodeDir = path.dirname(fs.realpathSync(process.execPath));
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found !== undefined) return found;
  const sibling = path.join(nodeDir, 'npm');
  return fs.existsSync(sibling) && fs.realpathSync(sibling).endsWith('npm-cli.js') ? fs.realpathSync(sibling) : undefined;
}

function parsePackJson(text: string, source: string): PackInfo {
  const parsed: unknown = JSON.parse(text);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (typeof entry !== 'object' || entry === null || !Array.isArray((entry as PackInfo).files) || typeof (entry as PackInfo).size !== 'number') {
    throw new Error(`${source} is not the output of npm pack --json`);
  }
  return entry as PackInfo;
}

function npmPackDryRun(root: string): PackInfo {
  const cli = findNpmCli();
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
  // Arguments, never a shell: node runs npm-cli.js directly. Without a located npm-cli.js a plain `npm` is used off Windows.
  const result = cli !== undefined
    ? spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync('npm', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm pack --dry-run failed (exit ${String(result.status)}): ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return parsePackJson(result.stdout, 'npm pack --dry-run --json');
}

export interface CheckOptions {
  readonly channel: Channel;
  readonly root: string;
  readonly skipPack: boolean;
  readonly packJson?: string;
}

export interface CheckResult {
  readonly problems: string[];
  readonly version: string;
}

export function runChecks(options: CheckOptions): CheckResult {
  const problems: string[] = [];
  let pkg: PackageManifest = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(options.root, 'package.json'), 'utf8')) as PackageManifest;
  } catch (error) {
    return { problems: [`package.json cannot be read: ${error instanceof Error ? error.message : String(error)}`], version: '' };
  }
  const version = pkg.version ?? '';
  problems.push(...checkVersion(options.channel, version));
  problems.push(...checkManifest(pkg));

  const changelogFile = path.join(options.root, 'CHANGELOG.md');
  if (fs.existsSync(changelogFile)) problems.push(...checkChangelog(fs.readFileSync(changelogFile, 'utf8'), version));
  else problems.push('CHANGELOG.md does not exist');

  const licenseFile = path.join(options.root, 'LICENSE');
  if (fs.existsSync(licenseFile) && !/\bMIT License\b/.test(fs.readFileSync(licenseFile, 'utf8'))) problems.push('LICENSE is not the MIT licence text');

  if (options.skipPack) return { problems, version };

  let pack: PackInfo;
  try {
    pack = options.packJson !== undefined ? parsePackJson(fs.readFileSync(options.packJson, 'utf8'), options.packJson) : npmPackDryRun(options.root);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return { problems, version };
  }
  problems.push(...checkPack(pack, pkg));
  for (const target of Object.values(pkg.bin ?? {})) {
    const absolute = path.join(options.root, ...normalise(target).split('/'));
    if (fs.existsSync(absolute)) problems.push(...checkShebang(normalise(target), fs.readFileSync(absolute, 'utf8')));
  }
  for (const file of pack.files) {
    const relative = normalise(file.path);
    if (!isTextFile(relative)) continue;
    const absolute = path.join(options.root, ...relative.split('/'));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    problems.push(...scanText(relative, fs.readFileSync(absolute, 'utf8')));
  }
  return { problems, version };
}

const USAGE = 'usage: node scripts/release-check.ts --channel <alpha|next|latest> [--root <dir>] [--skip-pack] [--pack-json <file>]';

function main(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { channel: { type: 'string' }, root: { type: 'string' }, 'skip-pack': { type: 'boolean' }, 'pack-json': { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`release-check: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  const channel = values.channel;
  if (channel === undefined || !isChannel(channel)) {
    process.stderr.write(`release-check: --channel must be one of ${CHANNELS.join(', ')}\n${USAGE}\n`);
    return 2;
  }
  const root = path.resolve(values.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { problems, version } = runChecks({
    channel,
    root,
    skipPack: values['skip-pack'] === true,
    ...(values['pack-json'] === undefined ? {} : { packJson: path.resolve(values['pack-json']) }),
  });
  if (problems.length > 0) {
    process.stderr.write(`release-check: FAILED (${String(problems.length)} problem${problems.length === 1 ? '' : 's'}) for ${channel}\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }
  process.stdout.write(`release-check: ok (channel ${channel}, version ${version}, tag ${distTagFor(channel)})\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
