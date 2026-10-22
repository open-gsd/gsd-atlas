/**
 * Prepares the angular checkout for pilot sessions (UNSCORED, UNREGISTERED; plan section 4): exports the pinned tree
 * with `git archive`, removes the agent-config files an agent could read instead of the code, records what was
 * removed and a manifest hash, and commits one clean tree (atlas needs blob ids). No code of the checkout is run.
 *
 *   node scripts/angular-pilot/prepare-checkout.ts --repo <clone> --sha <sha> --dest <empty dir> --scratch <dir>
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const STRIP_RULES = {
  /** File names removed at any depth (compared case-insensitively). */
  names: ['agents.md', 'gemini.md', 'claude.md', '.mcp.json', 'context7.json'],
  /** Directory names whose whole subtree is removed at any depth. */
  dirs: ['.agent', '.gemini', '.claude', '.cursor'],
  /** Directories removed only at the repository root. */
  rootDirs: ['skills'],
  /** Base-name pattern removed at any depth. */
  llms: /^llms.*\.txt$/i,
} as const;

export function shouldStrip(rel: string): { strip: boolean; rule?: string } {
  const parts = rel.split('/');
  const base = parts[parts.length - 1]!;
  if ((STRIP_RULES.names as readonly string[]).includes(base.toLowerCase())) return { strip: true, rule: `name ${base}` };
  if (STRIP_RULES.llms.test(base)) return { strip: true, rule: 'llms*.txt' };
  for (const d of parts.slice(0, -1)) if ((STRIP_RULES.dirs as readonly string[]).includes(d)) return { strip: true, rule: `dir ${d}/` };
  if (parts.length > 1 && (STRIP_RULES.rootDirs as readonly string[]).includes(parts[0]!)) return { strip: true, rule: `root dir ${parts[0]!}/` };
  return { strip: false };
}

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (rel === '' && e.name === '.git') continue;
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out;
}

function pruneEmptyDirs(root: string, rel = ''): boolean {
  const abs = path.join(root, rel);
  let empty = true;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (rel === '' && e.name === '.git') {
      empty = false;
      continue;
    }
    if (e.isDirectory() && pruneEmptyDirs(root, r)) fs.rmdirSync(path.join(root, r));
    else empty = false;
  }
  return empty;
}

/** sha256 over the sorted `path NUL sha256(content)` lines of every file outside `.git`. */
export function manifestHash(dir: string): string {
  const lines = listFiles(dir)
    .sort()
    .map((rel) => {
      const abs = path.join(dir, rel);
      const body = fs.lstatSync(abs).isSymbolicLink() ? Buffer.from(`link:${fs.readlinkSync(abs)}`) : fs.readFileSync(abs);
      return `${rel}\0${createHash('sha256').update(body).digest('hex')}\n`;
    });
  return createHash('sha256').update(lines.join('')).digest('hex');
}

/** Throws when a CLAUDE.md, AGENTS.md, `.claude` directory or `.mcp.json` is left anywhere in the tree. */
export function assertClean(dir: string): void {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (rel === '' && e.name === '.git') continue;
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      const lower = e.name.toLowerCase();
      if (lower === 'claude.md' || lower === 'agents.md' || lower === '.mcp.json' || (e.isDirectory() && lower === '.claude')) found.push(r);
      else if (e.isDirectory()) walk(r);
    }
  };
  walk('');
  if (found.length > 0) throw new Error(`agent config left in the prepared tree: ${found.join(', ')}`);
}

export interface PrepRecord {
  sha: string;
  /** Files in the exported tree before stripping. */
  treeFileCount: number;
  /** Files left after stripping. */
  fileCount: number;
  strippedPaths: string[];
  manifestSha256: string;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export function prepareCheckout(input: { repo: string; sha: string; dest: string; scratch: string }): PrepRecord {
  const dest = path.resolve(input.dest);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error(`${input.dest} is not empty`);
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(input.scratch, { recursive: true });
  const tar = path.join(input.scratch, 'export.tar');
  git(input.repo, ['archive', '--format=tar', '-o', tar, input.sha]);
  const x = spawnSync('tar', ['-xf', tar, '-C', dest], { encoding: 'utf8' });
  if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
  fs.rmSync(tar, { force: true });
  const all = listFiles(dest);
  const stripped = all.filter((r) => shouldStrip(r).strip).sort();
  for (const rel of stripped) fs.rmSync(path.join(dest, rel), { force: true });
  pruneEmptyDirs(dest);
  assertClean(dest);
  const manifestSha256 = manifestHash(dest);
  git(dest, ['init', '-q', '-b', 'main']);
  git(dest, ['add', '-A']);
  git(dest, ['-c', 'user.name=angular-pilot', '-c', 'user.email=angular-pilot@example.invalid', 'commit', '-q', '-m', `angular ${input.sha} prepared for the pilot`]);
  return { sha: input.sha, treeFileCount: all.length, fileCount: all.length - stripped.length, strippedPaths: stripped, manifestSha256 };
}

function main(): void {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, sha: { type: 'string' }, dest: { type: 'string' }, scratch: { type: 'string' }, record: { type: 'string' } } });
  if (values.repo === undefined || values.sha === undefined || values.dest === undefined || values.scratch === undefined) throw new Error('usage: --repo R --sha S --dest D --scratch T [--record json]');
  const rec = prepareCheckout({ repo: values.repo, sha: values.sha, dest: values.dest, scratch: values.scratch });
  if (values.record !== undefined) fs.writeFileSync(values.record, `${JSON.stringify(rec, null, 2)}\n`);
  process.stdout.write(`prepared ${values.dest}: ${String(rec.fileCount)} of ${String(rec.treeFileCount)} files kept, ${String(rec.strippedPaths.length)} stripped, manifest ${rec.manifestSha256}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
