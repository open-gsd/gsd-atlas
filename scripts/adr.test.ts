import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  PHASE1_SLUGS,
  checkRelativeLinks,
  collectLinkFiles,
  findAdrFile,
  ratifyText,
  rewriteReferences,
} from './adr.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADR_DIR = path.join(ROOT, 'docs', 'adr');
const REPO_URL = 'https://github.com/open-gsd/gsd-atlas';

// Slugs ratified so far. Task 3 of plan 01-02 extends this to all eight.
const RATIFIED: readonly string[] = ['product-boundary'];

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

  it('every relative markdown link in scope resolves', () => {
    const broken = checkRelativeLinks(ROOT, collectLinkFiles(ROOT));
    assert.deepEqual(broken, []);
  });
});
