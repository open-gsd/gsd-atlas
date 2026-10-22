import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createPilotOracle, type PilotOracle } from './oracle-lib.ts';
import { scopePredicate } from './sample-keys.ts';

// A workspace shaped like angular's `packages/` (paths map `@x/*` to `pkgs/*`). Line numbers matter: tests cite them.
const FILES: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@x/*': ['pkgs/*'] }, strict: true, experimentalDecorators: true },
  }),
  'pkgs/a/src/util.ts': [
    'export function target(n: number): number {',
    '  return n + 1;',
    '}',
    'export function wrapper(): number {',
    '  return target(1);',
    '}',
    'export interface Iface { x: number }',
    'export const TOKEN = Symbol("a");',
    'export abstract class Base { abstract run(): void }',
    'export function Dec(): ClassDecorator { return () => {}; }',
    '',
  ].join('\n'),
  'pkgs/a/index.ts': [
    "export { target, wrapper, Iface, TOKEN, Base, Dec } from './src/util';",
    "export { target as renamedTarget } from './src/util';",
    '',
  ].join('\n'),
  'pkgs/b/consumer.ts': [
    "import { target as t, Iface } from '@x/a';",
    'export const run = (): number => t(2);',
    'export function typed(v: Iface): number { return v.x; }',
    '',
  ].join('\n'),
  'pkgs/b/consumer.spec.ts': ["import { target } from '@x/a';", 'target(3);', ''].join('\n'),
  'pkgs/c/other.ts': "export function target(): string { return 'other'; }\n",
  'pkgs/c/use.ts': "import { target } from './other';\nexport const s = target();\n",
  'pkgs/c/base.ts': 'export abstract class Base {}\nexport class Other extends Base {}\n',
  'pkgs/d/mentions.ts': [
    '// calls target(1) in a comment',
    'export const text = "target";',
    'export const obj = { target: 1 };',
    'export const target2 = obj.target;',
    '',
  ].join('\n'),
  'pkgs/d/importonly.ts': ["import { target } from '@x/a';", 'export { target as again };', ''].join('\n'),
  'pkgs/d/viaagain.ts': ["import { again } from './importonly';", 'export const z = again(5);', ''].join('\n'),
  'pkgs/e/dec.ts': ["import { Dec } from '@x/a';", '@Dec()', 'export class Decorated {}', ''].join('\n'),
  'pkgs/f/f.ts': ["import { wrapper } from '@x/a';", 'export const w = wrapper();', ''].join('\n'),
  'pkgs/g/svc.ts': [
    "import { target } from '@x/a';",
    'export class Svc {',
    '  go(): number { return target(4); }',
    '}',
    '',
  ].join('\n'),
  'pkgs/h/h.ts': ["import { Svc } from '../g/svc';", 'export const h = new Svc().go();', ''].join('\n'),
  'pkgs/i/i.ts': ["import { run } from '../b/consumer';", 'export const r = run();', ''].join('\n'),
  'pkgs/j/anyuse.ts': ["import ext from 'not-installed';", 'export const e = ext.target(1);', ''].join('\n'),
  'pkgs/k/token.ts': [
    "import { TOKEN } from '@x/a';",
    'function inject(t: symbol): symbol { return t; }',
    'export const tk = inject(TOKEN);',
    '',
  ].join('\n'),
  'pkgs/l/sub.ts': [
    "import { Base } from '@x/a';",
    'export class Sub extends Base { run(): void {} }',
    'export class SubSub extends Sub {}',
    '',
  ].join('\n'),
  'pkgs/m/doc.ts': ["import { wrapper } from '@x/a';", '/** see {@link wrapper} */', 'export const nothing = 1;', ''].join('\n'),
};

const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

describe('oracle completion (spec files in scope)', () => {
  let dir = '';
  let withTests: PilotOracle;
  let noTests: PilotOracle;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-oracle2-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    withTests = createPilotOracle({ root: dir, tsconfig: 'tsconfig.json', include: (r) => r.startsWith('pkgs/') });
    noTests = createPilotOracle({ root: dir, tsconfig: 'tsconfig.json', include: (r) => r.startsWith('pkgs/') && !r.endsWith('.spec.ts') });
  });
  after(() => {
    withTests.dispose();
    noTests.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classifies references: definition, import, export, re-export, call, doc', () => {
    const roles = withTests.classifiedReferences('pkgs/a/src/util.ts', 'wrapper').map((r) => `${r.file}:${r.line}:${r.role}`);
    assert.ok(roles.includes('pkgs/a/src/util.ts:4:definition'));
    assert.ok(roles.includes('pkgs/a/index.ts:1:reexport'));
    assert.ok(roles.includes('pkgs/f/f.ts:1:import'));
    assert.ok(roles.includes('pkgs/f/f.ts:2:call'));
    assert.ok(roles.includes('pkgs/m/doc.ts:2:doc'));
    const imp = withTests.classifiedReferences('pkgs/a/src/util.ts', 'target').map((r) => `${r.file}:${r.line}:${r.role}`);
    assert.ok(imp.includes('pkgs/d/importonly.ts:2:export'));
  });

  it('callers: calls only, through aliases, in the declaring file, in specs; comments, strings, property keys and same-name symbols excluded', () => {
    const files = sorted(withTests.callSites('pkgs/a/src/util.ts', 'target').map((r) => r.file));
    assert.deepEqual(files, ['pkgs/a/src/util.ts', 'pkgs/b/consumer.spec.ts', 'pkgs/b/consumer.ts', 'pkgs/d/viaagain.ts', 'pkgs/g/svc.ts']);
  });

  it('the spec-file scope option removes spec files from the program', () => {
    const files = sorted(noTests.callSites('pkgs/a/src/util.ts', 'target').map((r) => r.file));
    assert.deepEqual(files, ['pkgs/a/src/util.ts', 'pkgs/b/consumer.ts', 'pkgs/d/viaagain.ts', 'pkgs/g/svc.ts']);
  });

  it('the other function of the same name has its own, different callers', () => {
    assert.deepEqual(sorted(withTests.callSites('pkgs/c/other.ts', 'target').map((r) => r.file)), ['pkgs/c/use.ts']);
  });

  it('decorator calls count as calls', () => {
    assert.deepEqual(sorted(withTests.callSites('pkgs/a/src/util.ts', 'Dec').map((r) => `${r.file}:${r.line}`)), ['pkgs/e/dec.ts:2']);
  });

  it('references count alias uses and type positions, not import, export or re-export specifiers, not doc links', () => {
    assert.deepEqual(sorted(withTests.referenceSites('pkgs/a/src/util.ts', 'target').map((r) => r.file)), [
      'pkgs/a/src/util.ts',
      'pkgs/b/consumer.spec.ts',
      'pkgs/b/consumer.ts',
      'pkgs/d/viaagain.ts',
      'pkgs/g/svc.ts',
    ]);
    // Iface: a type position counts for references, never for callers; the re-export in index.ts does not count.
    assert.deepEqual(sorted(withTests.referenceSites('pkgs/a/src/util.ts', 'Iface').map((r) => r.file)), ['pkgs/b/consumer.ts']);
    assert.deepEqual(withTests.callSites('pkgs/a/src/util.ts', 'Iface'), []);
    // import specifier plus doc link only: not a use
    assert.ok(!withTests.referenceSites('pkgs/a/src/util.ts', 'wrapper').some((r) => r.file === 'pkgs/m/doc.ts'));
  });

  it('a dependency-injection token passed to inject() is an ordinary reference', () => {
    assert.deepEqual(sorted(withTests.referenceSites('pkgs/a/src/util.ts', 'TOKEN').map((r) => r.file)), ['pkgs/k/token.ts']);
  });

  it('impact depth two: callers plus callers of the enclosing functions, methods and arrow consts, minus the target file', () => {
    const impact = withTests.impactDepthTwo('pkgs/a/src/util.ts', 'target');
    assert.deepEqual(impact.direct, ['pkgs/b/consumer.spec.ts', 'pkgs/b/consumer.ts', 'pkgs/d/viaagain.ts', 'pkgs/g/svc.ts']);
    assert.deepEqual(impact.viaCallers, ['pkgs/f/f.ts', 'pkgs/h/h.ts', 'pkgs/i/i.ts']);
    assert.deepEqual(impact.files, ['pkgs/b/consumer.spec.ts', 'pkgs/b/consumer.ts', 'pkgs/d/viaagain.ts', 'pkgs/f/f.ts', 'pkgs/g/svc.ts', 'pkgs/h/h.ts', 'pkgs/i/i.ts']);
  });

  it('definition has a file and the line of the declared name', () => {
    assert.deepEqual(withTests.definitionOf('pkgs/a/src/util.ts', 'target'), { file: 'pkgs/a/src/util.ts', line: 1 });
    assert.deepEqual(withTests.definitionOf('pkgs/a/src/util.ts', 'Dec'), { file: 'pkgs/a/src/util.ts', line: 10 });
    assert.deepEqual(withTests.definitionOf('pkgs/c/other.ts', 'target'), { file: 'pkgs/c/other.ts', line: 1 });
  });

  it('heritage: direct subtypes only, with file and class name, and not the same-name base elsewhere', () => {
    const rows = withTests.directSubtypes('pkgs/a/src/util.ts', 'Base');
    assert.deepEqual(rows.map((r) => `${r.file}:${r.cls}`), ['pkgs/l/sub.ts:Sub']);
  });

  it('the any audit lists sites where the name is used through an unresolved type', () => {
    const sites = withTests.anyRiskSites('pkgs/a/src/util.ts', 'target');
    assert.deepEqual(sites.map((s) => `${s.file}:${s.line}`), ['pkgs/j/anyuse.ts:2']);
    assert.deepEqual(withTests.anyRiskSites('pkgs/a/src/util.ts', 'wrapper'), []);
  });
});

describe('scopePredicate (spec-file scope option of sample-keys)', () => {
  it('keeps specs only when asked', () => {
    assert.equal(scopePredicate(false)('packages/core/src/x.spec.ts'), false);
    assert.equal(scopePredicate(true)('packages/core/src/x.spec.ts'), true);
    assert.equal(scopePredicate(true)('packages/core/schematics/x.ts'), false);
  });
});
