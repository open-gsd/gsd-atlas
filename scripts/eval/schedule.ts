/**
 * The cells of the eval run and their order (D-03).
 *
 * A cell is one session: a (question, arm, run) triple. This file holds the identity of a cell, which
 * resumption and the analysis both depend on, and (from plan 03-10 task 2) the seeded balanced order.
 * It imports nothing from the system under test.
 */

export type ArmName = 'atlas' | 'grep';

export interface Cell {
  readonly questionId: string;
  readonly arm: ArmName;
  /** 1-based repeat number of this question in this arm. */
  readonly run: number;
}

/** The identity of a cell: `questionId|arm|run`. A result row carries the same three fields. */
export function cellId(cell: { readonly questionId: string; readonly arm: string; readonly run: number }): string {
  return `${cell.questionId}|${cell.arm}|${String(cell.run)}`;
}

// RED stubs (plan 03-10 task 2): the interfaces exist, the behavior does not yet.
export function makeSchedule(
  _questionIds: readonly string[],
  _arms: readonly ArmName[],
  _runs: number,
  _seed: number,
): Cell[] {
  return [];
}

export function partition<T>(_cells: readonly T[], _workers: number): T[][] {
  return [];
}
