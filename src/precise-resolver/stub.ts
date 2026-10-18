import type { OverlaySnapshot, RefSiteKey, ResolutionContext, ResolvedEdge, ResolvedRelation } from '../facts/index.ts';
import type { PreciseResolver } from './index.ts';

/**
 * A scripted answer: the reference site and the definition it binds to. Confidence and resolver
 * are not scripted; the stub stamps `EXTRACTED` and its own id, so a script cannot break the
 * contract. A full `ResolvedEdge` is accepted too (its extra fields are replaced).
 */
export type ScriptedEdge = Pick<ResolvedEdge, 'site' | 'target'>;

/**
 * A scripted relation: the two symbols and how they relate. The resolver id is stamped by the stub, so a script cannot
 * claim another resolver's name.
 */
export type ScriptedRelation = Pick<ResolvedRelation, 'from' | 'to' | 'relation'>;

export interface ScriptedResolverOptions {
  readonly id: string;
  /** The edges this resolver knows, or a function producing them from the overlay and context. */
  readonly edges: readonly ScriptedEdge[] | ((overlay: OverlaySnapshot, context: ResolutionContext) => readonly ScriptedEdge[]);
  /**
   * The relations this resolver knows, or a function producing them. Giving the option gives the resolver a `relations`
   * method that yields the relations whose `from` symbol is declared in one of the files asked, in script order. Without
   * the option the resolver has no `relations` method at all.
   */
  readonly relations?:
    | readonly ScriptedRelation[]
    | ((overlay: OverlaySnapshot, context: ResolutionContext) => readonly ScriptedRelation[]);
  /** Called once when an iteration ends, whether it finished, was abandoned or threw. */
  readonly onClose?: () => void;
}

const SEPARATOR = '\u0000';

/** Equal sites give equal keys: path, the four span numbers and the name. */
function siteId(site: RefSiteKey): string {
  const { startLine, startColumn, endLine, endColumn } = site.span;
  return [site.path, startLine, startColumn, endLine, endColumn, site.name].join(SEPARATOR);
}

/**
 * A PreciseResolver whose answers are scripted by the test. For each requested site, in request
 * order, it yields the scripted edges whose site matches; a site requested twice is answered
 * once. It does no resolution of its own.
 */
export function createScriptedResolver(options: ScriptedResolverOptions): PreciseResolver {
  const { id, edges, onClose, relations } = options;
  if (id === '') {
    throw new RangeError('A PreciseResolver id must be a non-empty string');
  }
  const relate: PreciseResolver['relations'] =
    relations === undefined
      ? undefined
      : async function* (overlay, context, files) {
          try {
            const scripted = typeof relations === 'function' ? relations(overlay, context) : relations;
            const asked = new Set(files);
            for (const relation of scripted) {
              if (asked.has(relation.from.path)) {
                yield { from: relation.from, to: relation.to, relation: relation.relation, resolver: id };
              }
            }
          } finally {
            onClose?.();
          }
        };
  return {
    id,
    ...(relate === undefined ? {} : { relations: relate }),
    async *resolve(overlay, context, sites) {
      try {
        const scripted = typeof edges === 'function' ? edges(overlay, context) : edges;
        const bySite = new Map<string, ScriptedEdge[]>();
        for (const edge of scripted) {
          const key = siteId(edge.site);
          const group = bySite.get(key);
          if (group === undefined) {
            bySite.set(key, [edge]);
          } else {
            group.push(edge);
          }
        }
        const answered = new Set<string>();
        for (const site of sites) {
          const key = siteId(site);
          if (answered.has(key)) {
            continue;
          }
          answered.add(key);
          for (const edge of bySite.get(key) ?? []) {
            yield { site: edge.site, target: edge.target, confidence: 'EXTRACTED', resolver: id };
          }
        }
      } finally {
        onClose?.();
      }
    },
  };
}
