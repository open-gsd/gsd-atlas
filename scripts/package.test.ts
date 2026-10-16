import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');

type DepMap = Record<string, string>;

interface PackageJson {
  name?: string;
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
