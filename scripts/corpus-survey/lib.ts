/**
 * Pure helpers for the corpus survey (docs/eval/corpus-candidates.md). Nothing here executes code from a
 * surveyed repository: sources are parsed with the TypeScript parser (syntax only) and counted.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import ts from 'typescript';

/** Nearest-rank percentile (p in 0..100) of unsorted numbers; NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

/**
 * Deterministic sample: items ranked by sha256(`${seed}\0${item}`), first n taken. The result does not
 * depend on the order of the input.
 */
export function rankBySeed(items: readonly string[], seed: string | number, n: number): string[] {
  const keyed = items.map((item) => ({
    item,
    key: createHash('sha256').update(`${seed}\0${item}`).digest('hex'),
  }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.item < b.item ? -1 : 1));
  return keyed.slice(0, n).map((k) => k.item);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const ext = path.extname(fileName);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, false, scriptKindFor(fileName));
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function propertyKeyName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function isModuleExports(e: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'module' && e.name.text === 'exports';
}

/**
 * Names a file exports as functions, classes or values: `export function/class/const/let/var`,
 * `export default function Name`, and CommonJS `module.exports = {...}`, `exports.x =`, `module.exports.x =`.
 * Types and interfaces are not counted. Local names listed in `export { a as b }` are not counted
 * (they are declarations of a different file or already counted at their declaration).
 */
export function extractExportedNames(source: string, fileName: string): string[] {
  let sf: ts.SourceFile;
  try {
    sf = parse(source, fileName);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && hasExportModifier(st) && st.name !== undefined) names.push(st.name.text);
    else if (ts.isClassDeclaration(st) && hasExportModifier(st) && st.name !== undefined) names.push(st.name.text);
    else if (ts.isVariableStatement(st) && hasExportModifier(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    } else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = st.expression;
      if (isModuleExports(left) && ts.isObjectLiteralExpression(right)) {
        for (const p of right.properties) {
          const key = ts.isSpreadAssignment(p) ? undefined : propertyKeyName(p.name);
          if (key !== undefined) names.push(key);
        }
      } else if (ts.isPropertyAccessExpression(left)) {
        const target = left.expression;
        if ((ts.isIdentifier(target) && target.text === 'exports') || isModuleExports(target)) names.push(left.name.text);
      }
    }
  }
  return names;
}

/** Static module specifiers of a file: import, export-from, `import x = require()`, `require('x')`, `import('x')`. */
export function extractSpecifiers(source: string, fileName: string): string[] {
  let sf: ts.SourceFile;
  try {
    sf = parse(source, fileName);
  } catch {
    return [];
  }
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) out.push(node.moduleReference.expression.text);
    else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const callee = node.expression;
      const arg = node.arguments[0] as ts.Expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamic) && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** True when most non-import top-level statements are re-exports (`export * from`, `export { x } from`, `export { x }`). */
export function isBarrel(source: string, fileName: string): boolean {
  let sf: ts.SourceFile;
  try {
    sf = parse(source, fileName);
  } catch {
    return false;
  }
  const body = sf.statements.filter((s) => !ts.isImportDeclaration(s));
  if (body.length === 0) return false;
  const reexports = body.filter((s) => ts.isExportDeclaration(s)).length;
  return reexports / body.length >= 0.8;
}

export interface AmbiguityStats {
  /** Total exported-name declarations (a name exported twice from one file counts twice). */
  declarations: number;
  distinctNames: number;
  /** Names exported from more than one file. */
  multiFileNames: number;
}

export function ambiguityStats(namesByFile: ReadonlyMap<string, readonly string[]>): AmbiguityStats {
  const filesOfName = new Map<string, Set<string>>();
  let declarations = 0;
  for (const [file, names] of namesByFile) {
    for (const n of names) {
      declarations++;
      let set = filesOfName.get(n);
      if (set === undefined) filesOfName.set(n, (set = new Set()));
      set.add(file);
    }
  }
  let multiFileNames = 0;
  for (const set of filesOfName.values()) if (set.size > 1) multiFileNames++;
  return { declarations, distinctNames: filesOfName.size, multiFileNames };
}

const TEST_DIR = /(^|\/)(__tests__|tests?|specs?|fixtures?|__fixtures__|__mocks__|testdata|baselines|e2e)(\/|$)/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestPath(p: string): boolean {
  return TEST_DIR.test(p) || TEST_FILE.test(p);
}

const AGENT_BASENAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.mcp.json']);
const AGENT_DIRS = ['.claude/', '.cursor/', '.agents/', '.codex/', '.windsurf/', '.github/skills/'];

/** Tracked paths that configure a coding agent; an eval checkout must be clean of them. */
export function agentConfigPaths(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (AGENT_BASENAMES.has(base)) return true;
    if (p === '.github/copilot-instructions.md') return true;
    return AGENT_DIRS.some((d) => p.startsWith(d) || p.includes(`/${d}`));
  });
}

/** Rough SPDX classification of a LICENSE file's text. `UNCLEAR` means a human must read it. */
export function classifyLicense(text: string): string {
  const t = text.toUpperCase();
  if (t.includes('GNU AFFERO GENERAL PUBLIC LICENSE')) return 'AGPL-3.0';
  if (t.includes('GNU LESSER GENERAL PUBLIC LICENSE')) return 'LGPL';
  if (t.includes('GNU GENERAL PUBLIC LICENSE')) return 'GPL';
  if (t.includes('SUSTAINABLE USE LICENSE')) return 'LicenseRef-SUL-1.0 (fair-code, not OSI)';
  if (t.includes('ELASTIC LICENSE')) return 'Elastic-2.0 (source-available, not OSI)';
  if (t.includes('APACHE LICENSE') && t.includes('VERSION 2.0')) return 'Apache-2.0';
  if (t.includes('MOZILLA PUBLIC LICENSE')) return 'MPL-2.0';
  if (t.includes('PERMISSION IS HEREBY GRANTED, FREE OF CHARGE')) return 'MIT';
  if (t.includes('REDISTRIBUTION AND USE IN SOURCE AND BINARY FORMS')) {
    return t.includes('NEITHER THE NAME') ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (t.includes('PERMISSION TO USE, COPY, MODIFY, AND/OR DISTRIBUTE')) return 'ISC';
  return 'UNCLEAR';
}

export type SpecifierKind = 'relative' | 'workspace' | 'external';

/** Classify an import specifier against the package names found in the repository's own package.json files. */
export function classifySpecifier(spec: string, workspaceNames: ReadonlySet<string>): SpecifierKind {
  if (spec.startsWith('.') || spec.startsWith('/')) return 'relative';
  if (spec.startsWith('node:')) return 'external';
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
  return workspaceNames.has(pkg) ? 'workspace' : 'external';
}
