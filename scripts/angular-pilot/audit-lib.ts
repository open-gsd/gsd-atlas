/**
 * Helpers for the key audit of the angular pilot (UNSCORED, UNREGISTERED): a text-level reading of the checkout that
 * does not use the TypeScript checker, so the audit is independent of the oracle it audits. Whole-word `git grep`
 * finds the files; these functions classify the matching lines and follow import and re-export chains by text.
 */
import path from 'node:path';

export interface FileView {
  read(rel: string): string | undefined;
  exists(rel: string): boolean;
}

export type LineKind = 'comment' | 'string' | 'import' | 'export-from' | 'export-local' | 'member' | 'key' | 'code';
export interface KindedLine {
  line: number;
  kind: LineKind;
  text: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordRe(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, 'g');
}

/** Line ranges (1-based, inclusive) of import statements, `export ... from` statements and local `export { }` lists. */
function statementRanges(text: string): { start: number; end: number; kind: 'import' | 'export-from' | 'export-local' }[] {
  const out: { start: number; end: number; kind: 'import' | 'export-from' | 'export-local' }[] = [];
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
  const add = (re: RegExp, kind: 'import' | 'export-from' | 'export-local'): void => {
    for (const m of text.matchAll(re)) {
      const start = lineOf(m.index);
      const end = start + m[0].split('\n').length - 1;
      if (!out.some((r) => r.start <= start && r.end >= end)) out.push({ start, end, kind });
    }
  };
  add(/^import\b[^'";]*?\bfrom\s*['"][^'"]*['"]/gm, 'import');
  add(/^export\b[^'";{}]*?(?:\{[^}]*\})?[^'";{}]*?\bfrom\s*['"][^'"]*['"]/gm, 'export-from');
  add(/^export\s*(?:type\s*)?\{[^}]*\}(?!\s*from)/gm, 'export-local');
  return out;
}

/** Every line that spells `name` as a whole word, with what kind of mention it is (text level only). */
export function lineKinds(text: string, name: string): KindedLine[] {
  const lines = text.split('\n');
  const ranges = statementRanges(text);
  const re = wordRe(name);
  const out: KindedLine[] = [];
  let inBlock = false;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const startedInBlock = inBlock;
    // comment state at the end of this line, and the index where code starts on it
    let codeFrom = 0;
    let probe = startedInBlock;
    let idx = 0;
    const commentSpans: [number, number][] = [];
    let spanStart = startedInBlock ? 0 : -1;
    while (idx < raw.length) {
      if (probe) {
        const end = raw.indexOf('*/', idx);
        if (end < 0) {
          idx = raw.length;
        } else {
          commentSpans.push([spanStart, end + 2]);
          spanStart = -1;
          idx = end + 2;
          probe = false;
        }
      } else if (raw.startsWith('/*', idx)) {
        probe = true;
        spanStart = idx;
        idx += 2;
      } else if (raw.startsWith('//', idx)) {
        commentSpans.push([idx, raw.length]);
        idx = raw.length;
      } else if (raw[idx] === "'" || raw[idx] === '"' || raw[idx] === '`') {
        const q = raw[idx]!;
        idx += 1;
        while (idx < raw.length && raw[idx] !== q) idx += raw[idx] === '\\' ? 2 : 1;
        idx += 1;
      } else {
        idx += 1;
      }
    }
    if (probe) commentSpans.push([spanStart < 0 ? 0 : spanStart, raw.length]);
    inBlock = probe;
    void codeFrom;
    codeFrom = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let kind: LineKind | undefined;
    while ((m = re.exec(raw)) !== null) {
      const at = m.index;
      const inComment = commentSpans.some(([a, b]) => at >= a && at < b);
      if (inComment) {
        kind ??= 'comment';
        continue;
      }
      // inside a quote?
      let q: string | null = null;
      for (let k = 0; k < at; k += 1) {
        const ch = raw[k]!;
        if (q === null && (ch === "'" || ch === '"' || ch === '`')) q = ch;
        else if (q !== null && ch === q && raw[k - 1] !== '\\') q = null;
      }
      if (q !== null) {
        kind ??= 'string';
        continue;
      }
      const range = ranges.find((r) => r.start <= lineNo && r.end >= lineNo);
      if (range !== undefined) {
        kind = range.kind;
        break;
      }
      const before = raw.slice(0, at).trimEnd();
      const prev = before.slice(-1);
      if (before.endsWith('.') || before.endsWith('?.')) {
        kind = 'member';
        break;
      }
      const after = raw.slice(at + name.length);
      if (/^\s*\??:/.test(after) && (prev === '' || prev === '{' || prev === ',' || prev === '(' || prev === ';')) {
        kind = 'key';
        break;
      }
      kind = 'code';
      break;
    }
    if (kind !== undefined) out.push({ line: lineNo, kind, text: raw.trim() });
  });
  return out;
}

const ALIAS_NONE: Readonly<Record<string, string>> = {};

/** Resolves an import specifier to a tracked file, through relative paths and a prefix map (`@angular/` -> `packages/`). */
export function resolveSpecifier(from: string, spec: string, view: FileView, aliases: Readonly<Record<string, string>> = ALIAS_NONE): string | undefined {
  let base: string | undefined;
  if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else {
    for (const [prefix, target] of Object.entries(aliases)) if (spec.startsWith(prefix)) base = `${target}${spec.slice(prefix.length)}`;
  }
  if (base === undefined) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) if (view.exists(candidate) && candidate.endsWith('.ts')) return candidate;
  return undefined;
}

const DECLARES = (name: string): RegExp =>
  new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|enum|const|let|var|type|namespace)\\s+${escapeRe(name)}(?![\\w$])`, 'm');

export function declaresTopLevel(text: string, name: string): boolean {
  return DECLARES(name).test(text);
}

function specifiersOf(list: string): { orig: string; alias: string }[] {
  return list
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .filter((s) => s !== '')
    .map((s) => {
      const [orig, alias] = s.split(/\s+as\s+/);
      return { orig: orig!.trim(), alias: (alias ?? orig!).trim() };
    });
}

/** The file that declares `name` as seen from `file`, following named re-exports, `export *` and import-then-export. */
export function finalDeclarer(file: string, name: string, view: FileView, aliases: Readonly<Record<string, string>> = ALIAS_NONE, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const text = view.read(file);
  if (text === undefined) return undefined;
  if (declaresTopLevel(text, name)) return file;
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const s of specifiersOf(m[1]!)) {
      if (s.alias !== name) continue;
      const target = resolveSpecifier(file, m[2]!, view, aliases);
      return target === undefined ? undefined : finalDeclarer(target, s.orig, view, aliases, depth + 1);
    }
  }
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g)) {
    for (const s of specifiersOf(m[1]!)) {
      if (s.alias !== name) continue;
      const origin = importOrigin(text, file, s.orig, view, aliases, depth + 1);
      if (origin !== undefined) return origin.declarer;
    }
  }
  for (const m of text.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpecifier(file, m[1]!, view, aliases);
    if (target === undefined) continue;
    const found = finalDeclarer(target, name, view, aliases, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** How `file` imports `name`: the local alias and the file that declares it (undefined when external or unresolved). */
export function importOrigin(text: string, file: string, name: string, view: FileView, aliases: Readonly<Record<string, string>> = ALIAS_NONE, depth = 0): { alias: string; declarer: string | undefined } | undefined {
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const s of specifiersOf(m[1]!)) {
      if (s.orig !== name) continue;
      const target = resolveSpecifier(file, m[2]!, view, aliases);
      return { alias: s.alias, declarer: target === undefined ? undefined : finalDeclarer(target, name, view, aliases, depth + 1) };
    }
  }
  return undefined;
}

export type GrepOnlyClass = 'comment-or-string' | 'reexport-or-import-only' | 'different-symbol' | 'refers-to-target' | 'declaring-file' | 'manual';
export interface GrepOnlyResult {
  klass: GrepOnlyClass;
  note: string;
  lines: KindedLine[];
}

/** Classifies a file that a whole-word search finds but the oracle's key does not contain. */
export function classifyGrepOnlyFile(input: {
  file: string;
  text: string;
  name: string;
  targetFile: string;
  view: FileView;
  aliases?: Readonly<Record<string, string>>;
}): GrepOnlyResult {
  const { file, text, name, targetFile, view } = input;
  const aliases = input.aliases ?? ALIAS_NONE;
  const lines = lineKinds(text, name);
  if (file === targetFile) return { klass: 'declaring-file', note: 'the declaration itself; uses inside it are counted by the oracle', lines };
  const codeLines = lines.filter((l) => l.kind === 'code' || l.kind === 'member' || l.kind === 'key');
  if (codeLines.length === 0) {
    if (lines.every((l) => l.kind === 'comment' || l.kind === 'string')) return { klass: 'comment-or-string', note: 'only comments and strings', lines };
    const origin = importOrigin(text, file, name, view, aliases);
    if (origin !== undefined && origin.declarer === targetFile && origin.alias !== name) {
      const aliasUse = lineKinds(text, origin.alias).filter((l) => l.kind === 'code' || l.kind === 'member');
      if (aliasUse.length > 0) return { klass: 'refers-to-target', note: `imports the target as ${origin.alias} and uses it at line ${String(aliasUse[0]!.line)}`, lines };
    }
    return { klass: 'reexport-or-import-only', note: origin?.declarer === undefined ? 'import or export lines only' : `import or export lines only (declarer ${origin.declarer})`, lines };
  }
  if (declaresTopLevel(text, name)) return { klass: 'different-symbol', note: 'the file declares its own symbol of that name', lines };
  const origin = importOrigin(text, file, name, view, aliases);
  if (origin?.declarer !== undefined) {
    return origin.declarer === targetFile
      ? { klass: 'refers-to-target', note: `imports the name from a chain that ends at ${targetFile}`, lines }
      : { klass: 'different-symbol', note: `imports the name from a chain that ends at ${origin.declarer}`, lines };
  }
  return { klass: 'manual', note: origin === undefined ? 'no import of the name and no own declaration (member access or global); read the lines' : 'import from an external or unresolved module', lines };
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function stripGenerics(s: string): string {
  let out = s;
  for (let i = 0; i < 6; i += 1) out = out.replace(/<[^<>]*>/g, ' ');
  return out;
}

/** Classes and interfaces whose `extends` or `implements` list names one of `names` (text level, comments ignored). */
export function heritageHits(text: string, names: readonly string[]): { cls: string; line: number }[] {
  const clean = stripComments(text);
  const out: { cls: string; line: number }[] = [];
  for (const m of clean.matchAll(/\b(?:class|interface)\s+([A-Za-z_$][\w$]*)([^{;]*)\{/g)) {
    const rest = stripGenerics(m[2]!);
    const clause = /\b(?:extends|implements)\b([\s\S]*)$/.exec(rest);
    if (clause === null) continue;
    const tokens = clause[1]!.match(/[A-Za-z_$][\w$.]*/g) ?? [];
    const hit = tokens.some((t) => t !== 'extends' && t !== 'implements' && names.includes(t.split('.').pop()!));
    if (hit) out.push({ cls: m[1]!, line: clean.slice(0, m.index).split('\n').length + (m[0].slice(0, m[0].indexOf(m[1]!)).split('\n').length - 1) });
  }
  return out;
}
