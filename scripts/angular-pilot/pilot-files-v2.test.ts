import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AnswerFileSchema, loadQuestions } from '../eval/questions.ts';
import type { PilotCategory } from './select.ts';
import { keyBounds, packageLabel, type Tier } from './select-v2.ts';

const dir = path.resolve(import.meta.dirname, '..', '..', 'docs', 'eval', 'angular-pilot', 'v2');

describe('the rule-v2 pilot files', () => {
  const qs = loadQuestions(path.join(dir, 'pilot-questions.json'));
  const answers = AnswerFileSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, 'pilot-answers.json'), 'utf8')));
  const roles = JSON.parse(fs.readFileSync(path.join(dir, 'roles.json'), 'utf8')) as Record<string, string>;

  it('load through the frozen loader with the rule-v2 mix and ids p-301..p-316', () => {
    assert.equal(qs.corpusId, 'angular');
    assert.equal(qs.corpusSha, '3cc1edf3210a9debb0be57a4e99e53a54505db32');
    const counts: Record<string, number> = {};
    for (const q of qs.questions) counts[q.category] = (counts[q.category] ?? 0) + 1;
    assert.deepEqual(counts, { callers: 4, references: 4, heritage: 2, impact: 4, definition: 1, abstain: 1 });
    assert.deepEqual(qs.questions.map((q) => q.id), Array.from({ length: 16 }, (_, i) => `p-${String(301 + i)}`));
  });

  it('pair every question with one answer of the same kind and granularity', () => {
    assert.deepEqual(answers.answers.map((a) => a.questionId), qs.questions.map((q) => q.id));
    for (const q of qs.questions) {
      const a = answers.answers.find((x) => x.questionId === q.id)!;
      assert.equal(a.kind, q.key.kind);
      assert.equal(a.granularity, q.key.granularity);
      assert.equal(a.abstain, q.category === 'abstain');
      if (q.category !== 'abstain') assert.ok(a.items.length >= 1, q.id);
    }
  });

  it('keep every key inside the bounds of the tier recorded in its notes', () => {
    for (const q of qs.questions) {
      const a = answers.answers.find((x) => x.questionId === q.id)!;
      if (q.category === 'abstain' || q.category === 'definition') continue;
      const tier = Number(a.notes['tier']) as Tier;
      assert.ok(tier === 1 || tier === 2, q.id);
      const size = q.category === 'heritage' ? a.items.length : new Set(a.items.map((i) => i.file)).size;
      const b = keyBounds(tier, q.category as PilotCategory)!;
      assert.ok(size >= b.min && size <= b.max, `${q.id} has ${String(size)} outside ${String(b.min)}..${String(b.max)}`);
    }
  });

  it('never name the declaring file, but give the package and the role', () => {
    for (const q of qs.questions) {
      if (q.category === 'abstain') continue;
      const key = q.key as { definedIn?: string; symbol?: string };
      const file = key.definedIn!;
      assert.ok(!q.text.includes(file), `${q.id} names ${file}`);
      assert.ok(!q.text.includes(file.split('/').pop()!), `${q.id} names the file name`);
      if (q.category === 'definition') continue;
      assert.ok(q.text.includes(`\`${packageLabel(file)}\``), q.id);
      assert.ok(q.text.includes(roles[`${key.symbol!}@${file}`]!), q.id);
      assert.match(q.text, /A declaration is the target only if it is in the named package and fits the description/, q.id);
      assert.match(q.text, /Angular HTML templates and inline `template:` strings/, q.id);
    }
  });

  it('carry the impact sentence about nested calls and the heritage sentence about same-named subtypes', () => {
    for (const q of qs.questions.filter((x) => x.category === 'impact')) assert.match(q.text, /counts for the nearest enclosing declaration that has a name/, q.id);
    for (const q of qs.questions.filter((x) => x.category === 'heritage')) assert.match(q.text, /A subtype counts even when it has the same name as the target/, q.id);
  });
});
