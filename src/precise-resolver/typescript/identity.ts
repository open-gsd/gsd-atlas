/**
 * Identity mapping (plan 03-23, research Pitfall 2).
 *
 * The store accepts an edge only when its target equals a grammar symbol's identity. The compiler speaks in
 * declarations; this file maps each to the grammar symbol whose span contains the declaration's name token, through the
 * store's read-only lookup. A declaration with no containing symbol (a destructured binding, a parameter), or with two
 * equally tight ones, produces no edge: nothing is guessed. Every outcome is counted per compiler declaration kind, so
 * the ratio of edges to declarations asked is visible.
 */
import type { LocatedSymbol, SymbolIdentity, SymbolLookup } from '../../facts/index.ts';
import type { Target } from './protocol.ts';

export interface KindStats {
  /** Declarations of this kind the compiler returned for the sites asked. */
  asked: number;
  /** Of those, the ones mapped to exactly one grammar symbol. */
  edges: number;
  /** Of those, the ones that were not (`asked` minus `edges`). */
  dropped: number;
}

export interface Stats {
  /** Reference sites sent to the worker, and sites for which it returned at least one declaration. */
  sites: { asked: number; answered: number };
  /** Edges produced (mapped declarations). */
  edges: number;
  /** Declarations dropped, by compiler declaration kind. */
  dropped: Record<string, number>;
  /** Asked, mapped and dropped declarations by compiler declaration kind. */
  byKind: Record<string, KindStats>;
}

export function createStats(): Stats {
  return { sites: { asked: 0, answered: 0 }, edges: 0, dropped: {}, byKind: {} };
}

/** Counts one declaration of `kind` and whether it was mapped. */
export function countDeclaration(stats: Stats, kind: string, mapped: boolean): void {
  // Own keys only: a kind named `__proto__` or `constructor` must not resolve to an inherited member.
  const entry = Object.hasOwn(stats.byKind, kind) ? (stats.byKind[kind] as KindStats) : { asked: 0, edges: 0, dropped: 0 };
  entry.asked += 1;
  if (mapped) {
    entry.edges += 1;
    stats.edges += 1;
  } else {
    entry.dropped += 1;
    stats.dropped[kind] = (Object.hasOwn(stats.dropped, kind) ? (stats.dropped[kind] as number) : 0) + 1;
  }
  stats.byKind[kind] = entry;
}

/** True for a repository-relative POSIX path: not absolute, no drive letter, no backslash, no NUL and no `..` or `.` segment. */
export function isRepositoryPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\') || value.includes('\0')) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

/** True when the half-open range of `span` holds the position. */
function holds(span: LocatedSymbol['span'], row: number, col: number): boolean {
  if (row < span.startLine || (row === span.startLine && col < span.startColumn)) return false;
  return row < span.endLine || (row === span.endLine && col < span.endColumn);
}

/**
 * Negative when `a` is tighter than `b` (it starts later or, from the same start, ends earlier); zero when the two
 * spans are identical. Two spans that both hold one position nest, so this orders them innermost first.
 */
function tighter(a: LocatedSymbol['span'], b: LocatedSymbol['span']): number {
  return b.startLine - a.startLine || b.startColumn - a.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn;
}

/**
 * The identity of the grammar symbol `target` is the name token of, or null. Among the symbols called `target.name` in
 * `target.path` whose span contains the token, the innermost wins (a method inside a class); two equally tight ones are
 * ambiguous and give null.
 */
export async function mapTarget(target: Target, symbols: SymbolLookup): Promise<SymbolIdentity | null> {
  // The worker is untrusted (it may run the project's own compiler): a path that is not a plain repository-relative POSIX path
  // is refused before the store is asked anything about it (T-03-232).
  if (!isRepositoryPath(target.path)) return null;
  const candidates = await symbols.findIn(target.path, target.name);
  const containing = candidates.filter((symbol) => holds(symbol.span, target.row, target.col));
  if (containing.length === 0) return null;
  containing.sort((a, b) => tighter(a.span, b.span));
  const [best, second] = containing as [LocatedSymbol, ...LocatedSymbol[]];
  if (second !== undefined && tighter(best.span, second.span) === 0) return null;
  const { repo, path, qualifiedName, kind, discriminator } = best;
  return discriminator === undefined ? { repo, path, qualifiedName, kind } : { repo, path, qualifiedName, kind, discriminator };
}
