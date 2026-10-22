import assert from 'node:assert/strict';
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
