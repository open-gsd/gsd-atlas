import type { ConfigInfo, EmitMap } from './types.ts';

/**
 * Where the configs write the output of the overlay's sources (TSM-03). RED scaffold: maps nothing yet.
 */
export function buildEmitMap(
  _configs: readonly ConfigInfo[],
  _overlayPaths: readonly string[],
  _matches: (configPath: string, path: string) => boolean,
): EmitMap {
  return {
    outputToSource: () => undefined,
    sourceToOutputs: () => [],
    isOutput: () => false,
    outputsOf: () => [],
    diagnostics: [],
  };
}
