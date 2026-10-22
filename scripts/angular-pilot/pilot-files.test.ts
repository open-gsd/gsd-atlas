import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AnswerFileSchema, loadQuestions } from '../eval/questions.ts';

const dir = path.resolve(import.meta.dirname, '..', '..', 'docs', 'eval', 'angular-pilot');

describe('the generated pilot files', () => {
  const qs = loadQuestions(path.join(dir, 'pilot-questions.json'));
  const answers = AnswerFileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'pilot-answers.json'), 'utf8')));

  it('load through the frozen loader with the planned category counts', () => {
    assert.equal(qs.corpusId, 'angular');
    assert.equal(qs.corpusSha, '3cc1edf3210a9debb0be57a4e99e53a54505db32');
    const counts: Record<string, number> = {};
    for (const q of qs.questions) counts[q.category] = (counts[q.category] ?? 0) + 1;
    assert.deepEqual(counts, { callers: 5, references: 3, heritage: 3, impact: 2, definition: 2, abstain: 1 });
  });

  it('pair every question with one answer of the same kind and granularity', () => {
    assert.deepEqual(answers.answers.map((a) => a.questionId), qs.questions.map((q) => q.id));
    for (const q of qs.questions) {
      const a = answers.answers.find((x) => x.questionId === q.id)!;
      assert.equal(a.kind, q.key.kind);
      assert.equal(a.granularity, q.key.granularity);
      assert.equal(a.abstain, q.category === 'abstain');
      if (q.category === 'abstain') assert.equal(a.items.length, 0);
      else assert.ok(a.items.length >= 1, q.id);
    }
  });

  it('keep every question inside the selection rule: 2..25 key files except definition and abstain', () => {
    for (const q of qs.questions) {
      const a = answers.answers.find((x) => x.questionId === q.id)!;
      const size = q.key.granularity === 'file' ? new Set(a.items.map((i) => i.file)).size : a.items.length;
      if (q.category === 'definition') assert.equal(size, 1);
      else if (q.category !== 'abstain') assert.ok(size >= 2 && size <= 25, `${q.id} has ${String(size)}`);
    }
  });

  it('carry the counting rules in the question text', () => {
    for (const q of qs.questions.filter((x) => x.category !== 'abstain')) {
      assert.match(q.text, /Angular HTML templates and inline `template:` strings/, q.id);
      assert.match(q.text, /different symbol/, q.id);
    }
  });
});

describe('the wording changes after the second reader (2026-10-21)', () => {
  const qs = loadQuestions(path.join(dir, 'pilot-questions.json'));
  const text = (id: string): string => qs.questions.find((q) => q.id === id)!.text;

  it('p-212 says which enclosing declaration a nested or unnamed call counts for', () => {
    const t = text('p-212');
    assert.match(t, /a call inside a nested function, a callback or an unnamed arrow function counts for the nearest enclosing declaration that has a name/);
    assert.match(t, /a function that is only passed as a value has no callers/);
  });

  it('p-215 names the other declaration as an interface and p-214 and p-215 carry the enum line rule', () => {
    assert.match(text('p-215'), /Another declaration named `CanDeactivate` \(an interface\) is declared elsewhere in the tree/);
    assert.doesNotMatch(text('p-215'), /Another class named/);
    for (const id of ['p-214', 'p-215']) assert.match(text(id), /for an enum the `export enum` line/, id);
    assert.match(text('p-214'), /Another enum named `SecurityContext` is declared elsewhere/);
  });

  it('leave pilot-answers.json byte-identical', () => {
    const sha = createHash('sha256').update(fs.readFileSync(path.join(dir, 'pilot-answers.json'))).digest('hex');
    assert.equal(sha, 'c92c391f362eb41b478c9c8c6fb1406da7ec56f1b19adc514d12447f571d0f92');
  });
});
