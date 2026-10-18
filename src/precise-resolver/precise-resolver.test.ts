import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isResolverNotice } from '../facts/index.ts';
import type {
  OverlaySnapshot,
  RefSiteKey,
  ResolutionContext,
  ResolvedEdge,
  ResolvedRelation,
  ResolverNotice,
  ResolveScope,
  SymbolIdentity,
  SymbolLookup,
} from '../facts/index.ts';
import { definePreciseResolverContract } from './contract.ts';
import type { PreciseResolverSubject } from './contract.ts';
import { asStoreResolver, createScriptedResolver } from './index.ts';
import type { PreciseResolver, ScriptedEdge, ScriptedRelation } from './index.ts';

const overlay: OverlaySnapshot = { id: 'overlay-1', pathToHash: new Map([['src/a.ts', 'h1']]) };
const context: ResolutionContext = { id: 'ctx-1', configHashes: ['c1'] };

const site = (path: string, line: number, name: string): RefSiteKey => ({
  path,
  span: { startLine: line, startColumn: 2, endLine: line, endColumn: 2 + name.length },
  name,
});

const target = (qualifiedName: string): SymbolIdentity => ({
  repo: 'r',
  path: 'src/defs.ts',
  qualifiedName,
  kind: 'function',
});

const SITE_A = site('src/a.ts', 3, 'alpha');
const SITE_B = site('src/b.ts', 7, 'beta');
const SITE_NONE = site('src/c.ts', 1, 'gamma');

const SCRIPT: readonly ScriptedEdge[] = [
  { site: SITE_A, target: target('alpha') },
  { site: SITE_B, target: target('beta') },
  { site: SITE_A, target: target('alpha2') },
];

function scriptedSubject(): PreciseResolverSubject {
  let closes = 0;
  return {
    resolver: createScriptedResolver({ id: 'scripted', edges: SCRIPT, onClose: () => void (closes += 1) }),
    overlay,
    context,
    resolvable: [SITE_A, SITE_B],
    unresolvable: SITE_NONE,
    closeCount: () => closes,
  };
}

async function collect(iterable: AsyncIterable<ResolvedEdge>): Promise<ResolvedEdge[]> {
  const edges: ResolvedEdge[] = [];
  for await (const edge of iterable) {
    edges.push(edge);
  }
  return edges;
}

definePreciseResolverContract('scripted', scriptedSubject);

describe('scripted PreciseResolver', () => {
  it('yields each requested site its scripted edges, in scripted order within a site', async () => {
    const resolver = createScriptedResolver({ id: 'scripted', edges: SCRIPT });
    const edges = await collect(resolver.resolve(overlay, context, [SITE_A]));
    assert.deepEqual(
      edges.map((e) => e.target.qualifiedName),
      ['alpha', 'alpha2'],
    );
  });

  it('answers a site requested twice once', async () => {
    const resolver = createScriptedResolver({ id: 'scripted', edges: SCRIPT });
    const edges = await collect(resolver.resolve(overlay, context, [SITE_B, SITE_B]));
    assert.equal(edges.length, 1);
  });

  it('matches a site by path, span and name together', async () => {
    const resolver = createScriptedResolver({ id: 'scripted', edges: SCRIPT });
    const sameNameOtherPlace = site('src/a.ts', 4, 'alpha');
    const sameSpanOtherName = { ...SITE_A, name: 'alpha-renamed' };
    const sameSpanOtherPath = { ...SITE_A, path: 'src/z.ts' };
    for (const probe of [sameNameOtherPlace, sameSpanOtherName, sameSpanOtherPath]) {
      assert.deepEqual(await collect(resolver.resolve(overlay, context, [probe])), []);
    }
  });

  it('stamps EXTRACTED and its own id even when the script carries other values', async () => {
    const sloppy = { site: SITE_A, target: target('alpha'), confidence: 'INFERRED', resolver: 'someone-else' };
    const resolver = createScriptedResolver({ id: 'mine', edges: [sloppy as unknown as ScriptedEdge] });
    const [edge] = await collect(resolver.resolve(overlay, context, [SITE_A]));
    assert.equal(edge?.confidence, 'EXTRACTED');
    assert.equal(edge?.resolver, 'mine');
  });

  it('computes edges from the overlay and context when given a function', async () => {
    const seen: string[] = [];
    const resolver = createScriptedResolver({
      id: 'dynamic',
      edges: (o, c) => {
        seen.push(o.id, c.id);
        return [{ site: SITE_A, target: target(`from-${o.id}`) }];
      },
    });
    const edges = await collect(resolver.resolve(overlay, context, [SITE_A]));
    assert.deepEqual(seen, ['overlay-1', 'ctx-1']);
    assert.equal(edges[0]?.target.qualifiedName, 'from-overlay-1');
  });

  it('runs cleanup when the script function throws, and surfaces the error', async () => {
    let closes = 0;
    const boom = new Error('script failed');
    const resolver = createScriptedResolver({
      id: 'throws',
      edges: () => {
        throw boom;
      },
      onClose: () => void (closes += 1),
    });
    await assert.rejects(collect(resolver.resolve(overlay, context, [SITE_A])), (error: unknown) => error === boom);
    assert.equal(closes, 1);
  });

  it('runs cleanup once per iteration, not once per resolver', async () => {
    const subject = scriptedSubject();
    await collect(subject.resolver.resolve(overlay, context, [SITE_A]));
    await collect(subject.resolver.resolve(overlay, context, [SITE_B]));
    assert.equal(subject.closeCount(), 2);
  });

  it('refuses an empty id', () => {
    assert.throws(() => createScriptedResolver({ id: '', edges: [] }), RangeError);
  });
});

describe('asStoreResolver', () => {
  const lookup: SymbolLookup = { find: async () => [], findIn: async () => [] };
  const scope: ResolveScope = { worktree: 'wt', overlay, project: { context } };

  /** A PreciseResolver that records the arguments `resolve` was called with. */
  function recording(): { readonly resolver: PreciseResolver; readonly calls: unknown[][] } {
    const calls: unknown[][] = [];
    const resolver: PreciseResolver = {
      id: 'recording',
      async *resolve(...args) {
        calls.push(args);
        yield { site: SITE_A, target: target('alpha'), confidence: 'EXTRACTED', resolver: 'recording' };
      },
    };
    return { resolver, calls };
  }

  it('calls PreciseResolver.resolve with the scope overlay, the context, the sites and the symbol lookup', async () => {
    const { resolver, calls } = recording();
    const edges = await collect(asStoreResolver(resolver)([SITE_A, SITE_B], context, lookup, scope));
    assert.equal(calls.length, 1);
    const [receivedOverlay, receivedContext, receivedSites, receivedSymbols] = calls[0] ?? [];
    assert.equal(receivedOverlay, overlay, 'the overlay is the one in the scope');
    assert.equal(receivedContext, context);
    assert.deepEqual(receivedSites, [SITE_A, SITE_B]);
    assert.equal(receivedSymbols, lookup, 'the store lookup reaches the adapter');
    assert.deepEqual(
      edges.map((edge) => edge.target.qualifiedName),
      ['alpha'],
    );
  });

  it('yields the edges of the scripted resolver for the sites asked', async () => {
    const scripted = createScriptedResolver({ id: 'scripted', edges: SCRIPT });
    const edges = await collect(asStoreResolver(scripted)([SITE_B], context, lookup, scope));
    assert.deepEqual(
      edges.map((edge) => [edge.site.name, edge.target.qualifiedName, edge.resolver]),
      [['beta', 'beta', 'scripted']],
    );
  });

  it('yields nothing and never calls the resolver when the store passes no scope', async () => {
    const { resolver, calls } = recording();
    assert.deepEqual(await collect(asStoreResolver(resolver)([SITE_A], context, lookup)), []);
    assert.equal(calls.length, 0);
  });

  it('runs the resolver cleanup exactly once when the consumer stops after the first edge', async () => {
    let closes = 0;
    const scripted = createScriptedResolver({ id: 'scripted', edges: SCRIPT, onClose: () => void (closes += 1) });
    for await (const _edge of asStoreResolver(scripted)([SITE_A, SITE_B], context, lookup, scope)) {
      break;
    }
    assert.equal(closes, 1);
  });
});

describe('optional relations (plan 03-25)', () => {
  const lookup: SymbolLookup = { find: async () => [], findIn: async () => [] };
  const scope: ResolveScope = { worktree: 'wt', overlay, project: { context } };
  const identity = (path: string, qualifiedName: string, kind = 'class'): SymbolIdentity => ({ repo: 'r', path, qualifiedName, kind });
  const SUB = identity('src/sub.ts', 'Sub');
  const BASE = identity('src/base.ts', 'Base');
  const OTHER = identity('src/other.ts', 'Other');
  const RELATIONS: readonly ScriptedRelation[] = [
    { from: SUB, to: BASE, relation: 'extends' },
    { from: OTHER, to: BASE, relation: 'implements' },
  ];

  async function relationsOf(iterable: AsyncIterable<ResolvedRelation | ResolverNotice>): Promise<ResolvedRelation[]> {
    const out: ResolvedRelation[] = [];
    for await (const item of iterable) if (!isResolverNotice(item as never)) out.push(item as ResolvedRelation);
    return out;
  }

  it('the scripted resolver has no relations method unless it is given relations', () => {
    assert.equal('relations' in createScriptedResolver({ id: 'plain', edges: [] }), false);
    assert.equal(typeof createScriptedResolver({ id: 'with', edges: [], relations: RELATIONS }).relations, 'function');
  });

  it('yields the relations declared in the files asked, stamped with its own id', async () => {
    const resolver = createScriptedResolver({ id: 'mine', edges: [], relations: RELATIONS });
    const relations = await relationsOf(resolver.relations?.(overlay, context, ['src/sub.ts']) ?? (async function* () {})());
    assert.deepEqual(
      relations.map((relation) => [relation.relation, relation.from.qualifiedName, relation.to.qualifiedName, relation.resolver]),
      [['extends', 'Sub', 'Base', 'mine']],
    );
  });

  it('asStoreResolver carries relations only when the resolver has them, and hands over overlay, context, files and lookup', async () => {
    const plain = asStoreResolver(createScriptedResolver({ id: 'plain', edges: [] }));
    assert.equal(plain.relations, undefined);

    const calls: unknown[][] = [];
    const resolver: PreciseResolver = {
      id: 'recording',
      async *resolve() {
        // no edges
      },
      async *relations(...args) {
        calls.push(args);
        yield { from: SUB, to: BASE, relation: 'extends', resolver: 'recording' };
      },
    };
    const port = asStoreResolver(resolver);
    assert.equal(typeof port.relations, 'function');
    const relations = await relationsOf(port.relations?.(['src/sub.ts'], context, lookup, scope) ?? (async function* () {})());
    assert.equal(relations.length, 1);
    const [receivedOverlay, receivedContext, receivedFiles, receivedSymbols] = calls[0] ?? [];
    assert.equal(receivedOverlay, overlay);
    assert.equal(receivedContext, context);
    assert.deepEqual(receivedFiles, ['src/sub.ts']);
    assert.equal(receivedSymbols, lookup);
  });

  it('asStoreResolver relations yield nothing and never call the resolver when the store passes no scope', async () => {
    let called = 0;
    const resolver: PreciseResolver = {
      id: 'recording',
      async *resolve() {
        // no edges
      },
      async *relations() {
        called += 1;
        yield { from: SUB, to: BASE, relation: 'extends', resolver: 'recording' };
      },
    };
    const port = asStoreResolver(resolver);
    assert.deepEqual(await relationsOf(port.relations?.(['src/sub.ts'], context, lookup) ?? (async function* () {})()), []);
    assert.equal(called, 0);
  });
});
