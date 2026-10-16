import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FACT_PREDICATES,
  diagnostic,
  isValidSpan,
  systemClock,
  validateFileFacts,
} from './index.ts';
import type { FileFacts, Span } from './index.ts';

const span = (
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): Span => ({ startLine, startColumn, endLine, endColumn });

function goodFacts(): FileFacts {
  return {
    path: 'src/a.ts',
    contentHash: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    module: 'toy',
    grammarVersion: '1',
    symbols: [
      { name: 'A', kind: 'class', qualifiedName: 'A', span: span(0, 0, 4, 1) },
      { name: 'm', kind: 'method', qualifiedName: 'A.m', span: span(1, 2, 3, 3), parent: 0 },
    ],
    refSites: [{ name: 'B', span: span(5, 0, 5, 1) }],
    imports: [{ path: './b', span: span(6, 0, 6, 12) }],
    parse: { errorBytes: 0, totalBytes: 120 },
  };
}

describe('isValidSpan', () => {
  it('accepts ordinary and zero-width spans', () => {
    assert.equal(isValidSpan(span(0, 0, 0, 1)), true);
    assert.equal(isValidSpan(span(3, 4, 3, 4)), true);
    assert.equal(isValidSpan(span(1, 9, 2, 0)), true);
  });

  it('rejects negative and non-integer numbers', () => {
    assert.equal(isValidSpan(span(-1, 0, 0, 0)), false);
    assert.equal(isValidSpan(span(0, -1, 0, 0)), false);
    assert.equal(isValidSpan(span(0, 0, 0.5, 0)), false);
    assert.equal(isValidSpan(span(0, 0, 0, Number.NaN)), false);
    assert.equal(isValidSpan(span(0, 0, 0, Number.POSITIVE_INFINITY)), false);
  });

  it('rejects an end before the start (line first, then column)', () => {
    assert.equal(isValidSpan(span(2, 0, 1, 9)), false);
    assert.equal(isValidSpan(span(2, 5, 2, 4)), false);
  });

  it('rejects non-objects and missing fields', () => {
    assert.equal(isValidSpan(undefined), false);
    assert.equal(isValidSpan(null), false);
    assert.equal(isValidSpan('0:0-0:1'), false);
    assert.equal(isValidSpan({ startLine: 0, startColumn: 0 }), false);
  });
});

describe('FACT_PREDICATES', () => {
  it('is exactly the 16 predicates of the fact-model ADR', () => {
    assert.deepEqual(
      [...FACT_PREDICATES],
      [
        'defines',
        'contains',
        'imports',
        'reexports',
        'calls',
        'references',
        'extends',
        'extension_of',
        'implements',
        'conforms_to',
        'overrides',
        'tested_by',
        'emitted_as',
        'cites_adr',
        'uses_sdk_symbol',
        'targets_platform',
      ],
    );
  });
});

describe('diagnostic and systemClock', () => {
  it('diagnostic builds a value with an optional subject', () => {
    assert.deepEqual(diagnostic('c', 'warning', 'm'), {
      code: 'c',
      severity: 'warning',
      message: 'm',
    });
    assert.deepEqual(diagnostic('c', 'error', 'm', 'src/a.ts'), {
      code: 'c',
      severity: 'error',
      message: 'm',
      subject: 'src/a.ts',
    });
  });

  it('systemClock reports wall time and sleeps', async () => {
    const before = Date.now();
    await systemClock.sleep(1);
    assert.ok(systemClock.now() >= before);
  });
});

describe('validateFileFacts', () => {
  it('returns no diagnostics for a well-formed value', () => {
    assert.deepEqual(validateFileFacts(goodFacts()), []);
  });

  it('flags a symbol, ref site or import without a span as span_missing', () => {
    const noSymbolSpan = goodFacts() as unknown as { symbols: Array<Record<string, unknown>> };
    delete noSymbolSpan.symbols[1]!.span;
    const noRefSpan = goodFacts() as unknown as { refSites: Array<Record<string, unknown>> };
    delete noRefSpan.refSites[0]!.span;
    const noImportSpan = goodFacts() as unknown as { imports: Array<Record<string, unknown>> };
    delete noImportSpan.imports[0]!.span;

    for (const bad of [noSymbolSpan, noRefSpan, noImportSpan]) {
      const out = validateFileFacts(bad);
      assert.equal(out.length, 1);
      assert.equal(out[0]!.code, 'span_missing');
      assert.equal(out[0]!.severity, 'error');
      assert.equal(out[0]!.subject, 'src/a.ts');
    }
  });

  it('flags a span whose end precedes its start as span_invalid', () => {
    const bad = goodFacts();
    bad.refSites[0]!.span = span(5, 4, 5, 1);
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'span_invalid');
    assert.equal(out[0]!.subject, 'src/a.ts');
  });

  it('flags negative parse numbers as parse_invalid', () => {
    const a = goodFacts();
    a.parse.errorBytes = -1;
    const b = goodFacts();
    b.parse.totalBytes = -5;
    for (const bad of [a, b]) {
      const out = validateFileFacts(bad);
      assert.equal(out.length, 1);
      assert.equal(out[0]!.code, 'parse_invalid');
      assert.equal(out[0]!.subject, 'src/a.ts');
    }
  });

  it('flags a non-object input as facts_invalid', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const out = validateFileFacts(bad);
      assert.equal(out.length, 1);
      assert.equal(out[0]!.code, 'facts_invalid');
    }
  });

  it('flags missing arrays as facts_invalid with the path as subject', () => {
    const bad = { ...goodFacts(), symbols: undefined };
    const out = validateFileFacts(bad);
    assert.ok(out.some((d) => d.code === 'facts_invalid' && d.subject === 'src/a.ts'));
  });
});
