/**
 * The fake Source Tree's small rule set (quick task 261021-re7, DD-6): how the fake decides which files the built-in
 * defaults and a `.atlasignore` leave out. Production code never uses it: the real tree lets git evaluate full gitignore
 * syntax. The subset is exactly what the shared contract and the default list use, so the two implementations can be
 * compared on one data description; any other syntax is refused with `invalid_argument` when the fake's world is built,
 * never half-evaluated.
 *
 * Supported lines: blank and `#` comment lines (a trailing carriage return and a leading byte order mark are tolerated),
 * an optional `!` (negation), an optional leading `/` (anchored), then `/`-separated segments, each a literal name or
 * `*` followed by a literal suffix (`*.snap`, `*.min.js`), and an optional trailing `/` (directories only). A pattern
 * with a `/` before its last character is anchored at the directory of the file that holds it; one without matches a
 * name at any depth below that directory. The last matching rule wins, a deeper file overrides an outer one, and a
 * directory that is excluded excludes everything below it whatever a later negation of a file says.
 */
import { INDEX_DEFAULT_EXCLUDES } from './default-excludes.ts';
import { SourceTreeError } from './types.ts';

interface Segment {
  /** The whole name, when the segment has no wildcard. */
  readonly literal?: string;
  /** The literal tail after the one leading `*`. */
  readonly suffix?: string;
}

export interface Rule {
  readonly negate: boolean;
  readonly dirOnly: boolean;
  readonly anchored: boolean;
  readonly segments: readonly Segment[];
}

/** The rules of one ignore file and the directory it sits in (`''` for the root). */
export interface RuleFile {
  readonly base: string;
  readonly rules: readonly Rule[];
}

const unsupported = (line: string): SourceTreeError =>
  new SourceTreeError('invalid_argument', `the fake Source Tree does not evaluate this ignore rule: ${JSON.stringify(line)}`);

function parseSegment(part: string, line: string): Segment {
  if (part === '.' || part === '..' || part !== part.trim() || /[\\?[\]]/.test(part)) throw unsupported(line);
  if (!part.includes('*')) return { literal: part };
  // `*` must be the first character, once, with a literal tail: `*.ext`, `*.min.js`, `*.egg-info`.
  if (!part.startsWith('*') || part.length === 1 || part.indexOf('*', 1) !== -1) throw unsupported(line);
  return { suffix: part.slice(1) };
}

/** One non-blank, non-comment pattern line. Throws `invalid_argument` for anything outside the subset. */
function parsePattern(line: string): Rule {
  let body = line;
  let negate = false;
  if (body.startsWith('!')) {
    negate = true;
    body = body.slice(1);
  }
  let dirOnly = false;
  if (body.endsWith('/')) {
    dirOnly = true;
    body = body.slice(0, -1);
  }
  let anchored = false;
  if (body.startsWith('/')) {
    anchored = true;
    body = body.slice(1);
  }
  if (body === '') throw unsupported(line);
  const parts = body.split('/');
  if (parts.some((part) => part === '')) throw unsupported(line);
  if (parts.length > 1) anchored = true;
  return { negate, dirOnly, anchored, segments: parts.map((part) => parseSegment(part, line)) };
}

/** True when the fake can evaluate the pattern line as it stands (a comment or a blank line is supported). */
export function isSupportedPattern(line: string): boolean {
  if (line === '' || line.startsWith('#')) return true;
  try {
    parsePattern(line);
    return true;
  } catch {
    return false;
  }
}

/** Parses the text of the ignore file that sits in directory `base`. Throws `invalid_argument` for unsupported syntax. */
export function parseRuleFile(text: string, base: string): RuleFile {
  const rules: Rule[] = [];
  const lines = text.replace(/^﻿/, '').split('\n');
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '' || line.startsWith('#')) continue;
    rules.push(parsePattern(line));
  }
  return { base, rules };
}

const matchesSegment = (segment: Segment, name: string): boolean =>
  segment.literal !== undefined ? name === segment.literal : name.endsWith(segment.suffix as string);

/** Does `rule` match the path whose components (relative to the rule file's directory) are `parts`, as a directory or a file? */
function matches(rule: Rule, parts: readonly string[], isDirectory: boolean): boolean {
  if (rule.dirOnly && !isDirectory) return false;
  const [only] = rule.segments;
  if (!rule.anchored) return only !== undefined && matchesSegment(only, parts[parts.length - 1] as string);
  return rule.segments.length === parts.length && rule.segments.every((segment, i) => matchesSegment(segment, parts[i] as string));
}

const depthOf = (base: string): number => (base === '' ? 0 : base.split('/').length);

/**
 * True when `rel` (a file, repo-relative POSIX) is excluded by the ignore files: each leading directory is judged first
 * (an excluded directory excludes everything below it), then the file. A file applies only below its own directory,
 * outer files before deeper ones, and the last matching rule of all decides each component.
 */
export function ignoredByRuleFiles(files: readonly RuleFile[], rel: string): boolean {
  const ordered = [...files].sort((a, b) => depthOf(a.base) - depthOf(b.base));
  const components = rel.split('/');
  for (let length = 1; length <= components.length; length += 1) {
    const prefix = components.slice(0, length).join('/');
    const isDirectory = length < components.length;
    let verdict: boolean | undefined;
    for (const file of ordered) {
      if (file.base !== '' && !prefix.startsWith(`${file.base}/`)) continue;
      const parts = (file.base === '' ? prefix : prefix.slice(file.base.length + 1)).split('/');
      for (const rule of file.rules) if (matches(rule, parts, isDirectory)) verdict = !rule.negate;
    }
    if (verdict === true) return true;
  }
  return false;
}

const DEFAULT_RULES: ReadonlyArray<{ readonly rule: Rule; readonly appliesToTracked: boolean }> = INDEX_DEFAULT_EXCLUDES.map((entry) => ({
  rule: parsePattern(entry.pattern),
  appliesToTracked: entry.appliesToTracked,
}));

/**
 * True when a built-in default excludes `rel`: any default (`all`) or only the ones that also remove tracked files
 * (`tracked`). Defaults are never negated, so a path matching one at any leading directory or at the file is excluded.
 */
export function defaultsExclude(rel: string, scope: 'all' | 'tracked'): boolean {
  const components = rel.split('/');
  for (let length = 1; length <= components.length; length += 1) {
    const parts = components.slice(0, length);
    const isDirectory = length < components.length;
    for (const { rule, appliesToTracked } of DEFAULT_RULES) {
      if ((scope === 'all' || appliesToTracked) && matches(rule, parts, isDirectory)) return true;
    }
  }
  return false;
}
