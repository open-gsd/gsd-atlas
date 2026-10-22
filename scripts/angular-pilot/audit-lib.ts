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

/** Per character: 0 code, 1 comment, 2 string (template interpolations are code). */
function charClasses(text: string): Uint8Array {
  const cls = new Uint8Array(text.length);
  type Ctx = { kind: 'tpl' } | { kind: 'expr'; depth: number };
  const stack: Ctx[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const top = stack[stack.length - 1];
    if (top?.kind === 'tpl') {
      const ch = text[i]!;
      if (ch === '\\') {
        cls[i] = 2;
        if (i + 1 < n) cls[i + 1] = 2;
        i += 2;
      } else if (ch === '`') {
        cls[i] = 2;
        stack.pop();
        i += 1;
      } else if (ch === '$' && text[i + 1] === '{') {
        cls[i] = 2;
        cls[i + 1] = 2;
        stack.push({ kind: 'expr', depth: 0 });
        i += 2;
      } else {
        cls[i] = 2;
        i += 1;
      }
      continue;
    }
    const ch = text[i]!;
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') {
        cls[i] = 1;
        i += 1;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      while (i < stop) {
        cls[i] = 1;
        i += 1;
      }
    } else if (ch === "'" || ch === '"') {
      cls[i] = 2;
      i += 1;
      while (i < n && text[i] !== ch && text[i] !== '\n') {
        cls[i] = 2;
        i += text[i] === '\\' ? 2 : 1;
      }
      if (i < n) cls[i] = 2;
      i += 1;
    } else if (ch === '`') {
      cls[i] = 2;
      stack.push({ kind: 'tpl' });
      i += 1;
    } else {
      if (top?.kind === 'expr') {
        if (ch === '{') top.depth += 1;
        else if (ch === '}') {
          if (top.depth === 0) {
            stack.pop();
            cls[i] = 2;
            i += 1;
            continue;
          }
          top.depth -= 1;
        }
      }
      i += 1;
    }
  }
  return cls;
}

/** Every line that spells `name` as a whole word, with what kind of mention it is (text level only). */
export function lineKinds(text: string, name: string): KindedLine[] {
  const cls = charClasses(text);
  const ranges = statementRanges(text);
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  const lineAt = (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const byLine = new Map<number, LineKind>();
  for (const m of text.matchAll(wordRe(name))) {
    const at = m.index;
    const lineNo = lineAt(at);
    const prior = byLine.get(lineNo);
    if (prior !== undefined && prior !== 'comment' && prior !== 'string') continue;
    let kind: LineKind;
    if (cls[at] === 1) kind = 'comment';
    else if (cls[at] === 2) kind = 'string';
    else {
      const range = ranges.find((r) => r.start <= lineNo && r.end >= lineNo);
      if (range !== undefined) kind = range.kind;
      else {
        const before = text.slice(starts[lineNo - 1]!, at).trimEnd();
        const prev = before.slice(-1);
        const after = text.slice(at + name.length, text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at));
        if (before.endsWith('.') || before.endsWith('?.')) kind = 'member';
        else if (/^\s*\??:/.test(after) && (prev === '' || prev === '{' || prev === ',' || prev === '(' || prev === ';')) kind = 'key';
        else kind = 'code';
      }
    }
    byLine.set(lineNo, kind);
  }
  const lines = text.split('\n');
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([line, kind]) => ({ line, kind, text: (lines[line - 1] ?? '').trim() }));
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
  new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|(?:const\\s+)?enum|const|let|var|type|namespace)\\s+${escapeRe(name)}(?![\\w$])`, 'm');

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

/** `ns.name` member accesses where `ns` is a namespace import whose module chain declares `name`. */
export function namespaceMembers(text: string, file: string, name: string, view: FileView, aliases: Readonly<Record<string, string>> = ALIAS_NONE): { receiver: string; line: number; declarer: string | undefined }[] {
  const out: { receiver: string; line: number; declarer: string | undefined }[] = [];
  for (const m of text.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/g)) {
    const receiver = m[1]!;
    const target = resolveSpecifier(file, m[2]!, view, aliases);
    const declarer = target === undefined ? undefined : finalDeclarer(target, name, view, aliases);
    if (declarer === undefined) continue;
    const re = new RegExp(`(?<![\\w$.])${escapeRe(receiver)}\\.${escapeRe(name)}(?![\\w$])`, 'g');
    for (const k of lineKinds(text, name)) if (k.kind === 'member' && re.test(k.text)) out.push({ receiver, line: k.line, declarer });
  }
  return out;
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
  const nsHit = namespaceMembers(text, file, name, view, aliases)[0];
  if (nsHit !== undefined) return { klass: nsHit.declarer === targetFile ? 'refers-to-target' : 'different-symbol', note: `namespace member ${nsHit.receiver}.${name} at line ${String(nsHit.line)}, declarer ${nsHit.declarer ?? '?'}`, lines };
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
