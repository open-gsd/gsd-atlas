// RED stub (plan 02-16, task 2): replaced by the real ranking in the GREEN commit.

export type MatchTier = 0 | 1 | 2 | 3;

export type SortKey = readonly [number, number, number, number, number, string, number, number, string];

export interface RankInput {
  readonly tier: MatchTier;
  readonly isReference: boolean;
  readonly confidence: 'EXTRACTED' | 'INFERRED';
  readonly exported: boolean;
  readonly distance: number;
  readonly path: string;
  readonly line: number;
  readonly col: number;
  readonly handle: string;
}

const notYet = (): never => {
  throw new Error('ranking is not implemented yet');
};

export function tierOf(_candidate: string, _query: string): MatchTier | null {
  return notYet();
}

export function nameAndTier(_qualifiedName: string, _query: string, _foundExact: boolean): { name: string; tier: MatchTier } {
  return notYet();
}

export function directoryDistance(_fileDir: string, _hintDir: string | null): number {
  return notYet();
}

export function cwdHintDir(_worktree: string, _cwd: string | undefined): string | null {
  return notYet();
}

export function sortKeyOf(_input: RankInput): SortKey {
  return notYet();
}

export function compareRanked(_a: SortKey, _b: SortKey): number {
  return notYet();
}
