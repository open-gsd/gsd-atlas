/**
 * The module host: which language modules are loaded, which extensions they claim, and how a file's text becomes
 * `FileFacts`. The registry (`resolveModules`) already settled extension collisions, so each extension has at most
 * one module. Grammars load lazily, once per module; a module that cannot load is reported per file and tried
 * again on the next file, so a transient failure does not disable a language for the life of the process.
 */
import type { Diagnostic, FileFacts } from '../facts/index.ts';
import { extractFileFacts } from '../grammar-engine/index.ts';
import type { GrammarEngine, GrammarRunResult, LoadedGrammar } from '../grammar-engine/index.ts';
import { readModuleInputs, resolveModules } from '../lang/index.ts';
import type { ModuleEntry, Roots } from '../lang/index.ts';

export type ExtractOutcome =
  | { readonly kind: 'facts'; readonly facts: FileFacts; readonly diagnostics: Diagnostic[] }
  /** No loaded module claims the file's extension. */
  | { readonly kind: 'unclaimed' }
  /** The module could not load or the engine could not run; `code` is stable (`parse_timeout`, `wasm_hash_mismatch`, ...). */
  | { readonly kind: 'failed'; readonly code: string };

export interface ModuleHost {
  /** Lower-case extensions with the dot (`.ts`) that a loaded module claims and serves, sorted. */
  extensions(): readonly string[];
  /** Run the module for `path` over `text` and extract the facts. Never throws for a module or engine problem. */
  extract(path: string, text: string, contentHash: string): Promise<ExtractOutcome>;
  /** Release every grammar this host loaded. Safe to call twice. */
  dispose(): Promise<void>;
}

export interface ModuleHostOptions {
  readonly engine: GrammarEngine;
  readonly roots: Roots;
}

interface Loaded {
  readonly grammar: LoadedGrammar;
  readonly name: string;
  readonly version: string;
}

/** A module whose files could not be read; carries the stable code reported per file. */
class ModuleUnreadable extends Error {
  readonly code = 'module_unreadable';
}

/** The lower-case extension of the last path segment, with its dot, or '' (`.gitignore` has none). Same rule as Source Tree. */
export function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function codeOf(error: unknown, fallback: string): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : fallback;
}

export function createModuleHost(options: ModuleHostOptions): ModuleHost {
  const { modules } = resolveModules(options.roots);
  const byExtension = new Map<string, ModuleEntry>();
  for (const entry of modules) {
    for (const extension of entry.extensions) {
      if (entry.inactiveExtensions.includes(extension)) continue;
      byExtension.set(extension.toLowerCase(), entry);
    }
  }
  const claimed = [...byExtension.keys()].sort();

  const loads = new Map<string, Promise<Loaded>>();
  async function loadModule(entry: ModuleEntry): Promise<Loaded> {
    const read = readModuleInputs(entry.dir);
    if (!read.ok) throw new ModuleUnreadable(read.diagnostics.map((d) => d.message).join('; '));
    const grammar = await options.engine.load(read.input);
    const source = read.lock.source;
    // The grammar version is the pinned upstream ref without its leading v, or the manifest's own version.
    const version = source.type === 'upstream' ? source.ref.replace(/^v/, '') : (read.manifest.version ?? 'unversioned');
    return { grammar, name: read.manifest.name, version };
  }
  function loaded(entry: ModuleEntry): Promise<Loaded> {
    let load = loads.get(entry.name);
    if (load === undefined) {
      load = loadModule(entry);
      loads.set(entry.name, load);
      load.catch(() => {
        loads.delete(entry.name);
      });
    }
    return load;
  }

  return {
    extensions: () => claimed,

    async extract(path, text, contentHash): Promise<ExtractOutcome> {
      const entry = byExtension.get(extensionOf(path));
      if (entry === undefined) return { kind: 'unclaimed' };
      let module: Loaded;
      try {
        module = await loaded(entry);
      } catch (error) {
        return { kind: 'failed', code: codeOf(error, 'module_load_failed') };
      }
      let run: GrammarRunResult;
      try {
        run = await module.grammar.run(text);
      } catch (error) {
        return { kind: 'failed', code: codeOf(error, 'engine_error') };
      }
      const { facts, diagnostics } = extractFileFacts({
        path,
        contentHash,
        module: module.name,
        grammarVersion: module.version,
        run,
      });
      return { kind: 'facts', facts, diagnostics };
    },

    async dispose(): Promise<void> {
      const pending = [...loads.values()];
      loads.clear();
      for (const load of pending) {
        try {
          await (await load).grammar.dispose();
        } catch {
          // a grammar that never loaded has nothing to release
        }
      }
    },
  };
}
