// RED stub (plan 03-10 task 1): the interface exists, the behavior does not yet.
import type { AnswerKey, Question } from './questions.ts';
import type { ResultsStore } from './results.ts';
import type { ResultRow } from './rows.ts';
import type { Cell } from './schedule.ts';

export interface CellDeps {
  questions: ReadonlyMap<string, Question>;
  keys: ReadonlyMap<string, AnswerKey>;
  corpusDir: string;
  scratchRoot: string;
  store: ResultsStore;
  atlasBin: string;
  skillPath: string;
  answerSchema: string;
  model?: string;
  maxBudgetUsd: number;
  wallClockMs: number;
  keepSessions?: boolean;
  claude?: { executable?: string; prefixArgs?: string[] };
  env?: Record<string, string>;
}

export interface CellResult {
  outcome: 'done' | 'skipped';
  row?: ResultRow;
}

export async function runCell(_cell: Cell, _deps: CellDeps): Promise<CellResult> {
  return { outcome: 'skipped' };
}
