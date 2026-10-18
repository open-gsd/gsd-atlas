/**
 * The repository config file `.gsd-atlas/config.json` (plan 03-28, ADR 5 amendment of 2026-10-18, point 4; trust-boundaries
 * ADR, amendment of the same date).
 *
 * A repository may carry this file for non-privileged settings only. In Phase 3 it honours one key, `adrDirs`: a list of at most
 * eight relative paths, under the manifest's own path rule, that replaces the module manifests' list for that repository. Every
 * other key is ignored, whatever it claims (permissions, commands, diagnostics, auto-submit, anything unknown), and the one fixed
 * diagnostic `repo_config_ignored` says so. A file that is oversized, not valid JSON or not an object is ignored whole.
 *
 * The file is untrusted data read through the Source Tree's confined reader. Nothing in it is executed, resolved or copied into an
 * answer: the diagnostic is fixed text and the directories it names are listed through the same confined listing as every other.
 */
import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import { MAX_ADR_DIRS, isRelativeAssetPath } from '../lang/index.ts';
import type { SourceTree } from '../source-tree/index.ts';

/** Where the file lives, relative to a worktree root. */
export const REPO_CONFIG_FILE = '.gsd-atlas/config.json';

/** The most bytes of the file that are read: a larger one is ignored whole. */
export const REPO_CONFIG_MAX_BYTES = 64 * 1024;

/** The code of the one diagnostic a read of the file can leave. */
export const REPO_CONFIG_IGNORED = 'repo_config_ignored';

/** Fixed text: it names no key, no value and no path the file held. */
export const REPO_CONFIG_IGNORED_MESSAGE =
  'The repository config file .gsd-atlas/config.json was read in part or not at all: only adrDirs is honoured, as a short list of relative paths inside the repository, and nothing else in the file has any effect.';

export interface RepoConfig {
  /** The honoured ADR directories, when the file named some; they replace the module manifests' list. */
  readonly adrDirs?: readonly string[];
  /** At most one `repo_config_ignored` note. */
  readonly diagnostics: readonly Diagnostic[];
}

const ignored = (): Diagnostic => diagnostic(REPO_CONFIG_IGNORED, 'info', REPO_CONFIG_IGNORED_MESSAGE);

/**
 * What the repository config says. Never throws: a tree that fails to read the file, a missing file and a file that is not a regular
 * file are the same as no config (no note for a file that is not there; a note for one that is there and unusable).
 */
export async function readRepoConfig(tree: Pick<SourceTree, 'readText'>, worktree: string): Promise<RepoConfig> {
  let read: Awaited<ReturnType<SourceTree['readText']>>;
  try {
    read = await tree.readText(worktree, REPO_CONFIG_FILE, { maxBytes: REPO_CONFIG_MAX_BYTES });
  } catch {
    return { diagnostics: [] };
  }
  if (read.kind === 'missing') return { diagnostics: [] };
  if (read.kind !== 'ok') return { diagnostics: [ignored()] };

  let parsed: unknown;
  try {
    // A leading byte order mark is data the reader keeps; JSON does not allow it.
    parsed = JSON.parse(read.text.charCodeAt(0) === 0xfeff ? read.text.slice(1) : read.text);
  } catch {
    return { diagnostics: [ignored()] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { diagnostics: [ignored()] };

  const record = parsed as Record<string, unknown>;
  let partial = Object.keys(record).some((key) => key !== 'adrDirs');
  let adrDirs: string[] | undefined;
  if (Object.hasOwn(record, 'adrDirs')) {
    const listed = record['adrDirs'];
    if (Array.isArray(listed)) {
      const valid = listed.filter(isRelativeAssetPath);
      if (valid.length !== listed.length) partial = true;
      if (valid.length > MAX_ADR_DIRS) partial = true;
      adrDirs = valid.slice(0, MAX_ADR_DIRS);
    } else {
      partial = true;
    }
  }
  return {
    ...(adrDirs === undefined ? {} : { adrDirs }),
    diagnostics: partial ? [ignored()] : [],
  };
}
