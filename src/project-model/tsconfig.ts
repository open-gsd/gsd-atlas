import { diagnostic } from '../facts/index.ts';
import type { Diagnostic } from '../facts/index.ts';
import type { ReadTextResult } from '../source-tree/index.ts';
import { dirOf, resolveRepoPath, specProblem } from './globs.ts';
import { normalizedHash, parseJsonc } from './jsonc.ts';
import { PROJECT_MODEL_CODES } from './types.ts';
import type { ConfigInfo, ProjectFs } from './types.ts';

/** `extends` chains deeper than this are cut (T-03-183). */
export const MAX_EXTENDS_DEPTH = 16;
/** At most this many configs are described; the rest are reported as `too_many_configs` (T-03-183). */
export const MAX_CONFIGS = 200;
/** The file names that define a TypeScript or JavaScript project. */
export const CONFIG_FILE_NAMES: readonly string[] = ['tsconfig.json', 'jsconfig.json'];
/** TypeScript 5.5's template for "the directory of the config that is being built". */
const CONFIG_DIR_TEMPLATE = '${configDir}';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

// ---------------------------------------------------------------------------------------------
// Reading

/** Everything one `describe` call shares: the reader, each file read once, and the diagnostics collected so far. */
export interface ReadContext {
  readonly fs: ProjectFs;
  readonly diagnostics: Diagnostic[];
  readonly reads: Map<string, Promise<ReadTextResult>>;
  /** Set by `discoverConfigs`: the config paths it probed and the ones that existed. */
  probe?: { readonly candidates: readonly string[]; readonly present: readonly string[] };
}

export function createReadContext(fs: ProjectFs): ReadContext {
  return { fs, diagnostics: [], reads: new Map() };
}

function readCached(ctx: ReadContext, p: string): Promise<ReadTextResult> {
  let pending = ctx.reads.get(p);
  if (pending === undefined) {
    pending = ctx.fs.readText(p);
    ctx.reads.set(p, pending);
  }
  return pending;
}

function report(ctx: ReadContext, code: string, severity: Diagnostic['severity'], message: string, subject: string): void {
  ctx.diagnostics.push(diagnostic(code, severity, message, subject));
}

// ---------------------------------------------------------------------------------------------
// The parsed chain of one config

/** A list of specs and the repo-relative directory of the config that wrote it (specs read relative to it). */
export interface SpecList {
  readonly specs: readonly string[];
  readonly dir: string;
}

/** One compiler option and the directory of the config that set it (path options read relative to it). */
interface OptionValue {
  readonly value: unknown;
  readonly dir: string;
}

/** A config with its `extends` applied, before any file set is computed. */
export interface ConfigNode {
  readonly path: string;
  readonly dir: string;
  readonly hash: string;
  /** This config, then every config it extends, each once. */
  readonly chain: readonly string[];
  /** Normalised sha256 of every file in the chain. */
  readonly hashes: ReadonlyMap<string, string>;
  readonly options: ReadonlyMap<string, OptionValue>;
  readonly files?: SpecList;
  readonly include?: SpecList;
  readonly exclude?: SpecList;
  /** This config's own `references`, resolved to config paths (never inherited). */
  readonly references: readonly string[];
}

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** The climb of `rel` from `baseDir` reaches above the root. */
function climbsAboveRoot(baseDir: string, rel: string): boolean {
  let depth = baseDir === '' ? 0 : baseDir.split('/').length;
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (depth === 0) return true;
      depth -= 1;
    } else depth += 1;
  }
  return false;
}

type ExtendsTarget = { readonly path: string } | { readonly failure: 'extends_outside_repo' | 'extends_unresolved' };

/** Where `extends: spec` (written in a config in `dir`) points, by the compiler's rules: a path, or a package. */
async function resolveExtends(ctx: ReadContext, dir: string, spec: string): Promise<ExtendsTarget> {
  const written = spec.replace(/\\/g, '/');
  const outside = { failure: 'extends_outside_repo' } as const;
  const unresolved = { failure: 'extends_unresolved' } as const;
  if (written.startsWith('/') || /^[A-Za-z]:\//.test(written)) return outside;

  const candidates: string[] = [];
  if (written === '.' || written === '..' || written.startsWith('./') || written.startsWith('../')) {
    if (climbsAboveRoot(dir, written)) return outside;
    const target = resolveRepoPath(dir, written);
    candidates.push(target);
    if (!target.endsWith('.json')) candidates.push(`${target}.json`);
  } else {
    if (written.split('/').includes('..')) return unresolved;
    // A package: the nearest node_modules above the config that has it.
    for (let d = dir; ; d = dirOf(d)) {
      const modules = d === '' ? 'node_modules' : `${d}/node_modules`;
      if (written.endsWith('.json')) candidates.push(`${modules}/${written}`);
      else candidates.push(`${modules}/${written}.json`, `${modules}/${written}/tsconfig.json`);
      if (d === '') break;
    }
  }
  for (const candidate of candidates) {
    const result = await readCached(ctx, candidate);
    if (result.kind !== 'missing') return { path: candidate };
  }
  return unresolved;
}

/** The `references` of a config as paths of project configs: a directory means its `tsconfig.json`. */
function referencesOf(ctx: ReadContext, p: string, dir: string, value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    const target = isRecord(entry) ? entry['path'] : undefined;
    if (typeof target !== 'string' || target === '') continue;
    const written = target.replace(/\\/g, '/');
    if (written.startsWith('/') || /^[A-Za-z]:\//.test(written) || climbsAboveRoot(dir, written)) {
      report(ctx, PROJECT_MODEL_CODES.referenceOutsideRepo, 'warning', 'a project reference points outside the repository and is ignored', p);
      continue;
    }
    const resolved = resolveRepoPath(dir, written);
    out.push(resolved.endsWith('.json') ? resolved : resolved === '' ? 'tsconfig.json' : `${resolved}/tsconfig.json`);
  }
  return out;
}

/**
 * Reads the config at `p` and everything it extends. `stack` lists the configs being read above it (cycle
 * detection and the depth limit). Returns undefined when `p` cannot be used; the reason is in `ctx.diagnostics`.
 */
async function loadNode(ctx: ReadContext, p: string, stack: readonly string[], asRoot: boolean): Promise<ConfigNode | undefined> {
  const dir = dirOf(p);
  const read = await readCached(ctx, p);
  if (read.kind !== 'ok') {
    if (asRoot) report(ctx, PROJECT_MODEL_CODES.tsconfigInvalid, 'error', `the config could not be read (${read.kind})`, p);
    else if (read.kind === 'escape') report(ctx, PROJECT_MODEL_CODES.extendsOutsideRepo, 'warning', 'an extends target leaves the repository and is ignored', p);
    else report(ctx, PROJECT_MODEL_CODES.extendsUnresolved, 'warning', `an extends target could not be read (${read.kind}) and is ignored`, p);
    return undefined;
  }
  const parsed = parseJsonc(read.text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    report(ctx, PROJECT_MODEL_CODES.tsconfigInvalid, 'error', 'the config is not valid JSON with comments and is skipped', p);
    return undefined;
  }
  const own = parsed.value;

  const chain: string[] = [p];
  const hashes = new Map<string, string>([[p, normalizedHash(read.text)]]);
  const options = new Map<string, OptionValue>();
  let files: SpecList | undefined;
  let include: SpecList | undefined;
  let exclude: SpecList | undefined;

  // `extends`: one entry or an array; read left to right, later entries override earlier ones, this config overrides all.
  const extendsList = typeof own['extends'] === 'string' ? [own['extends']] : stringsOf(own['extends']);
  for (const spec of extendsList) {
    const target = await resolveExtends(ctx, dir, spec);
    if ('failure' in target) {
      report(
        ctx,
        target.failure === 'extends_outside_repo' ? PROJECT_MODEL_CODES.extendsOutsideRepo : PROJECT_MODEL_CODES.extendsUnresolved,
        'warning',
        target.failure === 'extends_outside_repo' ? 'an extends target leaves the repository and is ignored' : 'an extends target does not exist and is ignored',
        p,
      );
      continue;
    }
    if (target.path === p || stack.includes(target.path)) {
      report(ctx, PROJECT_MODEL_CODES.extendsCycle, 'warning', 'an extends chain leads back to a config already being read and the link is ignored', p);
      continue;
    }
    if (stack.length + 1 >= MAX_EXTENDS_DEPTH) {
      report(ctx, PROJECT_MODEL_CODES.extendsTooDeep, 'warning', `an extends chain is deeper than ${String(MAX_EXTENDS_DEPTH)} configs and the deeper links are ignored`, p);
      continue;
    }
    const base = await loadNode(ctx, target.path, [...stack, p], false);
    if (base === undefined) continue;
    for (const entry of base.chain) if (!chain.includes(entry)) chain.push(entry);
    for (const [file, hash] of base.hashes) hashes.set(file, hash);
    for (const [key, value] of base.options) options.set(key, value);
    if (base.files !== undefined) files = base.files;
    if (base.include !== undefined) include = base.include;
    if (base.exclude !== undefined) exclude = base.exclude;
  }

  const ownOptions = isRecord(own['compilerOptions']) ? own['compilerOptions'] : {};
  for (const [key, value] of Object.entries(ownOptions)) options.set(key, { value, dir });
  // A list the config sets itself replaces the inherited one wholesale; one it leaves out (or sets to null) is inherited.
  const listOf = (key: 'files' | 'include' | 'exclude', inherited: SpecList | undefined): SpecList | undefined => {
    const value = own[key];
    if (value === undefined || value === null) return inherited;
    return Array.isArray(value) ? { specs: stringsOf(value), dir } : undefined;
  };
  files = listOf('files', files);
  include = listOf('include', include);
  exclude = listOf('exclude', exclude);

  return {
    path: p,
    dir,
    hash: normalizedHash(read.text),
    chain,
    hashes,
    options,
    ...(files === undefined ? {} : { files }),
    ...(include === undefined ? {} : { include }),
    ...(exclude === undefined ? {} : { exclude }),
    references: referencesOf(ctx, p, dir, own['references']),
  };
}

/** Reads `configPath` and everything it extends. Undefined when the config is unreadable or invalid (a diagnostic says why). */
export function readConfigChain(ctx: ReadContext, configPath: string): Promise<ConfigNode | undefined> {
  return loadNode(ctx, configPath, [], true);
}

// ---------------------------------------------------------------------------------------------
// Discovery

/** The repo-relative directory of every ancestor of the overlay's files, the root included. */
function ancestorDirs(overlayPaths: readonly string[]): string[] {
  const dirs = new Set<string>(['']);
  for (const p of overlayPaths) {
    for (let d = dirOf(p); d !== '' && !dirs.has(d); d = dirOf(d)) dirs.add(d);
  }
  return [...dirs].sort(compareCodeUnits);
}

/**
 * The config paths discovery looks for: a `tsconfig.json` and a `jsconfig.json` in every directory from each source
 * file's up to the root, then the extra configs given. A caller keeps the answer of `exists` for this list to notice
 * a config that appeared or went away without describing the project again.
 */
function configCandidates(overlayPaths: readonly string[], extraConfigs: readonly string[] = []): string[] {
  const extras = extraConfigs.map((p) => resolveRepoPath('', p)).filter((p) => p !== '' && p.endsWith('.json'));
  return [
    ...ancestorDirs(overlayPaths).flatMap((d) => CONFIG_FILE_NAMES.map((name) => (d === '' ? name : `${d}/${name}`))),
    ...extras,
  ];
}

/**
 * Finds the configs that matter for `overlayPaths`: a `tsconfig.json` or `jsconfig.json` in the directory of any
 * source file or above it, plus every config a found config `references` (each round of references is checked
 * for existence). At most {@link MAX_CONFIGS} are kept, first in lexical order, with a `too_many_configs`
 * diagnostic. Returns the parsed nodes, sorted by path; configs that cannot be read are left out.
 */
export async function discoverConfigs(ctx: ReadContext, overlayPaths: readonly string[], extraConfigs: readonly string[] = []): Promise<ConfigNode[]> {
  const candidates = configCandidates(overlayPaths, extraConfigs);
  const present = await ctx.fs.exists(candidates);
  ctx.probe = { candidates, present: candidates.filter((c) => present.has(c)) };
  const found = [...new Set(candidates.filter((c) => present.has(c)))].sort(compareCodeUnits);
  let overflow = found.length > MAX_CONFIGS;
  const seen = new Set(found.slice(0, MAX_CONFIGS));
  const nodes = new Map<string, ConfigNode>();

  let round = [...seen];
  while (round.length > 0) {
    const referenced = new Set<string>();
    for (const p of round) {
      // One at a time: the diagnostics come out in a fixed order.
      const node = await readConfigChain(ctx, p);
      if (node === undefined) continue;
      nodes.set(node.path, node);
      for (const target of node.references) if (!seen.has(target)) referenced.add(target);
    }
    const existing = referenced.size === 0 ? new Set<string>() : await ctx.fs.exists([...referenced]);
    const fresh = [...referenced].filter((p) => existing.has(p)).sort(compareCodeUnits);
    const room = Math.max(0, MAX_CONFIGS - seen.size);
    if (fresh.length > room) overflow = true;
    round = fresh.slice(0, room);
    for (const p of round) seen.add(p);
  }
  if (overflow) {
    ctx.diagnostics.push(diagnostic(PROJECT_MODEL_CODES.tooManyConfigs, 'warning', `more than ${String(MAX_CONFIGS)} project configs were found; only the first ${String(MAX_CONFIGS)} in lexical order are described`));
  }
  return [...nodes.values()].sort((a, b) => compareCodeUnits(a.path, b.path));
}

// ---------------------------------------------------------------------------------------------
// The effective config

/** What `effectiveConfig` computes: the public description and the exact lists the matcher is built from. */
export interface EffectiveConfig {
  readonly info: ConfigInfo;
  /** Hashes of every file in the chain, by path. */
  readonly hashes: ReadonlyMap<string, string>;
}

const isAbsoluteSpec = (spec: string): boolean => spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);

/** One spec resolved to a repo-relative path (`.` for the root); `${configDir}` means the directory of `finalDir`. */
function resolveSpec(spec: string, listDir: string, finalDir: string): string {
  const resolved = spec.startsWith(CONFIG_DIR_TEMPLATE)
    ? resolveRepoPath(finalDir, spec.slice(CONFIG_DIR_TEMPLATE.length).replace(/^[\\/]+/, ''))
    : resolveRepoPath(listDir, spec);
  return resolved === '' ? '.' : resolved;
}

function resolveList(
  ctx: ReadContext,
  node: ConfigNode,
  list: SpecList,
  kind: 'files' | 'include' | 'exclude',
): string[] {
  const out: string[] = [];
  for (const spec of list.specs) {
    const problem = kind === 'files' ? undefined : specProblem(spec, kind);
    if (problem !== undefined || isAbsoluteSpec(spec)) {
      report(ctx, PROJECT_MODEL_CODES.specInvalid, 'warning', `a ${kind} entry is not valid (${problem ?? 'outside the repository'}) and is dropped`, node.path);
      continue;
    }
    out.push(resolveSpec(spec, list.dir, node.dir));
  }
  return out;
}

function optionPath(node: ConfigNode, key: string): string | undefined {
  const option = node.options.get(key);
  if (option === undefined || typeof option.value !== 'string' || option.value === '') return undefined;
  const resolved = option.value.startsWith(CONFIG_DIR_TEMPLATE)
    ? resolveRepoPath(node.dir, option.value.slice(CONFIG_DIR_TEMPLATE.length).replace(/^[\\/]+/, ''))
    : resolveRepoPath(option.dir, option.value);
  return resolved === '' ? '.' : resolved;
}

/**
 * The config's effective settings: `files`, `include` and `exclude` resolved against the config that wrote them,
 * the default include when neither `files` nor `include` is set, the output directories (`outDir`,
 * `declarationDir`) as the default exclude when `exclude` is absent, and the options the model reports. A `jsconfig.json` defaults `allowJs` to true.
 */
export function effectiveConfig(ctx: ReadContext, node: ConfigNode): EffectiveConfig {
  const files = node.files === undefined ? [] : resolveList(ctx, node, node.files, 'files');
  let include: string[];
  if (node.include !== undefined) include = resolveList(ctx, node, node.include, 'include');
  else include = node.files === undefined ? [resolveSpec('**/*', node.dir, node.dir)] : [];
  const rootDir = optionPath(node, 'rootDir');
  const outDir = optionPath(node, 'outDir');
  const declarationDir = optionPath(node, 'declarationDir');
  // With no `exclude` anywhere in the chain the output directories are excluded (the merged options, each read
  // against the config that set it: measured against the compiler, plan 03-18 Task 2).
  const exclude =
    node.exclude !== undefined
      ? resolveList(ctx, node, node.exclude, 'exclude')
      : [outDir, declarationDir].filter((dir): dir is string => dir !== undefined);

  const allowJsOption = node.options.get('allowJs')?.value;
  const allowJs = typeof allowJsOption === 'boolean' ? allowJsOption : baseName(node.path) === 'jsconfig.json';
  const jsx = node.options.get('jsx')?.value;
  const flag = (key: string): boolean => node.options.get(key)?.value === true;
  const outFile = [node.options.get('outFile')?.value, node.options.get('out')?.value].some((v) => typeof v === 'string' && v !== '');
  return {
    hashes: node.hashes,
    info: {
      path: node.path,
      hash: node.hash,
      chain: node.chain,
      files,
      include,
      exclude,
      ...(rootDir === undefined ? {} : { rootDir }),
      ...(outDir === undefined ? {} : { outDir }),
      ...(declarationDir === undefined ? {} : { declarationDir }),
      allowJs,
      ...(typeof jsx === 'string' ? { jsx } : {}),
      noEmit: flag('noEmit'),
      declaration: flag('declaration') || flag('composite'),
      emitDeclarationOnly: flag('emitDeclarationOnly'),
      outFile,
      references: node.references,
    },
  };
}
