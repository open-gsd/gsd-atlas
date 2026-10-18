/**
 * Child environment policy (T-01-23): inherit the parent environment, remove a denylist, then
 * overlay the spec's own variables.
 *
 * Inherit-then-remove rather than build-from-scratch because a Windows child needs `SystemRoot`,
 * `PATH` and `TEMP` to start at all. The overlay is applied last, so a spec that sets (for example)
 * `GIT_CONFIG_GLOBAL` or `GIT_OPTIONAL_LOCKS` deliberately keeps it.
 *
 * Known limit (IN-05, plan 02-33): this is a denylist of name patterns. A user-allowed executable still
 * inherits any variable the patterns do not name, including a credential with an unusual name. The switch to
 * an inherited-environment allowlist is deferred: the right allowlist depends on executables users may allow
 * later (the Phase 3 compiler, the Phase 6 SDK providers) and on Windows variables that cannot be verified
 * without CI. Home: ROADMAP.md Phase 4, success criterion 8. `GIT_AUTHOR_*` and `GIT_COMMITTER_*` are never
 * removed.
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

const SECRET_LOOKING = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|_AUTH$/i;

/** Credential-bearing names whose text carries no secret-looking word: the ssh agent socket and database URLs. */
const SECRET_EXACT: ReadonlySet<string> = new Set(['SSH_AUTH_SOCK', 'DATABASE_URL']);

/** True when an inherited variable must not reach a child. Windows names are case-insensitive, so compare upper-cased. */
export function isDenied(name: string): boolean {
  const upper = name.toUpperCase();
  return REDIRECTING.has(upper) || SECRET_EXACT.has(upper) || SECRET_LOOKING.test(name);
}

/**
 * The only inherited names a shape-matched built-in (the compiler worker, plan 03-19) receives: where the user's home and
 * temporary directories are, the locale and time zone, and the two Windows variables a Node child needs to start at all.
 * Deliberately absent: `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*` and every other name that can change what
 * code the child loads (T-03-192). Compared upper-cased, as Windows names are case-insensitive.
 */
const MINIMAL_INHERITED: ReadonlySet<string> = new Set([
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SYSTEMROOT',
  'WINDIR',
]);

/**
 * The environment of a shape-matched built-in: only {@link MINIMAL_INHERITED} names from the parent, then the spec's own
 * variables (which `decide` already restricted to the keys and value patterns of the shape).
 */
export function minimalEnv(
  parent: Readonly<Record<string, string | undefined>>,
  overlay?: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || !MINIMAL_INHERITED.has(name.toUpperCase())) continue;
    out[name] = value;
  }
  if (overlay !== undefined) {
    for (const [name, value] of Object.entries(overlay)) out[name] = value;
  }
  return out;
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
