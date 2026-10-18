/**
 * The Host's table of built-in precise tiers (plan 03-23, SEC-02).
 *
 * A language module's manifest names a precise adapter by id (`precise.adapter`). The id only picks from this table; it is
 * never a path, a command or a module to import, so a repository cannot add or enable a tier (T-03-235). The built-in
 * tiers run by default; the user turns one off by id in user-level configuration (`providers.disabled`), and a tier that is
 * off starts no process at all.
 */
import type { CommandRunner } from '../command-runner/index.ts';
import { createResolverMemory, createTypeScriptTier } from '../precise-resolver/index.ts';
import type { PreciseTier, ResolverMemory, TypeScriptTierTuning } from '../precise-resolver/index.ts';

/** What a tier needs from the Host. */
export interface TierDeps {
  /** The runner the Host uses; the tier starts its worker through it and nowhere else. */
  readonly runner: CommandRunner;
  /** Provider ids the user turned off. */
  readonly disabled: readonly string[];
  /** TEST HOOK: tuning of the TypeScript tier. */
  readonly tuning?: TypeScriptTierTuning;
}

export type TierFactory = (deps: TierDeps) => PreciseTier;

/**
 * The one memory budget and worker pool of a Host (plan 03-27, D-21): a share of the machine's RAM (25 percent by default)
 * that every tenant's tier draws on, so many repositories can not each take their own. The composition root builds it once
 * from `os.totalmem()` (a test injects the figure) and hands it to the Host through the tier tuning; the Host closes it.
 */
export function createTierMemory(options: { readonly totalMemBytes?: number } = {}): ResolverMemory {
  return createResolverMemory(options);
}

/** The built-in tiers by adapter id. */
export const BUILTIN_TIERS: ReadonlyMap<string, TierFactory> = new Map<string, TierFactory>([
  [
    'typescript',
    (deps) => createTypeScriptTier({ ...deps.tuning, runner: deps.runner, disabled: deps.disabled.includes('typescript') }),
  ],
]);

/** The tier built-in under `id`, or undefined for an id nobody knows. The lookup is a Map, so no inherited name resolves. */
export function createTier(id: string, deps: TierDeps): PreciseTier | undefined {
  return BUILTIN_TIERS.get(id)?.(deps);
}
