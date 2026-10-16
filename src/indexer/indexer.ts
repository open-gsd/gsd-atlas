import type { Indexer, IndexerDeps } from './types.ts';

/** RED stub: replaced by the real Indexer in the GREEN commit of this task. */
export function createIndexer(_deps: IndexerDeps): Indexer {
  const notYet = (what: string): Error => new Error(`the indexer ${what} is not implemented yet`);
  return {
    build: () => Promise.reject(notYet('build')),
    submit: () => {
      throw notYet('submit');
    },
    ensureFresh: () => Promise.reject(notYet('ensureFresh')),
    status: () => {
      throw notYet('status');
    },
    stop: () => Promise.resolve(),
  };
}
