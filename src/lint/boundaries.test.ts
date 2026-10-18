import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';

// Repo root resolved from this file: src/lint/boundaries.test.ts -> ../..
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });
const RULES = new Set(['no-restricted-imports', 'no-restricted-syntax', 'no-console']);

/** Lint `code` as if it lived at `relPath` (no file needs to exist) and return boundary messages. */
async function violations(code: string, relPath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, relPath) });
  assert.ok(result, 'ESLint returned no result for ' + relPath);
  const fatal = result.messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], 'fixture failed to parse: ' + JSON.stringify(fatal));
  return result.messages.filter((m) => m.ruleId !== null && RULES.has(m.ruleId)).map((m) => m.ruleId + ': ' + m.message);
}

interface Case {
  /** Appears at the start of the test name; the acceptance check looks for these group words. */
  group: string;
  /** Short description of the case. */
  what: string;
  /** Virtual path of the linted file. */
  at: string;
  /** One import or call statement (a control may combine a few). */
  code: string;
  /** Expected outcome: a violation, or a clean pass (positive control). */
  expect: 'fail' | 'pass';
  /** Optional rule id the violation must come from. */
  rule?: 'no-restricted-imports' | 'no-restricted-syntax' | 'no-console';
  /** Optional text the violation message must contain. */
  says?: string;
}

const imp = (spec: string, name = 'x'): string => `import * as ${name} from '${spec}';\nvoid ${name};`;
const reexport = (spec: string): string => `export * from '${spec}';`;
const PARSE_CALL = `declare const parser: { parse(s: string): unknown };\nparser.parse('x');`;

interface ConfigExports {
  MODULES: string[];
  SQLITE_OWNERS: string[];
  ADAPTERS: string[];
  CLOSED_IMPORTS: Record<string, { allow: string[]; builtins: boolean }>;
  TEST_CONTEXT_FILES: Record<string, string[]>;
}

const CASES: Case[] = [
  // Rule 1: child_process only in src/command-runner.
  { group: 'child_process', what: 'import in fact-store fails', at: 'src/fact-store/x.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'child_process', what: 'bare specifier in source-tree fails', at: 'src/source-tree/x.ts', code: imp('child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'child_process', what: 'import in command-runner passes (control)', at: 'src/command-runner/x.ts', code: imp('node:child_process'), expect: 'pass' },
  { group: 'child_process', what: 'test file outside command-runner still fails', at: 'src/lang/lang.test.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'child_process', what: 'test file inside command-runner passes (control)', at: 'src/command-runner/runner.test.ts', code: imp('node:child_process'), expect: 'pass' },

  // Rule 2: SQLite drivers and src/sqlite are private.
  { group: 'sqlite', what: 'src/sqlite import from source-tree fails', at: 'src/source-tree/x.ts', code: imp('../sqlite/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'src/sqlite import from fact-store passes (control)', at: 'src/fact-store/x.ts', code: imp('../sqlite/index.ts'), expect: 'pass' },
  { group: 'sqlite', what: 'src/sqlite import from metrics passes (control)', at: 'src/metrics/x.ts', code: imp('../sqlite/index.ts'), expect: 'pass' },
  { group: 'sqlite', what: 'src/sqlite import from sdk passes (control)', at: 'src/sdk/x.ts', code: imp('../sqlite/index.ts'), expect: 'pass' },
  { group: 'sqlite', what: 'node:sqlite import in fact-store fails', at: 'src/fact-store/x.ts', code: imp('node:sqlite'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'better-sqlite3 import in lang fails', at: 'src/lang/x.ts', code: imp('better-sqlite3'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'node:sqlite and better-sqlite3 inside src/sqlite pass (control)', at: 'src/sqlite/x.ts', code: imp('node:sqlite') + '\n' + imp('better-sqlite3', 'y'), expect: 'pass' },

  // Rule 3: cross-module imports go through index.ts only (D-12).
  { group: 'index.ts', what: 'deep import of another module fails', at: 'src/source-tree/x.ts', code: imp('../fact-store/writer/commit.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'index.ts', what: 'import through index.ts passes (control)', at: 'src/source-tree/x.ts', code: imp('../fact-store/index.ts'), expect: 'pass' },
  { group: 'index.ts', what: 'sibling relative import inside own module passes (control)', at: 'src/fact-store/x.ts', code: imp('./helper.ts'), expect: 'pass' },
  { group: 'index.ts', what: 'parent relative import inside own module passes (control)', at: 'src/fact-store/writer/x.ts', code: imp('../writer/commit.ts'), expect: 'pass' },

  // Rule 4: policy imports only facts, and is pure (no bare imports) in production.
  { group: 'policy', what: 'importing fact-store fails', at: 'src/policy/x.ts', code: imp('../fact-store/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'policy', what: 'importing node:fs fails', at: 'src/policy/x.ts', code: imp('node:fs'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'policy', what: 'importing facts passes (control)', at: 'src/policy/x.ts', code: imp('../facts/index.ts'), expect: 'pass' },
  { group: 'policy', what: 'test file may import node:test (control)', at: 'src/policy/x.test.ts', code: imp('node:test'), expect: 'pass' },
  { group: 'policy', what: 'test file may not import child_process', at: 'src/policy/x.test.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'policy', what: 'test file may not import fact-store', at: 'src/policy/x.test.ts', code: imp('../fact-store/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },

  // Rule 5: adapters import only host-client.
  { group: 'adapter', what: 'cli importing grammar-engine fails', at: 'src/cli/x.ts', code: imp('../grammar-engine/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'adapter', what: 'cli importing facts fails', at: 'src/cli/x.ts', code: imp('../facts/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'adapter', what: 'cli importing lang fails', at: 'src/cli/x.ts', code: imp('../lang/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'adapter', what: 'cli importing host-client passes (control)', at: 'src/cli/x.ts', code: imp('../host-client/index.ts'), expect: 'pass' },
  { group: 'adapter', what: 'cli may import node: built-ins (control)', at: 'src/cli/x.ts', code: imp('node:path'), expect: 'pass' },
  { group: 'adapter', what: 'mcp-shim importing grammar-engine fails', at: 'src/mcp-shim/x.ts', code: imp('../grammar-engine/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'adapter', what: 'mcp-shim importing facts fails', at: 'src/mcp-shim/x.ts', code: imp('../facts/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'adapter', what: 'mcp-shim importing host-client passes (control)', at: 'src/mcp-shim/x.ts', code: imp('../host-client/index.ts'), expect: 'pass' },
  { group: 'adapter', what: 'cli test file may use the test kit (control)', at: 'src/cli/x.test.ts', code: imp('../test-kit/index.ts'), expect: 'pass' },
  { group: 'adapter', what: 'cli test file still may not import lang', at: 'src/cli/x.test.ts', code: imp('../lang/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },

  // Dynamic import() and require() are invisible to no-restricted-imports (T-01-07).
  { group: 'dynamic', what: 'await import of child_process fails', at: 'src/lang/x.ts', code: `await import('node:child_process');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'dynamic', what: 'require of child_process fails', at: 'src/lang/x.ts', code: `require('child_process');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'dynamic', what: 'await import of child_process inside command-runner passes (control)', at: 'src/command-runner/x.ts', code: `await import('node:child_process');`, expect: 'pass' },
  { group: 'dynamic', what: 'await import of node:sqlite outside src/sqlite fails', at: 'src/fact-store/x.ts', code: `await import('node:sqlite');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'dynamic', what: 'require of better-sqlite3 outside src/sqlite fails', at: 'src/fact-store/x.ts', code: `require('better-sqlite3');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'dynamic', what: 'await import of node:sqlite inside src/sqlite passes (control)', at: 'src/sqlite/x.ts', code: `await import('node:sqlite');`, expect: 'pass' },
  { group: 'dynamic', what: 'await import of an ordinary built-in passes (control)', at: 'src/lang/x.ts', code: `await import('node:path');`, expect: 'pass' },

  // Composition root: src/bin may import every module through index.ts but keeps the process, driver and deep-import rules.
  { group: 'bin', what: 'composition root importing cli and grammar-engine passes (control)', at: 'src/bin/x.ts', code: imp('../cli/index.ts') + '\n' + imp('../grammar-engine/index.ts', 'y'), expect: 'pass' },
  { group: 'bin', what: 'composition root importing child_process fails', at: 'src/bin/x.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'bin', what: 'composition root deep import fails', at: 'src/bin/x.ts', code: imp('../cli/run.ts'), expect: 'fail', rule: 'no-restricted-imports' },

  // Parser guard: only src/grammar-engine/with-tree.ts calls parse (PITFALLS B1).
  { group: 'parse', what: 'parser.parse in grammar-engine/run.ts fails', at: 'src/grammar-engine/run.ts', code: PARSE_CALL, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'parse', what: 'chained member parse call in grammar-engine fails', at: 'src/grammar-engine/run.ts', code: `declare const a: { b: { parse(s: string): unknown } };\na.b.parse('x');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'parse', what: 'parser.parse in grammar-engine/with-tree.ts passes (control)', at: 'src/grammar-engine/with-tree.ts', code: PARSE_CALL, expect: 'pass' },
  { group: 'parse', what: 'JSON.parse in grammar-engine passes (control)', at: 'src/grammar-engine/run.ts', code: `JSON.parse('1');`, expect: 'pass' },
  { group: 'parse', what: 'parser.parse in a grammar-engine test file fails', at: 'src/grammar-engine/x.test.ts', code: PARSE_CALL, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'parse', what: 'with-tree.ts keeps the other selectors (dynamic child_process still fails)', at: 'src/grammar-engine/with-tree.ts', code: `await import('node:child_process');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'parse', what: 'a parse call outside grammar-engine is out of scope (control)', at: 'src/lang/x.ts', code: PARSE_CALL, expect: 'pass' },

  // Leaf properties: facts and test-kit are lint-enforced leaves (D-12).
  { group: 'leaf', what: 'facts importing a seam (fact-store) fails', at: 'src/facts/x.ts', code: imp('../fact-store/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'leaf', what: 'facts importing test-kit fails and says it is test code', at: 'src/facts/x.ts', code: imp('../test-kit/index.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'test code' },
  { group: 'leaf', what: 'facts importing an npm package (zod) fails', at: 'src/facts/x.ts', code: imp('zod'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'leaf', what: 'facts importing a relative file passes (control)', at: 'src/facts/x.ts', code: imp('./span.ts'), expect: 'pass' },
  { group: 'leaf', what: 'facts importing a node: built-in passes (control)', at: 'src/facts/x.ts', code: imp('node:crypto'), expect: 'pass' },
  { group: 'leaf', what: 'facts test file may import node:test (control)', at: 'src/facts/x.test.ts', code: imp('node:test'), expect: 'pass' },
  { group: 'leaf', what: 'facts test file still may not import an npm package', at: 'src/facts/x.test.ts', code: imp('zod'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'leaf', what: 'test-kit importing command-runner fails (a command-runner to test-kit cycle is impossible)', at: 'src/test-kit/x.ts', code: imp('../command-runner/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'leaf', what: 'test-kit importing facts passes (control)', at: 'src/test-kit/x.ts', code: imp('../facts/index.ts'), expect: 'pass' },
  { group: 'leaf', what: 'test-kit importing node:fs passes (control)', at: 'src/test-kit/x.ts', code: imp('node:fs'), expect: 'pass' },
  { group: 'leaf', what: 'test-kit importing child_process still fails', at: 'src/test-kit/x.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'leaf', what: 'test-kit importing an npm package fails', at: 'src/test-kit/x.ts', code: imp('zod'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'leaf', what: 'test-kit test file importing command-runner still fails', at: 'src/test-kit/x.test.ts', code: imp('../command-runner/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },

  // Production purity: shipped code never loads test code (T-01-42).
  { group: 'purity', what: 'index.ts re-exporting a contract file fails', at: 'src/command-runner/index.ts', code: reexport('./contract.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'test code' },
  { group: 'purity', what: 'node:test in a non-test file fails (static)', at: 'src/command-runner/index.ts', code: imp('node:test'), expect: 'fail', rule: 'no-restricted-imports', says: 'test code' },
  { group: 'purity', what: 'node:test in a non-test file fails (dynamic)', at: 'src/command-runner/index.ts', code: `await import('node:test');`, expect: 'fail', rule: 'no-restricted-syntax', says: 'test code' },
  { group: 'purity', what: 'node:test in a non-test file fails (require)', at: 'src/command-runner/index.ts', code: `require('node:test');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'purity', what: 'test-kit in a non-test file fails (static)', at: 'src/command-runner/index.ts', code: imp('../test-kit/index.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'test code' },
  { group: 'purity', what: 'test-kit in a non-test file fails (dynamic)', at: 'src/command-runner/index.ts', code: `await import('../test-kit/index.ts');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'purity', what: 'contract file in a non-test file fails (dynamic)', at: 'src/command-runner/index.ts', code: `await import('./contract.ts');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'purity', what: 'node:test in the bin entry point fails', at: 'src/bin/x.ts', code: imp('node:test'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'purity', what: 'test-kit in the cli fails', at: 'src/cli/x.ts', code: imp('../test-kit/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'purity', what: 'test file may import its own contract, node:test and test-kit (control)', at: 'src/command-runner/runner.test.ts', code: imp('./contract.ts') + '\n' + imp('node:test', 'y') + '\n' + imp('../test-kit/index.ts', 'z'), expect: 'pass' },
  { group: 'purity', what: 'contract file may import its own contract, node:test and test-kit (control)', at: 'src/command-runner/contract.ts', code: imp('./contract.ts') + '\n' + imp('node:test', 'y') + '\n' + imp('../test-kit/index.ts', 'z'), expect: 'pass' },
  { group: 'purity', what: 'sqlite contract file may import test-kit (control)', at: 'src/sqlite/contract.ts', code: imp('../test-kit/index.ts'), expect: 'pass' },
  { group: 'purity', what: 'test file may dynamically import node:test (control)', at: 'src/command-runner/runner.test.ts', code: `await import('node:test');`, expect: 'pass' },
  { group: 'purity', what: 'cross-module contract import from a test file still fails (D-12 stays literal)', at: 'src/source-tree/source-tree.test.ts', code: imp('../command-runner/contract.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'purity', what: 'cross-module index.ts import from a test file passes (control)', at: 'src/source-tree/source-tree.test.ts', code: imp('../command-runner/index.ts'), expect: 'pass' },

  // Phase 2 modules: indexer, query, tenant and host get the boundary blocks from their first file.
  { group: 'index.ts', what: 'host deep-importing indexer fails', at: 'src/host/x.ts', code: imp('../indexer/queue.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'index.ts', what: 'host importing indexer through index.ts passes (control)', at: 'src/host/x.ts', code: imp('../indexer/index.ts'), expect: 'pass' },
  { group: 'index.ts', what: 'indexer deep-importing fact-store fails', at: 'src/indexer/x.ts', code: imp('../fact-store/writer/commit.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'index.ts', what: 'indexer importing fact-store through index.ts passes (control)', at: 'src/indexer/x.ts', code: imp('../fact-store/index.ts'), expect: 'pass' },
  { group: 'index.ts', what: 'query deep-importing fact-store fails', at: 'src/query/x.ts', code: imp('../fact-store/reader.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'index.ts', what: 'query importing fact-store through index.ts passes (control)', at: 'src/query/x.ts', code: imp('../fact-store/index.ts'), expect: 'pass' },
  { group: 'index.ts', what: 'tenant deep-importing host fails', at: 'src/tenant/x.ts', code: imp('../host/server.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'index.ts', what: 'tenant importing host through index.ts passes (control)', at: 'src/tenant/x.ts', code: imp('../host/index.ts'), expect: 'pass' },
  { group: 'index.ts', what: 'source-tree deep-importing query fails', at: 'src/source-tree/x.ts', code: imp('../query/engine.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'index.ts', what: 'a test file in tenant deep-importing indexer still fails', at: 'src/tenant/x.test.ts', code: imp('../indexer/queue.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'index.ts', what: 'a test file in host importing query through index.ts passes (control)', at: 'src/host/x.test.ts', code: imp('../query/index.ts'), expect: 'pass' },
  { group: 'sqlite', what: 'indexer importing node:sqlite fails', at: 'src/indexer/x.ts', code: imp('node:sqlite'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'indexer importing src/sqlite fails (indexer is not a SQLite owner)', at: 'src/indexer/x.ts', code: imp('../sqlite/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'query importing src/sqlite fails', at: 'src/query/x.ts', code: imp('../sqlite/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'tenant importing src/sqlite fails', at: 'src/tenant/x.ts', code: imp('../sqlite/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'host importing better-sqlite3 fails', at: 'src/host/x.ts', code: imp('better-sqlite3'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'sqlite', what: 'host dynamically importing node:sqlite fails', at: 'src/host/x.ts', code: `await import('node:sqlite');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'child_process', what: 'host importing child_process fails', at: 'src/host/x.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'purity', what: 'node:test in a non-test indexer file fails', at: 'src/indexer/x.ts', code: imp('node:test'), expect: 'fail', rule: 'no-restricted-imports', says: 'test code' },
  { group: 'purity', what: 'node:test in a host test file passes (control)', at: 'src/host/x.test.ts', code: imp('node:test'), expect: 'pass' },

  // Phase 3 module: diagnostics (SKL-03, SKL-04) has its walls before it has code. No process, no SQLite, no deep
  // imports, and no adapter reaches it (adapters import only host-client).
  { group: 'diagnostics', what: 'importing node:child_process fails (no process)', at: 'src/diagnostics/x.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'importing node:sqlite fails (no database)', at: 'src/diagnostics/x.ts', code: imp('node:sqlite'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'importing better-sqlite3 fails (no database)', at: 'src/diagnostics/x.ts', code: imp('better-sqlite3'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'importing src/sqlite fails (not a SQLite owner)', at: 'src/diagnostics/x.ts', code: imp('../sqlite/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'dynamic import of node:child_process fails', at: 'src/diagnostics/x.ts', code: `await import('node:child_process');`, expect: 'fail', rule: 'no-restricted-syntax' },
  { group: 'diagnostics', what: 'deep import of fact-store fails and names index.ts', at: 'src/diagnostics/x.ts', code: imp('../fact-store/types.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'diagnostics', what: 'importing facts through index.ts passes (control)', at: 'src/diagnostics/x.ts', code: imp('../facts/index.ts'), expect: 'pass' },
  { group: 'diagnostics', what: 'importing an npm package (zod) passes (control)', at: 'src/diagnostics/x.ts', code: imp('zod'), expect: 'pass' },
  { group: 'diagnostics', what: 'production file may not import node:test or the test kit', at: 'src/diagnostics/x.ts', code: imp('node:test') + '\n' + imp('../test-kit/index.ts', 'y'), expect: 'fail', rule: 'no-restricted-imports', says: 'test code' },
  { group: 'diagnostics', what: 'test file may import node:test and the test kit (control)', at: 'src/diagnostics/x.test.ts', code: imp('node:test') + '\n' + imp('../test-kit/index.ts', 'y'), expect: 'pass' },
  { group: 'diagnostics', what: 'test file may not import child_process', at: 'src/diagnostics/x.test.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'cli importing diagnostics fails (adapters import only host-client)', at: 'src/cli/x.ts', code: imp('../diagnostics/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'mcp-shim importing diagnostics fails (adapters import only host-client)', at: 'src/mcp-shim/x.ts', code: imp('../diagnostics/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'cli test file importing diagnostics still fails', at: 'src/cli/x.test.ts', code: imp('../diagnostics/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'diagnostics', what: 'host importing diagnostics through index.ts passes (control)', at: 'src/host/x.ts', code: imp('../diagnostics/index.ts'), expect: 'pass' },
  { group: 'diagnostics', what: 'host deep-importing diagnostics fails and names index.ts', at: 'src/host/x.ts', code: imp('../diagnostics/bundle.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'diagnostics', what: 'facts importing diagnostics fails (facts stays a leaf)', at: 'src/facts/x.ts', code: imp('../diagnostics/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },

  // Phase 3 module: project-model (TSM-07) is a compiler-free reader of repository configuration. It may use the shared
  // kernel, Source Tree types and jsonc-parser, but its production files may never reach the TypeScript package (nor
  // run a process or open a database); its test files may, because the differential test needs the compiler.
  { group: 'project-model', what: 'importing typescript in a production file fails and names TSM-07', at: 'src/project-model/x.ts', code: imp('typescript'), expect: 'fail', rule: 'no-restricted-imports', says: 'TSM-07' },
  { group: 'project-model', what: 'importing a typescript subpath in a production file fails', at: 'src/project-model/x.ts', code: imp('typescript/lib/typescript.js'), expect: 'fail', rule: 'no-restricted-imports', says: 'TSM-07' },
  { group: 'project-model', what: 'importing the typescript-7 alias in a production file fails', at: 'src/project-model/x.ts', code: imp('typescript-7'), expect: 'fail', rule: 'no-restricted-imports', says: 'TSM-07' },
  { group: 'project-model', what: 'dynamic import of typescript in a production file fails', at: 'src/project-model/x.ts', code: `await import('typescript');`, expect: 'fail', rule: 'no-restricted-syntax', says: 'TSM-07' },
  { group: 'project-model', what: 'require of typescript in a production file fails', at: 'src/project-model/x.ts', code: `require('typescript');`, expect: 'fail', rule: 'no-restricted-syntax', says: 'TSM-07' },
  { group: 'project-model', what: 'importing jsonc-parser passes (control)', at: 'src/project-model/x.ts', code: imp('jsonc-parser'), expect: 'pass' },
  { group: 'project-model', what: 'importing the facts kernel and Source Tree through index.ts passes (control)', at: 'src/project-model/x.ts', code: imp('../facts/index.ts') + '\n' + imp('../source-tree/index.ts', 'y'), expect: 'pass' },
  { group: 'project-model', what: 'a test file may import typescript for the differential (control)', at: 'src/project-model/x.test.ts', code: imp('typescript'), expect: 'pass' },
  { group: 'project-model', what: 'a test file may dynamically import typescript (control)', at: 'src/project-model/x.test.ts', code: `await import('typescript');`, expect: 'pass' },
  { group: 'project-model', what: 'typescript stays importable in other modules (the restriction is local)', at: 'src/lang/x.ts', code: imp('typescript'), expect: 'pass' },
  { group: 'project-model', what: 'importing node:child_process fails (no process)', at: 'src/project-model/x.ts', code: imp('node:child_process'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'project-model', what: 'importing node:sqlite fails (no database)', at: 'src/project-model/x.ts', code: imp('node:sqlite'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'project-model', what: 'deep import of source-tree fails and names index.ts', at: 'src/project-model/x.ts', code: imp('../source-tree/read-text.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'project-model', what: 'cli importing project-model fails (adapters import only host-client)', at: 'src/cli/x.ts', code: imp('../project-model/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },
  { group: 'project-model', what: 'host importing project-model through index.ts passes (control)', at: 'src/host/x.ts', code: imp('../project-model/index.ts'), expect: 'pass' },
  { group: 'project-model', what: 'host deep-importing project-model fails and names index.ts', at: 'src/host/x.ts', code: imp('../project-model/tsconfig.ts'), expect: 'fail', rule: 'no-restricted-imports', says: 'index.ts' },
  { group: 'project-model', what: 'facts importing project-model fails (facts stays a leaf)', at: 'src/facts/x.ts', code: imp('../project-model/index.ts'), expect: 'fail', rule: 'no-restricted-imports' },

  // No stray console output: stdout carries protocol frames (HST-01, research Pitfall 8). process.stdout.write is the
  // sanctioned path and is not a console call.
  { group: 'console', what: 'console.log in query fails', at: 'src/query/x.ts', code: `console.log('x');`, expect: 'fail', rule: 'no-console' },
  { group: 'console', what: 'console.log in a query test file fails', at: 'src/query/x.test.ts', code: `console.log('x');`, expect: 'fail', rule: 'no-console' },
  { group: 'console', what: 'console.error in host fails', at: 'src/host/x.ts', code: `console.error('x');`, expect: 'fail', rule: 'no-console' },
  { group: 'console', what: 'console.log in the cli fails (the rule covers every module)', at: 'src/cli/x.ts', code: `console.log('x');`, expect: 'fail', rule: 'no-console' },
  { group: 'console', what: 'console.log in an indexer contract file fails', at: 'src/indexer/contract.ts', code: `console.log('x');`, expect: 'fail', rule: 'no-console' },
  { group: 'console', what: 'process.stdout.write in host passes (control)', at: 'src/host/x.ts', code: `process.stdout.write('x');`, expect: 'pass' },
  { group: 'console', what: 'process.stderr.write in query passes (control)', at: 'src/query/x.ts', code: `process.stderr.write('x');`, expect: 'pass' },
];

for (const c of CASES) {
  test(`${c.group}: ${c.what}`, async () => {
    const v = await violations(c.code, c.at);
    if (c.expect === 'pass') {
      assert.deepEqual(v, [], `${c.at} should lint clean`);
      return;
    }
    assert.ok(v.length > 0, `${c.at} should report a boundary violation`);
    const rule = c.rule;
    if (rule !== undefined) assert.ok(v.some((m) => m.startsWith(rule + ':')), `expected ${rule}, got ${JSON.stringify(v)}`);
    const says = c.says;
    if (says !== undefined) assert.ok(v.some((m) => m.includes(says)), `expected a message containing "${says}", got ${JSON.stringify(v)}`);
  });
}

test('config exports the documented tables', async () => {
  const config = (await import(pathToFileURL(path.join(root, 'eslint.config.js')).href)) as ConfigExports;
  assert.equal(new Set(config.MODULES).size, config.MODULES.length, 'MODULES has duplicates');
  assert.equal(config.MODULES.length, 23);
  for (const m of ['indexer', 'query', 'tenant', 'host', 'diagnostics', 'project-model']) {
    assert.ok(config.MODULES.includes(m), `MODULES lacks ${m}`);
    assert.deepEqual(config.TEST_CONTEXT_FILES[m], [`src/${m}/**/*.test.ts`, `src/${m}/**/contract.ts`]);
  }
  assert.ok(!config.SQLITE_OWNERS.some((m) => ['indexer', 'query', 'tenant', 'host', 'diagnostics', 'project-model'].includes(m)), 'a new module became a SQLite owner');
  assert.ok(!config.ADAPTERS.some((m) => ['indexer', 'query', 'tenant', 'host', 'diagnostics', 'project-model'].includes(m)), 'a new module became an adapter');
  assert.ok(!('diagnostics' in config.CLOSED_IMPORTS), 'diagnostics became a closed module');
  assert.ok(!('project-model' in config.CLOSED_IMPORTS), 'project-model became a closed module');
  assert.deepEqual(config.CLOSED_IMPORTS.facts, { allow: [], builtins: true });
  assert.deepEqual(config.CLOSED_IMPORTS['test-kit'], { allow: ['facts'], builtins: true });
  assert.deepEqual(config.CLOSED_IMPORTS.policy, { allow: ['facts'], builtins: false });
  assert.deepEqual(config.TEST_CONTEXT_FILES.lang, ['src/lang/**/*.test.ts', 'src/lang/**/contract.ts']);
  assert.deepEqual([...config.SQLITE_OWNERS].sort(), ['fact-store', 'metrics', 'sdk', 'sqlite']);
  assert.deepEqual([...config.ADAPTERS].sort(), ['cli', 'mcp-shim']);
});

test('real tree: every src/**/*.ts file has zero boundary violations', async () => {
  const results = await eslint.lintFiles(['src/**/*.ts']);
  assert.ok(results.length > 0, 'expected the real src tree to contain TypeScript files');
  const found = results.flatMap((r) =>
    r.messages
      .filter((m) => m.ruleId !== null && RULES.has(m.ruleId))
      .map((m) => `${path.relative(root, r.filePath)}:${m.line} ${m.ruleId}: ${m.message}`),
  );
  assert.deepEqual(found, []);
});
