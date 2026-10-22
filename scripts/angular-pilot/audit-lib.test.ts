import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyGrepOnlyFile,
  finalDeclarer,
  heritageHits,
  importOrigin,
  lineKinds,
  resolveSpecifier,
  type FileView,
} from './audit-lib.ts';

const FILES: Record<string, string> = {
  'packages/a/index.ts': "export * from './src/util';\n",
  'packages/a/renamed.ts': "export { helper as renamedHelper } from './src/util';\n",
  'packages/a/src/util.ts': 'export function target(n: number) { return n; }\nexport function helper() {}\n',
  'packages/b/index.ts': "export { target } from '@x/a';\n",
  'packages/c/own.ts': 'export function target() {}\nexport const z = target();\n',
};
const view: FileView = { read: (p) => FILES[p], exists: (p) => p in FILES };

describe('lineKinds', () => {
  it('classifies each line that spells the name as comment, string, import, export, member or code', () => {
    const text = [
      "import { a, target as t } from './x';", // 1 import
      'import {', // 2
      '  b,', // 3
      '  target,', // 4 import (inside a multi-line import)
      "} from './y';", // 5
      '// calls target(1)', // 6 comment
      '/*', // 7
      ' * target is documented here', // 8 comment
      ' */', // 9
      "const s = 'target';", // 10 string
      'const v = target(2);', // 11 code
      'const w = other.target(3);', // 12 member
      'const o = { target: 1 };', // 13 key
      "export { target } from './z';", // 14 export-from
      'export { target };', // 15 export-local
      'foo(); // target here', // 16 comment (trailing)
    ].join('\n');
    const kinds = Object.fromEntries(lineKinds(text, 'target').map((k) => [k.line, k.kind]));
    assert.deepEqual(kinds, {
      1: 'import',
      4: 'import',
      6: 'comment',
      8: 'comment',
      10: 'string',
      11: 'code',
      12: 'member',
      13: 'key',
      14: 'export-from',
      15: 'export-local',
      16: 'comment',
    });
  });
});

describe('resolveSpecifier', () => {
  it('resolves relative paths and the @angular path mapping to a tracked file', () => {
    assert.equal(resolveSpecifier('packages/a/src/x.ts', './util', view), 'packages/a/src/util.ts');
    assert.equal(resolveSpecifier('packages/b/index.ts', '@x/a', view, { '@x/': 'packages/' }), 'packages/a/index.ts');
    assert.equal(resolveSpecifier('packages/b/index.ts', 'rxjs', view, { '@x/': 'packages/' }), undefined);
  });
});

describe('finalDeclarer', () => {
  it('follows export-star and renaming re-exports to the file that declares the name', () => {
    assert.equal(finalDeclarer('packages/a/index.ts', 'helper', view, { '@x/': 'packages/' }), 'packages/a/src/util.ts');
    assert.equal(finalDeclarer('packages/b/index.ts', 'target', view, { '@x/': 'packages/' }), 'packages/a/src/util.ts');
    assert.equal(finalDeclarer('packages/a/renamed.ts', 'renamedHelper', view), 'packages/a/src/util.ts');
    assert.equal(finalDeclarer('packages/a/index.ts', 'nothing', view), undefined);
    assert.equal(finalDeclarer('packages/c/own.ts', 'target', view), 'packages/c/own.ts');
  });
});

describe('importOrigin', () => {
  it('finds the declaring file of an imported name, also through an alias', () => {
    const text = "import { target as t } from '@x/a';\nt(1);\n";
    assert.deepEqual(importOrigin(text, 'packages/d/u.ts', 'target', view, { '@x/': 'packages/' }), { alias: 't', declarer: 'packages/a/src/util.ts' });
    assert.equal(importOrigin("import { z } from './q';", 'packages/d/u.ts', 'target', view), undefined);
  });
});

describe('classifyGrepOnlyFile', () => {
  const target = 'packages/a/src/util.ts';
  it('comment or string mentions only', () => {
    assert.equal(classifyGrepOnlyFile({ file: 'packages/d/u.ts', text: "// target\nconst s = 'target';\n", name: 'target', targetFile: target, view }).klass, 'comment-or-string');
  });
  it('import or re-export only', () => {
    assert.equal(classifyGrepOnlyFile({ file: 'packages/b/index.ts', text: FILES['packages/b/index.ts']!, name: 'target', targetFile: target, view, aliases: { '@x/': 'packages/' } }).klass, 'reexport-or-import-only');
  });
  it('a different symbol: own declaration or an import chain that ends elsewhere', () => {
    assert.equal(classifyGrepOnlyFile({ file: 'packages/c/own.ts', text: FILES['packages/c/own.ts']!, name: 'target', targetFile: target, view }).klass, 'different-symbol');
    const text = "import { target } from './own';\ntarget();\n";
    assert.equal(classifyGrepOnlyFile({ file: 'packages/c/use.ts', text, name: 'target', targetFile: target, view }).klass, 'different-symbol');
  });
  it('flags a file that imports the target and uses it as a possible miss of the key', () => {
    const text = "import { target } from '@x/a';\ntarget();\n";
    assert.equal(classifyGrepOnlyFile({ file: 'packages/d/u.ts', text, name: 'target', targetFile: target, view, aliases: { '@x/': 'packages/' } }).klass, 'refers-to-target');
  });
  it('an aliased import that is used is a possible miss, an unused one is not', () => {
    const used = "import { target as t } from '@x/a';\nt();\n";
    assert.equal(classifyGrepOnlyFile({ file: 'packages/d/u.ts', text: used, name: 'target', targetFile: target, view, aliases: { '@x/': 'packages/' } }).klass, 'refers-to-target');
    const unused = "import { target as t } from '@x/a';\n";
    assert.equal(classifyGrepOnlyFile({ file: 'packages/d/u.ts', text: unused, name: 'target', targetFile: target, view, aliases: { '@x/': 'packages/' } }).klass, 'reexport-or-import-only');
  });
  it('the declaring file itself is reported as such', () => {
    assert.equal(classifyGrepOnlyFile({ file: target, text: FILES[target]!, name: 'target', targetFile: target, view }).klass, 'declaring-file');
  });
  it('leaves anything else for a human', () => {
    assert.equal(classifyGrepOnlyFile({ file: 'packages/d/u.ts', text: 'const v = obj.target(1);\n', name: 'target', targetFile: target, view }).klass, 'manual');
  });
});

describe('heritageHits', () => {
  it('finds classes and interfaces whose extends or implements clause names the symbol, multi-line and generic', () => {
    const text = [
      'export class A extends Base<string> {}',
      'export class B',
      '  extends Other',
      '  implements Base, Third {',
      '}',
      'export interface C extends Base {}',
      'export class D extends BaseX {}',
      '// class E extends Base {}',
      '',
    ].join('\n');
    assert.deepEqual(heritageHits(text, ['Base']).map((h) => `${h.cls}:${h.line}`), ['A:1', 'B:2', 'C:6']);
  });
});
