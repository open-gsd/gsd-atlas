// RED stub (plan 03-10 task 1): the interface exists, the behavior does not yet.
import type { ResultRow } from './rows.ts';

export class ResultsStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  has(_cellId: string): boolean {
    return false;
  }
  append(_row: ResultRow): void {}
  all(): ResultRow[] {
    return [];
  }
  appendAttempt(_record: Record<string, unknown>): void {}
  appendMeta(_record: Record<string, unknown>): void {}
}
