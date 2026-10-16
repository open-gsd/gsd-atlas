/**
 * `gsd-atlas lang test <module folder>`: run a language module end to end (D-02, FND-11).
 *
 * The manifest is validated, the lock and wasm hash are checked, the grammar is loaded, the
 * module's queries run over every file in `<module>/fixtures`, and spans and captures are
 * compared with the checked-in `<fixture>.golden.json`. Every failure is a diagnostic in the
 * report; nothing here throws for bad module content (FND-03).
 *
 * The report carries no parse-quality number: that metric belongs to the CI budget job (D-02, D-06).
 */
import fs from 'node:fs';
import path from 'node:path';

import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { GrammarLoadError, GrammarRunError } from '../grammar-engine/index.ts';
import type { GrammarEngine, LoadedGrammar } from '../grammar-engine/index.ts';
import { GOLDEN_SUFFIX, compareGolden, goldenFileName, renderGolden } from './golden.ts';
import type { GoldenDifference } from './golden.ts';
import { readModuleFile, readModuleInputs } from './module-files.ts';
import { resolveModule } from './registry.ts';
import type { Roots } from './registry.ts';

export const FIXTURES_DIR = 'fixtures';

export interface LangTestFixtureResult {
  /** The fixture file name, relative to the module's fixtures folder. */
  readonly file: string;
  readonly ok: boolean;
}

export interface LangTestReport {
  readonly ok: boolean;
  /** The manifest name once it is known, otherwise the target as given. */
  readonly module: string;
  readonly fixtures: readonly LangTestFixtureResult[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface LangTestOptions {
  /**
   * A module folder (an existing directory, absolute or relative to the working directory) or a bare
   * module id, resolved through the registry over `roots`. A directory wins over an id of the same name.
   */
  readonly target: string;
  readonly roots: Roots;
  readonly engine: GrammarEngine;
}

/** UTF-8 decoder that keeps a leading U+FEFF (the engine strips it and reports `hadBom`) and rejects bad bytes. */
const FIXTURE_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ResolvedTarget {
  readonly dir: string;
  /** Registry diagnostics (skipped copies of the module) when the target was an id. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The one place a target becomes a module folder: an existing directory is a folder; a bare id
 * (no path separator) that is not a directory is looked up in the registry; anything else is not found.
 */
function resolveTarget(target: string, roots: Roots): ResolvedTarget | { readonly diagnostics: readonly Diagnostic[] } {
  if (target === '') {
    return { diagnostics: [] };
  }
  const dir = path.resolve(target);
  try {
    if (fs.statSync(dir).isDirectory()) {
      return { dir, diagnostics: [] };
    }
  } catch {
    // not an existing directory
  }
  if (!/[\\/]/.test(target)) {
    const found = resolveModule(roots, target);
    if (found.entry !== undefined) {
      return { dir: found.entry.dir, diagnostics: found.diagnostics };
    }
    return { diagnostics: found.diagnostics };
  }
  return { diagnostics: [] };
}

function show(value: unknown): string {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function mismatchMessage(file: string, difference: GoldenDifference): string {
  const where = difference.index < 0 ? `header field ${difference.field}` : `capture ${String(difference.index)} field ${difference.field}`;
  return `${file}: golden differs at ${where}: expected ${show(difference.expected)}, actual ${show(difference.actual)}`;
}

function listFixtures(moduleDir: string): { readonly files: readonly string[] } | { readonly diagnostic: Diagnostic } {
  let names: string[];
  try {
    names = fs
      .readdirSync(path.join(moduleDir, FIXTURES_DIR), { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && !entry.name.endsWith(GOLDEN_SUFFIX))
      .map((entry) => entry.name);
  } catch (error) {
    return { diagnostic: diagnostic('fixture_unreadable', 'error', `${FIXTURES_DIR}: cannot list the fixtures folder (${reasonOf(error)})`, FIXTURES_DIR) };
  }
  if (names.length === 0) {
    return { diagnostic: diagnostic('fixture_unreadable', 'error', `${FIXTURES_DIR}: the fixtures folder has no fixture files, so nothing can be tested`, FIXTURES_DIR) };
  }
  // Code-unit order, so the report is the same on every platform and locale.
  return { files: names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}

async function testFixture(moduleDir: string, grammar: LoadedGrammar, file: string): Promise<Diagnostic[]> {
  const subject = `${FIXTURES_DIR}/${file}`;
  const source = readModuleFile(moduleDir, subject, 'fixture');
  if (!source.ok) {
    return [source.diagnostic];
  }
  let text: string;
  try {
    text = FIXTURE_DECODER.decode(source.bytes);
  } catch {
    return [diagnostic('fixture_unreadable', 'error', `${subject}: is not valid UTF-8`, subject)];
  }

  const goldenPath = `${FIXTURES_DIR}/${goldenFileName(file)}`;
  const goldenRead = readModuleFile(moduleDir, goldenPath, 'golden');
  if (!goldenRead.ok) {
    return [goldenRead.diagnostic];
  }
  let expected: unknown;
  try {
    expected = JSON.parse(goldenRead.bytes.toString('utf8'));
  } catch (error) {
    return [diagnostic('golden_invalid', 'error', `${goldenPath}: not valid JSON (${reasonOf(error)})`, goldenPath)];
  }

  let actual;
  try {
    actual = renderGolden(file, await grammar.run(text));
  } catch (error) {
    if (error instanceof GrammarRunError) {
      return [diagnostic(error.code, 'error', `${subject}: ${error.message}`, subject)];
    }
    throw error;
  }
  const difference = compareGolden(expected, actual);
  return difference === null ? [] : [diagnostic('golden_mismatch', 'error', mismatchMessage(file, difference), goldenPath)];
}

export async function runLangTest(options: LangTestOptions): Promise<LangTestReport> {
  const resolved = resolveTarget(options.target, options.roots);
  if (!('dir' in resolved)) {
    return {
      ok: false,
      module: options.target,
      fixtures: [],
      diagnostics: [
        ...resolved.diagnostics,
        diagnostic('module_not_found', 'error', `${options.target}: is not an existing module folder or a known module id`, options.target),
      ],
    };
  }
  const moduleDir = resolved.dir;

  const inputs = readModuleInputs(moduleDir);
  if (!inputs.ok) {
    return { ok: false, module: options.target, fixtures: [], diagnostics: [...resolved.diagnostics, ...inputs.diagnostics] };
  }
  const moduleName = inputs.manifest.name;

  let grammar: LoadedGrammar | undefined;
  try {
    try {
      grammar = await options.engine.load(inputs.input);
    } catch (error) {
      const code = error instanceof GrammarLoadError ? error.code : 'lang_test_failed';
      return {
        ok: false,
        module: moduleName,
        fixtures: [],
        diagnostics: [...resolved.diagnostics, diagnostic(code, 'error', reasonOf(error), inputs.manifest.grammar.wasm)],
      };
    }

    const listing = listFixtures(moduleDir);
    if ('diagnostic' in listing) {
      return { ok: false, module: moduleName, fixtures: [], diagnostics: [...resolved.diagnostics, listing.diagnostic] };
    }

    const fixtures: LangTestFixtureResult[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const file of listing.files) {
      const problems = await testFixture(moduleDir, grammar, file);
      fixtures.push({ file, ok: problems.length === 0 });
      diagnostics.push(...problems);
    }
    // Registry warnings about skipped copies are informative; only the fixtures decide pass or fail.
    return { ok: diagnostics.length === 0, module: moduleName, fixtures, diagnostics: [...resolved.diagnostics, ...diagnostics] };
  } catch (error) {
    return {
      ok: false,
      module: moduleName,
      fixtures: [],
      diagnostics: [diagnostic('lang_test_failed', 'error', `lang test stopped unexpectedly (${reasonOf(error)})`, options.target)],
    };
  } finally {
    await grammar?.dispose();
  }
}
