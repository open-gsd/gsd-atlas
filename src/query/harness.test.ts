/**
 * Test helper for the Query tests (no test inside it): a real temporary git repository with source files, a real
 * Fact Store populated through its Writer from hand-made FileFacts, and a real Source Tree. Query reads the store
 * for facts and the files for line text, exactly as it does in production.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { openFactStore } from '../fact-store/index.ts';
import type { FactStore, Resolver, Writer } from '../fact-store/index.ts';
import type { ExportSite, FileFacts, ImportBinding, ImportSite, ImportStyle, LocalSymbol, RefKind, RefSite } from '../facts/index.ts';
import { createSourceTree } from '../source-tree/index.ts';
import type { SourceTree } from '../source-tree/index.ts';
import { FakeClock, createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import type { TempGitRepo } from '../test-kit/index.ts';
import { createQuery } from './index.ts';
import type { Query, QueryDeps } from './index.ts';

/** Setup commands (init, add, commit) are not in the production allowlist, so setup uses the allow-all rule. */
const setupRunner = createRealRunner({ decide: allowAll });

/** A store without a precise resolver: it resolves nothing. */
const noResolver: Resolver = async function* () {
  // resolves nothing
};

/** The git blob id of `content` in a SHA-1 repository. */
export const blobId = (content: string | Uint8Array): string => {
  const body = Buffer.from(content);
  return createHash('sha1').update(`blob ${String(body.length)}\0`).update(body).digest('hex');
};

/** One definition to store, in the store's own coordinates: 0-based lines, 0-based UTF-16 columns. */
export interface SymbolSpec {
  readonly name: string;
  readonly kind?: string;
  readonly line: number;
  readonly col: number;
  readonly endLine?: number;
  readonly endCol?: number;
  readonly exported?: boolean;
  readonly qualifiedName?: string;
  /** Index into the same `symbols` list of the containing symbol. */
  readonly parent?: number;
}

/** One reference site, in the store's own coordinates. */
export interface RefSpec {
  readonly name: string;
  readonly line: number;
  readonly col: number;
  readonly endCol?: number;
  readonly kind?: RefKind;
  /** Index into the `symbols` list of the innermost symbol that contains the site. */
  readonly enclosing?: number;
  readonly importPath?: string;
}

/** One import statement on its own line. */
export interface ImportSpec {
  readonly path: string;
  readonly line: number;
  readonly style?: ImportStyle;
  readonly bindings?: readonly ImportBinding[];
}

/** One export on its own line. */
export interface ExportSpec {
  readonly name: string;
  readonly line: number;
  readonly col?: number;
  readonly local?: string;
}

/** Everything a hand-made file can carry: definitions, reference sites, imports and exports. */
export interface FactsSpec {
  readonly symbols?: readonly SymbolSpec[];
  readonly refs?: readonly RefSpec[];
  readonly imports?: readonly ImportSpec[];
  readonly exports?: readonly ExportSpec[];
}

export interface HarnessOptions {
  /** The store's precise resolver. Default: one that resolves nothing. */
  readonly resolver?: Resolver;
}

export interface Harness {
  /** The worktree root: the store's worktree id and the Source Tree's `worktree` argument. */
  readonly dir: string;
  readonly repo: TempGitRepo;
  readonly store: FactStore;
  readonly tree: SourceTree;
  readonly clock: FakeClock;
  /** Write `content` to `relPath` and store `symbols` as that file's facts. Returns the content hash. */
  addFile(relPath: string, content: string, symbols: readonly SymbolSpec[]): Promise<string>;
  /** Store `symbols` as the facts of a file without touching the disk (the file may be absent or different). */
  addFacts(relPath: string, hash: string, symbols: readonly SymbolSpec[]): Promise<void>;
  /** Write `content` to `relPath` and store `spec` (symbols, reference sites, imports, exports) as that file's facts. */
  addFileWith(relPath: string, content: string, spec: FactsSpec): Promise<string>;
  /** The store's single writer, held for the harness's life (tests call `markStale` or `setOverlay` through it). */
  readonly writer: Writer;
  /** Dependencies wired to the real store and Source Tree; `overrides` replace any of them. */
  deps(overrides?: Partial<QueryDeps>): QueryDeps;
  query(overrides?: Partial<QueryDeps>): Query;
  cleanup(): Promise<void>;
}

function localSymbol(spec: SymbolSpec): LocalSymbol {
  return {
    name: spec.name,
    kind: spec.kind ?? 'function',
    span: {
      startLine: spec.line,
      startColumn: spec.col,
      endLine: spec.endLine ?? spec.line,
      endColumn: spec.endCol ?? spec.col + spec.name.length,
    },
    ...(spec.qualifiedName === undefined ? {} : { qualifiedName: spec.qualifiedName }),
    ...(spec.exported === undefined ? {} : { exported: spec.exported }),
    ...(spec.parent === undefined ? {} : { parent: spec.parent }),
  };
}

function refSite(spec: RefSpec): RefSite {
  return {
    name: spec.name,
    span: { startLine: spec.line, startColumn: spec.col, endLine: spec.line, endColumn: spec.endCol ?? spec.col + spec.name.length },
    ...(spec.kind === undefined ? {} : { kind: spec.kind }),
    ...(spec.enclosing === undefined ? {} : { enclosing: spec.enclosing }),
    ...(spec.importPath === undefined ? {} : { importPath: spec.importPath }),
  };
}

function importSite(spec: ImportSpec): ImportSite {
  return {
    path: spec.path,
    span: { startLine: spec.line, startColumn: 0, endLine: spec.line, endColumn: 20 },
    ...(spec.style === undefined ? {} : { style: spec.style }),
    ...(spec.bindings === undefined ? {} : { bindings: spec.bindings }),
  };
}

function exportSite(spec: ExportSpec): ExportSite {
  const col = spec.col ?? 0;
  return {
    name: spec.name,
    span: { startLine: spec.line, startColumn: col, endLine: spec.line, endColumn: col + spec.name.length },
    ...(spec.local === undefined ? {} : { local: spec.local }),
  };
}

function factsOf(relPath: string, hash: string, spec: FactsSpec): FileFacts {
  return {
    path: relPath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: (spec.symbols ?? []).map(localSymbol),
    refSites: (spec.refs ?? []).map(refSite),
    imports: (spec.imports ?? []).map(importSite),
    exports: (spec.exports ?? []).map(exportSite),
    parse: { errorBytes: 0, totalBytes: 0 },
  };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const repo = await createTempGitRepo({ runner: setupRunner });
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const store = await openFactStore(
    path.join(tmp.path, 'store'),
    { resolver: options.resolver ?? noResolver, clock, gitHas: () => Promise.resolve(true) },
    { repo: 'toy', version: 'test' },
  );
  const tree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
  const writer = store.writer();
  const dir = repo.dir;

  const commit = async (relPath: string, hash: string, spec: FactsSpec): Promise<void> => {
    const result = await writer.commitFile({ worktree: dir, path: relPath, hash, facts: factsOf(relPath, hash, spec) });
    if (result.status === 'rejected') throw new Error(`the harness facts for ${relPath} were rejected`);
  };
  const addFacts = (relPath: string, hash: string, symbols: readonly SymbolSpec[]): Promise<void> => commit(relPath, hash, { symbols });
  const addFileWith = async (relPath: string, content: string, spec: FactsSpec): Promise<string> => {
    repo.write(relPath, content);
    const hash = blobId(content);
    await commit(relPath, hash, spec);
    return hash;
  };
  const deps = (overrides: Partial<QueryDeps> = {}): QueryDeps => ({ store, text: tree, clock, ...overrides });

  return {
    dir,
    repo,
    store,
    tree,
    clock,
    writer,
    addFile: (relPath, content, symbols) => addFileWith(relPath, content, { symbols }),
    addFacts,
    addFileWith,
    deps,
    query: (overrides) => createQuery(deps(overrides)),
    cleanup: async () => {
      writer.release();
      await store.close();
      tmp.cleanup();
      repo.cleanup();
    },
  };
}
