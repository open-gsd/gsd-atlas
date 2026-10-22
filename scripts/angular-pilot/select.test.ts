import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { AnswerFileSchema, QuestionFileSchema } from '../eval/questions.ts';
import {
  QUOTA,
  SCOPE_RULE,
  USE_RULES,
  abstainNames,
  buildFiles,
  candidateHash,
  orderRows,
  pickQuestions,
  poolFor,
  questionText,
  windowRows,
  type CensusRow,
} from './select.ts';

const row = (name: string, file: string, over: Partial<CensusRow> = {}): CensusRow => ({
  name,
  kind: 'function',
  file,
  otherDeclFiles: 1,
  grepFiles: 20,
  callSiteFiles: 3,
  directSubtypes: 0,
  fileLastChanged: '2026-05-01',
  ...over,
});

describe('candidateHash and orderRows', () => {
  it('hashes seed, name and declaring file with the registered separator and orders ascending', () => {
    const r = row('foo', 'packages/a/b.ts');
    assert.equal(candidateHash(20261021, r), createHash('sha256').update('20261021\0foo@packages/a/b.ts').digest('hex'));
    const rows = [row('b', 'p/1.ts'), row('a', 'p/2.ts'), row('c', 'p/3.ts')];
    const order = orderRows(rows, 20261021).map((x) => x.name);
    assert.deepEqual(order, orderRows([...rows].reverse(), 20261021).map((x) => x.name));
    assert.notDeepEqual(order, orderRows(rows, 7).map((x) => x.name));
  });
});

describe('windowRows', () => {
  it('keeps 10..150 grep files, another declaration elsewhere and a declaring file changed since 2026-01-01', () => {
    const rows = [
      row('keep', 'p/1.ts'),
      row('few', 'p/2.ts', { grepFiles: 9 }),
      row('many', 'p/3.ts', { grepFiles: 151 }),
      row('old', 'p/4.ts', { fileLastChanged: '2025-12-31' }),
      row('lone', 'p/5.ts', { otherDeclFiles: 0 }),
      row('edge', 'p/6.ts', { grepFiles: 150, fileLastChanged: '2026-01-01' }),
    ];
    assert.deepEqual(windowRows(rows).map((r) => r.name).sort(), ['edge', 'keep']);
  });
});

describe('poolFor', () => {
  it('routes kinds to categories', () => {
    const rows = [row('f', 'p/1.ts'), row('K', 'p/2.ts', { kind: 'class', callSiteFiles: 0, directSubtypes: 2 }), row('T', 'p/3.ts', { kind: 'type', callSiteFiles: 0 })];
    assert.deepEqual(poolFor('callers', rows).map((r) => r.name), ['f']);
    assert.deepEqual(poolFor('impact', rows).map((r) => r.name), ['f']);
    assert.deepEqual(poolFor('heritage', rows).map((r) => r.name), ['K']);
    assert.deepEqual(poolFor('references', rows).map((r) => r.name).sort(), ['K', 'T', 'f']);
    assert.deepEqual(poolFor('definition', rows).map((r) => r.name).sort(), ['K', 'T', 'f']);
  });
});

describe('pickQuestions', () => {
  const rows: CensusRow[] = Array.from({ length: 40 }, (_, i) => row(`fn${String(i)}`, `packages/x/f${String(i)}.ts`));
  it('takes candidates in hash order per category, one question per name, logging every skip', () => {
    const ordered = orderRows(rows, 20261021);
    const bad = new Set([ordered[0]!.name]);
    const { picked, skipped } = pickQuestions(rows, (cat, r) => (bad.has(r.name) ? { ok: false, reason: 'key size 1' } : { ok: true, value: `${cat}:${r.name}` }), { seed: 20261021, quota: { callers: 2, heritage: 0, impact: 1, references: 1, definition: 0 }, exclusions: [] });
    assert.equal(picked.length, 4);
    assert.deepEqual(picked.filter((p) => p.category === 'callers').map((p) => p.row.name), [ordered[1]!.name, ordered[2]!.name]);
    assert.deepEqual(picked.filter((p) => p.category === 'impact').map((p) => p.row.name), [ordered[3]!.name]);
    assert.equal(new Set(picked.map((p) => p.row.name)).size, 4);
    assert.deepEqual(skipped, [{ category: 'callers', name: ordered[0]!.name, file: ordered[0]!.file, reason: 'key size 1' }]);
  });

  it('honours audit exclusions and records them as skips', () => {
    const ordered = orderRows(rows, 20261021);
    const first = ordered[0]!;
    const { picked, skipped } = pickQuestions(rows, (_c, r) => ({ ok: true, value: r.name }), {
      seed: 20261021,
      quota: { callers: 1, heritage: 0, impact: 0, references: 0, definition: 0 },
      exclusions: [{ name: first.name, file: first.file, reason: 'audit: key-likely-incomplete' }],
    });
    assert.equal(picked[0]!.row.name, ordered[1]!.name);
    assert.deepEqual(skipped, [{ category: 'callers', name: first.name, file: first.file, reason: 'audit: key-likely-incomplete' }]);
  });

  it('reports a category that cannot fill its quota', () => {
    assert.throws(() => pickQuestions(rows.slice(0, 2), () => ({ ok: false, reason: 'no' }), { seed: 1, quota: { ...QUOTA, callers: 1, heritage: 0, impact: 0, references: 0, definition: 0 }, exclusions: [] }), /callers/);
  });
});

describe('questionText', () => {
  const base = { name: 'splitNsName', kind: 'function' as const, file: 'packages/compiler/src/ml_parser/tags.ts' };
  it('names the declaring file, says the same-name symbol elsewhere is different, and carries the counting rules verbatim', () => {
    for (const category of ['callers', 'references', 'impact'] as const) {
      const t = questionText({ ...base, category });
      assert.ok(t.includes('`packages/compiler/src/ml_parser/tags.ts`'), category);
      assert.ok(t.includes(SCOPE_RULE), category);
      assert.ok(t.includes(USE_RULES), category);
      assert.ok(t.includes('different symbol'), category);
      assert.ok(t.endsWith('Give your answer in the required JSON form.'), category);
    }
    const h = questionText({ ...base, name: 'AstVisitor', kind: 'interface', category: 'heritage' });
    assert.ok(h.includes('directly extend or implement'));
    assert.ok(h.includes(SCOPE_RULE));
    assert.ok(h.includes('Give the file and the name of each'));
  });
  it('fixes the meaning of a call and of depth two', () => {
    const c = questionText({ ...base, category: 'callers' });
    assert.match(c, /call expression, a `new` expression, a tagged template or a decorator/);
    assert.match(c, /type position/);
    const i = questionText({ ...base, category: 'impact' });
    assert.match(i, /depth two/);
    assert.match(i, /leave out `packages\/compiler\/src\/ml_parser\/tags.ts` itself/);
  });
  it('the definition question cites a use site and never names the declaring file', () => {
    const t = questionText({ ...base, category: 'definition', useSite: { file: 'packages/core/src/x.ts', line: 12 } });
    assert.ok(t.includes('`packages/core/src/x.ts`'));
    assert.ok(t.includes('line 12'));
    assert.ok(!t.includes('ml_parser/tags.ts'));
    assert.match(t, /line that holds the declared name/);
    assert.throws(() => questionText({ ...base, category: 'definition' }), /use site/);
  });
  it('the abstain question has the registered shape', () => {
    const t = questionText({ name: 'resolveZoneRegistry', kind: 'function', file: '', category: 'abstain' });
    assert.equal(t, 'Where is the function `resolveZoneRegistry` defined, and which files call it? If this repository has no such function, say so. Give your answer in the required JSON form.');
  });
});

describe('abstainNames', () => {
  it('derives plausible names from real function names in seeded order and keeps only those with zero whole-word hits', () => {
    const real = ['splitNsName', 'findTightestNode', 'isInSkipHydrationBlock'];
    const hits = new Set<string>(real);
    const names = abstainNames(real, 20261021, 2, (n) => (hits.has(n) ? 1 : 0));
    assert.equal(names.length, 2);
    for (const n of names) {
      assert.ok(!hits.has(n));
      assert.match(n, /^[a-z][A-Za-z]+$/);
    }
    assert.deepEqual(names, abstainNames([...real].reverse(), 20261021, 2, (n) => (hits.has(n) ? 1 : 0)));
    // a derived name that does occur is skipped
    const occupied = abstainNames(real, 20261021, 1, () => 0)[0]!;
    const next = abstainNames(real, 20261021, 1, (n) => (n === occupied ? 3 : 0))[0]!;
    assert.notEqual(next, occupied);
  });
});

describe('buildFiles', () => {
  it('writes question and answer files that the frozen loader shapes accept', () => {
    const files = buildFiles({
      sha: '3cc1edf3210a9debb0be57a4e99e53a54505db32',
      oracleVersion: 'angular-pilot-1',
      typescriptVersion: '6.0.3',
      entries: [
        {
          id: 'p-201',
          category: 'callers',
          name: 'f',
          kind: 'function',
          file: 'packages/a/b.ts',
          items: [{ file: 'packages/c/d.ts', line: 3, symbol: 'g' }],
          needles: ['f'],
          notes: { callSites: 1 },
        },
        { id: 'p-202', category: 'heritage', name: 'K', kind: 'class', file: 'packages/a/k.ts', items: [{ file: 'packages/c/e.ts', line: 4, symbol: 'Sub' }], needles: ['K', 'Sub'], notes: {} },
        { id: 'p-203', category: 'impact', name: 'f', kind: 'function', file: 'packages/a/b.ts', items: [{ file: 'packages/c/d.ts' }], needles: ['f'], notes: { depth: 2 } },
        { id: 'p-204', category: 'definition', name: 'f', kind: 'function', file: 'packages/a/b.ts', items: [{ file: 'packages/a/b.ts', line: 1, symbol: 'f' }], needles: ['f'], notes: {}, useSite: { file: 'packages/c/d.ts', line: 3 } },
        { id: 'p-205', category: 'references', name: 'T', kind: 'type', file: 'packages/a/t.ts', items: [{ file: 'packages/c/d.ts', line: 3, symbol: '<module>' }], needles: ['T'], notes: {} },
        { id: 'p-206', category: 'abstain', name: 'zzNoSuchThing', kind: 'function', file: '', items: [], needles: [], notes: {} },
      ],
    });
    const q = QuestionFileSchema.parse(files.questions);
    const a = AnswerFileSchema.parse(files.answers);
    assert.equal(q.corpusId, 'angular');
    assert.equal(q.questions.length, 6);
    assert.deepEqual(q.questions.map((x) => x.key.kind), ['callers', 'heritage', 'impact', 'definition', 'references', 'abstain']);
    assert.deepEqual(a.answers.map((x) => [x.questionId, x.granularity, x.abstain]), [
      ['p-201', 'file', false],
      ['p-202', 'file+symbol', false],
      ['p-203', 'file', false],
      ['p-204', 'file+line', false],
      ['p-205', 'file', false],
      ['p-206', 'file', true],
    ]);
    const imp = q.questions[2]!.key;
    assert.equal(imp.kind === 'impact' ? imp.depth : 0, 2);
  });
});
