import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isInside } from '../src/facts/index.ts';
import { validateCorpora } from './corpus.ts';

/**
 * node scripts/corpus-fetch.ts <id> [--dest <dir>]
 *
 * Checks an eval corpus out at its manifest SHA (corpora/corpora.json) into a fresh temporary
 * directory and prints the directory. The recall harness and the size gates measure that
 * checkout, never a developer's own clone (a local gsd-core sits at a different, dirty commit),
 * so the numbers are comparable across runs.
 *
 * Dev-time tooling only: it uses the network. Every git call is an argument array, never a shell
 * string; the checkout is detached, depth 1, in a directory this call created and owns.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(repoRoot, 'corpora', 'corpora.json');

export type CorpusFetchErrorCode =
  | 'manifest_invalid'
  | 'unknown_corpus'
  | 'corpus_not_pinned'
  | 'destination_inside_repo'
  | 'fetch_failed';

export class CorpusFetchError extends Error {
  readonly code: CorpusFetchErrorCode;
  constructor(code: CorpusFetchErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CorpusFetchError';
    this.code = code;
  }
}

export interface FetchCorpusOptions {
  readonly id: string;
  /** Directory that will hold the fresh checkout directory. Created when absent. */
  readonly destination: string;
  /** Overrides the GitHub URL built from the manifest entry. For tests. */
  readonly remote?: string;
  /** Overrides corpora/corpora.json. For tests. */
  readonly manifest?: unknown;
}

export interface FetchedCorpus {
  /** The checkout directory this call created. */
  readonly dir: string;
  /** The commit it is checked out at; always the manifest SHA. */
  readonly sha: string;
}

/** The default remote of a manifest entry. */
export function corpusRemote(entry: { readonly repo: string }): string {
  return `https://github.com/${entry.repo}.git`;
}

interface PinnedEntry {
  readonly id: string;
  readonly repo: string;
  readonly sha: string;
}

function readManifest(injected: unknown): unknown {
  if (injected !== undefined) {
    return injected;
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
}

/** The pinned entry for `id`; throws for an unknown id or an entry whose status is not pinned. */
function pinnedEntry(manifest: unknown, id: string): PinnedEntry {
  const errors = validateCorpora(manifest);
  if (errors.length > 0) {
    throw new CorpusFetchError('manifest_invalid', errors.join('; '));
  }
  const corpora = (manifest as { corpora: Array<Record<string, unknown>> }).corpora;
  const entry = corpora.find((candidate) => candidate['id'] === id);
  if (entry === undefined) {
    const known = corpora.map((candidate) => String(candidate['id'])).join(', ');
    throw new CorpusFetchError('unknown_corpus', `no corpus "${id}" in the manifest (known: ${known})`);
  }
  if (entry['status'] !== 'pinned') {
    throw new CorpusFetchError(
      'corpus_not_pinned',
      `corpus "${id}" has status ${String(entry['status'])}; only a pinned corpus can be fetched (it has no repo or sha yet)`,
    );
  }
  return { id, repo: String(entry['repo']), sha: String(entry['sha']) };
}

/** realpath of `target`, resolving the nearest existing ancestor and appending the rest as written. */
function resolveThroughExisting(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      break;
    }
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  // `native`: on Windows the runner's temp directory is spelled with an 8.3 short name (`RUNNER~1`), which only the native
  // call expands, so the checkout path matches the one every other caller gets from `realpath` (found by plan 02-26 on Windows CI).
  return path.join(fs.realpathSync.native(existing), ...rest);
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: 10 * 60 * 1000,
  });
  return {
    ok: result.error === undefined && result.status === 0,
    stdout: result.stdout,
    stderr: result.error === undefined ? result.stderr : result.error.message,
  };
}

function removeDir(dir: string): void {
  // Windows keeps files locked briefly after a child exits, hence the retries.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Check corpus `id` out at its manifest SHA into a new directory under `destination` and return
 * it. A corpus that is not pinned, an unknown id, a destination inside this repository and a SHA
 * the remote does not have are all refused, and a failed fetch removes what it created.
 */
export async function fetchCorpus(options: FetchCorpusOptions): Promise<FetchedCorpus> {
  const entry = pinnedEntry(readManifest(options.manifest), options.id);

  const destination = resolveThroughExisting(options.destination);
  if (isInside(fs.realpathSync.native(repoRoot), destination)) {
    throw new CorpusFetchError(
      'destination_inside_repo',
      `${options.destination} is inside the repository working tree (${repoRoot}); a corpus checkout must never land in a checkout`,
    );
  }

  const remote = options.remote ?? corpusRemote(entry);
  fs.mkdirSync(destination, { recursive: true });
  const dir = fs.mkdtempSync(path.join(destination, `${entry.id}-`));
  try {
    const objectFormat = entry.sha.length === 64 ? 'sha256' : 'sha1';
    const steps: string[][] = [
      ['init', '--quiet', `--object-format=${objectFormat}`],
      ['remote', 'add', 'origin', remote],
      ['fetch', '--quiet', '--depth', '1', 'origin', entry.sha],
      ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
    ];
    for (const args of steps) {
      const result = git(args, dir);
      if (!result.ok) {
        throw new CorpusFetchError(
          'fetch_failed',
          `git ${args[0] === '-c' ? 'checkout' : (args[0] ?? '')} for ${entry.id} at ${entry.sha} from ${remote} failed: ${result.stderr.trim()}`,
        );
      }
    }
    const head = git(['rev-parse', 'HEAD'], dir);
    if (!head.ok || head.stdout.trim() !== entry.sha) {
      throw new CorpusFetchError(
        'fetch_failed',
        `${entry.id} checked out ${head.stdout.trim()} instead of the manifest SHA ${entry.sha}`,
      );
    }
    return { dir, sha: entry.sha };
  } catch (error) {
    removeDir(dir);
    throw error;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  const args = process.argv.slice(2);
  const destIndex = args.indexOf('--dest');
  const dest = destIndex >= 0 ? args[destIndex + 1] : undefined;
  const id = args.find((a, i) => !a.startsWith('--') && (destIndex < 0 || i !== destIndex + 1));
  if (id === undefined || (destIndex >= 0 && dest === undefined)) {
    process.stderr.write('usage: node scripts/corpus-fetch.ts <id> [--dest <dir>]\n');
    process.exitCode = 1;
  } else {
    const destination = dest ?? path.join(os.tmpdir(), 'gsd-atlas-corpora');
    fetchCorpus({ id, destination }).then(
      (result) => {
        process.stdout.write(`${result.dir}\n`);
      },
      (error: unknown) => {
        process.stderr.write(`corpus-fetch: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  }
}
