/**
 * The ports `atlas_status` reads (open item of plan 02-19): the Host wires Query's `StatusPort` to the state it
 * already holds, so Query imports neither the Indexer, the Governor nor the module registry. Everything here is a
 * count, a flag or a name; nothing reads repository content.
 */
import type { FactStore } from '../fact-store/index.ts';
import type { Governor } from '../governor/index.ts';
import type { Indexer } from '../indexer/index.ts';
import { resolveModules } from '../lang/index.ts';
import type { Roots } from '../lang/index.ts';
import { POLICY_OFF } from '../query/index.ts';
import type { StatusPort } from '../query/index.ts';

export interface StatusPortParts {
  readonly store: Pick<FactStore, 'status'>;
  /** The Indexer, or undefined when this process runs none for the tenant. */
  readonly indexer: () => Indexer | undefined;
  readonly governor: Pick<Governor, 'status'>;
  readonly roots: Roots;
}

export function createStatusPort(parts: StatusPortParts): StatusPort {
  return {
    store: () => parts.store.status(),
    indexer: () => parts.indexer()?.status() ?? null,
    governor: () => parts.governor.status(),
    tiers: () =>
      resolveModules(parts.roots).modules.map((entry) => ({
        module: entry.name,
        tiers: entry.tiers.map((tier) => ({ tier: tier.tier, active: tier.active })),
      })),
    policy: () => POLICY_OFF,
  };
}
