// Miniature library of the oracle fixture. Nothing in this repository is ever executed.
export function compute(x: number): number {
  return x * 2;
}

export class Base {
  readonly label: string = 'base';
}

export interface Shape {
  area(): number;
}

/** The helper exists because of ADR-1, which has an ADR file. */
export function helper(): number {
  return 0;
}
