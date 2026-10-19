import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  PHASE1_SLUGS,
  PHASE2_SLUGS,
  PHASE3_SLUGS,
  RATIFIED_SLUGS,
  MVP_GATE,
  adrIssueRefs,
  appendOnlyViolations,
  checkRelativeLinks,
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
  unnumberedAdrFiles,
} from './adr.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');
const REPO_URL = 'https://github.com/open-gsd/gsd-atlas';

// The ratified set: the eight Phase 1 ADRs (plan 01-02) plus those of the four Phase 2 ADRs
// that plan 02-01 has ratified so far (FND-12, D-18).
const RATIFIED: readonly string[] = [
  'product-boundary',
  'trust-boundaries',
  'command-runner',
  'language-modules',
  'fact-model',
  'fact-store-interface',
  'sqlite-store',
  'tenant-composition',
  'worktree-lifecycle',
  'query-and-policy',
  'mcp-contract',
  'value-dashboard',
];

function tmpTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-test-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// The records that were still drafts when the MVP gate pass was planned. Their state in the real tree depends on
// whether the pass has run, so tests that need the pre-pass state rebuild it on a temporary copy.
const KNOWN_AT_GATE: readonly string[] = ['host-process-model', 'user-controlled-diagnostics'];

const SCHEDULE_PHASE: Readonly<Record<string, string>> = {
  'user-controlled-diagnostics': 'Phase 3',
  'host-process-model': 'Phase 4',
};

function copyScripts(dir: string): void {
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const name of ['adr.ts', 'adr-ratify.ts']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(dir, 'scripts', name));
  }
}

function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    out[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return out;
}

function runRatify(dir: string, args: readonly string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [path.join(dir, 'scripts', 'adr-ratify.ts'), ...args], {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

const FIXTURE_README = [
  '# Fixture ADRs',
  '',
  '## Pre-MVP set',
  '| ADR | Decision | DESIGN.md | Status |',
  '|-----|----------|-----------|--------|',
  '| [2-alpha](2-alpha.md) | Alpha is settled | A1 | Accepted |',
  '| [draft-beta](draft-beta.md) | Beta decides; things stay small | A2 | Proposed |',
  '| [draft-gamma-ray](draft-gamma-ray.md) | Gamma ray decision | A3 | Proposed |',
  '',
  '## Ratification log',
  'Introduction sentence.',
  '',
  '| Slug | Issue | File | Ratified |',
  '|------|-------|------|----------|',
  `| alpha | [#2](${REPO_URL}/issues/2) | [2-alpha.md](2-alpha.md) | 2026-10-15 |`,
  '',
  'Second paragraph that follows the table.',
  '',
  '## Ratification schedule',
  'The records that remain Proposed.',
  '',
  '| ADR | Ratify before | Amendments applied at that ratification |',
  '|-----|---------------|------------------------------------------|',
  '| gamma-ray | Phase 3 | None |',
  '| beta | Phase 4 | None |',
  '',
  '## Before M4',
  'Nothing.',
  '',
].join('\n');

function fixtureDraft(slug: string, title: string, extraHeader: readonly string[] = []): string {
  return [
    `# ${title}`,
    '',
    '- **Status:** Proposed',
    `- **Issue:** to be opened (rename to \`<issue#>-${slug}.md\`)`,
    ...extraHeader,
    '- **DESIGN.md:** A2',
    '',
    '## Context',
    `Context of ${slug}. See [alpha](2-alpha.md).`,
    '',
    '## Decision',
    `1. ${slug} decides. The file is draft-${slug}.md until it is numbered.`,
    '',
  ].join('\n');
}

const FIXTURE_ALPHA = [
  '# ADR: Alpha',
  '',
  '- **Status:** Accepted',
  `- **Issue:** [#2](${REPO_URL}/issues/2)`,
  '- **Ratified:** 2026-10-15',
  '',
  '## Decision',
  '1. Alpha stands.',
  '',
].join('\n');

/** A small docs/adr tree (one numbered record, two drafts) next to copies of the scripts. */
function fixtureTree(overrides: Record<string, string> = {}): string {
  const dir = tmpTree({
    'docs/adr/README.md': FIXTURE_README,
    'docs/adr/2-alpha.md': FIXTURE_ALPHA,
    'docs/adr/draft-beta.md': fixtureDraft('beta', 'ADR: Beta — decides‑things'),
    'docs/adr/draft-gamma-ray.md': fixtureDraft('gamma-ray', 'ADR: Gamma ray'),
    ...overrides,
  });
  copyScripts(dir);
  return dir;
}

/**
 * Put the named records of a docs/adr folder into the state they had before the MVP gate pass: a draft file with a
 * Proposed header, a README table row that links the draft and says Proposed, no Ratification log row and a row in
 * the Ratification schedule. A record that is already a draft is left alone.
 */
function dePassRecords(adrDir: string, slugs: readonly string[]): void {
  const readmePath = path.join(adrDir, 'README.md');
  let readme = fs.readFileSync(readmePath, 'utf8');
  for (const slug of slugs) {
    const file = findAdrFile(adrDir, slug);
    assert.ok(file, `no ADR file for ${slug} to build the pre-pass fixture from`);
    const draft = `draft-${slug}.md`;
    if (file !== draft) {
      const body = fs
        .readFileSync(path.join(adrDir, file), 'utf8')
        .replace(/^- \*\*Status:\*\* Accepted$/m, '- **Status:** Proposed')
        .replace(/^- \*\*Ratified:\*\*.*\n/m, '')
        .replace(/^- \*\*Issue:\*\*.*$/m, `- **Issue:** to be opened (rename to \`<issue#>-${slug}.md\`)`);
      fs.rmSync(path.join(adrDir, file));
      fs.writeFileSync(path.join(adrDir, draft), body);
      readme = readme.replace(new RegExp(`(?<![A-Za-z0-9-])\\d+-${slug}(?![A-Za-z0-9-])`, 'g'), `draft-${slug}`);
      readme = readme
        .split('\n')
        .filter((l) => !l.startsWith(`| ${slug} |`))
        .map((l) => (l.includes(`](${draft})`) && l.trimEnd().endsWith('| Accepted |') ? l.replace(/\| Accepted \|\s*$/, '| Proposed |') : l))
        .join('\n');
    }
    const lines = readme.split('\n');
    const at = lines.findIndex((l) => l === '## Ratification schedule');
    const row = `| ${slug} | ${SCHEDULE_PHASE[slug] ?? 'Phase 4'} | None |`;
    if (at === -1) {
      readme = `${readme.trimEnd()}\n\n## Ratification schedule\nRecords that remain Proposed.\n\n| ADR | Ratify before | Amendments applied at that ratification |\n|-----|---------------|------------------------------------------|\n${row}\n`;
    } else {
      let end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
      if (end === -1) end = lines.length;
      if (!lines.slice(at, end).some((l) => l.startsWith(`| ${slug} |`))) {
        let last = at;
        for (let i = at; i < end; i++) if ((lines[i] ?? '').startsWith('|')) last = i;
        lines.splice(last + 1, 0, row);
        readme = lines.join('\n');
      }
    }
  }
  fs.writeFileSync(readmePath, readme);
}

/** Temporary copy of the scripts and of the real docs/adr, rebuilt into the pre-pass state. */
function prePassTree(): string {
  const dir = tmpTree({});
  copyScripts(dir);
  fs.cpSync(ADR_DIR, path.join(dir, 'docs', 'adr'), { recursive: true });
  dePassRecords(path.join(dir, 'docs', 'adr'), KNOWN_AT_GATE);
  return dir;
}

const SAMPLE = [
  '# ADR: Sample',
  '',
  '- **Status:** Proposed',
  '- **Issue:** to be opened (rename this file to `<issue#>-sample.md`)',
  '- **DESIGN.md:** A1',
  '',
  '## Decision',
  '1. Keep the text, even `- **Status:** Proposed` in prose.',
  '',
].join('\n');

describe('ratifyText', () => {
  it('sets Status, Issue and Ratified lines', () => {
    const out = ratifyText(SAMPLE, 7, '2026-10-15').split('\n');
    assert.equal(out[2], '- **Status:** Accepted');
    assert.equal(out[3], `- **Issue:** [#7](${REPO_URL}/issues/7)`);
    assert.equal(out[4], '- **Ratified:** 2026-10-15');
  });

  it('leaves every other line byte-identical', () => {
    const before = SAMPLE.split('\n');
    const after = ratifyText(SAMPLE, 7, '2026-10-15').split('\n');
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
    assert.deepEqual(after.slice(5), before.slice(4));
  });

  it('throws when the Status or Issue line is missing', () => {
    assert.throws(() => ratifyText('# ADR\n\n- **Issue:** x\n', 1, '2026-01-01'), /Status/);
    assert.throws(() => ratifyText('# ADR\n\n- **Status:** Proposed\n', 1, '2026-01-01'), /Issue/);
  });

  it('is idempotent: a second run does not duplicate the Ratified line', () => {
    const once = ratifyText(SAMPLE, 7, '2026-10-15');
    assert.equal(ratifyText(once, 7, '2026-10-15'), once);
  });
});

describe('rewriteReferences', () => {
  it('rewrites file names and display text for mapped slugs only', () => {
    const text = '[draft-fact-model](draft-fact-model.md) and [draft-mcp-contract](draft-mcp-contract.md)';
    const out = rewriteReferences(text, { 'fact-model': 12 });
    assert.equal(out, '[12-fact-model](12-fact-model.md) and [draft-mcp-contract](draft-mcp-contract.md)');
  });

  it('rewrites paths and bare display text', () => {
    const text = 'see `adr/draft-query-and-policy.md` and draft-fact-model\'s rule';
    const out = rewriteReferences(text, { 'fact-model': 3, 'query-and-policy': 4 });
    assert.equal(out, "see `adr/4-query-and-policy.md` and 3-fact-model's rule");
  });

  it('does not touch longer names that merely start with a mapped slug', () => {
    const text = 'draft-fact-model-extra.md and draft-fact-model.md';
    assert.equal(rewriteReferences(text, { 'fact-model': 3 }), 'draft-fact-model-extra.md and 3-fact-model.md');
  });

  it('leaves the generic draft-<slug> placeholder alone', () => {
    const text = 'named `draft-<slug>.md`, glob `draft-*.md`';
    assert.equal(rewriteReferences(text, { 'fact-model': 3 }), text);
  });
});

describe('findAdrFile', () => {
  it('finds draft and numbered names and returns null when absent', () => {
    const dir = tmpTree({ 'draft-a-b.md': '', '12-c.md': '', 'README.md': '', '12-c-d.md': '' });
    try {
      assert.equal(findAdrFile(dir, 'a-b'), 'draft-a-b.md');
      assert.equal(findAdrFile(dir, 'c'), '12-c.md');
      assert.equal(findAdrFile(dir, 'b'), null);
      assert.equal(findAdrFile(dir, 'zzz'), null);
    } finally {
      rmTree(dir);
    }
  });
});

describe('collectLinkFiles', () => {
  it('collects docs, root docs and planning docs; excludes snapshot and generated folders', () => {
    const dir = tmpTree({
      'docs/a.md': '',
      'docs/adr/b.md': '',
      'docs/notes.txt': '',
      'GLOSSARY.md': '',
      'README.md': '',
      '.planning/PROJECT.md': '',
      '.planning/ROADMAP.md': '',
      '.planning/REQUIREMENTS.md': '',
      '.planning/STATE.md': '',
      '.planning/phases/01/PLAN.md': '',
      '.planning/research/R.md': '',
      'node_modules/x/README.md': '',
      '.claude/CLAUDE.md': '',
    });
    try {
      assert.deepEqual(collectLinkFiles(dir).sort(), [
        '.planning/PROJECT.md',
        '.planning/REQUIREMENTS.md',
        '.planning/ROADMAP.md',
        'GLOSSARY.md',
        'README.md',
        'docs/a.md',
        'docs/adr/b.md',
      ]);
    } finally {
      rmTree(dir);
    }
  });

  it('skips scoped files that do not exist', () => {
    const dir = tmpTree({ 'docs/a.md': '' });
    try {
      assert.deepEqual(collectLinkFiles(dir), ['docs/a.md']);
    } finally {
      rmTree(dir);
    }
  });
});

describe('checkRelativeLinks', () => {
  it('reports missing targets and ignores http, mailto, anchors and code spans', () => {
    const dir = tmpTree({
      'docs/a.md': [
        '[ok](b.md) [ok2](adr/c.md#section) [anchor](#top)',
        '[web](https://example.com/x.md) [mail](mailto:a@b.c)',
        '[gone](missing.md) [gone2](adr/nope.md#x)',
        'in code `[fake](nowhere.md)` is ignored',
        '```',
        '[fenced](nowhere2.md)',
        '```',
      ].join('\n'),
      'docs/b.md': '',
      'docs/adr/c.md': '[up](../a.md) [bad](../zzz.md)',
    });
    try {
      const broken = checkRelativeLinks(dir, ['docs/a.md', 'docs/adr/c.md']);
      assert.deepEqual(
        broken.map((b) => `${b.file} -> ${b.link}`),
        ['docs/a.md -> missing.md', 'docs/a.md -> adr/nope.md#x', 'docs/adr/c.md -> ../zzz.md'],
      );
    } finally {
      rmTree(dir);
    }
  });
});

describe('MVP gate helpers (SKL-03)', () => {
  it('mvpGateSlugs lists the slug of every draft file, sorted', () => {
    const dir = tmpTree({
      'draft-zeta.md': '',
      'draft-a-b2.md': '',
      'draft-zeta-two.md': '',
      '12-c.md': '',
      'README.md': '',
      'draft-Bad.md': '',
      'draft-a--b.md': '',
      'draft--lead.md': '',
      'draft-x.txt': '',
      'notes-draft-q.md': '',
    });
    try {
      assert.equal(MVP_GATE, 'mvp');
      assert.deepEqual(mvpGateSlugs(dir), ['a-b2', 'zeta', 'zeta-two']);
    } finally {
      rmTree(dir);
    }
  });

  it('mvpGateSlugs is empty when no draft is present', () => {
    const dir = tmpTree({ '2-alpha.md': '', 'README.md': '' });
    try {
      assert.deepEqual(mvpGateSlugs(dir), []);
    } finally {
      rmTree(dir);
    }
  });

  it('unnumberedAdrFiles reports every non-README file without a number', () => {
    const dir = tmpTree({ 'README.md': '', '3-ok.md': '', 'draft-x.md': '', 'notes.md': '', '12-Bad.md': '', '7-fine-one.md': '' });
    try {
      assert.deepEqual(unnumberedAdrFiles(dir), ['12-Bad.md', 'draft-x.md', 'notes.md']);
    } finally {
      rmTree(dir);
    }
  });
});

describe('ratifyReadme (SKL-03)', () => {
  const prepared = rewriteReferences(FIXTURE_README, { beta: 3 });
  const opts = { slug: 'beta', issue: 3, date: '2026-10-18' };

  it('moves the table row, appends one log row and drops the schedule row', () => {
    const out = ratifyReadme(prepared, opts);
    const lines = out.split('\n');
    const rowAfter = '| [3-beta](3-beta.md) | Beta decides; things stay small | A2 | Accepted |';
    const logRow = `| beta | [#3](${REPO_URL}/issues/3) | [3-beta.md](3-beta.md) | 2026-10-18 |`;
    assert.ok(lines.includes(rowAfter));
    assert.equal(lines.indexOf(logRow), lines.indexOf(`| alpha | [#2](${REPO_URL}/issues/2) | [2-alpha.md](2-alpha.md) | 2026-10-15 |`) + 1);
    assert.equal(lines.includes('| beta | Phase 4 | None |'), false);
    assert.ok(lines.includes('| gamma-ray | Phase 3 | None |'));
    // Nothing else changed: two lines added, two lines removed.
    const before = new Set(prepared.split('\n'));
    const after = new Set(lines);
    assert.deepEqual(lines.filter((l) => !before.has(l)), [rowAfter, logRow]);
    assert.deepEqual(prepared.split('\n').filter((l) => !after.has(l)), [
      '| [3-beta](3-beta.md) | Beta decides; things stay small | A2 | Proposed |',
      '| beta | Phase 4 | None |',
    ]);
  });

  it('is idempotent', () => {
    const once = ratifyReadme(prepared, opts);
    assert.equal(ratifyReadme(once, opts), once);
  });

  it('works when the README has no Ratification schedule section', () => {
    const noSchedule = prepared.replace(/## Ratification schedule[\s\S]*?(?=## Before M4)/, '');
    assert.equal(noSchedule.includes('Ratification schedule'), false);
    const out = ratifyReadme(noSchedule, opts);
    assert.ok(out.includes('| beta | [#3]('));
  });

  it('throws naming the missing part', () => {
    assert.throws(() => ratifyReadme(prepared, { slug: 'delta', issue: 5, date: '2026-10-18' }), /5-delta\.md/);
    assert.throws(
      () => ratifyReadme(prepared.replace('| Slug | Issue | File | Ratified |', '| Other |'), opts),
      /Slug \| Issue \| File \| Ratified/,
    );
  });
});

describe('issuePayload (SKL-03)', () => {
  const draft = fixtureDraft('beta', 'ADR: Beta \u2014 decides\u2011things');

  it('builds the title from the heading and the body from the README row', () => {
    const { title, body } = issuePayload(draft, FIXTURE_README, 'beta');
    assert.equal(title, 'ADR: Beta \u2014 decides-things');
    assert.equal(
      body,
      [
        'ADR: Beta \u2014 decides-things',
        '',
        'Decision summary: Beta decides; things stay small',
        '',
        'This issue gives the record its number at the MVP gate. The file is renamed to `<issue number>-beta.md` in the pull request that links this issue.',
      ].join('\n'),
    );
  });

  it('finds the README row of a numbered record too', () => {
    const { body } = issuePayload(FIXTURE_ALPHA, FIXTURE_README, 'alpha');
    assert.ok(body.includes('Decision summary: Alpha is settled'));
  });

  it('throws when the heading or the README row is missing', () => {
    assert.throws(() => issuePayload('no heading here\n', FIXTURE_README, 'beta'), /heading/);
    assert.throws(() => issuePayload(draft, FIXTURE_README, 'omega'), /omega/);
  });
});

describe('publicTextProblems (SKL-03)', () => {
  const dirty: readonly (readonly [string, string])[] = [
    ['absolute path', 'see /Users/someone/project/file.ts'],
    ['absolute path', 'at /home/ci/work'],
    ['absolute path', 'in /private/tmp/x'],
    ['absolute path', 'in /var/log/x'],
    ['absolute path', '(/tmp/scratch)'],
    ['absolute path', 'read /etc/hosts'],
    ['absolute path', 'under /opt/tools'],
    ['absolute path', 'on /mnt/disk'],
    ['absolute path', 'drive C:\\Users\\someone'],
    ['agent folder', 'the .claude folder'],
    ['token', `token ${'ghp_'}${'a'.repeat(36)}`],
    ['token', `token ${'gho_'}${'b'.repeat(36)}`],
    ['token', `token ${'ghu_'}${'c'.repeat(36)}`],
    ['token', `token ${'ghs_'}${'d'.repeat(36)}`],
    ['token', `token ${'ghr_'}${'e'.repeat(36)}`],
    ['token', `token ${'github_pat_'}${'A1'.repeat(20)}`],
    ['token', `key ${'sk-'}${'ab12'.repeat(8)}`],
    ['token', `id ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`],
    ['token', `-----BEGIN ${'RSA '}PRIVATE KEY-----`],
    ['email address', 'write to a.b@example.com'],
    ['planning vocabulary', 'Phase 3 closes'],
    ['planning vocabulary', 'see plan 03-37 for it'],
    ['planning vocabulary', 'decision D-04 says'],
    ['planning vocabulary', 'requirement SKL-03'],
  ];

  it('flags paths, tokens, emails and planning vocabulary', () => {
    for (const [label, text] of dirty) {
      const problems = publicTextProblems(text);
      assert.ok(
        problems.some((p) => p.startsWith(label)),
        `${JSON.stringify(text)} should be flagged as ${label}, got ${JSON.stringify(problems)}`,
      );
    }
  });

  it('flags the home directory and the user name of the running machine when given', () => {
    const who = { home: '/srv/people/jo-ann', user: 'jo-ann' };
    assert.deepEqual(publicTextProblems('nothing to see'), []);
    assert.ok(publicTextProblems('stored in /srv/people/jo-ann/notes', who).some((p) => p.startsWith('home directory')));
    assert.ok(publicTextProblems('written by Jo-Ann last week', who).some((p) => p.startsWith('user name')));
    assert.deepEqual(publicTextProblems('written by Joanna last week', who), []);
    assert.deepEqual(publicTextProblems('stored in /srv/people/jo-ann/notes'.replace('/srv/people/jo-ann', '/srv/people/other')), []);
  });

  it('passes clean text, including look-alikes', () => {
    const clean = [
      'ADR: Host process model',
      '',
      'Decision summary: One host per user; ports like 127.0.0.1:3000; see docs/adr/README.md and docs/tmp/notes.',
      'Encodings such as UTF-16 and hashes such as SHA-256 are fine; so is https://github.com/open-gsd/gsd-atlas/issues/15 and https://example.com/home/page.',
    ].join('\n');
    assert.deepEqual(publicTextProblems(clean), []);
  });

  it('passes the issue text built from every record', () => {
    const readme = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8');
    const who = machineIdentity();
    for (const slug of [...RATIFIED, ...KNOWN_AT_GATE]) {
      const file = findAdrFile(ADR_DIR, slug);
      assert.ok(file, `no ADR file for ${slug}`);
      const { title, body } = issuePayload(fs.readFileSync(path.join(ADR_DIR, file), 'utf8'), readme, slug);
      assert.deepEqual(publicTextProblems(`${title}\n${body}`, who), [], slug);
    }
  });
});

describe('appendOnlyViolations (SKL-03, T-03-372)', () => {
  const before = fixtureDraft('beta', 'ADR: Beta');
  const after = ratifyText(rewriteReferences(before, { beta: 3 }), 3, '2026-10-18');

  it('accepts header and link changes only', () => {
    assert.deepEqual(appendOnlyViolations(before, after, 'beta', 3), []);
    const other = 'Text before.\nSee [beta](draft-beta.md) and draft-beta.\nText after.\n';
    assert.deepEqual(appendOnlyViolations(other, rewriteReferences(other, { beta: 3 }), 'beta', 3), []);
  });

  it('reports a changed decision sentence, including one that also carries the link', () => {
    const edited = after.replace('beta decides.', 'beta never decides.');
    const problems = appendOnlyViolations(before, edited, 'beta', 3);
    assert.ok(problems.length >= 1);
    assert.ok(problems.some((p) => p.includes('never decides')));
    const plain = after.replace('Context of beta.', 'Context of something else.');
    assert.ok(appendOnlyViolations(before, plain, 'beta', 3).length >= 2);
  });

  it('reports a removed line, an added line and a removed Ratified line', () => {
    assert.ok(appendOnlyViolations(before, after.replace('## Decision\n', ''), 'beta', 3).length >= 1);
    assert.ok(appendOnlyViolations(before, `${after}An extra sentence.\n`, 'beta', 3).some((p) => p.includes('extra sentence')));
    const withRatified = before.replace('- **DESIGN.md:** A2', '- **Ratified:** 2020-01-01\n- **DESIGN.md:** A2');
    const reratified = ratifyText(rewriteReferences(withRatified, { beta: 3 }), 3, '2026-10-18');
    assert.ok(appendOnlyViolations(withRatified, reratified, 'beta', 3).some((p) => p.includes('2020-01-01')));
  });
});

describe('adrIssueRefs (SKL-03)', () => {
  function record(n: number, slug: string, issueLine: string): string {
    return `# ADR: ${slug}\u2011record\n\n- **Status:** Accepted\n${issueLine}\n- **Ratified:** 2026-10-15\n\n## Decision\nText.\n`;
  }

  it('reads the issue number of each numbered record, sorted by number', () => {
    const dir = tmpTree({
      '10-ten.md': record(10, 'ten', `- **Issue:** [#10](${REPO_URL}/issues/10)`),
      '2-two.md': record(2, 'two', `- **Issue:** [#2](${REPO_URL}/issues/2)`),
      '3-three.md': record(3, 'three', `- **Issue:** [#3](${REPO_URL}/issues/3)`),
      'draft-x.md': '# ADR: x\n\n- **Status:** Proposed\n- **Issue:** to be opened\n',
      'README.md': '# readme',
    });
    try {
      assert.deepEqual(adrIssueRefs(dir), [
        { file: '2-two.md', number: 2, slug: 'two', title: 'ADR: two-record', issue: 2 },
        { file: '3-three.md', number: 3, slug: 'three', title: 'ADR: three-record', issue: 3 },
        { file: '10-ten.md', number: 10, slug: 'ten', title: 'ADR: ten-record', issue: 10 },
      ]);
    } finally {
      rmTree(dir);
    }
  });

  it('throws naming the file when the Issue line is missing, has no number or names another number', () => {
    const missing = tmpTree({ '9-nine.md': '# ADR: nine\n\n- **Status:** Accepted\n\n## Decision\nText.\n' });
    const noNumber = tmpTree({ '8-eight.md': record(8, 'eight', '- **Issue:** to be opened') });
    const mismatch = tmpTree({ '7-seven.md': record(7, 'seven', `- **Issue:** [#8](${REPO_URL}/issues/8)`) });
    try {
      assert.throws(() => adrIssueRefs(missing), /9-nine\.md/);
      assert.throws(() => adrIssueRefs(noNumber), /8-eight\.md/);
      assert.throws(() => adrIssueRefs(mismatch), /7-seven\.md/);
    } finally {
      rmTree(missing);
      rmTree(noNumber);
      rmTree(mismatch);
    }
  });
});

describe('issueIsAdrsOwn (SKL-03)', () => {
  const slug = 'fact-model';

  it('accepts the three issue body shapes of the earlier records', () => {
    for (const body of [
      'Ratification issue (FND-09) for docs/adr/draft-fact-model.md. Opened to number the record.',
      'Draft: docs/adr/draft-fact-model.md\n\nSummary.',
      'ADR: docs/adr/draft-fact-model.md',
      'See docs/adr/6-fact-model.md',
      // The body that issuePayload writes names the file with the placeholder, because the number is not known yet.
      'Decision summary.\n\nThis issue gives the record its number at the MVP gate. The file is renamed to `<issue number>-fact-model.md` in the pull request that links this issue.',
    ]) {
      const verdict = issueIsAdrsOwn({ title: 'ADR: fact model', body }, slug);
      assert.equal(verdict.own, true, `${body}: ${verdict.reason}`);
    }
  });

  it('rejects other issues with a reason', () => {
    const cases: readonly { title: string; body: string }[] = [
      { title: 'Fix the parser', body: 'docs/adr/draft-fact-model.md' },
      { title: 'ADR: sqlite store', body: 'docs/adr/draft-sqlite-store.md' },
      { title: 'ADR: fact model', body: '' },
      { title: 'ADR: fact model', body: 'This is about the fact-model decision.' },
      { title: 'ADR: fact model', body: 'docs/adr/draft-big-fact-model.md' },
      { title: 'ADR: fact model', body: 'docs/adr/xdraft-fact-model.md' },
      { title: 'ADR: fact model', body: 'docs/adr/6-fact-model-extra.md' },
    ];
    for (const c of cases) {
      const verdict = issueIsAdrsOwn(c, slug);
      assert.equal(verdict.own, false, JSON.stringify(c));
      assert.ok(verdict.reason.length > 0);
    }
    assert.equal(issueIsAdrsOwn({ title: 'ADR: model', body: 'docs/adr/draft-fact-model.md' }, 'model').own, false);
  });
});

describe('adr-ratify flags (SKL-03)', () => {
  it('--list-gate prints the drafts, one slug per line', () => {
    const dir = fixtureTree();
    try {
      const run = runRatify(dir, ['--list-gate']);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, 'beta\ngamma-ray\n');
    } finally {
      rmTree(dir);
    }
  });

  it('--list-gate prints nothing when no draft is present', () => {
    const dir = tmpTree({ 'docs/adr/2-alpha.md': FIXTURE_ALPHA, 'docs/adr/README.md': FIXTURE_README });
    copyScripts(dir);
    try {
      const run = runRatify(dir, ['--list-gate']);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, '');
    } finally {
      rmTree(dir);
    }
  });

  it('--print-issue prints title and body as JSON for a present draft', () => {
    const dir = fixtureTree();
    try {
      const run = runRatify(dir, ['--print-issue', '--slug', 'beta']);
      assert.equal(run.status, 0, run.stderr);
      const expected = issuePayload(
        fs.readFileSync(path.join(dir, 'docs', 'adr', 'draft-beta.md'), 'utf8'),
        FIXTURE_README,
        'beta',
      );
      assert.deepEqual(JSON.parse(run.stdout), expected);
      assert.equal(JSON.parse(run.stdout).title, 'ADR: Beta \u2014 decides-things');
    } finally {
      rmTree(dir);
    }
  });

  it('--print-issue exits 1 with the problems when the text is not public', () => {
    const dirty = FIXTURE_README.replace('Beta decides; things stay small', 'Beta decides; mail me at someone@example.com');
    const dir = fixtureTree({ 'docs/adr/README.md': dirty });
    try {
      const run = runRatify(dir, ['--print-issue', '--slug', 'beta']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /email address/);
      assert.equal(run.stdout, '');
    } finally {
      rmTree(dir);
    }
  });

  it('--print-issue refuses a numbered record and a slug without a file', () => {
    const dir = fixtureTree();
    try {
      const numbered = runRatify(dir, ['--print-issue', '--slug', 'alpha']);
      assert.equal(numbered.status, 1);
      assert.match(numbered.stderr, /not a draft/);
      const none = runRatify(dir, ['--print-issue', '--slug', 'zeta']);
      assert.equal(none.status, 1);
      assert.match(none.stderr, /no ADR file for zeta/);
    } finally {
      rmTree(dir);
    }
  });

  it('--list-issues prints the numbered records, and --numbers only their issue numbers', () => {
    const dir = fixtureTree();
    try {
      const run = runRatify(dir, ['--list-issues']);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), [{ file: '2-alpha.md', number: 2, slug: 'alpha', title: 'ADR: Alpha', issue: 2 }]);
      const numbers = runRatify(dir, ['--list-issues', '--numbers']);
      assert.equal(numbers.status, 0, numbers.stderr);
      assert.equal(numbers.stdout, '2\n');
    } finally {
      rmTree(dir);
    }
  });

  it('--list-issues exits 1 with the thrown message when an Issue line is wrong', () => {
    const dir = fixtureTree({ 'docs/adr/2-alpha.md': FIXTURE_ALPHA.replace('issues/2)', 'issues/5)').replace('[#2]', '[#5]') });
    try {
      const run = runRatify(dir, ['--list-issues', '--numbers']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /2-alpha\.md/);
      assert.equal(run.stdout, '');
    } finally {
      rmTree(dir);
    }
  });

  it('--check-issue accepts or refuses an issue given as JSON on standard input', () => {
    const dir = fixtureTree();
    try {
      const own = runRatify(dir, ['--check-issue', '--slug', 'beta'], JSON.stringify({ title: 'ADR: Beta', body: 'Draft: docs/adr/draft-beta.md' }));
      assert.equal(own.status, 0, own.stderr);
      assert.equal(own.stdout.trim(), 'own');
      const notOwn = runRatify(dir, ['--check-issue', '--slug', 'beta'], JSON.stringify({ title: 'Something else', body: 'Draft: docs/adr/draft-beta.md' }));
      assert.equal(notOwn.status, 1);
      assert.match(notOwn.stdout, /^not own: .+/);
      const numbered = runRatify(dir, ['--check-issue', '--slug', 'alpha'], JSON.stringify({ title: 'ADR: Alpha', body: 'docs/adr/2-alpha.md' }));
      assert.equal(numbered.status, 0, numbered.stderr);
      const none = runRatify(dir, ['--check-issue', '--slug', 'zeta'], JSON.stringify({ title: 'ADR: Zeta', body: 'docs/adr/draft-zeta.md' }));
      assert.equal(none.status, 1);
      assert.match(none.stderr, /no ADR file for zeta/);
      const bad = runRatify(dir, ['--check-issue', '--slug', 'beta'], 'not json');
      assert.equal(bad.status, 1);
    } finally {
      rmTree(dir);
    }
  });

  it('a real run renames with git, sets the header, updates the README and leaves the other draft alone', () => {
    const dir = fixtureTree();
    try {
      const adrDir = path.join(dir, 'docs', 'adr');
      const original = fs.readFileSync(path.join(adrDir, 'draft-beta.md'), 'utf8');
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', 'docs'], { cwd: dir });
      const run = runRatify(dir, ['--gate', MVP_GATE, '--slug', 'beta', '--issue', '3', '--date', '2026-10-18']);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.existsSync(path.join(adrDir, 'draft-beta.md')), false);
      const renamed = fs.readFileSync(path.join(adrDir, '3-beta.md'), 'utf8');
      assert.match(renamed, /^- \*\*Status:\*\* Accepted$/m);
      assert.ok(renamed.includes(`- **Issue:** [#3](${REPO_URL}/issues/3)`));
      assert.match(renamed, /^- \*\*Ratified:\*\* 2026-10-18$/m);
      assert.deepEqual(appendOnlyViolations(original, renamed, 'beta', 3), []);
      const readme = fs.readFileSync(path.join(adrDir, 'README.md'), 'utf8');
      assert.ok(readme.includes('| [3-beta](3-beta.md) | Beta decides; things stay small | A2 | Accepted |'));
      assert.ok(readme.includes(`| beta | [#3](${REPO_URL}/issues/3) | [3-beta.md](3-beta.md) | 2026-10-18 |`));
      assert.equal(readme.includes('| beta | Phase 4 |'), false);
      assert.ok(run.stdout.includes('changed: docs/adr/3-beta.md'));
      assert.ok(run.stdout.includes('changed: docs/adr/README.md'));
      assert.deepEqual(mvpGateSlugs(adrDir), ['gamma-ray']);
    } finally {
      rmTree(dir);
    }
  });

  it('the append-only self-check fails the run before anything is written', () => {
    const draft = fixtureDraft('beta', 'ADR: Beta', ['- **Ratified:** 2020-01-01']);
    const dir = fixtureTree({ 'docs/adr/draft-beta.md': draft });
    try {
      const before = snapshotTree(path.join(dir, 'docs', 'adr'));
      const run = runRatify(dir, ['--gate', MVP_GATE, '--slug', 'beta', '--issue', '3', '--date', '2026-10-18']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /append-only/);
      assert.deepEqual(snapshotTree(path.join(dir, 'docs', 'adr')), before);
    } finally {
      rmTree(dir);
    }
  });

  it('refuses two modes at once and --numbers without --list-issues', () => {
    const dir = fixtureTree();
    try {
      assert.equal(runRatify(dir, ['--list-gate', '--list-issues']).status, 1);
      assert.equal(runRatify(dir, ['--list-gate', '--numbers']).status, 1);
    } finally {
      rmTree(dir);
    }
  });
});

describe('adr-ratify slug sets (FND-12, D-18, SKL-03)', () => {
  it('PHASE2_SLUGS is the four Phase 2 ADRs, PHASE3_SLUGS the diagnostics ADR, and RATIFIED_SLUGS is Phase 1, 2, then 3', () => {
    assert.deepEqual(PHASE2_SLUGS, ['worktree-lifecycle', 'query-and-policy', 'mcp-contract', 'value-dashboard']);
    assert.deepEqual(PHASE3_SLUGS, ['user-controlled-diagnostics']);
    assert.deepEqual(RATIFIED_SLUGS, [...PHASE1_SLUGS, ...PHASE2_SLUGS, ...PHASE3_SLUGS]);
    assert.equal(new Set(RATIFIED_SLUGS).size, 13);
    assert.equal(RATIFIED_SLUGS.length, 13);
    assert.equal(PHASE1_SLUGS.length, 8);
  });

  it('adr-ratify refuses a slug that has no ADR file', () => {
    const run = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'adr-ratify.ts'), '--gate', 'mvp', '--slug', 'no-such-record', '--issue', '99', '--dry-run'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no ADR file for no-such-record/);
  });

  it('adr-ratify refuses to rename without --gate mvp', () => {
    const dir = fixtureTree();
    try {
      const before = snapshotTree(path.join(dir, 'docs', 'adr'));
      for (const extra of [[], ['--dry-run'], ['--gate', 'later']]) {
        const run = runRatify(dir, ['--slug', 'beta', '--issue', '3', ...extra]);
        assert.equal(run.status, 1, run.stdout);
        assert.match(run.stderr, /numbered only at the MVP gate/);
        assert.match(run.stderr, /--gate mvp/);
      }
      assert.deepEqual(snapshotTree(path.join(dir, 'docs', 'adr')), before);
    } finally {
      rmTree(dir);
    }
  });

  it('a dry run with --gate mvp for user-controlled-diagnostics prints the rename, header lines and repaired files and changes no file', () => {
    // Drive a temp copy of the scripts and of docs/adr so the real tree is never touched.
    const dir = prePassTree();
    try {
      const adrDir = path.join(dir, 'docs', 'adr');
      const before = snapshotTree(adrDir);
      const run = runRatify(dir, [
        '--gate',
        MVP_GATE,
        '--slug',
        'user-controlled-diagnostics',
        '--issue',
        '15',
        '--date',
        '2026-10-18',
        '--dry-run',
      ]);
      assert.equal(run.status, 0, run.stderr);
      assert.match(
        run.stdout,
        /would rename docs\/adr\/draft-user-controlled-diagnostics\.md -> docs\/adr\/15-user-controlled-diagnostics\.md/,
      );
      assert.match(run.stdout, /would set: - \*\*Status:\*\* Accepted/);
      assert.ok(run.stdout.includes(`would set: - **Issue:** [#15](${REPO_URL}/issues/15)`));
      assert.match(run.stdout, /would set: - \*\*Ratified:\*\* 2026-10-18/);
      assert.match(run.stdout, /would change: docs\/adr\/README\.md/);
      assert.deepEqual(snapshotTree(adrDir), before);
      assert.equal(fs.existsSync(path.join(adrDir, '15-user-controlled-diagnostics.md')), false);
    } finally {
      rmTree(dir);
    }
  });

  it('a dry run with --gate mvp ratifies every present draft on a temporary copy and changes no file', () => {
    const dir = prePassTree();
    try {
      const adrDir = path.join(dir, 'docs', 'adr');
      const slugs = mvpGateSlugs(adrDir);
      assert.deepEqual(slugs, [...KNOWN_AT_GATE].sort());
      const before = snapshotTree(adrDir);
      let issue = 90;
      for (const slug of slugs) {
        issue += 1;
        const run = runRatify(dir, ['--gate', MVP_GATE, '--slug', slug, '--issue', String(issue), '--date', '2026-10-18', '--dry-run']);
        assert.equal(run.status, 0, run.stderr);
        assert.ok(run.stdout.includes(`would rename docs/adr/draft-${slug}.md -> docs/adr/${issue}-${slug}.md`));
        assert.ok(run.stdout.includes('would set: - **Status:** Accepted'));
        assert.ok(run.stdout.includes(`would set: - **Issue:** [#${issue}](${REPO_URL}/issues/${issue})`));
        assert.ok(run.stdout.includes('would set: - **Ratified:** 2026-10-18'));
        assert.ok(run.stdout.includes('would change: docs/adr/README.md'));
        assert.deepEqual(snapshotTree(adrDir), before);
      }
    } finally {
      rmTree(dir);
    }
  });

  it('a second ratify run for an already-numbered slug exits 1, refuses, and changes no file', () => {
    // Drive a temp copy of the scripts and of docs/adr so the real tree is never touched.
    const dir = tmpTree({});
    try {
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      for (const name of ['adr.ts', 'adr-ratify.ts']) {
        fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(dir, 'scripts', name));
      }
      fs.cpSync(ADR_DIR, path.join(dir, 'docs', 'adr'), { recursive: true });
      const snapshot = (): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const name of fs.readdirSync(path.join(dir, 'docs', 'adr')).sort()) {
          out[name] = fs.readFileSync(path.join(dir, 'docs', 'adr', name), 'utf8');
        }
        return out;
      };
      const before = snapshot();
      const run = spawnSync(
        process.execPath,
        [path.join(dir, 'scripts', 'adr-ratify.ts'), '--slug', 'fact-model', '--issue', '99'],
        { encoding: 'utf8' },
      );
      assert.equal(run.status, 1);
      assert.match(run.stderr, /refusing to ratify twice/);
      assert.deepEqual(snapshot(), before);
    } finally {
      rmTree(dir);
    }
  });
});

describe('Phase 1 ADR set (integration over the real docs/adr)', () => {
  it('PHASE1_SLUGS is exactly the eight Phase 1 ADRs', () => {
    assert.deepEqual(
      [...PHASE1_SLUGS].sort(),
      [
        'command-runner',
        'fact-model',
        'fact-store-interface',
        'language-modules',
        'product-boundary',
        'sqlite-store',
        'tenant-composition',
        'trust-boundaries',
      ],
    );
  });

  const readme = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8');

  for (const slug of RATIFIED) {
    it(`${slug} is ratified: renamed, Accepted, Issue line matches the file prefix`, () => {
      const file = findAdrFile(ADR_DIR, slug);
      assert.ok(file, `no ADR file found for ${slug}`);
      const m = /^(\d+)-/.exec(file);
      assert.ok(m, `${file} is not named <issue#>-${slug}.md`);
      const n = m[1];
      assert.equal(fs.existsSync(path.join(ADR_DIR, `draft-${slug}.md`)), false);

      const body = fs.readFileSync(path.join(ADR_DIR, file), 'utf8');
      assert.match(body, /^- \*\*Status:\*\* Accepted$/m);
      assert.ok(body.includes(`- **Issue:** [#${n}](${REPO_URL}/issues/${n})`));
      assert.match(body, /^- \*\*Ratified:\*\* \d{4}-\d{2}-\d{2}$/m);

      assert.ok(readme.includes(`](${file})`), `README does not link ${file}`);
      assert.equal(readme.includes(`draft-${slug}`), false);
      const row = readme.split('\n').find((l) => l.includes(`](${file})`));
      assert.ok(row?.trimEnd().endsWith('| Accepted |'), `README row for ${slug} is not Accepted`);

      const planningProject = path.join(ROOT, '.planning', 'PROJECT.md');
      if (fs.existsSync(planningProject)) {
        assert.equal(fs.readFileSync(planningProject, 'utf8').includes(`draft-${slug}`), false);
      }
    });
  }

  // The records of the MVP gate pass are either still drafts (before the pass) or numbered (after it). Each test
  // derives the state from the files present, so the same file is green before and after the pass.
  const gateDrafts = KNOWN_AT_GATE.filter((slug) => findAdrFile(ADR_DIR, slug) === `draft-${slug}.md`);
  const gateNumbered = KNOWN_AT_GATE.filter((slug) => /^\d+-/.test(findAdrFile(ADR_DIR, slug) ?? ''));
  const numberedKnown = [...RATIFIED, ...gateNumbered];

  for (const slug of KNOWN_AT_GATE) {
    it(`${slug} is a Proposed draft with a schedule row, or numbered and Accepted with a log row`, () => {
      const file = findAdrFile(ADR_DIR, slug);
      assert.ok(file, `no ADR file found for ${slug}`);
      const body = fs.readFileSync(path.join(ADR_DIR, file), 'utf8');
      const row = readme.split('\n').find((l) => l.includes(`](${file})`) && /\| (Proposed|Accepted) \|\s*$/.test(l));
      assert.ok(row, `README has no table row for ${file}`);
      if (file === `draft-${slug}.md`) {
        assert.match(body, /^- \*\*Status:\*\* Proposed$/m);
        assert.ok(row.trimEnd().endsWith('| Proposed |'), `README row for ${slug} is not Proposed`);
        const schedule = readme.split(/^## Ratification schedule$/m)[1] ?? '';
        const sRow = schedule.split('\n').find((l) => l.startsWith('|') && l.includes(`| ${slug} |`));
        assert.ok(sRow, `schedule has no row for ${slug}`);
        assert.ok(sRow.includes(`| ${SCHEDULE_PHASE[slug]} |`), `schedule row for ${slug} does not name ${SCHEDULE_PHASE[slug]}`);
      } else {
        const n = /^(\d+)-/.exec(file)?.[1];
        assert.ok(n, `${file} is not named <issue#>-${slug}.md`);
        assert.match(body, /^- \*\*Status:\*\* Accepted$/m);
        assert.ok(body.includes(`- **Issue:** [#${n}](${REPO_URL}/issues/${n})`));
        assert.match(body, /^- \*\*Ratified:\*\* \d{4}-\d{2}-\d{2}$/m);
        assert.ok(row.trimEnd().endsWith('| Accepted |'), `README row for ${slug} is not Accepted`);
        assert.equal(readme.includes(`draft-${slug}`), false);
      }
    });
  }

  it('docs/adr holds exactly the known records and no unknown file', () => {
    const known = new Set<string>([...RATIFIED, ...KNOWN_AT_GATE]);
    const names = fs.readdirSync(ADR_DIR).filter((n) => n !== 'README.md');
    assert.equal(names.length, known.size, `unexpected files: ${names.join(', ')}`);
    for (const name of names) {
      const slug = /^(?:draft|\d+)-([a-z0-9-]+)\.md$/.exec(name)?.[1];
      assert.ok(slug !== undefined && known.has(slug), `${name} is not a known record`);
    }
    assert.equal(names.filter((n) => /^\d+-/.test(n)).length, numberedKnown.length);
    assert.equal(names.filter((n) => n.startsWith('draft-')).length, gateDrafts.length);
    assert.deepEqual(mvpGateSlugs(ADR_DIR), [...gateDrafts].sort());
    assert.deepEqual(unnumberedAdrFiles(ADR_DIR), gateDrafts.map((s) => `draft-${s}.md`).sort());
  });

  it('README has a Ratification log row per numbered ADR and a schedule row per remaining draft', () => {
    assert.match(readme, /^## Ratification log$/m);
    const afterLog = readme.split(/^## Ratification log$/m)[1] ?? '';
    const logBlock = afterLog.split(/^## /m)[0] ?? '';
    const logRows = logBlock.split('\n').filter((l) => /^\| \[?[a-z]/.test(l) && !l.startsWith('| Slug'));
    assert.equal(logRows.length, numberedKnown.length);
    for (const slug of numberedKnown) {
      const row = logRows.find((l) => l.includes(`| ${slug} |`));
      assert.ok(row, `log has no row for ${slug}`);
      const file = findAdrFile(ADR_DIR, slug);
      assert.ok(row.includes(`](${file})`), `log row for ${slug} does not link ${file}`);
      assert.match(row, /issues\/\d+/);
      assert.match(row, /\d{4}-\d{2}-\d{2}/);
    }
    const afterSchedule = readme.split(/^## Ratification schedule$/m)[1] ?? '';
    const scheduleBlock = afterSchedule.split(/^## /m)[0] ?? '';
    const scheduleRows = scheduleBlock.split('\n').filter((l) => /^\| [a-z]/.test(l) && !l.startsWith('| ADR'));
    assert.equal(scheduleRows.length, gateDrafts.length);
    if (gateDrafts.length > 0) assert.match(readme, /^## Ratification schedule$/m);
  });

  it('no ratified ADR or docs/PRD.md contains a backslash followed by a digit', () => {
    const files = [
      path.join(ROOT, 'docs', 'PRD.md'),
      ...numberedKnown.map((slug) => path.join(ADR_DIR, findAdrFile(ADR_DIR, slug) ?? `missing-${slug}`)),
    ];
    for (const f of files) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\\[0-9]/, `${path.relative(ROOT, f)} still has a lost-text token`);
    }
  });

  it('no scoped file still links a draft name of a ratified slug', () => {
    for (const rel of collectLinkFiles(ROOT)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const slug of numberedKnown) {
        assert.equal(text.includes(`draft-${slug}`), false, `${rel} still mentions draft-${slug}`);
      }
    }
  });

  it('every relative markdown link in scope resolves', () => {
    const broken = checkRelativeLinks(ROOT, collectLinkFiles(ROOT));
    assert.deepEqual(broken, []);
  });
});

// ---------------------------------------------------------------------------
// Amendments (plan 01-08: FND-10, D-16, D-17, T-01-18)
//
// ADRs are append-only: every change is a dated `## Amendment YYYY-MM-DD: <title>` section
// placed after the last original section. `preserved` holds one verbatim ASCII fragment per
// original decision area; if any disappears, someone rewrote an Accepted ADR.
// ---------------------------------------------------------------------------

type Extra = 'git-hardening' | 'parse-budget' | 'node-floor';

/**
 * Task 1 (checkpoint:decision) of plan 01-08, resolved by the user on 2026-10-15:
 * `core-plus-recommended`, that is D-16, D-17 and all three extras. Narrowing this list
 * (`core-only` is the empty list) makes the extras tests assert the sections are ABSENT.
 */
const SELECTED_EXTRAS: readonly Extra[] = ['git-hardening', 'parse-budget', 'node-floor'];

interface AmendmentSpec {
  readonly title: string;
  readonly keywords: readonly string[];
  readonly extra?: Extra;
}

interface AmendedAdr {
  readonly slug: string;
  readonly preserved: readonly string[];
  readonly amendments: readonly AmendmentSpec[];
}

const GIT_HARDENING_KEYWORDS = ['core.fsmonitor', 'core.hooksPath', 'filter', 'GIT_OPTIONAL_LOCKS', 'no allowlist'];

const AMENDED: readonly AmendedAdr[] = [
  {
    slug: 'language-modules',
    preserved: [
      'A language is a module folder:',
      'always on, no build, every branch',
      'The only code a module may add is an optional `PreciseResolver`',
      'Extension collisions fail loudly unless `replace`.',
      'Grammars (sandboxed WebAssembly) and queries (data) are always allowed.',
      'Files with parse errors are reported in `status` and use the precise tier where it exists.',
      'skip binaries and LFS pointers',
      'Precise resolution runs for a bounded number of active overlays',
      'instead of depending on a community SCIP indexer.',
    ],
    amendments: [
      { title: 'ProjectModel seam', keywords: ['ProjectModel', 'compiler-free', 'built-in', 'A44', 'project.model'] },
      { title: 'Parse-error budget unit', keywords: ['bytes inside', 'parseBudget'], extra: 'parse-budget' },
      {
        title: 'Parser pool deadlines',
        keywords: ['pool.loadTimeoutMs', '30,000', 'pool.terminateGraceMs', '7,000', 'parse_timeout', 'engine_init_failed'],
      },
      {
        title: 'TypeScript project model, adapter ids and manifest version 2',
        keywords: ['adrDirs', 'schemaVersion', '.gsd-atlas/config.json', 'project.model', 'adapter', 'version 1'],
      },
    ],
  },
  {
    slug: 'fact-store-interface',
    preserved: [
      'No other module reads or writes SQLite.',
      'It is injectable for tests but is not part of the interface callers learn.',
      'Reads never throw for missing data',
      'Overlays with identical inputs share the cache (A5).',
      '`store.writer()` throws `WriterBusy` if held.',
      'Every task stays a CLI command (A21).',
      'Each injected dependency has a production and a test adapter.',
      'It would be a second adapter of the wrong seam and would drift from real semantics.',
      'No predicate registry, generic `Match` or `Custom` queries.',
      'Corruption never escapes',
      'Does `warm(worktree)` exist to pre',
      'Is the first-call latency bound by `timeoutMs`',
    ],
    amendments: [
      {
        title: 'Read-triggered cache write and SQLite-access wording',
        keywords: ['cache_unavailable', 'lease', 'sqlite/'],
      },
      { title: 'Open questions resolved', keywords: ['resolver_timeout', 'timeoutMs', 'no warm'] },
      {
        title: 'Maintenance options and lease holder',
        keywords: ['IDLE_MAINTENANCE', 'StoreMaintainOptions', 'leaseHolder', 'StoreClosed'],
      },
      {
        title: 'Phase 3 interface additions',
        keywords: [
          'findIn',
          'relations',
          'provenance',
          'emittedAs',
          'citations',
          'ProjectContext',
          'listDirectory',
          'schema',
          'not_indexed',
          'gsd-atlas build',
          'resolve(worktree',
        ],
      },
    ],
  },
  {
    slug: 'fact-model',
    preserved: [
      'Two layers of facts.',
      'Fixed vocabulary per release:',
      'Local definitions and imports are `EXTRACTED`.',
      'supersedes an `INFERRED` edge at the same reference site.',
      'not part of its identity',
      'A rename or move is a remove plus an add',
      'the ambiguity is reported.',
    ],
    amendments: [
      {
        title: 'Phase 3 fact kinds',
        keywords: ['cites_adr', 'unresolved', 'emitted_as', 'relations', 'negative', 'resolved_relations', 'outDir', 'INFERRED'],
      },
    ],
  },
  {
    slug: 'sqlite-store',
    preserved: [
      'behind the Fact Store module',
      'macOS, Linux and Windows.',
      '`store.dir` overrides. Never committed.',
      'source is the truth.',
      "one transaction per file's facts.",
      '`auto_vacuum=INCREMENTAL`',
      'use FTS5 with the trigram tokenizer',
      'Budgets are release gates',
    ],
    amendments: [
      { title: 'SQLite-access wording', keywords: ['sqlite/', 'Metrics'] },
      { title: 'Node floor and open-time self-test', keywords: ['24.16.0', 'NUL'], extra: 'node-floor' },
      {
        title: 'Phase 2 store policy',
        keywords: ['incremental_vacuum', 'wal_checkpoint', 'contentless_delete', 'dirty', '24 h'],
      },
    ],
  },
  {
    slug: 'worktree-lifecycle',
    preserved: [
      'each worktree or branch is an overlay mapping paths to content hashes',
      'a retired version is collected when',
      'History comes from git, not the store.',
      'of a repo join its workspace automatically',
      "Source Tree supplies each worktree's snapshot and `hasObject`",
      'watch tracked directories only.',
      'Keep versions for history:',
      'Full copy per worktree:',
    ],
    amendments: [
      {
        title: 'Writer contention and leader/follower',
        keywords: ['lease.db', 'BEGIN EXCLUSIVE', 'follower', 'exit code 3'],
      },
      {
        title: 'Idle full compaction and lease messages',
        keywords: ['VACUUM', 'dbstat', 'busy timeout of 0', 'lease_held', 'not_indexed', '200 ms'],
      },
    ],
  },
  {
    slug: 'tenant-composition',
    preserved: [
      'so there is no port; tests use real temporary git repos',
      'Interface: `submit(event)`',
      'The Fact Store only reports `stalePaths` in its watermark and never blocks.',
      'Tests use a fake clock.',
      'only call `host.handle(request)`',
      'stays reserved for A42',
      'Does `Indexer.ensureFresh` take a `fresh` priority class slot from the Governor per call, or one per request?',
      'Where does the file watcher live',
      'A compiler program is per file set (A25)',
    ],
    amendments: [
      {
        title: 'Open questions resolved',
        keywords: ['Indexer', 'EventSource', 'one', 'per request', 'file set'],
      },
      {
        title: 'Idle eviction, git timeouts and store identity',
        keywords: ['host.idleEvictMs', 'git.timeoutMs', 'smallest', 'source_too_large', 'store_unavailable'],
      },
      {
        title: 'Source Tree ignore verdicts and attribute prefetch',
        keywords: ['unignoredPaths', 'pathAttributes', 'check-attr', 'snapshot', 'never cached'],
      },
    ],
  },
  {
    slug: 'command-runner',
    preserved: [
      'Nothing else imports `child_process`; a lint rule enforces it.',
      'Argument arrays only, never a shell.',
      'The TypeScript adapter** is a named built',
      'Denials are reported,',
      'The security rule has one place to review and test.',
    ],
    amendments: [
      { title: 'git runs repo-controlled code', keywords: GIT_HARDENING_KEYWORDS, extra: 'git-hardening' },
      { title: 'Source Tree git subcommands', keywords: ['ls-tree', 'worktree list', 'porcelain'] },
      {
        title: 'Git option allowlist',
        keywords: ['--batch-check', 'exact option tokens', 'runner.defaultTimeoutMs', 'SSH_AUTH_SOCK', 'DATABASE_URL'],
      },
      {
        title: 'One pathspec-free ls-files listing for the ignore check',
        keywords: ['--cached', '--pathspec-from-file', 'ls-files', '--literal-pathspecs', 'git-allowlist.test.ts'],
      },
      {
        title: 'Compiler worker built-in and exact-argv approvals',
        keywords: [
          'typescript-resolver',
          'exact',
          'sha256',
          'stdout',
          'stdin',
          'max-old-space-size',
          'sampler',
          'D-21',
        ],
      },
    ],
  },
  {
    slug: 'query-and-policy',
    preserved: [
      'One module, Query,',
      'MCP, CLI and hooks are adapters:',
      'CLI parity (A12) is structural, not a convention.',
      'A timeout is reported as `degraded: [\'fresh_timeout\']` with the old watermark.',
      'it never touches git or SQLite directly.',
      'Policy never calls Query.',
      'Overrides come only from the user',
      'A ranking or envelope fix lands once and shows up in MCP, CLI and hooks.',
      'Gate inside Query:',
    ],
    amendments: [
      { title: 'Phase 2 shape', keywords: ['chain_confidence', 'readText', 'untrusted_text', 'in-process'] },
      {
        title: 'explain as a Query request kind',
        keywords: ['explain', 'read-only', 'answer_id', 'code_explain', 'Host'],
      },
    ],
  },
  {
    slug: 'mcp-contract',
    preserved: [
      'Agents choose the cheapest path.',
      'every tool takes `budget_tokens` (default 2,000)',
      'Ranking quality is part of the answer',
      '`INFERRED` hops are listed but not expanded unless asked.',
      'never mixed into `hints`.',
      'Read tools marked `readOnlyHint`.',
      'Many narrow tools:',
      'Unbounded results:',
    ],
    amendments: [
      {
        title: 'Phase 2 contract changes',
        keywords: ['watermark_moved', 'exit code 3', 'repo', 'six tools'],
      },
      {
        title: 'Unbuilt repositories',
        keywords: ['not_indexed', 'atlas_status', 'lease.db', 'metrics.db', 'schema_too_new', 'gsd-atlas build'],
      },
      {
        title: 'Phase 3 contract changes',
        keywords: [
          'code_explain',
          'answer_id',
          'memory_budget',
          'compiler_fallback',
          'needs_approval',
          'seventh',
          'handle',
          'ImpactVia',
          'emittedAs',
        ],
      },
    ],
  },
  {
    slug: 'value-dashboard',
    preserved: [
      'Two surfaces, both local.',
      'A Metrics module per Tenant,',
      '`record(event)`, `report(range)',
      'no single value score',
      'Asking the agent how much it saved is rejected.',
      'value statistics are never placed in agent context.',
      'The Host serves no dashboard route',
      'Provisional retention:',
      'One "atlas value score":',
    ],
    amendments: [
      {
        title: 'Metrics migrations and retention',
        keywords: ['user_version', 'forward-only', 'dropped_events', '30 days'],
      },
      {
        title: 'Ratings table',
        keywords: ['ratings', 'answer id', 'closed', 'free text', 'migration'],
      },
    ],
  },
  {
    slug: 'trust-boundaries',
    preserved: [
      'Unix socket or named pipe preferred',
      'A token is required on every route.',
      'The token file is `0600`.',
      'Network.** None by default.',
      'Cloning and indexing a hostile repo',
    ],
    amendments: [
      { title: 'git runs repo-controlled code', keywords: GIT_HARDENING_KEYWORDS, extra: 'git-hardening' },
      {
        title: 'Per-command approvals, MCP origin and compiler trust',
        keywords: [
          'allow',
          '--allow-build',
          'needs_approval',
          'repository files can never',
          'sha256',
          'residual risk',
          'skills',
        ],
      },
    ],
  },
];

const AMENDMENT_HEADING = /^## Amendment (\d{4}-\d{2}-\d{2}): (.+)$/;

interface Section {
  readonly heading: string;
  readonly text: string;
}

/** Split an ADR into its `## ` sections (the title and status block before the first one are dropped). */
function adrSections(body: string): Section[] {
  const out: { heading: string; lines: string[] }[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('## ')) out.push({ heading: line, lines: [line] });
    else out.at(-1)?.lines.push(line);
  }
  return out.map((s) => ({ heading: s.heading, text: s.lines.join('\n') }));
}

function readAdr(slug: string): string {
  const file = findAdrFile(ADR_DIR, slug);
  assert.ok(file, `no ADR file found for ${slug}`);
  return fs.readFileSync(path.join(ADR_DIR, file), 'utf8');
}

function findAmendment(body: string, title: string): { section: Section; date: string; index: number } | undefined {
  const sections = adrSections(body);
  for (const [index, section] of sections.entries()) {
    const m = AMENDMENT_HEADING.exec(section.heading);
    if (m?.[2] === title) return { section, date: m[1] ?? '', index };
  }
  return undefined;
}

function isRealDate(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso);
}

describe('ADR amendments (FND-10, D-16, D-17)', () => {
  const readme = fs.readFileSync(path.join(ADR_DIR, 'README.md'), 'utf8');

  it('amendments are appended and dated', () => {
    for (const adr of AMENDED) {
      const body = readAdr(adr.slug);
      const sections = adrSections(body);
      const ratified = /^- \*\*Ratified:\*\* (\d{4}-\d{2}-\d{2})$/m.exec(body)?.[1] ?? '';
      const originals = sections.filter((s) => !AMENDMENT_HEADING.test(s.heading));
      const lastOriginal = sections.indexOf(originals.at(-1) as Section);
      assert.ok(originals.length > 0, `${adr.slug} has no original sections`);

      for (const spec of adr.amendments) {
        if (spec.extra !== undefined && !SELECTED_EXTRAS.includes(spec.extra)) continue;
        const found = findAmendment(body, spec.title);
        assert.ok(found, `${adr.slug} has no heading '## Amendment YYYY-MM-DD: ${spec.title}'`);
        assert.ok(isRealDate(found.date), `${adr.slug} amendment '${spec.title}' has an invalid date ${found.date}`);
        assert.ok(found.date >= ratified, `${adr.slug} amendment '${spec.title}' predates ratification`);
        assert.ok(found.index > lastOriginal, `${adr.slug} amendment '${spec.title}' is not after the last original section`);
        assert.match(found.section.text, /^Sources: .+$/m, `${adr.slug} amendment '${spec.title}' names no sources`);
        assert.ok(found.section.text.length > 300, `${adr.slug} amendment '${spec.title}' is too thin`);
        for (const keyword of spec.keywords) {
          assert.ok(found.section.text.includes(keyword), `${adr.slug} amendment '${spec.title}' lacks '${keyword}'`);
        }
      }

      // Everything after the first amendment is an amendment: originals are never interleaved with them.
      const firstAmendment = sections.findIndex((s) => AMENDMENT_HEADING.test(s.heading));
      if (firstAmendment !== -1) {
        for (const s of sections.slice(firstAmendment)) {
          assert.match(s.heading, AMENDMENT_HEADING, `${adr.slug}: '${s.heading}' follows an amendment but is not one`);
        }
      }
    }
  });

  it('original decision text is preserved', () => {
    for (const adr of AMENDED) {
      assert.ok(adr.preserved.length >= 5, `${adr.slug}: the append-only sentence table is too small`);
      const body = readAdr(adr.slug);
      const sections = adrSections(body);
      const firstAmendment = sections.findIndex((s) => AMENDMENT_HEADING.test(s.heading));
      const originalPart =
        firstAmendment === -1 ? body : body.slice(0, body.indexOf(sections[firstAmendment]?.heading ?? ''));
      for (const sentence of adr.preserved) {
        assert.ok(originalPart.includes(sentence), `${adr.slug}: original text is gone: '${sentence}'`);
      }
    }
  });

  it('D-17 resolutions are recorded', () => {
    const factStore = findAmendment(readAdr('fact-store-interface'), 'Open questions resolved');
    assert.ok(factStore, 'fact-store-interface has no D-17 section');
    assert.match(factStore.section.text, /no warm\(worktree\)/);
    assert.match(factStore.section.text, /`refs` and `callers`/);
    assert.match(factStore.section.text, /degraded: \['resolver_timeout'\]/);
    assert.match(factStore.section.text, /Does `warm\(worktree\)` exist/);
    assert.match(factStore.section.text, /Is the first-call latency bound/);

    const tenant = findAmendment(readAdr('tenant-composition'), 'Open questions resolved');
    assert.ok(tenant, 'tenant-composition has no D-17 section');
    assert.match(tenant.section.text, /file watcher lives inside the Indexer/);
    assert.match(tenant.section.text, /`EventSource` port/);
    assert.match(tenant.section.text, /Source Tree supplies only git events/);
    assert.match(tenant.section.text, /one `fresh` priority slot .* per request, not per call/s);
    assert.match(tenant.section.text, /keys on the file set, not on \(tenant, overlay\)/);
    assert.match(tenant.section.text, /tenant plus a file-set id/);
    for (const q of ['Does `Indexer.ensureFresh`', 'Where does the file watcher live', 'A compiler program is per file set']) {
      assert.ok(tenant.section.text.includes(q), `tenant-composition amendment does not restate: ${q}`);
    }
  });

  it('extra amendments match the recorded Task 1 selection', () => {
    for (const adr of AMENDED) {
      const body = readAdr(adr.slug);
      for (const spec of adr.amendments) {
        if (spec.extra === undefined) continue;
        const present = findAmendment(body, spec.title) !== undefined;
        assert.equal(
          present,
          SELECTED_EXTRAS.includes(spec.extra),
          `${adr.slug} '${spec.title}' (${spec.extra}) ${present ? 'is present but was not selected' : 'was selected but is missing'}`,
        );
      }
    }
  });

  it('the amendment log in the README lists every amendment', () => {
    let checked = 0;
    for (const adr of AMENDED) {
      const body = readAdr(adr.slug);
      for (const spec of adr.amendments) {
        const found = findAmendment(body, spec.title);
        if (found === undefined) continue; // an unselected extra; covered by the selection test
        const logged = readme.split('\n').some((l) => l.startsWith(`- Amendment ${found.date}: ${adr.slug} - ${spec.title}`));
        assert.ok(logged, `README amendment log has no line for ${adr.slug} - ${spec.title}`);
        checked += 1;
      }
    }
    assert.ok(checked > 0, 'no amendment was found to check against the README log');
  });
});
