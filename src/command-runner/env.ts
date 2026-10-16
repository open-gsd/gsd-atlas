/**
 * Child environment policy (T-01-23): inherit the parent environment, remove a denylist, then
 * overlay the spec's own variables.
 *
 * Inherit-then-remove rather than build-from-scratch because a Windows child needs `SystemRoot`,
 * `PATH` and `TEMP` to start at all. The overlay is applied last, so a spec that sets (for example)
 * `GIT_CONFIG_GLOBAL` or `GIT_OPTIONAL_LOCKS` deliberately keeps it.
 */

/** Names that redirect git away from the repository the host believes it is reading. */
const REDIRECTING: ReadonlySet<string> = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_COMMON_DIR',
]);

const SECRET_LOOKING = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i;

/** True when an inherited variable must not reach a child. Windows names are case-insensitive, so compare upper-cased. */
export function isDenied(name: string): boolean {
  return REDIRECTING.has(name.toUpperCase()) || SECRET_LOOKING.test(name);
}

export function scrubEnv(
  parent: Readonly<Record<string, string | undefined>>,
  overlay?: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || isDenied(name)) continue;
    out[name] = value;
  }
  if (overlay !== undefined) {
    for (const [name, value] of Object.entries(overlay)) out[name] = value;
  }
  return out;
}
