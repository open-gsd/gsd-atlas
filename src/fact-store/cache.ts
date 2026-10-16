import type { ResolutionContext } from '../facts/index.ts';

/**
 * PLACEHOLDER for the RED commit of plan 02-11 task 3: the real snapshot id and context key arrive with the
 * GREEN commit.
 */
export function overlaySnapshotId(pathToHash: ReadonlyMap<string, string>): string {
  return JSON.stringify([...pathToHash]);
}

export function contextKey(_context: ResolutionContext): string {
  return '';
}
