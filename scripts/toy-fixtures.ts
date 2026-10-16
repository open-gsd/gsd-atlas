import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * node scripts/toy-fixtures.ts --write
 *
 * The toy module's fixture files are generated as Buffers so no editor or tool can normalise
 * the line endings or drop the BOM. Positions the goldens depend on (0-based line, 0-based
 * UTF-16 column, end exclusive):
 *   emoji.toy  string token  line 1 columns 4..10 (the emoji is 2 UTF-16 units, 4 UTF-8 bytes)
 *              name          line 2 columns 3..8
 *              call target   line 3 columns 2..6
 *   bom.toy    name `a`      line 0 columns 3..4 once the BOM is stripped
 */

const toyDir = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'modules', 'toy');

const BASIC_LF =
  '# a toy file\n' +
  'use "lib/util";\n' +
  'fn main {\n' +
  '  helper();\n' +
  '}\n' +
  'type Widget {\n' +
  '}\n';

const EMOJI_LF =
  '# unicode\n' +
  'use "a\u{1F600}b";\n' +
  'fn héllo {\n' +
  '  call();\n' +
  '}\n';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Keys are paths relative to the toy module directory. */
export const FIXTURES: Readonly<Record<string, Buffer>> = {
  'fixtures/basic.toy': Buffer.from(BASIC_LF, 'utf8'),
  'fixtures/emoji.toy': Buffer.from(EMOJI_LF, 'utf8'),
  'fixtures/crlf.toy': Buffer.from(BASIC_LF.replaceAll('\n', '\r\n'), 'utf8'),
  'fixtures/bom.toy': Buffer.concat([BOM, Buffer.from('fn a {\n}\n', 'utf8')]),
  // Outside the measured fixture set: the parse-budget negative test needs real ERROR nodes.
  'fixtures-negative/broken.toy': Buffer.from('fn ok {\n}\nfn ??? ((\n', 'utf8'),
};

export function writeFixtures(): void {
  for (const [relative, bytes] of Object.entries(FIXTURES)) {
    const target = path.join(toyDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  if (process.argv.includes('--write')) {
    writeFixtures();
    process.stdout.write(`wrote ${String(Object.keys(FIXTURES).length)} toy fixtures under ${toyDir}\n`);
  } else {
    process.stderr.write('usage: node scripts/toy-fixtures.ts --write\n');
    process.exitCode = 1;
  }
}
