import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import ts from 'typescript';

import {
  AnswerFileSchema,
  AnswerKeySchema,
  loadQuestions,
  type AnswerFile,
  type AnswerItem,
  type AnswerKey,
  type KeySpec,
  type Question,
  type Unexplained,
} from './questions.ts';

/**
 * The independent answer-key oracle of the pre-registered eval (EVL-02, D-02).
 *
 * An expected answer is derived from the TypeScript compiler (program, checker, comment ranges,
 * `getOutputFileNames`) plus `git ls-files` and `git grep` cross-checks, and from nothing else. It
 * reads no store, calls no tool of the system under test and parses nothing with a grammar tier, so
 * the eval never grades tree-sitter against tree-sitter. The only inputs are the corpus checkout and
 * the question file. The corpus is parsed and type-checked, never executed, and a tsconfig whose
 * `extends`, `include` or `files` leave the repository root is refused.
 *
 * Honest limit: the oracle and the system under test share the TypeScript compiler, so a compiler
 * quirk is shared. What the oracle adds on its own is the CommonJS rule (a `require` of an emitted
 * output or of a sibling `.cjs` that resolves back to the defining source), ADR citation handling,
 * and the cross-checks that surface ambiguity as `unexplained`.
 *
 * This file is hashed into the pre-registration, so any edit after the freeze is visible.
 */

/** Part of every answer key; names the plan that froze this logic. */
export const ORACLE_VERSION = '03-04.1';

export interface OracleContext {
  /** The corpus checkout (or fixture) root; must be inside a git work tree. */
  repoDir: string;
  /** The tsconfig to build the program from, absolute or relative to `repoDir`. */
  tsconfig: string;
  /** Directories (relative to `repoDir`) holding ADR files; default `docs/adr`. */
  adrDirs?: readonly string[];
}

/** A problem with the corpus, the question or the environment; `code` is stable and testable. */
export class OracleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OracleError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Paths, text and git

const CODE_EXT = new Set(['.ts', '.cts', '.mts', '.tsx', '.js', '.cjs', '.mjs', '.jsx']);
const JS_EXT = new Set(['.js', '.cjs', '.mjs', '.jsx']);
const ADR_FILE_EXT = new Set(['.md', '.markdown', '.mdx']);

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** Absolute path in the form the compiler uses: forward slashes. */
function norm(value: string): string {
  return toPosix(path.resolve(value));
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Repository-relative POSIX path, or undefined when `abs` is outside `root`. */
export function relInside(root: string, abs: string): string | undefined {
  const resolved = path.resolve(abs);
  if (!isInside(root, resolved)) return undefined;
  return toPosix(path.relative(root, resolved));
}

function assertInside(root: string, target: string, what: string): void {
  if (!isInside(root, target)) {
    throw new OracleError('OUTSIDE_REPO', `${what} resolves outside the repository root: ${target}`);
  }
}

function readText(abs: string): string {
  return fs.readFileSync(abs, 'utf8').replace(/^﻿/, '');
}

/**
 * Line starts as an editor shows them: a break is `\n` (so `\r\n` is one break) and nothing else.
 * U+2028, U+2029 and a lone `\r` are not breaks; a leading BOM never reaches this function.
 */
export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** The 1-based editor line of a character offset, given the starts from `computeLineStarts`. */
export function lineAt(starts: readonly number[], pos: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= pos) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') && name !== 'GIT_SSL_NO_VERIFY') delete env[name];
  }
  return env;
}

/** Runs git with an argument array (never a shell). Exit codes in `okCodes` are not errors. */
function git(repoDir: string, args: readonly string[], okCodes: readonly number[] = [0]): string {
  const result = spawnSync('git', ['-C', repoDir, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 29,
    windowsHide: true,
    env: gitEnv(),
  });
  if (result.error !== undefined) {
    throw new OracleError('GIT_UNAVAILABLE', `cannot run git: ${result.error.message}`);
  }
  if (result.status === null || !okCodes.includes(result.status)) {
    throw new OracleError('GIT_FAILED', `git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function assertGitWorkTree(repoDir: string): void {
  const result = spawnSync('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    windowsHide: true,
    env: gitEnv(),
  });
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim() !== 'true') {
    throw new OracleError('NOT_A_GIT_WORK_TREE', `${repoDir} is not inside a git work tree; the oracle needs git ls-files`);
  }
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

/** `git grep -nw` for a fixed word over tracked files; paths are relative to `repoDir`. */
export function gitGrepWord(repoDir: string, word: string): GrepHit[] {
  const out = git(repoDir, ['grep', '-n', '-z', '-w', '-F', '-I', '--no-color', '-e', word, '--'], [0, 1]);
  const hits: GrepHit[] = [];
  for (const record of out.split('\n')) {
    if (record === '') continue;
    const first = record.indexOf('\0');
    const second = first < 0 ? -1 : record.indexOf('\0', first + 1);
    if (first < 0 || second < 0) continue;
    hits.push({
      file: record.slice(0, first),
      line: Number(record.slice(first + 1, second)),
      text: record.slice(second + 1).replace(/\r$/, ''),
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Program state
//
// Every `export` in the sections below that is not a key kind (`computeAnswerKey`, `verifyCitation`,
// `main`) exists so that later plans reuse the compiler-walking code instead of copying it: the
// question census (03-09, `draft-census.ts`) and the edge-sample and sweep tools of 03-24, 03-25 and
// 03-31. This file is a registered file once plan 03-16 freezes it, so those plans import these
// helpers and never edit this file. Program creation: `stateOf`. Comment scanning: `commentRanges`,
// `commentCitations`, `citationsIn`. Emit-aware specifier resolution: `resolveRequireSpec`,
// `requireCallsTo`. Editor line numbering: `computeLineStarts`, `lineAt`, `lineOfNode`. Declaration
// lookup by name and file: `declarationsNamed`, `resolveTarget`, `exportedTargets`.

export interface Unit {
  rel: string;
  sf: ts.SourceFile;
  lineStarts: number[];
  checker?: ts.TypeChecker;
  program?: ts.Program;
  main: boolean;
}

export interface RequireCall {
  call: ts.CallExpression;
  spec: string;
}

export interface State {
  repoDir: string;
  parsed: ts.ParsedCommandLine;
  program: ts.Program;
  checker: ts.TypeChecker;
  units: Map<string, Unit>;
  /** Root file name exactly as the compiler lists it, by repository-relative path. */
  rootNames: Map<string, string>;
  rootAbs: Map<string, string>;
  emitInverse: Map<string, string>;
  tracked?: string[];
  jsUnits?: Map<string, Unit>;
  parseOnly: Map<string, Unit>;
  adrDirs: readonly string[];
  adrFilesCache?: Map<number, string[]>;
  requireCache: Map<Unit, RequireCall[]>;
  /** `requireCallsTo` answers by source file; the scan is the same for every symbol of that file. */
  requireToCache: Map<string, { unit: Unit; call: ts.CallExpression }[]>;
  idCache: Map<Unit, Map<string, ts.Identifier[]>>;
}

const stateCache = new WeakMap<OracleContext, State>();

function scriptKindOf(rel: string): ts.ScriptKind {
  switch (path.extname(rel).toLowerCase()) {
    case '.js':
    case '.cjs':
    case '.mjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function makeUnit(
  rel: string,
  sf: ts.SourceFile,
  main: boolean,
  checker?: ts.TypeChecker,
  program?: ts.Program,
): Unit {
  return { rel, sf, lineStarts: computeLineStarts(sf.text), checker, program, main };
}

function flattenDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ');
}

/** Refuses any tsconfig `extends`, `include` or `files` that points outside the repository (T-03-42). */
function assertConfigConfined(repoDir: string, tsconfigAbs: string): void {
  const read = ts.readConfigFile(tsconfigAbs, (file) => ts.sys.readFile(file));
  if (read.error !== undefined) {
    throw new OracleError('TSCONFIG_UNREADABLE', `${tsconfigAbs}: ${flattenDiagnostics([read.error])}`);
  }
  const raw: unknown = read.config;
  if (typeof raw !== 'object' || raw === null) return;
  const configDir = path.dirname(tsconfigAbs);
  const record = raw as Record<string, unknown>;
  const extendsValue = record.extends;
  const extendsList = typeof extendsValue === 'string' ? [extendsValue] : Array.isArray(extendsValue) ? extendsValue : [];
  for (const entry of extendsList) {
    if (typeof entry !== 'string') continue;
    if (entry.startsWith('.') || path.isAbsolute(entry)) {
      assertInside(repoDir, path.resolve(configDir, entry), 'tsconfig extends');
    }
  }
  for (const field of ['include', 'files']) {
    const value = record[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string') assertInside(repoDir, path.resolve(configDir, entry), `tsconfig ${field}`);
    }
  }
}

function buildState(ctx: OracleContext): State {
  let repoDir: string;
  try {
    repoDir = fs.realpathSync.native(ctx.repoDir);
  } catch {
    throw new OracleError('REPO_MISSING', `repository directory does not exist: ${ctx.repoDir}`);
  }
  assertGitWorkTree(repoDir);

  const tsconfigAbs = path.resolve(repoDir, ctx.tsconfig);
  assertInside(repoDir, tsconfigAbs, 'tsconfig');
  assertConfigConfined(repoDir, tsconfigAbs);

  const parseHost: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new OracleError('TSCONFIG_UNREADABLE', `${tsconfigAbs}: ${flattenDiagnostics([diagnostic])}`);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigAbs, {}, parseHost);
  if (parsed === undefined) throw new OracleError('TSCONFIG_UNREADABLE', `cannot parse ${tsconfigAbs}`);
  const configSource = parsed.options.configFile as ts.TsConfigSourceFile | undefined;
  for (const extended of configSource?.extendedSourceFiles ?? []) {
    assertInside(repoDir, path.resolve(extended), 'tsconfig extends');
  }
  if (parsed.fileNames.length === 0) {
    throw new OracleError('TSCONFIG_NO_INPUTS', `${tsconfigAbs} selects no source files`);
  }
  for (const fileName of parsed.fileNames) assertInside(repoDir, path.resolve(fileName), 'tsconfig input file');

  // The program only parses and binds; module detection is forced so that top-level names of
  // different files never merge into one global scope.
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const program = ts.createProgram({ rootNames: parsed.fileNames, options });
  const checker = program.getTypeChecker();

  const units = new Map<string, Unit>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || program.isSourceFileFromExternalLibrary(sf) || program.isSourceFileDefaultLibrary(sf)) {
      continue;
    }
    const rel = relInside(repoDir, sf.fileName);
    if (rel === undefined) continue;
    units.set(rel, makeUnit(rel, sf, true, checker, program));
  }

  const rootNames = new Map<string, string>();
  const rootAbs = new Map<string, string>();
  const emitInverse = new Map<string, string>();
  for (const fileName of parsed.fileNames) {
    const rel = relInside(repoDir, fileName);
    if (rel === undefined) continue;
    rootNames.set(rel, fileName);
    rootAbs.set(norm(fileName), rel);
    if (/\.d\.[cm]?ts$/.test(fileName)) continue;
    // Declaration files never emit; every other root maps its emitted outputs back to the source.
    for (const output of ts.getOutputFileNames(parsed, fileName, false)) {
      emitInverse.set(norm(output), rel);
    }
  }

  return {
    repoDir,
    parsed,
    program,
    checker,
    units,
    rootNames,
    rootAbs,
    emitInverse,
    parseOnly: new Map(),
    adrDirs: ctx.adrDirs ?? ['docs/adr'],
    requireCache: new Map(),
    requireToCache: new Map(),
    idCache: new Map(),
  };
}

export function stateOf(ctx: OracleContext): State {
  let state = stateCache.get(ctx);
  if (state === undefined) {
    state = buildState(ctx);
    stateCache.set(ctx, state);
  }
  return state;
}

export function trackedFiles(state: State): string[] {
  if (state.tracked === undefined) {
    state.tracked = git(state.repoDir, ['ls-files', '-z'])
      .split('\0')
      .filter((entry) => entry !== '');
  }
  return state.tracked;
}

/**
 * Tracked JavaScript outside the tsconfig program (for example `.cjs` consumers), parsed and bound
 * in a second program that does no module resolution. It exists so that scope-correct symbols are
 * available for the CommonJS rule.
 */
function jsUnitsOf(state: State): Map<string, Unit> {
  if (state.jsUnits !== undefined) return state.jsUnits;
  const units = new Map<string, Unit>();
  const rootsByAbs = new Map<string, string>();
  for (const rel of trackedFiles(state)) {
    if (!JS_EXT.has(path.extname(rel).toLowerCase())) continue;
    if (state.units.has(rel) || rel.split('/').includes('node_modules')) continue;
    rootsByAbs.set(norm(path.join(state.repoDir, rel)), rel);
  }
  if (rootsByAbs.size > 0) {
    const program = ts.createProgram({
      rootNames: [...rootsByAbs.keys()],
      options: {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        noResolve: true,
        noLib: true,
        types: [],
        skipLibCheck: true,
        maxNodeModuleJsDepth: 0,
        moduleDetection: ts.ModuleDetectionKind.Force,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
      },
    });
    const checker = program.getTypeChecker();
    for (const sf of program.getSourceFiles()) {
      const rel = rootsByAbs.get(norm(sf.fileName));
      if (rel !== undefined) units.set(rel, makeUnit(rel, sf, false, checker, program));
    }
  }
  state.jsUnits = units;
  return units;
}

export function allUnits(state: State): Unit[] {
  return [...state.units.values(), ...jsUnitsOf(state).values()];
}

/** Any tracked code file as a unit; files outside both programs are parsed without a checker. */
export function quickUnit(state: State, rel: string): Unit | undefined {
  const known = state.units.get(rel) ?? state.jsUnits?.get(rel) ?? state.parseOnly.get(rel);
  if (known !== undefined) return known;
  if (!CODE_EXT.has(path.extname(rel).toLowerCase())) return undefined;
  const abs = path.join(state.repoDir, rel);
  if (!fs.existsSync(abs)) return undefined;
  const sf = ts.createSourceFile(abs, readText(abs), ts.ScriptTarget.ESNext, true, scriptKindOf(rel));
  const unit = makeUnit(rel, sf, false);
  state.parseOnly.set(rel, unit);
  return unit;
}

// ---------------------------------------------------------------------------------------------
// Syntax helpers

export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function idsOf(state: State, unit: Unit): Map<string, ts.Identifier[]> {
  let ids = state.idCache.get(unit);
  if (ids === undefined) {
    ids = new Map();
    const collected = ids;
    walk(unit.sf, (node) => {
      if (ts.isIdentifier(node)) {
        const list = collected.get(node.text);
        if (list === undefined) collected.set(node.text, [node]);
        else list.push(node);
      }
    });
    state.idCache.set(unit, ids);
  }
  return ids;
}

export function lineOfNode(unit: Unit, node: ts.Node): number {
  return lineAt(unit.lineStarts, node.getStart(unit.sf));
}

/** The identifier that names a declaration node, for the declaration kinds the oracle tracks. */
export function declName(node: ts.Node): ts.Identifier | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isVariableDeclaration(node)
  ) {
    const name = node.name;
    if (name !== undefined && ts.isIdentifier(name)) return name;
  }
  return undefined;
}

/** A declaration at file or namespace level, or a member of a class or interface; never a local. */
export function isTopOrMember(node: ts.Node): boolean {
  let parent: ts.Node = node.parent;
  if (ts.isVariableDeclaration(node)) {
    if (!ts.isVariableDeclarationList(parent) || !ts.isVariableStatement(parent.parent)) return false;
    parent = parent.parent.parent;
  }
  return ts.isSourceFile(parent) || ts.isModuleBlock(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent);
}

function isCallee(node: ts.Node): boolean {
  const parent = node.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return true;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return isCallee(parent);
  if ((ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) && parent.expression === node) {
    return isCallee(parent);
  }
  return false;
}

/** Name of the function or method that contains a node; `<module>` for top-level code. */
function enclosingName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      const name = current.name;
      if (name !== undefined && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))) {
        return name.text;
      }
    } else if (ts.isConstructorDeclaration(current)) {
      return 'constructor';
    } else if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      if (ts.isFunctionExpression(current) && current.name !== undefined) return current.name.text;
      const holder: ts.Node = current.parent;
      if ((ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) && ts.isIdentifier(holder.name)) {
        return holder.name.text;
      }
      if (
        ts.isBinaryExpression(holder) &&
        holder.right === current &&
        ts.isPropertyAccessExpression(holder.left)
      ) {
        return holder.left.name.text;
      }
    } else if (ts.isPropertyDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }
  }
  return '<module>';
}

export function symbolAt(checker: ts.TypeChecker, id: ts.Identifier): ts.Symbol | undefined {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === id) {
    return checker.getShorthandAssignmentValueSymbol(parent) ?? checker.getSymbolAtLocation(id);
  }
  return checker.getSymbolAtLocation(id);
}

/** Follows an import alias to its target and an exported local to its export symbol. */
export function canon(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let resolved = symbol;
  if ((resolved.flags & ts.SymbolFlags.Alias) !== 0) resolved = checker.getAliasedSymbol(resolved);
  return checker.getExportSymbolOfSymbol(resolved);
}

const COMMENT_CACHE = new WeakMap<ts.SourceFile, ts.CommentRange[]>();

/**
 * Every comment of a file, found through the compiler's own trivia scanning at the full start of
 * each token of the syntax tree. Walking tokens (not raw text) keeps `//` inside a string, template
 * or regular expression from being mistaken for a comment. Kinds are SingleLineCommentTrivia and
 * MultiLineCommentTrivia only.
 */
export function commentRanges(sf: ts.SourceFile): ts.CommentRange[] {
  const cached = COMMENT_CACHE.get(sf);
  if (cached !== undefined) return cached;
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const text = sf.text;
  const collect = (pos: number): void => {
    const found = [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])];
    for (const range of found) {
      if (
        (range.kind === ts.SyntaxKind.SingleLineCommentTrivia || range.kind === ts.SyntaxKind.MultiLineCommentTrivia) &&
        !seen.has(range.pos)
      ) {
        seen.add(range.pos);
        ranges.push(range);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      collect(node.getFullStart());
      return;
    }
    for (const child of children) visit(child);
  };
  visit(sf);
  ranges.sort((a, b) => a.pos - b.pos);
  COMMENT_CACHE.set(sf, ranges);
  return ranges;
}

// ---------------------------------------------------------------------------------------------
// Results

function mkItem(fields: {
  file?: string;
  line?: number;
  symbol?: string;
  adr?: number;
  resolved?: boolean;
  detail?: string;
}): AnswerItem {
  const item: AnswerItem = {};
  if (fields.file !== undefined) item.file = fields.file;
  if (fields.line !== undefined) item.line = fields.line;
  if (fields.symbol !== undefined) item.symbol = fields.symbol;
  if (fields.adr !== undefined) item.adr = fields.adr;
  if (fields.resolved !== undefined) item.resolved = fields.resolved;
  if (fields.detail !== undefined) item.detail = fields.detail;
  return item;
}

function sortItems(items: readonly AnswerItem[]): AnswerItem[] {
  const unique = new Map<string, AnswerItem>();
  for (const item of items) unique.set(JSON.stringify(item), item);
  return [...unique.values()].sort(
    (a, b) =>
      (a.file ?? '').localeCompare(b.file ?? '', 'en') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.symbol ?? '').localeCompare(b.symbol ?? '', 'en') ||
      (a.adr ?? -1) - (b.adr ?? -1) ||
      (a.detail ?? '').localeCompare(b.detail ?? '', 'en'),
  );
}

interface Computed {
  items: AnswerItem[];
  abstain?: boolean;
  needles: string[];
  unexplained?: Unexplained[];
  notes?: Record<string, number | string>;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
}

// ---------------------------------------------------------------------------------------------
// Target symbol and references

export type RefKind = 'definition' | 'import' | 'export' | 'call' | 'read' | 'binding';

export interface RefSite {
  unit: Unit;
  node: ts.Node;
  kind: RefKind;
}

function refKindOf(id: ts.Identifier): RefKind {
  const parent = id.parent;
  if (declName(parent) === id) return 'definition';
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return 'import';
  if (ts.isExportSpecifier(parent)) return 'export';
  return isCallee(id) ? 'call' : 'read';
}

export function declarationsNamed(state: State, unit: Unit, name: string, container?: string): { node: ts.Node; id: ts.Identifier }[] {
  const found: { node: ts.Node; id: ts.Identifier }[] = [];
  for (const id of idsOf(state, unit).get(name) ?? []) {
    const parent = id.parent;
    if (declName(parent) !== id || !isTopOrMember(parent)) continue;
    if (container !== undefined) {
      const holder = parent.parent;
      const holderName =
        ts.isClassDeclaration(holder) || ts.isInterfaceDeclaration(holder) ? holder.name?.text : undefined;
      if (holderName !== container) continue;
    }
    found.push({ node: parent, id });
  }
  return found;
}

export interface Target {
  unit: Unit;
  symbol: ts.Symbol;
  name: string;
  decls: { node: ts.Node; id: ts.Identifier }[];
}

export function resolveTarget(state: State, definedIn: string, name: string, container?: string): Target {
  const unit = state.units.get(definedIn);
  if (unit === undefined || unit.checker === undefined) {
    throw new OracleError('FILE_NOT_IN_PROGRAM', `${definedIn} is not a source file of the program`);
  }
  const decls = declarationsNamed(state, unit, name, container);
  if (decls.length === 0) {
    throw new OracleError('SYMBOL_NOT_FOUND', `${definedIn} has no declaration named ${name}`);
  }
  const symbols = new Set<ts.Symbol>();
  for (const decl of decls) {
    const raw = symbolAt(unit.checker, decl.id);
    if (raw !== undefined) symbols.add(canon(unit.checker, raw));
  }
  if (symbols.size === 0) throw new OracleError('SYMBOL_NOT_FOUND', `${definedIn}: no symbol for ${name}`);
  if (symbols.size > 1) {
    throw new OracleError(
      'SYMBOL_AMBIGUOUS',
      `${definedIn} declares ${name} as ${symbols.size} different symbols; name a container`,
    );
  }
  return { unit, symbol: [...symbols][0], name, decls };
}

/** References the checker sees: identifiers (and import aliases) that resolve to the target symbol. */
function typedRefs(state: State, target: ts.Symbol, name: string, aliases: Set<string>): RefSite[] {
  const sites: RefSite[] = [];
  for (const unit of state.units.values()) {
    const checker = unit.checker;
    if (checker === undefined) continue;
    const names = new Set([name]);
    for (const statement of unit.sf.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const specifier of bindings.elements) {
        if ((specifier.propertyName ?? specifier.name).text === name) names.add(specifier.name.text);
      }
    }
    for (const candidate of names) {
      for (const id of idsOf(state, unit).get(candidate) ?? []) {
        const raw = symbolAt(checker, id);
        if (raw === undefined || canon(checker, raw) !== target) continue;
        if (candidate !== name) aliases.add(candidate);
        sites.push({ unit, node: id, kind: refKindOf(id) });
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------------------------
// CommonJS rule

function requireCallsOf(state: State, unit: Unit): RequireCall[] {
  let calls = state.requireCache.get(unit);
  if (calls === undefined) {
    calls = [];
    const collected = calls;
    for (const id of idsOf(state, unit).get('require') ?? []) {
      const call = id.parent;
      if (!ts.isCallExpression(call) || call.expression !== id || call.arguments.length !== 1) continue;
      const argument = call.arguments[0];
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        collected.push({ call, spec: argument.text });
      }
    }
    state.requireCache.set(unit, calls);
  }
  return calls;
}

const EXT_SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.cjs': ['.cts'],
  '.mjs': ['.mts'],
};

/**
 * The oracle's own resolution of a relative `require` specifier to a source file of the program:
 * an emitted output maps back to its source (inverse of `getOutputFileNames`), a `.cjs`, `.js` or
 * `.mjs` specifier maps to the `.cts`, `.ts` or `.mts` source beside it, and an extensionless
 * specifier is tried with the CommonJS extensions. Anything else is not a reference to the program.
 */
export function resolveRequireSpec(state: State, fromRel: string, spec: string): string | undefined {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return undefined;
  const joined = norm(path.resolve(state.repoDir, path.posix.dirname(fromRel), spec));
  const candidates = path.extname(joined) === '' ? [joined, `${joined}.cjs`, `${joined}.js`, `${joined}/index.js`] : [joined];
  for (const candidate of candidates) {
    const viaEmit = state.emitInverse.get(candidate);
    if (viaEmit !== undefined) return viaEmit;
    const exact = state.rootAbs.get(candidate);
    if (exact !== undefined) return exact;
    const ext = path.extname(candidate);
    for (const substitute of EXT_SUBSTITUTIONS[ext] ?? []) {
      const swapped = state.rootAbs.get(candidate.slice(0, candidate.length - ext.length) + substitute);
      if (swapped !== undefined) return swapped;
    }
  }
  return undefined;
}

/** Every `require(<specifier>)` call, in any tracked JS or program file, that resolves to `sourceRel`. */
export function requireCallsTo(state: State, sourceRel: string): { unit: Unit; call: ts.CallExpression }[] {
  const cached = state.requireToCache.get(sourceRel);
  if (cached !== undefined) return cached;
  const found: { unit: Unit; call: ts.CallExpression }[] = [];
  for (const unit of allUnits(state)) {
    for (const entry of requireCallsOf(state, unit)) {
      if (resolveRequireSpec(state, unit.rel, entry.spec) === sourceRel) found.push({ unit, call: entry.call });
    }
  }
  state.requireToCache.set(sourceRel, found);
  return found;
}

interface CjsResult {
  sites: RefSite[];
  /** Positions of identifiers the rule consumed, by file; the cross-check treats them as explained. */
  positions: Map<string, Set<number>>;
  aliases: Set<string>;
}

function cjsRefs(state: State, sourceRel: string, name: string): CjsResult {
  const sites: RefSite[] = [];
  const positions = new Map<string, Set<number>>();
  const aliases = new Set<string>();

  const mark = (unit: Unit, node: ts.Node): void => {
    let set = positions.get(unit.rel);
    if (set === undefined) {
      set = new Set();
      positions.set(unit.rel, set);
    }
    set.add(node.getStart(unit.sf));
  };
  const add = (unit: Unit, node: ts.Node, kind: RefKind): void => {
    sites.push({ unit, node, kind });
    if (ts.isIdentifier(node) && node.text === name) mark(unit, node);
  };

  const trackLocal = (unit: Unit, local: ts.Identifier): void => {
    const checker = unit.checker;
    if (checker === undefined) return;
    if (local.text !== name) aliases.add(local.text);
    const symbol = checker.getSymbolAtLocation(local);
    if (symbol === undefined) return;
    for (const id of idsOf(state, unit).get(local.text) ?? []) {
      if (id === local || checker.getSymbolAtLocation(id) !== symbol) continue;
      add(unit, id, isCallee(id) ? 'call' : 'read');
    }
  };

  const bindFromPattern = (unit: Unit, pattern: ts.ObjectBindingPattern): void => {
    for (const element of pattern.elements) {
      const key = element.propertyName ?? element.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
      if (keyText !== name) continue;
      add(unit, key, 'binding');
      if (ts.isIdentifier(element.name)) {
        add(unit, element.name, 'binding');
        trackLocal(unit, element.name);
      }
    }
  };

  const useOfMember = (unit: Unit, access: ts.PropertyAccessExpression | ts.ElementAccessExpression, memberNode: ts.Node): void => {
    const grand = access.parent;
    if (ts.isVariableDeclaration(grand) && grand.initializer === access && ts.isIdentifier(grand.name)) {
      add(unit, memberNode, 'binding');
      trackLocal(unit, grand.name);
      return;
    }
    add(unit, memberNode, isCallee(access) ? 'call' : 'read');
  };

  const trackNamespace = (unit: Unit, local: ts.Identifier): void => {
    const checker = unit.checker;
    if (checker === undefined) return;
    const symbol = checker.getSymbolAtLocation(local);
    if (symbol === undefined) return;
    for (const id of idsOf(state, unit).get(local.text) ?? []) {
      if (id === local || checker.getSymbolAtLocation(id) !== symbol) continue;
      const parent = id.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === id && parent.name.text === name) {
        useOfMember(unit, parent, parent.name);
      } else if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === id &&
        ts.isStringLiteralLike(parent.argumentExpression) &&
        parent.argumentExpression.text === name
      ) {
        useOfMember(unit, parent, parent.argumentExpression);
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === id && ts.isObjectBindingPattern(parent.name)) {
        bindFromPattern(unit, parent.name);
      }
    }
  };

  for (const { unit, call } of requireCallsTo(state, sourceRel)) {
    const parent = call.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === call) {
      if (parent.name.text === name) useOfMember(unit, parent, parent.name);
    } else if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === call &&
      ts.isStringLiteralLike(parent.argumentExpression) &&
      parent.argumentExpression.text === name
    ) {
      useOfMember(unit, parent, parent.argumentExpression);
    } else if (ts.isVariableDeclaration(parent) && parent.initializer === call) {
      if (ts.isObjectBindingPattern(parent.name)) bindFromPattern(unit, parent.name);
      else if (ts.isIdentifier(parent.name)) trackNamespace(unit, parent.name);
    }
  }
  return { sites, positions, aliases };
}

export interface Analysis {
  sites: RefSite[];
  positions: Map<string, Set<number>>;
  aliases: Set<string>;
}

export function analyze(state: State, target: Target): Analysis {
  const aliases = new Set<string>();
  const typed = typedRefs(state, target.symbol, target.name, aliases);
  const cjs = cjsRefs(state, target.unit.rel, target.name);
  for (const alias of cjs.aliases) aliases.add(alias);
  const seen = new Set<string>();
  const sites: RefSite[] = [];
  for (const site of [...typed, ...cjs.sites]) {
    const key = `${site.unit.rel}:${site.node.getStart(site.unit.sf)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push(site);
  }
  return { sites, positions: cjs.positions, aliases };
}

function siteItem(site: RefSite): AnswerItem {
  return mkItem({
    file: site.unit.rel,
    line: lineOfNode(site.unit, site.node),
    symbol: enclosingName(site.node),
  });
}

// ---------------------------------------------------------------------------------------------
// Cross-check with git grep

/**
 * Textual mentions of `name` that the compiler-based result neither includes nor classifies. A hit
 * is classified when its line is in the result, when the word on it is only inside a string or a
 * comment, when it names a different symbol, or when it is the definition or an import or export
 * of the target. The rest is returned so the question author can resolve the ambiguity.
 */
function crossCheck(
  state: State,
  name: string,
  target: Target | undefined,
  analysis: Analysis,
  included: Set<string>,
  mode: 'callers' | 'references' | 'definition',
): Unexplained[] {
  const unexplained: Unexplained[] = [];
  const reported = new Set<string>();
  for (const hit of gitGrepWord(state.repoDir, name)) {
    if (included.has(`${hit.file}:${hit.line}`)) continue;
    const unit = allUnits(state).find((candidate) => candidate.rel === hit.file);
    if (unit === undefined) continue;
    const idsOnLine = (idsOf(state, unit).get(name) ?? []).filter((id) => lineOfNode(unit, id) === hit.line);
    if (idsOnLine.length === 0) continue;
    const explained = idsOnLine.every((id) => classifyId(unit, id, target, analysis, mode));
    const key = `${hit.file}:${hit.line}`;
    if (!explained && !reported.has(key)) {
      reported.add(key);
      unexplained.push({ file: hit.file, line: hit.line, text: hit.text.trim() });
    }
  }
  return unexplained.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line);
}

function classifyId(
  unit: Unit,
  id: ts.Identifier,
  target: Target | undefined,
  analysis: Analysis,
  mode: 'callers' | 'references' | 'definition',
): boolean {
  if (analysis.positions.get(unit.rel)?.has(id.getStart(unit.sf)) === true) return true;
  const checker = unit.checker;
  const raw = checker === undefined ? undefined : symbolAt(checker, id);
  if (unit.main && checker !== undefined) {
    if (raw === undefined) return false;
    if (target === undefined || canon(checker, raw) !== target.symbol) return true;
    const parent = id.parent;
    if (declName(parent) === id) return true;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
    return mode !== 'callers';
  }
  // A JavaScript file outside the program: a property name, an own declaration or a require
  // binding of some other module is a different symbol of the same name.
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
  if (raw?.declarations?.some((declaration) => declaration.getSourceFile() === unit.sf) === true) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// ADR citations (D-19)

/** `ADR-<n>`, `ADR <n>`, `ADR #<n>`, case-insensitive, with an optional `§<section>` detail. */
const ADR_PATTERN = /\badr(?:[-\s]\s*#?|#)\s*(\d+)(?:\s*§\s*(\d+(?:\.\d+)*))?/gi;

export interface Citation {
  number: number;
  detail?: string;
  pos: number;
}

export function citationsIn(text: string, basePos: number): Citation[] {
  const found: Citation[] = [];
  for (const match of text.matchAll(ADR_PATTERN)) {
    const citation: Citation = { number: Number(match[1]), pos: basePos + (match.index ?? 0) };
    if (match[2] !== undefined) citation.detail = `§${match[2]}`;
    found.push(citation);
  }
  return found;
}

export function commentCitations(unit: Unit): Citation[] {
  const found: Citation[] = [];
  for (const range of commentRanges(unit.sf)) {
    found.push(...citationsIn(unit.sf.text.slice(range.pos, range.end), range.pos));
  }
  return found;
}

function stringCitationCount(unit: Unit, number: number): number {
  let count = 0;
  walk(unit.sf, (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      count += citationsIn(node.text, node.getStart(unit.sf)).filter((citation) => citation.number === number).length;
    }
  });
  return count;
}

export function adrFilesOf(state: State): Map<number, string[]> {
  if (state.adrFilesCache !== undefined) return state.adrFilesCache;
  const files = new Map<number, string[]>();
  const listed = git(state.repoDir, ['ls-files', '-z', '--', ...state.adrDirs])
    .split('\0')
    .filter((entry) => entry !== '');
  for (const rel of listed) {
    if (!ADR_FILE_EXT.has(path.posix.extname(rel).toLowerCase())) continue;
    const match = /^(\d+)(?=[-_.])/.exec(path.posix.basename(rel));
    if (match === null) continue;
    const number = Number(match[1]);
    const list = files.get(number);
    if (list === undefined) files.set(number, [rel]);
    else list.push(rel);
  }
  for (const list of files.values()) list.sort((a, b) => a.localeCompare(b, 'en'));
  state.adrFilesCache = files;
  return files;
}

export function trackedCodeUnits(state: State): Unit[] {
  const units: Unit[] = [];
  for (const rel of trackedFiles(state)) {
    if (!CODE_EXT.has(path.extname(rel).toLowerCase())) continue;
    const unit = quickUnit(state, rel);
    if (unit !== undefined) units.push(unit);
  }
  return units;
}

// ---------------------------------------------------------------------------------------------
// Key kinds

type KeyOf<K extends KeySpec['kind']> = Extract<KeySpec, { kind: K }>;

function callersKey(state: State, key: KeyOf<'callers'>): Computed {
  const target = resolveTarget(state, key.definedIn, key.symbol, key.container);
  const analysis = analyze(state, target);
  const calls = analysis.sites.filter((site) => site.kind === 'call');
  const included = new Set(calls.map((site) => `${site.unit.rel}:${lineOfNode(site.unit, site.node)}`));
  return {
    items: calls.map(siteItem),
    needles: uniqueSorted([key.symbol, ...analysis.aliases]),
    unexplained: crossCheck(state, key.symbol, target, analysis, included, 'callers'),
  };
}

function referencesKey(state: State, key: KeyOf<'references'>): Computed {
  const target = resolveTarget(state, key.definedIn, key.symbol, key.container);
  const analysis = analyze(state, target);
  const refs = analysis.sites.filter((site) => site.kind !== 'definition');
  const included = new Set(refs.map((site) => `${site.unit.rel}:${lineOfNode(site.unit, site.node)}`));
  return {
    items: refs.map(siteItem),
    needles: uniqueSorted([key.symbol, ...analysis.aliases]),
    unexplained: crossCheck(state, key.symbol, target, analysis, included, 'references'),
  };
}

function definitionKey(state: State, key: KeyOf<'definition'>): Computed {
  const units = key.definedIn === undefined ? [...state.units.values()] : [state.units.get(key.definedIn)];
  const items: AnswerItem[] = [];
  for (const unit of units) {
    if (unit === undefined) throw new OracleError('FILE_NOT_IN_PROGRAM', `${key.definedIn ?? ''} is not a source file of the program`);
    for (const decl of declarationsNamed(state, unit, key.symbol, key.container)) {
      items.push(mkItem({ file: unit.rel, line: lineOfNode(unit, decl.id), symbol: key.symbol }));
    }
  }
  if (items.length === 0) {
    throw new OracleError('SYMBOL_NOT_FOUND', `no declaration named ${key.symbol}${key.definedIn === undefined ? '' : ` in ${key.definedIn}`}`);
  }
  return { items, needles: [key.symbol] };
}

export function isLibraryFile(state: State, sf: ts.SourceFile): boolean {
  return state.program.isSourceFileDefaultLibrary(sf) || /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/.test(sf.fileName);
}

export function heritageTypes(node: ts.ClassDeclaration | ts.InterfaceDeclaration): ts.ExpressionWithTypeArguments[] {
  return (node.heritageClauses ?? []).flatMap((clause) => [...clause.types]);
}

/** The canonical symbol a heritage clause (`extends X`, `implements ns.X`) names, if the checker resolves it. */
export function resolveHeritageSymbol(state: State, type: ts.ExpressionWithTypeArguments): ts.Symbol | undefined {
  const expression = type.expression;
  const id = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  if (!ts.isIdentifier(id)) return undefined;
  const raw = symbolAt(state.checker, id);
  return raw === undefined ? undefined : canon(state.checker, raw);
}

function heritageKey(state: State, key: KeyOf<'heritage'>): Computed {
  const items: AnswerItem[] = [];
  const resolveClause = (type: ts.ExpressionWithTypeArguments): ts.Symbol | undefined => resolveHeritageSymbol(state, type);
  const needles = new Set<string>([key.symbol]);
  const notes: Record<string, number | string> = {};

  if (key.direction === 'subtypes') {
    const target = key.lib === true ? undefined : resolveTarget(state, key.definedIn ?? '', key.symbol).symbol;
    for (const unit of state.units.values()) {
      walk(unit.sf, (node) => {
        if ((!ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node)) || node.name === undefined) return;
        for (const type of heritageTypes(node)) {
          const resolved = resolveClause(type);
          if (resolved === undefined) continue;
          const matches =
            key.lib === true
              ? resolved.name === key.symbol &&
                (resolved.declarations ?? []).some((declaration) => isLibraryFile(state, declaration.getSourceFile()))
              : resolved === target;
          if (!matches) continue;
          needles.add(node.name.text);
          items.push(mkItem({ file: unit.rel, line: lineOfNode(unit, node.name), symbol: node.name.text }));
        }
      });
    }
  } else {
    const target = resolveTarget(state, key.definedIn ?? '', key.symbol);
    const external: string[] = [];
    for (const decl of target.decls) {
      const node = decl.node;
      if (!ts.isClassDeclaration(node) && !ts.isInterfaceDeclaration(node)) continue;
      for (const type of heritageTypes(node)) {
        const resolved = resolveClause(type);
        const declaration = resolved?.declarations?.[0];
        if (resolved === undefined || declaration === undefined) continue;
        const rel = relInside(state.repoDir, declaration.getSourceFile().fileName);
        const unit = rel === undefined ? undefined : state.units.get(rel);
        const id = declName(declaration);
        if (unit === undefined || id === undefined) {
          external.push(resolved.name);
          continue;
        }
        needles.add(resolved.name);
        items.push(mkItem({ file: unit.rel, line: lineOfNode(unit, id), symbol: resolved.name }));
      }
    }
    if (external.length > 0) notes.externalSupertypes = uniqueSorted(external).join(',');
  }
  return { items, needles: uniqueSorted(needles), notes };
}

function emitKey(state: State, key: KeyOf<'emit'>): Computed {
  const fileName = state.rootNames.get(key.source);
  if (fileName === undefined) {
    throw new OracleError('EMIT_SOURCE_NOT_IN_PROGRAM', `${key.source} is not a root file of the program, so it has no emit output`);
  }
  const items: AnswerItem[] = [];
  const needles: string[] = [];
  for (const output of ts.getOutputFileNames(state.parsed, fileName, false)) {
    const rel = relInside(state.repoDir, output);
    if (rel === undefined) {
      throw new OracleError('OUTSIDE_REPO', `emit output of ${key.source} is outside the repository: ${output}`);
    }
    items.push(mkItem({ file: rel }));
    needles.push(path.posix.basename(rel));
  }
  return { items, needles: uniqueSorted(needles) };
}

function emitConsumersKey(state: State, key: KeyOf<'emit-consumers'>): Computed {
  if (!state.rootNames.has(key.source)) {
    throw new OracleError('EMIT_SOURCE_NOT_IN_PROGRAM', `${key.source} is not a root file of the program, so it has no emit output`);
  }
  const items = requireCallsTo(state, key.source).map(({ unit, call }) =>
    mkItem({ file: unit.rel, line: lineOfNode(unit, call) }),
  );
  const needles = emitKey(state, { ...key, kind: 'emit' }).needles;
  return { items, needles: uniqueSorted([...needles, 'require']) };
}

function adrCitersKey(state: State, key: KeyOf<'adr-citers'>): Computed {
  const items: AnswerItem[] = [];
  let excluded = 0;
  for (const unit of trackedCodeUnits(state)) {
    for (const citation of commentCitations(unit)) {
      if (citation.number !== key.number) continue;
      items.push(mkItem({ file: unit.rel, line: lineAt(unit.lineStarts, citation.pos), detail: citation.detail }));
    }
    excluded += stringCitationCount(unit, key.number);
  }
  return { items, needles: ['ADR'], notes: { excludedNonComment: excluded } };
}

/** Comments that belong to a declaration: its leading comments and every comment inside it. */
export function declarationComments(unit: Unit, node: ts.Node): ts.CommentRange[] {
  const anchor =
    ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)
      ? node.parent.parent
      : node;
  const leading = ts.getLeadingCommentRanges(unit.sf.text, anchor.pos) ?? [];
  const start = anchor.getStart(unit.sf);
  const inside = commentRanges(unit.sf).filter((range) => range.pos >= start && range.end <= anchor.end);
  return [...leading, ...inside];
}

function adrOfKey(state: State, key: KeyOf<'adr-of'>): Computed {
  const unit = state.units.get(key.definedIn);
  if (unit === undefined) throw new OracleError('FILE_NOT_IN_PROGRAM', `${key.definedIn} is not a source file of the program`);
  const decls = declarationsNamed(state, unit, key.symbol, key.container);
  if (decls.length === 0) throw new OracleError('SYMBOL_NOT_FOUND', `${key.definedIn} has no declaration named ${key.symbol}`);
  const files = adrFilesOf(state);
  const items: AnswerItem[] = [];
  const seen = new Set<string>();
  for (const decl of decls) {
    for (const range of declarationComments(unit, decl.node)) {
      for (const citation of citationsIn(unit.sf.text.slice(range.pos, range.end), range.pos)) {
        const dedupe = `${citation.number}|${citation.detail ?? ''}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const adrFiles = files.get(citation.number) ?? [];
        if (adrFiles.length === 0) {
          items.push(mkItem({ adr: citation.number, resolved: false, detail: citation.detail }));
        }
        for (const adrFile of adrFiles) {
          items.push(mkItem({ file: adrFile, adr: citation.number, resolved: true, detail: citation.detail }));
        }
      }
    }
  }
  return { items, needles: ['ADR'] };
}

/** True for a function declaration or a variable bound to an arrow function or function expression. */
export function isFunctionLikeDeclaration(declaration: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(declaration) ||
    (ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)))
  );
}

/**
 * The symbols a program file exports whose declarations in that same file satisfy `accept`, each as a
 * `Target` carrying only the accepted declarations. `exportedFunctions` is this with the function rule.
 */
export function exportedTargets(state: State, unit: Unit, accept: (declaration: ts.Declaration) => boolean): Target[] {
  const checker = unit.checker;
  if (checker === undefined) return [];
  const moduleSymbol = checker.getSymbolAtLocation(unit.sf);
  if (moduleSymbol === undefined) return [];
  const targets: Target[] = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = canon(checker, exported);
    const decls = (symbol.declarations ?? []).filter((declaration) => declaration.getSourceFile() === unit.sf);
    const accepted = decls.filter(accept);
    if (accepted.length === 0) continue;
    targets.push({
      unit,
      symbol,
      name: symbol.name,
      decls: accepted.flatMap((declaration) => {
        const id = declName(declaration);
        return id === undefined ? [] : [{ node: declaration, id }];
      }),
    });
  }
  return targets;
}

export function exportedFunctions(state: State, unit: Unit): Target[] {
  return exportedTargets(state, unit, isFunctionLikeDeclaration);
}

function impactKey(state: State, key: KeyOf<'impact'>): Computed {
  const root = resolveTarget(state, key.definedIn, key.symbol, key.container);
  const rootAnalysis = analyze(state, root);
  const rootCalls = rootAnalysis.sites.filter((site) => site.kind === 'call');
  const included = new Set(rootCalls.map((site) => `${site.unit.rel}:${lineOfNode(site.unit, site.node)}`));
  const unexplained = crossCheck(state, key.symbol, root, rootAnalysis, included, 'callers');

  const reached = new Set<string>();
  let frontier = new Set(rootCalls.map((site) => site.unit.rel));
  for (const file of frontier) reached.add(file);
  for (let depth = 2; depth <= key.depth; depth += 1) {
    const next = new Set<string>();
    for (const file of frontier) {
      const unit = state.units.get(file);
      if (unit === undefined) continue;
      for (const exported of exportedFunctions(state, unit)) {
        for (const site of analyze(state, exported).sites) {
          if (site.kind === 'call' && !reached.has(site.unit.rel)) next.add(site.unit.rel);
        }
      }
    }
    for (const file of next) reached.add(file);
    frontier = next;
  }
  reached.delete(key.definedIn);
  return {
    items: [...reached].map((file) => mkItem({ file })),
    needles: uniqueSorted([key.symbol, ...rootAnalysis.aliases]),
    unexplained,
    notes: { depth: key.depth },
  };
}

function abstainKey(state: State, key: KeyOf<'abstain'>): Computed {
  const probe = key.probe;
  if ('adrNoFile' in probe) {
    const files = adrFilesOf(state).get(probe.adrNoFile) ?? [];
    if (files.length > 0) {
      throw new OracleError('ABSTAIN_PROBE_MATCHES', `ADR ${probe.adrNoFile} has file(s): ${files.join(', ')}`);
    }
    return { items: [], abstain: true, needles: [] };
  }
  const matches: string[] = [];
  for (const hit of gitGrepWord(state.repoDir, probe.symbol)) {
    const unit = quickUnit(state, hit.file);
    if (unit === undefined) {
      matches.push(`${hit.file}:${hit.line} (not a code file)`);
      continue;
    }
    const inCode = (idsOf(state, unit).get(probe.symbol) ?? []).some((id) => lineOfNode(unit, id) === hit.line);
    if (inCode) matches.push(`${hit.file}:${hit.line}`);
  }
  if (matches.length > 0) {
    throw new OracleError('ABSTAIN_PROBE_MATCHES', `probe ${probe.symbol} matches: ${matches.join(', ')}`);
  }
  return { items: [], abstain: true, needles: [] };
}

function isQuestion(input: Question | KeySpec): input is Question {
  return 'key' in input && 'id' in input;
}

/**
 * The expected answer for a question's machine key. Accepts a full question or a bare key (the
 * result then carries the question id `q-0`). Throws an OracleError when the key does not describe
 * something the corpus contains, or when an abstain probe matches something.
 */
export async function computeAnswerKey(input: Question | KeySpec, ctx: OracleContext): Promise<AnswerKey> {
  const key = isQuestion(input) ? input.key : input;
  const questionId = isQuestion(input) ? input.id : 'q-0';
  const state = stateOf(ctx);

  let computed: Computed;
  switch (key.kind) {
    case 'callers':
      computed = callersKey(state, key);
      break;
    case 'references':
      computed = referencesKey(state, key);
      break;
    case 'heritage':
      computed = heritageKey(state, key);
      break;
    case 'emit':
      computed = emitKey(state, key);
      break;
    case 'emit-consumers':
      computed = emitConsumersKey(state, key);
      break;
    case 'adr-citers':
      computed = adrCitersKey(state, key);
      break;
    case 'adr-of':
      computed = adrOfKey(state, key);
      break;
    case 'definition':
      computed = definitionKey(state, key);
      break;
    case 'impact':
      computed = impactKey(state, key);
      break;
    case 'abstain':
      computed = abstainKey(state, key);
      break;
  }

  return AnswerKeySchema.parse({
    questionId,
    kind: key.kind,
    abstain: computed.abstain === true,
    items: sortItems(computed.items),
    granularity: key.granularity,
    equality: key.equality,
    needles: computed.needles,
    unexplained: computed.unexplained ?? [],
    notes: computed.notes ?? {},
    oracleVersion: ORACLE_VERSION,
  });
}

/**
 * Checks a citation against the corpus on disk: the file exists, the line exists and, when needles
 * are given, the line contains at least one of them (case-insensitively). Reads from disk only.
 */
export async function verifyCitation(
  ctx: OracleContext,
  citation: { file: string; line: number },
  needles?: readonly string[],
): Promise<{ ok: boolean; reason?: string }> {
  let repoDir: string;
  try {
    repoDir = fs.realpathSync.native(ctx.repoDir);
  } catch {
    return { ok: false, reason: 'file missing' };
  }
  const abs = path.resolve(repoDir, citation.file);
  if (!isInside(repoDir, abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, reason: 'file missing' };
  }
  const lines = readText(abs).split('\n');
  const total = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  if (!Number.isInteger(citation.line) || citation.line < 1 || citation.line > total) {
    return { ok: false, reason: 'line out of range' };
  }
  if (needles !== undefined && needles.length > 0) {
    const text = lines[citation.line - 1].replace(/\r$/, '').toLowerCase();
    if (!needles.some((needle) => text.includes(needle.toLowerCase()))) return { ok: false, reason: 'needle absent' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Command line

const USAGE = `usage:
  node scripts/eval/oracle.ts keys  --repo <dir> --tsconfig <file> --questions <file> --out <file>
  node scripts/eval/oracle.ts check --repo <dir> --tsconfig <file> --questions <file> --answers <file>
`;

function repoSha(repoDir: string): string {
  return git(repoDir, ['rev-parse', 'HEAD']).trim();
}

async function computeAll(options: { repo: string; tsconfig: string; questions: string }): Promise<AnswerFile> {
  const file = loadQuestions(options.questions);
  const ctx: OracleContext = { repoDir: options.repo, tsconfig: options.tsconfig };
  const sha = repoSha(options.repo);
  if (file.corpusSha !== sha) {
    process.stderr.write(`warning: question file pins ${file.corpusSha} but the checkout is at ${sha}\n`);
  }
  const answers: AnswerKey[] = [];
  for (const question of file.questions) answers.push(await computeAnswerKey(question, ctx));
  answers.sort((a, b) => a.questionId.localeCompare(b.questionId, 'en'));
  return { oracleVersion: ORACLE_VERSION, repoSha: sha, answers };
}

function serialize(file: AnswerFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function differences(expected: AnswerFile, actual: AnswerFile): string[] {
  const lines: string[] = [];
  if (expected.oracleVersion !== actual.oracleVersion) {
    lines.push(`oracleVersion: ${expected.oracleVersion} -> ${actual.oracleVersion}`);
  }
  if (expected.repoSha !== actual.repoSha) lines.push(`repoSha: ${expected.repoSha} -> ${actual.repoSha}`);
  const before = new Map(expected.answers.map((answer) => [answer.questionId, answer]));
  const after = new Map(actual.answers.map((answer) => [answer.questionId, answer]));
  for (const id of uniqueSorted([...before.keys(), ...after.keys()])) {
    const a = before.get(id);
    const b = after.get(id);
    if (a === undefined || b === undefined) {
      lines.push(`${id}: ${a === undefined ? 'not in the recorded answers' : 'no longer computed'}`);
      continue;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const was = new Set(a.items.map((item) => JSON.stringify(item)));
    const now = new Set(b.items.map((item) => JSON.stringify(item)));
    for (const item of was) if (!now.has(item)) lines.push(`${id}: item removed ${item}`);
    for (const item of now) if (!was.has(item)) lines.push(`${id}: item added ${item}`);
    if (was.size === now.size && [...was].every((item) => now.has(item))) lines.push(`${id}: metadata differs`);
  }
  return lines;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  let values: { repo?: string; tsconfig?: string; questions?: string; out?: string; answers?: string };
  try {
    values = parseArgs({
      args: [...rest],
      options: {
        repo: { type: 'string' },
        tsconfig: { type: 'string' },
        questions: { type: 'string' },
        out: { type: 'string' },
        answers: { type: 'string' },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const { repo, tsconfig, questions, out, answers } = values;
  if (
    (command !== 'keys' && command !== 'check') ||
    repo === undefined ||
    tsconfig === undefined ||
    questions === undefined ||
    (command === 'keys' && out === undefined) ||
    (command === 'check' && answers === undefined)
  ) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const computed = await computeAll({ repo, tsconfig, questions });
    if (command === 'keys') {
      fs.writeFileSync(out as string, serialize(computed));
      return 0;
    }
    const recorded = AnswerFileSchema.parse(JSON.parse(readText(answers as string)));
    const diff = differences(recorded, computed);
    if (diff.length === 0) return 0;
    process.stderr.write(`${diff.join('\n')}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`${error instanceof OracleError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
