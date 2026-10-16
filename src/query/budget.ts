// RED stub (plan 02-16, task 2): replaced by the real budget in the GREEN commit.

export interface Cut<T> {
  readonly kept: readonly T[];
  readonly truncated: boolean;
  readonly lastIndex: number;
  readonly tooLarge: boolean;
}

const notYet = (): never => {
  throw new Error('the budget is not implemented yet');
};

export function estimateTokens(_envelope: unknown): number {
  return notYet();
}

export function cutToBudget<T>(
  _items: readonly T[],
  _measure: (kept: readonly T[], truncated: boolean) => number | Promise<number>,
  _limits: { readonly budget: number; readonly ceiling: number },
  _moreBeyond: boolean,
): Promise<Cut<T>> {
  return Promise.resolve(notYet());
}
