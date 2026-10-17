/**
 * History (STO-09): answer a code question about the repository as it was at a commit, from git alone.
 *
 * The commit is resolved with `rev-parse`, its tree is listed with `ls-tree`, the claimed-extension source files
 * are read with ONE `cat-file --batch` run, parsed by the same module host the Indexer uses, committed into a
 * throwaway Fact Store in a fresh temporary directory, answered by the unchanged Query code, and discarded. No
 * Tenant is opened: a request needs only a Source Tree, a module host and an engine, so it works on a repository
 * nobody indexed and in a process that is not the writer. The real store is never opened, never written and never
 * named, and nothing is fetched (every git spec pins lazy fetch and transport off; a missing object is
 * `commit_not_found`).
 *
 * Line text comes from the commit's own bytes held in memory for the request, so the citations show the
 * historical lines, at the positions of the historical content.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openFactStore } from '../fact-store/index.ts';
import type { Resolver } from '../fact-store/index.ts';
import { PROTOCOL_VERSION, diagnostic } from '../facts/index.ts';
import type { Clock, Diagnostic, Envelope, Request } from '../facts/index.ts';
import { DEFAULT_INDEXER_CONFIG } from '../indexer/index.ts';
import type { ModuleHost } from '../indexer/index.ts';
import { createQuery, errorEnvelope } from '../query/index.ts';
import { SOURCE_TREE_CODES, SourceTreeError } from '../source-tree/index.ts';
import type { ReadTextResult, SourceTree, TreeEntry } from '../source-tree/index.ts';
import { firstProblem, short } from './route.ts';

/** The request kind of a history question. The Host serves it in the `interactive` class. */
export const HISTORY_KIND = 'history';

/** Schema of a history answer: the Query envelope's fields under a history schema id. */
export const HISTORY_SCHEMA = 'gsd-atlas.history/1';

/** The tools history answers, each a Query tool without the `code_` prefix. */
export const HISTORY_TOOLS = ['find', 'refs', 'context', 'impact'] as const;

/** The most source files a whole-tree history question reads. Value: `history.maxFiles` in 02-CONSTANTS.md (Approved 2026-10-16). */
export const HISTORY_MAX_FILES = 2000;

/** How many distinct blobs are parsed at once; commits to the throwaway store stay sequential and in path order. */
const EXTRACT_CHUNK = 8;

/** The first bytes inspected for NUL, as Source Tree's source set does. */
const BINARY_PEEK_BYTES = 8192;

/** A history question has a Query tool's arguments plus the commit (`at`) and an optional single file (`path`). */
const text = z.string().min(1);
const historyArgs = z.strictObject({
  tool: z.enum(HISTORY_TOOLS),
  name: z.string().trim().min(1, 'name must not be empty'),
  at: text,
  path: text.optional(),
  repo: text.optional(),
  cwd: text.optional(),
  kind: text.optional(),
  mode: z.enum(['exact', 'prefix', 'fuzzy', 'auto']).optional(),
  limit: z.int().positive().optional(),
  depth: z.int().nonnegative().optional(),
  more: text.optional(),
  budget_tokens: z.int().positive().optional(),
});

export type HistoryArgs = z.infer<typeof historyArgs>;

/** Everything a history request needs. There is deliberately no store, no Tenant and no Indexer in here. */
export interface HistoryDeps {
  /** Reads git objects only; the real Source Tree of the repository. */
  readonly tree: SourceTree;
  /** Parses a file's text; the same module host the Indexer uses. */
  readonly modules: ModuleHost;
  readonly clock: Clock;
  /** The worktree the request resolved to. It only names the overlay inside the throwaway store, so Query ranks as it does live. */
  readonly worktree: string;
  /** The repository's name in symbol identities (its store id). Default: derived from the temporary directory. */
  readonly repoName?: string;
  /** Directories the throwaway store must not be inside (the repository and the real store). */
  readonly keepOut?: readonly string[];
  /** The directory the throwaway store is created under. Default: the operating system's temporary directory. */
  readonly tmpRoot?: string;
  /** Cap on source files read for a whole-tree question. Default: {@link HISTORY_MAX_FILES}. */
  readonly maxFiles?: number;
  /** Largest blob parsed, in bytes. Default: the Indexer's source cap. */
  readonly maxBlobBytes?: number;
  /** TEST HOOK. Supplies Query's per-response nonce. */
  readonly nonce?: () => string;
}

/** Phase 2 has no precise tier: the throwaway store resolves nothing, and every edge stays grammar-tier. */
const noPreciseTier: Resolver = async function* () {
  // resolves nothing
};

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The lower-case extension of the last path segment, with its dot, or '' (the rule Source Tree and the module host share). */
function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** True when `candidate` is `root` or lies below it. */
function isInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The `--path` value as a tree path, or null when it is not a plain repo-relative file path. */
function treePath(raw: string): string | null {
  const slashed = raw.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  if (slashed === '' || slashed.includes('\0') || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  if (slashed.split('/').some((segment) => segment === '..' || segment === '')) return null;
  return slashed;
}

const bad = (message: string): Envelope => errorEnvelope('invalid_args', message);

const notFound = (at: string): Envelope =>
  errorEnvelope('commit_not_found', short(`The revision "${short(at)}" names no commit that this repository holds; nothing was fetched.`));

/** The paths of one commit that share a blob: the blob is parsed once and the other paths are linked to its facts. */
interface Group {
  readonly oid: string;
  readonly paths: string[];
  readonly text: string;
}

export async function runHistory(deps: HistoryDeps, request: Request): Promise<Envelope> {
  const given = request.args === undefined || request.args === null ? {} : request.args;
  if (typeof given !== 'object' || Array.isArray(given)) return bad('args must be an object');
  const parsed = historyArgs.safeParse({
    ...given,
    ...(request.budget_tokens === undefined ? {} : { budget_tokens: request.budget_tokens }),
  });
  if (!parsed.success) return bad(firstProblem(parsed.error));
  const args = parsed.data;

  let onlyPath: string | undefined;
  if (args.path !== undefined) {
    const normal = treePath(args.path);
    if (normal === null) return bad('path: use a repo-relative file path inside the repository');
    onlyPath = normal;
  }

  // 1. The commit, from git objects only.
  let commit: string | null;
  try {
    commit = await deps.tree.resolveCommit(args.at);
  } catch (error) {
    if (error instanceof SourceTreeError && error.code === 'invalid_argument') return bad('at: not a usable revision name');
    return gitFailure(error);
  }
  if (commit === null) return notFound(args.at);

  // 2. Its tree, filtered to the files a loaded module claims (and to one file when --path names it).
  let entries: readonly TreeEntry[];
  try {
    entries = (await deps.tree.listTree(commit)).entries;
  } catch (error) {
    if (error instanceof SourceTreeError && error.code === SOURCE_TREE_CODES.commitNotFound) return notFound(args.at);
    return gitFailure(error);
  }
  const claimed = new Set(deps.modules.extensions());
  const wanted = entries
    .filter((entry) => claimed.has(extensionOf(entry.path)) && (onlyPath === undefined || entry.path === onlyPath))
    .sort((a, b) => compareCodeUnits(a.path, b.path));
  const cap = deps.maxFiles ?? HISTORY_MAX_FILES;
  const truncated = wanted.length > cap;
  const selected = truncated ? wanted.slice(0, cap) : wanted;

  // 3. ONE batched read of every selected blob.
  const maxBlobBytes = deps.maxBlobBytes ?? DEFAULT_INDEXER_CONFIG.maxFileBytes;
  let blobs: ReadonlyMap<string, Uint8Array | null>;
  try {
    blobs = (await deps.tree.readMany(commit, selected.map((entry) => entry.path), { maxBlobBytes })).blobs;
  } catch (error) {
    if (error instanceof SourceTreeError && error.code === SOURCE_TREE_CODES.commitNotFound) return notFound(args.at);
    return gitFailure(error);
  }

  let skipped = 0;
  const byOid = new Map<string, Group>();
  const texts = new Map<string, string>();
  for (const entry of selected) {
    const bytes = blobs.get(entry.path) ?? null;
    if (bytes === null || bytes.subarray(0, BINARY_PEEK_BYTES).includes(0)) {
      skipped += 1;
      continue;
    }
    const known = byOid.get(entry.oid);
    if (known !== undefined) {
      known.paths.push(entry.path);
      texts.set(entry.path, known.text);
      continue;
    }
    const content = decoder.decode(bytes);
    byOid.set(entry.oid, { oid: entry.oid, paths: [entry.path], text: content });
    texts.set(entry.path, content);
  }

  // 4. The throwaway store, outside the repository and the real store; always removed.
  const base = deps.tmpRoot ?? os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, 'gsd-atlas-history-'));
  try {
    const realDir = fs.realpathSync.native(dir);
    for (const forbidden of deps.keepOut ?? []) {
      let real: string;
      try {
        real = fs.realpathSync.native(forbidden);
      } catch {
        real = forbidden;
      }
      if (isInside(realDir, real)) {
        return errorEnvelope(
          'history_unavailable',
          'The temporary directory is inside the repository or its index, so history refuses to write there. Set TMPDIR to a directory elsewhere.',
        );
      }
    }
    const store = await openFactStore(
      dir,
      { resolver: noPreciseTier, clock: deps.clock, gitHas: () => Promise.resolve(true) },
      { lease: 'none', ...(deps.repoName === undefined ? {} : { repo: deps.repoName }) },
    );
    try {
      const overlay = new Map<string, string>();
      const writer = store.writer();
      try {
        const groups = [...byOid.values()];
        for (let at = 0; at < groups.length; at += EXTRACT_CHUNK) {
          const chunk = groups.slice(at, at + EXTRACT_CHUNK);
          const outcomes = await Promise.all(chunk.map((group) => deps.modules.extract(group.paths[0] as string, group.text, group.oid)));
          for (const [i, group] of chunk.entries()) {
            const outcome = outcomes[i];
            const first = group.paths[0] as string;
            if (outcome?.kind !== 'facts') {
              skipped += group.paths.length;
              continue;
            }
            const done = await writer.commitFile({ worktree: deps.worktree, path: first, hash: group.oid, facts: outcome.facts });
            if (done.status === 'rejected') {
              skipped += group.paths.length;
              continue;
            }
            overlay.set(first, group.oid);
            for (const other of group.paths.slice(1)) {
              const linked = await writer.link(deps.worktree, other, group.oid);
              if (linked.status === 'rejected') skipped += 1;
              else overlay.set(other, group.oid);
            }
          }
        }
        await writer.setOverlay(deps.worktree, `history:${commit}`, new Map([...overlay].sort(([a], [b]) => compareCodeUnits(a, b))));
      } finally {
        writer.release();
      }

      // 5. The same Query code, over the historical content.
      const query = createQuery({
        store,
        text: { readText: (_worktree, rel, options): Promise<ReadTextResult> => Promise.resolve(historicText(texts, rel, options?.maxBytes)) },
        clock: deps.clock,
        ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
      });
      const answered = await query.ask({
        protocol: PROTOCOL_VERSION,
        kind: `code_${args.tool}`,
        args: toolArgs(args),
        worktree: deps.worktree,
        ...(args.budget_tokens === undefined ? {} : { budget_tokens: args.budget_tokens }),
      });
      if (!answered.ok) return answered;

      const warnings: Diagnostic[] = truncated
        ? [
            diagnostic(
              'history_truncated',
              'warning',
              `The commit has ${String(wanted.length)} source files; only the first ${String(cap)} in path order were read. Ask with --path to read one file.`,
            ),
          ]
        : [];
      return {
        ...answered,
        schema: HISTORY_SCHEMA,
        diagnostics: [...answered.diagnostics, ...warnings],
        ...(truncated || answered.truncated === true ? { truncated: true } : {}),
        hints: [
          `This answer is from commit ${commit.slice(0, 12)} as it was then; the working tree and the index were not consulted.`,
          ...emptyHints(onlyPath, wanted.length, overlay.size, skipped, claimed.size),
          ...(truncated ? [`Only the first ${String(cap)} source files of the commit were read; pass --path to ask about one file.`] : []),
          ...(answered.hints ?? []),
        ],
      };
    } finally {
      await store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The arguments Query's strict schema takes for the tool: everything defined except the history-only and Host-only keys. */
function toolArgs(args: HistoryArgs): Record<string, unknown> {
  const out: Record<string, unknown> = { name: args.name };
  for (const key of ['kind', 'mode', 'limit', 'depth', 'cwd', 'more'] as const) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

/** The text of `rel` as the commit had it, in the shape Query's text port answers. */
function historicText(texts: ReadonlyMap<string, string>, rel: string, maxBytes: number | undefined): ReadTextResult {
  const content = texts.get(rel);
  if (content === undefined) return { kind: 'missing' };
  if (maxBytes !== undefined && Buffer.byteLength(content) > maxBytes) return { kind: 'too_large' };
  return { kind: 'ok', text: content };
}

/** Why an answer may be empty, in fixed sentences. */
function emptyHints(onlyPath: string | undefined, claimedFiles: number, indexed: number, skipped: number, extensions: number): string[] {
  const hints: string[] = [];
  if (onlyPath !== undefined && claimedFiles === 0) hints.push('That path is not a source file of this commit, or no loaded language module claims its extension.');
  else if (claimedFiles === 0) {
    hints.push(extensions === 0 ? 'No language module is loaded, so no file could be read.' : 'No source file of this commit is claimed by a loaded language module.');
  }
  if (skipped > 0) hints.push(`${String(skipped)} of ${String(claimedFiles)} source files could not be used (binary, over the size cap or not parsable) and are not in this answer.`);
  if (claimedFiles > 0 && indexed === 0) hints.push('None of the commit\'s source files could be parsed.');
  return hints;
}

function gitFailure(error: unknown): Envelope {
  if (error instanceof SourceTreeError) return errorEnvelope('git_failed', 'git could not read that commit.');
  throw error;
}
