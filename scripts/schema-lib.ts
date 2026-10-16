/**
 * Logic behind `scripts/schema-build.ts`, kept importable so tests can run the schema
 * build and drift check in-process (src/ must not spawn child processes, FND-06).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestJsonSchema } from '../src/lang/manifest.ts';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultTarget = path.join('schemas', 'atlas-lang.schema.json');

export interface SchemaBuildResult {
  status: 0 | 1;
  stdout: string;
  stderr: string;
}

/** Run the schema build (or `--check`) for the given CLI arguments and report the outcome. */
export function runSchemaBuild(args: string[]): SchemaBuildResult {
  const check = args.includes('--check');
  const positional = args.filter((a) => !a.startsWith('--'));
  const target = path.resolve(root, positional[0] ?? defaultTarget);

  const generated = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;

  if (check) {
    let current: string;
    try {
      // Normalise CRLF so a Windows checkout with core.autocrlf does not read as drift.
      current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      return { status: 1, stdout: '', stderr: `${target} is missing. Run: npm run schema:build\n` };
    }
    if (current !== generated) {
      return {
        status: 1,
        stdout: '',
        stderr: `${target} is out of date with src/lang/manifest.ts. Run: npm run schema:build\n`,
      };
    }
    return { status: 0, stdout: `${path.relative(root, target)} is current.\n`, stderr: '' };
  }

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, generated, 'utf8');
  return { status: 0, stdout: `wrote ${path.relative(root, target)}\n`, stderr: '' };
}
