// Number and ratify draft ADRs at the MVP gate (FND-09, SKL-03).
//
//   node scripts/adr-ratify.ts --gate mvp --slug <slug> --issue <n> [--date YYYY-MM-DD] [--dry-run]
//   node scripts/adr-ratify.ts --list-gate
//   node scripts/adr-ratify.ts --print-issue --slug <slug>
//   node scripts/adr-ratify.ts --list-issues [--numbers]
//   node scripts/adr-ratify.ts --check-issue --slug <slug>      (reads {"title","body"} JSON on standard input)
//
// A rename needs `--gate mvp`: draft records are numbered only at the end of Phase 3, in one logged pass.
// It renames docs/adr/draft-<slug>.md to docs/adr/<n>-<slug>.md with `git mv`, moves the header from
// Proposed to Accepted, rewrites every reference to the old name in the markdown files returned by
// collectLinkFiles, and updates docs/adr/README.md (table row, Ratification log, Ratification schedule).
// Every ADR file it changes must pass appendOnlyViolations before anything is written. The other modes only
// read: they print the gate list, the public text of the issue that gives a draft its number, the issue
// each numbered record names, or whether a GitHub issue is a record's own; none contacts a network service.
// This script lives outside the src boundary lint, so node:child_process is allowed; it passes an argument
// array and never uses a shell.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  MVP_GATE,
  adrIssueRefs,
  appendOnlyViolations,
  collectLinkFiles,
  findAdrFile,
  issueIsAdrsOwn,
  issuePayload,
  machineIdentity,
  mvpGateSlugs,
  publicTextProblems,
  ratifyReadme,
  ratifyText,
  rewriteReferences,
} from './adr.ts';

function localIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(message: string): never {
  process.stderr.write(`adr-ratify: ${message}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    issue: { type: 'string' },
    date: { type: 'string' },
    gate: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'list-gate': { type: 'boolean', default: false },
    'print-issue': { type: 'boolean', default: false },
    'list-issues': { type: 'boolean', default: false },
    'check-issue': { type: 'boolean', default: false },
    numbers: { type: 'boolean', default: false },
  },
  strict: true,
});

const root = path.resolve(import.meta.dirname, '..');
const adrDir = path.join(root, 'docs', 'adr');

const modes = (['list-gate', 'print-issue', 'list-issues', 'check-issue'] as const).filter((m) => values[m] === true);
if (modes.length > 1) fail(`choose one of --${modes.join(', --')}`);
if (values.numbers === true && values['list-issues'] !== true) fail('--numbers goes with --list-issues');

function requireSlug(): string {
  if (values.slug === undefined || values.slug === '') fail('--slug is required');
  return values.slug;
}

function ensureRecordFile(slug: string): string {
  const found = findAdrFile(adrDir, slug);
  if (found === null) fail(`no ADR file for ${slug}`);
  return found;
}

if (values['list-gate'] === true) {
  for (const slug of mvpGateSlugs(adrDir)) process.stdout.write(`${slug}\n`);
  process.exit(0);
}

if (values['list-issues'] === true) {
  try {
    const refs = adrIssueRefs(adrDir);
    if (values.numbers === true) {
      for (const ref of refs) process.stdout.write(`${ref.issue}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(refs, null, 2)}\n`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}

if (values['print-issue'] === true) {
  const slug = requireSlug();
  const file = ensureRecordFile(slug);
  if (file !== `draft-${slug}.md`) fail(`${file} is not a draft; its number was already given`);
  let payload: { title: string; body: string };
  try {
    payload = issuePayload(
      fs.readFileSync(path.join(adrDir, file), 'utf8'),
      fs.readFileSync(path.join(adrDir, 'README.md'), 'utf8'),
      slug,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const problems = publicTextProblems(`${payload.title}\n${payload.body}`, machineIdentity());
  if (problems.length > 0) fail(`the issue text for ${slug} is not fit to publish:\n  ${problems.join('\n  ')}`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(0);
}

if (values['check-issue'] === true) {
  const slug = requireSlug();
  ensureRecordFile(slug);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    fail('standard input is not JSON');
  }
  const candidate = parsed as { title?: unknown; body?: unknown } | null;
  if (candidate === null || typeof candidate !== 'object' || typeof candidate.title !== 'string') {
    fail('standard input must be a JSON object with a string "title" and a "body"');
  }
  const body = typeof candidate.body === 'string' ? candidate.body : '';
  const verdict = issueIsAdrsOwn({ title: candidate.title, body }, slug);
  if (verdict.own) {
    process.stdout.write('own\n');
    process.exit(0);
  }
  process.stdout.write(`not own: ${verdict.reason}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Rename one draft (needs --gate mvp)
// ---------------------------------------------------------------------------

const slug = requireSlug();
if (!values.issue || !/^[1-9][0-9]*$/.test(values.issue)) fail('--issue must be a positive integer');
const issue = Number(values.issue);
const date = values.date ?? localIsoDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date must be YYYY-MM-DD');
const dryRun = values['dry-run'] === true;

const draftName = `draft-${slug}.md`;
const finalName = `${issue}-${slug}.md`;

// The file checks come first so that a numbered record is always refused with the same message; the gate
// check follows and applies to every slug that is still a draft.
const found = findAdrFile(adrDir, slug);
if (found !== draftName) {
  fail(found === null ? `no ADR file for ${slug}` : `${found} is not a draft; refusing to ratify twice`);
}
if (values.gate !== MVP_GATE) {
  fail(`draft records are numbered only at the MVP gate: run with --gate ${MVP_GATE} (changes no file)`);
}
if (fs.existsSync(path.join(adrDir, finalName))) fail(`${finalName} already exists`);

const mapping = { [slug]: issue };
const draftRel = `docs/adr/${draftName}`;
const finalRel = `docs/adr/${finalName}`;
const readmeRel = 'docs/adr/README.md';

interface Edit {
  /** Path to report, relative to the root. */
  readonly rel: string;
  /** Path to write to (the final name for the renamed record). */
  readonly writeRel: string;
  readonly before: string;
  readonly after: string;
}

// Compute every change in memory first, check it, and only then touch the tree.
const edits: Edit[] = [];
const violations: string[] = [];
for (const rel of collectLinkFiles(root)) {
  const abs = path.join(root, rel);
  const before = fs.readFileSync(abs, 'utf8');
  let after = rewriteReferences(before, mapping);
  if (rel === draftRel) after = ratifyText(after, issue, date);
  if (rel === readmeRel) {
    try {
      after = ratifyReadme(after, { slug, issue, date });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (after === before) continue;
  edits.push({ rel, writeRel: rel === draftRel ? finalRel : rel, before, after });
  if (rel.startsWith('docs/adr/') && rel !== readmeRel) {
    for (const problem of appendOnlyViolations(before, after, slug, issue)) violations.push(`${rel}: ${problem}`);
  }
}
if (violations.length > 0) {
  fail(`the append-only check failed; nothing was changed:\n  ${violations.join('\n  ')}`);
}

const changed: string[] = [];
if (dryRun) {
  process.stdout.write(`would rename ${draftRel} -> ${finalRel}\n`);
} else {
  execFileSync('git', ['mv', draftRel, finalRel], { cwd: root, stdio: 'inherit' });
  changed.push(`${draftRel} -> ${finalRel}`);
}

for (const edit of edits) {
  if (!dryRun) fs.writeFileSync(path.join(root, edit.writeRel), edit.after);
  changed.push(dryRun ? edit.rel : edit.writeRel);
  if (dryRun && edit.rel === draftRel) {
    // Show the header lines ratifyText would set; the diff is the only difference it makes.
    const beforeLines = new Set(edit.before.split('\n'));
    for (const line of edit.after.split('\n')) {
      if (!beforeLines.has(line) && line.startsWith('- **')) process.stdout.write(`would set: ${line}\n`);
    }
  }
}

for (const rel of changed) process.stdout.write(`${dryRun ? 'would change' : 'changed'}: ${rel}\n`);
