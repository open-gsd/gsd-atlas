/**
 * Which git filter driver names the environment config channel can carry byte for byte (CR-01, T-01-50).
 *
 * `gitSpec` neutralises a repository's filter drivers through `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
 * environment variables. A git filter driver name is bytes; this code models it as a JavaScript string. The
 * two agree only when the name survives a UTF-8 round trip, because Node encodes an environment string as
 * UTF-8 and git compares the key by bytes. A name that does not survive (bytes that are not valid UTF-8, a
 * U+FFFD that stands for a decoder substitution, an unpaired surrogate) would be neutralised under a
 * different name than the one the repository configured, so its `clean` command would still run. Such a
 * name cannot be expressed on the channel at all, so the only safe response is to refuse the snapshot.
 *
 * The rule, in one place so the builder (`git-spec.ts`) and the permission gate (`decide.ts`) cannot disagree:
 *   - NUL, LF and CR are refused. NUL cannot be in an environment string, LF ends a line of git's config
 *     listing, and CR is refused because the gate has always denied it and a CR-named driver cannot be
 *     referenced from `.gitattributes` anyway (an attribute value ends at whitespace);
 *   - U+FFFD and any unpaired surrogate are refused, because they cannot be told apart from decoder
 *     substitution after a lossy decode;
 *   - a name longer than {@link MAX_FILTER_NAME_LENGTH} UTF-16 code units is refused. The cap is the
 *     cross-platform minimum-safe bound (Windows allows 32767 characters for the whole environment block,
 *     Linux 131072 bytes for one string), so one rule behaves identically on all three CI operating systems.
 * Everything else is carried verbatim: the empty name, `=`, `.`, tabs, leading and trailing spaces,
 * non-ASCII letters and well-formed surrogate pairs.
 *
 * This module is a leaf: it imports nothing, and it is internal to `src/command-runner` (not in the index).
 * Reasons never echo the name, because a driver name is repo-controlled text that may reach an agent (T-01-53).
 */

/** The longest driver name, in UTF-16 code units, that the environment channel is asked to carry. */
export const MAX_FILTER_NAME_LENGTH = 1024;

// Over code units (no `u` flag): a high surrogate not followed by a low one, or a low one not preceded by a high one.
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why the environment channel cannot carry `name` byte for byte, or `null` when it can. The reason is a
 * short fixed sentence fragment (completing "whose name ..."); it never contains the name.
 */
export function filterNameProblem(name: string): string | null {
  if (name.length > MAX_FILTER_NAME_LENGTH) return `is longer than ${String(MAX_FILTER_NAME_LENGTH)} UTF-16 code units`;
  if (name.includes('\0') || name.includes('\n') || name.includes('\r')) return 'contains a NUL, a line feed or a carriage return';
  if (name.includes('�') || UNPAIRED_SURROGATE.test(name)) {
    return 'is not well-formed Unicode text (it contains U+FFFD or an unpaired surrogate), so the environment channel cannot carry it byte for byte';
  }
  return null;
}

/** True when {@link filterNameProblem} finds nothing wrong with `name`. */
export function isNeutralisableFilterName(name: string): boolean {
  return filterNameProblem(name) === null;
}
