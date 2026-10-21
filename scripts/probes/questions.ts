/**
 * Fresh, unregistered probe questions. Unscored and exploratory: nothing here is part of any registered
 * question set. Wording follows the v2 key-set style (explicit counting rules); the keys are derived
 * elsewhere by the v2 oracle (`scripts/key-oracle/derive-v2.ts`).
 */
import { createHash } from 'node:crypto';

export type SymbolKind = 'callers' | 'references' | 'impact';
export type Candidate =
  | { kind: SymbolKind; symbol: string; definedIn: string; files: number }
  | { kind: 'emit' | 'emit-consumers'; source: string; files: number };

export interface ProbeKey {
  kind: string;
  symbol?: string;
  definedIn?: string;
  source?: string;
  depth?: number;
  granularity: 'file';
  equality: 'exact-set';
}

export interface ProbeQuestion {
  id: string;
  category: 'callers' | 'references' | 'impact' | 'emit';
  text: string;
  key: ProbeKey;
}

const FORM = 'Give your answer in the required JSON form.';

export function buildQuestion(id: string, c: Candidate): ProbeQuestion {
  switch (c.kind) {
    case 'callers':
      return {
        id,
        category: 'callers',
        text: `Which files call \`${c.symbol}\`, the function exported from \`${c.definedIn}\`? Include test files, plain JavaScript files and calls made through a renamed import. A different function that happens to share the name does not count. List each file once. ${FORM}`,
        key: { kind: 'callers', symbol: c.symbol, definedIn: c.definedIn, granularity: 'file', equality: 'exact-set' },
      };
    case 'references':
      return {
        id,
        category: 'references',
        text: `Which files refer to \`${c.symbol}\`, exported from \`${c.definedIn}\`? Count every use except its declaration (imports, calls, reads), including uses inside \`${c.definedIn}\`, and include test files and plain JavaScript files. List each file once; a different symbol with the same name does not count. A string literal that merely spells the name, such as a key in a data table or an index into an object, is not a use; only identifiers bound to the export count. ${FORM}`,
        key: { kind: 'references', symbol: c.symbol, definedIn: c.definedIn, granularity: 'file', equality: 'exact-set' },
      };
    case 'impact':
      return {
        id,
        category: 'impact',
        text: `List the files affected if the signature of \`${c.symbol}\` in \`${c.definedIn}\` changed, to depth two: files that call it directly, plus files that call any function exported by a \`.cts\` file that calls it directly. Include tests and plain JavaScript files; leave out \`${c.definedIn}\` itself. ${FORM}`,
        key: { kind: 'impact', symbol: c.symbol, definedIn: c.definedIn, depth: 2, granularity: 'file', equality: 'exact-set' },
      };
    case 'emit':
      return {
        id,
        category: 'emit',
        text: `The TypeScript build compiles \`${c.source}\` to a CommonJS file. At which path, relative to the repository root, does the build write the compiled file? ${FORM}`,
        key: { kind: 'emit', source: c.source, granularity: 'file', equality: 'exact-set' },
      };
    case 'emit-consumers':
      return {
        id,
        category: 'emit',
        text: `Which files in this repository \`require\` the compiled CommonJS module that the build produces from \`${c.source}\`? Include test files, plain JavaScript files and \`.cts\` sources that call \`require\`; list each file once. An \`import x = require('./m.cjs')\` declaration in a \`.cts\` file counts as \`require\`, and so does a \`require(...)\` call whose path resolves statically (a string literal, or a \`path.join\` of string literals and \`const\` strings). ES \`import\` statements, \`import()\` and text inside strings, including a \`require\` inside a string handed to a child process, do not count. ${FORM}`,
        key: { kind: 'emit-consumers', source: c.source, granularity: 'file', equality: 'exact-set' },
      };
  }
}

const nameOf = (c: Candidate): string => (c.kind === 'emit' || c.kind === 'emit-consumers' ? c.source : c.symbol);
const categoryOf = (c: Candidate): 'callers' | 'references' | 'impact' | 'emit' =>
  c.kind === 'emit-consumers' ? 'emit' : c.kind;

const hashOf = (seed: number, c: Candidate): string => createHash('sha256').update(`${String(seed)}|${c.kind}|${nameOf(c)}`).digest('hex');

/** Deterministic order by a seeded hash; independent of input order. */
export function orderCandidates(pool: readonly Candidate[], seed: number): Candidate[] {
  return [...pool].sort((a, b) => (hashOf(seed, a) < hashOf(seed, b) ? -1 : hashOf(seed, a) > hashOf(seed, b) ? 1 : 0));
}

/** At most one candidate per symbol or source name; none whose name is in `used`; per-category quota. */
export function pickFresh(
  pool: readonly Candidate[],
  used: ReadonlySet<string>,
  quota: Readonly<Record<'callers' | 'references' | 'impact' | 'emit', number>>,
  seed: number,
): Candidate[] {
  const left = { ...quota };
  const names = new Set<string>();
  const picked: Candidate[] = [];
  for (const c of orderCandidates(pool, seed)) {
    const name = nameOf(c);
    const cat = categoryOf(c);
    if (used.has(name) || names.has(name) || left[cat] <= 0) continue;
    left[cat] -= 1;
    names.add(name);
    picked.push(c);
  }
  return picked;
}
