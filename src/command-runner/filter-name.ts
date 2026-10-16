/** RED stub (plan 01-20): always accepts. Replaced by the real rule in the fix commit. */
export const MAX_FILTER_NAME_LENGTH = 1024;

export function filterNameProblem(_name: string): string | null {
  return null;
}

export function isNeutralisableFilterName(name: string): boolean {
  return filterNameProblem(name) === null;
}
