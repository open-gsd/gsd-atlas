/**
 * The compiler process (plan 03-23, D-07, D-12, D-13, research Pattern 1).
 *
 * Started only through the CommandRunner by the exact built-in shape of plan 03-19, with no repository input in its
 * argument list. It reads newline-delimited JSON requests on stdin and writes responses on stdout (protocol.ts). The
 * parent chooses the compiler and sends its directory as data: the project's own TypeScript when the project has 6.x,
 * the bundled 6.0.3 otherwise. This is the only file that loads a compiler; the host process never does (TSM-05).
 *
 * One `ts.Program` per owner config, created lazily with `ts.createProgram` (no language service, no tsserver, no
 * tsconfig plugins; Pitfall 10, ADR 4 decision 5). A site is resolved only when the identifier at its converted offset
 * has the site's name; otherwise it is skipped, never guessed (Pitfall 3). Offsets come from positions.ts, not from the
 * compiler's line map. The process exits when stdin ends, so a dead host leaves no orphan.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type ts from 'typescript';
import { MEMORY_DEFAULTS } from './budget.ts';
import { lineStarts, offsetOf, positionOf, stripBom } from './positions.ts';
import { PRECISE_LIMITS, encodeResponse, parseRequest } from './protocol.ts';
import type { Request, Response, Site, Target } from './protocol.ts';
import { collectRelations } from './relations.ts';
import { startSampler } from './sampler.ts';

/** The compiler API. Exported as a type only, so `relations.ts` can derive its types from it without loading the compiler. */
export type Compiler = typeof ts;

/** Declarations one site may report; a symbol with more (a heavily merged interface) is cut here. */
const MAX_TARGETS = 64;

interface FileInfo {
  readonly body: string;
  /** How many characters the compiler's text has before the text positions refer to (1 with a BOM it kept, else 0). */
  readonly shift: number;
  readonly starts: readonly number[];
}

interface ProgramEntry {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly files: Map<string, FileInfo>;
}

if (process.env['GSD_ATLAS_WORKER'] !== '1') {
  process.stderr.write('typescript worker: started outside the compiler worker shape\n');
  process.exit(2);
}

const nodeRequire = createRequire(import.meta.url);

let compiler: Compiler | undefined;
let rootDir = '';
let rootPosix = '';
let known = new Set<string>();
const programs = new Map<string, ProgramEntry>();
let samplerRunning = false;

const send = (message: Response): void => {
  process.stdout.write(encodeResponse(message));
};

const fail = (id: number | null, code: string, message: string): void => {
  send({ t: 'error', id, code, message });
};

const toPosix = (value: string): string => value.split(path.sep).join('/');

function loadCompiler(dir: string): Compiler | undefined {
  try {
    const loaded = nodeRequire(dir) as Partial<Compiler> & { default?: Partial<Compiler> };
    const candidate = (typeof loaded.createProgram === 'function' ? loaded : loaded.default) as Compiler | undefined;
    if (candidate === undefined || typeof candidate.createProgram !== 'function' || typeof candidate.version !== 'string') return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function init(message: Extract<Request, { t: 'init' }>): void {
  rootDir = path.resolve(message.worktreeRoot);
  rootPosix = toPosix(rootDir);
  known = new Set(message.configs);
  // The memory watch (plan 03-27, D-21): a thread of this process that ends it past the RSS limit. It starts before the
  // compiler loads, so loading a compiler into a budget that cannot hold it is stopped too; the V8 heap flag of the exact
  // worker shape is the backstop. Absent only for a worker started by a test that wants the heap flag alone.
  if (message.rssLimitMb !== undefined && !samplerRunning) {
    startSampler({ rssLimitMb: message.rssLimitMb, sampleMs: message.sampleMs ?? MEMORY_DEFAULTS.sampleMs });
    samplerRunning = true;
  }
  let source: 'project' | 'bundled' = 'bundled';
  let loaded: Compiler | undefined;
  if (message.compilerDir !== null) {
    loaded = loadCompiler(message.compilerDir);
    if (loaded !== undefined) source = 'project';
  }
  loaded ??= loadCompiler(message.bundledDir);
  if (loaded === undefined) {
    fail(null, 'compiler_unavailable', 'no usable TypeScript compiler could be loaded');
    return;
  }
  compiler = loaded;
  send({ t: 'ready', compiler: { version: loaded.version, source }, rssMb: process.memoryUsage().rss / 1_048_576, pid: process.pid, sampler: samplerRunning });
}

function createEntry(config: string): ProgramEntry | undefined {
  const api = compiler as Compiler;
  const configPath = path.join(rootDir, config);
  const host: ts.ParseConfigFileHost = {
    ...api.sys,
    useCaseSensitiveFileNames: api.sys.useCaseSensitiveFileNames,
    getCurrentDirectory: () => rootDir,
    onUnRecoverableConfigFileDiagnostic: () => {},
  };
  const parsed = api.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (parsed === undefined) return undefined;
  const program = api.createProgram({
    rootNames: parsed.fileNames,
    options: { ...parsed.options, noEmit: true },
    ...(parsed.projectReferences === undefined ? {} : { projectReferences: parsed.projectReferences }),
  });
  return { program, checker: program.getTypeChecker(), files: new Map() };
}

function infoOf(entry: ProgramEntry, file: ts.SourceFile): FileInfo {
  let info = entry.files.get(file.fileName);
  if (info === undefined) {
    const body = stripBom(file.text);
    info = { body, shift: file.text.length - body.length, starts: lineStarts(body) };
    entry.files.set(file.fileName, info);
  }
  return info;
}

/** The identifier that starts exactly at `at`, found by walking children; no line map of the compiler is used. */
function identifierAt(api: Compiler, file: ts.SourceFile, at: number): ts.Identifier | ts.PrivateIdentifier | undefined {
  let node: ts.Node = file;
  for (;;) {
    let next: ts.Node | undefined;
    api.forEachChild(node, (child) => {
      if (child.pos <= at && at < child.end) {
        next = child;
        return true;
      }
      return undefined;
    });
    if (next === undefined) break;
    node = next;
  }
  if ((api.isIdentifier(node) || api.isPrivateIdentifier(node)) && node.getStart(file) === at) return node;
  return undefined;
}

/** The repository-relative POSIX path of a declaration's file, or undefined when it is a library, a dependency or outside the worktree. */
function repoPathOf(entry: ProgramEntry, file: ts.SourceFile): string | undefined {
  if (entry.program.isSourceFileDefaultLibrary(file) || entry.program.isSourceFileFromExternalLibrary(file)) return undefined;
  const name = toPosix(file.fileName);
  if (name.split('/').includes('node_modules')) return undefined;
  if (name !== rootPosix && !name.startsWith(`${rootPosix}/`)) return undefined;
  const relative = name.slice(rootPosix.length + 1);
  return relative === '' ? undefined : relative;
}

function symbolOf(api: Compiler, entry: ProgramEntry, node: ts.Identifier | ts.PrivateIdentifier): ts.Symbol | undefined {
  const { checker } = entry;
  let symbol: ts.Symbol | undefined;
  if (api.isIdentifier(node) && api.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
    symbol = checker.getShorthandAssignmentValueSymbol(node.parent);
  } else {
    symbol = checker.getSymbolAtLocation(node);
  }
  if (symbol === undefined) return undefined;
  if ((symbol.flags & api.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return symbol;
}

/** The name token of a declaration as a target, or undefined for a library, a dependency, a file outside the worktree or a name that is no identifier. */
function targetOfDeclaration(api: Compiler, entry: ProgramEntry, declaration: ts.Declaration): Target | undefined {
  const nameNode = api.getNameOfDeclaration(declaration);
  if (nameNode === undefined || !(api.isIdentifier(nameNode) || api.isPrivateIdentifier(nameNode))) return undefined;
  const file = declaration.getSourceFile();
  const repoPath = repoPathOf(entry, file);
  if (repoPath === undefined) return undefined;
  const info = infoOf(entry, file);
  const start = nameNode.getStart(file) - info.shift;
  if (start < 0) return undefined;
  const { row, col } = positionOf(info.starts, start);
  return { path: repoPath, row, col, name: nameNode.text, kind: api.SyntaxKind[declaration.kind] ?? 'Unknown' };
}

function targetsOf(api: Compiler, entry: ProgramEntry, symbol: ts.Symbol): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  for (const declaration of symbol.declarations ?? []) {
    const target = targetOfDeclaration(api, entry, declaration);
    if (target === undefined) continue;
    const key = `${target.path}\u0000${String(target.row)}\u0000${String(target.col)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

function resolveSite(api: Compiler, entry: ProgramEntry, site: Site): Target[] {
  const file = entry.program.getSourceFile(`${rootPosix}/${site.path}`);
  if (file === undefined) return [];
  const info = infoOf(entry, file);
  const offset = offsetOf(info.starts, site.row, site.col);
  if (offset === undefined || info.body.slice(offset, offset + site.name.length) !== site.name) return [];
  const node = identifierAt(api, file, offset + info.shift);
  if (node === undefined || node.text !== site.name) return [];
  const symbol = symbolOf(api, entry, node);
  return symbol === undefined ? [] : targetsOf(api, entry, symbol);
}

/** The compiler and the program of an owner config, or undefined after the failure has been reported for request `id`. */
function programFor(id: number, config: string): { readonly api: Compiler; readonly entry: ProgramEntry } | undefined {
  const api = compiler;
  if (api === undefined) {
    fail(id, 'not_initialized', 'the worker has not been initialized');
    return undefined;
  }
  if (!known.has(config)) {
    fail(id, 'unknown_config', 'the config is not one the worker was told about');
    return undefined;
  }
  let entry = programs.get(config);
  if (entry === undefined) {
    entry = createEntry(config);
    if (entry === undefined) {
      fail(id, 'config_unreadable', 'the config could not be read');
      return undefined;
    }
    programs.set(config, entry);
  }
  return { api, entry };
}

/** The relations of the classes and interfaces declared in the requested files (plan 03-25). */
function relations(message: Extract<Request, { t: 'relations' }>): void {
  const ready = programFor(message.id, message.config);
  if (ready === undefined) return;
  const { api, entry } = ready;
  let answered = 0;
  for (const file of message.files) {
    const source = entry.program.getSourceFile(`${rootPosix}/${file}`);
    if (source === undefined) continue;
    const found = collectRelations(entry.checker, source, {
      api,
      targetOf: (declaration) => targetOfDeclaration(api, entry, declaration),
      maxDeclarations: MAX_TARGETS,
    });
    if (found.length > 0) answered += 1;
    for (const item of found) send({ t: 'relation', id: message.id, from: item.from, to: item.to, relation: item.relation });
  }
  send({ t: 'done', id: message.id, asked: message.files.length, answered });
}

function resolve(message: Extract<Request, { t: 'resolve' }>): void {
  const ready = programFor(message.id, message.config);
  if (ready === undefined) return;
  const { api, entry } = ready;
  let answered = 0;
  for (const site of message.sites) {
    const targets = resolveSite(api, entry, site);
    if (targets.length === 0) continue;
    answered += 1;
    send({ t: 'edge', id: message.id, site, targets });
  }
  send({ t: 'done', id: message.id, asked: message.sites.length, answered });
}

function handle(line: string): void {
  const parsed = parseRequest(line, PRECISE_LIMITS.maxLineBytes);
  if (!parsed.ok) {
    fail(null, 'bad_request', parsed.message);
    return;
  }
  const message = parsed.value;
  try {
    switch (message.t) {
      case 'init':
        init(message);
        return;
      case 'resolve':
        resolve(message);
        return;
      case 'relations':
        relations(message);
        return;
      case 'ping':
        send({ t: 'done', id: message.id, asked: 0, answered: 0 });
        return;
    }
  } catch (error) {
    // The text of an exception can carry file content, so only its class name leaves the process.
    const name = error instanceof Error ? error.name : 'Error';
    fail('id' in message ? message.id : null, 'internal', `the worker failed while handling a request (${name})`);
  }
}

// Requests are handled one at a time, in order. stdin ends when the parent closes it or dies: exit then.
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  pending += chunk;
  for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
    const line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    if (line.trim() !== '') handle(line);
  }
  if (Buffer.byteLength(pending, 'utf8') > PRECISE_LIMITS.maxLineBytes) {
    fail(null, 'line_too_long', 'a request line was longer than the limit');
    process.exit(3);
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
