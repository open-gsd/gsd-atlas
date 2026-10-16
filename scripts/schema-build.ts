/**
 * Render the language-module manifest JSON Schema from the Zod source (D-05).
 *
 *   node scripts/schema-build.ts [file]            write the schema (LF endings)
 *   node scripts/schema-build.ts --check [file]    exit 1 if the file differs from the generated text
 *
 * `file` defaults to schemas/atlas-lang.schema.json; the argument exists so the drift
 * check can be tested without touching the committed file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestJsonSchema } from '../src/lang/manifest.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const positional = args.filter((a) => !a.startsWith('--'));
const target = path.resolve(root, positional[0] ?? path.join('schemas', 'atlas-lang.schema.json'));

const generated = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;

if (check) {
  let current: string;
  try {
    // Normalise CRLF so a Windows checkout with core.autocrlf does not read as drift.
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    console.error(`${target} is missing. Run: npm run schema:build`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(`${target} is out of date with src/lang/manifest.ts. Run: npm run schema:build`);
    process.exit(1);
  }
  console.log(`${path.relative(root, target)} is current.`);
} else {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, generated, 'utf8');
  console.log(`wrote ${path.relative(root, target)}`);
}
