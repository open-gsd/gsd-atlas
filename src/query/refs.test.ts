import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Resolver } from '../fact-store/index.ts';
import type { Envelope, RefKind, Request } from '../facts/index.ts';
import { estimateTokens } from './budget.ts';
import { SHAPE_RELATIONS, addCaller, addShapes, defineFn, nameOf, relationResolver, shapeAt, where } from './fixtures.test.ts';
import { createHarness } from './harness.test.ts';
import type { Harness, HarnessOptions } from './harness.test.ts';
import type { Query, QueryConfig } from './index.ts';

async function world(t: TestContext, options?: HarnessOptions): Promise<Harness> {
  const harness = await createHarness(options);
  t.after(() => harness.cleanup());
  return harness;
}

interface RefResult {
  readonly target: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly kind: string | null;
  readonly enclosing: string | null;
  readonly tier: string;
  readonly confidence: string;
  readonly ambiguous: boolean;
  readonly candidates: number;
  readonly citation: string;
}

interface TargetInfo {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly handle: string;
}

interface RefsData {
  readonly targets: readonly TargetInfo[];
  readonly results: readonly RefResult[];
}

const dataOf = (envelope: Envelope): RefsData => envelope.data as RefsData;

function refsRequest(h: Harness, args: Record<string, unknown>): Request {
  return { protocol: 1, kind: 'code_refs', args: { repo: h.dir, ...args }, worktree: h.dir };
}

const NONCE = /^[0-9a-f]{32}$/;

describe('code_refs tracer: references of a definition, ranked and cited through the shared paging mechanism', () => {
  it('tracer: returns the imported call site of parse as an INFERRED grammar reference and leaves out the unimported same-name call', async (t) => {
    const h = await world(t);
    await defineFn(h, 'a.ts', 'parse');
    const bText = await addCaller(h, 'b.ts', './a', 'parse', 'load');
    // c.ts calls a function that is also called parse but imports nothing: it is not a reference to a.ts.
    const cText = '// c.ts\nexport function other() { return parse(2); }\n';
    const cAt = nameOf(cText, 'other');
    const cCall = where(cText, 'parse(2)');
    await h.addFileWith('c.ts', cText, {
      symbols: [{ name: 'other', kind: 'function', line: cAt.line, col: cAt.col, exported: true }],
      refs: [{ name: 'parse', line: cCall.line, col: cCall.col, kind: 'call', enclosing: 0 }],
    });

    const envelope = await h.query().ask(refsRequest(h, { name: 'parse' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(envelope.schema, 'gsd-atlas.code-refs/1');
    const { targets, results } = dataOf(envelope);
    assert.equal(targets.length, 1);
    assert.equal(targets[0]?.path, 'a.ts');
    assert.equal(targets[0]?.name, 'parse');
    assert.equal(results.length, 1, 'only the b.ts site is in scope');
    const [result] = results;
    assert.equal(result?.path, 'b.ts');
    assert.equal(result?.kind, 'call');
    assert.equal(result?.tier, 'grammar');
    assert.equal(result?.confidence, 'INFERRED', 'a name-matched reference is INFERRED, never EXTRACTED');
    assert.equal(result?.enclosing, 'load');
    assert.equal(result?.ambiguous, false);
    assert.equal(result?.candidates, 1);
    assert.equal(result?.target, targets[0]?.handle);
    const call = where(bText, 'parse(1)');
    assert.equal(result?.line, call.line + 1);
    assert.equal(result?.col, call.col + 1);

    const citation = envelope.citations?.find((candidate) => candidate.id === result?.citation);
    assert.ok(citation !== undefined, 'the result names its citation');
    assert.equal(citation.path, 'b.ts');
    assert.equal(citation.confidence, 'INFERRED');
    assert.equal(citation.text_ref, 'ut1');
    const untrusted = envelope.untrusted_text;
    assert.ok(untrusted !== undefined);
    assert.match(untrusted.nonce, NONCE);
    assert.deepEqual(untrusted.entries, [
      { ref: 'ut1', text: `BEGIN-UNTRUSTED-${untrusted.nonce}\nexport function load() { return parse(1); }\nEND-UNTRUSTED-${untrusted.nonce}` },
    ]);
    assert.equal('truncated' in envelope, false);
    assert.equal('more' in envelope, false);
  });

  it('no definitions: a name nothing defines is an ok envelope with empty targets and results and one static hint', async (t) => {
    const h = await world(t);
    await defineFn(h, 'a.ts', 'parse');

    const envelope = await h.query().ask(refsRequest(h, { name: 'nothingCalledThis' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(dataOf(envelope).targets, []);
    assert.deepEqual(dataOf(envelope).results, []);
    assert.equal(envelope.hints?.length, 1);
    assert.equal('citations' in envelope, false);
    assert.equal('untrusted_text' in envelope, false);
  });

  it('a target with no references is an ok envelope with the target and an empty list', async (t) => {
    const h = await world(t);
    await defineFn(h, 'a.ts', 'lonely');

    const envelope = await h.query().ask(refsRequest(h, { name: 'lonely' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(dataOf(envelope).targets.length, 1);
    assert.deepEqual(dataOf(envelope).results, []);
    assert.equal(envelope.hints?.length, 1);
  });

  it('path narrows the targets to definitions in that file and kind filters by symbol kind', async (t) => {
    const h = await world(t);
    await defineFn(h, 'p.ts', 'dup');
    await defineFn(h, 'q.ts', 'dup', { kind: 'class' });
    const query = h.query();

    const both = await query.ask(refsRequest(h, { name: 'dup' }));
    const byPath = await query.ask(refsRequest(h, { name: 'dup', path: 'q.ts' }));
    const byKind = await query.ask(refsRequest(h, { name: 'dup', kind: 'function' }));

    assert.equal(both.ok, true, JSON.stringify(both.diagnostics));
    assert.deepEqual(dataOf(both).targets.map((target) => target.path).sort(), ['p.ts', 'q.ts']);
    assert.deepEqual(dataOf(byPath).targets.map((target) => target.path), ['q.ts']);
    assert.deepEqual(dataOf(byKind).targets.map((target) => target.path), ['p.ts']);
  });
});

describe('code_refs ambiguity: a site is never guessed into one target', () => {
  it('ambiguous: one site that could match two definitions appears under both, each with ambiguous true and candidates 2', async (t) => {
    const h = await world(t);
    await defineFn(h, 'p.ts', 'x');
    await defineFn(h, 'q.ts', 'x');
    const content = "// r.ts\nimport { x } from './p';\nimport { x } from './q';\nexport function run() { return x(); }\n";
    const decl = nameOf(content, 'run');
    const call = where(content, 'x()');
    await h.addFileWith('r.ts', content, {
      symbols: [{ name: 'run', kind: 'function', line: decl.line, col: decl.col, exported: true }],
      refs: [{ name: 'x', line: call.line, col: call.col, kind: 'call', enclosing: 0 }],
      imports: [
        { path: './p', line: 1, style: 'es', bindings: [{ imported: 'x', local: 'x' }] },
        { path: './q', line: 2, style: 'es', bindings: [{ imported: 'x', local: 'x' }] },
      ],
    });

    const envelope = await h.query().ask(refsRequest(h, { name: 'x' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    const { targets, results } = dataOf(envelope);
    assert.equal(targets.length, 2);
    assert.equal(results.length, 2, 'the site is listed once per target, never merged');
    for (const result of results) {
      assert.equal(result.ambiguous, true);
      assert.equal(result.candidates, 2);
      assert.equal(result.confidence, 'INFERRED');
      assert.equal(result.path, 'r.ts');
    }
    assert.equal(new Set(results.map((result) => result.target)).size, 2, 'one entry under each target');
    assert.deepEqual(
      new Set(results.map((result) => result.target)),
      new Set(targets.map((target) => target.handle)),
    );
  });
});

describe('code_refs precise edges and the resolver bound', () => {
  const scripted: Resolver = async function* (sites) {
    for (const site of sites) {
      if (site.path === 'z.ts' && site.name === 'parse') {
        yield {
          site,
          target: { repo: 'toy', path: 'a.ts', qualifiedName: 'parse', kind: 'function' },
          confidence: 'EXTRACTED',
          resolver: 'scripted',
        };
      }
    }
  };

  it('precise: a resolved site has tier precise and confidence EXTRACTED and ranks before grammar sites', async (t) => {
    const h = await world(t, { resolver: scripted });
    await defineFn(h, 'a.ts', 'parse');
    await addCaller(h, 'b.ts', './a', 'parse', 'viaB');
    await addCaller(h, 'z.ts', './a', 'parse', 'viaZ');

    const envelope = await h.query().ask(refsRequest(h, { name: 'parse' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal('degraded' in envelope, false, JSON.stringify(envelope.degraded));
    const { results } = dataOf(envelope);
    assert.deepEqual(
      results.map((result) => [result.path, result.tier, result.confidence]),
      [
        ['z.ts', 'precise', 'EXTRACTED'],
        ['b.ts', 'grammar', 'INFERRED'],
      ],
    );
    const preciseCitation = envelope.citations?.find((citation) => citation.id === results[0]?.citation);
    assert.equal(preciseCitation?.confidence, 'EXTRACTED');
  });

  it('resolver_timeout: a resolver slower than the approved 1500 ms degrades the answer and still lists the grammar references', async (t) => {
    const hanging: Resolver = async function* () {
      await new Promise<never>(() => undefined);
    };
    const h = await world(t, { resolver: hanging });
    await defineFn(h, 'a.ts', 'parse');
    await addCaller(h, 'b.ts', './a', 'parse', 'viaB');
    let settled = false;
    const pending = h
      .query()
      .ask(refsRequest(h, { name: 'parse' }))
      .finally(() => {
        settled = true;
      });
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));

    await h.clock.advance(1499);
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the bound is 1500 ms, not less');
    await h.clock.advance(1);
    const envelope = await pending;

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.ok(envelope.degraded?.includes('resolver_timeout'), JSON.stringify(envelope.degraded));
    assert.deepEqual(
      dataOf(envelope).results.map((result) => [result.path, result.tier]),
      [['b.ts', 'grammar']],
    );
  });
});

describe('code_refs ranking', () => {
  it('orders call before new, type, heritage, read and member inside one file, then by line', async (t) => {
    const h = await world(t);
    const content =
      '// k.ts\nexport function target() {}\nmember(target);\nread(target);\nheritage(target);\ntype(target);\nnew1(target);\ncall(target);\n';
    const sym = nameOf(content, 'target');
    const site = (needle: string, kind: RefKind): { name: string; line: number; col: number; kind: RefKind } => ({
      name: 'target',
      line: where(content, needle).line,
      col: where(content, 'target', content.indexOf(needle)).col,
      kind,
    });
    await h.addFileWith('k.ts', content, {
      symbols: [{ name: 'target', kind: 'function', line: sym.line, col: sym.col, exported: true }],
      refs: [
        site('member(', 'member'),
        site('read(', 'read'),
        site('heritage(', 'heritage'),
        site('type(', 'type'),
        site('new1(', 'new'),
        site('call(', 'call'),
      ],
    });

    const envelope = await h.query().ask(refsRequest(h, { name: 'target' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(
      dataOf(envelope).results.map((result) => result.kind),
      ['call', 'new', 'type', 'heritage', 'read', 'member'],
    );
  });

  it('ranks the directory nearer to the cwd hint first, then path', async (t) => {
    const h = await world(t);
    await defineFn(h, 'lib/dup.ts', 'dup');
    await addCaller(h, 'src/a/use.ts', '../../lib/dup', 'dup', 'useA');
    await addCaller(h, 'src/b/use.ts', '../../lib/dup', 'dup', 'useB');
    const query = h.query();
    const paths = (e: Envelope): string[] => dataOf(e).results.map((result) => result.path);

    assert.deepEqual(paths(await query.ask(refsRequest(h, { name: 'dup' }))), ['src/a/use.ts', 'src/b/use.ts']);
    assert.deepEqual(paths(await query.ask(refsRequest(h, { name: 'dup', cwd: 'src/b' }))), ['src/b/use.ts', 'src/a/use.ts']);
  });

  it('total order: the same index built in a different order answers byte for byte the same, 100 times over', async (t) => {
    const names = Array.from({ length: 8 }, (_, index) => `use${String(index)}`);
    const build = async (order: readonly string[]): Promise<Harness> => {
      const h = await world(t);
      await defineFn(h, 'lib/core.ts', 'core');
      for (const name of order) await addCaller(h, `src/${name}.ts`, '../lib/core', 'core', name);
      return h;
    };
    const serialize = (envelope: Envelope, keepCursor = true): string => {
      const nonce = envelope.untrusted_text?.nonce;
      // A cursor binds to its worktree path, which differs between the two repositories below.
      const text = JSON.stringify(keepCursor ? envelope : { ...envelope, more: undefined });
      return nonce === undefined ? text : text.replaceAll(nonce, '<nonce>');
    };
    const forward = await build(names);
    const backward = await build([...names].reverse());
    const request = (h: Harness): Request => refsRequest(h, { name: 'core', limit: 5, budget_tokens: 900 });
    const baseline = serialize(await forward.query().ask(request(forward)));

    assert.ok(baseline.includes('<nonce>'));
    assert.equal(
      serialize(await backward.query().ask(request(backward)), false),
      serialize(await forward.query().ask(request(forward)), false),
      'insertion order does not matter',
    );
    const query = forward.query();
    for (let run = 0; run < 100; run += 1) {
      assert.equal(serialize(await query.ask(request(forward))), baseline, `run ${String(run)}`);
    }
  });
});

describe('code_refs paging through the shared mechanism', () => {
  const USERS = Array.from({ length: 12 }, (_, index) => `use${String(index + 1).padStart(2, '0')}`);

  async function twelveUsers(t: TestContext): Promise<Harness> {
    const h = await world(t);
    await defineFn(h, 'lib/core.ts', 'core');
    for (const name of USERS) await addCaller(h, `src/${name}.ts`, '../lib/core', 'core', name);
    return h;
  }

  async function pagesOf(h: Harness, args: Record<string, unknown>, config?: Partial<QueryConfig>): Promise<Envelope[]> {
    const query: Query = h.query(config === undefined ? {} : { config });
    const pages: Envelope[] = [];
    let more: string | undefined;
    do {
      const page = await query.ask(refsRequest(h, { ...args, ...(more === undefined ? {} : { more }) }));
      assert.equal(page.ok, true, JSON.stringify(page.diagnostics));
      pages.push(page);
      more = page.more;
      assert.ok(pages.length <= 40, 'paging must end');
    } while (more !== undefined);
    return pages;
  }

  const pathsOf = (envelope: Envelope): string[] => dataOf(envelope).results.map((result) => result.path);

  it('pages without repeating or skipping a reference, and the pages join into the unpaged order', async (t) => {
    const h = await twelveUsers(t);
    const unpaged = await h.query().ask(refsRequest(h, { name: 'core' }));
    assert.equal(pathsOf(unpaged).length, 12);
    assert.equal('more' in unpaged, false);

    const pages = await pagesOf(h, { name: 'core', limit: 5 });

    assert.deepEqual(pages.map((page) => pathsOf(page).length), [5, 5, 2]);
    assert.deepEqual(pages.flatMap(pathsOf), pathsOf(unpaged));
    assert.deepEqual(pages.map((page) => page.truncated), [true, true, undefined]);
  });

  it('cuts to the budget with whole references, a truncated flag and a cursor', async (t) => {
    const h = await twelveUsers(t);
    const unpaged = await h.query().ask(refsRequest(h, { name: 'core' }));

    const pages = await pagesOf(h, { name: 'core', budget_tokens: 1200 });

    assert.ok(pages.length > 1, 'twelve references do not fit in one 1200 token page');
    assert.deepEqual(pages.flatMap(pathsOf), pathsOf(unpaged));
    for (const page of pages) assert.ok(estimateTokens(page) <= 1200, `page estimate ${String(estimateTokens(page))}`);
    assert.equal(pages[0]?.truncated, true);
    assert.equal(typeof pages[0]?.more, 'string');
  });

  it('cursor from another tool: a code_find cursor presented to code_refs is refused with bad_cursor', async (t) => {
    const h = await world(t);
    for (const file of ['p.ts', 'q.ts', 'r.ts']) await defineFn(h, file, 'parse');
    const query = h.query();
    const found = await query.ask({ protocol: 1, kind: 'code_find', args: { repo: h.dir, name: 'parse', limit: 1 }, worktree: h.dir });
    assert.equal(typeof found.more, 'string');

    const envelope = await query.ask(refsRequest(h, { name: 'parse', more: found.more }));

    assert.equal(envelope.ok, false);
    assert.equal(envelope.schema, 'gsd-atlas.error/1');
    assert.equal(envelope.diagnostics[0]?.code, 'bad_cursor');
  });

  it('continues past a moved watermark and says so with degraded watermark_moved', async (t) => {
    const h = await twelveUsers(t);
    const query = h.query();
    const first = await query.ask(refsRequest(h, { name: 'core', limit: 5 }));
    await defineFn(h, 'src/elsewhere.ts', 'unrelated');

    const second = await query.ask(refsRequest(h, { name: 'core', limit: 5, more: first.more }));

    assert.equal(second.ok, true, JSON.stringify(second.diagnostics));
    assert.ok(second.degraded?.includes('watermark_moved'), JSON.stringify(second.degraded));
    assert.equal(pathsOf(second).length, 5);
  });
});

describe('cross-tool determinism: the four code tools share one envelope discipline', () => {
  const REQUESTS: readonly (readonly [string, (h: Harness) => Request])[] = [
    ['code_find', (h) => ({ protocol: 1, kind: 'code_find', args: { repo: h.dir, name: 'parse' }, worktree: h.dir })],
    ['code_refs', (h) => ({ protocol: 1, kind: 'code_refs', args: { repo: h.dir, name: 'parse' }, worktree: h.dir })],
    ['code_context', (h) => ({ protocol: 1, kind: 'code_context', args: { repo: h.dir, name: 'parse' }, worktree: h.dir })],
    ['code_impact', (h) => ({ protocol: 1, kind: 'code_impact', args: { repo: h.dir, name: 'parse', depth: 2 }, worktree: h.dir })],
  ];

  async function example(t: TestContext): Promise<Harness> {
    const h = await world(t);
    await defineFn(h, 'a.ts', 'parse');
    await addCaller(h, 'b.ts', './a', 'parse', 'load');
    await addCaller(h, 'c.ts', './b', 'load', 'main');
    return h;
  }

  const masked = (envelope: Envelope): string => {
    const nonce = envelope.untrusted_text?.nonce;
    const text = JSON.stringify(envelope);
    return nonce === undefined ? text : text.replaceAll(nonce, '<nonce>');
  };

  for (const [tool, build] of REQUESTS) {
    it(`${tool}: 100 identical requests are byte-identical once the nonce is masked, and every response carries schema, watermark and fenced text`, async (t) => {
      const h = await example(t);
      const query = h.query();
      const first = await query.ask(build(h));

      assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
      assert.match(first.schema, /^gsd-atlas\.code-[a-z]+\/1$/);
      assert.ok(first.watermark !== undefined, 'a watermark');
      const untrusted = first.untrusted_text;
      assert.ok(untrusted !== undefined, 'fenced text');
      assert.match(untrusted.nonce, NONCE);
      for (const entry of untrusted.entries) {
        assert.ok(entry.text.startsWith(`BEGIN-UNTRUSTED-${untrusted.nonce}\n`), 'the opening fence');
        assert.ok(entry.text.endsWith(`\nEND-UNTRUSTED-${untrusted.nonce}`), 'the closing fence');
      }
      const baseline = masked(first);
      assert.ok(baseline.includes('<nonce>'));
      for (let run = 0; run < 100; run += 1) {
        assert.equal(masked(await query.ask(build(h))), baseline, `run ${String(run)}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// Plan 03-25: extends, implements and overrides labels in code_refs.
// ---------------------------------------------------------------------------------------------------------

interface LabelledResult extends RefResult {
  readonly edge?: string;
}

const labelled = (envelope: Envelope): LabelledResult[] => (dataOf(envelope).results as readonly LabelledResult[]).slice();

describe('code_refs relations: the edge a precise item names', () => {
  it('heritage site carries extends: the sites that name Base in a class heritage clause are precise extends items', async (t) => {
    const { resolver } = relationResolver(SHAPE_RELATIONS);
    const h = await world(t, { resolver });
    await addShapes(h);

    const envelope = await h.query().ask(refsRequest(h, { name: 'Base', kind: 'class' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    const results = labelled(envelope);
    assert.deepEqual(
      results.map((result) => [result.path, result.kind, result.edge, result.tier, result.confidence, result.enclosing]),
      [
        ['box.ts', 'heritage', 'extends', 'precise', 'EXTRACTED', 'Box'],
        ['sub.ts', 'heritage', 'extends', 'precise', 'EXTRACTED', 'Sub'],
      ],
    );
    const subItem = results.find((result) => result.path === 'sub.ts');
    const line = shapeAt('sub.ts', 'extends Base', 'extends '.length);
    assert.equal(subItem?.line, line.line + 1);
    assert.equal(subItem?.col, line.col + 1);
    const citation = envelope.citations?.find((candidate) => candidate.id === subItem?.citation);
    assert.equal(citation?.confidence, 'EXTRACTED');
    assert.equal(envelope.degraded, undefined);
  });

  it('heritage site carries implements: a class that implements an interface and an interface that extends it', async (t) => {
    const { resolver } = relationResolver(SHAPE_RELATIONS);
    const h = await world(t, { resolver });
    await addShapes(h);

    const envelope = await h.query().ask(refsRequest(h, { name: 'Shape', kind: 'interface' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(
      labelled(envelope).map((result) => [result.path, result.edge, result.tier, result.enclosing]),
      [
        ['base.ts', 'implements', 'precise', 'Base'],
        ['square.ts', 'extends', 'precise', 'Square'],
      ],
    );
  });

  it('overriding method listed: the methods of subclasses that override Base.area appear as overrides items cited at their name', async (t) => {
    const { resolver } = relationResolver(SHAPE_RELATIONS);
    const h = await world(t, { resolver });
    await addShapes(h);

    const envelope = await h.query().ask(refsRequest(h, { name: 'area', path: 'base.ts', kind: 'method' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    const { targets } = dataOf(envelope);
    assert.deepEqual(targets.map((target) => [target.path, target.kind]), [['base.ts', 'method']]);
    const results = labelled(envelope);
    assert.equal(results.length, 1, JSON.stringify(results));
    const [item] = results;
    assert.equal(item?.edge, 'overrides');
    assert.equal(item?.path, 'sub.ts');
    assert.equal(item?.tier, 'precise');
    assert.equal(item?.confidence, 'EXTRACTED');
    assert.equal(item?.enclosing, 'Sub.area');
    assert.equal(item?.target, targets[0]?.handle);
    const name = shapeAt('sub.ts', 'area');
    assert.equal(item?.line, name.line + 1);
    assert.equal(item?.col, name.col + 1);
    const citation = envelope.citations?.find((candidate) => candidate.id === item?.citation);
    assert.equal(citation?.path, 'sub.ts');
    const text = envelope.untrusted_text?.entries.find((entry) => entry.ref === citation?.text_ref)?.text ?? '';
    assert.ok(text.includes('area(): number { return 1; }'), text);
  });

  it('a class method that implements an interface method is not listed as an override of it', async (t) => {
    const { resolver } = relationResolver(SHAPE_RELATIONS);
    const h = await world(t, { resolver });
    await addShapes(h);

    const envelope = await h.query().ask(refsRequest(h, { name: 'area', path: 'shape.ts', kind: 'method' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(labelled(envelope).filter((result) => result.edge === 'overrides'), []);
  });

  it('library base is absent: a class that extends a library class has no relation, and the library name has no definition', async (t) => {
    const { resolver } = relationResolver(SHAPE_RELATIONS);
    const h = await world(t, { resolver });
    await addShapes(h);
    const query = h.query();

    const base = await query.ask(refsRequest(h, { name: 'Base', kind: 'class' }));
    const error = await query.ask(refsRequest(h, { name: 'Error' }));
    const boom = await query.ask(refsRequest(h, { name: 'Boom' }));

    assert.equal(labelled(base).some((result) => result.path === 'boom.ts'), false);
    assert.deepEqual(dataOf(error).targets, [], 'nothing in the repository defines Error');
    assert.deepEqual(labelled(boom), [], 'Boom is extended by nothing');
  });

  it('name-matched item has no edge label: a site no relation names keeps the grammar tier and carries no edge key', async (t) => {
    // The compiler knows Sub only; Box extends Base in the text, but the relation list does not name it.
    const { resolver } = relationResolver(SHAPE_RELATIONS.filter((relation) => relation.from.path === 'sub.ts'));
    const h = await world(t, { resolver });
    await addShapes(h);
    await defineFn(h, 'lib.ts', 'work');
    await addCaller(h, 'use.ts', './lib', 'work', 'useWork');

    const heritage = labelled(await h.query().ask(refsRequest(h, { name: 'Base', kind: 'class' })));
    const calls = labelled(await h.query().ask(refsRequest(h, { name: 'work' })));

    const box = heritage.find((result) => result.path === 'box.ts');
    assert.equal(box?.tier, 'grammar');
    assert.equal(box?.confidence, 'INFERRED');
    assert.equal('edge' in (box ?? {}), false, 'a name-matched item is never labelled extends');
    assert.equal(heritage.find((result) => result.path === 'sub.ts')?.edge, 'extends');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tier, 'grammar');
    assert.equal('edge' in (calls[0] ?? {}), false);
  });

  it('a precise call site is labelled calls and a precise read site references', async (t) => {
    const precise: Resolver = async function* (sites) {
      for (const site of sites) {
        if ((site.path === 'z.ts' || site.path === 'y.ts') && site.name === 'parse') {
          yield { site, target: { repo: 'toy', path: 'a.ts', qualifiedName: 'parse', kind: 'function' }, confidence: 'EXTRACTED', resolver: 'scripted' };
        }
      }
    };
    const h = await world(t, { resolver: precise });
    await defineFn(h, 'a.ts', 'parse');
    await addCaller(h, 'z.ts', './a', 'parse', 'viaZ');
    const content = '// y.ts\nimport { parse } from "./a";\nexport const keep = parse;\n';
    const read = where(content, 'parse;');
    await h.addFileWith('y.ts', content, {
      symbols: [{ name: 'keep', kind: 'variable', line: 2, col: 13, exported: true }],
      refs: [{ name: 'parse', line: read.line, col: read.col, kind: 'read', enclosing: 0 }],
      imports: [{ path: './a', line: 1, style: 'es', bindings: [{ imported: 'parse', local: 'parse' }] }],
    });

    const results = labelled(await h.query().ask(refsRequest(h, { name: 'parse' })));

    assert.deepEqual(
      results.map((result) => [result.path, result.tier, result.edge]),
      [
        ['z.ts', 'precise', 'calls'],
        ['y.ts', 'precise', 'references'],
      ],
    );
  });
});

describe('code_refs relations: degradation', () => {
  it('relations failure degrades: the heritage items stay grammar-tier and the answer says resolver_failed', async (t) => {
    const { resolver } = relationResolver(SHAPE_RELATIONS, {
      before: async () => {
        throw new Error('the compiler exploded');
      },
    });
    const h = await world(t, { resolver });
    await addShapes(h);

    const envelope = await h.query().ask(refsRequest(h, { name: 'Base', kind: 'class' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(envelope.degraded, ['resolver_failed']);
    assert.deepEqual(
      labelled(envelope).map((result) => [result.path, result.tier, result.edge]),
      [
        ['box.ts', 'grammar', undefined],
        ['sub.ts', 'grammar', undefined],
      ],
    );
  });

  it('a resolver without relations leaves the heritage items grammar-tier and adds no degraded code', async (t) => {
    const plain: Resolver = async function* () {
      // edges only: this resolver has no relations method
    };
    const h = await world(t, { resolver: plain });
    await addShapes(h);

    const envelope = await h.query().ask(refsRequest(h, { name: 'Base', kind: 'class' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal('degraded' in envelope, false, JSON.stringify(envelope.degraded));
    assert.deepEqual(
      labelled(envelope).map((result) => [result.path, result.tier]),
      [
        ['box.ts', 'grammar'],
        ['sub.ts', 'grammar'],
      ],
    );
    assert.ok(labelled(envelope).every((result) => !('edge' in result)));
  });
});
