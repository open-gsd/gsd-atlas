import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { CANDIDATE_REASONS, CandidatesFileSchema, identityOfKey, projectedSize, type CandidatesFile } from './draft-census.ts';
import {
  AnswerFileSchema,
  CategorySchema,
  loadQuestions,
  type AnswerFile,
  type AnswerKey,
  type Category,
  type KeySpec,
  type Question,
  type QuestionFile,
} from './questions.ts';

/**
 * Validity tests over the committed question set of the pre-registered eval (EVL-02, D-01, plan
 * 03-09). They read the committed files, so a later edit that weakens the set (a hint in a text,
 * a changed mix, an ambiguous key, a candidate dropped without a recorded rule) fails here.
 */

const DIR = path.join(import.meta.dirname, 'questions');
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FILES = [
  'gsd-core.questions.json',
  'gsd-core.answers.json',
  'pilot.questions.json',
  'pilot.answers.json',
  'candidates.json',
];

/** The mix registered in plan 03-09 (EVL-02 minimum 50; abstain is 12 percent). */
const SCORED_MIX: Readonly<Record<Category, number>> = {
  callers: 11,
  references: 5,
  heritage: 5,
  emit: 7,
  adr: 7,
  impact: 4,
  definition: 5,
  abstain: 6,
};
const PILOT_QUESTIONS = 5;
const MAX_EXPECTED = 30;
const CLOSING_SENTENCE = 'Give your answer in the required JSON form.';
/** `eval.bootstrapSeed` in 03-CONSTANTS.md, the seed of the candidate order. */
const SEED = 20261017;
const FORBIDDEN = /\b(?:atlas|grep|ripgrep|index\w*|tool\w*|search\w*|mcp|lsp|codegraph)\b/i;

interface Committed {
  scored: QuestionFile;
  pilot: QuestionFile;
  scoredAnswers: AnswerFile;
  pilotAnswers: AnswerFile;
  candidates: CandidatesFile;
  all: Question[];
}

let memo: Committed | undefined;

/** Loads the committed files once; a missing file is a failed assertion, not a crash at import. */
function committed(): Committed {
  if (memo !== undefined) return memo;
  for (const file of FILES) assert.ok(fs.existsSync(path.join(DIR, file)), `scripts/eval/questions/${file} is committed`);
  const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as unknown;
  const scored = loadQuestions(path.join(DIR, 'gsd-core.questions.json'));
  const pilot = loadQuestions(path.join(DIR, 'pilot.questions.json'));
  memo = {
    scored,
    pilot,
    scoredAnswers: AnswerFileSchema.parse(readJson('gsd-core.answers.json')),
    pilotAnswers: AnswerFileSchema.parse(readJson('pilot.answers.json')),
    candidates: CandidatesFileSchema.parse(readJson('candidates.json')),
    all: [...scored.questions, ...pilot.questions],
  };
  return memo;
}

function answerFor(data: Committed, question: Question): AnswerKey {
  const file = question.id.startsWith('p-') ? data.pilotAnswers : data.scoredAnswers;
  const found = file.answers.find((answer) => answer.questionId === question.id);
  assert.ok(found, `answers file has a key for ${question.id}`);
  return found;
}

/** Texts a question must contain: the symbol, the file that defines it, the emit source or the ADR number. */
function targetsOf(key: KeySpec): string[] {
  switch (key.kind) {
    case 'emit':
    case 'emit-consumers':
      return [key.source];
    case 'adr-citers':
      return [String(key.number)];
    case 'abstain':
      return [];
    case 'heritage':
    case 'definition':
      return key.definedIn === undefined ? [key.symbol] : [key.symbol, key.definedIn];
    default:
      return [key.symbol, key.definedIn];
  }
}

function manifestSha(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'corpora', 'corpora.json'), 'utf8')) as {
    corpora: { id: string; sha: string }[];
  };
  const entry = manifest.corpora.find((corpus) => corpus.id === 'gsd-core');
  assert.ok(entry, 'gsd-core is in the corpus manifest');
  return entry.sha;
}

describe('question files', () => {
  test('ids are q-001 to q-050 and p-001 to p-005, and every question has a key of its own kind', () => {
    const data = committed();
    assert.deepEqual(
      data.scored.questions.map((question) => question.id),
      Array.from({ length: 50 }, (_unused, index) => `q-${String(index + 1).padStart(3, '0')}`),
    );
    assert.deepEqual(
      data.pilot.questions.map((question) => question.id),
      Array.from({ length: PILOT_QUESTIONS }, (_unused, index) => `p-${String(index + 1).padStart(3, '0')}`),
    );
    for (const question of data.all) {
      const key = answerFor(data, question);
      assert.equal(key.kind, question.key.kind, `${question.id} key kind`);
      assert.equal(key.granularity, question.key.granularity, `${question.id} granularity`);
      assert.equal(key.equality, question.key.equality, `${question.id} equality`);
    }
    assert.equal(data.scoredAnswers.answers.length, 50);
    assert.equal(data.pilotAnswers.answers.length, PILOT_QUESTIONS);
  });

  test('the corpus is the pinned gsd-core commit and the answers record how it was prepared', () => {
    const data = committed();
    const sha = manifestSha();
    for (const file of [data.scored, data.pilot]) {
      assert.equal(file.corpusId, 'gsd-core');
      assert.equal(file.corpusSha, sha);
    }
    for (const file of [data.scoredAnswers, data.pilotAnswers]) {
      assert.equal(file.repoSha, sha);
      assert.ok(file.preparedRecord, 'the answers file carries the preparedRecord');
      assert.equal(file.preparedRecord.corpusId, 'gsd-core');
      assert.equal(file.preparedRecord.sha, sha);
      // OQ8: npm ci --ignore-scripts ran, so the project's own TypeScript produced the keys.
      assert.equal(file.preparedRecord.npmCi, true);
      assert.match(file.preparedRecord.typescriptVersion ?? '', /^6\./);
      assert.match(file.preparedRecord.lockSha256 ?? '', /^[0-9a-f]{64}$/);
    }
    assert.deepEqual(data.scoredAnswers.preparedRecord, data.pilotAnswers.preparedRecord);
  });

  test('category mix is callers 11, references 5, heritage 5, emit 7, adr 7, impact 4, definition 5, abstain 6', () => {
    const { scored } = committed();
    const counts = Object.fromEntries(CategorySchema.options.map((category) => [category, 0])) as Record<Category, number>;
    for (const question of scored.questions) counts[question.category] += 1;
    assert.deepEqual(counts, SCORED_MIX);
    assert.equal(scored.questions.length, 50);
  });

  test('pilot questions come from five different categories', () => {
    const { pilot } = committed();
    assert.equal(pilot.questions.length, PILOT_QUESTIONS);
    assert.equal(new Set(pilot.questions.map((question) => question.category)).size, PILOT_QUESTIONS);
  });

  test('forbidden words: no question text names a tool, a method or a search technique outside a quoted span', () => {
    for (const question of committed().all) {
      const bare = question.text.replace(/`[^`]*`/g, ' ');
      const hit = FORBIDDEN.exec(bare);
      assert.equal(hit, null, `${question.id} contains "${hit?.[0] ?? ''}": ${question.text}`);
    }
  });

  test('text hygiene: one line, under 400 characters, ending with the one shared answer-format sentence', () => {
    for (const question of committed().all) {
      assert.ok(!/[\r\n]/.test(question.text), `${question.id} has a line break`);
      assert.ok(question.text.length < 400, `${question.id} is ${question.text.length} characters`);
      assert.ok(question.text.endsWith(CLOSING_SENTENCE), `${question.id} must end with the answer-format sentence`);
      assert.equal(question.text.split(CLOSING_SENTENCE).length, 2, `${question.id} says it once`);
    }
  });

  test('names the target: every non-abstain question text contains its symbol, defining file, emit source or ADR number', () => {
    for (const question of committed().all) {
      if (question.category === 'abstain') continue;
      for (const needle of targetsOf(question.key)) {
        assert.ok(question.text.includes(needle), `${question.id} must name ${needle}: ${question.text}`);
      }
    }
  });

  test('no unexplained: no key has a mention the compiler result neither includes nor classifies', () => {
    const data = committed();
    for (const question of data.all) {
      assert.deepEqual(answerFor(data, question).unexplained, [], `${question.id} has unexplained mentions`);
    }
  });

  test('every non-abstain key has between 1 and 30 expected answers at its granularity', () => {
    const data = committed();
    for (const question of data.all) {
      if (question.category === 'abstain') continue;
      const key = answerFor(data, question);
      const size = projectedSize(key.items, key.granularity);
      assert.ok(size >= 1 && size <= MAX_EXPECTED, `${question.id} expects ${size} answers`);
      assert.equal(key.abstain, false, `${question.id} is not an abstain question`);
    }
  });

  test('abstain keys: every abstain question abstains and expects no items; six are scored', () => {
    const data = committed();
    const abstainQuestions = data.all.filter((question) => question.category === 'abstain');
    assert.equal(abstainQuestions.filter((question) => question.id.startsWith('q-')).length, 6);
    for (const question of abstainQuestions) {
      const key = answerFor(data, question);
      assert.equal(question.key.kind, 'abstain');
      assert.equal(key.abstain, true, `${question.id} abstains`);
      assert.deepEqual(key.items, [], `${question.id} has no items`);
    }
  });

  test('pilot disjoint: no scored question is about anything a pilot question is about', () => {
    const { scored, pilot } = committed();
    const pilotIdentities = new Set(pilot.questions.map((question) => identityOfKey(question.key)));
    for (const question of scored.questions) {
      assert.ok(!pilotIdentities.has(identityOfKey(question.key)), `${question.id} reuses a pilot subject`);
    }
    const pilotNames = new Set(
      pilot.questions.flatMap((question) => targetsOf(question.key).filter((target) => /^[A-Za-z_$][\w$]*$/.test(target))),
    );
    for (const question of scored.questions) {
      for (const target of targetsOf(question.key)) {
        assert.ok(!pilotNames.has(target), `${question.id} reuses the pilot name ${target}`);
      }
    }
  });

  test('one subject per question: no two questions share a symbol, emit source or ADR number', () => {
    const seen = new Map<string, string>();
    for (const question of committed().all) {
      const identity = identityOfKey(question.key);
      assert.ok(!seen.has(identity), `${question.id} repeats ${identity} of ${seen.get(identity) ?? ''}`);
      seen.set(identity, question.id);
    }
  });

  test('the free-alternatives scan questions do not reappear (by key subject)', () => {
    const scan = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'scan-questions.json'), 'utf8')) as {
      questions: { key: KeySpec }[];
    };
    const scanned = new Set(scan.questions.map((question) => identityOfKey(question.key)));
    assert.ok(scanned.size >= 5);
    for (const question of committed().all) {
      assert.ok(!scanned.has(identityOfKey(question.key)), `${question.id} repeats a scan question`);
    }
  });
});

describe('candidates', () => {
  test('candidates accounted: every decision is on record and the accepted count per category is the mix plus the pilot', () => {
    const { candidates, all, pilot } = committed();
    assert.equal(candidates.corpusId, 'gsd-core');
    assert.equal(candidates.corpusSha, manifestSha());
    assert.equal(candidates.seed, SEED);
    assert.equal(candidates.pilotCategories.length, PILOT_QUESTIONS);
    assert.deepEqual(new Set(candidates.pilotCategories), new Set(pilot.questions.map((question) => question.category)));
    const byId = new Map(all.map((question) => [question.id, question]));
    const seenIds = new Set<string>();
    for (const category of CategorySchema.options) {
      const records = candidates.categories[category];
      assert.ok(records !== undefined && records.length > 0, `${category} has candidates`);
      assert.deepEqual(
        records.map((record) => record.rank),
        records.map((_unused, index) => index + 1),
        `${category} ranks are 1..n`,
      );
      const accepted = records.filter((record) => record.status === 'accepted');
      const wanted = SCORED_MIX[category] + (candidates.pilotCategories.includes(category) ? 1 : 0);
      assert.equal(accepted.length, wanted, `${category}: accepted entries`);
      for (const record of records) {
        if (record.status === 'rejected') {
          assert.ok(
            record.reason !== undefined && CANDIDATE_REASONS.includes(record.reason),
            `${category} #${record.rank} needs a closed-list reason`,
          );
        } else {
          assert.equal(record.reason, undefined, `${category} #${record.rank}: only rejections carry a reason`);
        }
        if (record.status === 'accepted') {
          assert.ok(record.questionId !== undefined, `${category} #${record.rank} is accepted without a question`);
          const question = byId.get(record.questionId);
          assert.ok(question, `${record.questionId} is a committed question`);
          assert.deepEqual(question.key, record.key, `${record.questionId} uses the accepted candidate's key`);
          assert.equal(record.slot === 'pilot', record.questionId.startsWith('p-'));
          assert.ok(!seenIds.has(record.questionId), `${record.questionId} is used by one candidate`);
          seenIds.add(record.questionId);
        } else {
          assert.equal(record.questionId, undefined);
        }
      }
    }
    assert.equal(seenIds.size, all.length, 'every committed question comes from an accepted candidate');
  });

  test('a rejected candidate was passed over for a recorded rule and an unused one was never looked at', () => {
    for (const records of Object.values(committed().candidates.categories)) {
      for (const record of records) {
        if (record.status === 'unused') assert.equal(record.detail, undefined);
        if (record.status === 'rejected') assert.ok((record.detail ?? '').length > 0, `rank ${record.rank} records why`);
      }
    }
  });
});
