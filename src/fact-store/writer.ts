import { diagnostic, validateFileFacts } from '../facts/index.ts';
import type { Diagnostic, FileFacts } from '../facts/index.ts';
import type { Db } from '../sqlite/index.ts';
import { assertOpen } from './parts.ts';
import type { StoreParts } from './parts.ts';
import type { CommitFileInput, CommitResult, WorktreeId, Writer } from './types.ts';

/** The most rows (symbols, reference sites, imports, bindings and exports together) one file may add (T-02-17). */
export const MAX_FILE_FACT_ROWS = 200_000;

function bool(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

/** Number of fact rows `facts` would write. */
function rowCount(facts: FileFacts): number {
  let total = facts.symbols.length + facts.refSites.length + facts.imports.length + (facts.exports?.length ?? 0);
  for (const site of facts.imports) total += site.bindings?.length ?? 0;
  return total;
}

/** The overlay's current `seq`, or 0 when the worktree has no overlay. */
function seqOf(db: Db, worktree: WorktreeId): number {
  const row = db.prepare('SELECT seq FROM overlays WHERE worktree = ?').get(worktree);
  return row === undefined ? 0 : Number(row.seq);
}

/** Create the overlay row when the worktree is new, or bring a dropped one back. */
function ensureOverlay(db: Db, worktree: WorktreeId): void {
  const row = db.prepare('SELECT dropped FROM overlays WHERE worktree = ?').get(worktree);
  if (row === undefined) {
    db.prepare('INSERT INTO overlays (worktree, ref, seq, dropped) VALUES (?, ?, 0, 0)').run(worktree, '');
  } else if (Number(row.dropped) !== 0) {
    db.prepare('UPDATE overlays SET dropped = 0 WHERE worktree = ?').run(worktree);
  }
}

/** Advance the worktree's watermark by one and return the new value. */
function bumpSeq(db: Db, worktree: WorktreeId): number {
  db.prepare('UPDATE overlays SET seq = seq + 1 WHERE worktree = ?').run(worktree);
  return seqOf(db, worktree);
}

/** Intern names once per file write; the names table is shared by every file. */
function interner(db: Db): (name: string) => number {
  const insert = db.prepare('INSERT OR IGNORE INTO names (name) VALUES (?)');
  const select = db.prepare('SELECT id FROM names WHERE name = ?');
  const cache = new Map<string, number>();
  return (name) => {
    const known = cache.get(name);
    if (known !== undefined) return known;
    insert.run(name);
    const row = select.get(name);
    if (row === undefined) throw new Error('a name that was just interned is missing');
    const id = Number(row.id);
    cache.set(name, id);
    return id;
  };
}

/** Write every fact row of one file under `fileId`. */
function writeFactRows(db: Db, fileId: number, facts: FileFacts): void {
  const intern = interner(db);

  const insertSymbol = db.prepare(
    'INSERT INTO symbols (file_id, ord, name_id, qname_id, kind, start_line, start_col, end_line, end_col, parent, exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  facts.symbols.forEach((symbol, ord) => {
    insertSymbol.run(
      fileId,
      ord,
      intern(symbol.name),
      symbol.qualifiedName === undefined ? null : intern(symbol.qualifiedName),
      symbol.kind,
      symbol.span.startLine,
      symbol.span.startColumn,
      symbol.span.endLine,
      symbol.span.endColumn,
      symbol.parent ?? null,
      bool(symbol.exported),
    );
  });

  const insertRef = db.prepare(
    'INSERT INTO refs (file_id, ord, name_id, kind, start_line, start_col, end_line, end_col, import_path, enclosing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  facts.refSites.forEach((site, ord) => {
    insertRef.run(
      fileId,
      ord,
      intern(site.name),
      site.kind ?? null,
      site.span.startLine,
      site.span.startColumn,
      site.span.endLine,
      site.span.endColumn,
      site.importPath ?? null,
      site.enclosing ?? null,
    );
  });

  const insertImport = db.prepare(
    'INSERT INTO imports (file_id, ord, path, style, start_line, start_col, end_line, end_col) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertBinding = db.prepare(
    'INSERT INTO import_bindings (file_id, import_ord, ord, imported, local_name) VALUES (?, ?, ?, ?, ?)',
  );
  facts.imports.forEach((site, ord) => {
    insertImport.run(
      fileId,
      ord,
      site.path,
      site.style ?? null,
      site.span.startLine,
      site.span.startColumn,
      site.span.endLine,
      site.span.endColumn,
    );
    site.bindings?.forEach((binding, at) => {
      insertBinding.run(fileId, ord, at, binding.imported, binding.local);
    });
  });

  const insertExport = db.prepare(
    'INSERT INTO exports (file_id, ord, name_id, local_id, from_path, start_line, start_col, end_line, end_col) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  facts.exports?.forEach((site, ord) => {
    insertExport.run(
      fileId,
      ord,
      intern(site.name),
      site.local === undefined ? null : intern(site.local),
      site.from ?? null,
      site.span.startLine,
      site.span.startColumn,
      site.span.endLine,
      site.span.endColumn,
    );
  });
}

/** Insert a new `files` row (state live) and all of its fact rows; returns the new file id. */
function insertFile(db: Db, hash: string, facts: FileFacts, now: number): number {
  const result = db
    .prepare(
      "INSERT INTO files (hash, module, grammar_version, nsym, nref, error_bytes, total_bytes, state, stale, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', 0, ?, ?)",
    )
    .run(
      hash,
      facts.module,
      facts.grammarVersion,
      facts.symbols.length,
      facts.refSites.length,
      facts.parse.errorBytes,
      facts.parse.totalBytes,
      now,
      now,
    );
  const fileId = Number(result.lastInsertRowid);
  writeFactRows(db, fileId, facts);
  return fileId;
}

/**
 * Replace the facts of an existing `files` row: a stale file re-extracted by a newer grammar, or a collected
 * file whose rows are gone. Keeps the row id and `first_seen`, so overlays that point at it stay valid.
 */
function rewriteFile(db: Db, fileId: number, facts: FileFacts, now: number): void {
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM refs WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM imports WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM import_bindings WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM exports WHERE file_id = ?').run(fileId);
  db.prepare(
    "UPDATE files SET module = ?, grammar_version = ?, nsym = ?, nref = ?, error_bytes = ?, total_bytes = ?, state = 'live', stale = 0, retired_at = NULL, last_seen = ? WHERE id = ?",
  ).run(
    facts.module,
    facts.grammarVersion,
    facts.symbols.length,
    facts.refSites.length,
    facts.parse.errorBytes,
    facts.parse.totalBytes,
    now,
    fileId,
  );
  writeFactRows(db, fileId, facts);
}

interface OverlayEntry {
  readonly hash: string;
  /** Null while the facts for `hash` have not been committed (pending). */
  readonly fileId: number | null;
}

function overlayEntry(db: Db, worktree: WorktreeId, path: string): OverlayEntry | undefined {
  const row = db.prepare('SELECT hash, file_id FROM overlay_files WHERE worktree = ? AND path = ?').get(worktree, path);
  if (row === undefined) return undefined;
  return { hash: String(row.hash), fileId: row.file_id === null ? null : Number(row.file_id) };
}

interface FileEntry {
  readonly id: number;
  readonly state: string;
  readonly stale: boolean;
}

function fileEntry(db: Db, hash: string): FileEntry | undefined {
  const row = db.prepare('SELECT id, state, stale FROM files WHERE hash = ?').get(hash);
  if (row === undefined) return undefined;
  return { id: Number(row.id), state: String(row.state), stale: Number(row.stale) !== 0 };
}

/** Retire a live file when no overlay in any worktree references it any more. */
function retireIfUnreferenced(db: Db, fileId: number, now: number): void {
  db.prepare(
    "UPDATE files SET state = 'retired', retired_at = ? WHERE id = ? AND state = 'live' AND NOT EXISTS (SELECT 1 FROM overlay_files WHERE file_id = ?)",
  ).run(now, fileId, fileId);
}

/** Mark a file seen now, and live again when it had been retired. Its fact rows are untouched. */
function touch(db: Db, fileId: number, now: number): void {
  db.prepare("UPDATE files SET state = 'live', retired_at = NULL, last_seen = ? WHERE id = ?").run(now, fileId);
}

/** Point every pending path with this hash, in any worktree, at the file; returns the worktrees that were waiting. */
function resolvePending(db: Db, hash: string, fileId: number): string[] {
  const waiting = db
    .prepare('SELECT DISTINCT worktree FROM overlay_files WHERE hash = ? AND file_id IS NULL')
    .all(hash)
    .map((row) => String(row.worktree));
  if (waiting.length > 0) {
    db.prepare('UPDATE overlay_files SET file_id = ? WHERE hash = ? AND file_id IS NULL').run(fileId, hash);
  }
  return waiting;
}

/** Map (worktree, path) to a file; the file the path used to map to is retired when nothing else references it. */
function place(db: Db, worktree: WorktreeId, path: string, hash: string, fileId: number, now: number): void {
  const previous = overlayEntry(db, worktree, path);
  db.prepare('INSERT OR REPLACE INTO overlay_files (worktree, path, hash, file_id) VALUES (?, ?, ?, ?)').run(
    worktree,
    path,
    hash,
    fileId,
  );
  if (previous?.fileId != null && previous.fileId !== fileId) retireIfUnreferenced(db, previous.fileId, now);
}

function result(status: CommitResult['status'], seq: number, diagnostics: readonly Diagnostic[] = []): CommitResult {
  return { status, seq, diagnostics };
}

function removePath(parts: StoreParts, worktree: WorktreeId, path: string): CommitResult {
  const db = parts.writeDb;
  const now = parts.deps.clock.now();
  return db.transaction(() => {
    const current = overlayEntry(db, worktree, path);
    if (current === undefined) return result('unchanged', seqOf(db, worktree));
    db.prepare('DELETE FROM overlay_files WHERE worktree = ? AND path = ?').run(worktree, path);
    if (current.fileId !== null) retireIfUnreferenced(db, current.fileId, now);
    return result('committed', bumpSeq(db, worktree));
  });
}

function commitFile(parts: StoreParts, input: CommitFileInput): CommitResult {
  const { worktree, path, hash, facts } = input;
  const db = parts.writeDb;
  const rejected = (diagnostics: readonly Diagnostic[]): CommitResult => result('rejected', seqOf(db, worktree), diagnostics);

  if (facts === null) return removePath(parts, worktree, path);

  if (typeof hash !== 'string' || hash === '' || typeof path !== 'string' || path === '') {
    return rejected([diagnostic('commit_invalid', 'error', 'a commit needs a non-empty path and content hash', path)]);
  }
  const problems = validateFileFacts(facts);
  if (problems.length > 0) return rejected(problems);
  if (facts.contentHash !== hash) {
    return rejected([
      diagnostic(
        'hash_mismatch',
        'error',
        `the facts were extracted from content hash ${facts.contentHash}, not the supplied ${hash}`,
        path,
      ),
    ]);
  }
  if (rowCount(facts) > MAX_FILE_FACT_ROWS) {
    return rejected([
      diagnostic('facts_too_large', 'error', `the file has more than ${MAX_FILE_FACT_ROWS} fact rows`, path),
    ]);
  }

  const now = parts.deps.clock.now();
  return db.transaction(() => {
    const current = overlayEntry(db, worktree, path);
    const existing = fileEntry(db, hash);
    if (current?.hash === hash && current.fileId !== null && existing !== undefined && !existing.stale) {
      return result('unchanged', seqOf(db, worktree));
    }
    ensureOverlay(db, worktree);
    let fileId: number;
    if (existing === undefined) {
      fileId = insertFile(db, hash, facts, now);
    } else if (existing.state === 'collected' || existing.stale) {
      rewriteFile(db, existing.id, facts, now);
      fileId = existing.id;
    } else {
      touch(db, existing.id, now);
      fileId = existing.id;
    }
    const waiting = resolvePending(db, hash, fileId);
    place(db, worktree, path, hash, fileId, now);
    for (const other of waiting) if (other !== worktree) bumpSeq(db, other);
    return result('committed', bumpSeq(db, worktree));
  });
}

function link(parts: StoreParts, worktree: WorktreeId, path: string, hash: string): CommitResult {
  const db = parts.writeDb;
  const now = parts.deps.clock.now();
  return db.transaction(() => {
    const existing = fileEntry(db, hash);
    if (existing === undefined || existing.state === 'collected') {
      return result('rejected', seqOf(db, worktree), [
        diagnostic('hash_unknown', 'error', `the store holds no facts for content hash ${hash}`, path),
      ]);
    }
    const current = overlayEntry(db, worktree, path);
    if (current?.hash === hash && current.fileId === existing.id) return result('unchanged', seqOf(db, worktree));
    ensureOverlay(db, worktree);
    touch(db, existing.id, now);
    place(db, worktree, path, hash, existing.id, now);
    return result('committed', bumpSeq(db, worktree));
  });
}

function setOverlay(
  parts: StoreParts,
  worktree: WorktreeId,
  ref: string,
  pathToHash: ReadonlyMap<string, string>,
): void {
  const db = parts.writeDb;
  const now = parts.deps.clock.now();
  db.transaction(() => {
    let changed = false;
    const row = db.prepare('SELECT ref, dropped FROM overlays WHERE worktree = ?').get(worktree);
    if (row === undefined) {
      db.prepare('INSERT INTO overlays (worktree, ref, seq, dropped) VALUES (?, ?, 0, 0)').run(worktree, ref);
      changed = true;
    } else {
      if (Number(row.dropped) !== 0) {
        db.prepare('UPDATE overlays SET dropped = 0 WHERE worktree = ?').run(worktree);
        changed = true;
      }
      if (String(row.ref) !== ref) {
        db.prepare('UPDATE overlays SET ref = ? WHERE worktree = ?').run(ref, worktree);
        changed = true;
      }
    }

    const stored = new Map<string, OverlayEntry>();
    for (const entry of db.prepare('SELECT path, hash, file_id FROM overlay_files WHERE worktree = ?').all(worktree)) {
      stored.set(String(entry.path), {
        hash: String(entry.hash),
        fileId: entry.file_id === null ? null : Number(entry.file_id),
      });
    }

    const unreferenced = new Set<number>();
    const remove = db.prepare('DELETE FROM overlay_files WHERE worktree = ? AND path = ?');
    for (const [path, entry] of stored) {
      if (pathToHash.has(path)) continue;
      remove.run(worktree, path);
      if (entry.fileId !== null) unreferenced.add(entry.fileId);
      changed = true;
    }

    const upsert = db.prepare('INSERT OR REPLACE INTO overlay_files (worktree, path, hash, file_id) VALUES (?, ?, ?, ?)');
    const known = new Map<string, FileEntry | undefined>();
    for (const [path, hash] of pathToHash) {
      if (!known.has(hash)) known.set(hash, fileEntry(db, hash));
      const file = known.get(hash);
      const fileId = file === undefined || file.state === 'collected' ? null : file.id;
      const entry = stored.get(path);
      if (entry?.hash === hash && entry.fileId === fileId) continue;
      if (fileId !== null) touch(db, fileId, now);
      upsert.run(worktree, path, hash, fileId);
      if (entry?.fileId != null && entry.fileId !== fileId) unreferenced.add(entry.fileId);
      changed = true;
    }

    for (const fileId of unreferenced) retireIfUnreferenced(db, fileId, now);
    if (changed) bumpSeq(db, worktree);
  });
}

function dropOverlay(parts: StoreParts, worktree: WorktreeId): void {
  const db = parts.writeDb;
  const now = parts.deps.clock.now();
  db.transaction(() => {
    const row = db.prepare('SELECT dropped FROM overlays WHERE worktree = ?').get(worktree);
    if (row === undefined || Number(row.dropped) !== 0) return;
    const files = db
      .prepare('SELECT DISTINCT file_id FROM overlay_files WHERE worktree = ? AND file_id IS NOT NULL')
      .all(worktree)
      .map((entry) => Number(entry.file_id));
    db.prepare('DELETE FROM overlay_files WHERE worktree = ?').run(worktree);
    db.prepare('UPDATE overlays SET dropped = 1 WHERE worktree = ?').run(worktree);
    for (const fileId of files) retireIfUnreferenced(db, fileId, now);
    bumpSeq(db, worktree);
  });
}

function markStale(parts: StoreParts, module: string, grammarVersion: string): number {
  const db = parts.writeDb;
  return db.transaction(() => {
    const affected = db
      .prepare(
        `SELECT DISTINCT o.worktree AS worktree FROM overlay_files o
         JOIN files f ON f.id = o.file_id
         WHERE f.module = ? AND f.grammar_version <> ? AND f.stale = 0 AND f.state = 'live'`,
      )
      .all(module, grammarVersion)
      .map((row) => String(row.worktree));
    const marked = db
      .prepare("UPDATE files SET stale = 1 WHERE module = ? AND grammar_version <> ? AND stale = 0 AND state = 'live'")
      .run(module, grammarVersion);
    for (const worktree of affected) bumpSeq(db, worktree);
    return Number(marked.changes);
  });
}

/**
 * The single writer. Every method runs one SQLite transaction on the store's writable connection, so a reader
 * sees all or none of a file's facts. Rows are keyed by content hash: identical content at two paths or in two
 * worktrees is one `files` row, and a file's facts are retired only when no overlay references them.
 *
 * A path whose hash has no facts yet (`setOverlay`) is pending: it has no facts and is reported in the
 * watermark's `stalePaths` until `commitFile` supplies the facts for that hash.
 */
export function createWriter(parts: StoreParts): Writer {
  let released = false;
  const live = (): void => {
    assertOpen(parts);
    if (released) throw new Error('this writer was released');
  };
  return {
    async commitFile(input) {
      live();
      return commitFile(parts, input);
    },
    async link(worktree, path, hash) {
      live();
      return link(parts, worktree, path, hash);
    },
    async setOverlay(worktree, ref, pathToHash) {
      live();
      setOverlay(parts, worktree, ref, pathToHash);
    },
    async dropOverlay(worktree) {
      live();
      dropOverlay(parts, worktree);
    },
    async markStale(selector) {
      live();
      return markStale(parts, selector.module, selector.grammarVersion);
    },
    release() {
      if (released) return;
      released = true;
      parts.state.writerTaken = false;
    },
  };
}
