// RED stub (plan 02-16, task 1): replaced by the real Query in the GREEN commit.
import type { Query, QueryDeps } from './types.ts';

export function createQuery(_deps: QueryDeps): Query {
  return {
    ask(): never {
      throw new Error('the query module is not implemented yet');
    },
  };
}
