import assert from 'node:assert/strict';
import { test } from 'node:test';
import { positionsOfCompact, positionsOfEnvelope, provenanceOf } from './citation.ts';
import { renderCompact, unfence } from './compact.ts';
import { ONE_TOOL, calibratedTokens, firstSentence, listBytes, trimSet, TOKENS_PER_DEFINITION_BYTE } from './footprint.ts';
import type { ToolDef } from './footprint.ts';
import { mergeReplay, summariseMerge } from './merge.ts';
import { analyseReads, classifyBash, segmentsOf, summariseReads, tokenise } from './reads.ts';
import { median, sizePage, summarisePages } from './stats.ts';
import { parseStream, repoRelative } from './stream.ts';

const NONCE = 'abc123';
const fence = (text: string): string => `BEGIN-UNTRUSTED-${NONCE}\n${text}\nEND-UNTRUSTED-${NONCE}`;

/** A code_refs envelope shaped like the recorded ones: three rows in two files. */
function refsEnvelope(): string {
  return JSON.stringify({
    schema: 'gsd-atlas.code-refs/1',
    ok: true,
    data: {
      targets: [{ name: 'foo', kind: 'function', path: 'src/foo.ts', line: 3, handle: 'sym/src%2Ffoo.ts/aa/1' }],
      results: [
        { target: 'sym/src%2Ffoo.ts/aa/1', path: 'src/a.ts', line: 10, col: 5, kind: 'call', enclosing: 'run', tier: 'precise', confidence: 'EXTRACTED', ambiguous: false, candidates: 1, edge: 'calls', citation: 'c1' },
        { target: 'sym/src%2Ffoo.ts/aa/1', path: 'src/b.ts', line: 7, col: 1, kind: 'member', enclosing: null, tier: 'grammar', confidence: 'INFERRED', ambiguous: true, candidates: 2, citation: 'c2' },
        { target: 'sym/src%2Ffoo.ts/aa/1', path: 'src/a.ts', line: 40, col: 2, kind: 'call', enclosing: 'other', tier: 'grammar', confidence: 'INFERRED', ambiguous: false, candidates: 1, citation: 'c3' },
      ],
    },
    diagnostics: [],
    citations: [
      { id: 'c1', path: 'src/a.ts', line: 10, col: 5, endLine: 10, endCol: 8, confidence: 'EXTRACTED', debug: 'ref/src%2Fa.ts/hh/1', text_ref: 'ut1' },
      { id: 'c2', path: 'src/b.ts', line: 7, col: 1, endLine: 7, endCol: 4, confidence: 'INFERRED', debug: 'ref/src%2Fb.ts/hh/2', text_ref: 'ut2' },
      { id: 'c3', path: 'src/a.ts', line: 40, col: 2, endLine: 40, endCol: 5, confidence: 'INFERRED', debug: 'ref/src%2Fa.ts/hh/3', text_ref: 'ut3' },
    ],
    watermark: { seq: 5, stalePaths: [] },
    untrusted_text: {
      nonce: NONCE,
      entries: [
        { ref: 'ut1', text: fence('  return foo(1);') },
        { ref: 'ut2', text: fence('x.foo') },
        { ref: 'ut3', text: fence('foo(2)') },
      ],
    },
    truncated: true,
    more: 'CURSOR',
    hints: ['pass more'],
    answer_id: 'a_1',
  });
}

test('unfence removes the fence lines and folds line breaks', () => {
  assert.equal(unfence(fence('  one\n  two')), 'one ⏎ two');
});

test('renderCompact groups by file, keeps the nonce fence once, and drops citation records', () => {
  const raw = refsEnvelope();
  const compact = renderCompact(raw, undefined, true);
  assert.notEqual(compact, null);
  assert.equal(compact?.references, 3);
  const text = compact?.text ?? '';
  const lines = text.split('\n');
  assert.match(lines[0] as string, /^code_refs target=foo function src\/foo\.ts:3 rows=3 more=CURSOR truncated$/);
  assert.equal(lines.filter((line) => line.startsWith('BEGIN-UNTRUSTED-')).length, 1);
  assert.equal(lines.filter((line) => line.startsWith('END-UNTRUSTED-')).length, 1);
  assert.ok(lines.includes('src/a.ts') && lines.includes('src/b.ts'));
  assert.equal(lines.filter((line) => line === 'src/a.ts').length, 1, 'one header per file');
  assert.ok(text.includes(' 10:5 call run P | return foo(1);'));
  assert.ok(text.includes(' 7:1 member - G?~ c2 | x.foo'));
  for (const dropped of ['debug', 'text_ref', 'endLine', 'handle', 'answer_id', 'hints', 'sym/']) {
    assert.ok(!text.includes(dropped), `${dropped} must be dropped`);
  }
});

test('the lean form omits the matched line but keeps position, kind and enclosing symbol', () => {
  const lean = renderCompact(refsEnvelope(), undefined, false)?.text ?? '';
  assert.ok(lean.includes(' 10:5 call run P'));
  assert.ok(!lean.includes('return foo'));
});

test('renderCompact keeps stale paths, degraded flags and diagnostics, and returns null for non-envelopes', () => {
  const envelope = JSON.parse(refsEnvelope()) as Record<string, unknown>;
  envelope.watermark = { seq: 1, stalePaths: ['src/a.ts'] };
  envelope.degraded = ['reconciling'];
  envelope.diagnostics = [{ code: 'bad_cursor', severity: 'error', message: 'malformed' }];
  const text = renderCompact(JSON.stringify(envelope))?.text ?? '';
  assert.ok(text.includes('stale=src/a.ts'));
  assert.ok(text.includes('degraded=reconciling'));
  assert.ok(text.includes('! bad_cursor: malformed'));
  assert.equal(renderCompact('not json'), null);
  assert.equal(renderCompact('{"a":1}'), null);
  assert.equal(renderCompact('[1]'), null);
});

test('an envelope with no rows has no fence', () => {
  const raw = JSON.stringify({ schema: 'gsd-atlas.code-refs/1', ok: true, data: { targets: [], results: [] }, diagnostics: [], watermark: { seq: 1, stalePaths: [] } });
  const compact = renderCompact(raw);
  assert.equal(compact?.references, 0);
  assert.ok(!(compact?.text ?? '').includes('BEGIN-UNTRUSTED'));
});

test('positions survive the round trip (the inputs the citation scorer needs)', () => {
  const raw = refsEnvelope();
  const compact = renderCompact(raw)?.text ?? '';
  const key = (list: { path: string; line: number }[]): string[] => list.map((p) => `${p.path}:${String(p.line)}`).sort();
  assert.deepEqual(key(positionsOfCompact(compact)), key(positionsOfEnvelope(raw)));
  assert.deepEqual(key(positionsOfCompact(compact)), ['src/a.ts:10', 'src/a.ts:40', 'src/b.ts:7']);
});

test('sizePage and summarisePages report smaller compact pages and a kept position set', () => {
  const page = sizePage(undefined, refsEnvelope());
  assert.notEqual(page, null);
  assert.ok((page?.compact ?? Infinity) < (page?.original ?? 0));
  assert.ok((page?.lean ?? Infinity) < (page?.compact ?? 0));
  assert.equal(page?.positionsKept, true);
  assert.ok((page?.cursor ?? 0) > 0);
  const summary = summarisePages(page === null || page === undefined ? [] : [page, page]);
  assert.equal(summary.references, 6);
  assert.equal(summary.pagesWithReferences, 2);
  assert.ok(summary.cutCompact > 0.3);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

// ------------------------------------------------------------------ stream builders

interface Step {
  readonly turn: number;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly result?: string;
}

/** Builds stream-json text with one assistant message per turn number and one result per step. */
function stream(steps: readonly Step[], cwd = '/work/repo', answer?: Record<string, unknown>): string {
  const lines: string[] = [JSON.stringify({ type: 'system', subtype: 'init', cwd })];
  const all: Step[] = answer === undefined ? [...steps] : [...steps, { turn: 999, name: 'StructuredOutput', input: answer, result: 'ok' }];
  all.forEach((step, index) => {
    const id = `t${String(index)}`;
    lines.push(JSON.stringify({ type: 'assistant', message: { id: `m${String(step.turn)}`, content: [{ type: 'tool_use', id, name: step.name, input: step.input }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: step.result ?? 'ok' }] }] } }));
  });
  return lines.join('\n');
}

const ATLAS = (tool: string): string => `mcp__gsd-atlas__${tool}`;
const rowsEnvelope = (paths: readonly string[]): string => JSON.stringify({ schema: 'gsd-atlas.code-refs/1', ok: true, data: { results: paths.map((path, i) => ({ path, line: i + 1, col: 1 })) } });

test('parseStream numbers turns by assistant message id and attaches results', () => {
  const session = parseStream('s', stream([
    { turn: 0, name: ATLAS('code_find'), input: { name: 'Foo' }, result: '{"x":1}' },
    { turn: 1, name: 'Bash', input: { command: 'ls' } },
  ]));
  assert.equal(session.calls.length, 2);
  assert.equal(session.calls[0]?.turn, 0);
  assert.equal(session.calls[1]?.turn, 1);
  assert.equal(session.calls[0]?.result, '{"x":1}');
  assert.equal(session.cwd, '/work/repo');
  assert.equal(parseStream('empty', 'garbage\n\n').calls.length, 0);
});

test('repoRelative strips the working directory and ./', () => {
  assert.equal(repoRelative('/work/repo/src/a.ts', '/work/repo'), 'src/a.ts');
  assert.equal(repoRelative('./src/a.ts', '/work/repo'), 'src/a.ts');
  assert.equal(repoRelative('src/a.ts', ''), 'src/a.ts');
});

// ------------------------------------------------------------------ B

test('mergeReplay merges contiguous runs on one symbol and counts continuations', () => {
  const session = parseStream('s', stream([
    { turn: 0, name: ATLAS('code_find'), input: { name: 'Foo' } },
    { turn: 1, name: ATLAS('code_refs'), input: { name: 'foo', path: 'a.ts' } },
    { turn: 2, name: ATLAS('code_refs'), input: { name: 'Foo', path: 'a.ts', more: 'c' } },
    { turn: 3, name: 'Bash', input: { command: 'ls' } },
    { turn: 4, name: ATLAS('code_impact'), input: { name: 'Bar' } },
    { turn: 5, name: ATLAS('code_refs'), input: { name: 'Foo' } },
    { turn: 6, name: ATLAS('atlas_status'), input: {} },
  ]));
  const result = mergeReplay(session);
  assert.equal(result.calls, 5, 'atlas_status is not mergeable');
  assert.equal(result.strictGroups, 3, 'Foo x3, Bar, Foo again');
  assert.equal(result.strictSaved, 2);
  assert.equal(result.continuationsSaved, 1);
  assert.equal(result.looseSaved, 4);
});

test('mergeReplay: no atlas call saves nothing; a single call saves nothing; unnamed calls never join', () => {
  assert.equal(mergeReplay(parseStream('s', stream([{ turn: 0, name: 'Bash', input: { command: 'ls' } }]))).strictSaved, 0);
  assert.equal(mergeReplay(parseStream('s', stream([{ turn: 0, name: ATLAS('code_find'), input: { name: 'A' } }]))).strictSaved, 0);
  const unnamed = parseStream('s', stream([
    { turn: 0, name: ATLAS('code_find'), input: {} },
    { turn: 1, name: ATLAS('code_find'), input: {} },
  ]));
  assert.equal(mergeReplay(unnamed).strictSaved, 0);
});

test('summariseMerge reports called sessions, nothing-to-merge and the histograms', () => {
  const sessions = [
    parseStream('a', stream([{ turn: 0, name: 'Bash', input: { command: 'ls' } }])),
    parseStream('b', stream([{ turn: 0, name: ATLAS('code_refs'), input: { name: 'A' } }])),
    parseStream('c', stream([
      { turn: 0, name: ATLAS('code_find'), input: { name: 'A' } },
      { turn: 1, name: ATLAS('code_refs'), input: { name: 'A' } },
      { turn: 2, name: ATLAS('code_refs'), input: { name: 'A', more: 'x' } },
    ])),
  ];
  const summary = summariseMerge(sessions);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.calledSessions, 2);
  assert.equal(summary.calls, 4);
  assert.equal(summary.strictSaved, 2);
  assert.equal(summary.calledNothingToMerge, 1);
  assert.equal(summary.sessionsWithStrictSaving, 1);
  assert.equal(summary.meanCallsPerCalled, 2);
  assert.equal(summary.callsHistogram.get(3), 1);
});

// ------------------------------------------------------------------ C

test('tokenise and segmentsOf respect quotes and shell separators', () => {
  assert.deepEqual(tokenise(`sed -n '10,20p' "a b.ts"`), ['sed', '-n', '10,20p', 'a b.ts']);
  assert.deepEqual(segmentsOf(`cd x && sed -n 1,5p a.ts; grep "a;b" c.ts | head -3`), ['cd x', 'sed -n 1,5p a.ts', 'grep "a;b" c.ts', 'head -3']);
});

test('classifyBash tells file reads, greps with a file, and recursive searches apart', () => {
  assert.deepEqual(classifyBash('sed -n 10,20p src/a.ts'), { category: 'bash-file-read', operands: ['src/a.ts'] });
  assert.deepEqual(classifyBash('cat src/a.ts'), { category: 'bash-file-read', operands: ['src/a.ts'] });
  assert.deepEqual(classifyBash('grep -n foo src/a.ts'), { category: 'grep-file', operands: ['src/a.ts'] });
  assert.deepEqual(classifyBash('grep -rn foo .'), { category: 'grep-search', operands: [] });
  assert.deepEqual(classifyBash('grep -rn foo.bar src'), { category: 'grep-search', operands: [] });
  assert.equal(classifyBash('ls -la'), null);
  assert.equal(classifyBash('node -e "x"'), null);
  assert.equal(classifyBash('sed -n 1,5p'), null, 'a reader without a file operand is not a file read');
});

test('analyseReads: only a returned file within two turns is the signal', () => {
  const returned = rowsEnvelope(['src/a.ts']);
  const session = parseStream('s', stream([
    { turn: 0, name: ATLAS('code_refs'), input: { name: 'Foo' }, result: returned },
    { turn: 1, name: 'Read', input: { file_path: '/work/repo/src/a.ts' } },
    { turn: 2, name: 'Read', input: { file_path: '/work/repo/src/other.ts' } },
    { turn: 3, name: 'Bash', input: { command: 'sed -n 1,9p src/a.ts' } },
    { turn: 4, name: 'Bash', input: { command: 'sed -n 1,9p src/a.ts' } },
    { turn: 5, name: 'Bash', input: { command: 'grep -rn Foo .' } },
  ]));
  const analysis = analyseReads(session);
  assert.equal(analysis.atlasCalls, 1);
  const byCategory = analysis.follows.map((f) => `${f.category}:${String(f.targetsReturned)}:${String(f.withinTwoTurns)}`);
  assert.deepEqual(byCategory, ['read:true:true', 'read:false:false', 'bash-file-read:true:false', 'bash-file-read:true:false', 'grep-search:false:false']);
});

test('analyseReads ignores calls before the first atlas call and calls in the same turn', () => {
  const returned = rowsEnvelope(['src/a.ts']);
  const session = parseStream('s', stream([
    { turn: 0, name: 'Read', input: { file_path: 'src/a.ts' } },
    { turn: 1, name: ATLAS('code_refs'), input: { name: 'Foo' }, result: returned },
    { turn: 1, name: 'Read', input: { file_path: 'src/a.ts' } },
  ]));
  const [only] = analyseReads(session).follows;
  assert.equal(analyseReads(session).follows.length, 1);
  assert.equal(only?.targetsReturned, false, 'a call in the same assistant turn was not informed by the result');
});

test('summariseReads counts sessions, not calls, for the signal', () => {
  const returned = rowsEnvelope(['src/a.ts']);
  const withSignal = parseStream('a', stream([
    { turn: 0, name: ATLAS('code_refs'), input: { name: 'Foo' }, result: returned },
    { turn: 1, name: 'Read', input: { file_path: 'src/a.ts' } },
    { turn: 2, name: 'Read', input: { file_path: 'src/a.ts' } },
  ]));
  const noAtlas = parseStream('b', stream([{ turn: 0, name: 'Read', input: { file_path: 'src/a.ts' } }]));
  const grepOnly = parseStream('c', stream([
    { turn: 0, name: ATLAS('code_refs'), input: { name: 'Foo' }, result: returned },
    { turn: 1, name: 'Bash', input: { command: 'grep -n Foo src/a.ts' } },
  ]));
  const summary = summariseReads([withSignal, noAtlas, grepOnly]);
  assert.equal(summary.calledSessions, 2);
  assert.equal(summary.sessionsSignal, 1);
  assert.equal(summary.sessionsSignalWithGrepFile, 2);
  assert.equal(summary.byCategory.read.after, 2);
});

// ------------------------------------------------------------------ provenance

test('provenanceOf says where answer lines come from', () => {
  const session = parseStream('s', stream(
    [{ turn: 0, name: ATLAS('code_refs'), input: { name: 'Foo' }, result: rowsEnvelope(['src/a.ts', 'src/b.ts']) }],
    '/work/repo',
    { answer: 'found', items: [{ file: 'src/a.ts', line: 1 }, { file: 'src/b.ts', line: 99 }, { file: '/work/repo/src/zzz.ts', line: 4 }, { file: 'src/a.ts' }], summary: 's' },
  ));
  assert.deepEqual(provenanceOf(session), { itemsWithLine: 3, exactFromAtlas: 1, fileOnlyFromAtlas: 1, notFromAtlas: 1 });
  assert.equal(provenanceOf(parseStream('n', stream([{ turn: 0, name: 'Bash', input: { command: 'ls' } }]))), null);
});

// ------------------------------------------------------------------ D

const def = (name: string, description: string, props: Record<string, unknown> = {}): ToolDef => ({
  name,
  title: `Title of ${name}`,
  description,
  inputSchema: { type: 'object', $schema: 'x', properties: { name: { type: 'string', description: 'The symbol name. Longer explanation follows here.' }, ...props }, required: ['name'], additionalProperties: false },
  annotations: { readOnlyHint: true },
});

test('trimSet keeps only the named tools with the short text and no $schema', () => {
  const tools = [def('code_find', 'long '.repeat(100)), def('code_refs', 'long '.repeat(100)), def('lang_list', 'x')];
  const trimmed = trimSet(tools, ['code_find', 'code_refs']);
  assert.deepEqual(trimmed.map((t) => t.name), ['code_find', 'code_refs']);
  assert.ok(listBytes(trimmed) < listBytes(tools) / 2);
  assert.ok(!JSON.stringify(trimmed).includes('$schema'));
  assert.ok(!JSON.stringify(trimmed).includes('Longer explanation'));
});

test('firstSentence cuts at the first sentence and at 80 characters', () => {
  assert.equal(firstSentence('One. Two.'), 'One.');
  assert.equal(firstSentence('No full stop'), 'No full stop.');
  assert.equal(firstSentence('x'.repeat(200)).length, 80);
});

test('calibration reproduces the P1 figure and the one-tool draft is a single read-only tool', () => {
  assert.equal(calibratedTokens(9267), 3500);
  assert.ok(Math.abs(TOKENS_PER_DEFINITION_BYTE - 0.3777) < 0.001);
  assert.equal(ONE_TOOL.name, 'atlas_explore');
  assert.deepEqual(ONE_TOOL.annotations, { readOnlyHint: true });
  assert.ok(listBytes([ONE_TOOL]) < 2000);
});
