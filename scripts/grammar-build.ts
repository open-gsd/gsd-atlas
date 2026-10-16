import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseGrammarLock } from '../src/lang/grammar-lock.ts';
import type { GrammarLock } from '../src/lang/grammar-lock.ts';
import { ensureTreeSitter } from './ensure-tree-sitter.ts';

/**
 * node scripts/grammar-build.ts [moduleDir...] [--update-lock] [--report]
 *
 * The one shared grammar build, driven by each module's grammar.lock (D-08). It generates the
 * parser with an explicit ABI and builds the WASM with the pinned tree-sitter CLI. It is
 * dev-time tooling: it uses the network and the wasi toolchain, so npm install and npm test
 * never run it (D-07).
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

/** The ABI is always passed to `generate` explicitly; the CLI default may change (Pitfall 1). */
const GENERATE_ABI = '15';

export type GrammarBuildErrorCode =
  | 'lock_invalid'
  | 'source_missing'
  | 'archive_hash_mismatch'
  | 'archive_fetch_failed'
  | 'extract_failed'
  | 'patch_failed'
  | 'generate_failed'
  | 'build_failed';

export class GrammarBuildError extends Error {
  readonly code: GrammarBuildErrorCode;
  constructor(code: GrammarBuildErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'GrammarBuildError';
    this.code = code;
  }
}

export interface PreparedSource {
  /** Directory holding the grammar source tree (grammar.js and tree-sitter.json). */
  readonly dir: string;
  readonly patchesApplied: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Null when the computed hash equals the lock; otherwise the text to print before exiting 1. */
export function checkAgainstLock(lock: GrammarLock, computedSha256: string): string | null {
  if (computedSha256 === lock.wasm.sha256) {
    return null;
  }
  return (
    `grammar hash mismatch for ${lock.name} on ${process.platform}/${process.arch}\n` +
    `  expected (grammar.lock): ${lock.wasm.sha256}\n` +
    `  computed:                ${computedSha256}\n` +
    'run with --update-lock if this change is intentional'
  );
}

export function removeDir(dir: string): void {
  // Windows keeps files locked briefly after a child exits, hence the retries.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Read the upstream archive: fetch for https, the file system for file:// (never http). */
async function readArchive(url: string): Promise<Buffer> {
  try {
    if (url.startsWith('file://')) {
      return fs.readFileSync(fileURLToPath(url));
    }
    if (!url.startsWith('https://')) {
      throw new Error('only https:// and file:// archive URLs are allowed');
    }
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new GrammarBuildError(
      'archive_fetch_failed',
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Extract an archive into the existing directory `workDir`, stripping one leading directory.
 * Relative paths plus a cwd that holds both: GNU tar on Windows parses a drive letter such as
 * C: as a remote host, so an absolute Windows path must never reach tar (assumption A2).
 */
function extractArchive(archive: Buffer, workDir: string): void {
  const holder = path.dirname(workDir);
  const archiveName = `${path.basename(workDir)}.archive.tar.gz`;
  fs.writeFileSync(path.join(holder, archiveName), archive);
  try {
    const result = spawnSync(
      'tar',
      ['-xzf', archiveName, '-C', path.basename(workDir), '--strip-components=1'],
      { cwd: holder, encoding: 'utf8' },
    );
    if (result.error !== undefined || result.status !== 0) {
      const reason = result.error?.message ?? result.stderr;
      throw new GrammarBuildError('extract_failed', `tar -xzf ${archiveName} failed: ${reason}`);
    }
  } finally {
    fs.rmSync(path.join(holder, archiveName), { force: true });
  }
}

function applyPatch(patchRelative: string, patchFile: string, dir: string): void {
  if (!fs.existsSync(patchFile)) {
    throw new GrammarBuildError('patch_failed', `patch ${patchRelative} does not exist`);
  }
  // git apply works outside a repository and is on every runner; argument array, no shell.
  const result = spawnSync('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: dir, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr.trim();
    throw new GrammarBuildError('patch_failed', `patch ${patchRelative} does not apply: ${reason}`);
  }
}

/**
 * Put the grammar source for `lock` into the fresh directory `workDir` (never inside the repo)
 * and apply the lock's patches in order. Local sources are copied from the module directory;
 * upstream sources are fetched, checked against `archiveSha256` and extracted. The shipped
 * product never reaches this code: it is explicit dev-time build tooling.
 */
export async function prepareSource(
  lock: GrammarLock,
  moduleDir: string,
  workDir: string,
): Promise<PreparedSource> {
  if (lock.license.trim() === '') {
    throw new GrammarBuildError('lock_invalid', 'license must be an SPDX id');
  }
  fs.mkdirSync(workDir, { recursive: true });
  let dir = workDir;
  if (lock.source.type === 'local') {
    const from = path.join(moduleDir, lock.source.path);
    if (!fs.existsSync(path.join(from, 'grammar.js'))) {
      throw new GrammarBuildError('source_missing', `no grammar.js under ${from}`);
    }
    fs.cpSync(from, workDir, { recursive: true });
  } else {
    const archive = await readArchive(lock.source.url);
    const actual = sha256Hex(archive);
    if (actual !== lock.source.archiveSha256) {
      throw new GrammarBuildError(
        'archive_hash_mismatch',
        `${lock.source.url}: expected ${lock.source.archiveSha256}, got ${actual}`,
      );
    }
    extractArchive(archive, workDir);
    if (lock.source.subdir !== undefined) {
      dir = path.join(workDir, lock.source.subdir);
    }
    if (!fs.existsSync(path.join(dir, 'grammar.js'))) {
      throw new GrammarBuildError('source_missing', `no grammar.js under ${dir} after extraction`);
    }
  }
  for (const patch of lock.patches) {
    applyPatch(patch, path.join(moduleDir, patch), dir);
  }
  return { dir, patchesApplied: lock.patches.length };
}

function run(binary: string, args: string[], cwd: string, code: GrammarBuildErrorCode): void {
  const result = spawnSync(binary, args, {
    cwd,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 15 * 60 * 1000,
  });
  if (result.error !== undefined) {
    throw new GrammarBuildError(code, `${binary} ${args.join(' ')}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new GrammarBuildError(code, `${binary} ${args.join(' ')} exited ${String(result.status)}`);
  }
}

/** generate --abi 15, then build --wasm into `outFile`. Needs the wasi toolchain (CLI downloads it). */
export function buildWasm(cliBinary: string, workDir: string, outFile: string): void {
  run(cliBinary, ['generate', '--abi', GENERATE_ABI], workDir, 'generate_failed');
  run(cliBinary, ['build', '--wasm', '-o', outFile], workDir, 'build_failed');
}

export interface BuiltModule {
  readonly lock: GrammarLock;
  readonly wasm: Buffer;
  readonly sha256: string;
  readonly patchesApplied: number;
}

export function readLock(moduleDir: string): GrammarLock {
  const lockPath = path.join(moduleDir, 'grammar.lock');
  if (!fs.existsSync(lockPath)) {
    throw new GrammarBuildError('lock_invalid', `no grammar.lock in ${moduleDir}`);
  }
  const parsed = parseGrammarLock(fs.readFileSync(lockPath, 'utf8'), lockPath);
  if (!parsed.ok) {
    throw new GrammarBuildError('lock_invalid', parsed.diagnostics.map((d) => d.message).join('; '));
  }
  return parsed.lock;
}

/** Build one module's wasm in a throwaway temp directory and return its bytes and hash. */
export async function buildModule(moduleDir: string, cliBinary: string): Promise<BuiltModule> {
  const lock = readLock(moduleDir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-grammar-'));
  try {
    const workDir = path.join(root, 'src');
    fs.mkdirSync(workDir);
    const prepared = await prepareSource(lock, moduleDir, workDir);
    const outFile = path.join(root, 'grammar.wasm');
    buildWasm(cliBinary, prepared.dir, outFile);
    const wasm = fs.readFileSync(outFile);
    return { lock, wasm, sha256: sha256Hex(wasm), patchesApplied: prepared.patchesApplied };
  } finally {
    removeDir(root);
  }
}

/** Every directory under modules/ and test/fixtures/modules/ that holds a grammar.lock. */
export function discoverModules(): string[] {
  const found: string[] = [];
  for (const base of [path.join(repoRoot, 'modules'), path.join(repoRoot, 'test', 'fixtures', 'modules')]) {
    if (!fs.existsSync(base)) {
      continue;
    }
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const dir = path.join(base, entry.name);
      if (entry.isDirectory() && fs.existsSync(path.join(dir, 'grammar.lock'))) {
        found.push(dir);
      }
    }
  }
  return found.sort();
}

/** Stable key order (the schema's), LF endings, trailing newline. */
export function serializeLock(lock: GrammarLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

async function main(argv: string[]): Promise<number> {
  const updateLock = argv.includes('--update-lock');
  const report = argv.includes('--report');
  const requested = argv.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
  const modules = requested.length > 0 ? requested : discoverModules();
  if (modules.length === 0) {
    process.stderr.write('grammar-build: no module with a grammar.lock found\n');
    return 1;
  }
  let status = 0;
  for (const moduleDir of modules) {
    const lock = readLock(moduleDir);
    const cli = ensureTreeSitter(lock);
    const built = await buildModule(moduleDir, cli.binary);
    if (report) {
      process.stdout.write(
        `${JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          cli: cli.version,
          abi: lock.abi,
          name: lock.name,
          license: lock.license,
          sha256: built.sha256,
          bytes: built.wasm.length,
          patchesApplied: built.patchesApplied,
        })}\n`,
      );
      continue;
    }
    const wasmPath = path.join(moduleDir, lock.wasm.file);
    if (updateLock) {
      fs.writeFileSync(wasmPath, built.wasm);
      const next: GrammarLock = { ...lock, wasm: { file: lock.wasm.file, sha256: built.sha256 } };
      fs.writeFileSync(path.join(moduleDir, 'grammar.lock'), serializeLock(next));
      process.stdout.write(`${lock.name}: wrote ${lock.wasm.file} (${built.wasm.length} bytes) sha256 ${built.sha256}\n`);
      continue;
    }
    const mismatch = checkAgainstLock(lock, built.sha256);
    if (mismatch !== null) {
      process.stderr.write(`${mismatch}\n`);
      status = 1;
      continue;
    }
    fs.writeFileSync(wasmPath, built.wasm);
    process.stdout.write(`${lock.name}: ok sha256 ${built.sha256}\n`);
  }
  return status;
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`grammar-build: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
