/**
 * Key oracle v2 (proposal, not registered).
 *
 * Recomputes the answer keys of the 75 pre-registered questions from the pinned corpus (gsd-core at
 * CORPUS_SHA), read-only, with explicit rules about the question wording. It does not use the
 * registered oracle, any session answer, or the registered result files. Nothing here edits a frozen
 * file; `node scripts/key-oracle/derive-v2.ts` writes new files under docs/<registered-dir>/key-set-v2/.
 *
 * HOW THE CORPUS IS READ
 *   `git ls-tree -r -z` and `git cat-file --batch` (argument arrays through child_process, never a
 *   shell string) against the pinned commit. Nothing is checked out, fetched or executed in the clone.
 *   Every tracked `.cts .ts .mts .cjs .js .mjs` file is parsed with the repository's own `typescript`
 *   (syntax only; no type checker, no program, no tsconfig resolution).
 *
 * RULES (each is a rule about the wording, applied the same way in every file type)
 *   M  Module reference. A file refers to module M (a `.cts` source, compiled to a `.cjs` file) when it has
 *      a module reference whose specifier resolves, by static string evaluation, to M. Forms:
 *        F1  `require(<spec>)` call;
 *        F2  `import x = require(<spec>)` declaration (a `.cts` form that tsc emits as `require`);
 *        F3  ES `import ... from <spec>` / `export ... from <spec>` (tsc emits `require`, source does not);
 *        F4  `import(<spec>)` dynamic import; F5 `require.resolve(<spec>)`; F6 `import type`, `import('..').T`.
 *      Specifier evaluation (nothing is executed): string literals, templates, `+`, `__dirname`, `__filename`,
 *      `const` (or single-declaration `let`/`var`) identifiers in the same file whose initializer evaluates,
 *      and `path.join/resolve/normalize/dirname`. A relative specifier resolves against the file.
 *      A value with an unknown prefix (`path.join(ROOT, 'gsd-core', 'bin', 'lib', 'x.cjs')` where ROOT is not
 *      static) keeps its known tail and matches M when the tail is a path suffix of the source stem
 *      (`src/x`) or of the emit stem (`gsd-core/bin/lib/x`); a tail that is only the basename matches only
 *      when no other tracked code file has that basename ("tail-basename", reported separately).
 *      M matches the source path or its emit path (rootDir/outDir read from tsconfig.build.json), with the
 *      extension `.cts`, `.cjs`, `.js` or none.
 *   B  Binding. What a module reference binds: `const m = require(M)` / `import m = require(M)` / default or
 *      namespace import (namespace alias m); `const { f, g: h } = <ref or alias>` and
 *      `({ f } = require(M))` (named bindings f, h); `require(M).f`, `m.f`, `m['f']` (member access);
 *      `const h = f` and `const h = m.f` (alias, three levels); wrappers `as`, `satisfies`, `!`, `<T>`, `( )`
 *      are transparent. Tracking is by name inside the file (no scope analysis).
 *   C  Call. A use is a call when it is the callee of a call expression, `new`, or tagged template, through
 *      the transparent wrappers, `(0, f)(x)`, or `f.call(...)` / `f.apply(...)`.
 *   R1 callers(F in M): files with a call to F by rule B, plus a call to F by its own name in M itself
 *      (a self-call counts, including recursion). A same-named function that is not bound to M is not a call.
 *   R2 references(F in M): files with any use of F other than its declaration: import or destructuring
 *      element, call, read, type position, member access `m.F`, `export { F }`, shorthand `{ F }`.
 *      A string literal that spells the name is not a use (binding-level reading).
 *   R3 emit(S): outDir + (S relative to rootDir) with `.cts` replaced by `.cjs`, read from tsconfig.build.json.
 *   R4 emit-consumers(S), two readings chosen by the question wording:
 *        "calls"  (wording: ".cts sources that call `require`"): F1 only.
 *        "load"   (wording: "load that module with `require`, by compiled path or sibling `.cjs` specifier"):
 *                 F1 and F2.  F3 to F6 and strings that contain text such as `require('...')` never count.
 *   R5 impact(F in M, depth two): D1 = R1 callers. D2 = for each `.cts` file I in D1 other than M, the files that
 *      call (rule R1, without I's self-calls) any name exported by I: `export function/const`, `export { a as b }`,
 *      `export = { a, b: c, d() {} }`. Result = D1 + D2 minus M.
 *   R6 adr-citers(N): files with a code COMMENT matching ADR-N, ADR N or ADR #N where the digits are written
 *      exactly as in the question (no leading zeros). String literals and Markdown do not count.
 *   R7 adr-of(S): ADR files for the numbers cited in the comments ATTACHED to S: the contiguous comment block
 *      directly above the declaration (no blank line between comment and declaration, or between comments) and
 *      every comment inside it. A banner comment separated by a blank line is not attached.
 *
 * LIMITS (reported, not hidden)
 *   Name-based tracking: a local name reused for another meaning in the same file is a false positive risk.
 *   Not followed: re-exports (`export { f } from`), `module.exports = require(...)`, aliasing through function
 *   parameters or object properties, `Object.assign`, computed requires with a fully unknown path, requires in
 *   strings handed to a child process, calls via `bind`. Counts of unresolved forms are reported.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export const CORPUS_SHA = '10ac3a7a947903ba50f538a907af036744d759d5';
export const DEFAULT_REPO = process.env['GSD_CORE_REPO'] ?? '/Users/trekkie/projects/gsd-core';
export const DERIVE_VERSION = 'v2-derive.1';

const CODE_EXT = new Set(['.cts', '.ts', '.mts', '.cjs', '.js', '.mjs']);
const REPO_ROOT = '/@repo';

// ---------------------------------------------------------------------------------------------------
// Corpus loading (read-only git)
// ---------------------------------------------------------------------------------------------------

export interface Corpus {
  repo: string;
  sha: string;
  allPaths: string[];
  code: Map<string, string>;
  tsconfigBuild: string;
}

function gitBuf(repo: string, args: readonly string[], input?: Buffer | string): Buffer {
  return execFileSync('git', ['-C', repo, ...args], {
    input,
    maxBuffer: 1 << 30,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

export function loadCorpus(repo: string = DEFAULT_REPO, sha: string = CORPUS_SHA): Corpus {
  const listing = gitBuf(repo, ['ls-tree', '-r', '-z', sha]).toString('utf8');
  const allPaths: string[] = [];
  const wanted: { oid: string; rel: string }[] = [];
  for (const entry of listing.split('\0')) {
    if (entry === '') continue;
    const tab = entry.indexOf('\t');
    const [, type, oid] = entry.slice(0, tab).split(' ');
    const rel = entry.slice(tab + 1);
    if (type !== 'blob') continue;
    allPaths.push(rel);
    if (CODE_EXT.has(path.posix.extname(rel))) wanted.push({ oid: oid as string, rel });
  }
  const out = gitBuf(repo, ['cat-file', '--batch'], wanted.map((w) => w.oid).join('\n') + '\n');
  const code = new Map<string, string>();
  let offset = 0;
  for (const w of wanted) {
    const nl = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, nl).toString('utf8').split(' ');
    const size = Number(header[2]);
    code.set(w.rel, out.subarray(nl + 1, nl + 1 + size).toString('utf8'));
    offset = nl + 1 + size + 1;
  }
  const tsconfigBuild = gitBuf(repo, ['show', `${sha}:tsconfig.build.json`]).toString('utf8');
  allPaths.sort(cmp);
  return { repo, sha, allPaths, code, tsconfigBuild };
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------
// Units and module references
// ---------------------------------------------------------------------------------------------------

export type RefForm =
  | 'require-call'
  | 'import-equals'
  | 'import-decl'
  | 'import-decl-type'
  | 'export-from'
  | 'dynamic-import'
  | 'require-resolve'
  | 'import-type';

export type Spec =
  | { kind: 'repo'; path: string }
  | { kind: 'tail'; tail: string }
  | { kind: 'bare'; text: string }
  | { kind: 'none' };

interface NamedBinding {
  exportName: string;
  keyNode: ts.Node;
  local?: ts.Identifier;
}
interface DirectMember {
  name: string;
  nameNode: ts.Node;
  access: ts.Node;
}
export interface ModuleRef {
  form: RefForm;
  node: ts.Node;
  specText: string;
  spec: Spec;
  ns: ts.Identifier[];
  named: NamedBinding[];
  direct: DirectMember[];
  /** import('...').T qualifier name */
  typeMember?: ts.Identifier;
}

export interface Unit {
  rel: string;
  sf: ts.SourceFile;
  ids: Map<string, ts.Identifier[]>;
  consts: Map<string, ts.Expression | null>;
  refs: ModuleRef[];
}

export interface Index {
  corpus: Corpus;
  units: Map<string, Unit>;
  rootDir: string;
  outDir: string;
  baseStemCount: Map<string, string[]>;
  adrFiles: Map<number, string[]>;
}

export function lineOf(unit: Unit, pos: number): number {
  return unit.sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function scriptKindOf(rel: string): ts.ScriptKind {
  const ext = path.posix.extname(rel);
  return ext === '.cts' || ext === '.ts' || ext === '.mts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function unwrapDown(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
    } else return cur;
  }
}

function unwrapUp(node: ts.Node): ts.Node {
  let cur = node;
  for (;;) {
    const p = cur.parent;
    if (
      p !== undefined &&
      (ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isSatisfiesExpression(p) ||
        ts.isTypeAssertionExpression(p))
    ) {
      cur = p;
    } else return cur;
  }
}

// --- static string evaluation ---------------------------------------------------------------------

interface Val {
  text: string;
  open: boolean;
}
const OPEN: Val = { text: '', open: true };
const PATH_FN = new Set(['join', 'resolve', 'normalize', 'dirname']);

function isPathObject(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return /^(path|nodePath|pathPosix|posix)$/.test(e.text);
  if (ts.isPropertyAccessExpression(e)) {
    return ts.isIdentifier(e.expression) && e.expression.text === 'path' && e.name.text === 'posix';
  }
  if (ts.isCallExpression(e)) {
    const a = e.arguments[0];
    return (
      ts.isIdentifier(e.expression) &&
      e.expression.text === 'require' &&
      e.arguments.length === 1 &&
      a !== undefined &&
      ts.isStringLiteralLike(a) &&
      /^(node:)?path$/.test(a.text)
    );
  }
  return false;
}

function concat(a: Val, b: Val): Val {
  return b.open ? { text: b.text, open: true } : { text: a.text + b.text, open: a.open };
}

/**
 * The initializer of the nearest enclosing declaration of `id` (block scoped lookup by name through the
 * statements of each enclosing block, source file or case clause); undefined when none has an initializer.
 */
function lookupConst(id: ts.Identifier): ts.Expression | undefined {
  let cur: ts.Node | undefined = id.parent;
  while (cur !== undefined) {
    let statements: readonly ts.Statement[] | undefined;
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)) statements = cur.statements;
    else if (ts.isCaseClause(cur) || ts.isDefaultClause(cur)) statements = cur.statements;
    if (statements !== undefined) {
      for (const st of statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.name.text === id.text) return d.initializer;
        }
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

function fold(unit: Unit, node: ts.Expression, depth: number): Val {
  if (depth > 14) return OPEN;
  const n = unwrapDown(node);
  if (ts.isStringLiteralLike(n)) return { text: n.text, open: false };
  if (ts.isTemplateExpression(n)) {
    let acc: Val = { text: n.head.text, open: false };
    for (const span of n.templateSpans) {
      acc = concat(acc, fold(unit, span.expression, depth + 1));
      acc = concat(acc, { text: span.literal.text, open: false });
    }
    return acc;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return concat(fold(unit, n.left, depth + 1), fold(unit, n.right, depth + 1));
  }
  if (ts.isIdentifier(n)) {
    if (n.text === '__dirname') {
      const d = path.posix.dirname(unit.rel);
      return { text: REPO_ROOT + (d === '.' ? '' : '/' + d), open: false };
    }
    if (n.text === '__filename') return { text: `${REPO_ROOT}/${unit.rel}`, open: false };
    const init = lookupConst(n);
    return init === undefined ? OPEN : fold(unit, init, depth + 1);
  }
  if (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'require' &&
    n.expression.name.text === 'resolve' &&
    n.arguments.length >= 1
  ) {
    // require.resolve('./x.cjs') evaluates to the file it names; the bare-specifier form stays unknown
    const a = fold(unit, n.arguments[0] as ts.Expression, depth + 1);
    if (!a.open && (a.text.startsWith('./') || a.text.startsWith('../'))) {
      const d = path.posix.dirname(unit.rel);
      return { text: path.posix.normalize(path.posix.join(REPO_ROOT + (d === '.' ? '' : '/' + d), a.text)), open: false };
    }
    return OPEN;
  }
  if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
    const callee = n.expression;
    if (!isPathObject(callee.expression) || !PATH_FN.has(callee.name.text)) return OPEN;
    const parts = n.arguments.map((a) => fold(unit, a, depth + 1));
    const first = parts[0];
    if (first === undefined) return OPEN;
    const fn = callee.name.text;
    if (fn === 'dirname') {
      return { text: first.text.includes('/') ? path.posix.dirname(first.text) : '', open: first.open };
    }
    let acc = first;
    for (const p of parts.slice(1)) {
      if (p.open) acc = { text: p.text, open: true };
      else if (fn === 'resolve' && p.text.startsWith('/')) acc = p;
      else acc = { text: acc.text === '' ? p.text : acc.text + '/' + p.text, open: acc.open };
    }
    return { text: acc.text === '' ? '' : path.posix.normalize(acc.text), open: acc.open };
  }
  return OPEN;
}

function specOf(unit: Unit, expr: ts.Expression): Spec {
  const v = fold(unit, expr, 0);
  if (v.open) return v.text === '' ? { kind: 'none' } : { kind: 'tail', tail: v.text };
  const t = v.text;
  if (t.startsWith(REPO_ROOT + '/')) return { kind: 'repo', path: path.posix.normalize(t.slice(REPO_ROOT.length + 1)) };
  if (t.startsWith('./') || t.startsWith('../') || t === '.' || t === '..') {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(unit.rel), t));
    return joined.startsWith('../') ? { kind: 'none' } : { kind: 'repo', path: joined };
  }
  return { kind: 'bare', text: t };
}

// --- bindings ---------------------------------------------------------------------------------------

function keyText(k: ts.Node | undefined): string | undefined {
  if (k === undefined) return undefined;
  if (ts.isIdentifier(k) || ts.isStringLiteralLike(k) || ts.isNumericLiteral(k)) return k.text;
  return undefined;
}

function namedFromBindingPattern(pattern: ts.ObjectBindingPattern, out: NamedBinding[]): void {
  for (const el of pattern.elements) {
    if (el.dotDotDotToken !== undefined) continue;
    const key = keyText(el.propertyName ?? (ts.isIdentifier(el.name) ? el.name : undefined));
    if (key === undefined) continue;
    const binding: NamedBinding = { exportName: key, keyNode: el.propertyName ?? el.name };
    if (ts.isIdentifier(el.name)) binding.local = el.name;
    out.push(binding);
  }
}

function namedFromAssignPattern(pattern: ts.ObjectLiteralExpression, out: NamedBinding[]): void {
  for (const prop of pattern.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      out.push({ exportName: prop.name.text, keyNode: prop.name, local: prop.name });
    } else if (ts.isPropertyAssignment(prop)) {
      const key = keyText(prop.name);
      if (key === undefined) continue;
      const binding: NamedBinding = { exportName: key, keyNode: prop.name };
      const target = unwrapDown(prop.initializer);
      if (ts.isIdentifier(target)) binding.local = target;
      out.push(binding);
    }
  }
}

interface Bindings {
  ns: ts.Identifier[];
  named: NamedBinding[];
  direct: DirectMember[];
}

function bindingsOfValue(value: ts.Node): Bindings {
  const b: Bindings = { ns: [], named: [], direct: [] };
  const top = unwrapUp(value);
  const p = top.parent;
  if (p === undefined) return b;
  if (ts.isPropertyAccessExpression(p) && p.expression === top) {
    b.direct.push({ name: p.name.text, nameNode: p.name, access: p });
  } else if (ts.isElementAccessExpression(p) && p.expression === top && ts.isStringLiteralLike(p.argumentExpression)) {
    b.direct.push({ name: p.argumentExpression.text, nameNode: p.argumentExpression, access: p });
  } else if (ts.isVariableDeclaration(p) && p.initializer === top) {
    if (ts.isIdentifier(p.name)) b.ns.push(p.name);
    else if (ts.isObjectBindingPattern(p.name)) namedFromBindingPattern(p.name, b.named);
  } else if (
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    p.right === top
  ) {
    const left = unwrapDown(p.left);
    if (ts.isIdentifier(left)) b.ns.push(left);
    else if (ts.isObjectLiteralExpression(left)) namedFromAssignPattern(left, b.named);
  }
  return b;
}

function buildUnit(rel: string, text: string): Unit {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel));
  const ids = new Map<string, ts.Identifier[]>();
  const consts = new Map<string, ts.Expression | null>();
  const refs: ModuleRef[] = [];
  const addRef = (form: RefForm, node: ts.Node, specExpr: ts.Expression, b?: Bindings): void => {
    refs.push({
      form,
      node,
      specText: specExpr.getText(sf),
      spec: specOf({ rel, sf, ids, consts, refs } as Unit, specExpr),
      ns: b?.ns ?? [],
      named: b?.named ?? [],
      direct: b?.direct ?? [],
    });
  };
  const pending: (() => void)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const list = ids.get(node.text);
      if (list === undefined) ids.set(node.text, [node]);
      else list.push(node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      consts.set(node.name.text, consts.has(node.name.text) ? null : (node.initializer ?? null));
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (ts.isIdentifier(callee) && callee.text === 'require' && node.arguments.length === 1 && arg !== undefined) {
        pending.push(() => addRef('require-call', node, arg, bindingsOfValue(node)));
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword && arg !== undefined) {
        pending.push(() => addRef('dynamic-import', node, arg));
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve' &&
        arg !== undefined
      ) {
        pending.push(() => addRef('require-resolve', node, arg));
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      pending.push(() => addRef('import-equals', node, expr, { ns: [node.name], named: [], direct: [] }));
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const b: Bindings = { ns: [], named: [], direct: [] };
      const clause = node.importClause;
      if (clause !== undefined) {
        if (clause.name !== undefined) b.ns.push(clause.name);
        const nb = clause.namedBindings;
        if (nb !== undefined && ts.isNamespaceImport(nb)) b.ns.push(nb.name);
        else if (nb !== undefined) {
          for (const el of nb.elements) {
            b.named.push({ exportName: (el.propertyName ?? el.name).text, keyNode: el.propertyName ?? el.name, local: el.name });
          }
        }
      }
      const typeOnly = clause?.isTypeOnly === true;
      pending.push(() => addRef(typeOnly ? 'import-decl-type' : 'import-decl', node, node.moduleSpecifier as ts.Expression, b));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const b: Bindings = { ns: [], named: [], direct: [] };
      if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          b.named.push({ exportName: (el.propertyName ?? el.name).text, keyNode: el.propertyName ?? el.name });
        }
      }
      pending.push(() => addRef('export-from', node, node.moduleSpecifier as ts.Expression, b));
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const lit = node.argument.literal;
      pending.push(() => {
        addRef('import-type', node, lit);
        const q = node.qualifier;
        const last = refs[refs.length - 1] as ModuleRef;
        if (q !== undefined) last.typeMember = ts.isIdentifier(q) ? q : q.left && ts.isIdentifier(q.left) ? q.left : undefined;
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const unit: Unit = { rel, sf, ids, consts, refs };
  for (const f of pending) {
    // specOf needs the complete const table, so references are resolved after the whole walk.
    f();
  }
  // re-resolve specs now that the unit is complete
  for (const r of refs) {
    const expr = specExprOf(r);
    if (expr !== undefined) r.spec = specOf(unit, expr);
  }
  unit.refs = refs;
  return unit;
}

function specExprOf(r: ModuleRef): ts.Expression | undefined {
  const n = r.node;
  if (ts.isCallExpression(n)) return n.arguments[0];
  if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) return n.moduleReference.expression;
  if (ts.isImportDeclaration(n)) return n.moduleSpecifier;
  if (ts.isExportDeclaration(n)) return n.moduleSpecifier;
  if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) return n.argument.literal as ts.Expression;
  return undefined;
}

export function buildIndex(corpus: Corpus): Index {
  const units = new Map<string, Unit>();
  for (const [rel, text] of corpus.code) units.set(rel, buildUnit(rel, text));
  const parsed = ts.parseConfigFileTextToJson('tsconfig.build.json', corpus.tsconfigBuild);
  const co = (parsed.config as { compilerOptions: { rootDir: string; outDir: string } }).compilerOptions;
  const baseStemCount = new Map<string, string[]>();
  for (const rel of corpus.code.keys()) {
    const stem = stripExt(path.posix.basename(rel));
    const list = baseStemCount.get(stem);
    if (list === undefined) baseStemCount.set(stem, [rel]);
    else list.push(rel);
  }
  const adrFiles = new Map<number, string[]>();
  for (const rel of corpus.allPaths) {
    if (!rel.startsWith('docs/adr/') || path.posix.extname(rel) !== '.md') continue;
    const m = /^(\d+)(?=[-_.])/.exec(path.posix.basename(rel));
    if (m === null) continue;
    const n = Number(m[1]);
    const list = adrFiles.get(n);
    if (list === undefined) adrFiles.set(n, [rel]);
    else list.push(rel);
  }
  return { corpus, units, rootDir: co.rootDir, outDir: co.outDir, baseStemCount, adrFiles };
}

function stripExt(p: string): string {
  return p.replace(/\.(cts|cjs|ts|js|mjs|mts)$/, '');
}

// ---------------------------------------------------------------------------------------------------
// Module matching
// ---------------------------------------------------------------------------------------------------

export function outputPath(idx: Index, src: string): string {
  const rel = path.posix.relative(idx.rootDir, src);
  return path.posix.join(idx.outDir, rel.replace(/\.cts$/, '.cjs'));
}

export type MatchKind = 'exact' | 'tail' | 'tail-basename';

export function matchSpec(idx: Index, spec: Spec, src: string): MatchKind | null {
  const stems = [stripExt(src), stripExt(outputPath(idx, src))];
  const okExt = (p: string): boolean => ['', '.cjs', '.cts', '.js'].includes(path.posix.extname(p));
  if (spec.kind === 'repo') {
    if (!okExt(spec.path)) return null;
    return stems.includes(stripExt(spec.path)) ? 'exact' : null;
  }
  if (spec.kind === 'tail') {
    let t = path.posix.normalize(spec.tail).replace(/^(\.\.\/)+/, '').replace(/^\.\//, '').replace(/^\//, '');
    if (t === '' || !okExt(t)) return null;
    t = stripExt(t);
    if (t.includes('/')) return stems.some((s) => s === t || s.endsWith('/' + t)) ? 'tail' : null;
    if (!stems.some((s) => s.endsWith('/' + t))) return null;
    const others = (idx.baseStemCount.get(t) ?? []).filter((r) => r !== src);
    return others.length === 0 ? 'tail-basename' : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Uses
// ---------------------------------------------------------------------------------------------------

export type UseKind = 'call' | 'read' | 'binding' | 'type' | 'export';

export interface Use {
  unit: Unit;
  node: ts.Node;
  kind: UseKind;
  line: number;
  match?: MatchKind;
  form?: RefForm;
}

function isCallee(node: ts.Node): boolean {
  let cur: ts.Node = node;
  for (;;) {
    const p = cur.parent;
    if (p === undefined) return false;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p)
    ) {
      cur = p;
      continue;
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken && p.right === cur) {
      cur = p;
      continue;
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === cur) return true;
    if (ts.isTaggedTemplateExpression(p) && p.tag === cur) return true;
    if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === cur &&
      (p.name.text === 'call' || p.name.text === 'apply') &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      return true;
    }
    return false;
  }
}

/** True when the identifier occurrence is a declaration name, a property name or another non-use position. */
function isNonUse(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p)) return p.name === id;
  if (ts.isQualifiedName(p)) return p.right === id;
  if (ts.isBindingElement(p)) return p.propertyName === id || p.name === id;
  if (ts.isImportSpecifier(p)) return true;
  if (ts.isExportSpecifier(p)) return p.propertyName !== undefined ? p.name === id : false;
  if (ts.isShorthandPropertyAssignment(p)) return false;
  if (
    ts.isPropertyAssignment(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodSignature(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isEnumMember(p) ||
    ts.isParameter(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isClassExpression(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) ||
    ts.isEnumDeclaration(p) ||
    ts.isModuleDeclaration(p) ||
    ts.isTypeParameterDeclaration(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isImportEqualsDeclaration(p) ||
    ts.isLabeledStatement(p) ||
    ts.isBreakOrContinueStatement(p)
  ) {
    return (p as { name?: ts.Node }).name === id || (p as { label?: ts.Node }).label === id;
  }
  return false;
}

function nameOfUse(node: ts.Node): string {
  return node.getText();
}
void nameOfUse;

function push(out: Use[], unit: Unit, node: ts.Node, kind: UseKind, ref?: ModuleRef, match?: MatchKind): void {
  const u: Use = { unit, node, kind, line: lineOf(unit, node.getStart(unit.sf)) };
  if (ref !== undefined) u.form = ref.form;
  if (match !== undefined) u.match = match;
  out.push(u);
}

function trackLocal(unit: Unit, local: ts.Identifier, depth: number, out: Use[], ref?: ModuleRef, match?: MatchKind): void {
  for (const occ of unit.ids.get(local.text) ?? []) {
    if (occ === local || isNonUse(occ)) continue;
    const kind: UseKind = isCallee(occ) ? 'call' : ts.isExportSpecifier(occ.parent) ? 'export' : ts.isTypeReferenceNode(occ.parent) ? 'type' : 'read';
    push(out, unit, occ, kind, ref, match);
    const top = unwrapUp(occ);
    const p = top.parent;
    if (depth < 3 && p !== undefined && ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) {
      trackLocal(unit, p.name, depth + 1, out, ref, match);
    }
  }
}

function accessUse(unit: Unit, access: ts.Node, nameNode: ts.Node, depth: number, out: Use[], ref?: ModuleRef, match?: MatchKind): void {
  const top = unwrapUp(access);
  const p = top.parent;
  if (depth < 3 && p !== undefined && ts.isVariableDeclaration(p) && p.initializer === top && ts.isIdentifier(p.name)) {
    push(out, unit, nameNode, 'binding', ref, match);
    trackLocal(unit, p.name, depth + 1, out, ref, match);
    return;
  }
  push(out, unit, nameNode, isCallee(access) ? 'call' : 'read', ref, match);
}

function trackNs(unit: Unit, ns: ts.Identifier, names: ReadonlySet<string>, depth: number, out: Use[], ref?: ModuleRef, match?: MatchKind): void {
  for (const occ of unit.ids.get(ns.text) ?? []) {
    if (occ === ns || isNonUse(occ)) continue;
    const p = occ.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === occ) {
      if (names.has(p.name.text)) accessUse(unit, p, p.name, depth, out, ref, match);
      continue;
    }
    if (ts.isElementAccessExpression(p) && p.expression === occ) {
      const a = p.argumentExpression;
      if (ts.isStringLiteralLike(a) && names.has(a.text)) accessUse(unit, p, a, depth, out, ref, match);
      continue;
    }
    if (ts.isQualifiedName(p) && p.left === occ) {
      if (names.has(p.right.text)) push(out, unit, p.right, 'type', ref, match);
      continue;
    }
    const top = unwrapUp(occ);
    const pp = top.parent;
    if (pp === undefined) continue;
    if (ts.isVariableDeclaration(pp) && pp.initializer === top) {
      if (ts.isObjectBindingPattern(pp.name)) {
        const named: NamedBinding[] = [];
        namedFromBindingPattern(pp.name, named);
        applyNamed(unit, named, names, depth, out, ref, match);
      } else if (ts.isIdentifier(pp.name) && depth < 3) trackNs(unit, pp.name, names, depth + 1, out, ref, match);
    } else if (ts.isBinaryExpression(pp) && pp.operatorToken.kind === ts.SyntaxKind.EqualsToken && pp.right === top) {
      const left = unwrapDown(pp.left);
      if (ts.isIdentifier(left) && depth < 3) trackNs(unit, left, names, depth + 1, out, ref, match);
      else if (ts.isObjectLiteralExpression(left)) {
        const named: NamedBinding[] = [];
        namedFromAssignPattern(left, named);
        applyNamed(unit, named, names, depth, out, ref, match);
      }
    }
  }
}

function applyNamed(unit: Unit, named: NamedBinding[], names: ReadonlySet<string>, depth: number, out: Use[], ref?: ModuleRef, match?: MatchKind): void {
  for (const nb of named) {
    if (!names.has(nb.exportName)) continue;
    push(out, unit, nb.keyNode, 'binding', ref, match);
    if (nb.local !== undefined) trackLocal(unit, nb.local, depth, out, ref, match);
  }
}

/**
 * Names declared with a type that is the module's namespace type (rule B7): a parameter, variable or
 * property whose annotation is `typeof NS`, `typeof import(M)`, or an alias `type A = typeof NS`.
 */
function typedHolders(unit: Unit, nsNames: ReadonlySet<string>, typeofImport: ts.ImportTypeNode | undefined): ts.Identifier[] {
  const typeNames = new Set<string>();
  const isModuleType = (t: ts.TypeNode | undefined): boolean => {
    if (t === undefined) return false;
    if (ts.isTypeQueryNode(t) && ts.isIdentifier(t.exprName)) return nsNames.has(t.exprName.text);
    if (ts.isImportTypeNode(t)) return typeofImport !== undefined && t === typeofImport && t.isTypeOf === true;
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) return typeNames.has(t.typeName.text);
    return false;
  };
  const aliases: ts.TypeAliasDeclaration[] = [];
  const holders: (ts.ParameterDeclaration | ts.VariableDeclaration | ts.PropertyDeclaration)[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(n)) aliases.push(n);
    else if (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) holders.push(n);
    ts.forEachChild(n, collect);
  };
  collect(unit.sf);
  for (let round = 0; round < 3; round++) for (const a of aliases) if (isModuleType(a.type)) typeNames.add(a.name.text);
  const out: ts.Identifier[] = [];
  for (const h of holders) if (ts.isIdentifier(h.name) && isModuleType(h.type)) out.push(h.name);
  return out;
}

/** Every use, outside M, of the names `names` exported by M, through module references of any form. */
export function usesViaModule(idx: Index, src: string, names: ReadonlySet<string>): Use[] {
  const out: Use[] = [];
  for (const unit of idx.units.values()) {
    if (unit.rel === src) continue;
    for (const ref of unit.refs) {
      if (ref.form === 'require-resolve' || ref.form === 'dynamic-import') continue;
      const match = matchSpec(idx, ref.spec, src);
      if (match === null) continue;
      for (const d of ref.direct) if (names.has(d.name)) accessUse(unit, d.access, d.nameNode, 0, out, ref, match);
      applyNamed(unit, ref.named, names, 0, out, ref, match);
      for (const ns of ref.ns) trackNs(unit, ns, names, 0, out, ref, match);
      if (ref.ns.length > 0) {
        for (const h of typedHolders(unit, new Set(ref.ns.map((n) => n.text)), undefined)) trackNs(unit, h, names, 1, out, ref, match);
      }
      if (ref.form === 'import-type' && ts.isImportTypeNode(ref.node) && ref.node.isTypeOf === true) {
        for (const h of typedHolders(unit, new Set(), ref.node)) trackNs(unit, h, names, 1, out, ref, match);
      }
      if (ref.form === 'import-type' && ref.typeMember !== undefined && names.has(ref.typeMember.text)) {
        push(out, unit, ref.typeMember, 'type', ref, match);
      }
    }
  }
  return out;
}

/** Uses of the local names inside M itself (self-calls, self-references). */
export function selfUses(unit: Unit, locals: ReadonlySet<string>): Use[] {
  const out: Use[] = [];
  for (const name of locals) {
    for (const occ of unit.ids.get(name) ?? []) {
      if (isNonUse(occ)) continue;
      const kind: UseKind = isCallee(occ) ? 'call' : ts.isExportSpecifier(occ.parent) ? 'export' : ts.isTypeReferenceNode(occ.parent) ? 'type' : 'read';
      push(out, unit, occ, kind);
    }
  }
  return out;
}

// --- exports -----------------------------------------------------------------------------------------

function hasExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

export interface ExportInfo {
  map: Map<string, string | null>;
  exportEqualsIdentifier?: string;
  hasSpread: boolean;
}

export function exportsOf(unit: Unit): ExportInfo {
  const map = new Map<string, string | null>();
  const info: ExportInfo = { map, hasSpread: false };
  const objectProps = (obj: ts.ObjectLiteralExpression): void => {
    for (const prop of obj.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) map.set(prop.name.text, prop.name.text);
      else if (ts.isPropertyAssignment(prop)) {
        const k = keyText(prop.name);
        if (k === undefined) continue;
        const v = unwrapDown(prop.initializer);
        map.set(k, ts.isIdentifier(v) ? v.text : null);
      } else if (ts.isMethodDeclaration(prop)) {
        const k = keyText(prop.name);
        if (k !== undefined) map.set(k, null);
      } else if (ts.isSpreadAssignment(prop)) info.hasSpread = true;
    }
  };
  for (const st of unit.sf.statements) {
    if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name !== undefined &&
      hasExport(st)
    ) {
      map.set(st.name.text, st.name.text);
    } else if (ts.isVariableStatement(st) && hasExport(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) map.set(d.name.text, d.name.text);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier === undefined && st.exportClause !== undefined && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) map.set(el.name.text, (el.propertyName ?? el.name).text);
    } else if (ts.isExportAssignment(st) && st.isExportEquals === true) {
      const e = unwrapDown(st.expression);
      if (ts.isObjectLiteralExpression(e)) objectProps(e);
      else if (ts.isIdentifier(e)) info.exportEqualsIdentifier = e.text;
    } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = st.expression.left;
      const right = unwrapDown(st.expression.right);
      if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'module' && left.name.text === 'exports') {
        if (ts.isObjectLiteralExpression(right)) objectProps(right);
      } else if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'exports') {
        map.set(left.name.text, ts.isIdentifier(right) ? right.text : null);
      }
    }
  }
  return info;
}

export function namesForSymbol(info: ExportInfo, symbol: string): { exportNames: Set<string>; locals: Set<string> } {
  const exportNames = new Set<string>([symbol]);
  const locals = new Set<string>([symbol]);
  for (const [e, l] of info.map) if (l === symbol) exportNames.add(e);
  const l = info.map.get(symbol);
  if (typeof l === 'string') locals.add(l);
  return { exportNames, locals };
}

// ---------------------------------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------------------------------

export interface Site {
  file: string;
  line: number;
  symbol?: string;
}

function enclosingName(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur !== undefined) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isClassDeclaration(cur)) && cur.name !== undefined) return cur.name.getText();
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text;
    cur = cur.parent;
  }
  return '<module>';
}

export function sitesOf(uses: readonly Use[]): Site[] {
  const seen = new Set<string>();
  const sites: Site[] = [];
  for (const u of uses) {
    const key = `${u.unit.rel}:${u.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push({ file: u.unit.rel, line: u.line, symbol: enclosingName(u.node) });
  }
  return sites.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
}

export function filesOf(uses: readonly Use[]): string[] {
  return [...new Set(uses.map((u) => u.unit.rel))].sort(cmp);
}

function allUses(idx: Index, src: string, symbol: string): { uses: Use[]; exportNames: Set<string>; locals: Set<string> } {
  const unit = idx.units.get(src);
  if (unit === undefined) throw new Error(`${src} is not a code file of the corpus`);
  const info = exportsOf(unit);
  const { exportNames, locals } = namesForSymbol(info, symbol);
  const uses = [...usesViaModule(idx, src, exportNames), ...selfUses(unit, locals)];
  return { uses, exportNames, locals };
}

export function callersOf(idx: Index, src: string, symbol: string): Use[] {
  return allUses(idx, src, symbol).uses.filter((u) => u.kind === 'call');
}

export function referencesOf(idx: Index, src: string, symbol: string): Use[] {
  return allUses(idx, src, symbol).uses;
}

/** Names the symbol is spelled with at call sites (renamed imports and aliases), for the `needles`. */
export function aliasesOf(uses: readonly Use[], symbol: string): string[] {
  const set = new Set<string>();
  for (const u of uses) {
    const text = u.node.getText(u.unit.sf);
    if (/^[A-Za-z_$][\w$]*$/.test(text) && text !== symbol) set.add(text);
  }
  return [...set].sort(cmp);
}

export interface ImpactResult {
  d1: string[];
  d2: string[];
  /** For each depth-two file, the first intermediate `.cts`, exported name and line that reach it. */
  via: Map<string, { intermediate: string; name: string; line: number }>;
  files: string[];
  intermediates: string[];
  spreadWarnings: string[];
}

export function impactOf(idx: Index, src: string, symbol: string, includeDefAsIntermediate = true): ImpactResult {
  const d1 = filesOf(callersOf(idx, src, symbol));
  const intermediates = d1.filter((f) => f.endsWith('.cts') && (includeDefAsIntermediate || f !== src));
  const d2 = new Set<string>();
  const via = new Map<string, { intermediate: string; name: string; line: number }>();
  const spreadWarnings: string[] = [];
  for (const i of intermediates) {
    const info = exportsOf(idx.units.get(i) as Unit);
    if (info.hasSpread) spreadWarnings.push(i);
    const names = new Set(info.map.keys());
    for (const u of usesViaModule(idx, i, names)) {
      if (u.kind !== 'call') continue;
      d2.add(u.unit.rel);
      if (!via.has(u.unit.rel)) via.set(u.unit.rel, { intermediate: i, name: u.node.getText(u.unit.sf), line: u.line });
    }
  }
  const files = [...new Set([...d1, ...d2])].filter((f) => f !== src).sort(cmp);
  return { d1, d2: [...d2].sort(cmp), via, files, intermediates, spreadWarnings };
}

export type ConsumerMode = 'calls' | 'load';

export interface Consumer {
  file: string;
  line: number;
  form: RefForm;
  match: MatchKind;
}

export function consumersOf(idx: Index, src: string, mode: ConsumerMode): { hits: Consumer[]; excluded: Consumer[] } {
  const hits: Consumer[] = [];
  const excluded: Consumer[] = [];
  const allowed: ReadonlySet<RefForm> = mode === 'calls' ? new Set<RefForm>(['require-call']) : new Set<RefForm>(['require-call', 'import-equals']);
  for (const unit of idx.units.values()) {
    if (unit.rel === src) continue;
    for (const ref of unit.refs) {
      const match = matchSpec(idx, ref.spec, src);
      if (match === null) continue;
      const c: Consumer = { file: unit.rel, line: lineOf(unit, ref.node.getStart(unit.sf)), form: ref.form, match };
      (allowed.has(ref.form) ? hits : excluded).push(c);
    }
  }
  const order = (a: Consumer, b: Consumer): number => cmp(a.file, b.file) || a.line - b.line;
  return { hits: hits.sort(order), excluded: excluded.sort(order) };
}

/** Code-embedded mentions the oracle does not resolve: `require(` text inside string literals that names the module. */
export function stringMentions(idx: Index, src: string): { file: string; line: number }[] {
  const base = path.posix.basename(stripExt(src));
  const out: { file: string; line: number }[] = [];
  for (const unit of idx.units.values()) {
    const visit = (n: ts.Node): void => {
      if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes('require(') && n.text.includes(base)) {
        out.push({ file: unit.rel, line: lineOf(unit, n.getStart(unit.sf)) });
      }
      ts.forEachChild(n, visit);
    };
    visit(unit.sf);
  }
  return out.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
}

/** `require(...)` calls whose specifier names the module's basename but did not resolve to it. */
export function unresolvedNear(idx: Index, src: string): { file: string; line: number; text: string }[] {
  const base = path.posix.basename(stripExt(src));
  const out: { file: string; line: number; text: string }[] = [];
  for (const unit of idx.units.values()) {
    if (unit.rel === src) continue;
    for (const ref of unit.refs) {
      if (ref.form !== 'require-call' && ref.form !== 'import-equals') continue;
      if (matchSpec(idx, ref.spec, src) !== null) continue;
      // A require whose specifier could not be evaluated (kind none) in a file that spells the module's
      // basename anywhere is reported: the oracle cannot tell whether the unknown path is this module.
      if (ref.specText.includes(base) || (ref.spec.kind === 'none' && unit.sf.text.includes(base))) {
        out.push({ file: unit.rel, line: lineOf(unit, ref.node.getStart(unit.sf)), text: ref.specText });
      }
    }
  }
  return out;
}

export function globalUnresolvedStats(idx: Index): { requireCalls: number; none: number; tail: number; bare: number; repo: number } {
  const stats = { requireCalls: 0, none: 0, tail: 0, bare: 0, repo: 0 };
  for (const unit of idx.units.values()) {
    for (const ref of unit.refs) {
      if (ref.form !== 'require-call') continue;
      stats.requireCalls++;
      stats[ref.spec.kind]++;
    }
  }
  return stats;
}

/** require(...) calls with a specifier that could not be evaluated at all (kind none), with the argument text. */
export function fullyDynamicRequires(idx: Index): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const unit of idx.units.values()) {
    for (const ref of unit.refs) {
      if (ref.form === 'require-call' && ref.spec.kind === 'none') {
        out.push({ file: unit.rel, line: lineOf(unit, ref.node.getStart(unit.sf)), text: ref.specText });
      }
    }
  }
  return out.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
}

// --- string-keyed reads (alternative reading of q-012) -----------------------------------------------

export function stringSpellings(idx: Index, src: string, name: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const unit of idx.units.values()) {
    if (unit.rel === src) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n) && n.text === name) out.push({ file: unit.rel, line: lineOf(unit, n.getStart(unit.sf)) });
      ts.forEachChild(n, visit);
    };
    visit(unit.sf);
  }
  return out.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
}

// ---------------------------------------------------------------------------------------------------
// ADR rules
// ---------------------------------------------------------------------------------------------------

export interface CommentRange {
  pos: number;
  end: number;
}

const commentCache = new WeakMap<Unit, CommentRange[]>();

export function commentRanges(unit: Unit): CommentRange[] {
  const cached = commentCache.get(unit);
  if (cached !== undefined) return cached;
  const seen = new Map<number, CommentRange>();
  const text = unit.sf.text;
  const add = (ranges: ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) seen.set(r.pos, { pos: r.pos, end: r.end });
  };
  const visit = (n: ts.Node): void => {
    add(ts.getLeadingCommentRanges(text, n.getFullStart()));
    add(ts.getTrailingCommentRanges(text, n.getEnd()));
    ts.forEachChild(n, visit);
  };
  visit(unit.sf);
  add(ts.getLeadingCommentRanges(text, unit.sf.endOfFileToken.getFullStart()));
  const list = [...seen.values()].sort((a, b) => a.pos - b.pos);
  commentCache.set(unit, list);
  return list;
}

const ADR_RE = /\bADR(?:[-\s]\s*#?|#)\s*(\d+)(?:\s*§\s*(\d+(?:\.\d+)*))?/gi;

export interface Cite {
  digits: string;
  number: number;
  detail?: string;
  pos: number;
}

export function citesIn(text: string, base: number): Cite[] {
  const out: Cite[] = [];
  for (const m of text.matchAll(ADR_RE)) {
    const c: Cite = { digits: m[1] as string, number: Number(m[1]), pos: base + (m.index ?? 0) };
    if (m[2] !== undefined) c.detail = `§${m[2]}`;
    out.push(c);
  }
  return out;
}

export function adrCiters(idx: Index, n: number, literalDigits: boolean): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const unit of idx.units.values()) {
    for (const r of commentRanges(unit)) {
      for (const c of citesIn(unit.sf.text.slice(r.pos, r.end), r.pos)) {
        if (c.number !== n) continue;
        if (literalDigits && c.digits !== String(n)) continue;
        out.push({ file: unit.rel, line: lineOf(unit, c.pos) });
      }
    }
  }
  return out.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
}

function findTopDecl(unit: Unit, name: string): ts.Node[] {
  const found: ts.Node[] = [];
  for (const st of unit.sf.statements) {
    if (
      (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) &&
      st.name?.text === name
    ) {
      found.push(st);
    } else if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) {
      found.push(st);
    }
  }
  return found;
}

export type AdrCommentRule = 'attached' | 'trivia';

export function adrOf(idx: Index, definedIn: string, symbol: string, rule: AdrCommentRule): { number: number; detail?: string; files: string[] }[] {
  const unit = idx.units.get(definedIn);
  if (unit === undefined) throw new Error(`${definedIn} not in corpus`);
  const text = unit.sf.text;
  const picked = new Map<number, CommentRange>();
  for (const decl of findTopDecl(unit, symbol)) {
    const lead = ts.getLeadingCommentRanges(text, decl.pos) ?? [];
    const start = decl.getStart(unit.sf);
    let chosen: ts.CommentRange[] = lead;
    if (rule === 'attached') {
      chosen = [];
      let next = start;
      for (let i = lead.length - 1; i >= 0; i--) {
        const r = lead[i] as ts.CommentRange;
        const gap = text.slice(r.end, next);
        if ((gap.match(/\n/g) ?? []).length > 1 && /^\s*$/.test(gap)) break;
        chosen.unshift(r);
        next = r.pos;
      }
    }
    for (const r of chosen) picked.set(r.pos, { pos: r.pos, end: r.end });
    for (const r of commentRanges(unit)) if (r.pos >= start && r.end <= decl.end) picked.set(r.pos, r);
  }
  const results: { number: number; detail?: string; files: string[] }[] = [];
  const seen = new Set<string>();
  for (const r of [...picked.values()].sort((a, b) => a.pos - b.pos)) {
    for (const c of citesIn(text.slice(r.pos, r.end), r.pos)) {
      const k = `${c.number}|${c.detail ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const res: { number: number; detail?: string; files: string[] } = { number: c.number, files: idx.adrFiles.get(c.number) ?? [] };
      if (c.detail !== undefined) res.detail = c.detail;
      results.push(res);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------
// Cheap independent checks for heritage, definition and abstain
// ---------------------------------------------------------------------------------------------------

export function heritageSubtypes(idx: Index, symbol: string): { file: string; symbol: string; line: number }[] {
  const out: { file: string; symbol: string; line: number }[] = [];
  for (const unit of idx.units.values()) {
    if (!unit.rel.endsWith('.cts')) continue;
    const visit = (n: ts.Node): void => {
      if ((ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name !== undefined && n.heritageClauses !== undefined) {
        for (const h of n.heritageClauses) {
          for (const t of h.types) {
            const e = t.expression;
            const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
            if (name === symbol) out.push({ file: unit.rel, symbol: n.name.text, line: lineOf(unit, n.name.getStart(unit.sf)) });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(unit.sf);
  }
  return out.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
}

export function declarationsNamed(idx: Index, symbol: string, underPrefix: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const unit of idx.units.values()) {
    if (!unit.rel.startsWith(underPrefix) || !unit.rel.endsWith('.cts')) continue;
    for (const occ of unit.ids.get(symbol) ?? []) {
      const p = occ.parent;
      const isDecl =
        (ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p)) && p.name === occ;
      const isVar = ts.isVariableDeclaration(p) && p.name === occ && ts.isVariableDeclarationList(p.parent) && ts.isVariableStatement(p.parent.parent) && p.parent.parent.parent === unit.sf;
      if (isDecl || isVar) out.push({ file: unit.rel, line: lineOf(unit, occ.getStart(unit.sf)) });
    }
  }
  return out.sort((a, b) => cmp(a.file, b.file) || a.line - b.line);
}

export function symbolAbsent(idx: Index, symbol: string): boolean {
  for (const unit of idx.units.values()) if (unit.ids.has(symbol)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Not awaited: build-v2.ts imports this module, so a top-level await here would deadlock.
  void import('./build-v2.ts').then((m) => m.main(process.argv.slice(2)));
}
void fs;
