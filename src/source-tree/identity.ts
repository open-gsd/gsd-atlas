/**
 * Which root commit names a repository (WR-06). `git rev-list --max-parents=0 HEAD` prints every root commit
 * reachable from HEAD in an order that follows commit dates and graph walk details, not anything stable, so the
 * first line is not an identity. The smallest valid object id is: the same set of roots always gives the same one.
 *
 * Limits, recorded and not hidden: the answer still changes when the SET of roots reachable from HEAD changes (an
 * unrelated history merged in, a checkout of a branch with other roots, the first commit of an unborn branch).
 * `--all` was rejected because it walks every ref on every request. An id that survives root-set changes would
 * need a pointer persisted inside the store, which is a Phase 4 host-identity question.
 */
import { isObjectId } from './validate.ts';

/**
 * The lexicographically smallest valid object id among the lines of a `rev-list --max-parents=0` output (code-unit
 * order, which for lower-case hex is numeric order), or null when the output holds none. Blank lines, surrounding
 * whitespace (CRLF included) and lines that are not object ids are ignored.
 */
export function pickRootCommit(output: string): string | null {
  let smallest: string | null = null;
  for (const line of output.split('\n')) {
    const id = line.trim();
    if (!isObjectId(id)) continue;
    if (smallest === null || id < smallest) smallest = id;
  }
  return smallest;
}
