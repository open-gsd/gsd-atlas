import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

// Repo root resolved from this file: src/lint/boundaries.test.ts -> ../..
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });
const RULES = new Set(['no-restricted-imports', 'no-restricted-syntax']);

/** Lint `code` as if it lived at `relPath` (no file needs to exist) and return boundary messages. */
async function violations(code: string, relPath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, relPath) });
  assert.ok(result, 'ESLint returned no result for ' + relPath);
  const fatal = result.messages.filter((m) => m.fatal);
  assert.deepEqual(fatal, [], 'fixture failed to parse: ' + JSON.stringify(fatal));
  return result.messages.filter((m) => m.ruleId !== null && RULES.has(m.ruleId)).map((m) => m.ruleId + ': ' + m.message);
}

test('child_process: import outside src/command-runner fails lint', async () => {
  const v = await violations(`import { spawn } from 'node:child_process';\nvoid spawn;`, 'src/fact-store/x.ts');
  assert.ok(v.some((m) => m.startsWith('no-restricted-imports')), 'expected no-restricted-imports, got ' + JSON.stringify(v));
});

test('child_process: the same import inside src/command-runner passes', async () => {
  const v = await violations(`import { spawn } from 'node:child_process';\nvoid spawn;`, 'src/command-runner/x.ts');
  assert.deepEqual(v, []);
});
