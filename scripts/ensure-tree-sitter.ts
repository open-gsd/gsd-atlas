import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Make sure the tree-sitter CLI binary exists and is the exact version everything else pins.
 *
 * `npm ci --ignore-scripts` installs tree-sitter-cli WITHOUT its native executable (the
 * package fetches it in an install script). This is the single deliberate network fetch of
 * that release binary; it is only ever run by the grammar:* scripts and the grammar CI jobs,
 * never by npm install or npm test (D-07, Pitfall 4).
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPackageDir = path.join(repoRoot, 'node_modules', 'tree-sitter-cli');

export interface TreeSitterCli {
  readonly binary: string;
  readonly version: string;
}

/** Extract `0.27.1` from `tree-sitter 0.27.1 (hash)`; null when the text is not a version line. */
export function parseCliVersion(text: string): string | null {
  const match = /tree-sitter\s+(\d+\.\d+\.\d+)/.exec(text);
  return match === null ? null : (match[1] ?? null);
}

function readJsonVersion(file: string): string {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new Error(`no version field in ${file}`);
  }
  return parsed.version;
}

function binaryPath(): string {
  return path.join(cliPackageDir, process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter');
}

function runVersion(binary: string): string {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (result.error !== undefined) {
    throw new Error(`could not run ${binary} --version: ${result.error.message}`);
  }
  const parsed = parseCliVersion(`${result.stdout}${result.stderr}`);
  if (result.status !== 0 || parsed === null) {
    throw new Error(`${binary} --version gave no parsable version (exit ${String(result.status)})`);
  }
  return parsed;
}

/**
 * Locate (fetching if absent) the tree-sitter binary and assert its version equals the
 * web-tree-sitter version, the package.json pin and, when supplied, the grammar.lock version.
 */
export function ensureTreeSitter(lock?: { readonly cli: { readonly version: string } }): TreeSitterCli {
  const binary = binaryPath();
  if (!fs.existsSync(binary)) {
    const install = path.join(cliPackageDir, 'install.js');
    if (!fs.existsSync(install)) {
      throw new Error(`tree-sitter-cli is not installed (missing ${install}); run npm ci --ignore-scripts first`);
    }
    // The one deliberate network fetch of the CLI release binary. Argument array, no shell.
    const result = spawnSync(process.execPath, [install], { cwd: cliPackageDir, stdio: 'inherit' });
    if (result.status !== 0 || !fs.existsSync(binary)) {
      throw new Error(`fetching the tree-sitter binary failed (exit ${String(result.status)})`);
    }
  }

  const version = runVersion(binary);
  const webVersion = readJsonVersion(path.join(repoRoot, 'node_modules', 'web-tree-sitter', 'package.json'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const pinned = pkg.devDependencies?.['tree-sitter-cli'];

  const expectations: Array<[string, string | undefined]> = [
    ['web-tree-sitter', webVersion],
    ['package.json pin', pinned],
  ];
  if (lock !== undefined) {
    expectations.push(['grammar.lock cli.version', lock.cli.version]);
  }
  if (expectations.some(([, expected]) => expected !== version)) {
    const detail = expectations.map(([label, expected]) => `${label} ${String(expected)}`).join(', ');
    throw new Error(`tree-sitter CLI version mismatch: binary ${version}, ${detail}; all must be equal`);
  }
  return { binary, version };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  try {
    const { binary, version } = ensureTreeSitter();
    process.stdout.write(`${binary}\n${version}\n`);
  } catch (error) {
    process.stderr.write(`ensure-tree-sitter: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
