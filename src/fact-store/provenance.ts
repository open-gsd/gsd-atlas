/**
 * Handles and provenance (plan 03-26, QRY-07, D-18): why a fact is what it is.
 *
 * A handle is the `debug` string every citation carries. It is opaque to callers: only this file parses one. Its grammar is
 * strict and its lookup is by (path, file content hash, ordinal) in the overlay snapshot a read sees, with bound parameters,
 * so no handle can make the store read anything outside the overlay: a malformed handle is `null`, a handle for a path the
 * overlay does not hold is `null`, and a handle whose file version is no longer the overlay's is `'stale'`.
 *
 * Explaining reads only what is already stored: the file row, the symbol, reference, import or export row, and the cache of
 * resolved edges and relations. It never runs a resolver and never writes.
 */
import type { Confidence, ProjectContext, RefSiteKey, RelationKind, Span, SymbolIdentity } from '../facts/index.ts';
import { RELATION_KINDS, isRelationKind, symbolKey } from '../facts/index.ts';
import { findContextId, readRelationsFrom, siteId } from './cache.ts';
import { extractorOf } from './parts.ts';
import { prepareResolution } from './resolve.ts';
import { fileRow, fileSymbols, identityOf, num, overlayView, spanOf, str } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import type { CacheState, FactExplanation, FactKind } from './types.ts';

/** The longest handle the store reads, in characters. A longer string is not a handle. */
export const MAX_HANDLE_CHARS = 2048;

/** The kinds of handle, as the prefix says. `rel` is a compiler relation between two symbols (plan 03-25). */
export type HandleKind = 'sym' | 'ref' | 'imp' | 'exp' | 'rel';

/**
 * A parsed handle. `path`, `hash` and `ord` locate the fact in its file (for `rel` the `from` symbol); a `rel` handle also
 * names the relation and the other end by path and ordinal.
 */
export interface Handle {
  readonly kind: HandleKind;
  readonly path: string;
  readonly hash: string;
  readonly ord: number;
  readonly relation?: RelationKind;
  readonly toPath?: string;
  readonly toOrd?: number;
}

const SIMPLE_KINDS: ReadonlySet<string> = new Set(['sym', 'ref', 'imp', 'exp']);

/** What `encodeURIComponent` can emit: unreserved characters, `!`, `'`, `(`, `)`, `*` and `%XX`. */
const ENCODED = /^[A-Za-z0-9\-_.!~*'()%]+$/;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ORDINAL = /^(?:0|[1-9][0-9]{0,9})$/;
/** No store holds a billion definitions in one file; a larger number is not an ordinal of this store. */
const MAX_ORD = 1_000_000_000;

function ordinalOf(text: string | undefined): number | null {
  if (text === undefined || !ORDINAL.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= MAX_ORD ? value : null;
}

/**
 * The path a handle segment encodes, or null. The segment must be exactly what `encodeURIComponent` emits for the path, so
 * `%2f`, a raw space and every other non-canonical form are refused; the path must be repository-relative, with no `.`
 * or `..` segment, no backslash, no drive letter and no control character.
 */
function pathOf(segment: string | undefined): string | null {
  if (segment === undefined || segment === '' || !ENCODED.test(segment)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded === '' || encodeURIComponent(decoded) !== segment) return null;
  if (decoded.startsWith('/') || /^[A-Za-z]:/.test(decoded) || decoded.includes('\\')) return null;
  for (const char of decoded) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  if (decoded.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return decoded;
}

/** The handle `text` is, or null for anything that is not exactly one of the shapes the store and Query issue. */
export function parseHandle(text: string): Handle | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_HANDLE_CHARS) return null;
  const parts = text.split('/');
  const [kind] = parts;
  if (kind !== undefined && SIMPLE_KINDS.has(kind)) {
    if (parts.length !== 4) return null;
    const path = pathOf(parts[1]);
    const hash = parts[2] as string;
    const ord = ordinalOf(parts[3]);
    if (path === null || !HASH.test(hash) || ord === null) return null;
    return { kind: kind as HandleKind, path, hash, ord };
  }
  if (kind === 'rel') {
    if (parts.length !== 7) return null;
    const relation = parts[1] as string;
    const path = pathOf(parts[2]);
    const hash = parts[3] as string;
    const ord = ordinalOf(parts[4]);
    const toPath = pathOf(parts[5]);
    const toOrd = ordinalOf(parts[6]);
    if (!isRelationKind(relation) || path === null || !HASH.test(hash) || ord === null || toPath === null || toOrd === null) return null;
    return { kind: 'rel', relation, path, hash, ord, toPath, toOrd };
  }
  return null;
}

/** The text of a handle; the inverse of {@link parseHandle}. This is the one place a handle is composed. */
export function formatHandle(handle: Handle): string {
  const head = `${encodeURIComponent(handle.path)}/${handle.hash}/${String(handle.ord)}`;
  if (handle.kind === 'rel') {
    return `rel/${handle.relation ?? RELATION_KINDS[0]}/${head}/${encodeURIComponent(handle.toPath ?? '')}/${String(handle.toOrd ?? 0)}`;
  }
  return `${handle.kind}/${head}`;
}

const KIND_OF: Readonly<Record<HandleKind, FactKind>> = {
  sym: 'symbol',
  ref: 'reference',
  imp: 'import',
  exp: 'export',
  rel: 'relation',
};

/** The base name of a worktree id (a path): the only part of it an explanation shows. */
function baseName(worktree: string): string {
  const parts = worktree.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? '';
}

const STALE_COUNT_SQL = `SELECT count(*) AS n FROM overlay_files o LEFT JOIN files f ON f.id = o.file_id
  WHERE o.worktree = ? AND (o.file_id IS NULL OR f.stale = 1)`;

function spanFromRow(db: Snapshot['db'], sql: string, fileId: number, ord: number): Span | null {
  const row = db.prepare(sql).get(fileId, ord);
  return row === undefined ? null : spanOf(row);
}

/**
 * What a reference site's cache entry says (plan 03-26): `hit` when a precise edge was stored for it, `asked_no_edge` when
 * the resolver was asked and found nothing, `not_asked` when it could be asked and was not yet, and `not_applicable` when no
 * resolver can answer for it (no precise tier, or a TypeScript file that no config covers).
 */
function siteResolution(snap: Snapshot, project: ProjectContext | null, site: RefSiteKey): { readonly resolution: NonNullable<FactExplanation['resolution']>; readonly cached: boolean } {
  const input = prepareResolution(snap, [site], project);
  const id = siteId(site);
  const hits = [...(input.cached.get(id) ?? [])].sort((a, b) => (symbolKey(a.target) < symbolKey(b.target) ? -1 : 1));
  const base = { contextId: input.context.id, configHashCount: input.context.configHashes.length, snapshot: input.snapshotId };
  const first = hits[0];
  if (first !== undefined && input.unavailable !== true) {
    return {
      cached: true,
      resolution: { ...base, cache: 'hit', resolver: first.resolver, target: { name: first.target.qualifiedName, kind: first.target.kind, path: first.target.path } },
    };
  }
  const precise = input.project.precise;
  let cache: CacheState;
  if (input.unavailable === true) cache = 'not_applicable';
  else if (input.asked.has(id)) cache = 'asked_no_edge';
  else if (precise === undefined || (precise.requiresOwner(site.path) && precise.ownerOf(site.path) === undefined)) cache = 'not_applicable';
  else cache = 'not_asked';
  return { cached: false, resolution: { ...base, cache } };
}

/**
 * Explain the fact `handle` names, inside the read transaction of `snap`. `project` is the project context of the snapshot
 * (null when none could be had): it only keys the cache lookup, nothing is asked of the resolver. Returns `'stale'` when the
 * path is in the overlay at another file version (or its facts are not stored yet), and null for anything the overlay does
 * not hold: an unknown path or an ordinal that is not a fact of that file.
 */
export function describeFact(snap: Snapshot, handle: Handle, project: ProjectContext | null): FactExplanation | 'stale' | null {
  const view = overlayView(snap);
  if (!view.paths.has(handle.path)) return null;
  if (view.hashes.get(handle.path) !== handle.hash) return 'stale';
  const fileId = view.fileIds.get(handle.path);
  if (fileId === undefined || fileId === null) return 'stale';
  const file = fileRow(snap, fileId);
  const staleRow = snap.db.prepare('SELECT stale FROM files WHERE id = ?').get(fileId);
  const stale = staleRow !== undefined && num(staleRow.stale) !== 0;
  const staleCount = num(snap.db.prepare(STALE_COUNT_SQL).get(snap.worktree)?.n ?? 0);

  const explain = (
    span: Span,
    tier: 'grammar' | 'precise',
    confidence: Confidence,
    extractor: string,
    resolution: FactExplanation['resolution'],
  ): FactExplanation => ({
    handle: formatHandle(handle),
    kind: KIND_OF[handle.kind],
    fact: {
      extractor,
      tier,
      confidence,
      module: file.module,
      grammarVersion: file.grammarVersion,
      stale,
      path: handle.path,
      contentHash: file.hash,
      firstSeen: file.firstSeen,
      lastSeen: file.lastSeen,
      span,
    },
    resolution,
    overlay: { worktree: baseName(snap.worktree), seq: snap.seq, stalePaths: staleCount },
  });
  const grammar = extractorOf(file.module, file.grammarVersion);

  switch (handle.kind) {
    case 'sym': {
      const symbol = fileSymbols(snap, fileId).find((candidate) => candidate.ord === handle.ord);
      return symbol === undefined ? null : explain(symbol.span, 'grammar', 'EXTRACTED', grammar, null);
    }
    case 'imp': {
      const span = spanFromRow(snap.db, 'SELECT start_line, start_col, end_line, end_col FROM imports WHERE file_id = ? AND ord = ?', fileId, handle.ord);
      return span === null ? null : explain(span, 'grammar', 'EXTRACTED', grammar, null);
    }
    case 'exp': {
      const span = spanFromRow(snap.db, 'SELECT start_line, start_col, end_line, end_col FROM exports WHERE file_id = ? AND ord = ?', fileId, handle.ord);
      return span === null ? null : explain(span, 'grammar', 'EXTRACTED', grammar, null);
    }
    case 'ref': {
      const row = snap.db
        .prepare(
          `SELECT n.name AS name, r.start_line AS start_line, r.start_col AS start_col, r.end_line AS end_line, r.end_col AS end_col
           FROM refs r JOIN names n ON n.id = r.name_id WHERE r.file_id = ? AND r.ord = ?`,
        )
        .get(fileId, handle.ord);
      if (row === undefined) return null;
      const span = spanOf(row);
      const { resolution, cached } = siteResolution(snap, project, { path: handle.path, span, name: str(row.name) });
      return cached
        ? explain(span, 'precise', 'EXTRACTED', `precise:${resolution.resolver ?? 'unknown'}`, resolution)
        : explain(span, 'grammar', 'INFERRED', grammar, resolution);
    }
    case 'rel': {
      const toPath = handle.toPath;
      const toOrd = handle.toOrd;
      const relation = handle.relation;
      if (toPath === undefined || toOrd === undefined || relation === undefined || !view.paths.has(toPath)) return null;
      const toFileId = view.fileIds.get(toPath);
      if (toFileId === undefined || toFileId === null) return null;
      const from = fileSymbols(snap, fileId).find((candidate) => candidate.ord === handle.ord);
      const to = fileSymbols(snap, toFileId).find((candidate) => candidate.ord === toOrd);
      if (from === undefined || to === undefined) return null;
      const fromId: SymbolIdentity = identityOf(snap, handle.path, from);
      const toId: SymbolIdentity = identityOf(snap, toPath, to);
      const input = prepareResolution(snap, [], project);
      const base = { contextId: input.context.id, configHashCount: input.context.configHashes.length, snapshot: input.snapshotId };
      const contextId = input.unavailable === true ? undefined : findContextId(snap.db, input.contextKey);
      const cached =
        contextId === undefined
          ? undefined
          : readRelationsFrom(snap.db, input.snapshotId, contextId, handle.path, snap.parts.repo).find(
              (row) => row.relation === relation && symbolKey(row.from) === symbolKey(fromId) && symbolKey(row.to) === symbolKey(toId),
            );
      const target = { name: toId.qualifiedName, kind: toId.kind, path: toId.path };
      // A relation is a compiler fact: without a stored row for this snapshot and context nothing says which resolver made it.
      return cached === undefined
        ? explain(from.span, 'precise', 'EXTRACTED', 'precise', { ...base, cache: 'not_asked', target })
        : explain(from.span, 'precise', 'EXTRACTED', `precise:${cached.resolver}`, { ...base, cache: 'hit', resolver: cached.resolver, target });
    }
  }
}
