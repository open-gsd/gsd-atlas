import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  PHASE1_SLUGS,
  PHASE2_SLUGS,
  RATIFIED_SLUGS,
  checkRelativeLinks,
  collectLinkFiles,
  findAdrFile,
  ratifyText,
  rewriteReferences,
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

// The ADRs that stay Proposed, and the phase that must ratify each.
const REMAINING: Readonly<Record<string, string>> = {
  'user-controlled-diagnostics': 'Phase 3',
  'host-process-model': 'Phase 4',
};

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

describe('adr-ratify slug sets (FND-12, D-18)', () => {
  it('PHASE2_SLUGS is exactly the four Phase 2 ADRs and RATIFIED_SLUGS is Phase 1 then Phase 2', () => {
    assert.deepEqual(PHASE2_SLUGS, ['worktree-lifecycle', 'query-and-policy', 'mcp-contract', 'value-dashboard']);
    assert.deepEqual(RATIFIED_SLUGS, [...PHASE1_SLUGS, ...PHASE2_SLUGS]);
    assert.equal(new Set(RATIFIED_SLUGS).size, 12);
    assert.equal(PHASE1_SLUGS.length, 8);
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

  for (const [slug, phase] of Object.entries(REMAINING)) {
    it(`${slug} stays a Proposed draft and is scheduled for ${phase}`, () => {
      assert.equal(findAdrFile(ADR_DIR, slug), `draft-${slug}.md`);
      const body = fs.readFileSync(path.join(ADR_DIR, `draft-${slug}.md`), 'utf8');
      assert.match(body, /^- \*\*Status:\*\* Proposed$/m);
      const row = readme.split('\n').find((l) => l.includes(`](draft-${slug}.md)`));
      assert.ok(row?.trimEnd().endsWith('| Proposed |'), `README row for ${slug} is not Proposed`);

      const schedule = readme.split(/^## Ratification schedule$/m)[1] ?? '';
      const sRow = schedule.split('\n').find((l) => l.startsWith('|') && l.includes(`| ${slug} |`));
      assert.ok(sRow, `schedule has no row for ${slug}`);
      assert.ok(sRow.includes(`| ${phase} |`), `schedule row for ${slug} does not name ${phase}`);
    });
  }

  it('docs/adr holds one numbered file per ratified ADR and one draft per remaining ADR', () => {
    const names = fs.readdirSync(ADR_DIR).filter((n) => n !== 'README.md');
    assert.equal(names.filter((n) => /^\d+-/.test(n)).length, RATIFIED.length);
    assert.equal(names.filter((n) => n.startsWith('draft-')).length, Object.keys(REMAINING).length);
  });

  it('README has a Ratification log row per ratified ADR and a schedule row per remaining ADR', () => {
    assert.match(readme, /^## Ratification log$/m);
    assert.match(readme, /^## Ratification schedule$/m);
    const afterLog = readme.split(/^## Ratification log$/m)[1] ?? '';
    const logBlock = afterLog.split(/^## /m)[0] ?? '';
    const logRows = logBlock.split('\n').filter((l) => /^\| \[?[a-z]/.test(l) && !l.startsWith('| Slug'));
    assert.equal(logRows.length, RATIFIED.length);
    for (const slug of RATIFIED) {
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
    assert.equal(scheduleRows.length, Object.keys(REMAINING).length);
  });

  it('no ratified ADR or docs/PRD.md contains a backslash followed by a digit', () => {
    const files = [
      path.join(ROOT, 'docs', 'PRD.md'),
      ...RATIFIED.map((slug) => path.join(ADR_DIR, findAdrFile(ADR_DIR, slug) ?? `missing-${slug}`)),
    ];
    for (const f of files) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\\[0-9]/, `${path.relative(ROOT, f)} still has a lost-text token`);
    }
  });

  it('no scoped file still links a draft name of a ratified slug', () => {
    for (const rel of collectLinkFiles(ROOT)) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const slug of RATIFIED) {
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
