/**
 * The four structural errors of the Fact Store (fact-store-interface ADR decision 10). Reads never throw for
 * missing data; they throw only `UnknownWorktree` and `StoreClosed`. Each class has a stable `name`.
 */

/** The store on disk was written by a newer build than this one. Names the host version that can open it (A46). */
export class SchemaTooNew extends Error {
  /** The host version needed to open this store. */
  readonly hostVersion: string;

  constructor(hostVersion: string) {
    super(`this store was written by a newer gsd-atlas; it needs host version ${hostVersion} or newer`);
    this.name = 'SchemaTooNew';
    this.hostVersion = hostVersion;
  }
}

/** `store.writer()` while another writer holds the single writer lease. */
export class WriterBusy extends Error {
  constructor() {
    super('another writer holds this store\'s writer lease');
    this.name = 'WriterBusy';
  }
}

/** A read named a worktree the store has no overlay for. */
export class UnknownWorktree extends Error {
  readonly worktree: string;

  constructor(worktree: string) {
    super(`unknown worktree: ${worktree}`);
    this.name = 'UnknownWorktree';
    this.worktree = worktree;
  }
}

/** Any call after `close()`. */
export class StoreClosed extends Error {
  constructor() {
    super('the fact store is closed');
    this.name = 'StoreClosed';
  }
}
