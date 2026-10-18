import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OverlaySnapshot, RefSiteKey, ResolutionContext, ResolvedEdge, SymbolLookup } from '../facts/index.ts';
import type { PreciseResolver } from './index.ts';

/**
 * What the contract needs from an adapter, so it can run against the PreciseResolver interface
 * alone: TS 6.x, TS 7.x, SCIP and IndexStoreDB adapters each build a subject over a small fixture.
 */
export interface PreciseResolverSubject {
  readonly resolver: PreciseResolver;
  readonly overlay: OverlaySnapshot;
  readonly context: ResolutionContext;
  /** Two or more distinct sites the resolver can bind, each to at least one edge. */
  readonly resolvable: readonly RefSiteKey[];
  /** A site the resolver has no edge for. */
  readonly unresolvable: RefSiteKey;
  /** How many times the resolver's cleanup has run for this subject. */
  closeCount(): number;
}

/**
 * Behaviour every PreciseResolver must show. Test code: it is imported only by
 * precise-resolver.test.ts (and any adapter added inside src/precise-resolver, by relative
 * import) and never re-exported from index.ts. An adapter in another module needs a deliberate,
 * dated lint exception, because the module boundaries forbid a cross-module contract import.
 * `make` must return a fresh subject (close count 0) on every call.
 */
export function definePreciseResolverContract(label: string, make: () => PreciseResolverSubject): void {
  async function collect(
    subject: PreciseResolverSubject,
    sites: readonly RefSiteKey[],
  ): Promise<ResolvedEdge[]> {
    const edges: ResolvedEdge[] = [];
    for await (const edge of subject.resolver.resolve(subject.overlay, subject.context, sites)) {
      edges.push(edge);
    }
    return edges;
  }

  const key = (site: RefSiteKey): string => JSON.stringify([site.path, site.span, site.name]);

  describe(`PreciseResolver contract: ${label}`, () => {
    it('has a non-empty string id', () => {
      const { resolver } = make();
      assert.equal(typeof resolver.id, 'string');
      assert.ok(resolver.id.length > 0);
    });

    it('yields only edges for requested sites', async () => {
      const subject = make();
      const [wanted, other] = subject.resolvable;
      assert.ok(wanted !== undefined && other !== undefined, 'the subject must offer two resolvable sites');
      const edges = await collect(subject, [wanted]);
      assert.ok(edges.length > 0, 'the requested site should resolve');
      for (const edge of edges) {
        assert.equal(key(edge.site), key(wanted));
        assert.notEqual(key(edge.site), key(other));
      }
    });

    it('yields nothing for a site it cannot resolve', async () => {
      const subject = make();
      assert.deepEqual(await collect(subject, [subject.unresolvable]), []);
    });

    it('yields edges in request order', async () => {
      const subject = make();
      const [first, second] = subject.resolvable;
      assert.ok(first !== undefined && second !== undefined);
      const forward = (await collect(make(), [first, second])).map((edge) => key(edge.site));
      const backward = (await collect(subject, [second, first])).map((edge) => key(edge.site));
      const groups = (keys: readonly string[]): string[] => keys.filter((k, i) => i === 0 || k !== keys[i - 1]);
      assert.deepEqual(groups(forward), [key(first), key(second)]);
      assert.deepEqual(groups(backward), [key(second), key(first)]);
    });

    it('gives every edge confidence EXTRACTED and its own id as the resolver', async () => {
      const subject = make();
      const edges = await collect(subject, subject.resolvable);
      assert.ok(edges.length > 0);
      for (const edge of edges) {
        assert.equal(edge.confidence, 'EXTRACTED');
        assert.equal(edge.resolver, subject.resolver.id);
      }
    });

    it('gives the same sequence for the same inputs twice', async () => {
      const subject = make();
      const first = await collect(subject, subject.resolvable);
      const second = await collect(subject, subject.resolvable);
      assert.deepEqual(second, first);
    });

    it('resolves the same edges with and without the optional symbols argument', async () => {
      const subject = make();
      const lookup: SymbolLookup = { find: async () => [], findIn: async () => [] };
      const without = await collect(subject, subject.resolvable);
      const withLookup: ResolvedEdge[] = [];
      for await (const edge of subject.resolver.resolve(subject.overlay, subject.context, subject.resolvable, lookup)) {
        withLookup.push(edge);
      }
      assert.ok(without.length > 0);
      assert.deepEqual(withLookup, without);
    });

    it('yields nothing for an empty request', async () => {
      const subject = make();
      assert.deepEqual(await collect(subject, []), []);
    });

    it('runs cleanup exactly once when the iteration finishes', async () => {
      const subject = make();
      assert.equal(subject.closeCount(), 0);
      await collect(subject, subject.resolvable);
      assert.equal(subject.closeCount(), 1);
    });

    it('runs cleanup exactly once when the consumer breaks out after the first edge', async () => {
      const subject = make();
      let seen = 0;
      for await (const _edge of subject.resolver.resolve(subject.overlay, subject.context, subject.resolvable)) {
        seen += 1;
        break;
      }
      assert.equal(seen, 1);
      assert.equal(subject.closeCount(), 1);
    });

    it('runs cleanup exactly once when the consumer throws mid-iteration', async () => {
      const subject = make();
      const boom = new Error('consumer failed');
      await assert.rejects(
        (async () => {
          for await (const _edge of subject.resolver.resolve(subject.overlay, subject.context, subject.resolvable)) {
            throw boom;
          }
        })(),
        (error: unknown) => error === boom,
      );
      assert.equal(subject.closeCount(), 1);
    });
  });
}
