/**
 * The TypeScript precise tier as the Host builds it (plan 03-23, SEC-02).
 *
 * A tier is the store's resolver port plus what a Tenant needs to run it: its status, the fixed text that explains a
 * degraded code it produced, and a way to end it. The built-in tier is on by default and the user can turn it off by id in
 * user-level configuration; when it is off no worker is ever started and every answer that needs it says so. Nothing a
 * repository contains can create or enable a tier: the Host picks it from its own table by the id a module manifest names.
 */
import type { CommandRunner } from '../../command-runner/index.ts';
import { diagnostic } from '../../facts/index.ts';
import type { DegradedCode, Diagnostic, NoticingResolverPort, PreciseFacts, ResolvedEdge } from '../../facts/index.ts';
import { TYPESCRIPT_RESOLVER_ID, createTypeScriptResolver } from './client.ts';
import type { PreciseLimits, TypeScriptResolver, WorkerInfo } from './client.ts';
import { compilerFallbackText } from './compiler.ts';
import { createStats } from './identity.ts';
import type { KindStats, Stats } from './identity.ts';

/** What a Tenant sees of a precise tier. */
export interface PreciseTier {
  readonly id: string;
  /** The store's resolver port: yields edges and notices, or nothing at all while the tier is off. */
  readonly resolver: NoticingResolverPort;
  /** False while the user has turned the provider off. */
  readonly active: boolean;
  /** The fixed-text diagnostic that explains `code` for a worktree whose project facts are `facts`, or undefined. */
  explain(code: DegradedCode, facts: PreciseFacts | undefined): Diagnostic | undefined;
  /** Sites asked, edges produced and declarations dropped, summed over the tier's workers. */
  stats(): Stats;
  /** What each running worker reported about itself. */
  info(): readonly WorkerInfo[];
  /** End every worker. Safe to call twice. */
  close(): Promise<void>;
}

/** Test and tuning options of the TypeScript tier. Production leaves them unset. */
export interface TypeScriptTierTuning {
  /** The V8 heap limit of a worker, in megabytes. */
  readonly heapMb?: number;
  readonly limits?: Partial<PreciseLimits>;
  /** The Node binary and worker file the runner's built-in shape names. */
  readonly execPath?: string;
  readonly workerPath?: string;
  readonly bundledDir?: string;
  readonly onCleanup?: () => void;
}

export interface TypeScriptTierDeps extends TypeScriptTierTuning {
  readonly runner: CommandRunner;
  /** True when the user turned the provider off: the tier then starts nothing. */
  readonly disabled?: boolean;
}

/** The text for the codes the tier explains. Fixed words only: no repository text, path or version string. */
const TEXT: Readonly<Partial<Record<DegradedCode, string>>> = {
  precise_unavailable: 'no tsconfig.json covers a TypeScript file in this answer; it was answered from grammar facts',
  memory_budget: 'the compiler worker reached its memory limit; this answer uses grammar facts',
  resolver_failed: 'the compiler worker failed; this answer uses grammar facts',
};

/** The text shown while the provider is off. */
export const PROVIDER_OFF_TEXT = 'the typescript provider is turned off in the user configuration';

/** Adds `part` into `into`: counts are summed key by key. */
function addStats(into: Stats, part: Stats): void {
  into.sites.asked += part.sites.asked;
  into.sites.answered += part.sites.answered;
  into.edges += part.edges;
  for (const [kind, count] of Object.entries(part.dropped)) into.dropped[kind] = (into.dropped[kind] ?? 0) + count;
  for (const [kind, each] of Object.entries(part.byKind)) {
    const total: KindStats = into.byKind[kind] ?? { asked: 0, edges: 0, dropped: 0 };
    total.asked += each.asked;
    total.edges += each.edges;
    total.dropped += each.dropped;
    into.byKind[kind] = total;
  }
}

async function* nothing(): AsyncGenerator<ResolvedEdge, void, undefined> {
  // the provider is off: it resolves nothing
}

export function createTypeScriptTier(deps: TypeScriptTierDeps): PreciseTier {
  const disabled = deps.disabled === true;
  const resolvers = new Map<string, TypeScriptResolver>();
  let closed = false;

  function resolverFor(worktree: string): TypeScriptResolver {
    let resolver = resolvers.get(worktree);
    if (resolver === undefined) {
      resolver = createTypeScriptResolver({
        runner: deps.runner,
        worktree,
        ...(deps.execPath === undefined ? {} : { execPath: deps.execPath }),
        ...(deps.workerPath === undefined ? {} : { workerPath: deps.workerPath }),
        ...(deps.bundledDir === undefined ? {} : { bundledDir: deps.bundledDir }),
        ...(deps.heapMb === undefined ? {} : { heapMb: deps.heapMb }),
        ...(deps.limits === undefined ? {} : { limits: deps.limits }),
        ...(deps.onCleanup === undefined ? {} : { onCleanup: deps.onCleanup }),
      });
      resolvers.set(worktree, resolver);
    }
    return resolver;
  }

  const resolver: NoticingResolverPort = (sites, context, symbols, scope) => {
    if (disabled || closed || scope === undefined) return nothing();
    return resolverFor(scope.worktree).resolveScoped(scope.project.precise, scope.overlay, context, sites, symbols);
  };

  return {
    id: TYPESCRIPT_RESOLVER_ID,
    resolver,
    active: !disabled,
    explain(code, facts) {
      if (disabled) return code === 'precise_unavailable' ? diagnostic(code, 'info', PROVIDER_OFF_TEXT) : undefined;
      if (code === 'compiler_fallback') {
        const text = facts === undefined ? undefined : compilerFallbackText(facts.compiler);
        // A state, not a fault: the answer is still precise. `info` keeps the CLI's stderr for problems.
        return text === undefined ? undefined : diagnostic(code, 'info', text);
      }
      const text = TEXT[code];
      if (text === undefined) return undefined;
      // `precise_unavailable` is a state too (no config covers the file); a worker that failed or ran out of memory is a problem.
      return diagnostic(code, code === 'precise_unavailable' ? 'info' : 'warning', text);
    },
    stats() {
      const total = createStats();
      for (const each of resolvers.values()) addStats(total, each.stats());
      return total;
    },
    info() {
      return [...resolvers.values()].flatMap((each) => {
        const info = each.info();
        return info === undefined ? [] : [info];
      });
    },
    async close() {
      closed = true;
      const all = [...resolvers.values()];
      resolvers.clear();
      await Promise.all(all.map((each) => each.close().catch(() => undefined)));
    },
  };
}
