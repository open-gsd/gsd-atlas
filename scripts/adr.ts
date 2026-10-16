// Pure helpers for ADR ratification (FND-09). Node built-ins only.
//
// An ADR is ratified by: opening a GitHub issue, renaming draft-<slug>.md to
// <issue#>-<slug>.md, moving Status from Proposed to Accepted, filling the
// Issue line, and rewriting every reference to the old file name. ADR decision
// text is never touched here; only header lines and link targets change.

import fs from 'node:fs';
import path from 'node:path';

export const REPO_URL = 'https://github.com/open-gsd/gsd-atlas';

/** The eight ADRs ratified in Phase 1 (D-15). */
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

/** The four ADRs scheduled for Phase 2 (FND-12, D-18). */
export const PHASE2_SLUGS: readonly string[] = [
  'worktree-lifecycle',
  'query-and-policy',
  'mcp-contract',
  'value-dashboard',
];

/** Every ADR that adr-ratify may ratify: the Phase 1 set followed by the Phase 2 set (FND-12, D-18). */
export const RATIFIED_SLUGS: readonly string[] = [...PHASE1_SLUGS, ...PHASE2_SLUGS];

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
