import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { allowAll, createRealRunner } from '../src/command-runner/index.ts';
import { makeTempDir } from '../src/test-kit/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

type DepMap = Record<string, string>;

interface PackageJson {
  name?: string;
  version?: string;
  license?: string;
  type?: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: DepMap;
  devDependencies?: DepMap;
  peerDependencies?: DepMap;
  optionalDependencies?: DepMap;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function readPackage(): PackageJson {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson;
}

// Node spawns are done with argument arrays and no shell, always through
// process.execPath: npm/npx/.cmd shims fail on Windows without a shell.
function runNode(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let buildResult: { status: number | null; stdout: string; stderr: string } | undefined;

// Builds dist/ once per test process. A stale dist/ is removed first so the
// assertions describe what tsc emits now, not what an earlier run left behind.
function ensureBuild(): void {
  if (buildResult === undefined) {
    rmSync(distDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    buildResult = runNode([
      path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      'tsconfig.build.json',
    ]);
  }
  assert.equal(
    buildResult.status,
    0,
    `tsc -p tsconfig.build.json failed:\n${buildResult.stdout}\n${buildResult.stderr}`,
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

// Removes comments so that text such as "// import x from 'node:test'" can
// never trip the specifier scan. Strings containing " //" lose their tail,
// which is harmless for a scan that only reads import/export specifiers.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function moduleSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])(.*?)\1/g,
    /\bimport\s*(['"])(.*?)\1/g,
    /\bimport\s*\(\s*(['"`])(.*?)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      specifiers.push(match[2] as string);
    }
  }
  return specifiers;
}

test('package.json identity, license, module type, engines floor, bins and files', () => {
  const pkg = readPackage();
  assert.equal(pkg.name, '@opengsd/gsd-atlas');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=24.16.0');
  assert.deepEqual(Object.keys(pkg.bin ?? {}).sort(), ['gsd-atlas', 'gsd-atlas-mcp']);
  assert.equal(pkg.bin?.['gsd-atlas'], 'dist/bin/gsd-atlas.js');
  assert.equal(pkg.bin?.['gsd-atlas-mcp'], 'dist/bin/gsd-atlas-mcp.js');
  assert.ok(pkg.files?.includes('dist'), 'files must include dist');
  assert.ok(pkg.files?.includes('schemas'), 'files must include schemas');
});

test('every dependency is an exact pin, no gsd-core or gsd-graph dependency, better-sqlite3 peer optional', () => {
  const pkg = readPackage();
  const exact = /^\d+\.\d+\.\d+$/;
  const maps: Array<[string, DepMap | undefined]> = [
    ['dependencies', pkg.dependencies],
    ['devDependencies', pkg.devDependencies],
    ['peerDependencies', pkg.peerDependencies],
    ['optionalDependencies', pkg.optionalDependencies],
  ];
  for (const [mapName, map] of maps) {
    for (const [dep, version] of Object.entries(map ?? {})) {
      assert.match(version, exact, `${mapName}.${dep} must be an exact version, got "${version}"`);
      assert.ok(
        !dep.startsWith('@opengsd/gsd-core') && !dep.includes('gsd-graph'),
        `${mapName}.${dep} is forbidden by the product boundary`,
      );
    }
  }
  assert.equal(pkg.peerDependenciesMeta?.['better-sqlite3']?.optional, true);
});

test('scripts include the eleven required names', () => {
  const pkg = readPackage();
  const required = [
    'build',
    'typecheck',
    'lint',
    'test',
    'coverage',
    'schema:build',
    'schema:check',
    'grammar:build',
    'grammar:verify',
    'grammar:budget',
    'prepack',
  ];
  for (const name of required) {
    assert.ok(
      typeof pkg.scripts?.[name] === 'string' && pkg.scripts[name] !== '',
      `missing npm script ${name}`,
    );
  }
});

test('built dist/bin/gsd-atlas.js starts with a shebang and prints the same version as the source run', () => {
  ensureBuild();
  const distBin = path.join(distDir, 'bin', 'gsd-atlas.js');
  assert.ok(existsSync(distBin), 'dist/bin/gsd-atlas.js must exist after the build');
  assert.ok(readFileSync(distBin, 'utf8').startsWith('#!'), 'dist/bin/gsd-atlas.js must start with a shebang');
  const fromSource = runNode([path.join('src', 'bin', 'gsd-atlas.ts'), '--version']);
  const fromDist = runNode([distBin, '--version']);
  assert.equal(fromSource.status, 0, fromSource.stderr);
  assert.equal(fromDist.status, 0, fromDist.stderr);
  assert.equal(fromSource.stdout, fromDist.stdout);
  assert.match(fromDist.stdout, /^gsd-atlas \d+\.\d+\.\d+\n$/);
});

test('gsd-atlas-mcp exits 1 and its stderr says the MCP server arrives in Phase 2', () => {
  const result = runNode([path.join('src', 'bin', 'gsd-atlas-mcp.ts')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Phase 2/);
});

test('build output is production-only: no contract, test or test-kit code in dist/', () => {
  ensureBuild();
  const files = walk(distDir);
  assert.ok(files.length > 0, 'dist/ must not be empty');
  for (const file of files) {
    const rel = path.relative(distDir, file).split(path.sep);
    const base = rel[rel.length - 1] as string;
    assert.ok(
      base !== 'contract.js' && base !== 'contract.d.ts',
      `dist must not contain a contract suite: ${rel.join('/')}`,
    );
    assert.ok(
      !base.endsWith('.test.js') && !base.endsWith('.test.d.ts'),
      `dist must not contain a test file: ${rel.join('/')}`,
    );
    assert.ok(!rel.includes('test-kit'), `dist must not contain test-kit: ${rel.join('/')}`);
    if (base.endsWith('.js')) {
      for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
        assert.ok(
          specifier !== 'node:test' && !specifier.includes('test-kit'),
          `${rel.join('/')} imports ${specifier}, which is test-only`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The published artifact (FND-02, ROADMAP SC1): pack the tarball, install it in a clean directory
// and run the installed bins. These tests use the network: the tarball install resolves
// `web-tree-sitter` and `zod` from the registry (exact pins in package.json), with --ignore-scripts.
// npm itself is started as `node <npm-cli.js> ...` through the CommandRunner: never an npm shim,
// an `.cmd` file or a shell (FND-06; those fail on Windows).
// No wall-clock limit is set here on purpose: the CI job timeout bounds a hung install.
// ---------------------------------------------------------------------------------------------

const runner = createRealRunner({ decide: allowAll });

/** Locates npm's `npm-cli.js` without spawning an npm shim. */
export function findNpmCli(): string {
  const fromEnv = process.env['npm_execpath'];
  if (fromEnv !== undefined && fromEnv.endsWith('npm-cli.js') && existsSync(fromEnv)) {
    return fromEnv;
  }
  const nodeDir = path.dirname(realpathSync(process.execPath));
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Homebrew and similar layouts keep npm outside the node prefix: `<node dir>/npm` is a link to npm-cli.js.
  const sibling = path.join(nodeDir, 'npm');
  if (existsSync(sibling) && realpathSync(sibling).endsWith('npm-cli.js')) {
    return realpathSync(sibling);
  }
  throw new Error(
    `npm-cli.js not found: npm_execpath is ${fromEnv ?? 'unset'}; tried ${candidates.join(' and ')}`,
  );
}

interface Run {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runChild(executable: string, args: string[], cwd: string): Promise<Run> {
  const result = await runner.run({ executable, args, cwd });
  assert.equal(result.spawnError, undefined, `could not start ${executable}: ${JSON.stringify(result.spawnError)}`);
  assert.equal(result.denied, undefined);
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

function runNpm(args: string[], cwd: string): Promise<Run> {
  return runChild(process.execPath, [findNpmCli(), ...args], cwd);
}

interface PackedTarball {
  readonly tarball: string;
  readonly files: string[];
}

const scratch = makeTempDir();
after(() => {
  scratch.cleanup();
});

let packed: Promise<PackedTarball> | undefined;

/** Builds dist/ and packs it once per test process. */
function packOnce(): Promise<PackedTarball> {
  packed ??= (async () => {
    ensureBuild();
    const destination = path.join(scratch.path, 'pack');
    mkdirSync(destination);
    const result = await runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination], root);
    assert.equal(result.exitCode, 0, `npm pack failed:\n${result.stdout}\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    assert.equal(parsed.length, 1, 'npm pack must produce exactly one tarball');
    const entry = parsed[0] as { filename: string; files: Array<{ path: string }> };
    return {
      tarball: path.join(destination, path.basename(entry.filename)),
      files: entry.files.map((file) => file.path.split('\\').join('/')),
    };
  })();
  return packed;
}

test('pack contents', async () => {
  const pkg = readPackage();
  const { files } = await packOnce();
  const has = (file: string): boolean => files.includes(file);

  for (const required of [
    'package.json',
    'dist/bin/gsd-atlas.js',
    'dist/bin/gsd-atlas-mcp.js',
    'schemas/atlas-lang.schema.json',
  ]) {
    assert.ok(has(required), `tarball must contain ${required}`);
  }
  for (const [name, target] of Object.entries(pkg.bin ?? {})) {
    assert.ok(has(target), `bin ${name} points at ${target}, which is not in the tarball`);
  }
  for (const dir of ['lang', 'grammar-engine', 'cli']) {
    assert.ok(
      files.some((file) => file.startsWith(`dist/${dir}/`) && file.endsWith('.js')),
      `tarball must contain compiled dist/${dir}/ modules`,
    );
  }

  const forbiddenPrefixes = ['src/', 'test/', 'scripts/', 'docs/', '.planning/', '.github/', 'node_modules/'];
  for (const file of files) {
    for (const prefix of forbiddenPrefixes) {
      assert.ok(!file.startsWith(prefix), `tarball must not contain ${file}`);
    }
    const base = file.split('/').pop() as string;
    assert.ok(
      base !== 'contract.js' && base !== 'contract.d.ts' && !base.endsWith('.test.js') && !base.endsWith('.test.d.ts'),
      `tarball must not contain a contract suite or test output: ${file}`,
    );
    assert.ok(!file.split('/').includes('test-kit'), `tarball must not contain test-kit output: ${file}`);
    // Strict whitelist: what the files list names plus what npm adds on its own.
    assert.ok(
      /^(dist|schemas|modules)\//.test(file) || ['package.json', 'README.md', 'LICENSE'].includes(file),
      `unexpected path in tarball: ${file}`,
    );
  }
});

test('installed tarball runs the bins', async () => {
  const { tarball } = await packOnce();
  const prefix = path.join(scratch.path, 'clean install');
  mkdirSync(prefix);
  const install = await runNpm(
    ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    prefix,
  );
  assert.equal(install.exitCode, 0, `npm install of the tarball failed:\n${install.stdout}\n${install.stderr}`);

  const installed = path.join(prefix, 'node_modules', '@opengsd', 'gsd-atlas');
  const bin = path.join(installed, 'dist', 'bin', 'gsd-atlas.js');
  const mcpBin = path.join(installed, 'dist', 'bin', 'gsd-atlas-mcp.js');
  assert.ok(existsSync(bin) && existsSync(mcpBin), 'both bin targets exist in the installed package');
  for (const dependency of ['web-tree-sitter', 'zod']) {
    assert.ok(
      existsSync(path.join(prefix, 'node_modules', dependency, 'package.json')),
      `${dependency} must be installed from the tarball's own dependencies`,
    );
  }

  // No installed production file may load test code (T-01-40): scan every dist .js file's specifiers.
  const distFiles = walk(path.join(installed, 'dist')).filter((file) => file.endsWith('.js'));
  assert.ok(distFiles.length > 0, 'installed dist/ has compiled files');
  for (const file of distFiles) {
    for (const specifier of moduleSpecifiers(readFileSync(file, 'utf8'))) {
      assert.ok(
        specifier !== 'node:test' && !specifier.includes('test-kit'),
        `${path.relative(installed, file)} imports ${specifier}, which is test-only`,
      );
    }
  }

  const version = await runChild(process.execPath, [bin, '--version'], prefix);
  assert.equal(version.exitCode, 0, version.stderr);
  assert.equal(version.stdout, `gsd-atlas ${readPackage().version ?? ''}\n`);

  const empty = (name: string): string => {
    const dir = path.join(scratch.path, name);
    mkdirSync(dir);
    return dir;
  };
  const list = await runChild(
    process.execPath,
    [
      bin,
      'lang',
      'list',
      '--repo-root',
      empty('empty repo'),
      '--user-dir',
      empty('empty user'),
      '--npm-root',
      empty('empty npm'),
    ],
    prefix,
  );
  assert.equal(list.exitCode, 0, list.stderr);
  const listEnvelope = JSON.parse(list.stdout.trim()) as { ok: boolean; data: { modules: unknown[] } };
  assert.equal(listEnvelope.ok, true);
  assert.deepEqual(listEnvelope.data.modules, []);

  const toy = path.join(root, 'test', 'fixtures', 'modules', 'toy');
  const langTest = await runChild(process.execPath, [bin, 'lang', 'test', toy], prefix);
  assert.equal(langTest.exitCode, 0, `lang test from the installed package failed:\n${langTest.stdout}\n${langTest.stderr}`);
  const report = JSON.parse(langTest.stdout.trim()) as {
    ok: boolean;
    data: { ok: boolean; fixtures: Array<{ file: string; ok: boolean }> };
  };
  assert.equal(report.ok, true);
  assert.equal(report.data.fixtures.length, 4, 'the toy module has four fixtures');
  assert.ok(report.data.fixtures.every((fixture) => fixture.ok), 'every toy fixture matches its golden');

  const mcp = await runChild(process.execPath, [mcpBin], prefix);
  assert.equal(mcp.exitCode, 1);
  assert.match(mcp.stderr, /Phase 2/);
});
