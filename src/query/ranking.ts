/**
 * Deterministic ranking (D-08, mcp-contract ADR amendment decision 7). Ranking is a pure comparator over a sort
 * key tuple, so the cursor can carry the last key and a re-query can resume strictly after it. The tuple ends in
 * path, line, column and the debug handle, which makes the order total: a hundred identical requests give the
 * same list. There is no usage-count boost.
 *
 * Key: [tier, kindRank, confidenceRank, exportedRank, dirDistance, path, line, col, handle]
 *   tier            0 exact name, 1 same letters in another case, 2 prefix, 3 substring
 *   kindRank        0 definition, 1 reference
 *   confidenceRank  0 EXTRACTED, 1 INFERRED
 *   exportedRank    0 exported, 1 local or unknown
 *   dirDistance     path segments between the cwd hint's directory and the file's directory (0 without a hint)
 */
import path from 'node:path';
import { isInside } from '../facts/index.ts';

export type MatchTier = 0 | 1 | 2 | 3;

export type SortKey = readonly [number, number, number, number, number, string, number, number, string];

export interface RankInput {
  readonly tier: MatchTier;
  readonly isReference: boolean;
  readonly confidence: 'EXTRACTED' | 'INFERRED';
  readonly exported: boolean;
  readonly distance: number;
  readonly path: string;
  /** Any consistent line number; the store's own 0-based lines are used. */
  readonly line: number;
  readonly col: number;
  readonly handle: string;
}

/**
 * How `candidate` matches `query`: 0 the same characters, 1 the same letters in another case, 2 starts with
 * the query, 3 contains it. Case is compared with simple lower-casing of both sides. `null` when the query is
 * not in the candidate at all.
 */
export function tierOf(candidate: string, query: string): MatchTier | null {
  if (candidate === query) return 0;
  const lowered = candidate.toLowerCase();
  const wanted = query.toLowerCase();
  if (lowered === wanted) return 1;
  if (lowered.startsWith(wanted)) return 2;
  if (lowered.includes(wanted)) return 3;
  return null;
}

/**
 * The name a stored symbol answers to and its tier. The store keeps a qualified name (`Job.run`); the name is
 * its last segment. A symbol the exact read returned has exactly the query as its name, so it is the exact
 * tier. Any other symbol can not be the exact tier (the exact read would have returned it), so its tier is at
 * least 1. A symbol that matches no tier (the fuzzy read found it by folding the store does and this file does
 * not) is kept in the substring tier rather than dropped.
 */
export function nameAndTier(qualifiedName: string, query: string, foundExact: boolean): { name: string; tier: MatchTier } {
  if (foundExact) return { name: query, tier: 0 };
  const dot = qualifiedName.lastIndexOf('.');
  const last = dot < 0 ? qualifiedName : qualifiedName.slice(dot + 1);
  const candidates = last === qualifiedName ? [qualifiedName] : [last, qualifiedName];
  let best: { name: string; tier: MatchTier } | null = null;
  for (const name of candidates) {
    const tier = tierOf(name, query);
    if (tier === null) continue;
    const clamped: MatchTier = tier === 0 ? 1 : tier;
    if (best === null || clamped < best.tier) best = { name, tier: clamped };
  }
  return best ?? { name: last, tier: 3 };
}

const segmentsOf = (dir: string): string[] => (dir === '' ? [] : dir.split('/'));

/**
 * Path segments between two directories (repo-relative, POSIX, `''` for the root): the steps up from one to
 * the common ancestor plus the steps down to the other. No hint means every file is at distance 0.
 */
export function directoryDistance(fileDir: string, hintDir: string | null): number {
  if (hintDir === null) return 0;
  const file = segmentsOf(fileDir);
  const hint = segmentsOf(hintDir);
  let common = 0;
  while (common < file.length && common < hint.length && file[common] === hint[common]) common += 1;
  return file.length - common + (hint.length - common);
}

/**
 * The `cwd` hint as a repo-relative POSIX directory, or `null` when there is no usable hint: none given, an
 * absolute path outside the worktree, or a relative one that climbs out of it. A relative hint is taken as
 * already repo-relative.
 */
export function cwdHintDir(worktree: string, cwd: string | undefined): string | null {
  if (cwd === undefined || cwd === '') return null;
  if (path.isAbsolute(cwd)) {
    if (!isInside(worktree, cwd)) return null;
    return path.relative(worktree, cwd).split(path.sep).join('/');
  }
  const normal = path.posix.normalize(cwd.split(path.sep).join('/'));
  if (normal === '..' || normal.startsWith('../')) return null;
  if (normal === '.') return '';
  return normal.endsWith('/') ? normal.slice(0, -1) : normal;
}

export function sortKeyOf(input: RankInput): SortKey {
  return [
    input.tier,
    input.isReference ? 1 : 0,
    input.confidence === 'EXTRACTED' ? 0 : 1,
    input.exported ? 0 : 1,
    input.distance,
    input.path,
    input.line,
    input.col,
    input.handle,
  ];
}

const rankOf = (value: 'EXTRACTED' | 'INFERRED'): number => (value === 'EXTRACTED' ? 0 : 1);

/** Which tier produced a reference edge, best first: a compiler result outranks a name match. */
const REF_TIER_RANK: Readonly<Record<string, number>> = { precise: 0, base_commit: 1, grammar: 2 };

/** What a reference site does with its name, in ranking order (a call matters most to a reader). */
const REF_KIND_RANK: Readonly<Record<string, number>> = { call: 0, new: 1, type: 2, heritage: 3, read: 4, member: 5 };

export interface RefRankInput {
  readonly tier: string;
  readonly confidence: 'EXTRACTED' | 'INFERRED';
  /** The site's kind; a site that does not say sorts after every named kind. */
  readonly kind: string | undefined;
  readonly distance: number;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  /** Anything that makes two otherwise equal keys differ (the site handle and the target handle). */
  readonly handle: string;
}

/**
 * Key of one reference under `code_refs`: [tier, confidence, kind, 0, dirDistance, path, line, col, handle], so
 * precise comes before grammar, EXTRACTED before INFERRED, then call, new, type, heritage, read, member.
 */
export function refKeyOf(input: RefRankInput): SortKey {
  return [
    REF_TIER_RANK[input.tier] ?? 3,
    rankOf(input.confidence),
    input.kind === undefined ? 6 : (REF_KIND_RANK[input.kind] ?? 6),
    0,
    input.distance,
    input.path,
    input.line,
    input.col,
    input.handle,
  ];
}

/**
 * How an impacted item is reached, in ranking order. The first three are Phase 2's; `extends`, `implements` and
 * `overrides` (mcp-contract ADR amendment, point 8) come from the compiler's relations and rank after them, in this order.
 */
export type ImpactVia = 'import' | 'call' | 'reference' | 'extends' | 'implements' | 'overrides';

const VIA_RANK: Readonly<Record<ImpactVia, number>> = { import: 0, call: 1, reference: 2, extends: 3, implements: 4, overrides: 5 };

/** The number of ways to reach an item: the radix of the edge slot of the key. */
const VIA_COUNT = Object.keys(VIA_RANK).length;

/**
 * The edge slot of an impact key: edge confidence (EXTRACTED first), then chain confidence (EXTRACTED first), then how the
 * item is reached, most significant first. One number, so two edges to the same node compare the same way everywhere.
 */
export function edgeRankOf(confidence: 'EXTRACTED' | 'INFERRED', chain: 'EXTRACTED' | 'INFERRED', via: ImpactVia): number {
  return rankOf(confidence) * 2 * VIA_COUNT + rankOf(chain) * VIA_COUNT + VIA_RANK[via];
}

export interface ImpactRankInput {
  readonly hop: number;
  /** A file item (an importer, or a module-level reference) sorts after the symbols of its hop. */
  readonly isFile: boolean;
  readonly confidence: 'EXTRACTED' | 'INFERRED';
  readonly chain: 'EXTRACTED' | 'INFERRED';
  readonly via: ImpactVia;
  readonly distance: number;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly handle: string;
}

/**
 * Key of one impacted item under `code_impact`: [hop, file, edge, 0, dirDistance, path, line, col, handle].
 * Inside a hop symbols come before files; then the edge slot orders confidence (EXTRACTED first), chain
 * confidence (EXTRACTED first) and how the item is reached (import, call, reference), most significant first.
 */
export function impactKeyOf(input: ImpactRankInput): SortKey {
  return [
    input.hop,
    input.isFile ? 1 : 0,
    edgeRankOf(input.confidence, input.chain, input.via),
    0,
    input.distance,
    input.path,
    input.line,
    input.col,
    input.handle,
  ];
}

/**
 * The sections of `code_context`, in the order they are listed and cut. `supertype` and `subtype` (plan 03-25) are the
 * compiler's relations of the symbol; they are paged like the others but are rendered under `data.supertypes` and
 * `data.subtypes`, not in `data.results`.
 */
export const CONTEXT_SECTIONS = ['definition', 'parent', 'child', 'supertype', 'subtype', 'import', 'export', 'reference'] as const;

export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

/**
 * Key of one `code_context` item: [section, ordinal, 0, 0, 0, path, line, col, ''], where the ordinal is the
 * item's place inside its section, so the list keeps the order the tool built it in and a cursor can continue it.
 */
export function contextKeyOf(section: ContextSection, ordinal: number, path: string, line: number, col: number): SortKey {
  return [CONTEXT_SECTIONS.indexOf(section), ordinal, 0, 0, 0, path, line, col, ''];
}

const byNumber = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Strings compare by UTF-16 code unit, the same unit every position in the kernel uses. */
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Negative when `a` ranks before `b`, positive when after, zero only for identical keys. */
export function compareRanked(a: SortKey, b: SortKey): number {
  return (
    byNumber(a[0], b[0]) ||
    byNumber(a[1], b[1]) ||
    byNumber(a[2], b[2]) ||
    byNumber(a[3], b[3]) ||
    byNumber(a[4], b[4]) ||
    byString(a[5], b[5]) ||
    byNumber(a[6], b[6]) ||
    byNumber(a[7], b[7]) ||
    byString(a[8], b[8])
  );
}
