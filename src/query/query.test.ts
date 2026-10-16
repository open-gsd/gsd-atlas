import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Citation, Envelope, Request } from '../facts/index.ts';
import { estimateTokens } from './budget.ts';
import { createHarness } from './harness.test.ts';
import type { Harness, SymbolSpec } from './harness.test.ts';
import { TOOLS, TOOL_NAMES, buildRequest } from './index.ts';
import type { QueryConfig } from './index.ts';

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

/** Add `name` as an exported one-line function in `file`, with its definition on line 1 at column 17. */
async function addFn(h: Harness, file: string, name: string, extra: Partial<SymbolSpec> = {}): Promise<void> {
  await h.addFile(file, `export function ${name}() {}\n`, [{ name, kind: 'function', line: 0, col: 16, exported: true, ...extra }]);
}

const namesOf = (envelope: Envelope): string[] => dataOf(envelope).results.map((result) => result.name);

describe('code_find tiers and modes', () => {
  const FOUR = ['Config', 'config', 'configure', 'loadConfig'];

  async function fourNames(h: Harness): Promise<void> {
    for (const [index, name] of FOUR.entries()) await addFn(h, `src/x/f${String(index)}.ts`, name);
  }

  it('orders exact, case-insensitive exact, prefix and substring matches', async (t) => {
    const h = await world(t);
    await fourNames(h);

    const envelope = await h.query().ask(findRequest(h, { name: 'config' }));

    assert.deepEqual(namesOf(envelope), ['config', 'Config', 'configure', 'loadConfig']);
  });

  it('returns only exact and prefix matches for a query shorter than three characters', async (t) => {
    const h = await world(t);
    await addFn(h, 'src/x/one.ts', 'ab');
    await addFn(h, 'src/x/two.ts', 'abc');
    await addFn(h, 'src/x/three.ts', 'xab');

    const envelope = await h.query().ask(findRequest(h, { name: 'ab' }));

    assert.deepEqual(namesOf(envelope), ['ab', 'abc']);
  });

  it('mode exact returns only the exact tier, prefix adds the prefix tier, fuzzy returns every tier', async (t) => {
    const h = await world(t);
    await fourNames(h);
    const query = h.query();

    assert.deepEqual(namesOf(await query.ask(findRequest(h, { name: 'config', mode: 'exact' }))), ['config']);
    assert.deepEqual(namesOf(await query.ask(findRequest(h, { name: 'config', mode: 'prefix' }))), ['config', 'configure']);
    assert.deepEqual(namesOf(await query.ask(findRequest(h, { name: 'config', mode: 'fuzzy' }))), ['config', 'Config', 'configure', 'loadConfig']);
  });

  it('filters by symbol kind before ranking', async (t) => {
    const h = await world(t);
    await addFn(h, 'src/x/fn.ts', 'thing', { kind: 'function' });
    await addFn(h, 'src/x/cls.ts', 'thing', { kind: 'class' });

    const envelope = await h.query().ask(findRequest(h, { name: 'thing', kind: 'class' }));

    assert.equal(dataOf(envelope).results.length, 1);
    assert.equal(dataOf(envelope).results[0]?.kind, 'class');
  });

  it('puts exported definitions before local ones inside a tier', async (t) => {
    const h = await world(t);
    await addFn(h, 'src/a/local.ts', 'twin', { exported: false });
    await addFn(h, 'src/b/public.ts', 'twin', { exported: true });

    const envelope = await h.query().ask(findRequest(h, { name: 'twin' }));

    assert.deepEqual(
      dataOf(envelope).results.map((result) => result.path),
      ['src/b/public.ts', 'src/a/local.ts'],
    );
  });

  it('ranks the directory nearer to the cwd hint first and ignores a hint outside the worktree', async (t) => {
    const h = await world(t);
    await addFn(h, 'src/a/x.ts', 'dup');
    await addFn(h, 'src/b/x.ts', 'dup');
    const query = h.query();
    const paths = (e: Envelope): string[] => dataOf(e).results.map((result) => result.path);

    assert.deepEqual(paths(await query.ask(findRequest(h, { name: 'dup' }))), ['src/a/x.ts', 'src/b/x.ts']);
    assert.deepEqual(paths(await query.ask(findRequest(h, { name: 'dup', cwd: path.join(h.dir, 'src', 'b') }))), ['src/b/x.ts', 'src/a/x.ts']);
    assert.deepEqual(paths(await query.ask(findRequest(h, { name: 'dup', cwd: path.join(h.dir, '..', 'elsewhere') }))), ['src/a/x.ts', 'src/b/x.ts']);
  });

  it('returns two results with the same position and different handles, in a stable order, never merged', async (t) => {
    const h = await world(t);
    await h.addFile('src/twin.ts', 'export function dup2() {}\n', [
      { name: 'dup2', kind: 'function', line: 0, col: 16, exported: true },
      { name: 'dup2', kind: 'interface', line: 0, col: 16, exported: true },
    ]);
    const query = h.query();

    const first = await query.ask(findRequest(h, { name: 'dup2' }));

    assert.equal(dataOf(first).results.length, 2);
    const handles = (first.citations ?? []).map((citation) => citation.debug);
    assert.equal(new Set(handles).size, 2, 'two different handles');
    assert.deepEqual(handles, [...handles].sort(), 'ordered by handle at the final tie-break');
    for (let run = 0; run < 5; run += 1) {
      const again = await query.ask(findRequest(h, { name: 'dup2' }));
      assert.deepEqual(
        (again.citations ?? []).map((citation) => citation.debug),
        handles,
      );
    }
  });
});

describe('code_find budget, ceiling, limit and pages', () => {
  const NAMES = Array.from({ length: 12 }, (_, index) => `item${String(index + 1).padStart(2, '0')}`);

  async function twelveItems(t: TestContext): Promise<Harness> {
    const h = await world(t);
    for (const name of NAMES) await addFn(h, `src/items/${name}.ts`, name);
    return h;
  }

  /** Follow `more` until it is absent; returns every page. */
  async function pagesOf(h: Harness, args: Record<string, unknown>, config?: Partial<QueryConfig>): Promise<Envelope[]> {
    const query = h.query(config === undefined ? {} : { config });
    const pages: Envelope[] = [];
    let more: string | undefined;
    do {
      const page = await query.ask(findRequest(h, { ...args, ...(more === undefined ? {} : { more }) }));
      assert.equal(page.ok, true, JSON.stringify(page.diagnostics));
      pages.push(page);
      more = page.more;
      assert.ok(pages.length <= 40, 'paging must end');
    } while (more !== undefined);
    return pages;
  }

  it('pages without repeating or skipping an item, and the pages join into the unpaged order', async (t) => {
    const h = await twelveItems(t);
    const unpaged = await h.query().ask(findRequest(h, { name: 'item' }));
    assert.deepEqual(namesOf(unpaged), NAMES);
    assert.equal('truncated' in unpaged, false);
    assert.equal('more' in unpaged, false);

    const pages = await pagesOf(h, { name: 'item', limit: 5 });

    assert.deepEqual(
      pages.map((page) => namesOf(page).length),
      [5, 5, 2],
    );
    assert.deepEqual(pages.flatMap(namesOf), NAMES);
    assert.deepEqual(
      pages.map((page) => page.truncated),
      [true, true, undefined],
    );
    assert.equal(pages[2]?.more, undefined);
  });

  it('cuts to the budget with whole items, a truncated flag and a cursor', async (t) => {
    const h = await twelveItems(t);

    const pages = await pagesOf(h, { name: 'item', budget_tokens: 700 });

    assert.ok(pages.length > 1, 'twelve items do not fit in one 700 token page');
    assert.deepEqual(pages.flatMap(namesOf), NAMES);
    for (const page of pages) {
      assert.ok(estimateTokens(page) <= 700, `page estimate ${String(estimateTokens(page))} is within the budget`);
      assert.equal(estimateTokens(page), Math.ceil(JSON.stringify(page).length / 4));
      const refs = new Set((page.untrusted_text?.entries ?? []).map((entry) => entry.ref));
      const cited = (page.citations ?? []).map((citation) => citation.text_ref);
      assert.equal(cited.length, namesOf(page).length, 'every result has its citation');
      assert.ok(
        cited.every((ref) => ref !== undefined && refs.has(ref)),
        'every citation has its entry',
      );
    }
    assert.equal(pages[0]?.truncated, true);
    assert.equal(typeof pages[0]?.more, 'string');
  });

  it('returns the one item that alone exceeds the budget while it is under the hard ceiling', async (t) => {
    const h = await twelveItems(t);

    const envelope = await h.query().ask(findRequest(h, { name: 'item', budget_tokens: 50 }));

    assert.equal(namesOf(envelope).length, 1);
    assert.ok(estimateTokens(envelope) > 50);
    assert.ok(estimateTokens(envelope) <= 8000);
    assert.equal(envelope.truncated, true);
    assert.equal(typeof envelope.more, 'string');
  });

  it('applies the hard ceiling whatever budget was asked for', async (t) => {
    const h = await twelveItems(t);

    const asked = await h.query({ config: { hardCeilingTokens: 600 } }).ask(findRequest(h, { name: 'item', budget_tokens: 100000 }));
    const byDefault = await h
      .query({ config: { hardCeilingTokens: 600, defaultBudgetTokens: 100000 } })
      .ask(findRequest(h, { name: 'item' }));

    for (const envelope of [asked, byDefault]) {
      assert.ok(estimateTokens(envelope) <= 600, String(estimateTokens(envelope)));
      assert.equal(envelope.truncated, true);
      assert.ok(namesOf(envelope).length < NAMES.length);
    }
  });

  it('answers a single item that cannot fit under the ceiling with a tiny output_too_large error', async (t) => {
    const h = await twelveItems(t);

    const envelope = await h.query({ config: { hardCeilingTokens: 40 } }).ask(findRequest(h, { name: 'item' }));

    assert.equal(envelope.ok, false);
    assert.equal(envelope.schema, 'gsd-atlas.error/1');
    assert.equal(envelope.diagnostics[0]?.code, 'output_too_large');
    assert.ok(estimateTokens(envelope) < 100, String(estimateTokens(envelope)));
  });

  it('clamps a limit above the maximum and uses the default limit when none is given', async (t) => {
    const h = await twelveItems(t);

    const clamped = await h.query({ config: { maxLimit: 3 } }).ask(findRequest(h, { name: 'item', limit: 100 }));
    const byDefault = await h.query({ config: { defaultLimit: 2, maxLimit: 3 } }).ask(findRequest(h, { name: 'item' }));

    assert.equal(namesOf(clamped).length, 3);
    assert.equal(clamped.truncated, true);
    assert.equal(namesOf(byDefault).length, 2);
    assert.equal(byDefault.truncated, true);
  });

  it('continues past a moved watermark and says so with degraded watermark_moved', async (t) => {
    const h = await twelveItems(t);
    const query = h.query();
    const first = await query.ask(findRequest(h, { name: 'item', limit: 5 }));
    assert.equal('degraded' in first, false);
    await addFn(h, 'src/other/zzz.ts', 'zzz');

    const second = await query.ask(findRequest(h, { name: 'item', limit: 5, more: first.more }));

    assert.equal(second.ok, true);
    assert.deepEqual(namesOf(second), NAMES.slice(5, 10));
    assert.ok(second.degraded?.includes('watermark_moved'), JSON.stringify(second.degraded));
  });

  it('rejects a malformed, oversized or foreign cursor with a short bad_cursor error', async (t) => {
    const h = await twelveItems(t);
    const query = h.query();
    const first = await query.ask(findRequest(h, { name: 'item', limit: 5 }));
    assert.equal(typeof first.more, 'string');

    for (const [label, args] of [
      ['not base64url', { name: 'item', more: 'not base64url!!' }],
      ['valid base64url, wrong content', { name: 'item', more: Buffer.from('{"x":1}').toString('base64url') }],
      ['oversized', { name: 'item', more: 'A'.repeat(1025) }],
      ['issued for another name', { name: 'itemx', more: first.more }],
    ] as const) {
      const envelope = await query.ask(findRequest(h, args));
      assert.equal(envelope.ok, false, label);
      assert.equal(envelope.schema, 'gsd-atlas.error/1', label);
      assert.equal(envelope.diagnostics[0]?.code, 'bad_cursor', label);
      assert.ok((envelope.diagnostics[0]?.message.length ?? 999) < 120, label);
    }
  });
});
