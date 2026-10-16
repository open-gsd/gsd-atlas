import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Resolver } from '../fact-store/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import { addCaller, defineFn, nameOf, where } from './fixtures.test.ts';
import { createHarness } from './harness.test.ts';
import type { Harness, HarnessOptions } from './harness.test.ts';

async function world(t: TestContext, options?: HarnessOptions): Promise<Harness> {
  const harness = await createHarness(options);
  t.after(() => harness.cleanup());
  return harness;
}

interface ImpactItem {
  readonly hop: number;
  readonly via: string;
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly confidence: string;
  readonly chain_confidence: string;
  readonly handle: string;
  readonly from: string;
  readonly citation: string;
}

interface Seed {
  readonly name: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly handle: string;
}

interface ImpactData {
  readonly seeds: readonly Seed[];
  readonly results: readonly ImpactItem[];
}

const dataOf = (envelope: Envelope): ImpactData => envelope.data as ImpactData;

function impactRequest(h: Harness, args: Record<string, unknown>): Request {
  return { protocol: 1, kind: 'code_impact', args: { repo: h.dir, ...args }, worktree: h.dir };
}

/** The columns the golden test compares: hop, name, kind, path, via, confidence, chain confidence. */
const rowOf = (item: ImpactItem): [number, string, string, string, string, string, string] => [
  item.hop,
  item.name,
  item.kind,
  item.path,
  item.via,
  item.confidence,
  item.chain_confidence,
];

/** The worked example of the query-and-policy ADR amendment: a defines parse; b imports it and load calls it; c imports load and main calls it. */
async function adrExample(h: Harness): Promise<void> {
  await defineFn(h, 'a.ts', 'parse');
  await addCaller(h, 'b.ts', './a', 'parse', 'load');
  await addCaller(h, 'c.ts', './b', 'load', 'main');
}

const GOLDEN: ReturnType<typeof rowOf>[] = [
  [1, 'load', 'function', 'b.ts', 'call', 'INFERRED', 'INFERRED'],
  [1, 'b.ts', 'file', 'b.ts', 'import', 'EXTRACTED', 'EXTRACTED'],
  [2, 'main', 'function', 'c.ts', 'call', 'INFERRED', 'INFERRED'],
  [2, 'c.ts', 'file', 'c.ts', 'import', 'EXTRACTED', 'EXTRACTED'],
];

describe('code_impact: how far a change to a symbol reaches', () => {
  it('ADR worked example: parse at depth 2 reaches b.load and b.ts at hop 1 and c.main and c.ts at hop 2, with per-hop and chain confidence', async (t) => {
    const h = await world(t);
    await adrExample(h);

    const envelope = await h.query().ask(impactRequest(h, { name: 'parse', depth: 2 }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.equal(envelope.schema, 'gsd-atlas.code-impact/1');
    const { seeds, results } = dataOf(envelope);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0]?.name, 'parse');
    assert.equal(seeds[0]?.path, 'a.ts');
    assert.deepEqual(results.map(rowOf), GOLDEN);
    for (const item of results) {
      assert.equal(item.from, seeds[0]?.handle, 'every result names the seed it came from');
      const cited = envelope.citations?.find((citation) => citation.id === item.citation);
      assert.ok(cited !== undefined, `${item.name} has a citation`);
      assert.equal(cited.path, item.path);
      assert.equal(cited.confidence, item.confidence);
      assert.equal(typeof item.handle, 'string');
    }
    assert.equal('truncated' in envelope, false);
  });

  it('depth 1 returns only the hop-1 items; no depth uses the approved default of 2; depth 0 returns nothing with a hint', async (t) => {
    const h = await world(t);
    await adrExample(h);
    await addCaller(h, 'd.ts', './c', 'main', 'last');
    const query = h.query();
    const rows = (e: Envelope): ReturnType<typeof rowOf>[] => dataOf(e).results.map(rowOf);

    assert.deepEqual(rows(await query.ask(impactRequest(h, { name: 'parse', depth: 1 }))), GOLDEN.slice(0, 2));
    assert.deepEqual(rows(await query.ask(impactRequest(h, { name: 'parse' }))), GOLDEN, 'the default depth stops at hop 2');
    assert.deepEqual(
      rows(await query.ask(impactRequest(h, { name: 'parse', depth: 3 }))).slice(4),
      [
        [3, 'last', 'function', 'd.ts', 'call', 'INFERRED', 'INFERRED'],
        [3, 'd.ts', 'file', 'd.ts', 'import', 'EXTRACTED', 'EXTRACTED'],
      ],
    );
    const none = await query.ask(impactRequest(h, { name: 'parse', depth: 0 }));
    assert.equal(none.ok, true, JSON.stringify(none.diagnostics));
    assert.deepEqual(dataOf(none).results, []);
    assert.equal(dataOf(none).seeds.length, 1);
    assert.equal(none.hints?.length, 1);
  });

  it('a depth above the approved maximum of 5 is clamped and the hint says so', async (t) => {
    const h = await world(t);
    await adrExample(h);
    const query = h.query();

    const clamped = await query.ask(impactRequest(h, { name: 'parse', depth: 9 }));
    const five = await query.ask(impactRequest(h, { name: 'parse', depth: 5 }));

    assert.equal(clamped.ok, true, JSON.stringify(clamped.diagnostics));
    assert.deepEqual(dataOf(clamped).results.map(rowOf), dataOf(five).results.map(rowOf));
    assert.ok(clamped.hints?.some((hint) => hint.includes('5')), JSON.stringify(clamped.hints));
    assert.equal(five.hints, undefined);
  });

  it('a module-level reference is a file item reached by reference; a heritage use inside a class names the class', async (t) => {
    const h = await world(t);
    const topLevel = '// top.ts\nexport function parse(input) {}\nparse(0);\n';
    const sym = nameOf(topLevel, 'parse');
    const site = where(topLevel, 'parse(0)');
    await h.addFileWith('top.ts', topLevel, {
      symbols: [{ name: 'parse', kind: 'function', line: sym.line, col: sym.col, exported: true }],
      refs: [{ name: 'parse', line: site.line, col: site.col, kind: 'call' }],
      exports: [{ name: 'parse', line: sym.line, col: sym.col }],
    });
    await defineFn(h, 'base.ts', 'Base', { kind: 'class' });
    const widget = "// widget.ts\nimport { Base } from './base';\nexport class Widget extends Base {}\n";
    const cls = where(widget, 'Widget');
    const use = where(widget, 'Base {}');
    await h.addFileWith('widget.ts', widget, {
      symbols: [{ name: 'Widget', kind: 'class', line: cls.line, col: cls.col, exported: true }],
      refs: [{ name: 'Base', line: use.line, col: use.col, kind: 'heritage', enclosing: 0 }],
      imports: [{ path: './base', line: 1, style: 'es', bindings: [{ imported: 'Base', local: 'Base' }] }],
    });
    const query = h.query();

    const moduleLevel = await query.ask(impactRequest(h, { name: 'parse' }));
    const heritage = await query.ask(impactRequest(h, { name: 'Base' }));

    assert.deepEqual(dataOf(moduleLevel).results.map(rowOf), [[1, 'top.ts', 'file', 'top.ts', 'reference', 'INFERRED', 'INFERRED']]);
    assert.deepEqual(dataOf(heritage).results.map(rowOf), [
      [1, 'Widget', 'class', 'widget.ts', 'reference', 'INFERRED', 'INFERRED'],
      [1, 'widget.ts', 'file', 'widget.ts', 'import', 'EXTRACTED', 'EXTRACTED'],
    ]);
  });

  it('terminates on a cycle and lists each symbol once at its smallest hop', async (t) => {
    const h = await world(t);
    const text = '// cycle.ts\nexport function fnA() { return fnB(); }\nexport function fnB() { return fnA(); }\n';
    const a = nameOf(text, 'fnA');
    const b = nameOf(text, 'fnB');
    await h.addFileWith('cycle.ts', text, {
      symbols: [
        { name: 'fnA', kind: 'function', line: a.line, col: a.col, exported: true },
        { name: 'fnB', kind: 'function', line: b.line, col: b.col, exported: true },
      ],
      refs: [
        { name: 'fnB', line: a.line, col: where(text, 'fnB()').col, kind: 'call', enclosing: 0 },
        { name: 'fnA', line: b.line, col: where(text, 'fnA();').col, kind: 'call', enclosing: 1 },
      ],
    });

    const envelope = await h.query().ask(impactRequest(h, { name: 'fnA', depth: 5 }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(dataOf(envelope).results.map(rowOf), [[1, 'fnB', 'function', 'cycle.ts', 'call', 'INFERRED', 'INFERRED']]);
  });

  it('a hop larger than the per-hop row cap is cut to the cap, marked truncated, and the hint names the hop', async (t) => {
    const h = await world(t);
    const names = Array.from({ length: 10 }, (_, index) => `call${String(index).padStart(2, '0')}`);
    const lines = ['// wide.ts', 'export function core() {}', ...names.map((name) => `export function ${name}() { core(); }`), ''];
    const text = lines.join('\n');
    const core = nameOf(text, 'core');
    await h.addFileWith('wide.ts', text, {
      symbols: [
        { name: 'core', kind: 'function', line: core.line, col: core.col, exported: true },
        ...names.map((name) => ({ name, kind: 'function', line: nameOf(text, name).line, col: nameOf(text, name).col, exported: true })),
      ],
      refs: names.map((name, index) => ({
        name: 'core',
        line: nameOf(text, name).line,
        col: where(text, 'core();', text.indexOf(`function ${name}(`)).col,
        kind: 'call' as const,
        enclosing: index + 1,
      })),
    });

    const envelope = await h.query({ config: { impactRowCapPerHop: 3 } }).ask(impactRequest(h, { name: 'core' }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(
      dataOf(envelope).results.map((item) => item.name),
      ['call00', 'call01', 'call02'],
    );
    assert.equal(envelope.truncated, true);
    assert.ok(envelope.hints?.some((hint) => /hop 1/i.test(hint)), JSON.stringify(envelope.hints));
  });

  it('a precise edge makes its own item and chain EXTRACTED while items reached through grammar edges downstream stay INFERRED in chain', async (t) => {
    const scripted: Resolver = async function* (sites) {
      for (const site of sites) {
        if (site.path === 'b.ts' && site.name === 'parse') {
          yield {
            site,
            target: { repo: 'toy', path: 'a.ts', qualifiedName: 'parse', kind: 'function' },
            confidence: 'EXTRACTED',
            resolver: 'scripted',
          };
        }
      }
    };
    const h = await world(t, { resolver: scripted });
    await adrExample(h);

    const envelope = await h.query().ask(impactRequest(h, { name: 'parse', depth: 2 }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    assert.deepEqual(dataOf(envelope).results.map(rowOf), [
      [1, 'load', 'function', 'b.ts', 'call', 'EXTRACTED', 'EXTRACTED'],
      [1, 'b.ts', 'file', 'b.ts', 'import', 'EXTRACTED', 'EXTRACTED'],
      [2, 'main', 'function', 'c.ts', 'call', 'INFERRED', 'INFERRED'],
      [2, 'c.ts', 'file', 'c.ts', 'import', 'EXTRACTED', 'EXTRACTED'],
    ]);
  });

  it('an unknown name and a seed nothing refers to are ok envelopes with empty lists and a hint', async (t) => {
    const h = await world(t);
    await defineFn(h, 'lonely.ts', 'lonely');
    const query = h.query();

    const unknown = await query.ask(impactRequest(h, { name: 'nothingCalledThis' }));
    const lonely = await query.ask(impactRequest(h, { name: 'lonely' }));

    assert.equal(unknown.ok, true, JSON.stringify(unknown.diagnostics));
    assert.deepEqual(dataOf(unknown).seeds, []);
    assert.deepEqual(dataOf(unknown).results, []);
    assert.equal(unknown.hints?.length, 1);
    assert.equal(lonely.ok, true, JSON.stringify(lonely.diagnostics));
    assert.equal(dataOf(lonely).seeds.length, 1);
    assert.deepEqual(dataOf(lonely).results, []);
    assert.equal(lonely.hints?.length, 1);
  });

  it('two definitions of the name are two seeds, walked separately, each result naming the seed it came from', async (t) => {
    const h = await world(t);
    await defineFn(h, 'p.ts', 'dup');
    await defineFn(h, 'q.ts', 'dup');
    await addCaller(h, 'r.ts', './p', 'dup', 'fromP');
    await addCaller(h, 's.ts', './q', 'dup', 'fromQ');

    const envelope = await h.query().ask(impactRequest(h, { name: 'dup', depth: 1 }));

    assert.equal(envelope.ok, true, JSON.stringify(envelope.diagnostics));
    const { seeds, results } = dataOf(envelope);
    assert.equal(seeds.length, 2);
    const seedAt = (file: string): string => seeds.find((seed) => seed.path === file)?.handle ?? '';
    assert.deepEqual(
      results.map((item) => [item.name, item.from]),
      [
        ['fromP', seedAt('p.ts')],
        ['fromQ', seedAt('q.ts')],
        ['r.ts', seedAt('p.ts')],
        ['s.ts', seedAt('q.ts')],
      ],
    );
  });

  it('a cursor from code_refs is refused with bad_cursor', async (t) => {
    const h = await world(t);
    await adrExample(h);
    await addCaller(h, 'e.ts', './a', 'parse', 'extra');
    const query = h.query();
    const refs = await query.ask({ protocol: 1, kind: 'code_refs', args: { repo: h.dir, name: 'parse', limit: 1 }, worktree: h.dir });
    const more = refs.more;
    assert.equal(typeof more, 'string');

    const envelope = await query.ask(impactRequest(h, { name: 'parse', more }));

    assert.equal(envelope.ok, false);
    assert.equal(envelope.diagnostics[0]?.code, 'bad_cursor');
  });
});
