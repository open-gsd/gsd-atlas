// Ratify one ADR after its GitHub issue exists (FND-09).
//
//   node scripts/adr-ratify.ts --slug <slug> --issue <n> [--date YYYY-MM-DD] [--dry-run]
//
// Renames docs/adr/draft-<slug>.md to docs/adr/<n>-<slug>.md with `git mv`,
// moves the header from Proposed to Accepted, and rewrites every reference to
// the old name in the markdown files returned by collectLinkFiles. This script
// lives outside the src boundary lint, so node:child_process is allowed; it
// passes an argument array and never uses a shell.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { PHASE1_SLUGS, collectLinkFiles, findAdrFile, ratifyText, rewriteReferences } from './adr.ts';

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
    'dry-run': { type: 'boolean', default: false },
  },
  strict: true,
});

const slug = values.slug;
if (!slug || !PHASE1_SLUGS.includes(slug)) {
  fail(`--slug must be one of: ${PHASE1_SLUGS.join(', ')}`);
}
if (!values.issue || !/^[1-9][0-9]*$/.test(values.issue)) fail('--issue must be a positive integer');
const issue = Number(values.issue);
const date = values.date ?? localIsoDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('--date must be YYYY-MM-DD');
const dryRun = values['dry-run'] === true;

const root = path.resolve(import.meta.dirname, '..');
const adrDir = path.join(root, 'docs', 'adr');
const draftName = `draft-${slug}.md`;
const finalName = `${issue}-${slug}.md`;

const found = findAdrFile(adrDir, slug);
if (found !== draftName) {
  fail(found === null ? `no ADR file for ${slug}` : `${found} is not a draft; refusing to ratify twice`);
}
if (fs.existsSync(path.join(adrDir, finalName))) fail(`${finalName} already exists`);

const changed: string[] = [];

if (dryRun) {
  process.stdout.write(`would rename docs/adr/${draftName} -> docs/adr/${finalName}\n`);
} else {
  execFileSync('git', ['mv', `docs/adr/${draftName}`, `docs/adr/${finalName}`], { cwd: root, stdio: 'inherit' });
  changed.push(`docs/adr/${draftName} -> docs/adr/${finalName}`);
}

const mapping = { [slug]: issue };
const renamedRel = `docs/adr/${finalName}`;

for (const rel of collectLinkFiles(root)) {
  // In a dry run the file has not been renamed yet, so read it from its draft path.
  const readRel = dryRun && rel === renamedRel ? `docs/adr/${draftName}` : rel;
  const abs = path.join(root, readRel);
  if (!fs.existsSync(abs)) continue;
  const before = fs.readFileSync(abs, 'utf8');
  let after = rewriteReferences(before, mapping);
  if (readRel === (dryRun ? `docs/adr/${draftName}` : renamedRel)) {
    after = ratifyText(after, issue, date);
  }
  if (after !== before) {
    if (!dryRun) fs.writeFileSync(abs, after);
    changed.push(rel);
  }
}

for (const rel of changed) process.stdout.write(`${dryRun ? 'would change' : 'changed'}: ${rel}\n`);
