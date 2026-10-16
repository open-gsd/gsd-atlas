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

function notYet(): never {
  throw new Error('not implemented in this task');
}

function commitFile(parts: StoreParts, input: CommitFileInput): CommitResult {
  const { worktree, path, hash, facts } = input;
  const db = parts.writeDb;
  const rejected = (diagnostics: readonly Diagnostic[]): CommitResult => ({
    status: 'rejected',
    seq: seqOf(db, worktree),
    diagnostics,
  });

  if (facts === null) return notYet();

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
  const seq = db.transaction(() => {
    ensureOverlay(db, worktree);
    const fileId = insertFile(db, hash, facts, now);
    db.prepare('INSERT OR REPLACE INTO overlay_files (worktree, path, hash, file_id) VALUES (?, ?, ?, ?)').run(
      worktree,
      path,
      hash,
      fileId,
    );
    return bumpSeq(db, worktree);
  });
  return { status: 'committed', seq, diagnostics: [] };
}

/**
 * The single writer. Every method runs one SQLite transaction on the store's writable connection, so a reader
 * sees all or none of a file's facts. Task 2 of plan 02-06 completes overlays, retirement and the watermark.
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
    async link() {
      live();
      return notYet();
    },
    async setOverlay() {
      live();
      notYet();
    },
    async dropOverlay() {
      live();
      notYet();
    },
    async markStale() {
      live();
      return notYet();
    },
    release() {
      if (released) return;
      released = true;
      parts.state.writerTaken = false;
    },
  };
}
