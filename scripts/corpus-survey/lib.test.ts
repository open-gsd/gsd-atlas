import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentConfigPaths,
  ambiguityStats,
  classifyLicense,
  classifySpecifier,
  extractExportedNames,
  extractSpecifiers,
  isBarrel,
  isTestPath,
  percentile,
  rankBySeed,
} from './lib.ts';

test('percentile uses nearest rank on unsorted input', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([7], 90), 7);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test('rankBySeed is deterministic, order independent, and seed dependent', () => {
  const items = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
  const a = rankBySeed(items, 'seed-1', 10);
  const b = rankBySeed([...items].reverse(), 'seed-1', 10);
  const c = rankBySeed(items, 'seed-2', 10);
  assert.deepEqual(a, b);
  assert.equal(a.length, 10);
  assert.notDeepEqual(a, c);
  assert.equal(rankBySeed(items, 'seed-1', 500).length, 50);
});

test('extractExportedNames finds exported functions, classes, consts and re-declared names', () => {
  const src = [
    'export function alpha() {}',
    'export async function beta() {}',
    'export class Gamma {}',
    'export abstract class Delta {}',
    'export const eps = 1, zeta = () => 2;',
    'export let eta = 1;',
    'const hidden = 1;',
    'function notExported() {}',
    'export default function theta() {}',
    'export interface Iota {}',
    'export type Kappa = number;',
    'export { hidden as lambda, notExported };',
    "export { mu } from './x';",
  ].join('\n');
  const names = extractExportedNames(src, 'a.ts');
  for (const n of ['alpha', 'beta', 'Gamma', 'Delta', 'eps', 'zeta', 'eta', 'theta']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  for (const n of ['hidden', 'notExported', 'Iota', 'Kappa']) {
    assert.ok(!names.includes(n), `unexpected ${n}`);
  }
});

test('extractExportedNames sees CommonJS exports in .js and .cjs files', () => {
  const src = [
    'function one() {}',
    'const two = 2;',
    'module.exports = { one, two, three: two };',
    'exports.four = function () {};',
    'module.exports.five = 5;',
  ].join('\n');
  const names = extractExportedNames(src, 'a.cjs');
  assert.deepEqual([...names].sort(), ['five', 'four', 'one', 'three', 'two']);
});

test('extractExportedNames does not throw on broken source', () => {
  assert.doesNotThrow(() => extractExportedNames('export function (', 'bad.ts'));
});

test('ambiguityStats counts names declared in more than one file', () => {
  const map = new Map<string, string[]>([
    ['a.ts', ['x', 'y']],
    ['b.ts', ['x', 'z']],
    ['c.ts', ['x', 'x']],
  ]);
  const s = ambiguityStats(map);
  assert.equal(s.distinctNames, 3);
  assert.equal(s.multiFileNames, 1);
  assert.equal(s.declarations, 6);
});

test('isTestPath recognises common test and fixture locations', () => {
  for (const p of ['src/a.test.ts', 'src/a.spec.tsx', 'tests/x.ts', 'pkg/__tests__/y.js', 'test/z.ts', 'a/fixtures/b.ts', 'a/b.test.cjs']) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ['src/latest.ts', 'src/contest/a.ts', 'src/protest.ts']) {
    assert.equal(isTestPath(p), false, p);
  }
});

test('agentConfigPaths lists agent configuration files that a clean checkout must strip', () => {
  const paths = ['CLAUDE.md', 'src/a.ts', '.claude/settings.json', 'sub/AGENTS.md', '.mcp.json', '.cursor/rules/x.mdc', '.github/copilot-instructions.md', 'docs/claude.md', 'GEMINI.md', '.cursorrules'];
  assert.deepEqual(agentConfigPaths(paths).sort(), ['.claude/settings.json', '.cursor/rules/x.mdc', '.cursorrules', '.github/copilot-instructions.md', '.mcp.json', 'CLAUDE.md', 'GEMINI.md', 'sub/AGENTS.md'].sort());
});

test('classifyLicense maps licence text to an SPDX id or flags it', () => {
  assert.equal(classifyLicense('MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy'), 'MIT');
  assert.equal(classifyLicense('Apache License\nVersion 2.0, January 2004'), 'Apache-2.0');
  assert.equal(classifyLicense('GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007'), 'AGPL-3.0');
  assert.equal(classifyLicense('Redistribution and use in source and binary forms, with or without modification ... Neither the name'), 'BSD-3-Clause');
  assert.equal(classifyLicense('Sustainable Use License\nVersion 1.0'), 'LicenseRef-SUL-1.0 (fair-code, not OSI)');
  assert.equal(classifyLicense('something else entirely'), 'UNCLEAR');
});

test('classifySpecifier separates relative, workspace and external imports', () => {
  const ws = new Set(['@scope/core', 'tool']);
  assert.equal(classifySpecifier('./a', ws), 'relative');
  assert.equal(classifySpecifier('../a/b', ws), 'relative');
  assert.equal(classifySpecifier('@scope/core', ws), 'workspace');
  assert.equal(classifySpecifier('@scope/core/sub/path', ws), 'workspace');
  assert.equal(classifySpecifier('tool/x', ws), 'workspace');
  assert.equal(classifySpecifier('react', ws), 'external');
  assert.equal(classifySpecifier('@other/pkg', ws), 'external');
  assert.equal(classifySpecifier('node:fs', ws), 'external');
});

test('extractSpecifiers returns static import, export-from, require and dynamic import specifiers', () => {
  const src = [
    "import a from './a';",
    "import type { B } from '@s/b';",
    "export * from './c';",
    "export { d } from 'dd';",
    "const e = require('ee');",
    "const f = await import('./f');",
    'const g = require(someVar);',
    "import h = require('hh');",
  ].join('\n');
  assert.deepEqual(extractSpecifiers(src, 'a.ts').sort(), ['./a', './c', './f', '@s/b', 'dd', 'ee', 'hh'].sort());
});

test('isBarrel is true when most statements are re-exports', () => {
  assert.equal(isBarrel("export * from './a';\nexport { b } from './b';\nexport * from './c';", 'index.ts'), true);
  assert.equal(isBarrel("export * from './a';\nexport function f() {}\nconst x = 1;\nfunction g() {}", 'index.ts'), false);
  assert.equal(isBarrel('', 'index.ts'), false);
});
