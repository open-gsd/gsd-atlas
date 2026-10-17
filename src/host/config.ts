import type { Diagnostic } from '../facts/index.ts';
import type { UserConfig } from './types.ts';

/** What {@link loadUserConfig} found: the settings, and one warning for each thing it refused. */
export interface LoadedUserConfig {
  readonly config: UserConfig;
  readonly diagnostics: readonly Diagnostic[];
}

/** RED-phase stand-in: every user is taken to have no configuration. */
export function loadUserConfig(_userDir: string, _env: Readonly<Record<string, string | undefined>>): LoadedUserConfig {
  return { config: {}, diagnostics: [] };
}
