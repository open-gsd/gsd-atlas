import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { censusOfSource, createPilotOracle, type PilotOracle } from './oracle-lib.ts';

// A tiny workspace shaped like angular's: `@x/*` maps to `pkgs/*` through tsconfig paths with a baseUrl,
// one package imports an external package that is not installed (so its types are `any`).
const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@x/*': ['pkgs/*'] }, strict: true, experimentalDecorators: true },
  }),
  'pkgs/a/index.ts': `export * from './src/base';\nexport { helper } from './src/helper';\n`,
  'pkgs/a/src/base.ts': `export abstract class Base { abstract run(): void; }\nexport interface Runner { go(): void }\n`,
  'pkgs/a/src/helper.ts': `export function helper(n: number): number { return n + 1; }\n`,
  'pkgs/b/index.ts': [
    `import { Base, Runner, helper } from '@x/a';`,
    `import { Observable } from 'rxjs';`,
    `export class Impl extends Base { run(): void { helper(1); } }`,
    `export class Go implements Runner { go(): void { helper(2); } }`,
    `export function other(o: Observable<number>) { return o.pipe(); }`,
    `export const ref = helper;`,
    ``,
  ].join('\n'),
  'pkgs/b/index.spec.ts': `import { helper } from '@x/a';\nhelper(3);\n`,
  'pkgs/c/index.ts': `export function helper(): string { return 'other helper'; }\n`,
};

describe('censusOfSource', () => {
  it('lists exported top-level declarations and direct heritage, syntax only', () => {
    const c = censusOfSource('pkgs/a/src/base.ts', FILES['pkgs/a/src/base.ts']!);
    assert.deepEqual(
      c.decls.map((d) => [d.name, d.kind]),
      [
        ['Base', 'class'],
        ['Runner', 'interface'],
      ],
    );
    const b = censusOfSource('pkgs/b/index.ts', FILES['pkgs/b/index.ts']!);
    assert.deepEqual(b.heritage, [
      { cls: 'Impl', file: 'pkgs/b/index.ts', extends: ['Base'], implements: [], line: 3 },
      { cls: 'Go', file: 'pkgs/b/index.ts', extends: [], implements: ['Runner'], line: 4 },
    ]);
  });
});

describe('createPilotOracle', () => {
  let dir = '';
  let o: PilotOracle;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-oracle-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    o = createPilotOracle({
      root: dir,
      tsconfig: 'tsconfig.json',
      include: (rel) => rel.startsWith('pkgs/') && !rel.endsWith('.spec.ts'),
    });
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('references of the helper in pkgs/a follow paths and re-exports, and skip the same name in pkgs/c', () => {
    const refs = o.references('pkgs/a/src/helper.ts', 'helper');
    assert.deepEqual([...new Set(refs.map((r) => r.file))].sort(), ['pkgs/a/index.ts', 'pkgs/a/src/helper.ts', 'pkgs/b/index.ts']);
  });

  it('call sites are the references that are the callee of a call', () => {
    const calls = o.callSites('pkgs/a/src/helper.ts', 'helper');
    assert.deepEqual(calls.map((r) => `${r.file}:${r.line}`).sort(), ['pkgs/b/index.ts:3', 'pkgs/b/index.ts:4']);
  });

  it('direct implementers come from heritage clauses resolved by the checker', () => {
    assert.deepEqual(o.directSubtypes('pkgs/a/src/base.ts', 'Base').map((r) => r.cls), ['Impl']);
    assert.deepEqual(o.directSubtypes('pkgs/a/src/base.ts', 'Runner').map((r) => r.cls), ['Go']);
  });

  it('reports unresolved import specifiers (the source of any)', () => {
    assert.deepEqual(o.unresolvedSpecifiers(), [{ specifier: 'rxjs', files: 1 }]);
  });

  it('throws on a name that is not declared in the file', () => {
    assert.throws(() => o.references('pkgs/a/src/helper.ts', 'nope'), /not declared/);
  });
});
