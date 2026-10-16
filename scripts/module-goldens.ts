import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createGrammarEngine } from '../src/grammar-engine/index.ts';
import { goldenFileName, readModuleInputs, renderGolden, serializeGolden } from '../src/lang/index.ts';

/**
 * node scripts/module-goldens.ts <moduleDir> [--check]
 *
 * Writes `<fixture>.golden.json` for every fixture of a module that the manifest's extensions
 * claim, rendered by the real Grammar Engine with the module's own queries. With `--check` it
 * writes nothing and exits 1 when a golden is missing or differs. Like scripts/toy-goldens.ts this
 * is an author convenience: a golden is only trusted once someone has read it against the fixture.
 */

export type GoldenStatus = 'written' | 'ok' | 'differs' | 'missing';

export interface GoldenOutcome {
  readonly fixture: string;
  readonly golden: string;
  readonly status: GoldenStatus;
}

function claimedFixtures(fixtureDir: string, extensions: readonly string[]): string[] {
  if (!fs.existsSync(fixtureDir)) {
    return [];
  }
  const wanted = new Set(extensions.map((e) => e.toLowerCase()));
  return fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.includes('.golden') && wanted.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();
}

/** Render (and write, or with `check` only compare) the golden of every claimed fixture. */
export async function syncGoldens(moduleDir: string, options: { readonly check?: boolean } = {}): Promise<GoldenOutcome[]> {
  const inputs = readModuleInputs(moduleDir);
  if (!inputs.ok) {
    throw new Error(`cannot read the module: ${inputs.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}`);
  }
  const fixtureDir = path.join(moduleDir, 'fixtures');
  const names = claimedFixtures(fixtureDir, inputs.manifest.extensions);
  if (names.length === 0) {
    throw new Error(`no fixture claimed by ${inputs.manifest.extensions.join(' ')} found in ${fixtureDir}`);
  }
  const engine = createGrammarEngine();
  const outcomes: GoldenOutcome[] = [];
  try {
    const grammar = await engine.load(inputs.input);
    for (const name of names) {
      // ignoreBOM keeps U+FEFF in the text; the engine strips it and reports hadBom.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(path.join(fixtureDir, name)));
      const rendered = serializeGolden(renderGolden(name, await grammar.run(text)));
      const goldenName = goldenFileName(name);
      const target = path.join(fixtureDir, goldenName);
      if (options.check === true) {
        const status: GoldenStatus = !fs.existsSync(target)
          ? 'missing'
          : fs.readFileSync(target, 'utf8') === rendered
            ? 'ok'
            : 'differs';
        outcomes.push({ fixture: name, golden: goldenName, status });
      } else {
        fs.writeFileSync(target, rendered);
        outcomes.push({ fixture: name, golden: goldenName, status: 'written' });
      }
    }
  } finally {
    await engine.dispose();
  }
  return outcomes;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const dirs = args.filter((a) => !a.startsWith('--'));
  if (dirs.length !== 1) {
    process.stderr.write('usage: node scripts/module-goldens.ts <moduleDir> [--check]\n');
    process.exitCode = 1;
  } else {
    try {
      const outcomes = await syncGoldens(path.resolve(dirs[0] as string), { check });
      for (const outcome of outcomes) {
        process.stdout.write(`${outcome.golden}: ${outcome.status}\n`);
      }
      if (outcomes.some((o) => o.status === 'differs' || o.status === 'missing')) {
        process.exitCode = 1;
      }
    } catch (error) {
      process.stderr.write(`module-goldens: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
