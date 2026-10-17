/**
 * Source: .planning/phases/02-grammar-tier-store-and-stdio-host/02-CONSTANTS.md, "Addendum 2026-10-17 (gap closure)"
 * (Addendum status: Approved, 2026-10-17, by the user). The value is copied from the key named beside it; change it in
 * that file first, this object only carries it.
 *
 * - `idleEvictMs`: `host.idleEvictMs`, how long a tenant, and a history module host, may go without a request and with
 *   none in flight before the Host closes it and releases the repository's writer lease, its SQLite connections and
 *   its watcher (30 minutes, three times the 10-minute idle Reconcile interval of D-13).
 */
export const HOST_DEFAULTS = {
  idleEvictMs: 1_800_000,
} as const;
