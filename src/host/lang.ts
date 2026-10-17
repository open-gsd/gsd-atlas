/**
 * The language-module requests the Host serves itself: `lang_test` and `lang_list`. They moved here from the
 * Phase 1 in-process client unchanged, apart from `lang_list` also taking the MCP tool's `repo` argument. They
 * touch no repository store, so they need no tenant and no Governor slot.
 */
import path from 'node:path';
import { failEnvelope, okEnvelope } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import { resolveModules, runLangTest } from '../lang/index.ts';
import type { LangTestReport, ModuleEntry, Roots } from '../lang/index.ts';
import { errorEnvelope } from '../query/index.ts';

/** Envelope schema of a `lang_test` reply. */
export const LANG_TEST_SCHEMA = 'gsd-atlas.lang-test/1';
/** Envelope schema of a `lang_list` reply. */
export const LANG_LIST_SCHEMA = 'gsd-atlas.lang-list/1';

/** The data of a `lang_list` reply. */
export interface LangListData {
  readonly modules: readonly ModuleEntry[];
}

/** The two request kinds this file serves. */
export const LANG_KINDS = ['lang_test', 'lang_list'] as const;

function argsObject(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

function targetOf(args: unknown): string | undefined {
  const { target } = argsObject(args);
  return typeof target === 'string' && target !== '' ? target : undefined;
}

type RootsOverride = { readonly ok: true; readonly roots: Roots } | { readonly ok: false; readonly message: string };

const isAbsolutePath = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value);

/**
 * Merge a request's optional `args.roots` over the defaults, field by field. Every path must be an
 * absolute string: the host never resolves a relative root against its own working directory.
 */
function rootsFor(defaults: Roots, args: unknown): RootsOverride {
  const { roots } = argsObject(args);
  if (roots === undefined) {
    return { ok: true, roots: defaults };
  }
  if (typeof roots !== 'object' || roots === null || Array.isArray(roots)) {
    return { ok: false, message: 'args.roots must be an object' };
  }
  const given = roots as Record<string, unknown>;
  const known = new Set(['repoRoot', 'userDir', 'builtinDir', 'npmRoots']);
  const unknown = Object.keys(given).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return { ok: false, message: `args.roots has unknown fields: ${unknown.join(', ')}` };
  }
  const merged = { ...defaults } as { -readonly [K in keyof Roots]: Roots[K] };
  if (given['repoRoot'] !== undefined) {
    if (!isAbsolutePath(given['repoRoot'])) {
      return { ok: false, message: 'args.roots.repoRoot must be an absolute path' };
    }
    merged.repoRoot = given['repoRoot'];
  }
  if (given['userDir'] !== undefined) {
    if (!isAbsolutePath(given['userDir'])) {
      return { ok: false, message: 'args.roots.userDir must be an absolute path' };
    }
    merged.userDir = given['userDir'];
  }
  if (given['builtinDir'] !== undefined) {
    if (given['builtinDir'] !== null && !isAbsolutePath(given['builtinDir'])) {
      return { ok: false, message: 'args.roots.builtinDir must be an absolute path or null' };
    }
    merged.builtinDir = given['builtinDir'];
  }
  if (given['npmRoots'] !== undefined) {
    const list = given['npmRoots'];
    if (!Array.isArray(list) || !list.every(isAbsolutePath)) {
      return { ok: false, message: 'args.roots.npmRoots must be an array of absolute paths' };
    }
    merged.npmRoots = [...(list as string[])];
  }
  return { ok: true, roots: merged };
}

function langTestEnvelope(report: LangTestReport): Envelope<LangTestReport> {
  return report.ok
    ? okEnvelope(LANG_TEST_SCHEMA, report, report.diagnostics)
    : failEnvelope<LangTestReport>(LANG_TEST_SCHEMA, report.diagnostics);
}

export interface LangContext {
  /** The default module search roots. */
  readonly roots: Roots;
  readonly engine: GrammarEngine;
}

/** Answer a `lang_test` or `lang_list` request. */
export async function handleLang(request: Request, context: LangContext): Promise<Envelope> {
  const roots = rootsFor(context.roots, request.args);
  if (!roots.ok) {
    return errorEnvelope('invalid_args', roots.message);
  }
  if (request.kind === 'lang_test') {
    const target = targetOf(request.args);
    if (target === undefined) {
      return errorEnvelope('invalid_args', 'lang_test needs args.target: a non-empty module folder path or module id');
    }
    return langTestEnvelope(await runLangTest({ target, roots: roots.roots, engine: context.engine }));
  }
  // lang_list: the MCP tool's `repo` argument names the repository whose own modules are listed.
  const { repo } = argsObject(request.args);
  let effective = roots.roots;
  if (repo !== undefined) {
    if (!isAbsolutePath(repo)) {
      return errorEnvelope('invalid_args', 'args.repo must be an absolute path');
    }
    effective = { ...roots.roots, repoRoot: repo };
  }
  const { modules, diagnostics } = resolveModules(effective);
  return okEnvelope<LangListData>(LANG_LIST_SCHEMA, { modules }, diagnostics);
}
