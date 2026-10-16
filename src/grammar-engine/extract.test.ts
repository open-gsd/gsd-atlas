import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateFileFacts } from '../facts/index.ts';
import { loadToyScenarios } from './contract.ts';
import { extractFileFacts } from './extract.ts';
import { createFakeGrammarEngine } from './fake.ts';
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

function sp(startLine: number, startColumn: number, endLine: number, endColumn: number) {
  return { startLine, startColumn, endLine, endColumn };
}

describe('extractFileFacts: imports', () => {
  const statement = [1, 0, 1, 40] as const;

  it('merges the matches that share a statement span into one site with ordered bindings and an unquoted path', () => {
    const { facts, diagnostics } = extract(
      runOf([
        cap('imports', 0, 'import.es', statement),
        cap('imports', 0, 'import.path', [1, 30, 1, 39], '"./lib/util"'),
        cap('imports', 0, 'import.default', [1, 7, 1, 10], 'foo'),
        cap('imports', 1, 'import.es', statement),
        cap('imports', 1, 'import.named', [1, 13, 1, 14], 'a'),
        cap('imports', 1, 'import.local', [1, 18, 1, 19], 'b'),
        cap('imports', 2, 'import.es', statement),
        cap('imports', 2, 'import.named', [1, 21, 1, 22], 'c'),
        cap('imports', 3, 'import.es', statement),
        cap('imports', 3, 'import.namespace', [1, 24, 1, 26], 'ns'),
        // The same binding twice (two patterns matched it) collapses to one.
        cap('imports', 4, 'import.es', statement),
        cap('imports', 4, 'import.named', [1, 21, 1, 22], 'c'),
      ]),
    );
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(facts.imports, [
      {
        path: './lib/util',
        span: sp(...statement),
        style: 'es',
        bindings: [
          { imported: 'default', local: 'foo' },
          { imported: 'a', local: 'b' },
          { imported: 'c', local: 'c' },
          { imported: '*', local: 'ns' },
        ],
      },
    ]);
    assert.deepEqual(validateFileFacts(facts), []);
  });

  it('removes exactly one pair of matching surrounding quotes and nothing else (quotes)', () => {
    const paths = ['"a"', "'b'", '`c`', '"d\'', '"e', '"\'f\'"', 'g'];
    const captures = paths.flatMap((text, i) => [
      cap('imports', i, 'import.es', [i, 0, i, 20]),
      cap('imports', i, 'import.path', [i, 4, i, 4 + text.length], text),
    ]);
    const { facts } = extract(runOf(captures));
    assert.deepEqual(
      facts.imports.map((site) => site.path),
      ['a', 'b', 'c', '"d\'', '"e', "'f'", 'g'],
    );
  });

  it('keeps the style and leaves bindings out for a statement without binding captures', () => {
    const { facts } = extract(
      runOf([
        cap('imports', 0, 'import.side-effect', [0, 0, 0, 12]),
        cap('imports', 0, 'import.path', [0, 7, 0, 11], '"x"'),
        cap('imports', 1, 'import.cjs', [1, 0, 1, 30]),
        cap('imports', 1, 'import.path', [1, 20, 1, 29], "'./other'"),
        cap('imports', 2, 'import.reexport', [2, 0, 2, 30]),
        cap('imports', 2, 'import.path', [2, 20, 2, 29], '"./more"'),
      ]),
    );
    assert.deepEqual(
      facts.imports.map((site) => [site.path, site.style, site.bindings?.length ?? 0]),
      [
        ['x', 'side-effect', 0],
        ['./other', 'cjs', 0],
        ['./more', 'reexport', 0],
      ],
    );
  });

  it('skips a statement without a path and reports one info diagnostic with the count', () => {
    const { facts, diagnostics } = extract(
      runOf([
        cap('imports', 0, 'import.es', [0, 0, 0, 10]),
        cap('imports', 0, 'import.default', [0, 7, 0, 8], 'x'),
        cap('imports', 1, 'import.es', [1, 0, 1, 12]),
        cap('imports', 1, 'import.path', [1, 7, 1, 11], '""'),
        cap('imports', 2, 'import.es', [2, 0, 2, 12]),
        cap('imports', 2, 'import.path', [2, 7, 2, 11], '"ok"'),
      ]),
    );
    assert.deepEqual(
      facts.imports.map((site) => site.path),
      ['ok'],
    );
    assert.equal(diagnostics.length, 1);
    const [only] = diagnostics;
    assert.ok(only);
    assert.equal(only.code, 'match_missing_path');
    assert.equal(only.severity, 'info');
    assert.match(only.message, /\b2\b/);
  });
});

describe('extractFileFacts: exports and exported symbols', () => {
  it('builds an export site from export.name, export.local and export.from', () => {
    const { facts } = extract(
      runOf([
        cap('imports', 0, 'export', [3, 0, 3, 40]),
        cap('imports', 0, 'export.name', [3, 9, 3, 12], 'pub'),
        cap('imports', 0, 'export.local', [3, 16, 3, 20], 'impl'),
        cap('imports', 0, 'export.from', [3, 30, 3, 36], "'./x'"),
      ]),
    );
    assert.deepEqual(facts.exports, [{ name: 'pub', local: 'impl', span: sp(3, 0, 3, 40), from: './x' }]);
    assert.deepEqual(validateFileFacts(facts), []);
  });

  it('marks the symbol of a definition match with an export capture as exported and yields an export site for it', () => {
    const { facts } = extract(
      runOf([
        cap('tags', 0, 'definition.function', [0, 0, 2, 1]),
        cap('tags', 0, 'name', [0, 16, 0, 19], 'api'),
        cap('tags', 0, 'export', [0, 0, 2, 1]),
        cap('tags', 1, 'definition.function', [3, 0, 4, 1]),
        cap('tags', 1, 'name', [3, 9, 3, 12], 'own'),
      ]),
    );
    assert.deepEqual(
      facts.symbols.map((s) => [s.name, s.exported]),
      [
        ['api', true],
        ['own', undefined],
      ],
    );
    assert.deepEqual(facts.exports, [{ name: 'api', local: 'api', span: sp(0, 0, 2, 1) }]);
  });

  it('marks a top-level symbol whose name an export site names as local, but not a nested one or a re-export', () => {
    const { facts } = extract(
      runOf([
        cap('tags', 0, 'definition.function', [0, 0, 9, 1]),
        cap('tags', 0, 'name', [0, 3, 0, 6], 'run'),
        cap('tags', 1, 'definition.function', [1, 2, 3, 3]),
        cap('tags', 1, 'name', [1, 5, 1, 10], 'inner'),
        cap('tags', 2, 'definition.function', [10, 0, 11, 1]),
        cap('tags', 2, 'name', [10, 3, 10, 8], 'other'),
        cap('imports', 0, 'export', [12, 0, 12, 20]),
        cap('imports', 0, 'export.name', [12, 7, 12, 10], 'run'),
        cap('imports', 1, 'export', [13, 0, 13, 20]),
        cap('imports', 1, 'export.name', [13, 7, 13, 12], 'inner'),
        cap('imports', 2, 'export', [14, 0, 14, 30]),
        cap('imports', 2, 'export.name', [14, 7, 14, 12], 'other'),
        cap('imports', 2, 'export.from', [14, 20, 14, 28], '"./y"'),
      ]),
    );
    assert.deepEqual(
      facts.symbols.map((s) => [s.name, s.exported]),
      [
        ['run', true],
        ['inner', undefined],
        ['other', undefined],
      ],
    );
    assert.equal(facts.exports?.length, 3);
  });

  it('collapses duplicate (name, span) export sites to one', () => {
    const { facts } = extract(
      runOf([
        cap('imports', 0, 'export', [0, 0, 0, 20]),
        cap('imports', 0, 'export.name', [0, 7, 0, 10], 'dup'),
        cap('imports', 1, 'export', [0, 0, 0, 20]),
        cap('imports', 1, 'export.name', [0, 7, 0, 10], 'dup'),
        cap('imports', 2, 'export', [1, 0, 1, 20]),
        cap('imports', 2, 'export.name', [1, 7, 1, 10], 'dup'),
      ]),
    );
    assert.deepEqual(
      facts.exports?.map((e) => [e.name, e.span.startLine]),
      [
        ['dup', 0],
        ['dup', 1],
      ],
    );
  });
});

describe('extractFileFacts: reference sites', () => {
  /** main (top level) contains inner; `helper` is imported from lib/util; `pub` is an export name. */
  const base: Capture[] = [
    cap('tags', 0, 'definition.function', [0, 0, 6, 1]),
    cap('tags', 0, 'name', [0, 3, 0, 7], 'main'),
    cap('tags', 1, 'definition.function', [1, 2, 3, 3]),
    cap('tags', 1, 'name', [1, 5, 1, 10], 'inner'),
    cap('imports', 0, 'import.es', [8, 0, 8, 30]),
    cap('imports', 0, 'import.path', [8, 20, 8, 29], '"lib/util"'),
    cap('imports', 0, 'import.default', [8, 7, 8, 13], 'helper'),
    cap('imports', 1, 'export', [9, 0, 9, 20]),
    cap('imports', 1, 'export.name', [9, 7, 9, 10], 'pub'),
  ];
  const refs: Capture[] = [
    cap('refs', 0, 'reference.call', [2, 4, 2, 8], 'main'),
    cap('refs', 1, 'reference.call', [4, 2, 4, 8], 'helper'),
    cap('refs', 2, 'reference.read', [5, 2, 5, 5], 'pub'),
    cap('refs', 3, 'reference.call', [5, 6, 5, 15], 'unknownFn'),
    cap('refs', 4, 'reference.member', [4, 12, 4, 16], 'push'),
    cap('refs', 5, 'reference.read', [4, 20, 4, 25], 'inner'),
    cap('refs', 6, 'reference.read', [0, 3, 0, 7], 'main'),
    cap('refs', 7, 'reference.read', [7, 0, 7, 4], 'main'),
    cap('refs', 8, 'reference.bogus', [7, 6, 7, 10], 'main'),
  ];

  it('applies the scope filter: keeps top-level, imported and exported names and member calls, drops the rest (scope filter)', () => {
    const { facts } = extract(runOf([...base, ...refs]));
    assert.deepEqual(facts.refSites, [
      { name: 'main', span: sp(2, 4, 2, 8), kind: 'call', enclosing: 1 },
      { name: 'helper', span: sp(4, 2, 4, 8), kind: 'call', importPath: 'lib/util', enclosing: 0 },
      { name: 'push', span: sp(4, 12, 4, 16), kind: 'member', enclosing: 0 },
      { name: 'pub', span: sp(5, 2, 5, 5), kind: 'read', enclosing: 0 },
      { name: 'main', span: sp(7, 0, 7, 4), kind: 'read' },
    ]);
    // 9 candidate sites, 5 kept: unknownFn (unbound), inner (not top level), the declaration's own name, a bogus kind.
    assert.equal(facts.refSites.length, 5);
    assert.deepEqual(validateFileFacts(facts), []);
  });

  it('does not depend on the order the captures arrive in', () => {
    const forward = extract(runOf([...base, ...refs])).facts;
    const reversed = extract(runOf([...[...refs].reverse(), ...[...base].reverse()])).facts;
    assert.deepEqual(reversed, forward);
  });

  it('records no reference site when nothing is local, imported, exported or a member call', () => {
    const { facts } = extract(
      runOf([cap('refs', 0, 'reference.call', [0, 0, 0, 3], 'foo'), cap('refs', 1, 'reference.type', [1, 0, 1, 3], 'Bar')]),
    );
    assert.deepEqual(facts.refSites, []);
  });
});

describe('extractFileFacts: determinism and edges', () => {
  it('emits two definitions with identical spans without merging them (identical spans, via the fake engine)', async () => {
    const scenarios = await loadToyScenarios();
    const source = 'scripted';
    const engine = createFakeGrammarEngine({
      abi: scenarios.abi,
      results: new Map([
        [
          source,
          {
            hadBom: false,
            errorBytes: 0,
            totalBytes: 8,
            missingNodes: 0,
            captures: [
              { query: 'tags', match: 0, name: 'definition.function', span: sp(0, 0, 2, 1), text: '' },
              { query: 'tags', match: 0, name: 'name', span: sp(0, 3, 0, 4), text: 'x' },
              { query: 'tags', match: 1, name: 'definition.function', span: sp(0, 0, 2, 1), text: '' },
              { query: 'tags', match: 1, name: 'name', span: sp(0, 3, 0, 4), text: 'x' },
              { query: 'tags', match: 2, name: 'definition.function', span: sp(3, 0, 3, 10), text: '' },
              { query: 'tags', match: 2, name: 'name', span: sp(3, 3, 3, 4), text: 'a' },
              { query: 'tags', match: 3, name: 'definition.function', span: sp(4, 0, 4, 10), text: '' },
              { query: 'tags', match: 3, name: 'name', span: sp(4, 3, 4, 4), text: 'b' },
            ],
          },
        ],
      ]),
    });
    const grammar = await engine.load(scenarios.input);
    try {
      const { facts } = extract(await grammar.run(source));
      assert.equal(facts.symbols.length, 4);
      assert.deepEqual(
        facts.symbols.map((s) => [s.name, s.parent]),
        [
          ['x', undefined],
          ['x', undefined],
          ['a', undefined],
          ['b', undefined],
        ],
      );
      assert.notDeepEqual(facts.symbols[2]?.span, facts.symbols[3]?.span, 'consecutive lines have disjoint spans');
      assert.deepEqual(validateFileFacts(facts), []);
    } finally {
      await engine.dispose();
    }
  });

  it('gives deep-equal facts when the extractor runs twice on the same run, and does not touch its input (twice)', () => {
    const run = runOf(
      [
        cap('tags', 0, 'definition.function', [0, 0, 5, 1]),
        cap('tags', 0, 'name', [0, 3, 0, 4], 'a'),
        cap('tags', 1, 'definition.function', [1, 2, 2, 3]),
        cap('tags', 1, 'name', [1, 5, 1, 6], 'b'),
        cap('refs', 0, 'reference.call', [3, 2, 3, 3], 'a'),
      ],
      { totalBytes: 40 },
    );
    const before = JSON.stringify(run);
    const first = extract(run);
    const second = extract(run);
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(run), before);
  });

  it('orders equal start positions outer first, then by kind, then by name', () => {
    const { facts } = extract(
      runOf([
        cap('tags', 0, 'definition.type', [0, 0, 1, 1]),
        cap('tags', 0, 'name', [0, 5, 0, 6], 'z'),
        cap('tags', 1, 'definition.function', [0, 0, 3, 1]),
        cap('tags', 1, 'name', [0, 3, 0, 4], 'outer'),
        cap('tags', 2, 'definition.function', [0, 0, 1, 1]),
        cap('tags', 2, 'name', [0, 3, 0, 4], 'b'),
        cap('tags', 3, 'definition.function', [0, 0, 1, 1]),
        cap('tags', 3, 'name', [0, 3, 0, 4], 'a'),
      ]),
    );
    assert.deepEqual(
      facts.symbols.map((s) => [s.qualifiedName, s.kind]),
      [
        ['outer', 'function'],
        ['outer.a', 'function'],
        ['outer.b', 'function'],
        ['outer.z', 'type'],
      ],
    );
  });

  it('yields empty arrays and parse bytes 0 and 0 for an empty source (empty source)', () => {
    const { facts, diagnostics } = extract(runOf([]));
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(facts.symbols, []);
    assert.deepEqual(facts.refSites, []);
    assert.deepEqual(facts.imports, []);
    assert.deepEqual(facts.exports ?? [], []);
    assert.deepEqual(facts.parse, { errorBytes: 0, totalBytes: 0 });
    assert.deepEqual(validateFileFacts(facts), []);
  });
});
