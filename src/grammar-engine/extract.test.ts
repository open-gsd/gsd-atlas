import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateFileFacts } from '../facts/index.ts';
import { extractFileFacts } from './extract.ts';
import type { Capture, GrammarRunResult, QueryKind } from './types.ts';

/** Scripted captures exercise the capture-name vocabulary independent of any grammar. */
function cap(
  query: QueryKind,
  match: number,
  name: string,
  span: readonly [number, number, number, number],
  text = '',
): Capture {
  const [startLine, startColumn, endLine, endColumn] = span;
  return { query, match, name, span: { startLine, startColumn, endLine, endColumn }, text };
}

function runOf(captures: readonly Capture[], over: Partial<GrammarRunResult> = {}): GrammarRunResult {
  return { hadBom: false, captures, errorBytes: 0, totalBytes: 0, missingNodes: 0, ...over };
}

function extract(run: GrammarRunResult) {
  return extractFileFacts({
    path: 'src/a.toy',
    contentHash: 'c'.repeat(40),
    module: 'toy',
    grammarVersion: 'toy-0.1.0',
    run,
  });
}

describe('extractFileFacts: definitions', () => {
  it('turns each tags match into a symbol whose kind is the definition suffix and whose span is the definition span', () => {
    const { facts, diagnostics } = extract(
      runOf(
        [
          cap('tags', 0, 'definition.function', [2, 0, 4, 1]),
          cap('tags', 0, 'name', [2, 3, 2, 7], 'main'),
          cap('tags', 1, 'definition.type', [5, 0, 6, 1]),
          cap('tags', 1, 'name', [5, 5, 5, 11], 'Widget'),
        ],
        { errorBytes: 3, totalBytes: 99 },
      ),
    );
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(facts.symbols, [
      {
        name: 'main',
        kind: 'function',
        qualifiedName: 'main',
        span: { startLine: 2, startColumn: 0, endLine: 4, endColumn: 1 },
      },
      {
        name: 'Widget',
        kind: 'type',
        qualifiedName: 'Widget',
        span: { startLine: 5, startColumn: 0, endLine: 6, endColumn: 1 },
      },
    ]);
    assert.deepEqual(facts.parse, { errorBytes: 3, totalBytes: 99 });
    assert.equal(facts.path, 'src/a.toy');
    assert.equal(facts.contentHash, 'c'.repeat(40));
    assert.equal(facts.module, 'toy');
    assert.equal(facts.grammarVersion, 'toy-0.1.0');
  });

  it('passes validateFileFacts and leaves refSites, imports and exports empty in the definitions-only pass', () => {
    const { facts } = extract(
      runOf([cap('tags', 0, 'definition.function', [0, 0, 1, 1]), cap('tags', 0, 'name', [0, 3, 0, 4], 'a')]),
    );
    assert.deepEqual(validateFileFacts(facts), []);
    assert.deepEqual(facts.refSites, []);
    assert.deepEqual(facts.imports, []);
  });

  it('gives a nested definition its container as parent and a dotted qualifiedName (outer.inner)', () => {
    // Captures arrive in an arbitrary order: the extractor derives containment from spans alone.
    const { facts } = extract(
      runOf([
        cap('tags', 1, 'definition.function', [1, 2, 3, 3]),
        cap('tags', 1, 'name', [1, 5, 1, 10], 'inner'),
        cap('tags', 0, 'definition.function', [0, 0, 4, 1]),
        cap('tags', 0, 'name', [0, 3, 0, 8], 'outer'),
      ]),
    );
    assert.deepEqual(
      facts.symbols.map((s) => [s.name, s.qualifiedName, s.parent]),
      [
        ['outer', 'outer', undefined],
        ['inner', 'outer.inner', 0],
      ],
    );
    assert.deepEqual(validateFileFacts(facts), []);
  });

  it('chains three levels and returns to the grandparent for a later sibling', () => {
    const { facts } = extract(
      runOf([
        cap('tags', 0, 'definition.type', [0, 0, 9, 1]),
        cap('tags', 0, 'name', [0, 5, 0, 6], 'A'),
        cap('tags', 1, 'definition.function', [1, 2, 4, 3]),
        cap('tags', 1, 'name', [1, 5, 1, 6], 'b'),
        cap('tags', 2, 'definition.function', [2, 4, 3, 5]),
        cap('tags', 2, 'name', [2, 7, 2, 8], 'c'),
        cap('tags', 3, 'definition.function', [5, 2, 8, 3]),
        cap('tags', 3, 'name', [5, 5, 5, 6], 'd'),
      ]),
    );
    assert.deepEqual(
      facts.symbols.map((s) => [s.qualifiedName, s.parent]),
      [
        ['A', undefined],
        ['A.b', 0],
        ['A.b.c', 1],
        ['A.d', 0],
      ],
    );
  });

  it('skips a match that has no name capture and reports one info diagnostic with the count', () => {
    const { facts, diagnostics } = extract(
      runOf([
        cap('tags', 0, 'definition.function', [0, 0, 1, 1]),
        cap('tags', 1, 'definition.function', [2, 0, 3, 1]),
        cap('tags', 2, 'definition.type', [4, 0, 5, 1]),
        cap('tags', 2, 'name', [4, 5, 4, 6], 'T'),
      ]),
    );
    assert.deepEqual(
      facts.symbols.map((s) => s.name),
      ['T'],
    );
    assert.equal(diagnostics.length, 1);
    const [only] = diagnostics;
    assert.ok(only);
    assert.equal(only.code, 'match_missing_name');
    assert.equal(only.severity, 'info');
    assert.match(only.message, /\b2\b/);
    assert.equal(only.subject, 'src/a.toy');
  });
});
