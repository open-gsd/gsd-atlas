import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';
import { expectedPlatformSha256 } from '../src/lang/grammar-lock.ts';
import type { GrammarLock } from '../src/lang/grammar-lock.ts';
import { ensureTreeSitter } from './ensure-tree-sitter.ts';
import { buildModule, discoverModules, readLock, sha256Hex } from './grammar-build.ts';

/**
 * node scripts/grammar-verify.ts [moduleDir...]
 *
 * Proves the pinned hashes are reproducible: every module is built twice from source into two
 * different temp directories, and both hashes must equal each other and this platform's
 * grammar.lock entry (wasm.platforms). Separately the committed wasm must hash to the
 * committed-wasm value (wasm.sha256), so the shipped artifact stays pinned on every OS
 * (FND-04, ROADMAP SC3). Exits non-zero on any mismatch or when this platform has no entry.
 */

/**
 * Null when this platform's two rebuilds agree with each other and with this platform's
 * grammar.lock entry (wasm.platforms), AND the committed wasm matches the committed-wasm hash
 * (wasm.sha256). The two checks are independent: on a platform whose toolchain emits different
 * bytes (win32-x64) the rebuild differs from the committed wasm by design, yet the shipped
 * artifact stays pinned. A platform with no entry fails; it never passes silently.
 */
export function compareHashes(
  lock: GrammarLock,
  firstBuild: string,
  secondBuild: string,
  committed: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const expected = expectedPlatformSha256(lock, platform, arch);
  if (!expected.ok) {
    return `grammar verify failed: ${expected.message}`;
  }
  if (firstBuild === secondBuild && firstBuild === expected.sha256 && committed === lock.wasm.sha256) {
    return null;
  }
  return (
    `grammar verify failed for ${lock.name} on ${expected.key}\n` +
    `  expected rebuild (grammar.lock wasm.platforms.${expected.key}): ${expected.sha256}\n` +
    `  first build:             ${firstBuild}\n` +
    `  second build:            ${secondBuild}\n` +
    `  expected committed (grammar.lock wasm.sha256): ${lock.wasm.sha256}\n` +
    `  committed ${lock.wasm.file}: ${committed}`
  );
}

async function loadAbiVersion(wasm: Uint8Array): Promise<number> {
  await Parser.init();
  return (await Language.load(wasm)).abiVersion;
}

async function verifyModule(moduleDir: string): Promise<string | null> {
  const lock = readLock(moduleDir);
  const expected = expectedPlatformSha256(lock);
  if (!expected.ok) {
    // Fail before the slow toolchain download and builds: an unrecorded platform cannot pass.
    return `grammar verify failed: ${expected.message}`;
  }
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
  process.stdout.write(
    `${lock.name}: verified ${expected.key} rebuild sha256 ${first.sha256}; committed ${lock.wasm.file} sha256 ${lock.wasm.sha256} ` +
      `(abi ${String(abi)}, cli ${cli.version})\n`,
  );
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
