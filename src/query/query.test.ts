import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Citation, Envelope, Request } from '../facts/index.ts';
import { createHarness } from './harness.test.ts';
import type { Harness, SymbolSpec } from './harness.test.ts';
import { TOOLS, TOOL_NAMES, buildRequest } from './index.ts';

async function world(t: TestContext): Promise<Harness> {
  const harness = await createHarness();
  t.after(() => harness.cleanup());
  return harness;
}

/** Line 3 holds `export function parse(input) {`; the name starts at 0-based column 16. */
const A_TS = '// a.ts\n\nexport function parse(input) {\n  return input;\n}\n';
const PARSE: SymbolSpec = { name: 'parse', kind: 'function', line: 2, col: 16, endCol: 21, exported: true };

interface FoundResult {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly exported?: boolean;
  readonly confidence: string;
  readonly citation: string;
}

interface FindData {
  readonly results: readonly FoundResult[];
}

const dataOf = (envelope: Envelope): FindData => envelope.data as FindData;

function findRequest(h: Harness, args: Record<string, unknown>): Request {
  return { protocol: 1, kind: 'code_find', args: { repo: h.dir, ...args }, worktree: h.dir };
}

const NONCE = /^[0-9a-f]{32}$/;

describe('Query tracer: code_find returns a ranked citation with fenced line text over a real store and real files', () => {
  it('returns the full envelope for one exported function', async (t) => {
    const h = await world(t);
    await h.addFile('src/a.ts', A_TS, [PARSE]);

    const envelope = await h.query().ask(findRequest(h, { name: 'parse' }));

    assert.equal(envelope.ok, true);
    assert.equal(envelope.schema, 'gsd-atlas.code-find/1');
    assert.deepEqual(envelope.diagnostics, []);
    assert.equal('degraded' in envelope, false);
    assert.equal('truncated' in envelope, false);
    assert.equal('more' in envelope, false);

    const { results } = dataOf(envelope);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      name: 'parse',
      kind: 'function',
      path: 'src/a.ts',
      line: 3,
      col: 17,
      exported: true,
      confidence: 'EXTRACTED',
      citation: 'c1',
    });

    const stored = (await h.store.at(h.dir).find('parse')).data[0];
    assert.ok(stored !== undefined);
    const citations = envelope.citations ?? [];
    assert.equal(citations.length, 1);
    const citation = citations[0] as Citation;
    assert.equal(citation.id, 'c1');
    assert.equal(citation.path, 'src/a.ts');
    assert.equal(citation.line, 3);
    assert.equal(citation.col, 17);
    assert.equal(citation.endLine, 3);
    assert.equal(citation.endCol, 22);
    assert.equal(citation.confidence, 'EXTRACTED');
    assert.equal(citation.debug, stored.debug);
    assert.equal(citation.text_ref, 'ut1');

    const untrusted = envelope.untrusted_text;
    assert.ok(untrusted !== undefined);
    assert.match(untrusted.nonce, NONCE);
    assert.deepEqual(untrusted.entries, [
      {
        ref: 'ut1',
        text: `BEGIN-UNTRUSTED-${untrusted.nonce}\nexport function parse(input) {\nEND-UNTRUSTED-${untrusted.nonce}`,
      },
    ]);

    const current = await h.store.at(h.dir).find('parse');
    assert.deepEqual(envelope.watermark, { seq: current.watermark.seq, stalePaths: [] });
  });

  it('gives every response its own 32 hex character nonce', async (t) => {
    const h = await world(t);
    await h.addFile('src/a.ts', A_TS, [PARSE]);
    const query = h.query();

    const first = await query.ask(findRequest(h, { name: 'parse' }));
    const second = await query.ask(findRequest(h, { name: 'parse' }));

    const one = first.untrusted_text?.nonce ?? '';
    const two = second.untrusted_text?.nonce ?? '';
    assert.match(one, NONCE);
    assert.match(two, NONCE);
    assert.notEqual(one, two);
  });

  it('answers a name with no match as an ok envelope with an empty list and one static hint', async (t) => {
    const h = await world(t);
    await h.addFile('src/a.ts', A_TS, [PARSE]);

    const envelope = await h.query().ask(findRequest(h, { name: 'nothingCalledThis' }));

    assert.equal(envelope.ok, true);
    assert.deepEqual(dataOf(envelope).results, []);
    assert.equal(envelope.hints?.length, 1);
    assert.equal('citations' in envelope, false);
    assert.equal('untrusted_text' in envelope, false);
    assert.equal('truncated' in envelope, false);
    assert.ok(envelope.watermark !== undefined);
    assert.equal(envelope.watermark.stalePaths.length, 0);
  });

  it('answers an unindexed repository with not_indexed and names the exact build command', async (t) => {
    const h = await world(t);

    const envelope = await h.query().ask({ protocol: 1, kind: 'code_find', args: { name: 'parse' }, worktree: `${h.dir}-never-indexed` });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.schema, 'gsd-atlas.error/1');
    const found = envelope.diagnostics.find((d) => d.code === 'not_indexed');
    assert.ok(found !== undefined, 'a not_indexed diagnostic');
    assert.equal(found.severity, 'error');
    assert.ok(found.message.includes('gsd-atlas build'), found.message);
  });

  it('answers an unknown request kind with the unknown_kind error envelope', async (t) => {
    const h = await world(t);

    const envelope = await h.query().ask({ protocol: 1, kind: 'bogus_tool', args: {}, worktree: h.dir });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.schema, 'gsd-atlas.error/1');
    assert.equal(envelope.diagnostics[0]?.code, 'unknown_kind');
  });

  it('answers an unsupported protocol with unsupported_protocol', async (t) => {
    const h = await world(t);

    const envelope = await h.query().ask({ protocol: 99, kind: 'code_find', args: { name: 'parse' }, worktree: h.dir });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'unsupported_protocol');
  });

  it('rejects an empty, whitespace-only or missing name with invalid_args', async (t) => {
    const h = await world(t);
    await h.addFile('src/a.ts', A_TS, [PARSE]);
    const query = h.query();

    for (const args of [{ name: '' }, { name: '   \t ' }, {}, { name: 'parse', unknown_key: 1 }]) {
      const envelope = await query.ask(findRequest(h, args));
      assert.equal(envelope.ok, false, JSON.stringify(args));
      assert.equal(envelope.schema, 'gsd-atlas.error/1');
      assert.equal(envelope.diagnostics[0]?.code, 'invalid_args', JSON.stringify(args));
    }
  });

  it('rejects a request that names no worktree with invalid_args', async (t) => {
    const h = await world(t);

    const envelope = await h.query().ask({ protocol: 1, kind: 'code_find', args: { name: 'parse' } });

    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'invalid_args');
  });

  it('matches non-ASCII and emoji names exactly', async (t) => {
    const h = await world(t);
    const name = 'naïve\u{1F600}';
    await h.addFile('src/emoji.ts', `export const ${name} = 1;\n`, [{ name, kind: 'const', line: 0, col: 13, exported: true }]);

    const envelope = await h.query().ask(findRequest(h, { name }));

    assert.equal(envelope.ok, true);
    const { results } = dataOf(envelope);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.name, name);
    assert.equal(results[0]?.col, 14);
  });
});

describe('Query tools: the shared definitions behind the CLI and the MCP server', () => {
  it('names exactly six tools in the stated order, each read-only with a fixed description', () => {
    assert.deepEqual([...TOOL_NAMES], ['code_find', 'code_refs', 'code_context', 'code_impact', 'atlas_status', 'lang_list']);
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      [...TOOL_NAMES],
    );
    for (const tool of TOOLS) {
      assert.equal(tool.readOnlyHint, true, tool.name);
      assert.ok(tool.title.length > 0, tool.name);
      assert.ok(tool.description.length > 0, tool.name);
      assert.equal(tool.description.includes('${'), false, tool.name);
    }
    const find = TOOLS.find((tool) => tool.name === 'code_find');
    assert.ok(find?.description.includes('untrusted_text'), 'code_find says where repo text goes');
  });

  it('parses each tool\'s documented arguments and rejects unknown keys', () => {
    const common = { repo: '/r', cwd: '/r/src', budget_tokens: 100, more: 'abc', fresh: ['a.ts'] };
    const documented: Record<string, Record<string, unknown>> = {
      code_find: { name: 'parse', kind: 'function', mode: 'fuzzy', limit: 5, ...common },
      code_refs: { name: 'parse', path: 'src/a.ts', limit: 5, ...common },
      code_context: { name: 'parse', path: 'src/a.ts', limit: 5, ...common },
      code_impact: { name: 'parse', path: 'src/a.ts', limit: 5, depth: 2, ...common },
      atlas_status: { repo: '/r' },
      lang_list: { repo: '/r' },
    };
    for (const tool of TOOLS) {
      const input = documented[tool.name];
      assert.ok(input !== undefined, tool.name);
      assert.equal(tool.inputSchema.safeParse(input).success, true, `${tool.name} accepts its arguments`);
      assert.equal(tool.inputSchema.safeParse({ ...input, surprise: true }).success, false, `${tool.name} rejects unknown keys`);
    }
    const find = TOOLS.find((tool) => tool.name === 'code_find');
    assert.equal(find?.inputSchema.safeParse({ name: '   ' }).success, false, 'a blank name is refused');
    assert.equal(find?.inputSchema.safeParse({}).success, false, 'a name is required');
  });

  it('builds a request with the protocol, kind, args, budget and fresh paths', () => {
    assert.deepEqual(buildRequest('code_find', { name: 'parse', budget_tokens: 500, fresh: ['a.ts'] }), {
      protocol: 1,
      kind: 'code_find',
      args: { name: 'parse' },
      budget_tokens: 500,
      fresh: ['a.ts'],
    });
    const withRepo = buildRequest('code_find', { name: 'parse', repo: '/r' });
    assert.equal(withRepo.worktree, '/r');
    assert.deepEqual(withRepo.args, { name: 'parse', repo: '/r' });
  });
});
