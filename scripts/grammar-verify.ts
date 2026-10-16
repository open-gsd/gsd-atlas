import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';
import type { GrammarLock } from '../src/lang/grammar-lock.ts';
import { ensureTreeSitter } from './ensure-tree-sitter.ts';
import { buildModule, discoverModules, readLock, sha256Hex } from './grammar-build.ts';

/**
 * node scripts/grammar-verify.ts [moduleDir...]
 *
 * Proves the pinned hash is reproducible: every module is built twice from source into two
 * different temp directories, and both hashes must equal each other, grammar.lock and the
 * committed wasm (FND-04, ROADMAP SC3). Exits non-zero on any mismatch.
 */

/** Null when all four values agree; otherwise the failure text naming every value. */
export function compareHashes(
  lock: GrammarLock,
  firstBuild: string,
  secondBuild: string,
  committed: string,
): string | null {
  if (firstBuild === secondBuild && firstBuild === lock.wasm.sha256 && firstBuild === committed) {
    return null;
  }
  return (
    `grammar verify failed for ${lock.name} on ${process.platform}/${process.arch}\n` +
    `  expected (grammar.lock): ${lock.wasm.sha256}\n` +
    `  first build:             ${firstBuild}\n` +
    `  second build:            ${secondBuild}\n` +
    `  committed ${lock.wasm.file}: ${committed}`
  );
}

async function loadAbiVersion(wasm: Uint8Array): Promise<number> {
  await Parser.init();
  return (await Language.load(wasm)).abiVersion;
}

async function verifyModule(moduleDir: string): Promise<string | null> {
  const lock = readLock(moduleDir);
  const cli = ensureTreeSitter(lock);
  // Two builds, each in its own mkdtemp directory, so a path leaking into the wasm shows up.
  const first = await buildModule(moduleDir, cli.binary);
  const second = await buildModule(moduleDir, cli.binary);
  const committedBytes = fs.readFileSync(path.join(moduleDir, lock.wasm.file));
  const failure = compareHashes(lock, first.sha256, second.sha256, sha256Hex(committedBytes));
  if (failure !== null) {
    return failure;
  }
  const abi = await loadAbiVersion(new Uint8Array(committedBytes));
  if (abi !== lock.abi) {
    return `grammar verify failed for ${lock.name}: committed wasm has ABI ${String(abi)}, grammar.lock says ${String(lock.abi)}`;
  }
  process.stdout.write(`${lock.name}: verified sha256 ${first.sha256} (abi ${String(abi)}, cli ${cli.version})\n`);
  return null;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

async function main(argv: string[]): Promise<number> {
  const requested = argv.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
  const modules = requested.length > 0 ? requested : discoverModules();
  if (modules.length === 0) {
    process.stderr.write('grammar-verify: no module with a grammar.lock found\n');
    return 1;
  }
  let status = 0;
  for (const moduleDir of modules) {
    const failure = await verifyModule(moduleDir);
    if (failure !== null) {
      process.stderr.write(`${failure}\n`);
      status = 1;
    }
  }
  return status;
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`grammar-verify: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
