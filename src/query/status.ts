/**
 * `atlas_status`: how current and healthy the index is, from injected ports only (QRY-03). The answer is state,
 * never benefit: it carries counts and flags, no source text, no file paths beyond the repository root, and no
 * value statistics (tokens saved, calls avoided; value-dashboard ADR decision 10). The stale paths and the failed
 * paths are counted and never listed, and the path the store moved a corrupt file to is reduced to a flag.
 */
import type { DegradedCode, Envelope } from '../facts/index.ts';
import { okEnvelope } from '../facts/index.ts';
import { cleanField } from './cite.ts';
import { ATLAS_STATUS_SCHEMA, errorEnvelope, withDegraded } from './envelope.ts';
import type { PolicyMode, StatusPort } from './types.ts';

/**
 * The policy mode until the Policy module lands in Phase 7 (the module does not exist yet). The Host's status port
 * returns this constant; when Policy arrives the port supplies the real mode and nothing here changes.
 */
export const POLICY_OFF: PolicyMode = 'off';

/** Why the index is degraded, in the fixed order reasons are reported. */
export const HEALTH_REASONS = ['follower', 'rebuilding', 'reconciling', 'stale_files', 'watch_fallback', 'indexer_failures'] as const;

export type HealthReason = (typeof HEALTH_REASONS)[number];

/** The degraded code that mirrors a health reason, where the closed vocabulary has one. */
const REASON_CODE: Readonly<Partial<Record<HealthReason, DegradedCode>>> = {
  follower: 'follower',
  rebuilding: 'rebuilding',
  reconciling: 'reconciling',
  stale_files: 'stale',
};

/** The `data` of an `atlas_status` answer. */
export interface StatusSnapshot {
  /** The repository root the request named; null when it named none. */
  readonly repo: string | null;
  readonly worktrees: readonly { readonly worktree: string; readonly seq: number; readonly staleCount: number }[];
  readonly store: {
    readonly schemaVersion: number;
    readonly sizeBytes: number;
    /** True when this process holds the writer lease. */
    readonly writerLeaseHeld: boolean;
    /** True when a corrupt store was found, moved aside and rebuilt. */
    readonly rebuilt: boolean;
  };
  /** Null when this process runs no Indexer. */
  readonly indexer: {
    readonly watchMode: string;
    readonly queued: number;
    readonly running: number;
    readonly failed: number;
    readonly reconciling: boolean;
    readonly lastReconcileAt: number | null;
    readonly lastIndexedAt: number | null;
  } | null;
  readonly governor: { readonly queued: number; readonly running: number; readonly leases: number };
  /**
   * Citations the index holds (plan 03-28, amendment of 2026-10-18). `filesWithGaps` is how many files, summed over the listed
   * worktrees, hold ADR mentions the index could not store (a comment over the comment size bound, or more mentions than the
   * per-file cap). A count only: it adds no health reason and no degraded code, so a benign repository stays `ok`.
   */
  readonly citations: { readonly filesWithGaps: number };
  readonly tiers: readonly { readonly module: string; readonly grammar: boolean; readonly precise: boolean; readonly platform: boolean }[];
  readonly policy: PolicyMode;
  readonly health: 'ok' | 'degraded';
  readonly reasons: readonly HealthReason[];
}

const UNAVAILABLE_MESSAGE = 'The index status is not available from this host right now.';

const unavailable = (message: string): Envelope => errorEnvelope('unavailable', message);

export async function runStatus(ports: StatusPort | undefined, repo: string | undefined): Promise<Envelope> {
  if (ports === undefined) return unavailable('atlas_status needs the host to supply its status ports; this host has none.');
  let snapshot: StatusSnapshot;
  try {
    const store = await ports.store();
    const indexer = ports.indexer();
    const governor = ports.governor();
    const worktrees = store.worktrees.map((entry) => ({ worktree: cleanField(entry.worktree), seq: entry.seq, staleCount: entry.stalePaths }));

    const reasons: HealthReason[] = [];
    const add = (reason: HealthReason, when: boolean): void => {
      if (when) reasons.push(reason);
    };
    add('follower', !store.writerLeaseHeld);
    add('rebuilding', store.rebuiltAfterCorruption !== undefined);
    add('reconciling', indexer !== null && indexer.reconciling);
    add('stale_files', worktrees.some((entry) => entry.staleCount > 0));
    add('watch_fallback', indexer !== null && indexer.watchMode === 'reconcile-only');
    add('indexer_failures', indexer !== null && indexer.failed.length > 0);

    snapshot = {
      repo: repo === undefined || repo === '' ? null : cleanField(repo),
      worktrees,
      store: {
        schemaVersion: store.schemaVersion,
        sizeBytes: store.sizeBytes,
        writerLeaseHeld: store.writerLeaseHeld,
        rebuilt: store.rebuiltAfterCorruption !== undefined,
      },
      indexer:
        indexer === null
          ? null
          : {
              watchMode: cleanField(indexer.watchMode),
              queued: indexer.queued,
              running: indexer.running,
              failed: indexer.failed.length,
              reconciling: indexer.reconciling,
              lastReconcileAt: indexer.lastReconcile === null ? null : indexer.lastReconcile.at,
              lastIndexedAt: indexer.lastIndexedAt,
            },
      governor: { queued: governor.queued, running: governor.running, leases: governor.leases },
      citations: { filesWithGaps: store.worktrees.reduce((sum, entry) => sum + entry.citationGapFiles, 0) },
      tiers: ports.tiers().map((entry) => ({
        module: cleanField(entry.module),
        grammar: entry.tiers.some((tier) => tier.tier === 'grammar' && tier.active),
        precise: entry.tiers.some((tier) => tier.tier === 'precise' && tier.active),
        platform: entry.tiers.some((tier) => tier.tier === 'platform' && tier.active),
      })),
      policy: ports.policy(),
      health: reasons.length === 0 ? 'ok' : 'degraded',
      reasons,
    };
  } catch {
    // The port's own error text is not echoed: it can quote paths.
    return unavailable(UNAVAILABLE_MESSAGE);
  }

  const codes: DegradedCode[] = [];
  for (const reason of snapshot.reasons) {
    const code = REASON_CODE[reason];
    if (code !== undefined) codes.push(code);
  }
  return withDegraded(okEnvelope(ATLAS_STATUS_SCHEMA, snapshot), codes);
}
