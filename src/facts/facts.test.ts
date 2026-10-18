import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANSWER_ID_PATTERN,
  DEFAULT_PROJECT_CONTEXT,
  DEGRADED_CODES,
  FACT_PREDICATES,
  IMPORT_STYLES,
  PROTOCOL_VERSION,
  REF_KINDS,
  createAnswerId,
  diagnostic,
  failEnvelope,
  isAnswerId,
  isDegradedCode,
  isValidSpan,
  okEnvelope,
  symbolKey,
  systemClock,
  validateFileFacts,
} from './index.ts';
import type {
  Answer,
  Citation,
  FileFacts,
  OverlaySnapshot,
  ProjectContext,
  ProjectContextProvider,
  Request,
  ResolutionContext,
  ResolvedEdge,
  ResolveScope,
  ResolverPort,
  Span,
  SymbolIdentity,
  SymbolLookup,
  UntrustedText,
  Watermark,
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

  it('systemClock.after calls the callback once after the delay', async () => {
    let calls = 0;
    systemClock.after(1, () => {
      calls += 1;
    });
    await systemClock.sleep(30);
    assert.equal(calls, 1);
  });

  it('systemClock.after cancel prevents the call and leaves no timer pending', async () => {
    let calls = 0;
    const cancel = systemClock.after(5, () => {
      calls += 1;
    });
    cancel();
    cancel();
    await systemClock.sleep(30);
    assert.equal(calls, 0);
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
    const bad: FileFacts = {
      ...goodFacts(),
      refSites: [{ name: 'B', span: span(5, 4, 5, 1) }],
    };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'span_invalid');
    assert.equal(out[0]!.subject, 'src/a.ts');
  });

  it('flags negative parse numbers as parse_invalid', () => {
    const a: FileFacts = { ...goodFacts(), parse: { errorBytes: -1, totalBytes: 120 } };
    const b: FileFacts = { ...goodFacts(), parse: { errorBytes: 0, totalBytes: -5 } };
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

describe('validateFileFacts with the Phase 2 optional fields', () => {
  function richFacts(): FileFacts {
    return {
      ...goodFacts(),
      symbols: [
        { name: 'A', kind: 'class', qualifiedName: 'A', span: span(0, 0, 4, 1), exported: true },
        { name: 'm', kind: 'method', qualifiedName: 'A.m', span: span(1, 2, 3, 3), parent: 0 },
      ],
      refSites: [{ name: 'B', span: span(5, 0, 5, 1), kind: 'call', enclosing: 0 }],
      imports: [
        {
          path: './b',
          span: span(6, 0, 6, 12),
          style: 'es',
          bindings: [{ imported: 'a', local: 'b' }],
        },
      ],
      exports: [{ name: 'A', local: 'A', span: span(7, 0, 7, 10) }],
    };
  }

  it('accepts exports, reference kinds, enclosing symbols and import bindings', () => {
    assert.deepEqual(validateFileFacts(richFacts()), []);
  });

  it('accepts every declared reference kind and import style', () => {
    for (const kind of REF_KINDS) {
      const facts: FileFacts = {
        ...goodFacts(),
        refSites: [{ name: 'B', span: span(5, 0, 5, 1), kind }],
      };
      assert.deepEqual(validateFileFacts(facts), [], kind);
    }
    for (const style of IMPORT_STYLES) {
      const facts: FileFacts = {
        ...goodFacts(),
        imports: [{ path: './b', span: span(6, 0, 6, 12), style }],
      };
      assert.deepEqual(validateFileFacts(facts), [], style);
    }
  });

  it('declares the closed reference-kind and import-style sets', () => {
    assert.deepEqual([...REF_KINDS], ['call', 'new', 'read', 'type', 'heritage', 'member']);
    assert.deepEqual([...IMPORT_STYLES], ['es', 'cjs', 'side-effect', 'reexport']);
  });

  it('still accepts a Phase 1 shaped value with none of the new fields', () => {
    assert.deepEqual(validateFileFacts(goodFacts()), []);
  });

  it('rejects a ref site enclosing index outside the symbols array', () => {
    const bad: FileFacts = {
      ...goodFacts(),
      symbols: [{ name: 'A', kind: 'class', span: span(0, 0, 4, 1) }],
      refSites: [{ name: 'B', span: span(5, 0, 5, 1), enclosing: 5 }],
    };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'facts_invalid');
    assert.equal(out[0]!.subject, 'src/a.ts');
  });

  it('rejects a negative or fractional enclosing index', () => {
    for (const enclosing of [-1, 0.5]) {
      const bad: FileFacts = {
        ...goodFacts(),
        refSites: [{ name: 'B', span: span(5, 0, 5, 1), enclosing }],
      };
      const out = validateFileFacts(bad);
      assert.equal(out.length, 1);
      assert.equal(out[0]!.code, 'facts_invalid');
    }
  });

  it('rejects a symbol parent index outside the symbols array', () => {
    const bad: FileFacts = {
      ...goodFacts(),
      symbols: [
        { name: 'A', kind: 'class', span: span(0, 0, 4, 1) },
        { name: 'm', kind: 'method', span: span(1, 2, 3, 3), parent: 3 },
      ],
    };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'facts_invalid');
    assert.equal(out[0]!.subject, 'src/a.ts');
  });

  it('rejects a reference kind outside the closed set', () => {
    const bad = {
      ...goodFacts(),
      refSites: [{ name: 'B', span: span(5, 0, 5, 1), kind: 'bogus' }],
    };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'facts_invalid');
    assert.equal(out[0]!.subject, 'src/a.ts');
  });

  it('rejects an import style outside the closed set', () => {
    const bad = {
      ...goodFacts(),
      imports: [{ path: './b', span: span(6, 0, 6, 12), style: 'amd' }],
    };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'facts_invalid');
  });

  it('flags an export without a span as span_missing', () => {
    const bad = { ...goodFacts(), exports: [{ name: 'A' }] };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'span_missing');
    assert.equal(out[0]!.subject, 'src/a.ts');
  });

  it('flags an export whose end precedes its start as span_invalid', () => {
    const bad: FileFacts = {
      ...goodFacts(),
      exports: [{ name: 'A', span: span(7, 4, 7, 1) }],
    };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'span_invalid');
  });

  it('flags an export with an empty name as facts_invalid', () => {
    const bad: FileFacts = {
      ...goodFacts(),
      exports: [{ name: '', span: span(7, 0, 7, 1) }],
    };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'facts_invalid');
  });

  it('flags a non-array exports field as facts_invalid', () => {
    const bad = { ...goodFacts(), exports: 'A' };
    const out = validateFileFacts(bad);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.code, 'facts_invalid');
    assert.equal(out[0]!.subject, 'src/a.ts');
  });

  it('flags an import binding with an empty imported or local name as facts_invalid', () => {
    for (const binding of [
      { imported: '', local: 'b' },
      { imported: 'a', local: '' },
    ]) {
      const bad: FileFacts = {
        ...goodFacts(),
        imports: [{ path: './b', span: span(6, 0, 6, 12), style: 'es', bindings: [binding] }],
      };
      const out = validateFileFacts(bad);
      assert.equal(out.length, 1);
      assert.equal(out[0]!.code, 'facts_invalid');
      assert.equal(out[0]!.subject, 'src/a.ts');
    }
  });

  it('[edge LNG-04/empty] validates empty arrays and zero parse bytes with no diagnostics', () => {
    const empty: FileFacts = {
      ...goodFacts(),
      symbols: [],
      refSites: [],
      imports: [],
      exports: [],
      parse: { errorBytes: 0, totalBytes: 0 },
    };
    assert.deepEqual(validateFileFacts(empty), []);
  });
});

describe('DEGRADED_CODES', () => {
  it('is exactly the fourteen codes of the contract, the earlier eleven first and in order', () => {
    assert.equal(DEGRADED_CODES.length, 14);
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
        'reconciling',
        'rebuilding',
        'watermark_moved',
        'memory_budget',
        'compiler_fallback',
        'needs_approval',
      ],
    );
  });

  it('isDegradedCode narrows strings', () => {
    assert.equal(isDegradedCode('stale'), true);
    assert.equal(isDegradedCode('resolver_failed'), true);
    assert.equal(isDegradedCode('reconciling'), true);
    assert.equal(isDegradedCode('rebuilding'), true);
    assert.equal(isDegradedCode('watermark_moved'), true);
    assert.equal(isDegradedCode('memory_budget'), true);
    assert.equal(isDegradedCode('compiler_fallback'), true);
    assert.equal(isDegradedCode('needs_approval'), true);
    assert.equal(isDegradedCode('nope'), false);
    assert.equal(isDegradedCode(''), false);
  });

  it('[edge SEC-02/forward-compat] an unknown code is not a code and never throws', () => {
    assert.doesNotThrow(() => isDegradedCode('future_code'));
    assert.equal(isDegradedCode('future_code'), false);
    // A hand-made envelope from a newer host: a consumer reads its codes through isDegradedCode and
    // keeps the ones it knows; the rest read as "degraded, reason unknown".
    const fromNewerHost = JSON.parse(
      JSON.stringify({
        schema: 'x.v1',
        ok: true,
        data: null,
        diagnostics: [],
        degraded: ['stale', 'future_code'],
      }),
    ) as { degraded: string[] };
    assert.deepEqual(fromNewerHost.degraded.filter(isDegradedCode), ['stale']);
    assert.equal(fromNewerHost.degraded.some((code) => !isDegradedCode(code)), true);
  });
});

describe('answer id', () => {
  it('answer id shape: a_ followed by sixteen lower-case hex characters', () => {
    assert.equal(ANSWER_ID_PATTERN.source, '^a_[0-9a-f]{16}$');
    for (let i = 0; i < 20; i += 1) {
      const id = createAnswerId();
      assert.match(id, ANSWER_ID_PATTERN);
      assert.equal(isAnswerId(id), true);
    }
    assert.equal(isAnswerId('a_00112233445566ff'), true);
  });

  it('isAnswerId rejects an uppercase form, a missing prefix, 15 or 17 digits and non-strings', () => {
    assert.equal(isAnswerId('a_00112233445566FF'), false);
    assert.equal(isAnswerId('00112233445566ff'), false);
    assert.equal(isAnswerId('A_00112233445566ff'), false);
    assert.equal(isAnswerId('a_00112233445566f'), false);
    assert.equal(isAnswerId('a_00112233445566ff0'), false);
    assert.equal(isAnswerId('a_00112233445566fg'), false);
    assert.equal(isAnswerId('a_00112233445566ff\n'), false);
    assert.equal(isAnswerId(' a_00112233445566ff'), false);
    assert.equal(isAnswerId(''), false);
    for (const bad of [undefined, null, 42, {}, [], ['a_00112233445566ff'], Symbol('a')]) {
      assert.equal(isAnswerId(bad), false);
    }
  });

  it('answer id random: two ids differ and each comes from the random source', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(createAnswerId());
    assert.equal(seen.size, 200);
  });

  it('answer id random: an injected source returning eight zero bytes gives a_0000000000000000', () => {
    const asked: number[] = [];
    const id = createAnswerId((size) => {
      asked.push(size);
      return new Uint8Array(size);
    });
    assert.equal(id, 'a_0000000000000000');
    assert.deepEqual(asked, [8]);
  });

  it('answer id random: an injected source maps bytes to two lower-case hex digits each', () => {
    const id = createAnswerId(() => Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0xff]));
    assert.equal(id, 'a_00112233445566ff');
  });

  it('answer id random: a source that returns the wrong number of bytes is refused', () => {
    assert.throws(() => createAnswerId(() => new Uint8Array(4)));
  });

  it('answer id takes no request, tool name or path: the helper has no required parameter', () => {
    assert.equal(createAnswerId.length, 0);
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

describe('Envelope extras (QRY-01)', () => {
  const citation: Citation = {
    id: 'c1',
    path: 'src/a.ts',
    line: 3,
    col: 1,
    endLine: 3,
    endCol: 9,
    confidence: 'EXTRACTED',
    debug: 'dbg-1',
  };
  const untrusted: UntrustedText = {
    nonce: 'n0nce',
    entries: [{ ref: 'c1', text: 'export function a() {}' }],
  };
  const watermark: Watermark = { seq: 4, stalePaths: [] };

  it('okEnvelope without extras has exactly the Phase 1 key set', () => {
    const envelope = okEnvelope('x.v1', { a: 1 });
    assert.deepEqual(Object.keys(envelope).sort(), ['data', 'diagnostics', 'ok', 'schema']);
  });

  it('okEnvelope carries each extra it is given and omits the rest', () => {
    const envelope = okEnvelope('x.v1', 1, [], {
      citations: [citation],
      watermark,
      untrusted_text: untrusted,
      truncated: true,
      more: 'cursor-x',
      hints: ['h'],
    });
    assert.deepEqual(envelope.citations, [citation]);
    assert.deepEqual(envelope.watermark, watermark);
    assert.deepEqual(envelope.untrusted_text, untrusted);
    assert.equal(envelope.truncated, true);
    assert.equal(envelope.more, 'cursor-x');
    assert.deepEqual(envelope.hints, ['h']);
    assert.equal('retry_after' in envelope, false);
  });

  it('okEnvelope leaves out keys whose extra is absent or undefined', () => {
    const envelope = okEnvelope('x.v1', 1, [], { truncated: false, more: undefined });
    assert.deepEqual(Object.keys(envelope).sort(), [
      'data',
      'diagnostics',
      'ok',
      'schema',
      'truncated',
    ]);
    assert.equal(JSON.stringify(envelope).includes('undefined'), false);
    assert.equal(JSON.stringify(envelope).includes('more'), false);
  });

  it('okEnvelope with empty extras equals the Phase 1 object', () => {
    assert.deepEqual(okEnvelope('x.v1', 1, [], {}), okEnvelope('x.v1', 1));
  });

  it('failEnvelope without extras is unchanged', () => {
    const d = diagnostic('boom', 'error', 'failed');
    assert.deepEqual(Object.keys(failEnvelope('x.v1', [d])).sort(), [
      'data',
      'diagnostics',
      'ok',
      'schema',
    ]);
  });

  it('failEnvelope carries retry_after in milliseconds and no other new key', () => {
    const d = diagnostic('busy', 'error', 'try again');
    const envelope = failEnvelope('x.v1', [d], { retry_after: 250 });
    assert.deepEqual(envelope, {
      schema: 'x.v1',
      ok: false,
      data: null,
      diagnostics: [d],
      retry_after: 250,
    });
  });

  it('okEnvelope keeps answer_id and the envelope round-trips through JSON', () => {
    const envelope = okEnvelope('x', {}, [], { answer_id: 'a_00112233445566ff' });
    assert.equal(envelope.answer_id, 'a_00112233445566ff');
    assert.deepEqual(JSON.parse(JSON.stringify(envelope)), envelope);
  });

  it('an envelope built without answer_id has no answer_id key', () => {
    const plain = okEnvelope('x', {});
    assert.equal('answer_id' in plain, false);
    const undef = okEnvelope('x', {}, [], { answer_id: undefined });
    assert.equal('answer_id' in undef, false);
    assert.equal(JSON.stringify(undef).includes('answer_id'), false);
    assert.equal('answer_id' in failEnvelope('x', []), false);
  });

  it('a Phase 2 shaped envelope with no answer_id still has the same key set', () => {
    const phase2 = okEnvelope('x.v1', 1, [], { citations: [citation], watermark, hints: ['h'] });
    assert.deepEqual(Object.keys(phase2).sort(), [
      'citations',
      'data',
      'diagnostics',
      'hints',
      'ok',
      'schema',
      'watermark',
    ]);
  });

  it('a Citation holds structure and a text_ref handle, never source text', () => {
    const withRef: Citation = { ...citation, text_ref: 'c1' };
    assert.deepEqual(Object.keys(withRef).sort(), [
      'col',
      'confidence',
      'debug',
      'endCol',
      'endLine',
      'id',
      'line',
      'path',
      'text_ref',
    ]);
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
      findIn: async (path, name) =>
        path === identity.path && name === 'A' ? [{ ...identity, span: span(0, 0, 4, 1) }] : [],
    };
    assert.deepEqual(await lookup.find('A'), [identity]);
    assert.deepEqual(await lookup.find('Z'), []);
    assert.deepEqual(await lookup.findIn(identity.path, 'A'), [{ ...identity, span: span(0, 0, 4, 1) }]);
    assert.deepEqual(await lookup.findIn('src/other.ts', 'A'), []);
  });

  it('shapes ResolveScope, ProjectContext and ProjectContextProvider, and the default context is the grammar tier', async () => {
    const overlay: OverlaySnapshot = { id: 'ov1', pathToHash: new Map([['src/a.ts', 'h1']]) };
    const project: ProjectContext = { context: { id: 'ts:6', configHashes: ['h-tsconfig'] } };
    const scope: ResolveScope = { worktree: 'main', overlay, project };
    const provider: ProjectContextProvider = async (asked) => (asked.worktree === scope.worktree ? project : DEFAULT_PROJECT_CONTEXT);
    assert.equal(await provider({ worktree: 'main', overlay }), project);
    assert.equal(await provider({ worktree: 'other', overlay }), DEFAULT_PROJECT_CONTEXT);

    assert.deepEqual(DEFAULT_PROJECT_CONTEXT, { context: { id: 'grammar', configHashes: [] } });
    assert.ok(Object.isFrozen(DEFAULT_PROJECT_CONTEXT), 'a shared default can not be changed by a resolver');
    assert.ok(Object.isFrozen(DEFAULT_PROJECT_CONTEXT.context));
    assert.ok(Object.isFrozen(DEFAULT_PROJECT_CONTEXT.context.configHashes));

    // A resolver written for the three-argument shape is a ResolverPort.
    const old: ResolverPort = async function* (sites, context) {
      for (const site of sites) yield { site, target: identity, confidence: 'EXTRACTED', resolver: context.id };
    };
    const lookup: SymbolLookup = { find: async () => [], findIn: async () => [] };
    const site = { path: 'src/b.ts', span: span(1, 0, 1, 1), name: 'A' };
    const seen: string[] = [];
    for await (const edge of old([site], project.context, lookup)) seen.push(edge.resolver);
    assert.deepEqual(seen, ['ts:6']);
  });
});
