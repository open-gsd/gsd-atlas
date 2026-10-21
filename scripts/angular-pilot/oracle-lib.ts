/**
 * Prototype pieces of a compiler-based answer-key oracle for an UNSCORED, UNREGISTERED angular pilot.
 * Reads a checkout, never runs its code, never installs its dependencies: the TypeScript language service of
 * THIS repository's `typescript` is pointed at the checkout's tsconfig `paths`, so workspace packages resolve
 * to their sources and everything that lives in `node_modules` (rxjs, zone.js, ...) stays unresolved, which
 * makes the values typed by it `any` (references through them are not found by the compiler).
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

export type DeclKind = 'class' | 'interface' | 'function' | 'type' | 'const' | 'enum';

export interface Decl {
  name: string;
  kind: DeclKind;
  file: string;
  line: number;
}

export interface HeritageRow {
  cls: string;
  file: string;
  extends: string[];
  implements: string[];
  line: number;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function nameOfExpr(e: ts.Expression): string {
  return ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : e.getText();
}

function heritageNames(clause: ts.HeritageClause): string[] {
  return clause.types.map((t) => nameOfExpr(t.expression));
}

/** Syntax-only census of one file: exported top-level declarations and the heritage of every top-level class or interface. */
export function censusOfSource(file: string, text: string): { decls: Decl[]; heritage: HeritageRow[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);
  const decls: Decl[] = [];
  const heritage: HeritageRow[] = [];
  for (const stmt of sf.statements) {
    const exported = isExported(stmt);
    if (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
      if (stmt.name === undefined) continue;
      const kind: DeclKind = ts.isClassDeclaration(stmt) ? 'class' : 'interface';
      if (exported) decls.push({ name: stmt.name.text, kind, file, line: lineOf(sf, stmt) });
      const ext: string[] = [];
      const impl: string[] = [];
      for (const clause of stmt.heritageClauses ?? []) {
        (clause.token === ts.SyntaxKind.ImplementsKeyword ? impl : ext).push(...heritageNames(clause));
      }
      if (ext.length > 0 || impl.length > 0) {
        heritage.push({ cls: stmt.name.text, file, extends: ext, implements: impl, line: lineOf(sf, stmt) });
      }
    } else if (exported && ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) {
      decls.push({ name: stmt.name.text, kind: 'function', file, line: lineOf(sf, stmt) });
    } else if (exported && ts.isTypeAliasDeclaration(stmt)) {
      decls.push({ name: stmt.name.text, kind: 'type', file, line: lineOf(sf, stmt) });
    } else if (exported && ts.isEnumDeclaration(stmt)) {
      decls.push({ name: stmt.name.text, kind: 'enum', file, line: lineOf(sf, stmt) });
    } else if (exported && ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) decls.push({ name: d.name.text, kind: 'const', file, line: lineOf(sf, d) });
      }
    }
  }
  return { decls, heritage };
}

export interface Ref {
  file: string;
  line: number;
  isDefinition: boolean;
  /** Offset of the reference in the file text (UTF-16 units). */
  pos: number;
}

export interface PilotOracleOptions {
  /** Checkout root (absolute). */
  root: string;
  /** tsconfig path relative to `root`; only its `compilerOptions` are used. */
  tsconfig: string;
  /** Which files (posix, relative to `root`) are in the program. */
  include: (rel: string) => boolean;
  /** Explicit file list (relative); default is a walk of `root` skipping `.git` and `node_modules`. */
  files?: readonly string[];
}

export interface PilotOracle {
  files: readonly string[];
  references(file: string, name: string): Ref[];
  callSites(file: string, name: string): Ref[];
  directSubtypes(file: string, name: string): HeritageRow[];
  unresolvedSpecifiers(): { specifier: string; files: number }[];
  dispose(): void;
}

const CODE = /\.(ts|tsx|mts|cts)$/;

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (CODE.test(e.name)) out.push(r);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function createPilotOracle(opts: PilotOracleOptions): PilotOracle {
  const root = fs.realpathSync.native(opts.root);
  const cfgPath = path.join(root, opts.tsconfig);
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
  if (read.error !== undefined) throw new Error(`cannot read ${opts.tsconfig}`);
  const parsed = ts.parseJsonConfigFileContent({ compilerOptions: read.config?.compilerOptions ?? {} }, ts.sys, path.dirname(cfgPath));
  const options: ts.CompilerOptions = {
    ...parsed.options,
    types: [],
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ignoreDeprecations: '6.0',
    outDir: undefined,
    rootDir: undefined,
  };
  const rels = (opts.files ?? walk(root)).filter((r) => CODE.test(r) && opts.include(r)).sort();
  const abs = rels.map((r) => path.join(root, r));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => abs,
    getScriptVersion: () => '1',
    getScriptSnapshot: (f) => (fs.existsSync(f) && fs.statSync(f).isFile() ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined),
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = ls.getProgram();
  if (program === undefined) throw new Error('no program');
  const checker = program.getTypeChecker();
  const inSet = new Set(abs);
  const relOf = (f: string): string => toPosix(path.relative(root, f));

  function locate(file: string, name: string): { sf: ts.SourceFile; id: ts.Identifier } {
    const sf = program!.getSourceFile(path.join(root, file));
    if (sf === undefined) throw new Error(`${file} is not in the program`);
    for (const stmt of sf.statements) {
      if ((ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isFunctionDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt)) && stmt.name?.text === name) {
        return { sf, id: stmt.name };
      }
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return { sf, id: d.name };
      }
    }
    throw new Error(`${name} is not declared at top level in ${file}`);
  }

  function references(file: string, name: string): Ref[] {
    const { sf, id } = locate(file, name);
    const seen = new Map<string, Ref>();
    for (const group of ls.findReferences(sf.fileName, id.getStart(sf)) ?? []) {
      for (const r of group.references) {
        if (!inSet.has(r.fileName)) continue;
        const rsf = program!.getSourceFile(r.fileName)!;
        const line = rsf.getLineAndCharacterOfPosition(r.textSpan.start).line + 1;
        seen.set(`${r.fileName}:${r.textSpan.start}`, { file: relOf(r.fileName), line, isDefinition: r.isDefinition === true, pos: r.textSpan.start });
      }
    }
    return [...seen.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  }

  function nodeAt(sf: ts.SourceFile, pos: number): ts.Node {
    let found: ts.Node = sf;
    const visit = (n: ts.Node): void => {
      if (pos >= n.getStart(sf) && pos < n.getEnd()) {
        found = n;
        ts.forEachChild(n, visit);
      }
    };
    ts.forEachChild(sf, visit);
    return found;
  }

  function isCallee(node: ts.Node): boolean {
    let n: ts.Node = node;
    if (n.parent !== undefined && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
    const p = n.parent;
    if (p === undefined) return false;
    return ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) || (ts.isTaggedTemplateExpression(p) && p.tag === n);
  }

  function callSites(file: string, name: string): Ref[] {
    return references(file, name).filter((r) => {
      if (r.isDefinition) return false;
      const sf = program!.getSourceFile(path.join(root, r.file))!;
      const node = nodeAt(sf, r.pos);
      return ts.isIdentifier(node) && isCallee(node);
    });
  }

  function resolved(expr: ts.Expression): ts.Symbol | undefined {
    const id = ts.isPropertyAccessExpression(expr) ? expr.name : expr;
    let sym = checker.getSymbolAtLocation(id);
    if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) sym = checker.getAliasedSymbol(sym);
    return sym;
  }

  function directSubtypes(file: string, name: string): HeritageRow[] {
    const { id } = locate(file, name);
    let target = checker.getSymbolAtLocation(id);
    if (target !== undefined && (target.flags & ts.SymbolFlags.Alias) !== 0) target = checker.getAliasedSymbol(target);
    const rows: HeritageRow[] = [];
    for (const sf of program!.getSourceFiles()) {
      if (!inSet.has(sf.fileName)) continue;
      const visit = (n: ts.Node): void => {
        if ((ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isInterfaceDeclaration(n)) && n.heritageClauses !== undefined) {
          const ext: string[] = [];
          const impl: string[] = [];
          let hit = false;
          for (const clause of n.heritageClauses) {
            for (const t of clause.types) {
              if (resolved(t.expression) === target) {
                hit = true;
                (clause.token === ts.SyntaxKind.ImplementsKeyword ? impl : ext).push(nameOfExpr(t.expression));
              }
            }
          }
          if (hit) rows.push({ cls: n.name?.text ?? '(anonymous)', file: relOf(sf.fileName), extends: ext, implements: impl, line: lineOf(sf, n) });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  }

  function unresolvedSpecifiers(): { specifier: string; files: number }[] {
    const counts = new Map<string, Set<string>>();
    for (const sf of program!.getSourceFiles()) {
      if (!inSet.has(sf.fileName)) continue;
      for (const stmt of sf.statements) {
        let spec: string | undefined;
        if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier)) spec = stmt.moduleSpecifier.text;
        else if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference) && ts.isStringLiteral(stmt.moduleReference.expression)) spec = stmt.moduleReference.expression.text;
        if (spec === undefined) continue;
        const r = ts.resolveModuleName(spec, sf.fileName, options, host);
        if (r.resolvedModule === undefined) {
          const set = counts.get(spec) ?? new Set<string>();
          set.add(sf.fileName);
          counts.set(spec, set);
        }
      }
    }
    return [...counts.entries()].map(([specifier, f]) => ({ specifier, files: f.size })).sort((a, b) => b.files - a.files || (a.specifier < b.specifier ? -1 : 1));
  }

  return { files: rels, references, callSites, directSubtypes, unresolvedSpecifiers, dispose: () => ls.dispose() };
}
