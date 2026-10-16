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
import type { FileFacts, LocalSymbol } from '../facts/index.ts';
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
  };
}

function factsOf(relPath: string, hash: string, symbols: readonly SymbolSpec[]): FileFacts {
  return {
    path: relPath,
    contentHash: hash,
    module: 'typescript',
    grammarVersion: '0.23.2',
    symbols: symbols.map(localSymbol),
    refSites: [],
    imports: [],
    exports: [],
    parse: { errorBytes: 0, totalBytes: 0 },
  };
}

export async function createHarness(): Promise<Harness> {
  const repo = await createTempGitRepo({ runner: setupRunner });
  const tmp = makeTempDir();
  const clock = new FakeClock(1000);
  const store = await openFactStore(
    path.join(tmp.path, 'store'),
    { resolver: noResolver, clock, gitHas: () => Promise.resolve(true) },
    { repo: 'toy', version: 'test' },
  );
  const tree = createSourceTree({ runner: createRealRunner(), repoDir: repo.dir, envOverlay: repo.envOverlay });
  const writer = store.writer();
  const dir = repo.dir;

  const addFacts = async (relPath: string, hash: string, symbols: readonly SymbolSpec[]): Promise<void> => {
    const result = await writer.commitFile({ worktree: dir, path: relPath, hash, facts: factsOf(relPath, hash, symbols) });
    if (result.status === 'rejected') throw new Error(`the harness facts for ${relPath} were rejected`);
  };
  const deps = (overrides: Partial<QueryDeps> = {}): QueryDeps => ({ store, text: tree, clock, ...overrides });

  return {
    dir,
    repo,
    store,
    tree,
    clock,
    writer,
    addFile: async (relPath, content, symbols) => {
      repo.write(relPath, content);
      const hash = blobId(content);
      await addFacts(relPath, hash, symbols);
      return hash;
    },
    addFacts,
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
