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
import type { DegradedCode, Diagnostic, NoticingResolverPort, PreciseFacts, RelationsPort, ResolvedEdge, ResolvedRelation } from '../../facts/index.ts';
import { TYPESCRIPT_RESOLVER_ID, createTuningMemory, createTypeScriptResolver } from './client.ts';
import type { PreciseLimits, RelationStats, ResolverMemory, TypeScriptResolver, WorkerInfo } from './client.ts';
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
  /** Files asked, relations kept and relations dropped, summed over the tier's workers (plan 03-25). */
  relationStats(): RelationStats;
  /** What each running worker reported about itself. */
  info(): readonly WorkerInfo[];
  /** The budget and pool this tier's workers live in: the Host's when it was given one, else the tier's own. */
  readonly memory: ResolverMemory;
  /** Forget every memory stop: the next read of a project that was stopped for memory starts a worker again (plan 03-27). */
  clearMemoryStop(): void;
  /** End every worker. Safe to call twice. */
  close(): Promise<void>;
}

/** Test and tuning options of the TypeScript tier. Production leaves them unset. */
export interface TypeScriptTierTuning {
  /** The V8 heap limit of a worker, in megabytes. */
  readonly heapMb?: number;
  /** The RSS limit of a worker's sampler thread in megabytes; `null` runs the V8 heap flag alone (a test of that backstop). */
  readonly rssLimitMb?: number | null;
  /** The sampler's period in milliseconds. */
  readonly sampleMs?: number;
  /** The machine's RAM in bytes (default `os.totalmem()`). */
  readonly totalMemBytes?: number;
  /**
   * The memory budget and worker pool of the Host (plan 03-27): one pair for all its tenants, built by the composition root.
   * Without it the tier builds its own, so its workers are bounded among themselves but not against other tiers.
   */
  readonly memory?: ResolverMemory;
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

async function* noRelations(): AsyncGenerator<ResolvedRelation, void, undefined> {
  // the provider is off: it has no relations
}

export function createTypeScriptTier(deps: TypeScriptTierDeps): PreciseTier {
  const disabled = deps.disabled === true;
  const resolvers = new Map<string, TypeScriptResolver>();
  const ownsMemory = deps.memory === undefined;
  const memory: ResolverMemory = deps.memory ?? createTuningMemory(deps);
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
        ...(deps.rssLimitMb === undefined ? {} : { rssLimitMb: deps.rssLimitMb }),
        ...(deps.sampleMs === undefined ? {} : { sampleMs: deps.sampleMs }),
        ...(deps.totalMemBytes === undefined ? {} : { totalMemBytes: deps.totalMemBytes }),
        memory,
        ...(deps.limits === undefined ? {} : { limits: deps.limits }),
        ...(deps.onCleanup === undefined ? {} : { onCleanup: deps.onCleanup }),
      });
      resolvers.set(worktree, resolver);
    }
    return resolver;
  }

  const edges: NoticingResolverPort = (sites, context, symbols, scope) => {
    if (disabled || closed || scope === undefined) return nothing();
    return resolverFor(scope.worktree).resolveScoped(scope.project.precise, scope.overlay, context, sites, symbols);
  };
  // The relations of the same worker (plan 03-25). While the provider is off the port still carries the method, so the
  // store derives the same tier state codes for relations as for edges; it just yields nothing.
  const relations: RelationsPort = (files, context, symbols, scope) => {
    if (disabled || closed || scope === undefined) return noRelations();
    return resolverFor(scope.worktree).relationsScoped(scope.project.precise, scope.overlay, context, files, symbols);
  };
  const resolver: NoticingResolverPort = Object.assign(edges, { relations });

  return {
    id: TYPESCRIPT_RESOLVER_ID,
    resolver,
    active: !disabled,
    memory,
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
    relationStats() {
      const total: RelationStats = { files: { asked: 0, answered: 0 }, kept: 0, dropped: 0 };
      for (const each of resolvers.values()) {
        const part = each.relationStats();
        total.files.asked += part.files.asked;
        total.files.answered += part.files.answered;
        total.kept += part.kept;
        total.dropped += part.dropped;
      }
      return total;
    },
    info() {
      return [...resolvers.values()].flatMap((each) => {
        const info = each.info();
        return info === undefined ? [] : [info];
      });
    },
    clearMemoryStop() {
      for (const each of resolvers.values()) each.clearMemoryStop();
    },
    async close() {
      closed = true;
      const all = [...resolvers.values()];
      resolvers.clear();
      await Promise.all(all.map((each) => each.close().catch(() => undefined)));
      // The Host's pool outlives its tenants and is closed by the Host; a tier's own pool ends with the tier.
      if (ownsMemory) await memory.pool.close();
    },
  };
}
