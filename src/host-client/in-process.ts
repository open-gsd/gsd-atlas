import path from 'node:path';

import { PROTOCOL_VERSION, diagnostic, failEnvelope, okEnvelope } from '../facts/index.ts';
import type { Envelope, Request } from '../facts/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import { resolveModules, runLangTest } from '../lang/index.ts';
import type { LangTestReport, ModuleEntry, Roots } from '../lang/index.ts';
import type { HostClient } from './index.ts';

/** Envelope schema of a `lang_test` reply. */
export const LANG_TEST_SCHEMA = 'gsd-atlas.lang-test/1';
/** Envelope schema of a `lang_list` reply. */
export const LANG_LIST_SCHEMA = 'gsd-atlas.lang-list/1';
/** Envelope schema of a reply that is only an error (unsupported protocol, unknown kind, bad args). */
export const ERROR_SCHEMA = 'gsd-atlas.error/1';

export interface InProcessHostClientOptions {
  /** The default module search roots. The composition root alone knows the home and working directories. */
  readonly roots: Roots;
  readonly engine: GrammarEngine;
}

/** The data of a `lang_list` reply. */
export interface LangListData {
  readonly modules: readonly ModuleEntry[];
}

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

function invalidArgs(message: string): Envelope {
  return failEnvelope(ERROR_SCHEMA, [diagnostic('invalid_args', 'error', message)]);
}

/**
 * The Phase 1 host: it serves requests in the calling process. The transport changes in Phase 4;
 * the request and envelope shapes do not.
 */
export function createInProcessHostClient(options: InProcessHostClientOptions): HostClient {
  return {
    async handle(request: Request): Promise<Envelope> {
      if (request.protocol !== PROTOCOL_VERSION) {
        return failEnvelope(ERROR_SCHEMA, [
          diagnostic(
            'unsupported_protocol',
            'error',
            `protocol ${String(request.protocol)} is not supported; this host speaks protocol ${String(PROTOCOL_VERSION)}`,
          ),
        ]);
      }
      switch (request.kind) {
        case 'lang_test': {
          const target = targetOf(request.args);
          if (target === undefined) {
            return invalidArgs('lang_test needs args.target: a non-empty module folder path or module id');
          }
          const roots = rootsFor(options.roots, request.args);
          if (!roots.ok) {
            return invalidArgs(roots.message);
          }
          return langTestEnvelope(await runLangTest({ target, roots: roots.roots, engine: options.engine }));
        }
        case 'lang_list': {
          const roots = rootsFor(options.roots, request.args);
          if (!roots.ok) {
            return invalidArgs(roots.message);
          }
          const { modules, diagnostics } = resolveModules(roots.roots);
          return okEnvelope<LangListData>(LANG_LIST_SCHEMA, { modules }, diagnostics);
        }
        default:
          return failEnvelope(ERROR_SCHEMA, [
            diagnostic('unknown_kind', 'error', `request kind ${JSON.stringify(request.kind)} is not known to this host`),
          ]);
      }
    },
  };
}
