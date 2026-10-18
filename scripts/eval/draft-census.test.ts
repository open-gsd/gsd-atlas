import assert from 'node:assert/strict';
import path from 'node:path';
import { before, describe, test } from 'node:test';

import {
  buildCensus,
  mulberry32,
  orderCandidates,
  sample,
  type Candidate,
  type Census,
  type ExportEntry,
} from './draft-census.ts';
import { computeAnswerKey, type OracleContext } from './oracle.ts';
import { CategorySchema, KeySpecSchema, type Category } from './questions.ts';

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
