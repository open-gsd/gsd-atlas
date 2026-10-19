// Pure helpers for ADR ratification (FND-09). Node built-ins only.
//
// An ADR is ratified by: opening a GitHub issue, renaming draft-<slug>.md to
// <issue#>-<slug>.md, moving Status from Proposed to Accepted, filling the
// Issue line, and rewriting every reference to the old file name. ADR decision
// text is never touched here; only header lines and link targets change.
//
// Numbering happens at the MVP gate (SKL-03): the list of drafts to number is read from the
// `draft-*.md` files present, and the public text of the issue that gives a record its number is built
// from the record's heading and its README row, then checked for local paths, secrets and planning words.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO_URL = 'https://github.com/open-gsd/gsd-atlas';

/**
 * The MVP gate (SKL-03). Draft ADRs are numbered only at the end of Phase 3, in one logged pass, and
 * `adr-ratify` renames a draft only when it is run with `--gate mvp`.
 */
export const MVP_GATE = 'mvp';

// History of the passes that came before the MVP gate. `scripts/adr.test.ts` pins these four lists
// (13 distinct slugs) so the history cannot drift, but no script reads them for gating any more: the
// gate list is read from the draft files present (`mvpGateSlugs`).

/** The eight ADRs ratified in Phase 1 (D-15). History only. */
export const PHASE1_SLUGS: readonly string[] = [
  'product-boundary',
  'trust-boundaries',
  'command-runner',
  'language-modules',
  'fact-model',
  'fact-store-interface',
  'sqlite-store',
  'tenant-composition',
];

/** The four ADRs scheduled for Phase 2 (FND-12, D-18). History only. */
export const PHASE2_SLUGS: readonly string[] = [
  'worktree-lifecycle',
  'query-and-policy',
  'mcp-contract',
  'value-dashboard',
];

/**
 * The ADR scheduled for Phase 3: user-controlled diagnostics (SKL-03; ROADMAP Planning Notes
 * row 3). History only: it is numbered at the MVP gate with the other drafts.
 */
export const PHASE3_SLUGS: readonly string[] = ['user-controlled-diagnostics'];

/**
 * The Phase 1, Phase 2 and Phase 3 sets in order (13 entries). History only; nothing gates on it.
 */
export const RATIFIED_SLUGS: readonly string[] = [...PHASE1_SLUGS, ...PHASE2_SLUGS, ...PHASE3_SLUGS];

export interface BrokenLink {
  /** Path of the file holding the link, relative to the root, forward slashes. */
  file: string;
  /** The link target as written, including any anchor. */
  link: string;
  /** The resolved path that does not exist, relative to the root. */
  target: string;
}

const STATUS_LINE = /^- \*\*Status:\*\*/;
const ISSUE_LINE = /^- \*\*Issue:\*\*/;
const RATIFIED_LINE = /^- \*\*Ratified:\*\*/;

/**
 * Move an ADR header from Proposed to Accepted. Replaces the Status and Issue
 * lines and inserts a Ratified line directly after the Issue line. Every other
 * line is returned byte-identical. Only the header (before the first `## `
 * heading) is considered, so prose that quotes these lines is never rewritten.
 */
export function ratifyText(text: string, issueNumber: number, isoDate: string): string {
  const lines = text.split('\n');
  const headerEnd = lines.findIndex((l) => l.startsWith('## '));
  const limit = headerEnd === -1 ? lines.length : headerEnd;

  let statusAt = -1;
  let issueAt = -1;
  for (let i = 0; i < limit; i++) {
    const line = lines[i] ?? '';
    if (statusAt === -1 && STATUS_LINE.test(line)) statusAt = i;
    if (issueAt === -1 && ISSUE_LINE.test(line)) issueAt = i;
  }
  if (statusAt === -1) throw new Error('ADR header has no "- **Status:**" line');
  if (issueAt === -1) throw new Error('ADR header has no "- **Issue:**" line');

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i < limit && RATIFIED_LINE.test(line)) continue; // replaced below, keeps this idempotent
    if (i === statusAt) {
      out.push('- **Status:** Accepted');
    } else if (i === issueAt) {
      out.push(`- **Issue:** [#${issueNumber}](${REPO_URL}/issues/${issueNumber})`);
      out.push(`- **Ratified:** ${isoDate}`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * Turn `draft-<slug>.md` into `<n>-<slug>.md` and the display text
 * `draft-<slug>` into `<n>-<slug>`, for slugs in the mapping only. A name that
 * merely starts with a mapped slug (`draft-fact-model-extra`) and the generic
 * placeholders (`draft-<slug>`, `draft-*`) are left alone.
 */
export function rewriteReferences(text: string, slugToIssue: Readonly<Record<string, number>>): string {
  let out = text;
  for (const [slug, issue] of Object.entries(slugToIssue)) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![A-Za-z0-9-])draft-${escaped}(?![A-Za-z0-9-])`, 'g');
    out = out.replace(re, `${issue}-${slug}`);
  }
  return out;
}

/**
 * Find the file for `slug` in `adrDir`, whether still a draft or already
 * numbered. Returns the file name (not a path), or null when there is none.
 */
export function findAdrFile(adrDir: string, slug: string): string | null {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(draft|\\d+)-${escaped}\\.md$`);
  for (const name of fs.readdirSync(adrDir).sort()) {
    if (re.test(name)) return name;
  }
  return null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'phases', 'research']);
const ROOT_FILES = [
  'GLOSSARY.md',
  'README.md',
  '.planning/PROJECT.md',
  '.planning/ROADMAP.md',
  '.planning/REQUIREMENTS.md',
];

function walkMarkdown(root: string, relDir: string, out: string[]): void {
  const entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkMarkdown(root, rel, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(rel);
    }
  }
}

/**
 * Markdown files whose relative links and ADR references are kept current:
 * everything under docs/, plus GLOSSARY.md, README.md and the long-lived
 * .planning docs. Dated snapshot records (.planning/phases, .planning/research),
 * node_modules and .claude (generated instructions) are excluded. Scoped files
 * that do not exist are skipped. Paths are relative to `root` with forward slashes.
 */
export function collectLinkFiles(root: string): string[] {
  const out: string[] = [];
  if (fs.existsSync(path.join(root, 'docs'))) walkMarkdown(root, 'docs', out);
  for (const rel of ROOT_FILES) {
    if (fs.existsSync(path.join(root, rel))) out.push(rel);
  }
  return out;
}

function stripCode(text: string): string {
  const withoutFences = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  return withoutFences.replace(/`[^`\n]*`/g, '');
}

const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Resolve every `](relative/path)` target against the file that holds it and
 * report the ones that do not exist. http(s), mailto and other schemes, and
 * anchor-only links, are ignored, as are links inside code spans and fences.
 */
export function checkRelativeLinks(root: string, files: readonly string[]): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const file of files) {
    const abs = path.join(root, file);
    const text = stripCode(fs.readFileSync(abs, 'utf8'));
    for (const m of text.matchAll(LINK)) {
      const link = m[1] ?? '';
      if (link.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(link)) continue;
      const bare = link.split('#')[0]?.split('?')[0] ?? '';
      if (bare === '') continue;
      let decoded = bare;
      try {
        decoded = decodeURIComponent(bare);
      } catch {
        // keep the raw form
      }
      const target = path.resolve(path.dirname(abs), decoded);
      if (!fs.existsSync(target)) {
        broken.push({
          file,
          link,
          target: path.relative(root, target).split(path.sep).join('/'),
        });
      }
    }
  }
  return broken;
}

// ---------------------------------------------------------------------------
// The MVP gate (SKL-03)
// ---------------------------------------------------------------------------

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The MVP gate list: the slug of every `draft-<slug>.md` file in `adrDir`, sorted and unique. It is read
 * from the files present, never from a constant, so it is empty once every record has a number.
 */
export function mvpGateSlugs(adrDir: string): string[] {
  const re = new RegExp(`^draft-(${SLUG})\\.md$`);
  const out = new Set<string>();
  for (const name of fs.readdirSync(adrDir)) {
    const slug = re.exec(name)?.[1];
    if (slug !== undefined) out.add(slug);
  }
  return [...out].sort();
}

/** Every entry of `adrDir` other than README.md whose name is not `<digits>-<slug>.md`, sorted. */
export function unnumberedAdrFiles(adrDir: string): string[] {
  const numbered = new RegExp(`^\\d+-${SLUG}\\.md$`);
  return fs
    .readdirSync(adrDir)
    .filter((name) => name !== 'README.md' && !numbered.test(name))
    .sort();
}

export interface ReadmeRatification {
  readonly slug: string;
  readonly issue: number;
  /** ISO date, YYYY-MM-DD. */
  readonly date: string;
}

const LOG_HEADER = '| Slug | Issue | File | Ratified |';
const SCHEDULE_HEADING = '## Ratification schedule';
const STATUS_CELL = /\|\s*(Proposed|Accepted)\s*\|\s*$/;

/**
 * Update docs/adr/README.md for one ratified record. `text` must already have been through
 * rewriteReferences, so the table row links `<issue>-<slug>.md`. Sets the trailing Status cell of that row
 * to Accepted, appends one row to the Ratification log table, and removes the record's row from the
 * Ratification schedule when that section exists. Idempotent. Throws, naming the missing part, when no
 * table row links the file or the log table header is missing.
 */
export function ratifyReadme(text: string, { slug, issue, date }: ReadmeRatification): string {
  const file = `${issue}-${slug}.md`;
  const lines = text.split('\n');

  const rowAt = lines.findIndex((l) => l.includes(`](${file})`) && STATUS_CELL.test(l));
  if (rowAt === -1) throw new Error(`docs/adr/README.md has no table row that links ${file}`);
  lines[rowAt] = (lines[rowAt] ?? '').replace(/\|\s*Proposed\s*\|\s*$/, '| Accepted |');

  const scheduleAt = lines.indexOf(SCHEDULE_HEADING);
  if (scheduleAt !== -1) {
    let end = lines.findIndex((l, i) => i > scheduleAt && l.startsWith('## '));
    if (end === -1) end = lines.length;
    for (let i = end - 1; i > scheduleAt; i--) {
      if ((lines[i] ?? '').startsWith(`| ${slug} |`)) lines.splice(i, 1);
    }
  }

  const headerAt = lines.findIndex((l) => l.trim() === LOG_HEADER);
  if (headerAt === -1) throw new Error(`docs/adr/README.md has no Ratification log table (${LOG_HEADER})`);
  let next = headerAt + 2; // the separator row follows the header
  while ((lines[next] ?? '').startsWith('|')) next += 1;
  const alreadyLogged = lines.slice(headerAt, next).some((l) => l.startsWith(`| ${slug} |`));
  if (!alreadyLogged) {
    lines.splice(next, 0, `| ${slug} | [#${issue}](${REPO_URL}/issues/${issue}) | [${file}](${file}) | ${date} |`);
  }
  return lines.join('\n');
}

const NON_BREAKING_HYPHEN = /‑/g;

function headingOf(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim().replace(NON_BREAKING_HYPHEN, '-');
  }
  return null;
}

/**
 * The public text of the issue that gives a record its number: the title is the record's heading (with
 * the non-breaking hyphen made ASCII); the body is the title, the Decision cell of the record's row in
 * the README table, and one fixed sentence about the number. Nothing else leaves the machine.
 */
export function issuePayload(adrText: string, readmeText: string, slug: string): { title: string; body: string } {
  const title = headingOf(adrText);
  if (title === null) throw new Error(`the ADR for ${slug} has no "# " heading`);
  const link = new RegExp(`\\]\\((?:draft|\\d+)-${escapeRegExp(slug)}\\.md\\)`);
  const row = readmeText.split('\n').find((l) => link.test(l) && STATUS_CELL.test(l));
  if (row === undefined) throw new Error(`docs/adr/README.md has no table row for ${slug}`);
  const decision = row.split('|').map((c) => c.trim())[2];
  if (decision === undefined || decision === '') throw new Error(`the README row for ${slug} has no Decision cell`);
  const body = [
    title,
    '',
    `Decision summary: ${decision}`,
    '',
    `This issue gives the record its number at the MVP gate. The file is renamed to \`<issue number>-${slug}.md\` in the pull request that links this issue.`,
  ].join('\n');
  return { title, body };
}

/** Who is running: the home directory and the user name that public text must not contain. */
export interface MachineIdentity {
  readonly home?: string;
  readonly user?: string;
}

const GENERIC_USER_NAMES = new Set(['root', 'runner', 'runneradmin', 'admin', 'administrator', 'user', 'ubuntu', 'node']);

/**
 * The home directory and user name of the running machine. A user name that is shorter than three
 * characters or generic (a CI account such as `runner`) is left out, because it would match ordinary words.
 */
export function machineIdentity(): MachineIdentity {
  let user: string | undefined;
  try {
    user = os.userInfo().username;
  } catch {
    user = undefined;
  }
  const out: { home?: string; user?: string } = {};
  const home = os.homedir();
  if (home.length > 1) out.home = home;
  if (user !== undefined && user.length >= 3 && !GENERIC_USER_NAMES.has(user.toLowerCase())) out.user = user;
  return out;
}

const PLANNING_REQUIREMENT_PREFIXES = 'AGT|DSH|EMB|EVL|FND|HRD|HST|IDX|INT|LNG|MET|NET|OKF|QRY|REL|SDK|SEC|SKL|STO|SWF|TSM';

const PUBLIC_TEXT_CHECKS: readonly { label: string; re: RegExp; echo: boolean }[] = [
  { label: 'absolute path', re: /(?<![\w.~/-])\/(?:Users|home|private|var|tmp|etc|opt|mnt)\/[^\s)"'`]*/g, echo: true },
  { label: 'absolute path', re: /(?<![A-Za-z0-9])[A-Za-z]:\\[^\s]*/g, echo: true },
  { label: 'agent folder', re: /(?<![\w-])\.claude(?![\w-])/g, echo: true },
  { label: 'token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, echo: false },
  { label: 'token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, echo: false },
  { label: 'token', re: /\bsk-[A-Za-z0-9_-]{20,}/g, echo: false },
  { label: 'token', re: /\bAKIA[0-9A-Z]{16}\b/g, echo: false },
  { label: 'token', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, echo: false },
  { label: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, echo: true },
  { label: 'planning vocabulary', re: /\bphase \d+\b/gi, echo: true },
  { label: 'planning vocabulary', re: /\bplan \d{2}-\d{2}\b/gi, echo: true },
  { label: 'planning vocabulary', re: /\bD-\d{2}\b/g, echo: true },
  { label: 'planning vocabulary', re: new RegExp(`\\b(?:${PLANNING_REQUIREMENT_PREFIXES})-\\d{2}\\b`, 'g'), echo: true },
];

/**
 * Problems that make `text` unfit to publish (an issue, a comment or a pull request): an absolute path, an
 * agent folder, a token-like string (never echoed), an email address, planning vocabulary and, when `who`
 * is given, the running machine's home directory or user name. Each problem starts with its label.
 * Clean text returns an empty list.
 */
export function publicTextProblems(text: string, who?: MachineIdentity): string[] {
  const problems: string[] = [];
  for (const { label, re, echo } of PUBLIC_TEXT_CHECKS) {
    for (const m of text.matchAll(re)) {
      problems.push(echo ? `${label}: ${m[0].slice(0, 80)}` : `${label}: a ${m[0].slice(0, 4)}... string`);
    }
  }
  const lower = text.toLowerCase();
  if (who?.home !== undefined && who.home.length > 1 && lower.includes(who.home.toLowerCase())) {
    problems.push('home directory: the home directory of the running machine');
  }
  if (who?.user !== undefined && who.user.length > 0) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(who.user)}(?![A-Za-z0-9])`, 'i');
    if (re.test(text)) problems.push('user name: the user name of the running machine');
  }
  return problems;
}

const HEADER_LINE = /^- \*\*(Status|Issue|Ratified):\*\*/;

function headerLines(lines: readonly string[]): Set<string> {
  const end = lines.findIndex((l) => l.startsWith('## '));
  return new Set(lines.slice(0, end === -1 ? lines.length : end));
}

function lineCounts(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  return counts;
}

/**
 * The append-only check for one ADR file that a ratification changed. Every line that was removed must be a
 * header Status or Issue line, or a line whose only change is the new file name (the line, run through
 * rewriteReferences, is among the lines added); every line added must be a header Status, Issue or Ratified
 * line, or the rewritten counterpart of a removed line. A changed decision sentence is reported, even when it
 * also carries a link to the renamed file. Returns the violations, empty when the change is allowed.
 */
export function appendOnlyViolations(before: string, after: string, slug: string, issue: number): string[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const beforeCounts = lineCounts(beforeLines);
  const afterCounts = lineCounts(afterLines);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [l, n] of beforeCounts) {
    const delta = n - (afterCounts.get(l) ?? 0);
    for (let i = 0; i < delta; i++) removed.push(l);
  }
  for (const [l, n] of afterCounts) {
    const delta = n - (beforeCounts.get(l) ?? 0);
    for (let i = 0; i < delta; i++) added.push(l);
  }

  const beforeHeader = headerLines(beforeLines);
  const afterHeader = headerLines(afterLines);
  const mapping = { [slug]: issue };
  const problems: string[] = [];
  const unmatched = [...added];
  for (const l of removed) {
    if (/^- \*\*(Status|Issue):\*\*/.test(l) && beforeHeader.has(l)) continue;
    const rewritten = rewriteReferences(l, mapping);
    const at = rewritten === l ? -1 : unmatched.indexOf(rewritten);
    if (at === -1) {
      problems.push(`removed line: ${l}`);
    } else {
      unmatched.splice(at, 1);
    }
  }
  for (const l of unmatched) {
    if (HEADER_LINE.test(l) && afterHeader.has(l)) continue;
    problems.push(`added line: ${l}`);
  }
  return problems;
}

export interface AdrIssueRef {
  /** File name in the ADR folder. */
  readonly file: string;
  /** The number in the file name. */
  readonly number: number;
  readonly slug: string;
  /** The first `# ` heading, with the non-breaking hyphen made ASCII. */
  readonly title: string;
  /** The issue number named by the record's `- **Issue:**` header line. */
  readonly issue: number;
}

/**
 * The issue each numbered record names, sorted by number. Throws, naming the file, when the Issue line is
 * missing, names no issue number, or names a number other than the file's own. Drafts and README.md are not
 * listed.
 */
export function adrIssueRefs(adrDir: string): AdrIssueRef[] {
  const re = new RegExp(`^(\\d+)-(${SLUG})\\.md$`);
  const refs: AdrIssueRef[] = [];
  for (const name of fs.readdirSync(adrDir)) {
    const m = re.exec(name);
    if (m === null) continue;
    const number = Number(m[1]);
    const slug = m[2] ?? '';
    const text = fs.readFileSync(path.join(adrDir, name), 'utf8');
    const lines = text.split('\n');
    const end = lines.findIndex((l) => l.startsWith('## '));
    const issueLine = lines.slice(0, end === -1 ? lines.length : end).find((l) => ISSUE_LINE.test(l));
    if (issueLine === undefined) throw new Error(`${name}: the header has no "- **Issue:**" line`);
    const named = /#(\d+)/.exec(issueLine)?.[1];
    if (named === undefined) throw new Error(`${name}: the Issue line names no issue number`);
    if (Number(named) !== number) throw new Error(`${name}: the Issue line names #${named} but the file number is ${number}`);
    const title = headingOf(text);
    if (title === null) throw new Error(`${name}: the record has no "# " heading`);
    refs.push({ file: name, number, slug, title, issue: Number(named) });
  }
  return refs.sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));
}

/**
 * Is a GitHub issue the record's own? True only when the title starts with `ADR:` and the body names the
 * record's file (`draft-<slug>.md`, or `<digits>-<slug>.md`), the slug matched as a whole. Real titles are not
 * compared to the ADR heading, because several earlier titles are worded differently.
 */
export function issueIsAdrsOwn(issue: { title: string; body: string }, slug: string): { own: boolean; reason: string } {
  if (!issue.title.trimStart().startsWith('ADR:')) return { own: false, reason: 'the title does not start with "ADR:"' };
  if ((issue.body ?? '').trim() === '') return { own: false, reason: 'the body is empty' };
  const file = new RegExp(`(?<![A-Za-z0-9-])(?:draft|\\d+)-${escapeRegExp(slug)}\\.md(?![A-Za-z0-9-])`);
  if (!file.test(issue.body)) {
    return { own: false, reason: `the body does not name draft-${slug}.md or <number>-${slug}.md` };
  }
  return { own: true, reason: `the title starts with "ADR:" and the body names the file of ${slug}` };
}
