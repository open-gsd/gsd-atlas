import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { validateFileFacts } from '../src/facts/index.ts';
import { createGrammarEngine } from '../src/grammar-engine/index.ts';
import type { GrammarEngine } from '../src/grammar-engine/index.ts';
import { CONSTRUCTS, compareConstruct, decodeSource, openModule, readTruths, runRecall } from './recall.ts';
import type { OpenedModule, RecallItem } from './recall.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsDir = path.join(repoRoot, 'modules', 'typescript');

let engine: GrammarEngine;
let typescript: OpenedModule;

before(async () => {
  engine = createGrammarEngine();
  typescript = await openModule(tsDir, engine);
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

  it('prints one row per construct, never a pooled total, and marks a construct without truth n/a', async () => {
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
    for (const construct of ['function', 'class', 'interface', 'type alias', 'enum', 'const/var', 'method', 'property', 'containment']) {
      const row = module.rows.find((candidate) => candidate.construct === construct);
      assert.ok(row && row.truth > 0, `${construct} has truth items`);
    }
    assert.equal(module.rows.find((row) => row.construct === 'CJS module.exports')?.status, 'n/a');
  });

  it('a deleted pattern makes exactly that construct fail and the run exit 1', async () => {
    const withoutEnum = (_module: string, kind: string, text: string): string =>
      kind === 'tags'
        ? text
            .split(/\n\s*\n/)
            .filter((block) => !block.includes('@definition.enum'))
            .join('\n\n')
        : text;
    const report = await runRecall({ modules: ['typescript'], out: () => undefined, queryTransform: withoutEnum });
    const [module] = report.modules;
    assert.ok(module);
    assert.deepEqual(
      module.rows.filter((row) => row.status === 'fail').map((row) => row.construct),
      ['enum'],
    );
    assert.equal(report.ok, false);
    assert.equal(module.rows.find((row) => row.construct === 'enum')?.matched, 0);
  });

  it('the CRLF and BOM variants of every fixture yield the same items as the LF original', async () => {
    for (const truth of readTruths(tsDir)) {
      const lf = fixtureText(tsDir, truth.fixture);
      assert.ok(!lf.includes('\r'), `${truth.fixture} is stored with LF`);
      const base = sortedKeys((await typescript.measure(truth.fixture, lf)).items);
      const crlf = sortedKeys((await typescript.measure(truth.fixture, lf.replace(/\n/g, '\r\n'))).items);
      const bom = sortedKeys((await typescript.measure(truth.fixture, `﻿${lf}`)).items);
      assert.deepEqual(crlf, base, `${truth.fixture} with CRLF`);
      assert.deepEqual(bom, base, `${truth.fixture} with a BOM`);
    }
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

  it('marks exported declarations, emits export default under the name default, and never exports a namespace member', async () => {
    const { facts } = await typescript.measure('constructs.ts', fixtureText(tsDir, 'constructs.ts'));
    const exportedNames = new Set((facts.exports ?? []).map((site) => site.name));
    assert.ok(exportedNames.has('default'));
    assert.ok(!exportedNames.has('defaultNamed'), 'export default function f is exported as default only');
    assert.ok(!exportedNames.has('helper'), 'a namespace member is not a module export');
    const exported = (name: string): boolean | undefined => facts.symbols.find((symbol) => symbol.name === name)?.exported;
    assert.equal(exported('exportedPlain'), true);
    assert.equal(exported('Shape'), true);
    assert.notEqual(exported('asyncPlain'), true);
  });
});

describe('scripts/recall.ts as a command', () => {
  it('node scripts/recall.ts --module typescript exits 0 and prints a row per construct', () => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'recall.ts'), '--module', 'typescript'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const construct of CONSTRUCTS) {
      assert.ok(result.stdout.split('\n').some((line) => line.startsWith(construct)), `row for ${construct}`);
    }
  });
});
