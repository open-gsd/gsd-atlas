import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';

import {
  CANDIDATE_REASONS,
  CandidatesFileSchema,
  PILOT_COUNT,
  SCORED_MIX,
  buildCensus,
  decide,
  draftCandidates,
  identityOfKey,
  mulberry32,
  orderCandidates,
  pickPilotCategories,
  projectedSize,
  renderReview,
  sample,
  serializeCandidates,
  type Candidate,
  type Census,
  type DecideInput,
  type ExportEntry,
  type ReviewInput,
} from './draft-census.ts';
import { computeAnswerKey, type OracleContext } from './oracle.ts';
import {
  AnswerFileSchema,
  CategorySchema,
  KeySpecSchema,
  loadQuestions,
  type AnswerItem,
  type AnswerKey,
  type Category,
  type Granularity,
} from './questions.ts';

const FIXTURE = path.join(import.meta.dirname, '__fixtures__', 'oracle-repo');
const CTX: OracleContext = { repoDir: FIXTURE, tsconfig: 'tsconfig.json' };

function fn(symbol: string, calls = 1): ExportEntry {
  return {
    symbol,
    file: `src/${symbol.toLowerCase()}.cts`,
    line: 3,
    kind: 'function',
    calls,
    callerFiles: calls,
    refs: calls + 1,
    nameCount: 1,
  };
}

/** A census with eight exported functions that all have callers, no fixture needed. */
function synthetic(order: 'forward' | 'reversed' = 'forward'): Census {
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  let exports = names.map((name) => fn(name));
  if (order === 'reversed') {
    exports = [...exports].reverse().map((entry) => Object.fromEntries(Object.entries(entry).reverse()) as unknown as ExportEntry);
  }
  return { exports, types: [], libTypes: [], emits: [], adrs: [], adrOf: [], nearMisses: [] };
}

function names(candidates: readonly Candidate[]): string[] {
  return candidates.map((candidate) => candidate.name);
}

describe('mulberry32', () => {
  test('matches the published recurrence', () => {
    const next = mulberry32(1);
    assert.equal(next(), 0.6270739405881613);
    assert.equal(next(), 0.002735721180215478);
    assert.equal(next(), 0.5274470399599522);
  });
});

describe('census', () => {
  let census: Census;
  before(async () => {
    census = await buildCensus(CTX);
  });

  test('census lists exported functions with callers, subtyped types, emit outputs and ADR files', () => {
    const compute = census.exports.find((entry) => entry.symbol === 'compute');
    assert.ok(compute, 'compute is listed');
    assert.equal(compute.kind, 'function');
    assert.equal(compute.file, 'src/lib.cts');
    assert.equal(compute.calls, 3);
    assert.equal(compute.callerFiles, 2);
    assert.equal(compute.nameCount, 1);

    const base = census.types.find((entry) => entry.symbol === 'Base');
    assert.ok(base, 'Base is listed');
    assert.equal(base.kind, 'class');
    assert.equal(base.subtypes, 1);
    assert.equal(census.types.find((entry) => entry.symbol === 'Shape')?.kind, 'interface');
    assert.deepEqual(census.libTypes, [{ symbol: 'Error', subtypes: 1 }]);

    const lib = census.emits.find((entry) => entry.source === 'src/lib.cts');
    assert.ok(lib, 'src/lib.cts is listed');
    assert.deepEqual(lib.outputs, ['out/lib.cjs']);
    assert.equal(lib.requirers, 2);
    assert.equal(census.emits.find((entry) => entry.source === 'src/shapes.cts')?.requirers, 0);

    assert.deepEqual(
      census.adrs.map((entry) => [entry.number, entry.files]),
      [
        [1, ['docs/adr/0001-first.md']],
        [2, ['docs/adr/2-second.md']],
        [3, []],
      ],
    );
    assert.deepEqual(census.adrOf.find((entry) => entry.symbol === 'helper')?.adrs, [1]);
  });

  test('strings are not citations', () => {
    // user.cts mentions ADR-9 only inside a string literal; it must not appear anywhere.
    assert.equal(census.adrs.some((entry) => entry.number === 9), false);
    assert.equal(census.adrOf.some((entry) => entry.adrs.includes(9)), false);
  });

  test('names that are only text are not exports and a local function is not a declaration of the name', () => {
    assert.equal(census.exports.some((entry) => entry.symbol === 'note' && entry.calls > 0), false);
    // `unrelated` declares a local `compute`; it is not a top-level or member declaration.
    assert.equal(census.exports.find((entry) => entry.symbol === 'compute')?.nameCount, 1);
  });

  test('every candidate of every category is a valid key spec the oracle accepts', async () => {
    for (const category of CategorySchema.options) {
      const ordered = orderCandidates(census, category, 7);
      for (const candidate of ordered) {
        const parsed = KeySpecSchema.safeParse(candidate.key);
        assert.ok(parsed.success, `${category}/${candidate.name}: ${parsed.success ? '' : parsed.error.message}`);
        const answer = await computeAnswerKey(candidate.key, CTX);
        assert.equal(answer.kind, candidate.key.kind);
      }
    }
    const categories = new Set<Category>();
    for (const category of CategorySchema.options) {
      if (orderCandidates(census, category, 7).length > 0) categories.add(category);
    }
    for (const needed of ['callers', 'references', 'heritage', 'emit', 'adr', 'impact', 'definition', 'abstain'] as const) {
      assert.ok(categories.has(needed), `the fixture census yields ${needed} candidates`);
    }
  });
});

describe('ordering', () => {
  test('deterministic order: the same census and seed give the same order, whatever the insertion order', () => {
    const first = names(orderCandidates(synthetic(), 'callers', 7));
    const second = names(orderCandidates(synthetic(), 'callers', 7));
    const shuffledInput = names(orderCandidates(synthetic('reversed'), 'callers', 7));
    assert.equal(first.length, 8);
    assert.deepEqual(second, first);
    assert.deepEqual(shuffledInput, first);
    assert.deepEqual([...first].sort(), ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']);
  });

  test('different seed gives a different order for at least five items', () => {
    const seven = names(orderCandidates(synthetic(), 'callers', 7));
    const eight = names(orderCandidates(synthetic(), 'callers', 8));
    assert.notDeepEqual(eight, seven);
    assert.deepEqual([...eight].sort(), [...seven].sort());
  });

  test('each candidate carries a key spec for its category and a stable identity', () => {
    const ordered = orderCandidates(synthetic(), 'callers', 7);
    for (const candidate of ordered) {
      assert.equal(candidate.category, 'callers');
      assert.equal(candidate.key.kind, 'callers');
      assert.equal(candidate.identity, `sym:${candidate.name}`);
    }
  });

  test('continuation: sample with skip returns the next candidates of the same ordered list', () => {
    const census = synthetic();
    const head = sample(census, 'callers', 2, { seed: 7, skip: 0 });
    const tail = sample(census, 'callers', 2, { seed: 7, skip: 2 });
    const all = sample(census, 'callers', 4, { seed: 7, skip: 0 });
    assert.equal(head.length, 2);
    assert.equal(tail.length, 2);
    assert.equal(new Set([...names(head), ...names(tail)]).size, 4, 'no candidate is returned twice');
    assert.deepEqual([...names(head), ...names(tail)], names(all));
    assert.deepEqual(names(all), names(orderCandidates(census, 'callers', 7)).slice(0, 4));
  });

  test('sample past the end returns what is left, and nothing beyond it', () => {
    const census = synthetic();
    assert.equal(sample(census, 'callers', 5, { seed: 7, skip: 6 }).length, 2);
    assert.equal(sample(census, 'callers', 5, { seed: 7, skip: 99 }).length, 0);
  });

  test('categories use different shuffles of the same seed', () => {
    const census = synthetic();
    census.types = [];
    const callers = names(orderCandidates(census, 'callers', 7));
    const impact = names(orderCandidates(census, 'impact', 7));
    assert.deepEqual([...impact].sort(), [...callers].sort());
    assert.notDeepEqual(impact, callers);
  });
});

function answerKey(overrides: Partial<AnswerKey> = {}): AnswerKey {
  return {
    questionId: 'q-0',
    kind: 'callers',
    abstain: false,
    items: [{ file: 'src/a.cts', line: 3, symbol: 'f' }],
    granularity: 'file',
    equality: 'exact-set',
    needles: [],
    unexplained: [],
    notes: {},
    oracleVersion: 'test',
    ...overrides,
  };
}

function filesItems(count: number): AnswerItem[] {
  return Array.from({ length: count }, (_unused, index) => ({ file: `src/f${index}.cts`, line: 1, symbol: 'f' }));
}

interface DecidePatch {
  nameCount?: number;
  candidate?: Candidate;
  answer?: AnswerKey;
  error?: { code: string; message: string };
  used?: ReadonlyMap<string, 'scored' | 'pilot' | 'reserved'>;
}

/** A decide input for the first synthetic callers candidate, with a clean answer unless patched. */
function decideInput(patch: DecidePatch = {}): DecideInput {
  const base = orderCandidates(synthetic(), 'callers', 7)[0];
  assert.ok(base);
  const candidate: Candidate = patch.candidate ?? structuredClone(base);
  if (patch.nameCount !== undefined) candidate.facts.nameCount = patch.nameCount;
  const input: DecideInput = { candidate, used: patch.used ?? new Map() };
  if (patch.error !== undefined) input.error = patch.error;
  else input.answer = patch.answer ?? answerKey();
  return input;
}

function reasonOf(decision: ReturnType<typeof decide>): string | undefined {
  return decision.status === 'rejected' ? decision.reason : undefined;
}

describe('projectedSize', () => {
  test('counts distinct files, file and symbol pairs, or file and line pairs by granularity', () => {
    const items: AnswerItem[] = [
      { file: 'src/a.cts', line: 1, symbol: 'f' },
      { file: 'src/a.cts', line: 9, symbol: 'f' },
      { file: 'src/a.cts', line: 12, symbol: 'g' },
      { file: 'src/b.cts', line: 1, symbol: 'f' },
      { file: 'docs/adr/0001-x.md', adr: 1, resolved: true },
    ];
    const size = (granularity: Granularity): number => projectedSize(items, granularity);
    assert.equal(size('file'), 3);
    assert.equal(size('file+symbol'), 4);
    assert.equal(size('file+line'), 5);
  });

  test('an item without a file (an unresolved citation) counts for nothing', () => {
    assert.equal(projectedSize([{ adr: 3, resolved: false }, { file: 'src/a.cts', line: 1 }], 'file'), 1);
  });
});

describe('decide', () => {
  test('a clean candidate with one to thirty expected files is accepted', () => {
    assert.deepEqual(decide(decideInput()), { status: 'accepted' });
    assert.deepEqual(decide(decideInput({ answer: answerKey({ items: filesItems(30) }) })), { status: 'accepted' });
  });

  test('many sites in a few files is not too large', () => {
    const items = Array.from({ length: 80 }, (_unused, index) => ({ file: `src/f${index % 3}.cts`, line: index + 1 }));
    assert.deepEqual(decide(decideInput({ answer: answerKey({ items }) })), { status: 'accepted' });
  });

  test('too-large: more than thirty expected files', () => {
    const decision = decide(decideInput({ answer: answerKey({ items: filesItems(31) }) }));
    assert.equal(decision.status, 'rejected');
    assert.equal(decision.status === 'rejected' && decision.reason, 'too-large');
  });

  test('empty: a non-abstain key with nothing in it', () => {
    const decision = decide(decideInput({ answer: answerKey({ items: [] }) }));
    assert.equal(decision.status === 'rejected' && decision.reason, 'empty');
  });

  test('unexplained: a key with a mention the compiler result neither includes nor classifies', () => {
    const answer = answerKey({ unexplained: [{ file: 'src/z.cts', line: 4, text: 'x' }] });
    assert.equal((decide(decideInput({ answer })) as { reason: string }).reason, 'unexplained');
  });

  test('unexplained: an adr-of key with a citation that has no ADR file', () => {
    const candidate = decideInput().candidate;
    candidate.key = { kind: 'adr-of', symbol: 'alpha', definedIn: 'src/alpha.cts', granularity: 'file', equality: 'exact-set' };
    const answer = answerKey({ kind: 'adr-of', items: [{ file: 'docs/adr/1-x.md', adr: 1, resolved: true }, { adr: 7, resolved: false }] });
    assert.equal((decide(decideInput({ candidate, answer })) as { reason: string }).reason, 'unexplained');
  });

  test('duplicate-symbol and used-by-pilot depend on who holds the identity', () => {
    const identity = decideInput().candidate.identity;
    const held = (holder: 'scored' | 'pilot' | 'reserved') => decide(decideInput({ used: new Map([[identity, holder]]) }));
    assert.equal(reasonOf(held('scored')), 'duplicate-symbol');
    assert.equal(reasonOf(held('reserved')), 'duplicate-symbol');
    assert.equal(reasonOf(held('pilot')), 'used-by-pilot');
    assert.equal(reasonOf(decide(decideInput({ used: new Map([['sym:somethingElse', 'scored']]) }))), undefined);
  });

  test('ambiguous-name: a name declared more than once, or an oracle that refuses it', () => {
    assert.equal(reasonOf(decide(decideInput({ nameCount: 2 }))), 'ambiguous-name');
    assert.equal(reasonOf(decide(decideInput({ error: { code: 'SYMBOL_AMBIGUOUS', message: 'two symbols' } }))), 'ambiguous-name');
    assert.equal(reasonOf(decide(decideInput({ error: { code: 'ABSTAIN_PROBE_MATCHES', message: 'present' } }))), 'ambiguous-name');
  });

  test('any other oracle error is a bug in the draft, not a rejection', () => {
    assert.throws(() => decide(decideInput({ error: { code: 'SYMBOL_NOT_FOUND', message: 'gone' } })), /SYMBOL_NOT_FOUND/);
  });

  test('abstain: accepted when the key abstains, with no items', () => {
    const candidate = decideInput().candidate;
    candidate.key = { kind: 'abstain', probe: { symbol: 'nope' }, granularity: 'file', equality: 'exact-set' };
    candidate.facts.nameCount = 0;
    const answer = answerKey({ kind: 'abstain', abstain: true, items: [] });
    assert.deepEqual(decide(decideInput({ candidate, answer })), { status: 'accepted' });
  });
});

describe('pickPilotCategories', () => {
  test('picks the requested number of different categories in category order, the same ones every time', () => {
    const first = pickPilotCategories(20261017, PILOT_COUNT);
    assert.equal(first.length, PILOT_COUNT);
    assert.equal(new Set(first).size, PILOT_COUNT);
    assert.deepEqual(first, pickPilotCategories(20261017, PILOT_COUNT));
    const order = CategorySchema.options;
    assert.deepEqual(first, [...first].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    assert.equal(pickPilotCategories(20261017, 2).length, 2);
  });

  test('the registered mix sums to fifty with abstain at twelve percent', () => {
    const total = Object.values(SCORED_MIX).reduce((sum, groups) => sum + Object.values(groups).reduce((a, b) => a + b, 0), 0);
    assert.equal(total, 50);
    assert.equal(Object.values(SCORED_MIX.abstain).reduce((a, b) => a + b, 0), 6);
  });
});

describe('draftCandidates', () => {
  const MIX = {
    callers: { callers: 1 },
    heritage: { heritage: 1 },
    emit: { 'emit-outputs': 1 },
    abstain: { 'abstain-symbol': 1, 'abstain-adr': 1 },
  } as const;
  let census: Census;
  before(async () => {
    census = await buildCensus(CTX);
  });

  function options(extra: Record<string, unknown> = {}) {
    // The fixture is tiny, so the pilot categories are named instead of picked by the seed.
    return { seed: 20261017, corpusId: 'oracle-fixture', corpusSha: 'abc', mix: MIX, pilotCategories: ['callers', 'heritage'] as Category[], ...extra };
  }

  test('every candidate is decided once, the quotas and the pilot are met, and ids are assigned in order', async () => {
    const file = await draftCandidates(census, CTX, options());
    CandidatesFileSchema.parse(file);
    assert.equal(file.pilotCategories.length, 2);
    const accepted = Object.values(file.categories).flat().filter((record) => record.status === 'accepted');
    const scored = accepted.filter((record) => record.slot === 'scored');
    const pilot = accepted.filter((record) => record.slot === 'pilot');
    assert.equal(scored.length, 5);
    assert.equal(pilot.length, 2);
    assert.deepEqual(scored.map((record) => record.questionId), ['q-001', 'q-002', 'q-003', 'q-004', 'q-005']);
    assert.deepEqual(pilot.map((record) => record.questionId), ['p-001', 'p-002']);
    for (const category of CategorySchema.options) {
      const records = file.categories[category] ?? [];
      assert.deepEqual(records.map((record) => record.rank), records.map((_unused, index) => index + 1), `${category} ranks are contiguous`);
      const wanted = Object.values(MIX[category as keyof typeof MIX] ?? {}).reduce((a, b) => a + b, 0) + (file.pilotCategories.includes(category) ? 1 : 0);
      assert.equal(records.filter((record) => record.status === 'accepted').length, wanted, `${category} accepted count`);
      for (const record of records) {
        assert.equal(record.status === 'rejected', record.reason !== undefined, `${category} rank ${record.rank}: a reason goes with a rejection`);
      }
    }
  });

  test('no identity is used twice and the pilot shares no identity with the scored set', async () => {
    const file = await draftCandidates(census, CTX, options());
    const accepted = Object.values(file.categories).flat().filter((record) => record.status === 'accepted');
    const identities = accepted.map((record) => record.identity);
    assert.equal(new Set(identities).size, identities.length);
    for (const record of accepted) assert.equal(record.identity, identityOfKey(record.key));
  });

  test('the same census and seed give a byte-identical file', async () => {
    const first = serializeCandidates(await draftCandidates(census, CTX, options()));
    const second = serializeCandidates(await draftCandidates(census, CTX, options()));
    assert.equal(first, second);
  });

  test('a reserved identity is rejected as duplicate-symbol and recorded', async () => {
    const head = orderCandidates(census, 'callers', 20261017)[0];
    assert.ok(head);
    const file = await draftCandidates(census, CTX, options({ reserved: [head.identity] }));
    const record = (file.categories.callers ?? []).find((entry) => entry.identity === head.identity);
    assert.equal(record?.status, 'rejected');
    assert.equal(record?.reason, 'duplicate-symbol');
  });

  test('asking for more than the census offers fails loudly', async () => {
    await assert.rejects(draftCandidates(census, CTX, options({ mix: { callers: { callers: 10 } } })), /not enough/);
  });
});

describe('review document', () => {
  const DIR = path.join(import.meta.dirname, 'questions');
  const DOC = path.join(import.meta.dirname, '..', '..', 'docs', 'eval', 'questions-review.md');
  const SCRIPT = path.join(import.meta.dirname, 'draft-census.ts');

  function readJson(file: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as unknown;
  }

  function inputs(): ReviewInput {
    return {
      questions: loadQuestions(path.join(DIR, 'gsd-core.questions.json')),
      answers: AnswerFileSchema.parse(readJson('gsd-core.answers.json')),
      pilotQuestions: loadQuestions(path.join(DIR, 'pilot.questions.json')),
      pilotAnswers: AnswerFileSchema.parse(readJson('pilot.answers.json')),
      candidates: CandidatesFileSchema.parse(readJson('candidates.json')),
    };
  }

  test('review opens with the attestation, then the corpus sha, the preparation record, the seed and the category table', () => {
    const doc = renderReview(inputs());
    const lines = doc.split('\n');
    assert.match(lines[0] ?? '', /^# /, 'a title comes first');
    assert.ok(lines.includes('Drafted without running atlas: yes'), 'the attestation line is present on its own line');
    const first = doc.indexOf('Drafted without running atlas: yes');
    for (const needle of [
      '10ac3a7a947903ba50f538a907af036744d759d5',
      '`npm ci --ignore-scripts`: yes',
      'TypeScript 6.0.3',
      'dccc7f1cc3cd7ee9b8d071a03def1e7a4a535cc68a1828df2b797c6aecb357fb',
      '20261017',
    ]) {
      const at = doc.indexOf(needle);
      assert.ok(at > first, `${needle} follows the attestation`);
      assert.ok(at < doc.indexOf('### q-001'), `${needle} comes before the first question`);
    }
    const input = inputs();
    for (const category of CategorySchema.options) {
      const count = input.questions.questions.filter((question) => question.category === category).length;
      const pilot = (input.pilotQuestions?.questions ?? []).filter((question) => question.category === category).length;
      const share = `${Math.round((100 * count) / 50)}%`;
      assert.ok(doc.includes(`| ${category} | ${count} | ${share} | ${pilot} |`), `the table row for ${category}`);
    }
    assert.ok(doc.includes('| total | 50 | 100% | 5 |'));
  });

  test('one block per scored question and per pilot question, with granularity, equality, size and first expected items', () => {
    const input = inputs();
    const doc = renderReview(input);
    assert.equal((doc.match(/^### q-\d{3} /gm) ?? []).length, 50);
    assert.equal((doc.match(/^### p-\d{3} /gm) ?? []).length, 5);
    for (const question of [...input.questions.questions, ...(input.pilotQuestions?.questions ?? [])]) {
      assert.ok(doc.includes(`### ${question.id} (${question.category})`), `${question.id} has a block`);
      assert.ok(doc.includes(`> ${question.text}`), `${question.id} shows its text`);
    }
    const q1 = input.questions.questions[0];
    assert.ok(q1);
    const key = input.answers.answers.find((answer) => answer.questionId === q1.id);
    assert.ok(key);
    const block = doc.slice(doc.indexOf(`### ${q1.id} `), doc.indexOf('### q-002 '));
    assert.ok(block.includes(`- Granularity: ${key.granularity}; equality: ${key.equality}`));
    assert.ok(block.includes(`- Expected answers: ${projectedSize(key.items, key.granularity)} at granularity ${key.granularity} (${key.items.length} key items)`));
    const first = key.items[0];
    assert.ok(first?.file !== undefined);
    assert.ok(block.includes(`\`${first.file}${first.line === undefined ? '' : `:${first.line}`}${first.symbol === undefined ? '' : ` ${first.symbol}`}\``));
  });

  test('an abstain block says the expected answer is not found, with no items', () => {
    const doc = renderReview(inputs());
    const block = doc.slice(doc.indexOf('### q-045 '), doc.indexOf('### q-046 '));
    assert.ok(block.includes('- Expected answer: not found (abstain)'));
    assert.ok(!block.includes('First expected'));
  });

  test('rejected candidates are listed by reason with counts that match the candidates file', () => {
    const input = inputs();
    const doc = renderReview(input);
    const section = doc.slice(doc.indexOf('## Rejected candidates'));
    assert.ok(section.length > 0);
    const rejected = Object.values(input.candidates.categories).flat().filter((record) => record.status === 'rejected');
    assert.ok(rejected.length > 0, 'the committed draft passed over at least one candidate');
    for (const reason of CANDIDATE_REASONS) {
      const count = rejected.filter((record) => record.reason === reason).length;
      assert.ok(section.includes(`| ${reason} | ${count} |`), `the table row for ${reason}`);
    }
    assert.ok(section.includes(`| total | ${rejected.length} |`));
    for (const record of rejected) assert.ok(section.includes(record.identity), `${record.identity} is listed`);
  });

  test('rendering twice gives the same bytes and carries no timestamp or absolute path', () => {
    const first = renderReview(inputs());
    const second = renderReview(inputs());
    assert.equal(first, second);
    assert.ok(!/\/Users\/|\/private\/|\/tmp\/|C:\\/.test(first), 'no machine-specific path');
    assert.ok(!/\b20\d\d-\d\d-\d\dT\d\d:/.test(first), 'no timestamp');
  });

  test('stale review document: the committed file is exactly what the committed question files render to', () => {
    assert.ok(fs.existsSync(DOC), 'docs/eval/questions-review.md is committed');
    assert.equal(fs.readFileSync(DOC, 'utf8'), renderReview(inputs()), 'regenerate it with the review command');
  });

  test('the review command writes identical bytes on two runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
    try {
      const outputs = [path.join(dir, 'a.md'), path.join(dir, 'b.md')];
      for (const out of outputs) {
        const result = spawnSync(
          process.execPath,
          [
            SCRIPT,
            'review',
            '--questions', path.join(DIR, 'gsd-core.questions.json'),
            '--answers', path.join(DIR, 'gsd-core.answers.json'),
            '--pilot-questions', path.join(DIR, 'pilot.questions.json'),
            '--pilot-answers', path.join(DIR, 'pilot.answers.json'),
            '--candidates', path.join(DIR, 'candidates.json'),
            '--out', out,
          ],
          { encoding: 'utf8', windowsHide: true },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      const hashes = outputs.map((out) => createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
      assert.equal(hashes[0], hashes[1]);
      assert.equal(fs.readFileSync(outputs[0], 'utf8'), fs.readFileSync(DOC, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('the review command refuses a missing argument', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'review', '--questions', 'x.json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/);
  });
});
