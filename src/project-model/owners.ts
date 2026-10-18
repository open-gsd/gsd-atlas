import { dirOf } from './globs.ts';

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const segmentsOf = (dir: string): string[] => (dir === '' ? [] : dir.split('/'));

/** A name such as `tsconfig.test.json` or `tsconfig.build.json`: not a config an editor or a plain `tsc` run would use first. */
const SPECIAL_NAME = /(?:^|[.-])(?:test|tests|spec|build|dist|prod|production)(?:[.-]|$)/i;

function isSpecialName(configPath: string): boolean {
  const name = configPath.slice(configPath.lastIndexOf('/') + 1).replace(/\.json$/i, '');
  return SPECIAL_NAME.test(name);
}

/** How near a config's directory is to the file: an ancestor first (deeper is nearer), then by shared prefix length. */
function nearness(configPath: string, filePath: string): { readonly ancestor: boolean; readonly depth: number } {
  const config = segmentsOf(dirOf(configPath));
  const file = segmentsOf(dirOf(filePath));
  let shared = 0;
  while (shared < config.length && shared < file.length && config[shared] === file[shared]) shared += 1;
  return { ancestor: shared === config.length, depth: shared };
}

/**
 * The one config that owns `path` (research Pattern 3), chosen the same way every time from the configs that cover
 * it: the config whose directory is the nearest ancestor of the file; then a plain name (`tsconfig.json`) before a
 * test or build name; then lexical order of the path. One compiler program is later run per owner, never per config.
 * Undefined when no config covers the file.
 */
export function chooseOwner(path: string, matchingConfigs: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestKey: readonly [number, number, number] | undefined;
  for (const config of matchingConfigs) {
    const near = nearness(config, path);
    const key = [near.ancestor ? 0 : 1, -near.depth, isSpecialName(config) ? 1 : 0] as const;
    if (best === undefined || bestKey === undefined) {
      best = config;
      bestKey = key;
      continue;
    }
    const diff = key[0] - bestKey[0] || key[1] - bestKey[1] || key[2] - bestKey[2];
    if (diff < 0 || (diff === 0 && compareCodeUnits(config, best) < 0)) {
      best = config;
      bestKey = key;
    }
  }
  return best;
}
