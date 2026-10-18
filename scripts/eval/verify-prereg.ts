/**
 * node scripts/eval/verify-prereg.ts [--prereg <path>] [--draft]
 *
 * The mechanical form of the freeze (D-04, D-09, D-23). It reads the single `prereg-json` block of the
 * pre-registration (default docs/eval/preregistration.md), recomputes the sha256 of every registered file with line
 * endings normalised to LF, and fails when any differs, when a Frozen block lacks its hashes, when a Stage B record
 * refers to a Stage A that is not frozen, or when the Stage B skill hash does not match the skill file.
 *
 * With --draft only the block itself is checked (schema and internal consistency): no registered file is read, and
 * an absent pre-registration is nothing to check. Exit 0 when ok, 1 with the problems printed one per line, 2 for a
 * usage error or an absent pre-registration without --draft.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PREREG_PATH, hashFile, readPrereg, SKILL_PATH, STAGE_A_FILES } from './prereg.ts';
import type { Prereg } from './prereg.ts';

export interface VerifyResult {
  readonly ok: boolean;
  /** Each one names the path or field at fault. */
  readonly problems: string[];
  /** Things that are fine for a Draft but would be problems in a Frozen block. */
  readonly notes: string[];
}

export interface VerifyOptions {
  /** Check the block only: no registered file is read. */
  readonly draft?: boolean;
}

/** Output sinks, injected so tests can run the command in-process. */
export interface Io {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** The repository root, two levels above scripts/eval. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * The absolute path of a registered repository-relative path, or null when it is not a plain relative POSIX path
 * that stays inside `root` (absolute, drive-lettered, backslashed or `..` paths are never read).
 */
function insideRoot(root: string, rel: string): string | null {
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) return null;
  const segments = rel.split('/');
  if (segments.includes('..') || segments.includes('') || segments.includes('.')) return null;
  const resolved = path.resolve(root, ...segments);
  const base = path.resolve(root);
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function short(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Checks the pre-registration at `preregPath` against the files under `root`. Never throws for a bad
 * pre-registration: an unreadable file, an invalid block or a schema violation is a problem like any other.
 */
export function verifyPrereg(preregPath: string, root: string, options: VerifyOptions = {}): VerifyResult {
  const problems: string[] = [];
  const notes: string[] = [];
  let prereg: Prereg;
  try {
    prereg = readPrereg(preregPath);
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)], notes };
  }

  // Stage A must be frozen for a Frozen block and for any Stage B record (which builds on it).
  const stageAFrozen = prereg.status === 'Frozen' || prereg.stage === 'B';
  const registered = Object.keys(prereg.files).sort();

  for (const rel of registered) {
    if (insideRoot(root, rel) === null) problems.push(`registered path is outside the repository root or not a plain relative path: ${rel}`);
  }
  const unregistered = STAGE_A_FILES.filter((rel) => prereg.files[rel] === undefined);
  if (stageAFrozen) {
    for (const rel of unregistered) problems.push(`Stage A file not registered: ${rel}`);
    if (prereg.stage === 'B' && unregistered.length > 0) {
      problems.push(
        `Stage B record refers to a Stage A that is not frozen: ${String(unregistered.length)} of ${String(STAGE_A_FILES.length)} Stage A files have no registered hash`,
      );
    }
    if (prereg.stage === 'A' && registered.length === 0) problems.push('Frozen preregistration lacks its hashes: no file is registered');
  } else {
    for (const rel of unregistered) notes.push(`not registered yet: ${rel}`);
  }

  if (options.draft === true) return { ok: problems.length === 0, problems, notes };

  for (const rel of registered) {
    const file = insideRoot(root, rel);
    if (file === null) continue; // already reported
    if (!isFile(file)) {
      if (stageAFrozen) problems.push(`missing file: ${rel}`);
      else notes.push(`not present yet: ${rel}`);
      continue;
    }
    const now = hashFile(file);
    const was = prereg.files[rel] as string;
    if (now !== was) problems.push(`changed file: ${rel} (registered ${short(was)}, now ${short(now)})`);
  }

  if (prereg.stageB !== undefined) {
    const skill = insideRoot(root, SKILL_PATH) as string;
    if (!isFile(skill)) {
      if (prereg.status === 'Frozen') problems.push(`missing file: ${SKILL_PATH}`);
      else notes.push(`not present yet: ${SKILL_PATH}`);
    } else {
      const now = hashFile(skill);
      if (now !== prereg.stageB.skillSha256) {
        problems.push(`changed file: ${SKILL_PATH} (registered ${short(prereg.stageB.skillSha256)}, now ${short(now)})`);
      }
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

const USAGE = 'usage: node scripts/eval/verify-prereg.ts [--prereg <path>] [--draft]\n';

/** The command body. Returns the exit code. */
export function runCli(argv: string[], io: Io, root: string): number {
  let values: { prereg?: string | undefined; draft?: boolean | undefined };
  try {
    values = parseArgs({ args: argv, options: { prereg: { type: 'string' }, draft: { type: 'boolean' } }, strict: true, allowPositionals: false }).values;
  } catch (error) {
    io.err(`verify-prereg: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const given = values.prereg ?? DEFAULT_PREREG_PATH;
  const file = path.resolve(root, given);
  const draft = values.draft === true;
  if (!isFile(file)) {
    if (draft) {
      io.out(`verify-prereg: no preregistration at ${given} (draft mode): nothing to check\n`);
      return 0;
    }
    io.err(`verify-prereg: no preregistration at ${given}; write it, or pass --draft to check before the freeze\n`);
    return 2;
  }
  const result = verifyPrereg(file, root, { draft });
  for (const note of result.notes) io.out(`note: ${note}\n`);
  if (!result.ok) {
    for (const problem of result.problems) io.err(`${problem}\n`);
    return 1;
  }
  io.out(`verify-prereg: ok${draft ? ' (draft mode: block only)' : ''}\n`);
  return 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
}

if (isEntryPoint()) {
  process.exitCode = runCli(
    process.argv.slice(2),
    { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
    REPO_ROOT,
  );
}
