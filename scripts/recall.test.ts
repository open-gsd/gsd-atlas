import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { validateFileFacts } from '../src/facts/index.ts';
import type { FileFacts } from '../src/facts/index.ts';
import { createGrammarEngine } from '../src/grammar-engine/index.ts';
import type { GrammarEngine } from '../src/grammar-engine/index.ts';
import { readModuleInputs } from '../src/lang/index.ts';
import { CONSTRUCTS, compareConstruct, decodeSource, openModule, readTruths, runRecall } from './recall.ts';
import type { OpenedModule, RecallItem } from './recall.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsDir = path.join(repoRoot, 'modules', 'typescript');
const jsDir = path.join(repoRoot, 'modules', 'javascript');

let engine: GrammarEngine;
let typescript: OpenedModule;
let javascript: OpenedModule;

before(async () => {
  engine = createGrammarEngine();
  typescript = await openModule(tsDir, engine);
  javascript = await openModule(jsDir, engine);
});

after(async () => {
  await engine.dispose();
});

function fixtureText(moduleDir: string, name: string): string {
  return decodeSource(fs.readFileSync(path.join(moduleDir, 'fixtures', name)));
}

function sortedKeys(items: readonly RecallItem[]): string[] {
  return items.map((item) => JSON.stringify([item.construct, item.parent ?? '', item.name, item.line])).sort();
}

/** The import site that starts on 1-based `line`. */
function importAt(facts: FileFacts, line: number) {
  return facts.imports.find((site) => site.span.startLine + 1 === line);
}

/** The export sites of the statement that starts on 1-based `line`. */
function exportsAt(facts: FileFacts, line: number) {
  return (facts.exports ?? []).filter((site) => site.span.startLine + 1 === line);
}

describe('compareConstruct', () => {
  it('matches by multiset on name and line: a duplicate in truth needs a duplicate in found', () => {
    const truth = [
      { name: 'over', line: 3 },
      { name: 'over', line: 3 },
    ];
    assert.deepEqual(compareConstruct(truth, [{ name: 'over', line: 3 }]), { truth: 2, found: 1, matched: 1, recall: 0.5 });
    assert.deepEqual(compareConstruct(truth, truth), { truth: 2, found: 2, matched: 2, recall: 1 });
  });

  it('does not let extra found items reduce recall, and treats the same name on another line as a miss', () => {
    const result = compareConstruct(
      [{ name: 'a', line: 1 }],
      [
        { name: 'a', line: 1 },
        { name: 'b', line: 2 },
        { name: 'a', line: 9 },
      ],
    );
    assert.deepEqual(result, { truth: 1, found: 3, matched: 1, recall: 1 });
    assert.equal(compareConstruct([{ name: 'a', line: 1 }], [{ name: 'a', line: 2 }]).recall, 0);
  });

  it('keeps files apart and separates containment pairs by parent', () => {
    assert.equal(compareConstruct([{ name: 'a', line: 1, file: 'x' }], [{ name: 'a', line: 1, file: 'y' }]).recall, 0);
    assert.equal(compareConstruct([{ name: 'm', line: 1, parent: 'A' }], [{ name: 'm', line: 1, parent: 'B' }]).recall, 0);
  });

  it('yields recall null, not zero, for an empty truth', () => {
    assert.deepEqual(compareConstruct([], [{ name: 'a', line: 1 }]), { truth: 0, found: 1, matched: 0, recall: null });
    assert.deepEqual(compareConstruct([], []), { truth: 0, found: 0, matched: 0, recall: null });
  });
});

describe('typescript fixture recall (LNG-02)', () => {
  it('every applicable construct reaches 90 percent against the hand-curated truth', async () => {
    const report = await runRecall({ modules: ['typescript'], out: () => undefined });
    const [module] = report.modules;
    assert.ok(module);
    assert.deepEqual(module.failures, []);
    assert.deepEqual(
      module.rows.filter((row) => row.status === 'fail').map((row) => `${row.construct} ${String(row.matched)}/${String(row.truth)}`),
      [],
    );
    assert.equal(report.ok, true);
  });

  it('prints one row per construct, never a pooled total, and every construct has truth in typescript', async () => {
    const lines: string[] = [];
    const report = await runRecall({ modules: ['typescript'], out: (line) => lines.push(line) });
    const [module] = report.modules;
    assert.ok(module);
    assert.deepEqual(
      module.rows.map((row) => row.construct),
      [...CONSTRUCTS],
    );
    assert.equal(CONSTRUCTS.length, 13);
    for (const construct of CONSTRUCTS) {
      assert.ok(
        lines.some((line) => line.startsWith(construct)),
        `a printed row for ${construct}`,
      );
    }
    assert.ok(!lines.some((line) => /^(total|overall|pooled)/i.test(line)));
    for (const row of module.rows) {
      assert.ok(row.truth > 0 && row.status === 'ok', `${row.construct} has truth items and passes`);
    }
  });

  it('a deleted pattern makes exactly that construct fail and the run exit 1', async () => {
    // Drop the enum patterns that carry no @export, so the exported enum (and the ES export row) is untouched.
    const withoutPlainEnums = (_module: string, kind: string, text: string): string =>
      kind === 'tags'
        ? text
            .split(/\n\s*\n/)
            .filter((block) => !(block.includes('@definition.enum') && !block.includes('@export')))
            .join('\n\n')
        : text;
    const report = await runRecall({ modules: ['typescript'], out: () => undefined, queryTransform: withoutPlainEnums });
    const [module] = report.modules;
    assert.ok(module);
    assert.deepEqual(
      module.rows.filter((row) => row.status === 'fail').map((row) => row.construct),
      ['enum'],
    );
    assert.equal(report.ok, false);
    assert.equal(module.rows.find((row) => row.construct === 'enum')?.matched, 1, 'only the exported Level is still found');
  });

  it('scopes definitions as the truth states: no constructor, destructuring, locals, type-literal or enum members', async () => {
    const { facts } = await typescript.measure('constructs.ts', fixtureText(tsDir, 'constructs.ts'));
    assert.deepEqual(validateFileFacts(facts), []);
    const names = new Set(facts.symbols.map((symbol) => symbol.name));
    for (const absent of ['constructor', 'id', 'destructuredA', 'destructuredB', 'localValue', 'localCounter', 'LIMIT_IN_NS', 'run', 'size', 'Red', 'Low', 'named']) {
      assert.ok(!names.has(absent), `${absent} is not a definition`);
    }
    const kindOf = (name: string): string | undefined => facts.symbols.find((symbol) => symbol.name === name)?.kind;
    assert.equal(kindOf('LIMIT'), 'constant');
    assert.equal(kindOf('counter'), 'variable');
    assert.equal(kindOf('legacy'), 'variable');
    assert.equal(kindOf('arrowTop'), 'function');
    assert.equal(kindOf('varArrow'), 'function');
    assert.equal(kindOf('Util'), 'namespace');
    assert.equal(kindOf('Id'), 'type');
  });

  it('marks exported declarations, exports a default declaration only as default, and never exports a namespace member', async () => {
    const { facts } = await typescript.measure('constructs.ts', fixtureText(tsDir, 'constructs.ts'));
    const exportedNames = new Set((facts.exports ?? []).map((site) => site.name));
    assert.ok(exportedNames.has('default'));
    assert.equal(facts.exports?.find((site) => site.name === 'default')?.local, 'defaultNamed');
    assert.ok(!exportedNames.has('defaultNamed'), 'export default function f is exported as default only');
    assert.ok(!exportedNames.has('helper'), 'a namespace member is not a module export');
    const exported = (name: string): boolean | undefined => facts.symbols.find((symbol) => symbol.name === name)?.exported;
    assert.equal(exported('exportedPlain'), true);
    assert.equal(exported('Shape'), true);
    assert.equal(exported('defaultNamed'), true);
    assert.notEqual(exported('asyncPlain'), true);
  });

  it('modules.ts: import styles, bindings and unquoted paths of every ES and CommonJS form', async () => {
    const { facts } = await typescript.measure('modules.ts', fixtureText(tsDir, 'modules.ts'));
    assert.deepEqual(validateFileFacts(facts), []);
    const at = (line: number) => {
      const site = importAt(facts, line);
      return site === undefined ? undefined : [site.path, site.style, site.bindings];
    };
    assert.deepEqual(at(4), ['./default-thing', 'es', [{ imported: 'default', local: 'defaultThing' }]]);
    assert.deepEqual(at(5), ['./everything', 'es', [{ imported: '*', local: 'everything' }]]);
    assert.deepEqual(at(6), [
      './named',
      'es',
      [
        { imported: 'plain', local: 'plain' },
        { imported: 'original', local: 'renamed' },
      ],
    ]);
    assert.deepEqual(at(7), ['./only-type', 'es', [{ imported: 'OnlyType', local: 'OnlyType' }]]);
    assert.deepEqual(at(8), [
      './inline-type',
      'es',
      [
        { imported: 'InlineType', local: 'InlineType' },
        { imported: 'value', local: 'value' },
      ],
    ]);
    assert.deepEqual(at(9), ['./side-effect', 'side-effect', undefined]);
    assert.deepEqual(at(10), ['./legacy', 'cjs', [{ imported: '*', local: 'legacy' }]]);
    assert.deepEqual(at(11), [
      './mixed',
      'es',
      [
        { imported: 'default', local: 'mixed' },
        { imported: 'extra', local: 'extra' },
      ],
    ]);
    assert.deepEqual(at(12), ['./default-type', 'es', [{ imported: 'default', local: 'DefaultType' }]]);
    assert.deepEqual(at(14), ['./all', 'reexport', undefined]);
    assert.deepEqual(at(27), ['./fs-like', 'cjs', [{ imported: '*', local: 'fsLike' }]]);
    assert.deepEqual(at(28), [
      './destructured',
      'cjs',
      [
        { imported: 'destructured', local: 'destructured' },
        { imported: 'aliased', local: 'renamedAlias' },
      ],
    ]);
    assert.deepEqual(at(29), ['./member', 'cjs', [{ imported: 'thing', local: 'member' }]]);
    assert.deepEqual(at(30), ['./bare', 'cjs', undefined]);
    assert.deepEqual(at(31), ['./old-style', 'cjs', [{ imported: '*', local: 'oldStyle' }]]);
    const names = new Set(facts.symbols.map((symbol) => symbol.name));
    for (const absent of ['fsLike', 'destructured', 'member', 'oldStyle', 'renamedAlias']) {
      assert.ok(!names.has(absent), `${absent} is an import binding, not a definition`);
    }
  });

  it('modules.ts: export names, local names and re-export sources', async () => {
    const { facts } = await typescript.measure('modules.ts', fixtureText(tsDir, 'modules.ts'));
    const shape = (line: number) => exportsAt(facts, line).map((site) => [site.name, site.local, site.from]);
    assert.deepEqual(shape(14), [['*', undefined, './all']]);
    assert.deepEqual(shape(15), [['grouped', undefined, './grouped']]);
    // Sites that share a statement come out ordered by name.
    assert.deepEqual(shape(16), [
      ['other', 'value', './reexport'],
      ['shown', 'plain', './reexport'],
    ]);
    assert.deepEqual(shape(17), [['OnlyType', undefined, './only-type']]);
    assert.deepEqual(shape(21), [
      ['localOne', undefined, undefined],
      ['publicTwo', 'localTwo', undefined],
    ]);
    assert.deepEqual(shape(25), [['default', 'localTwo', undefined]]);
    assert.deepEqual(shape(33).map((entry) => [entry[0], entry[1]]), [
      ['inline', undefined],
      ['localOne', undefined],
      ['publicOne', 'localTwo'],
    ]);
    assert.deepEqual(shape(34).map((entry) => entry[0]), ['direct']);
    assert.deepEqual(shape(35).map((entry) => entry[0]), ['nested']);
    const exported = (name: string): boolean | undefined => facts.symbols.find((symbol) => symbol.name === name)?.exported;
    assert.equal(exported('localOne'), true, 'export { localOne } marks the local symbol exported');
    assert.equal(exported('localTwo'), true, 'export { localTwo as publicTwo } and export default localTwo mark it exported');
  });
});

describe('javascript fixture recall (LNG-02)', () => {
  it('every applicable construct reaches 90 percent; constructs JavaScript does not have are n/a, not zero', async () => {
    const report = await runRecall({ modules: ['javascript'], out: () => undefined });
    const [module] = report.modules;
    assert.ok(module);
    assert.deepEqual(module.failures, []);
    assert.deepEqual(
      module.rows.filter((row) => row.status === 'fail').map((row) => `${row.construct} ${String(row.matched)}/${String(row.truth)}`),
      [],
    );
    for (const construct of ['interface', 'type alias', 'enum']) {
      const row = module.rows.find((candidate) => candidate.construct === construct);
      assert.deepEqual([row?.status, row?.recall], ['n/a', null], `${construct} is not applicable to JavaScript`);
    }
    for (const construct of ['function', 'class', 'const/var', 'method', 'property', 'containment', 'ES import', 'ES export', 'CJS require', 'CJS module.exports']) {
      const row = module.rows.find((candidate) => candidate.construct === construct);
      assert.ok(row && row.truth > 0 && row.status === 'ok', `${construct} is applicable and passes`);
    }
    assert.equal(report.ok, true);
  });

  it('measures every module with truth when no module is named, one table each', async () => {
    const lines: string[] = [];
    const report = await runRecall({ out: (line) => lines.push(line) });
    assert.deepEqual(
      report.modules.map((module) => module.module),
      ['typescript', 'javascript'],
    );
    assert.equal(report.ok, true);
    assert.equal(lines.filter((line) => line.startsWith('module ')).length, 2);
  });

  it('constructs.cjs: a require() binding is an import and not a const, and module.exports gives one site per property', async () => {
    const { facts } = await javascript.measure('constructs.cjs', fixtureText(jsDir, 'constructs.cjs'));
    assert.deepEqual(validateFileFacts(facts), []);
    const names = new Set(facts.symbols.map((symbol) => symbol.name));
    for (const absent of ['fsLike', 'member', 'oldStyle', 'destructured', 'constructor', 'localValue', 'named']) {
      assert.ok(!names.has(absent), `${absent} is not a definition`);
    }
    const kindOf = (name: string): string | undefined => facts.symbols.find((symbol) => symbol.name === name)?.kind;
    assert.equal(kindOf('LIMIT'), 'constant');
    assert.equal(kindOf('counter'), 'variable');
    assert.equal(kindOf('legacy'), 'variable');
    assert.equal(kindOf('arrowConst'), 'function');
    assert.equal(kindOf('name'), 'property');
    const at = (line: number) => {
      const site = importAt(facts, line);
      return site === undefined ? undefined : [site.path, site.style, site.bindings];
    };
    assert.deepEqual(at(4), ['./fs-like', 'cjs', [{ imported: '*', local: 'fsLike' }]]);
    assert.deepEqual(at(5), [
      './destructured',
      'cjs',
      [
        { imported: 'destructured', local: 'destructured' },
        { imported: 'aliased', local: 'renamedAlias' },
      ],
    ]);
    assert.deepEqual(at(6), ['./member', 'cjs', [{ imported: 'thing', local: 'member' }]]);
    assert.deepEqual(at(8), ['./bare', 'cjs', undefined]);
    const shape = (line: number) => exportsAt(facts, line).map((site) => [site.name, site.local]);
    assert.deepEqual(shape(65), [
      ['outer', undefined],
      ['plainFunction', undefined],
      ['shown', 'asyncFunction'],
    ]);
    assert.deepEqual(shape(66), [['direct', 'arrowConst']]);
    assert.deepEqual(shape(67), [['nested', undefined]]);
    assert.deepEqual(shape(68), [['module.exports', 'Dog']]);
  });

  it('modules.mjs: ES import and export forms with bindings, aliases and re-export sources', async () => {
    const { facts } = await javascript.measure('modules.mjs', fixtureText(jsDir, 'modules.mjs'));
    assert.deepEqual(validateFileFacts(facts), []);
    const site = (line: number) => importAt(facts, line);
    assert.deepEqual(site(4)?.bindings, [{ imported: 'default', local: 'defaultThing' }]);
    assert.deepEqual(site(6)?.bindings, [
      { imported: 'plain', local: 'plain' },
      { imported: 'original', local: 'renamed' },
    ]);
    assert.equal(site(7)?.style, 'side-effect');
    assert.deepEqual(
      exportsAt(facts, 12).map((entry) => [entry.name, entry.local, entry.from]),
      [
        ['other', 'renamed', './reexport.mjs'],
        ['shown', 'plain', './reexport.mjs'],
      ],
    );
    assert.deepEqual(
      exportsAt(facts, 20).map((entry) => [entry.name, entry.local]),
      [['default', 'localTwo']],
    );
  });
});

describe('fixture variants and manifests', () => {
  const modules: Array<[string, string, () => OpenedModule]> = [
    ['typescript', tsDir, () => typescript],
    ['javascript', jsDir, () => javascript],
  ];

  for (const [name, dir, opened] of modules) {
    it(`${name}: the CRLF and BOM variants of every fixture yield the same items as the LF original`, async () => {
      for (const truth of readTruths(dir)) {
        const lf = fixtureText(dir, truth.fixture);
        assert.ok(!lf.includes('\r'), `${truth.fixture} is stored with LF`);
        const base = sortedKeys((await opened().measure(truth.fixture, lf)).items);
        const crlf = sortedKeys((await opened().measure(truth.fixture, lf.replace(/\n/g, '\r\n'))).items);
        const bom = sortedKeys((await opened().measure(truth.fixture, `﻿${lf}`)).items);
        assert.deepEqual(crlf, base, `${truth.fixture} with CRLF`);
        assert.deepEqual(bom, base, `${truth.fixture} with a BOM`);
      }
    });

    it(`${name}: the manifest lists the tags, refs and imports query files`, () => {
      const inputs = readModuleInputs(dir);
      assert.ok(inputs.ok);
      assert.deepEqual(inputs.manifest.queries, {
        tags: 'queries/tags.scm',
        refs: 'queries/refs.scm',
        imports: 'queries/imports.scm',
      });
    });
  }

  it('the typescript refs query has type and heritage references and the javascript one has no type reference', () => {
    const tsRefs = fs.readFileSync(path.join(tsDir, 'queries', 'refs.scm'), 'utf8');
    const jsRefs = fs.readFileSync(path.join(jsDir, 'queries', 'refs.scm'), 'utf8');
    assert.ok(tsRefs.includes('reference.type') && tsRefs.includes('reference.heritage'));
    assert.ok(!jsRefs.includes('reference.type'));
    assert.ok(jsRefs.includes('reference.heritage'));
  });
});

describe('reference extraction (D-06)', () => {
  const tsSource = [
    "import { helper, Thing } from './lib';",
    "import type { Shape } from './shapes';",
    "import { Base } from './base';",
    'export class Child extends Base implements Shape {',
    '  run(arg: Thing): void {',
    '    helper(arg);',
    '    const made = new Thing();',
    '    made.go();',
    '    return unimported();',
    '  }',
    '}',
    '',
  ].join('\n');

  it('typescript: a call, new, type use, heritage and member call each give a RefSite of the right kind with the enclosing symbol', async () => {
    const { facts } = await typescript.measure('inline.ts', tsSource);
    assert.deepEqual(validateFileFacts(facts), []);
    const run = facts.symbols.findIndex((symbol) => symbol.name === 'run');
    const child = facts.symbols.findIndex((symbol) => symbol.name === 'Child');
    assert.ok(run >= 0 && child >= 0);
    const sites = facts.refSites.map((site) => ({
      name: site.name,
      kind: site.kind,
      line: site.span.startLine + 1,
      importPath: site.importPath,
      enclosing: site.enclosing,
    }));
    assert.deepEqual(sites, [
      { name: 'Base', kind: 'heritage', line: 4, importPath: './base', enclosing: child },
      { name: 'Shape', kind: 'heritage', line: 4, importPath: './shapes', enclosing: child },
      { name: 'Thing', kind: 'type', line: 5, importPath: './lib', enclosing: run },
      { name: 'helper', kind: 'call', line: 6, importPath: './lib', enclosing: run },
      { name: 'Thing', kind: 'new', line: 7, importPath: './lib', enclosing: run },
      { name: 'go', kind: 'member', line: 8, importPath: undefined, enclosing: run },
    ]);
  });

  it('typescript: a call to an unimported global is not recorded', async () => {
    const { facts } = await typescript.measure('inline.ts', tsSource);
    assert.ok(!facts.refSites.some((site) => site.name === 'unimported'));
    assert.ok(!facts.refSites.some((site) => site.name === 'made'), 'a local variable is not a top-level definition');
  });

  const jsSource = [
    "const { helper } = require('./lib');",
    "const Thing = require('./thing');",
    'class Child extends Thing {',
    '  run(arg) {',
    '    helper(arg);',
    '    const made = new Thing();',
    '    made.go();',
    '    return unimported();',
    '  }',
    '}',
    '',
  ].join('\n');

  it('javascript: a call, new, heritage and member call each give a RefSite of the right kind; an unimported call is dropped', async () => {
    const { facts } = await javascript.measure('inline.cjs', jsSource);
    assert.deepEqual(validateFileFacts(facts), []);
    const run = facts.symbols.findIndex((symbol) => symbol.name === 'run');
    const child = facts.symbols.findIndex((symbol) => symbol.name === 'Child');
    assert.ok(run >= 0 && child >= 0);
    const sites = facts.refSites.map((site) => ({
      name: site.name,
      kind: site.kind,
      line: site.span.startLine + 1,
      importPath: site.importPath,
      enclosing: site.enclosing,
    }));
    assert.deepEqual(sites, [
      { name: 'Thing', kind: 'heritage', line: 3, importPath: './thing', enclosing: child },
      { name: 'helper', kind: 'call', line: 5, importPath: './lib', enclosing: run },
      { name: 'Thing', kind: 'new', line: 6, importPath: './thing', enclosing: run },
      { name: 'go', kind: 'member', line: 7, importPath: undefined, enclosing: run },
    ]);
  });

  it('a read of an imported or top-level name is a read site, and a declaration name is never a reference', async () => {
    const { facts } = await javascript.measure(
      'reads.cjs',
      ["const { helper } = require('./lib');", 'const LIMIT = 3;', 'function use() {', '  return [helper, LIMIT + 1];', '}', ''].join('\n'),
    );
    assert.deepEqual(
      facts.refSites.map((site) => [site.name, site.kind, site.span.startLine + 1]),
      [
        ['helper', 'read', 4],
        ['LIMIT', 'read', 4],
      ],
    );
  });
});

describe('scripts/recall.ts as a command', () => {
  it('node scripts/recall.ts exits 0 and prints a row per construct for each module', () => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'recall.ts')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const rows = result.stdout.split('\n');
    for (const construct of CONSTRUCTS) {
      assert.equal(rows.filter((line) => line.startsWith(construct)).length, 2, `a row for ${construct} in each of the two tables`);
    }
  });

  it('node scripts/recall.ts --module typescript prints only the typescript table', () => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'recall.ts'), '--module', 'typescript'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('module typescript'));
    assert.ok(!result.stdout.includes('module javascript'));
  });
});
