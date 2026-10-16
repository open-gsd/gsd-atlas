import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEGRADED_CODES,
  FACT_PREDICATES,
  PROTOCOL_VERSION,
  diagnostic,
  failEnvelope,
  isDegradedCode,
  isValidSpan,
  okEnvelope,
  symbolKey,
  systemClock,
  validateFileFacts,
} from './index.ts';
import type {
  Answer,
  FileFacts,
  OverlaySnapshot,
  Request,
  ResolutionContext,
  ResolvedEdge,
  Span,
  SymbolIdentity,
  SymbolLookup,
} from './index.ts';

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

describe('DEGRADED_CODES', () => {
  it('is exactly the eight codes of the contract', () => {
    assert.deepEqual(
      [...DEGRADED_CODES],
      [
        'resolver_failed',
        'resolver_timeout',
        'fresh_timeout',
        'precise_base_commit',
        'precise_unavailable',
        'stale',
        'follower',
        'cache_unavailable',
      ],
    );
  });

  it('isDegradedCode narrows strings', () => {
    assert.equal(isDegradedCode('stale'), true);
    assert.equal(isDegradedCode('resolver_failed'), true);
    assert.equal(isDegradedCode('nope'), false);
    assert.equal(isDegradedCode(''), false);
  });
});

describe('Envelope helpers', () => {
  it('okEnvelope defaults diagnostics to an empty array', () => {
    assert.deepEqual(okEnvelope('x.v1', { a: 1 }), {
      schema: 'x.v1',
      ok: true,
      data: { a: 1 },
      diagnostics: [],
    });
  });

  it('okEnvelope keeps given diagnostics', () => {
    const d = diagnostic('c', 'info', 'm');
    assert.deepEqual(okEnvelope('x.v1', 1, [d]).diagnostics, [d]);
  });

  it('failEnvelope returns ok false with null data', () => {
    const d = diagnostic('boom', 'error', 'failed');
    assert.deepEqual(failEnvelope('x.v1', [d]), {
      schema: 'x.v1',
      ok: false,
      data: null,
      diagnostics: [d],
    });
  });
});

describe('Request, PROTOCOL_VERSION and Answer', () => {
  it('PROTOCOL_VERSION is 1 and builds a Request', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    const request: Request = {
      protocol: PROTOCOL_VERSION,
      kind: 'lang_test',
      args: { id: 'toy' },
      worktree: '/repo',
      tenantHint: 'repo-a',
      budget_tokens: 2000,
      fresh: ['src/a.ts'],
    };
    assert.equal(request.protocol, 1);
    const minimal: Request = { protocol: PROTOCOL_VERSION, kind: 'anything' };
    assert.equal(minimal.kind, 'anything');
  });

  it('Answer carries data, a watermark and optional degraded codes', () => {
    const answer: Answer<string[]> = {
      data: [],
      watermark: { seq: 3, stalePaths: ['src/a.ts'] },
      degraded: ['resolver_timeout'],
    };
    assert.equal(answer.watermark.seq, 3);
    const clean: Answer<number> = { data: 1, watermark: { seq: 0, stalePaths: [] } };
    assert.equal(clean.degraded, undefined);
  });
});

describe('resolution contracts', () => {
  const identity: SymbolIdentity = {
    repo: 'r',
    path: 'src/a.ts',
    qualifiedName: 'A.m',
    kind: 'method',
  };

  it('symbolKey is equal for equal identities', () => {
    assert.equal(symbolKey({ ...identity }), symbolKey(identity));
    assert.equal(
      symbolKey({ ...identity, discriminator: '1' }),
      symbolKey({ ...identity, discriminator: '1' }),
    );
  });

  it('symbolKey differs when only kind, discriminator or qualifiedName differ', () => {
    const base = symbolKey(identity);
    assert.notEqual(symbolKey({ ...identity, kind: 'function' }), base);
    assert.notEqual(symbolKey({ ...identity, discriminator: '2' }), base);
    assert.notEqual(symbolKey({ ...identity, qualifiedName: 'A.n' }), base);
    assert.notEqual(symbolKey({ ...identity, path: 'src/b.ts' }), base);
    assert.notEqual(symbolKey({ ...identity, repo: 'q' }), base);
  });

  it('symbolKey cannot be forged by moving text between fields', () => {
    const a = symbolKey({ repo: 'r', path: 'a', qualifiedName: 'b', kind: 'k' });
    const b = symbolKey({ repo: 'r', path: 'a\u0000b', qualifiedName: '', kind: 'k' });
    assert.notEqual(a, b);
  });

  it('symbolKey ignores the content hash (identity excludes the version)', () => {
    const withHash = { ...identity, contentHash: 'abc' } as SymbolIdentity;
    assert.equal(symbolKey(withHash), symbolKey(identity));
  });

  it('shapes ResolvedEdge, OverlaySnapshot, ResolutionContext and SymbolLookup', async () => {
    const edge: ResolvedEdge = {
      site: {
        path: 'src/b.ts',
        span: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 1 },
        name: 'A',
      },
      target: identity,
      confidence: 'EXTRACTED',
      resolver: 'typescript-6',
    };
    assert.equal(edge.confidence, 'EXTRACTED');

    const overlay: OverlaySnapshot = {
      id: 'ov1',
      pathToHash: new Map([['src/a.ts', 'h1']]),
    };
    assert.equal(overlay.pathToHash.get('src/a.ts'), 'h1');

    const context: ResolutionContext = { id: 'ctx1', configHashes: ['h-tsconfig', 'h-lock'] };
    assert.equal(context.configHashes.length, 2);

    const lookup: SymbolLookup = {
      find: async (name) => (name === 'A' ? [identity] : []),
    };
    assert.deepEqual(await lookup.find('A'), [identity]);
    assert.deepEqual(await lookup.find('Z'), []);
  });
});
