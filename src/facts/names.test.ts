/**
 * `validateFileFacts` checks every text field the store binds (WR-05, plan 02-32): a name, kind or top-level
 * string that is not what the writer binds is rejected as `facts_invalid`, with the field named.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateFileFacts } from './index.ts';
import type { FileFacts, Span } from './index.ts';

const span: Span = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 1 };

function goodFacts(): FileFacts {
  return {
    path: 'src/a.ts',
    contentHash: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: [{ name: 'A', kind: 'class', qualifiedName: 'A', span }],
    refSites: [{ name: 'B', span, importPath: './b' }],
    imports: [{ path: './b', span }],
    exports: [{ name: 'A', local: 'A', from: './c', span }],
    parse: { errorBytes: 0, totalBytes: 10 },
  };
}

/** A deep copy of the good facts with one place replaced; the value is deliberately untyped. */
function broken(change: (facts: Record<string, any>) => void): unknown {
  const copy = JSON.parse(JSON.stringify(goodFacts())) as Record<string, any>;
  change(copy);
  return copy;
}

/** The single `facts_invalid` diagnostic a broken value yields; fails when there is not exactly one. */
function only(value: unknown): string {
  const problems = validateFileFacts(value);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(problems[0]?.code, 'facts_invalid');
  return problems[0]?.message ?? '';
}

describe('validateFileFacts: names and kinds', () => {
  it('the good fixture is valid', () => {
    assert.deepEqual(validateFileFacts(goodFacts()), []);
  });

  it('empty name: symbol, reference site and export', () => {
    assert.match(only(broken((f) => (f.symbols[0].name = ''))), /symbol at index 0.*name/);
    assert.match(only(broken((f) => (f.refSites[0].name = ''))), /ref site at index 0.*name/);
    assert.match(only(broken((f) => (f.exports[0].name = ''))), /export at index 0.*name/);
  });

  it('non-string name: symbol, reference site and export', () => {
    assert.match(only(broken((f) => (f.symbols[0].name = 42))), /symbol at index 0.*name/);
    assert.match(only(broken((f) => (f.refSites[0].name = null))), /ref site at index 0.*name/);
    assert.match(only(broken((f) => (f.exports[0].name = 7))), /export at index 0.*name/);
  });

  it('a NUL character in a name', () => {
    assert.match(only(broken((f) => (f.symbols[0].name = 'a\0b'))), /symbol at index 0.*name/);
    assert.match(only(broken((f) => (f.refSites[0].name = '\0'))), /ref site at index 0.*name/);
    assert.match(only(broken((f) => (f.exports[0].name = 'x\0'))), /export at index 0.*name/);
  });

  it('empty and non-string kind', () => {
    assert.match(only(broken((f) => (f.symbols[0].kind = ''))), /symbol at index 0.*kind/);
    assert.match(only(broken((f) => (f.symbols[0].kind = 3))), /symbol at index 0.*kind/);
  });

  it('optional strings must be strings when present', () => {
    assert.match(only(broken((f) => (f.symbols[0].qualifiedName = 7))), /symbol at index 0.*qualifiedName/);
    assert.match(only(broken((f) => (f.refSites[0].importPath = 7))), /ref site at index 0.*importPath/);
    assert.match(only(broken((f) => (f.exports[0].local = 7))), /export at index 0.*local/);
    assert.match(only(broken((f) => (f.exports[0].from = 7))), /export at index 0.*from/);
  });

  it('import path must be a string', () => {
    assert.match(only(broken((f) => (f.imports[0].path = 5))), /import at index 0.*path/);
  });

  it('top-level strings', () => {
    assert.match(only(broken((f) => (f.contentHash = null))), /contentHash/);
    assert.match(only(broken((f) => (f.module = ''))), /module/);
    assert.match(only(broken((f) => (f.grammarVersion = 1))), /grammarVersion/);
  });

  it('valid boundary names stay valid', () => {
    for (const name of ['a', '$', '\\', 'ünïcödé', '日本語', 'x'.repeat(4000)]) {
      const facts = broken((f) => {
        f.symbols[0].name = name;
        f.refSites[0].name = name;
        f.exports[0].name = name;
      });
      assert.deepEqual(validateFileFacts(facts), [], `name ${name.slice(0, 12)}`);
    }
  });

  it('qualifiedName, importPath, local and from may be absent', () => {
    const facts = broken((f) => {
      delete f.symbols[0].qualifiedName;
      delete f.refSites[0].importPath;
      delete f.exports[0].local;
      delete f.exports[0].from;
    });
    assert.deepEqual(validateFileFacts(facts), []);
  });
});
