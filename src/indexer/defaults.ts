import { GRAMMAR_LIMITS } from '../grammar-engine/index.ts';
import type { IndexerConfig } from './types.ts';

/**
 * Source: .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md (Status: Approved 2026-10-16),
 * keys `indexer.debounceMs` (D-12, locked), `indexer.maxWaitMs` (D-12, locked) and `indexer.ensureFreshWaitMs`.
 * Change the values there first; this object only carries them. `maxFileBytes` is the Grammar Engine's own
 * source cap, so a file the engine would refuse is never read. `maxRaceRetries` is the plan's three re-reads
 * of a file that changes while it is being indexed. `idleReconcileIntervalMs` is the key of the same name in that
 * file (D-13, about 10 minutes); the approved value is written here and nowhere else.
 */
export const DEFAULT_INDEXER_CONFIG: IndexerConfig = {
  debounceMs: 100,
  maxWaitMs: 500,
  ensureFreshWaitMs: 2000,
  maxFileBytes: GRAMMAR_LIMITS.sourceBytes,
  maxRaceRetries: 3,
  idleReconcileIntervalMs: 600000,
};
