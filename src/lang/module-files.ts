/**
 * The one confined reader for language-module files (T-01-12, second half; FND-05).
 *
 * A module folder is untrusted data. Every file the manifest names (the manifest itself, the
 * lock, the wasm and each query) is resolved with `realpath` and must land inside the module
 * folder's own realpath, so a symlink or junction pointing elsewhere is rejected rather than read.
 * Realpaths are compared, never raw strings. Reads are size-capped. Bad module content never
 * throws: it becomes diagnostics and the module is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';

import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { GRAMMAR_LIMITS } from '../grammar-engine/index.ts';
import type { GrammarInput } from '../grammar-engine/index.ts';
import { parseGrammarLock } from './grammar-lock.ts';
import type { GrammarLock } from './grammar-lock.ts';
import { parseManifest } from './manifest.ts';
import type { Manifest } from './manifest.ts';

export const MANIFEST_FILE = 'atlas-lang.json';

export type ReadModuleInputsResult =
  | {
      readonly ok: true;
      readonly manifest: Manifest;
      readonly lock: GrammarLock;
      readonly input: GrammarInput;
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

type FileRole = 'manifest' | 'lock' | 'wasm' | 'query';

interface RoleSpec {
  readonly missing: string;
  readonly tooLarge: string;
  readonly cap: number;
}

const ROLES: Readonly<Record<FileRole, RoleSpec>> = {
  manifest: { missing: 'manifest_unreadable', tooLarge: 'manifest_too_large', cap: GRAMMAR_LIMITS.manifestBytes },
  lock: { missing: 'lock_missing', tooLarge: 'lock_invalid', cap: GRAMMAR_LIMITS.manifestBytes },
  wasm: { missing: 'wasm_missing', tooLarge: 'wasm_too_large', cap: GRAMMAR_LIMITS.wasmBytes },
  query: { missing: 'query_missing', tooLarge: 'query_too_large', cap: GRAMMAR_LIMITS.queryBytes },
};

type ConfinedRead = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly diagnostic: Diagnostic };

function isInside(rootReal: string, candidateReal: string): boolean {
  return candidateReal === rootReal || candidateReal.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read `relative` (a module-relative path) with containment and size checks. Never throws. */
function confinedRead(rootReal: string, moduleDir: string, relative: string, role: FileRole): ConfinedRead {
  const spec = ROLES[role];
  const subject = relative;
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(moduleDir, relative));
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(spec.missing, 'warning', `${relative}: not found or not readable (${reasonOf(error)})`, subject) };
  }
  // Compare realpaths, never the raw strings: a symlink or junction inside the folder can point out of it.
  if (!isInside(rootReal, real) || real === rootReal) {
    return { ok: false, diagnostic: diagnostic('path_escape', 'warning', `${relative}: resolves outside the module folder and was not read`, subject) };
  }
  let fd: number | undefined;
  try {
    fd = fs.openSync(real, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      return { ok: false, diagnostic: diagnostic(spec.missing, 'warning', `${relative}: is not a regular file`, subject) };
    }
    if (stat.size > spec.cap) {
      return { ok: false, diagnostic: diagnostic(spec.tooLarge, 'warning', `${relative}: ${String(stat.size)} bytes is over the ${String(spec.cap)} byte cap`, subject) };
    }
    // One byte of slack detects a file that grew between fstat and read.
    const buffer = Buffer.alloc(stat.size + 1);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (read > stat.size) {
      return { ok: false, diagnostic: diagnostic(spec.tooLarge, 'warning', `${relative}: changed size while being read`, subject) };
    }
    return { ok: true, bytes: buffer.subarray(0, read) };
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(spec.missing, 'warning', `${relative}: could not be read (${reasonOf(error)})`, subject) };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/**
 * Read a module's manifest, lock, wasm and queries into a GrammarInput. Returns diagnostics
 * (codes: manifest_unreadable, manifest_too_large, manifest_invalid, lock_missing, lock_invalid,
 * wasm_missing, wasm_too_large, query_missing, query_too_large, path_escape) instead of throwing.
 */
export function readModuleInputs(moduleDir: string): ReadModuleInputsResult {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(moduleDir);
    if (!fs.statSync(rootReal).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic('manifest_unreadable', 'warning', `${MANIFEST_FILE}: module folder is not readable (${reasonOf(error)})`, moduleDir)],
    };
  }

  const manifestRead = confinedRead(rootReal, moduleDir, MANIFEST_FILE, 'manifest');
  if (!manifestRead.ok) {
    return { ok: false, diagnostics: [manifestRead.diagnostic] };
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRead.bytes.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      diagnostics: [diagnostic('manifest_invalid', 'warning', `manifest: not valid JSON (${reasonOf(error)})`, MANIFEST_FILE)],
    };
  }
  const parsedManifest = parseManifest(manifestJson, MANIFEST_FILE);
  if (!parsedManifest.ok) {
    return { ok: false, diagnostics: parsedManifest.diagnostics };
  }
  const { manifest } = parsedManifest;

  // Independent reads: report every problem at once instead of one per run.
  const problems: Diagnostic[] = [];

  let lock: GrammarLock | undefined;
  const lockRead = confinedRead(rootReal, moduleDir, manifest.grammar.lock, 'lock');
  if (lockRead.ok) {
    const parsedLock = parseGrammarLock(lockRead.bytes.toString('utf8'), manifest.grammar.lock);
    if (parsedLock.ok) {
      lock = parsedLock.lock;
    } else {
      problems.push(...parsedLock.diagnostics);
    }
  } else {
    problems.push(lockRead.diagnostic);
  }

  const wasmRead = confinedRead(rootReal, moduleDir, manifest.grammar.wasm, 'wasm');
  if (!wasmRead.ok) {
    problems.push(wasmRead.diagnostic);
  }

  const queries: { tags?: string; refs?: string; imports?: string } = {};
  for (const kind of ['tags', 'refs', 'imports'] as const) {
    const relative = manifest.queries[kind];
    if (relative === undefined) {
      continue;
    }
    const queryRead = confinedRead(rootReal, moduleDir, relative, 'query');
    if (queryRead.ok) {
      queries[kind] = queryRead.bytes.toString('utf8');
    } else {
      problems.push(queryRead.diagnostic);
    }
  }

  if (problems.length > 0 || lock === undefined || !wasmRead.ok) {
    return { ok: false, diagnostics: problems };
  }
  return {
    ok: true,
    manifest,
    lock,
    input: {
      name: lock.name,
      wasm: new Uint8Array(wasmRead.bytes),
      expectedSha256: lock.wasm.sha256,
      queries,
    },
  };
}
