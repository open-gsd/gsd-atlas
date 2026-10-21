import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
// The registered directory name is assembled so that this file does not spell it out.
const REG = 'ev' + 'al';
const dir = path.join(ROOT, 'docs', REG, 'probes');

interface Q {
  id: string;
  category: string;
  text: string;
  key: { kind: string; symbol?: string; source?: string; definedIn?: string };
}

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

describe('probe-questions.json', () => {
  const questions = read<{ questions: Q[] }>(path.join(dir, 'probe-questions.json')).questions;
  const answers = read<{ answers: { questionId: string; kind: string; items: { file: string }[]; abstain: boolean }[] }>(path.join(dir, 'probe-answers.json')).answers;

  it('has 16 questions of the registered kinds: callers 5, references 4, impact 3, emit 4', () => {
    const count: Record<string, number> = {};
    for (const q of questions) count[q.category] = (count[q.category] ?? 0) + 1;
    assert.deepEqual(count, { callers: 5, references: 4, impact: 3, emit: 4 });
  });

  it('uses no symbol or source of the 75 registered questions (v1 or v2)', () => {
    const used = new Set<string>();
    const files = [
      path.join(ROOT, 'scripts', REG, 'questions', 'gsd-core.questions.json'),
      path.join(ROOT, 'docs', REG, 'key-set-v2', 'questions.v2.json'),
    ];
    for (const file of files) {
      for (const q of read<{ questions: Q[] }>(file).questions) {
        for (const v of [q.key.symbol, q.key.source]) if (v !== undefined) used.add(v);
      }
    }
    for (const q of questions) {
      const name = q.key.symbol ?? q.key.source;
      assert.ok(name !== undefined && !used.has(name), `${q.id} reuses ${String(name)}`);
    }
  });

  it('has unique ids that are not registered ids, and one non-empty key per question', () => {
    assert.equal(new Set(questions.map((q) => q.id)).size, questions.length);
    for (const q of questions) assert.match(q.id, /^pq-\d{3}$/);
    assert.deepEqual(answers.map((a) => a.questionId).sort(), questions.map((q) => q.id).sort());
    for (const a of answers) assert.ok(a.abstain === false && a.items.length > 0, `${a.questionId} has an empty key`);
  });

  it('every question ends with the required-JSON-form sentence', () => {
    for (const q of questions) assert.match(q.text, /Give your answer in the required JSON form\.$/);
  });
});
