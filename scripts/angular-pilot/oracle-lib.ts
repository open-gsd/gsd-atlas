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

export type RefRole = 'definition' | 'import' | 'export' | 'reexport' | 'call' | 'use' | 'doc' | 'other';

export interface ClassifiedRef extends Ref {
  role: RefRole;
  /** The occurrence sits inside a type node (annotation, generic argument, `implements`, `typeof` in a type). */
  typeOnly: boolean;
  /** Name of the nearest enclosing named function, method or class (constructor), or `<module>`. */
  enclosing: string;
  /** The identifier text at the reference (differs from the declared name for an alias). */
  text: string;
}

export interface ImpactResult {
  /** Files with a direct call, without the target's own file. */
  direct: string[];
  /** Files calling a function, method or class whose body holds a direct call (not already in `direct`, not the target file). */
  viaCallers: string[];
  /** direct plus viaCallers. */
  files: string[];
}

export interface AnyRiskSite {
  file: string;
  line: number;
  text: string;
}

export interface PilotOracle {
  files: readonly string[];
  references(file: string, name: string): Ref[];
  /** Every compiler reference with a role; roles `call` and `use` are the uses the counting rules accept. */
  classifiedReferences(file: string, name: string): ClassifiedRef[];
  /** Uses (role `use` or `call`) of the declared symbol, through aliases; declaration, import/export specifiers and re-exports left out. */
  referenceSites(file: string, name: string): ClassifiedRef[];
  callSites(file: string, name: string): ClassifiedRef[];
  impactDepthTwo(file: string, name: string): ImpactResult;
  definitionOf(file: string, name: string): { file: string; line: number };
  /** Identifiers spelled `name` that the compiler could not bind to any symbol (typed `any` or from an unresolved module). */
  anyRiskSites(file: string, name: string): AnyRiskSite[];
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
    while (
      n.parent !== undefined &&
      (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent) || ts.isTypeAssertionExpression(n.parent) || ts.isSatisfiesExpression(n.parent))
    ) {
      n = n.parent;
    }
    const p = n.parent;
    if (p === undefined) return false;
    return ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) || (ts.isTaggedTemplateExpression(p) && p.tag === n) || (ts.isDecorator(p) && p.expression === n);
  }

  /** The symbol an identifier denotes, with import/export aliases followed; undefined when unbound or unresolved. */
  function symbolOf(id: ts.Node): ts.Symbol | undefined {
    let sym: ts.Symbol | undefined;
    if (ts.isIdentifier(id) && id.parent !== undefined && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id) {
      sym = checker.getShorthandAssignmentValueSymbol(id.parent);
    } else {
      sym = checker.getSymbolAtLocation(id);
    }
    if (sym !== undefined && (sym.flags & ts.SymbolFlags.Alias) !== 0) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch {
        return undefined;
      }
    }
    if (sym !== undefined && sym.declarations === undefined && String(sym.escapedName) === 'unknown') return undefined;
    return sym;
  }

  function identifierAt(sf: ts.SourceFile, pos: number): ts.Identifier | undefined {
    const n = nodeAt(sf, pos);
    return ts.isIdentifier(n) && n.getStart(sf) === pos ? n : undefined;
  }

  const isDeclarationName = (p: ts.Node, id: ts.Node): boolean =>
    (ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isInterfaceDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === id;

  function inTypeNode(id: ts.Node): boolean {
    for (let n: ts.Node | undefined = id.parent; n !== undefined; n = n.parent) {
      if (ts.isExpressionWithTypeArguments(n)) return n.parent !== undefined && ts.isHeritageClause(n.parent) && n.parent.token === ts.SyntaxKind.ImplementsKeyword;
      if (ts.isTypeNode(n)) return true;
      if (ts.isStatement(n)) return false;
      if (ts.isExpression(n) && !ts.isIdentifier(n) && !ts.isPropertyAccessExpression(n)) return false;
    }
    return false;
  }

  interface Unit {
    name: string;
    sym: ts.Symbol;
    fileName: string;
    pos: number;
  }

  /** The nearest enclosing named function, method, accessor, arrow/function bound to a name, or class (for a constructor or field initializer). */
  function enclosingUnit(node: ts.Node): Unit | undefined {
    const make = (nameNode: ts.Node | undefined): Unit | undefined => {
      if (nameNode === undefined || !ts.isIdentifier(nameNode)) return undefined;
      const sym = checker.getSymbolAtLocation(nameNode);
      if (sym === undefined) return undefined;
      const sf = nameNode.getSourceFile();
      return { name: nameNode.text, sym, fileName: sf.fileName, pos: nameNode.getStart(sf) };
    };
    for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
      if (ts.isFunctionDeclaration(n) && n.name !== undefined) return make(n.name);
      if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && ts.isIdentifier(n.name)) return make(n.name);
      if (ts.isConstructorDeclaration(n) || ts.isClassStaticBlockDeclaration(n)) return ts.isClassLike(n.parent) ? make(n.parent.name) : undefined;
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const p = n.parent;
        if (ts.isFunctionExpression(n) && n.name !== undefined) return make(n.name);
        if (p !== undefined && (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertyAssignment(p)) && p.initializer === n) return make(p.name);
        continue;
      }
      if (ts.isPropertyDeclaration(n) && n.initializer !== undefined && ts.isClassLike(n.parent)) return make(n.parent.name);
    }
    return undefined;
  }

  const enclosingName = (id: ts.Node): string => enclosingUnit(id)?.name ?? '<module>';

  function classify(ref: Ref, targetSym: ts.Symbol): ClassifiedRef {
    const sf = program!.getSourceFile(path.join(root, ref.file))!;
    const base = { ...ref, typeOnly: false, enclosing: '<module>', text: '' };
    const id = identifierAt(sf, ref.pos);
    if (id === undefined) return { ...base, role: 'doc' };
    const p = id.parent;
    const text = id.text;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || (ts.isImportEqualsDeclaration(p) && p.name === id)) return { ...base, role: 'import', text };
    if (ts.isExportSpecifier(p)) return { ...base, role: p.parent.parent.moduleSpecifier !== undefined ? 'reexport' : 'export', text };
    if (ts.isNamespaceExport(p)) return { ...base, role: 'reexport', text };
    const sym = symbolOf(id);
    if (sym !== targetSym) return { ...base, role: 'other', text };
    if (isDeclarationName(p, id)) return { ...base, role: 'definition', text };
    const typeOnly = inTypeNode(id);
    return { ...base, role: !typeOnly && isCallee(id) ? 'call' : 'use', typeOnly, enclosing: enclosingName(id), text };
  }

  function classifiedAt(fileName: string, pos: number, targetSym: ts.Symbol): ClassifiedRef[] {
    const seen = new Map<string, ClassifiedRef>();
    for (const group of ls.findReferences(fileName, pos) ?? []) {
      for (const r of group.references) {
        if (!inSet.has(r.fileName)) continue;
        const rsf = program!.getSourceFile(r.fileName)!;
        const line = rsf.getLineAndCharacterOfPosition(r.textSpan.start).line + 1;
        const c = classify({ file: relOf(r.fileName), line, isDefinition: r.isDefinition === true, pos: r.textSpan.start }, targetSym);
        seen.set(`${c.file}:${c.pos}`, c);
      }
    }
    return [...seen.values()].sort((a, b) => (a.file === b.file ? a.pos - b.pos : a.file < b.file ? -1 : 1));
  }

  function targetOf(file: string, name: string): { sf: ts.SourceFile; id: ts.Identifier; sym: ts.Symbol } {
    const { sf, id } = locate(file, name);
    const sym = symbolOf(id);
    if (sym === undefined) throw new Error(`${name} in ${file} has no symbol`);
    return { sf, id, sym };
  }

  function classifiedReferences(file: string, name: string): ClassifiedRef[] {
    const t = targetOf(file, name);
    return classifiedAt(t.sf.fileName, t.id.getStart(t.sf), t.sym);
  }

  const referenceSites = (file: string, name: string): ClassifiedRef[] => classifiedReferences(file, name).filter((r) => r.role === 'use' || r.role === 'call');
  const callSites = (file: string, name: string): ClassifiedRef[] => classifiedReferences(file, name).filter((r) => r.role === 'call');

  function impactDepthTwo(file: string, name: string): ImpactResult {
    const direct = callSites(file, name);
    const directFiles = new Set(direct.map((c) => c.file));
    const via = new Set<string>();
    const seen = new Set<string>();
    for (const c of direct) {
      const sf = program!.getSourceFile(path.join(root, c.file))!;
      const id = identifierAt(sf, c.pos);
      if (id === undefined) continue;
      const unit = enclosingUnit(id);
      if (unit === undefined) continue;
      const key = `${unit.fileName}:${unit.pos}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const r of classifiedAt(unit.fileName, unit.pos, unit.sym)) if (r.role === 'call') via.add(r.file);
    }
    const sort = (xs: Iterable<string>): string[] => [...xs].sort();
    const d = sort([...directFiles].filter((f) => f !== file));
    const v = sort([...via].filter((f) => f !== file && !directFiles.has(f)));
    return { direct: d, viaCallers: v, files: sort([...d, ...v]) };
  }

  function definitionOf(file: string, name: string): { file: string; line: number } {
    const { sf, id } = locate(file, name);
    return { file, line: sf.getLineAndCharacterOfPosition(id.getStart(sf)).line + 1 };
  }

  function anyRiskSites(file: string, name: string): AnyRiskSite[] {
    targetOf(file, name);
    const sites: AnyRiskSite[] = [];
    for (const sf of program!.getSourceFiles()) {
      if (!inSet.has(sf.fileName) || !sf.text.includes(name)) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && n.text === name) {
          const p = n.parent;
          const skip = ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isNamespaceExport(p) || ts.isImportEqualsDeclaration(p);
          if (!skip && symbolOf(n) === undefined) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            sites.push({ file: relOf(sf.fileName), line, text: sf.text.split('\n')[line - 1]?.trim() ?? '' });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
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

  return { files: rels, references, classifiedReferences, referenceSites, callSites, impactDepthTwo, definitionOf, anyRiskSites, directSubtypes, unresolvedSpecifiers, dispose: () => ls.dispose() };
}
