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

/** mulberry32: a small seeded generator, local so the order depends on nothing but this file and the seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The run order: for each (question, run) the arms form one adjacent group in random order, and the
 * groups are shuffled. Prompt-cache warmth and rate-limit drift then fall evenly on both arms. The
 * order is a pure function of the arguments; the seed is registered, and `plan` prints the result.
 */
export function makeSchedule(
  questionIds: readonly string[],
  arms: readonly ArmName[],
  runs: number,
  seed: number,
): Cell[] {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError(`runs must be a positive integer, got ${String(runs)}`);
  if (!Number.isInteger(seed)) throw new RangeError(`seed must be an integer, got ${String(seed)}`);
  if (arms.length === 0) throw new RangeError('at least one arm is needed');
  if (new Set(arms).size !== arms.length) throw new RangeError('arms must not repeat');
  if (new Set(questionIds).size !== questionIds.length) throw new RangeError('question ids must not repeat');
  const random = seededRandom(seed);
  const groups: Cell[][] = [];
  for (const questionId of questionIds) {
    for (let run = 1; run <= runs; run += 1) {
      groups.push(shuffled(arms.map((arm): Cell => ({ questionId, arm, run })), random));
    }
  }
  return shuffled(groups, random).flat();
}

/**
 * Deals cells to `workers` lanes in turn, each lane in schedule order. The run itself uses a shared
 * queue (a worker takes the next cell when it is free, so a slow cell does not idle the others); the
 * lanes are for reading a schedule by worker.
 */
export function partition<T>(cells: readonly T[], workers: number): T[][] {
  if (!Number.isInteger(workers) || workers < 1) throw new RangeError(`workers must be a positive integer, got ${String(workers)}`);
  const lanes: T[][] = Array.from({ length: workers }, () => []);
  cells.forEach((cell, index) => {
    (lanes[index % workers] as T[]).push(cell);
  });
  return lanes;
}
