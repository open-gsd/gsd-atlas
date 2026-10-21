/**
 * Census of the ambiguous tail of an angular checkout, for an UNSCORED, UNREGISTERED pilot. Zero model cost.
 * `node scripts/angular-pilot/census.ts --repo <checkout> --out <json>`: reads tracked files with `git ls-files`
 * and `git show` (nothing from the checkout is executed), parses syntax only, and for each name declared in
 * at least two pilot source files measures what a whole-word search returns (files) and what the compiler
 * oracle (oracle-lib.ts) says about call sites and direct subtypes of its first declaration.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { censusOfSource, createPilotOracle, type Decl, type HeritageRow } from './oracle-lib.ts';

export type { Decl, HeritageRow };

/** The pilot's scope: framework sources under `packages/`, no tests, no schematics, no examples, no `.d.ts`. */
export function isPilotSource(rel: string): boolean {
  if (!rel.startsWith('packages/')) return false;
  if (!/\.(ts|tsx)$/.test(rel) || rel.endsWith('.d.ts')) return false;
  if (rel.endsWith('.spec.ts') || rel.endsWith('_spec.ts')) return false;
  if (/(^|\/)(test|schematics|integrationtest|examples)\//.test(rel)) return false;
  return true;
}

export interface AmbiguousName {
  name: string;
  files: string[];
  kinds: string[];
}

export function ambiguousNames(decls: readonly Decl[]): AmbiguousName[] {
  const by = new Map<string, { files: Set<string>; kinds: Set<string> }>();
  for (const d of decls) {
    const e = by.get(d.name) ?? { files: new Set<string>(), kinds: new Set<string>() };
    e.files.add(d.file);
    e.kinds.add(d.kind);
    by.set(d.name, e);
  }
  return [...by.entries()]
    .filter(([, e]) => e.files.size >= 2)
    .map(([name, e]) => ({ name, files: [...e.files].sort(), kinds: [...e.kinds].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface SupplyRow extends AmbiguousName {
  grepFiles: number;
  callSiteFiles: number;
  subtypeCount: number;
}

export interface Window {
  minGrepFiles: number;
  maxGrepFiles: number;
  minKey: number;
  maxKey: number;
}

export function supplyByCategory(rows: readonly SupplyRow[], w: Window): { callers: number; references: number; heritage: number; definition: number } {
  const inWindow = rows.filter((r) => r.grepFiles >= w.minGrepFiles && r.grepFiles <= w.maxGrepFiles);
  const callable = (r: SupplyRow): boolean => r.kinds.includes('function') || r.kinds.includes('const');
  return {
    callers: inWindow.filter((r) => callable(r) && r.callSiteFiles >= w.minKey && r.callSiteFiles <= w.maxKey).length,
    references: inWindow.length,
    heritage: inWindow.filter((r) => (r.kinds.includes('class') || r.kinds.includes('interface')) && r.subtypeCount >= w.minKey && r.subtypeCount <= w.maxKey).length,
    definition: inWindow.length,
  };
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

/** Number of tracked files (whole repo, tests and docs included) that contain `name` as a whole word. */
function grepFileCount(repo: string, name: string): number {
  const r = spawnSync('git', ['-C', repo, 'grep', '-l', '-w', '-F', '-e', name], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status === 1) return 0;
  if (r.status !== 0) throw new Error('git grep failed');
  return r.stdout.split('\n').filter((l) => l !== '').length;
}

function main(): void {
  const { values } = parseArgs({ options: { repo: { type: 'string' }, out: { type: 'string' }, 'max-names': { type: 'string' } } });
  if (values.repo === undefined || values.out === undefined) throw new Error('usage: --repo <checkout> --out <json> [--max-names N]');
  const repo = values.repo;
  const tracked = git(repo, ['ls-files', 'packages']).split('\n').filter(isPilotSource);
  const decls: Decl[] = [];
  const heritage: HeritageRow[] = [];
  for (const rel of tracked) {
    const c = censusOfSource(rel, fs.readFileSync(`${repo}/${rel}`, 'utf8'));
    decls.push(...c.decls);
    heritage.push(...c.heritage);
  }
  const amb = ambiguousNames(decls).filter((a) => a.name.length >= 3);
  const limit = values['max-names'] === undefined ? amb.length : Number(values['max-names']);
  const oracle = createPilotOracle({ root: repo, tsconfig: 'packages/tsconfig.json', include: (r) => isPilotSource(r), files: tracked });
  const rows: (SupplyRow & { declFile: string; declKind: string })[] = [];
  const grepCache = new Map<string, number>();
  for (const a of amb.slice(0, limit)) {
    grepCache.set(a.name, grepFileCount(repo, a.name));
    // every declaration of an ambiguous name is its own candidate target
    for (const d of decls.filter((x) => x.name === a.name)) {
      let callSiteFiles = 0;
      let subtypeCount = 0;
      try {
        if (d.kind === 'function' || d.kind === 'const') callSiteFiles = new Set(oracle.callSites(d.file, a.name).map((r) => r.file)).size;
        if (d.kind === 'class' || d.kind === 'interface') subtypeCount = oracle.directSubtypes(d.file, a.name).length;
      } catch {
        // not a plain top-level declaration the oracle can locate; counts stay zero
      }
      rows.push({ name: a.name, files: a.files, kinds: [d.kind], declFile: d.file, declKind: d.kind, grepFiles: grepCache.get(a.name)!, callSiteFiles, subtypeCount });
    }
  }
  fs.writeFileSync(values.out, `${JSON.stringify({ trackedPilotFiles: tracked.length, exportedDecls: decls.length, ambiguous: amb.length, rows }, null, 1)}\n`);
  process.stdout.write(`files ${tracked.length} decls ${decls.length} ambiguous ${amb.length} measured ${rows.length}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
