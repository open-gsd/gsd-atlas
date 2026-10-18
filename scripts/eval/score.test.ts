import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';

import Ajv2020Module from 'ajv/dist/2020.js';
import { z } from 'zod';

import { computeAnswerKey, type OracleContext } from './oracle.ts';
import { AnswerKeySchema, type AnswerKey, type KeySpec, type Question } from './questions.ts';
import {
  AnswerSchema,
  LINE_SLACK,
  MAX_CITATIONS,
  extractAnswer,
  matchLines,
  matchSets,
  normalisePath,
  projectItems,
  scoreAnswer,
  toResultRow,
  type RowPartial,
  type Scored,
} from './score.ts';

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

// ---------------------------------------------------------------------------------------------
// Task 2: abstain, line slack, granularities, path safety and the result row

/** A key written by hand, validated by the real schema. */
function handKey(fields: { items: AnswerKey['items'] } & Partial<AnswerKey>): AnswerKey {
  return AnswerKeySchema.parse({
    questionId: 'q-1',
    kind: 'callers',
    abstain: false,
    granularity: 'file+symbol',
    equality: 'exact-set',
    needles: [],
    unexplained: [],
    notes: {},
    oracleVersion: 'test',
    ...fields,
  });
}

function tempDir(prefix: string): { dir: string; cleanup(): void } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const handQuestion: Question = question(callersSpec('exact-set'));

describe('score: abstain and giving up', () => {
  const abstainQuestion: Question = {
    id: 'q-9',
    category: 'abstain',
    text: 'Where is noSuchSymbolAnywhere used?',
    key: { kind: 'abstain', probe: { symbol: 'noSuchSymbolAnywhere' }, granularity: 'file', equality: 'exact-set' },
  };
  let abstainKey: AnswerKey;
  let callersKey: AnswerKey;

  before(async () => {
    abstainKey = await computeAnswerKey(abstainQuestion, ctx);
    callersKey = await computeAnswerKey(handQuestion, ctx);
  });

  test('abstain correct', async () => {
    assert.equal(abstainKey.abstain, true);
    const scored = await scoreAnswer(abstainQuestion, abstainKey, answerJson([], 'not_found'), ctx);
    assert.equal(scored.correct, true);
    assert.equal(scored.reason, 'abstain correct');
    assert.equal(scored.answered, 'not_found');
    assert.deepEqual(scored.citation, { applicable: false, total: 0, verified: 0, hasVerifiable: false, failures: [] });
  });

  test('abstain with items', async () => {
    const scored = await scoreAnswer(
      abstainQuestion,
      abstainKey,
      answerJson([{ file: 'src/user.cts', line: 5 }], 'not_found'),
      ctx,
    );
    assert.equal(scored.correct, false);
    assert.equal(scored.reason, 'abstain with items');
    assert.equal(scored.citation.applicable, false);
  });

  test('abstain: found is a fabricated answer, with or without items', async () => {
    for (const items of [[], [{ file: 'src/user.cts', line: 5 }]] as WireItem[][]) {
      const scored = await scoreAnswer(abstainQuestion, abstainKey, answerJson(items, 'found'), ctx);
      assert.equal(scored.correct, false);
      assert.equal(scored.reason, 'fabricated answer');
      assert.equal(scored.answered, 'found');
      assert.equal(scored.citation.applicable, false);
    }
  });

  test('gave up', async () => {
    const scored = await scoreAnswer(handQuestion, callersKey, answerJson([], 'not_found'), ctx);
    assert.equal(scored.correct, false);
    assert.equal(scored.reason, 'gave up');
    assert.equal(scored.answered, 'not_found');
    assert.equal(scored.citation.applicable, true);
    assert.equal(scored.citation.hasVerifiable, false);
  });
});

describe('score: line slack', () => {
  const lineKey = handKey({
    granularity: 'file+line',
    items: [{ file: 'src/user.cts', line: 12 }],
    needles: ['calc', 'compute'],
  });

  test('line slack 2', async () => {
    assert.equal(LINE_SLACK, 2);
    for (const line of [10, 11, 12, 13, 14]) {
      const scored = await scoreAnswer(handQuestion, lineKey, answerJson([{ file: 'src/user.cts', line }]), ctx);
      assert.equal(scored.correct, true, `line ${line}`);
      assert.deepEqual(scored.matched, [{ file: 'src/user.cts', line: 12 }]);
    }
    assert.equal(matchLines(10, 12), 2);
    assert.equal(matchLines(10, 8), 2);
    assert.equal(matchLines(10, 10), 0);
  });

  test('line slack 3', async () => {
    for (const line of [9, 15]) {
      const scored = await scoreAnswer(handQuestion, lineKey, answerJson([{ file: 'src/user.cts', line }]), ctx);
      assert.equal(scored.correct, false, `line ${line}`);
      assert.deepEqual(scored.missing, [{ file: 'src/user.cts', line: 12 }]);
      assert.deepEqual(scored.extra, [{ file: 'src/user.cts', line }]);
    }
    assert.equal(matchLines(10, 13), undefined);
    assert.equal(matchLines(10, 7), undefined);
  });

  test('line slack: each key line is matched once, the second near line is an extra', async () => {
    const items = [
      { file: 'src/user.cts', line: 11 },
      { file: 'src/user.cts', line: 13 },
    ];
    const exact = await scoreAnswer(handQuestion, lineKey, answerJson(items), ctx);
    assert.equal(exact.correct, false);
    assert.equal(exact.reason, 'extra items');
    assert.equal(exact.matched.length, 1);
    assert.equal(exact.extra.length, 1);
    const tolerant = await scoreAnswer(handQuestion, handKey({ ...lineKey, equality: 'superset-ok' }), answerJson(items), ctx);
    assert.equal(tolerant.correct, true);
    assert.equal(tolerant.extra.length, 1);
  });

  test('line slack: matching is cheapest first, so a nearer answer wins the key line', () => {
    const match = matchSets(
      [{ file: 'a.ts', line: 10 }],
      [
        { file: 'a.ts', line: 12 },
        { file: 'a.ts', line: 10 },
      ],
      'file+line',
    );
    assert.deepEqual(match.extra, [{ file: 'a.ts', line: 12 }]);
  });
});

describe('score: granularities', () => {
  test('file granularity ignores symbol and line', async () => {
    const fileQuestion = question(callersSpec('exact-set', 'file'));
    const key = await computeAnswerKey(fileQuestion, ctx);
    assert.deepEqual([...new Set(key.items.map((item) => item.file))], ['consumer.cjs', 'src/user.cts']);
    const items: WireItem[] = [
      { file: 'consumer.cjs', symbol: 'whatever' },
      { file: 'src/user.cts', line: 1, symbol: 'anything' },
    ];
    const scored = await scoreAnswer(fileQuestion, key, answerJson(items), ctx);
    assert.equal(scored.correct, true);
    assert.deepEqual(scored.matched, [{ file: 'consumer.cjs' }, { file: 'src/user.cts' }]);
  });

  test('file+symbol granularity ignores the line', async () => {
    const key = await computeAnswerKey(handQuestion, ctx);
    const items = perfectItems(key).map((item) => ({ ...item, line: 999 }));
    const scored = await scoreAnswer(handQuestion, key, answerJson(items), ctx);
    assert.equal(scored.correct, true);
    assert.equal(scored.citation.verified, 0);
    assert.deepEqual(
      scored.citation.failures.map((failure) => failure.reason),
      ['line out of range', 'line out of range', 'line out of range'],
    );
  });

  test('symbols compare without a trailing () or a leading async', async () => {
    const key = handKey({ items: [{ file: 'src/user.cts', line: 5, symbol: 'useTyped' }] });
    for (const symbol of ['useTyped', 'useTyped()', 'async useTyped', ' async useTyped() ']) {
      const scored = await scoreAnswer(handQuestion, key, answerJson([{ file: 'src/user.cts', symbol }]), ctx);
      assert.equal(scored.correct, true, symbol);
    }
  });

  test('a symbol written as Class.method matches a key symbol method, and not another class', async () => {
    const key = handKey({ items: [{ file: 'src/shapes.cts', line: 4, symbol: 'area' }] });
    for (const symbol of ['Circle.area', 'Circle.area()', 'Circle#area', 'area']) {
      const scored = await scoreAnswer(handQuestion, key, answerJson([{ file: 'src/shapes.cts', symbol }]), ctx);
      assert.equal(scored.correct, true, symbol);
    }
    const qualifiedKey = handKey({ items: [{ file: 'src/shapes.cts', line: 4, symbol: 'Circle.area' }] });
    const same = await scoreAnswer(handQuestion, qualifiedKey, answerJson([{ file: 'src/shapes.cts', symbol: 'area' }]), ctx);
    assert.equal(same.correct, true);
    const other = await scoreAnswer(handQuestion, qualifiedKey, answerJson([{ file: 'src/shapes.cts', symbol: 'Square.area' }]), ctx);
    assert.equal(other.correct, false);
    assert.deepEqual(other.missing, [{ file: 'src/shapes.cts', symbol: 'Circle.area' }]);
  });

  test('projectItems keeps one entry per file or per file and symbol, and every line', () => {
    const items = [
      { file: 'a.ts', line: 1, symbol: 'f' },
      { file: 'a.ts', line: 2, symbol: 'f()' },
      { file: 'a.ts', line: 3, symbol: 'g' },
    ];
    assert.deepEqual(projectItems(items, 'file'), [{ file: 'a.ts' }]);
    assert.deepEqual(projectItems(items, 'file+symbol'), [
      { file: 'a.ts', symbol: 'f' },
      { file: 'a.ts', symbol: 'g' },
    ]);
    assert.equal(projectItems(items, 'file+line').length, 3);
  });
});

describe('score: path safety', () => {
  const roots = [FIXTURE.replace(/\\/g, '/')];

  test('path traversal', async () => {
    const hostile = [
      '../../etc/passwd',
      'src/../../x',
      'C:\\Windows\\x',
      'c:/Windows/x',
      '/absolute/outside/path',
      '\\\\server\\share\\x',
      'src/lib.cts\0.png',
      '..',
      '.',
    ];
    for (const raw of hostile) {
      assert.equal(normalisePath(raw, roots).ok, false, raw);
    }
    const key = handKey({ items: [{ file: 'src/lib.cts', line: 2, symbol: 'compute' }], needles: ['compute'] });
    for (const raw of hostile.slice(0, 7)) {
      const scored = await scoreAnswer(handQuestion, key, answerJson([{ file: raw, line: 1 }]), ctx);
      assert.equal(scored.correct, false, raw);
      assert.equal(scored.reason, 'invalid path', raw);
      assert.deepEqual(scored.citation.failures, [{ file: raw, line: 1, reason: 'path rejected' }], raw);
    }
  });

  test('path forms inside the checkout are normalised, not rejected', async () => {
    const wanted = { ok: true, path: 'src/lib.cts' };
    for (const raw of ['src/lib.cts', './src/lib.cts', 'src\\lib.cts', 'src//lib.cts', `${roots[0]}/src/lib.cts`]) {
      assert.deepEqual(normalisePath(raw, roots), wanted, raw);
    }
    const key = handKey({ items: [{ file: 'src/lib.cts', line: 2, symbol: 'compute' }], needles: ['compute'] });
    const scored = await scoreAnswer(
      handQuestion,
      key,
      answerJson([{ file: `${FIXTURE}/src\\lib.cts`, line: 2, symbol: 'compute' }]),
      ctx,
    );
    assert.equal(scored.correct, true);
    assert.equal(scored.citation.hasVerifiable, true);
  });

  test('symlink out of tree', async (t) => {
    const outside = tempDir('score-outside-');
    const repo = tempDir('score-repo-');
    try {
      fs.writeFileSync(path.join(outside.dir, 'secret.txt'), 'the secret needle\n');
      fs.mkdirSync(path.join(outside.dir, 'sub'));
      fs.writeFileSync(path.join(outside.dir, 'sub', 'inner.txt'), 'needle in a directory\n');
      fs.writeFileSync(path.join(repo.dir, 'real.txt'), 'a needle here\n');
      try {
        fs.symlinkSync(path.join(outside.dir, 'secret.txt'), path.join(repo.dir, 'link.txt'));
        fs.symlinkSync(path.join(outside.dir, 'sub'), path.join(repo.dir, 'linkdir'), 'dir');
        fs.symlinkSync(path.join(repo.dir, 'real.txt'), path.join(repo.dir, 'inner-link.txt'));
      } catch (error) {
        t.skip(`cannot create symbolic links here: ${String(error)}`);
        return;
      }
      const key = handKey({ granularity: 'file', equality: 'superset-ok', items: [{ file: 'real.txt' }], needles: ['needle'] });
      const items: WireItem[] = [
        { file: 'link.txt', line: 1 },
        { file: 'linkdir/inner.txt', line: 1 },
        { file: 'inner-link.txt', line: 1 },
        { file: 'real.txt', line: 1 },
      ];
      const scored = await scoreAnswer(handQuestion, key, answerJson(items), { repoDir: repo.dir, tsconfig: 'tsconfig.json' });
      assert.equal(scored.correct, true);
      assert.equal(scored.citation.total, 4);
      assert.equal(scored.citation.verified, 2, 'a link that stays inside the checkout verifies');
      assert.equal(scored.citation.hasVerifiable, false);
      assert.deepEqual(scored.citation.failures, [
        { file: 'link.txt', line: 1, reason: 'outside checkout' },
        { file: 'linkdir/inner.txt', line: 1, reason: 'outside checkout' },
      ]);
    } finally {
      repo.cleanup();
      outside.cleanup();
    }
  });

  test('BOM and CRLF', async () => {
    const repo = tempDir('score-bom-');
    try {
      fs.writeFileSync(path.join(repo.dir, 'lf.ts'), '// header\nconst compute = 1;\n');
      fs.writeFileSync(path.join(repo.dir, 'crlf.ts'), '\uFEFF// header\r\nconst compute = 1;\r\n');
      const key = handKey({
        granularity: 'file+line',
        equality: 'superset-ok',
        items: [{ file: 'lf.ts', line: 2 }],
        needles: ['compute'],
      });
      const items: WireItem[] = [
        { file: 'lf.ts', line: 2 },
        { file: 'crlf.ts', line: 2 },
        { file: 'crlf.ts', line: 1 },
        { file: 'crlf.ts', line: 3 },
      ];
      const scored = await scoreAnswer(handQuestion, key, answerJson(items), { repoDir: repo.dir, tsconfig: 'tsconfig.json' });
      assert.deepEqual(
        scored.citation.failures.map((failure) => `${failure.file}:${failure.line}:${failure.reason}`),
        ['crlf.ts:1:needle absent', 'crlf.ts:3:line out of range'],
      );
      assert.equal(scored.citation.verified, 2, 'the BOM file verifies the same line as its LF twin');
    } finally {
      repo.cleanup();
    }
  });

  test('too many citations: items beyond the cap are failures and are not verified', async () => {
    assert.equal(MAX_CITATIONS, 200);
    const key = handKey({ items: [{ file: 'src/user.cts', line: 5, symbol: 'useTyped' }], needles: ['compute'] });
    const items: WireItem[] = Array.from({ length: 250 }, () => ({ file: 'src/user.cts', line: 5, symbol: 'useTyped' }));
    const scored = await scoreAnswer(handQuestion, key, answerJson(items), ctx);
    assert.equal(scored.correct, true);
    assert.equal(scored.citation.total, 250);
    assert.equal(scored.citation.verified, 200);
    assert.equal(scored.citation.failures.length, 50);
    assert.ok(scored.citation.failures.every((failure) => failure.reason === 'too many citations'));
    assert.equal(scored.citation.hasVerifiable, false);
  });
});

describe('score: result row', () => {
  const RowMirror = z
    .strictObject({
      questionId: z.string(),
      category: z.string(),
      arm: z.enum(['atlas', 'grep']),
      run: z.number().int().min(1),
      status: z.enum(['ok', 'error', 'timeout', 'budget', 'killed']),
      answered: z.enum(['found', 'not_found', 'none']),
      correct: z.boolean(),
      citation: z.strictObject({
        applicable: z.boolean(),
        total: z.number().int().min(0),
        verified: z.number().int().min(0),
        hasVerifiable: z.boolean(),
      }),
      usage: z.strictObject({
        input: z.number().int().min(0),
        output: z.number().int().min(0),
        cacheCreation: z.number().int().min(0),
        cacheRead: z.number().int().min(0),
      }),
      billableTokens: z.number().int().min(0),
      toolCalls: z.number().int().min(0),
      toolCallsByName: z.record(z.string(), z.number().int().min(0)),
      atlasToolCalls: z.number().int().min(0),
      wallMs: z.number().min(0),
      costUsd: z.number().min(0).nullable(),
    })
    .refine((row) => row.billableTokens === row.usage.input + row.usage.output + row.usage.cacheCreation + row.usage.cacheRead);

  const partial: RowPartial = {
    questionId: 'q-1',
    category: 'callers',
    arm: 'atlas',
    run: 1,
    status: 'ok',
    usage: { input: 10, output: 20, cacheCreation: 30, cacheRead: 40 },
    toolCalls: 3,
    toolCallsByName: { Read: 2, Grep: 1 },
    atlasToolCalls: 0,
    wallMs: 1234,
    costUsd: null,
  };

  async function realSchema(): Promise<{ parse(value: unknown): unknown } | undefined> {
    // rows.ts belongs to plan 03-05; it is validated here only when it is present.
    const specifier = './rows.ts';
    const loaded = (await import(specifier).catch(() => undefined)) as { ResultRowSchema?: { parse(value: unknown): unknown } } | undefined;
    return loaded?.ResultRowSchema;
  }

  test('result row', async () => {
    const key = await computeAnswerKey(handQuestion, ctx);
    const scored = await scoreAnswer(handQuestion, key, answerJson(perfectItems(key)), ctx);
    const row = toResultRow(partial, scored);
    assert.equal(row.correct, true);
    assert.equal(row.answered, 'found');
    assert.equal(row.billableTokens, 100);
    assert.deepEqual(row.citation, { applicable: true, total: 3, verified: 3, hasVerifiable: true });
    assert.doesNotThrow(() => RowMirror.parse(row));
    const real = await realSchema();
    if (real !== undefined) assert.doesNotThrow(() => real.parse(row));
  });

  test('result row: an abstain question carries citation.applicable false', async () => {
    const abstainQuestion: Question = {
      id: 'q-9',
      category: 'abstain',
      text: 'Where is noSuchSymbolAnywhere used?',
      key: { kind: 'abstain', probe: { symbol: 'noSuchSymbolAnywhere' }, granularity: 'file', equality: 'exact-set' },
    };
    const key = await computeAnswerKey(abstainQuestion, ctx);
    const scored: Scored = await scoreAnswer(abstainQuestion, key, answerJson([], 'not_found'), ctx);
    const row = toResultRow({ ...partial, questionId: 'q-9', category: 'abstain', arm: 'grep' }, scored);
    assert.equal(row.correct, true);
    assert.equal(row.citation.applicable, false);
    assert.doesNotThrow(() => RowMirror.parse(row));
    const real = await realSchema();
    if (real !== undefined) assert.doesNotThrow(() => real.parse(row));
  });

  test('result row: an unparseable answer is incorrect with answered none', async () => {
    const key = await computeAnswerKey(handQuestion, ctx);
    const scored = await scoreAnswer(handQuestion, key, 'I could not decide.', ctx);
    const row = toResultRow({ ...partial, status: 'error' }, scored);
    assert.equal(row.correct, false);
    assert.equal(row.answered, 'none');
    assert.doesNotThrow(() => RowMirror.parse(row));
  });

  test('result row: a wrong usage report is refused, not summed', async () => {
    const key = await computeAnswerKey(handQuestion, ctx);
    const scored = await scoreAnswer(handQuestion, key, answerJson(perfectItems(key)), ctx);
    assert.throws(() => toResultRow({ ...partial, usage: { ...partial.usage, input: -1 } }, scored), RangeError);
  });
});
