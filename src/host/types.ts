/**
 * The Host's public types (tenant-composition ADR decision 5): the composition root for a process. It owns request
 * routing and the tenants; adapters only call `host.handle(request)`, through the HostClient seam.
 */
import type { CommandRunner, UserPermissions } from '../command-runner/index.ts';
import type { Clock, Envelope, Request } from '../facts/index.ts';
import type { Governor } from '../governor/index.ts';
import type { GrammarEngine } from '../grammar-engine/index.ts';
import type { EventSource, Indexer, IndexerDeps } from '../indexer/index.ts';
import type { Roots } from '../lang/index.ts';
import type { TenantTuning } from '../tenant/index.ts';

/**
 * The user-level configuration (trust-boundaries ADR): it comes from `<userDir>/config.json` and the environment
 * only, never from a repository. Every key is optional.
 */
export interface UserConfig {
  readonly store?: {
    /** Absolute directory under which each repository's store lives, in a folder named by its store id. */
    readonly dir?: string;
  };
  readonly indexer?: {
    readonly debounceMs?: number;
    readonly maxWaitMs?: number;
  };
  readonly gc?: {
    /** How long a retired file version is kept when git does not have its blob, in milliseconds. */
    readonly graceMs?: number;
  };
  /** Which commands the CommandRunner may start beyond its built-in read-only git rule. */
  readonly permissions?: UserPermissions;
}

export interface HostOptions {
  /** The default module search roots. The composition root alone knows the home and working directories. */
  readonly roots: Roots;
  readonly engine: GrammarEngine;
  /** Default: the real runner with the user's permissions, created on first use. */
  readonly runner?: CommandRunner;
  /** Default: the real Governor with the approved limits, created on first use. */
  readonly governor?: Governor;
  /** Default: the system clock. */
  readonly clock?: Clock;
  /** The directory a repo-scoped request without `repo` or `cwd` is about. Default: `roots.repoRoot`. */
  readonly cwd?: string;
  /** The user-level configuration folder; the cache fallback lives under it when `cacheRoot` is not given. */
  readonly userDir?: string;
  readonly config?: UserConfig;
  /** The version of this build, recorded in a new store. */
  readonly version?: string;
  /** False: record no metrics. Default true. */
  readonly metrics?: boolean;
  /** Where a store goes when the git common directory is not usable. Default: `<userDir>/cache`. */
  readonly cacheRoot?: string;
  /** Extra environment for every git command (a test's config isolation). */
  readonly gitEnv?: Readonly<Record<string, string>>;
  /** Builds the event source of a tenant's Indexer. Absent: Indexers are reconcile-only. */
  readonly eventSource?: () => EventSource;
  /** TEST HOOK. Builds a tenant's Indexer; production omits it. */
  readonly indexerFactory?: (deps: IndexerDeps) => Indexer;
  /** Shortens waits in tests. */
  readonly tuning?: Partial<TenantTuning>;
}

export interface Host {
  /** Answer one request. Every outcome, including every error, is an envelope; only a bug rejects. */
  handle(request: Request): Promise<Envelope>;
  /** Close one tenant and forget it; the next request for its repository opens it again. */
  closeTenant(storeId: string): Promise<void>;
  /** Close every tenant. Safe to call twice. */
  close(): Promise<void>;
}
