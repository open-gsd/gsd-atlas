import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AnswerFileSchema, QuestionFileSchema } from '../eval/questions.ts';
import {
  PICK_ORDER_V2,
  QUOTA_V2,
  SEED_V2,
  assertRoleDoesNotLeak,
  buildFilesV2,
  keyBounds,
  packageLabel,
  pickQuestionsV2,
  questionTextV2,
  tierRows,
  type CensusRowV2,
  type EntryV2,
} from './select-v2.ts';

const row = (name: string, file: string, over: Partial<CensusRowV2> = {}): CensusRowV2 => ({
  name,
  kind: 'function',
  file,
  otherDeclFiles: 2,
  otherKinds: ['function'],
  grepFiles: 70,
  callSiteFiles: 9,
  directSubtypes: 5,
  fileLastChanged: '2026-05-01',
  ...over,
});

describe('constants of rule v2', () => {
  it('states the seed, the mix of 16 and the processing order before any draw', () => {
    assert.equal(SEED_V2, 20261022);
    assert.deepEqual(QUOTA_V2, { callers: 4, references: 4, heritage: 2, impact: 4, definition: 1 });
    assert.deepEqual(PICK_ORDER_V2, ['heritage', 'callers', 'impact', 'references', 'definition']);
  });

  it('has the key bounds of both tiers', () => {
    assert.deepEqual(keyBounds(1, 'callers'), { min: 8, max: 60 });
    assert.deepEqual(keyBounds(1, 'references'), { min: 8, max: 60 });
    assert.deepEqual(keyBounds(1, 'impact'), { min: 10, max: 80 });
    assert.deepEqual(keyBounds(1, 'heritage'), { min: 4, max: 30 });
    assert.deepEqual(keyBounds(2, 'callers'), { min: 4, max: 60 });
    assert.deepEqual(keyBounds(2, 'references'), { min: 8, max: 60 });
    assert.deepEqual(keyBounds(2, 'impact'), { min: 4, max: 80 });
    assert.deepEqual(keyBounds(2, 'heritage'), { min: 2, max: 30 });
    assert.equal(keyBounds(1, 'definition'), null);
  });
});

describe('tierRows', () => {
  it('tier 1 needs grep >= 60, 2 other declarations and a file changed since 2026-01-01; tier 2 needs grep >= 30 and 1 other', () => {
    const rows = [
      row('t1', 'p/1.ts'),
      row('lowgrep', 'p/2.ts', { grepFiles: 59 }),
      row('oneother', 'p/3.ts', { otherDeclFiles: 1 }),
      row('old', 'p/4.ts', { fileLastChanged: '2025-12-31' }),
      row('t2only', 'p/5.ts', { grepFiles: 30, otherDeclFiles: 1, fileLastChanged: '2020-01-01' }),
      row('toolow', 'p/6.ts', { grepFiles: 29 }),
      row('noother', 'p/7.ts', { otherDeclFiles: 0 }),
    ];
    assert.deepEqual(tierRows(rows, 1).map((r) => r.name), ['t1']);
    assert.deepEqual(tierRows(rows, 2).map((r) => r.name).sort(), ['lowgrep', 'old', 'oneother', 't1', 't2only']);
  });
});

describe('packageLabel', () => {
  it('maps the directory under packages/ to the npm package name', () => {
    assert.equal(packageLabel('packages/forms/src/directives/validators.ts'), '@angular/forms');
    assert.equal(packageLabel('packages/compiler-cli/src/ngtsc/a.ts'), '@angular/compiler-cli');
    assert.equal(packageLabel('packages/zone.js/lib/common/utils.ts'), 'zone.js');
  });
});

describe('pickQuestionsV2', () => {
  const ok = (keySize: number) => ({ ok: true as const, value: { keySize } });
  it('fills a category from tier 1 first, then from tier 2, labels tiers and logs skips', () => {
    const rows = [
      row('a', 'p/a.ts'),
      row('b', 'p/b.ts'),
      row('c', 'p/c.ts', { grepFiles: 35, otherDeclFiles: 1, fileLastChanged: '2020-01-01' }),
      row('d', 'p/d.ts', { grepFiles: 35, otherDeclFiles: 1, fileLastChanged: '2020-01-01' }),
    ];
    const quota = { callers: 4, references: 0, heritage: 0, impact: 0, definition: 0 };
    const { picked, skipped } = pickQuestionsV2(
      rows,
      (_c, r, tier) => (r.name === 'b' && tier === 1 ? { ok: false, reason: 'key size 3 outside 8..60' } : ok(tier)),
      { seed: SEED_V2, quota, exclusions: [] },
    );
    const byName = new Map(picked.map((p) => [p.row.name, p.tier]));
    assert.equal(picked.length, 4);
    assert.equal(byName.get('a'), 1);
    assert.equal(byName.get('c'), 2);
    assert.equal(byName.get('d'), 2);
    assert.equal(byName.get('b'), 2);
    assert.ok(skipped.some((s) => s.name === 'b' && s.tier === 1));
  });

  it('takes one question per name across categories and honours audit exclusions', () => {
    const rows = [row('a', 'p/a.ts'), row('b', 'p/b.ts'), row('c', 'p/c.ts'), row('d', 'p/d.ts')];
    const quota = { callers: 1, references: 1, heritage: 0, impact: 1, definition: 0 };
    const { picked, skipped } = pickQuestionsV2(rows, () => ok(1), {
      seed: SEED_V2,
      quota,
      exclusions: [{ name: 'a', file: 'p/a.ts', reason: 'audit: defect' }],
    });
    assert.equal(new Set(picked.map((p) => p.row.name)).size, 3);
    assert.ok(!picked.some((p) => p.row.name === 'a'));
    assert.ok(skipped.some((s) => s.name === 'a' && s.reason === 'audit: defect'));
  });

  it('throws and names the category when tier 2 cannot fill the quota', () => {
    assert.throws(
      () => pickQuestionsV2([row('a', 'p/a.ts')], () => ok(1), { seed: SEED_V2, quota: { callers: 2, references: 0, heritage: 0, impact: 0, definition: 0 }, exclusions: [] }),
      /category callers cannot fill its quota \(1 missing\)/,
    );
  });
});

describe('questionTextV2', () => {
  const base = { name: 'Validator', kind: 'interface' as const, file: 'packages/forms/src/directives/validators.ts', role: 'the interface that a form validator directive implements', otherDeclFiles: 3, otherKinds: ['class', 'interface'] };

  it('identifies the target by package and role and never names the declaring file', () => {
    for (const category of ['callers', 'references', 'heritage', 'impact'] as const) {
      const text = questionTextV2({ category, ...base });
      assert.ok(text.includes('`@angular/forms`'), category);
      assert.ok(text.includes(base.role), category);
      assert.ok(!text.includes('validators.ts'), category);
      assert.ok(!text.includes('packages/forms'), category);
      assert.match(text, /A declaration is the target only if it is in the named package and fits the description/, category);
      assert.match(text, /3 other files/, category);
      assert.match(text, /Angular HTML templates and inline `template:` strings/, category);
    }
  });

  it('tells a heritage reader that a subtype of the target may share its name (the defect that excluded NgModuleFactory in v1)', () => {
    const text = questionTextV2({ category: 'heritage', ...base });
    assert.match(text, /A subtype counts even when it has the same name as the target, as long as its heritage clause refers to the target/);
    assert.doesNotMatch(questionTextV2({ category: 'callers', ...base }), /A subtype counts/);
  });

  it('carries the nested-call sentence in every impact question and a depth-two formula', () => {
    const text = questionTextV2({ category: 'impact', ...base, kind: 'function', role: 'the function that checks a value' });
    assert.match(text, /a call inside a nested function, a callback or an unnamed arrow function counts for the nearest enclosing declaration that has a name/);
    assert.match(text, /a function that is only passed as a value has no callers/);
    assert.match(text, /leave out the declaring file/);
  });

  it('adds "a call in a class field initializer counts for the class" only to an impact question that asks for it', () => {
    const sentence = 'a call in a class field initializer counts for the class';
    const plain = questionTextV2({ category: 'impact', ...base, kind: 'function', role: 'the function that checks a value' });
    const asked = questionTextV2({ category: 'impact', ...base, kind: 'function', role: 'the function that checks a value', classFieldRule: true });
    assert.ok(!plain.includes(sentence));
    assert.ok(asked.includes(sentence));
    // the only difference is the inserted sentence, placed inside the nested-call clause
    assert.equal(asked.replace(`${sentence}, `, ''), plain);
    assert.match(asked, /counts for the nearest enclosing declaration that has a name, a call in a class field initializer counts for the class, and a function that is only passed as a value has no callers/);
  });

  it('keeps definition and abstain without a role and without the declaring file', () => {
    const def = questionTextV2({ category: 'definition', ...base, kind: 'enum', useSite: { file: 'packages/core/src/a.ts', line: 12 } });
    assert.match(def, /In `packages\/core\/src\/a.ts`, line 12/);
    assert.match(def, /for an enum the `export enum` line/);
    assert.ok(!def.includes('validators.ts'));
    assert.match(questionTextV2({ category: 'abstain', ...base, name: 'fooHandler', kind: 'function', file: '' }), /Where is the function `fooHandler` defined/);
  });
});

describe('assertRoleDoesNotLeak', () => {
  const file = 'packages/forms/src/directives/validators.ts';
  it('accepts a plain role and rejects a path, a file name, a basename word, a line number or a wrong opening', () => {
    assert.doesNotThrow(() => assertRoleDoesNotLeak('the interface that a form check implements', 'interface', file));
    assert.doesNotThrow(() => assertRoleDoesNotLeak('the abstract class that checks a form', 'class', file));
    assert.doesNotThrow(() => assertRoleDoesNotLeak('the const enum that lists codes', 'enum', file));
    assert.throws(() => assertRoleDoesNotLeak('the thing that is a class somewhere far away', 'class', file), /must begin with/);
    assert.throws(() => assertRoleDoesNotLeak('the interface in src/directives', 'interface', file), /path separator/);
    assert.throws(() => assertRoleDoesNotLeak('the interface that is in validators.ts', 'interface', file), /file name/);
    assert.throws(() => assertRoleDoesNotLeak('the interface that lists validators', 'interface', file), /basename/);
    assert.throws(() => assertRoleDoesNotLeak('the interface declared at line 12', 'interface', file), /line number/);
    assert.throws(() => assertRoleDoesNotLeak('a thing that checks', 'interface', file), /must begin with/);
    assert.throws(() => assertRoleDoesNotLeak(`the interface ${'word '.repeat(31)}`, 'interface', file), /30 words/);
  });
});

describe('buildFilesV2', () => {
  const entries: EntryV2[] = [
    { id: 'p-301', category: 'callers', name: 'f', kind: 'function', file: 'packages/a/b.ts', role: 'the function that adds one', otherDeclFiles: 2, otherKinds: ['function'], items: [{ file: 'packages/a/c.ts', line: 3, symbol: 'g' }], needles: ['f'], notes: { tier: 1 } },
    { id: 'p-302', category: 'abstain', name: 'fooHandler', kind: 'function', file: '', role: '', otherDeclFiles: 0, otherKinds: [], items: [], needles: [], notes: {} },
  ];
  it('produces the registered shapes with p-3xx ids (the frozen loader accepts only q- or p- ids)', () => {
    const { questions, answers } = buildFilesV2({ sha: '3cc1edf3210a9debb0be57a4e99e53a54505db32', oracleVersion: 'angular-pilot-1', typescriptVersion: '6.0.3', entries });
    const q = QuestionFileSchema.parse(questions);
    AnswerFileSchema.parse(answers);
    assert.deepEqual(q.questions.map((x) => x.id), ['p-301', 'p-302']);
    assert.ok(!q.questions[0]!.text.includes('b.ts'));
  });

  it('carries the class-field sentence into the generated text of an entry that sets classFieldRule, and only that entry', () => {
    const impact = (id: string, over: Partial<EntryV2>): EntryV2 => ({ id, category: 'impact', name: 'g', kind: 'function', file: 'packages/a/d.ts', role: 'the function that adds two', otherDeclFiles: 1, otherKinds: ['function'], items: [{ file: 'packages/a/c.ts' }], needles: ['g'], notes: {}, ...over });
    const { questions } = buildFilesV2({ sha: '3cc1edf3210a9debb0be57a4e99e53a54505db32', oracleVersion: 'angular-pilot-1', typescriptVersion: '6.0.3', entries: [impact('p-311', {}), impact('p-313', { classFieldRule: true })] });
    const q = QuestionFileSchema.parse(questions).questions;
    assert.ok(!q[0]!.text.includes('a call in a class field initializer counts for the class'));
    assert.ok(q[1]!.text.includes('a call in a class field initializer counts for the class'));
  });
});
