import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';

import Ajv2020Module from 'ajv/dist/2020.js';

import { computeAnswerKey, type OracleContext } from './oracle.ts';
import type { AnswerKey, KeySpec, Question } from './questions.ts';
import { AnswerSchema, LINE_SLACK, extractAnswer, scoreAnswer } from './score.ts';

const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'oracle-repo');
const ctx: OracleContext = { repoDir: FIXTURE, tsconfig: 'tsconfig.json' };

// ajv is a CommonJS package: under nodenext the class sits on `.default` of the default import.
type AjvCtor = new (options: { allErrors: boolean }) => {
  compile(schema: object): (data: unknown) => boolean;
};
const Ajv2020 = (Ajv2020Module as unknown as { default: AjvCtor }).default;

type WireItem = { file: string; line?: number; symbol?: string };

function callersSpec(equality: 'exact-set' | 'superset-ok', granularity: 'file' | 'file+symbol' | 'file+line' = 'file+symbol'): KeySpec {
  return { kind: 'callers', symbol: 'compute', definedIn: 'src/lib.cts', granularity, equality };
}

function question(spec: KeySpec, id = 'q-1'): Question {
  return { id, category: 'callers', text: 'Which functions call compute?', key: spec };
}

/** The wire items of a perfect answer, built from the computed key so a fixture edit cannot desynchronise a test. */
function perfectItems(key: AnswerKey): WireItem[] {
  return key.items.map((item) => ({
    file: item.file as string,
    ...(item.line === undefined ? {} : { line: item.line }),
    ...(item.symbol === undefined ? {} : { symbol: item.symbol }),
  }));
}

function answerJson(items: WireItem[], answer: 'found' | 'not_found' = 'found', summary = 'ok'): string {
  return JSON.stringify({ answer, items, summary });
}

describe('score: callers question on the oracle fixture', () => {
  let exactQuestion: Question;
  let exactKey: AnswerKey;
  let supersetQuestion: Question;
  let supersetKey: AnswerKey;

  before(async () => {
    exactQuestion = question(callersSpec('exact-set'));
    exactKey = await computeAnswerKey(exactQuestion, ctx);
    supersetQuestion = question(callersSpec('superset-ok'));
    supersetKey = await computeAnswerKey(supersetQuestion, ctx);
  });

  test('perfect answer', async () => {
    const scored = await scoreAnswer(exactQuestion, exactKey, answerJson(perfectItems(exactKey)), ctx);
    assert.equal(scored.correct, true);
    assert.equal(scored.reason, 'correct');
    assert.equal(scored.answered, 'found');
    assert.equal(scored.matched.length, exactKey.items.length);
    assert.deepEqual(scored.missing, []);
    assert.deepEqual(scored.extra, []);
    assert.deepEqual(scored.citation, {
      applicable: true,
      total: exactKey.items.length,
      verified: exactKey.items.length,
      hasVerifiable: true,
      failures: [],
    });
  });

  test('missing item', async () => {
    const items = perfectItems(exactKey);
    const dropped = items.pop() as WireItem;
    const scored = await scoreAnswer(exactQuestion, exactKey, answerJson(items), ctx);
    assert.equal(scored.correct, false);
    assert.equal(scored.reason, 'missing items');
    assert.deepEqual(scored.missing, [{ file: dropped.file, symbol: dropped.symbol }]);
    assert.deepEqual(scored.extra, []);
    assert.equal(scored.matched.length, exactKey.items.length - 1);
  });

  test('extra item exact-set', async () => {
    const extra: WireItem = { file: 'src/lib.cts', line: 2, symbol: 'compute' };
    const scored = await scoreAnswer(exactQuestion, exactKey, answerJson([...perfectItems(exactKey), extra]), ctx);
    assert.equal(scored.correct, false);
    assert.equal(scored.reason, 'extra items');
    assert.deepEqual(scored.extra, [{ file: 'src/lib.cts', symbol: 'compute' }]);
    assert.deepEqual(scored.missing, []);
  });

  test('extra item superset-ok', async () => {
    const extra: WireItem = { file: 'src/lib.cts', line: 2, symbol: 'compute' };
    const scored = await scoreAnswer(supersetQuestion, supersetKey, answerJson([...perfectItems(supersetKey), extra]), ctx);
    assert.equal(scored.correct, true);
    assert.equal(scored.reason, 'correct');
    assert.deepEqual(scored.extra, [{ file: 'src/lib.cts', symbol: 'compute' }]);
    assert.deepEqual(scored.missing, []);
  });

  test('unparseable answer', async () => {
    const samples: Record<string, string> = {
      'not json': 'The callers are run, useTyped and useRequire.',
      'empty text': '',
      'unknown property': JSON.stringify({ answer: 'found', items: [], summary: 'x', confidence: 1 }),
      'answer outside the two values': JSON.stringify({ answer: 'maybe', items: [], summary: 'x' }),
      'negative line': answerJson([{ file: 'src/user.cts', line: -1 }]),
      'summary of 401 characters': answerJson([], 'found', 'x'.repeat(401)),
      'two objects': `${answerJson([])} ${answerJson([])}`,
    };
    for (const [name, text] of Object.entries(samples)) {
      const scored = await scoreAnswer(exactQuestion, exactKey, text, ctx);
      assert.equal(scored.correct, false, name);
      assert.equal(scored.reason, 'unparseable answer', name);
      assert.equal(scored.answered, 'none', name);
      assert.deepEqual(scored.matched, [], name);
    }
  });

  test('unparseable answer: the single tolerance is the outermost braces', () => {
    const clean = answerJson([{ file: 'src/user.cts', line: 5 }]);
    assert.equal(extractAnswer(clean).ok, true);
    const wrapped = extractAnswer(`Here is my answer:\n${clean}\nHope it helps.`);
    assert.equal(wrapped.ok, true);
    // a fenced block is the same tolerance, nothing more is repaired
    assert.equal(extractAnswer(`\`\`\`json\n${clean}\n\`\`\``).ok, true);
    const loose = extractAnswer("{answer: 'found', items: [], summary: 'single quotes and bare keys'}");
    assert.equal(loose.ok, false);
    if (!loose.ok) assert.equal(loose.reason, 'unparseable answer');
    // JSON that parses as a whole but breaks the schema is not retried through the braces
    assert.equal(extractAnswer(JSON.stringify([{ answer: 'found', items: [], summary: '' }])).ok, false);
  });

  test('citation: a cited line without any needle fails and is listed', async () => {
    const userLines = fs.readFileSync(path.join(FIXTURE, 'src', 'user.cts'), 'utf8').split('\n');
    const needleFree = userLines.findIndex((line) => !/calc|compute/i.test(line)) + 1;
    assert.ok(needleFree >= 1);
    const items = perfectItems(exactKey).map((item) =>
      item.symbol === 'useTyped' ? { ...item, line: needleFree } : item,
    );
    const scored = await scoreAnswer(exactQuestion, exactKey, answerJson(items), ctx);
    assert.equal(scored.correct, true, 'file+symbol granularity ignores the line');
    assert.equal(scored.citation.total, exactKey.items.length);
    assert.equal(scored.citation.verified, exactKey.items.length - 1);
    assert.equal(scored.citation.hasVerifiable, false);
    assert.deepEqual(scored.citation.failures, [{ file: 'src/user.cts', line: needleFree, reason: 'needle absent' }]);
  });

  test('citation: an item without a line neither helps nor hurts', async () => {
    const items = perfectItems(exactKey);
    const withoutOne = items.map((item, index) => (index === 0 ? { file: item.file, symbol: item.symbol } : item));
    const some = await scoreAnswer(exactQuestion, exactKey, answerJson(withoutOne), ctx);
    assert.equal(some.correct, true);
    assert.equal(some.citation.total, exactKey.items.length - 1);
    assert.equal(some.citation.verified, exactKey.items.length - 1);
    assert.equal(some.citation.hasVerifiable, true);

    const withoutAny = items.map((item) => ({ file: item.file, symbol: item.symbol }));
    const none = await scoreAnswer(exactQuestion, exactKey, answerJson(withoutAny), ctx);
    assert.equal(none.correct, true);
    assert.equal(none.citation.total, 0);
    assert.equal(none.citation.hasVerifiable, false);
  });
});

describe('score: schema agreement between the zod twin and answer-schema.json', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'answer-schema.json'), 'utf8')) as object;
  const validate = new Ajv2020({ allErrors: true }).compile(schema);

  const samples: Array<{ name: string; valid: boolean; value: unknown }> = [
    { name: 'found with a file only', valid: true, value: { answer: 'found', items: [{ file: 'a.ts' }], summary: '' } },
    { name: 'not_found with no items', valid: true, value: { answer: 'not_found', items: [], summary: 'nothing' } },
    {
      name: 'file, line and symbol',
      valid: true,
      value: { answer: 'found', items: [{ file: 'a.ts', line: 3, symbol: 'f' }], summary: 'x' },
    },
    { name: 'summary of exactly 400 characters', valid: true, value: { answer: 'found', items: [], summary: 'x'.repeat(400) } },
    {
      name: 'summary of 400 astral characters',
      valid: true,
      value: { answer: 'found', items: [], summary: '\u{1F600}'.repeat(400) },
    },
    { name: 'unknown top-level property', valid: false, value: { answer: 'found', items: [], summary: '', extra: 1 } },
    { name: 'answer outside the two values', valid: false, value: { answer: 'maybe', items: [], summary: '' } },
    { name: 'negative line', valid: false, value: { answer: 'found', items: [{ file: 'a.ts', line: -2 }], summary: '' } },
    { name: 'summary of 401 characters', valid: false, value: { answer: 'found', items: [], summary: 'x'.repeat(401) } },
    {
      name: 'unknown property inside an item',
      valid: false,
      value: { answer: 'found', items: [{ file: 'a.ts', column: 1 }], summary: '' },
    },
  ];

  test('schema agreement: ten samples are accepted and rejected identically', () => {
    assert.equal(samples.length, 10);
    for (const sample of samples) {
      assert.equal(validate(sample.value), sample.valid, `ajv: ${sample.name}`);
      assert.equal(AnswerSchema.safeParse(sample.value).success, sample.valid, `zod: ${sample.name}`);
    }
  });

  test('schema agreement: more edges', () => {
    const edges: unknown[] = [
      { answer: 'found', items: [{ file: 'a.ts', line: 1.5 }], summary: '' },
      { answer: 'found', items: [{ file: 'a.ts', line: 0 }], summary: '' },
      { answer: 'found', items: [{ file: '' }], summary: '' },
      { answer: 'found', items: [{ line: 3 }], summary: '' },
      { answer: 'found', items: [{ file: 'a.ts', symbol: 7 }], summary: '' },
      { answer: 'found', items: [{ file: 'a.ts', line: '3' }], summary: '' },
      { answer: 'found', items: [] },
      { items: [], summary: '' },
      { answer: 'found', summary: '' },
      { answer: 'found', items: {}, summary: '' },
      [],
      null,
      'found',
    ];
    for (const value of edges) {
      assert.equal(validate(value), false, `ajv: ${JSON.stringify(value)}`);
      assert.equal(AnswerSchema.safeParse(value).success, false, `zod: ${JSON.stringify(value)}`);
    }
  });

  test('schema agreement: the file forbids additional properties at the top level and inside items', () => {
    const parsed = schema as { additionalProperties?: unknown; properties: { items: { items: { additionalProperties?: unknown } } } };
    assert.equal(parsed.additionalProperties, false);
    assert.equal(parsed.properties.items.items.additionalProperties, false);
    assert.equal(LINE_SLACK, 2);
  });
});
