/**
 * Prototype keys for sample pilot questions (UNSCORED, UNREGISTERED). For each spec `kind:name@declaring/file.ts`
 * it prints the compiler oracle's key (files) and the files a whole-word `git grep` finds in the same scope, so a
 * human can read the files where they differ. Nothing in the checkout is executed.
 *
 *   node scripts/angular-pilot/sample-keys.ts --repo <checkout> --out <json> callers:name@file references:name@file heritage:name@file
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { isPilotSource } from './census.ts';
import { createPilotOracle } from './oracle-lib.ts';

/** The scope of a sample run: framework sources, spec and test files only when asked. */
export function scopePredicate(withTests: boolean): (rel: string) => boolean {
  return (rel) => isPilotSource(rel, { tests: withTests });
}

export type SampleKind ='callers' | 'references' | 'heritage';

export function parseSampleSpec(spec: string): { kind: SampleKind; name: string; file: string } {
  const m = /^([a-z]+):([^@]+)@(.+)$/.exec(spec);
  if (m === null) throw new Error(`bad spec ${spec}`);
  if (m[1] !== 'callers' && m[1] !== 'references' && m[1] !== 'heritage') throw new Error(`unknown kind ${m[1]}`);
  return { kind: m[1], name: m[2]!, file: m[3]! };
}

export function compareKeyToGrep(key: readonly string[], grep: readonly string[]): { inBoth: string[]; keyOnly: string[]; grepOnly: string[] } {
  const k = new Set(key);
  const g = new Set(grep);
  return {
    inBoth: [...k].filter((f) => g.has(f)).sort(),
    keyOnly: [...k].filter((f) => !g.has(f)).sort(),
    grepOnly: [...g].filter((f) => !k.has(f)).sort(),
  };
}

function grepScope(repo: string, name: string, inScope: (rel: string) => boolean): string[] {
  const r = spawnSync('git', ['-C', repo, 'grep', '-l', '-w', '-F', '-e', name, '--', 'packages'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status === 1) return [];
  return r.stdout.split('\n').filter((l) => l !== '' && inScope(l));
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { repo: { type: 'string' }, out: { type: 'string' }, 'with-tests': { type: 'boolean' } },
    allowPositionals: true,
  });
  if (values.repo === undefined || values.out === undefined || positionals.length === 0) throw new Error('usage: --repo R --out J [--with-tests] spec...');
  const repo = values.repo;
  const inScope = scopePredicate(values['with-tests'] === true);
  const tracked = spawnSync('git', ['-C', repo, 'ls-files', 'packages'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\n').filter(inScope);
  const oracle = createPilotOracle({ root: repo, tsconfig: 'packages/tsconfig.json', include: inScope, files: tracked });
  const out = [];
  for (const spec of positionals) {
    const s = parseSampleSpec(spec);
    let key: string[];
    let detail: unknown;
    if (s.kind === 'callers') {
      const calls = oracle.callSites(s.file, s.name);
      key = [...new Set(calls.map((c) => c.file))].sort();
      detail = calls.map((c) => `${c.file}:${c.line}`);
    } else if (s.kind === 'references') {
      const refs = oracle.references(s.file, s.name).filter((r) => !r.isDefinition);
      key = [...new Set(refs.map((c) => c.file))].sort();
      detail = refs.map((c) => `${c.file}:${c.line}`);
    } else {
      const subs = oracle.directSubtypes(s.file, s.name);
      key = [...new Set(subs.map((c) => c.file))].sort();
      detail = subs.map((c) => `${c.file}:${c.line} ${c.cls}`);
    }
    const grep = grepScope(repo, s.name, inScope);
    out.push({ spec, key, detail, grepFiles: grep.length, ...compareKeyToGrep(key, grep) });
  }
  fs.writeFileSync(values.out, `${JSON.stringify({ unresolved: oracle.unresolvedSpecifiers(), samples: out }, null, 1)}\n`);
  for (const o of out) process.stdout.write(`${o.spec}: key ${o.key.length} files, grep ${o.grepFiles}, grep-only ${o.grepOnly.length}, key-only ${o.keyOnly.length}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
