import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGrammarEngine } from '../src/grammar-engine/index.ts';
import { goldenFileName, readModuleInputs, renderGolden, serializeGolden } from '../src/lang/index.ts';

/**
 * node scripts/toy-goldens.ts --write [module folder]
 *
 * Renders `<fixture>.golden.json` for every fixture of a module (default: the toy module) from
 * the real Grammar Engine. This is an author convenience, not a check: the goldens it writes are
 * only trusted once the hand-verified numbers in src/lang/lang-test.e2e.test.ts agree with them.
 * If the engine and the hand-computed numbers disagree, the engine is wrong, not the numbers.
 */

const defaultModule = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', 'modules', 'toy');

export async function writeGoldens(moduleDir: string): Promise<string[]> {
  const inputs = readModuleInputs(moduleDir);
  if (!inputs.ok) {
    throw new Error(`cannot read the module: ${inputs.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`);
  }
  const engine = createGrammarEngine();
  const written: string[] = [];
  try {
    const grammar = await engine.load(inputs.input);
    const fixtureDir = path.join(moduleDir, 'fixtures');
    const names = fs
      .readdirSync(fixtureDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith('.golden.json'))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      // ignoreBOM keeps U+FEFF in the text; the engine strips it and reports hadBom.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(path.join(fixtureDir, name)));
      const golden = renderGolden(name, await grammar.run(text));
      const target = path.join(fixtureDir, goldenFileName(name));
      fs.writeFileSync(target, serializeGolden(golden));
      written.push(target);
    }
  } finally {
    await engine.dispose();
  }
  return written;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  const args = process.argv.slice(2);
  if (args[0] === '--write') {
    const moduleDir = path.resolve(args[1] ?? defaultModule);
    const written = await writeGoldens(moduleDir);
    process.stdout.write(`wrote ${String(written.length)} golden files under ${moduleDir}\n`);
  } else {
    process.stderr.write('usage: node scripts/toy-goldens.ts --write [module folder]\n');
    process.exitCode = 1;
  }
}
