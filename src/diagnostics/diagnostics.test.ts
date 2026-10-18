/**
 * User-controlled diagnostics (SKL-03; docs/DIAGNOSTICS.md, draft ADR "user-controlled diagnostics"). Task 1 of plan
 * 03-21: the catalog, the consent file and the report layout, proved with the smallest report there is (the header).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { allowAll, createRealRunner } from '../command-runner/index.ts';
import { PROTOCOL_VERSION } from '../facts/index.ts';
import type { Envelope } from '../facts/index.ts';
import { createGrammarEngine } from '../grammar-engine/index.ts';
import { createHost } from '../host/index.ts';
import type { Host } from '../host/index.ts';
import { createManualEventSource } from '../indexer/index.ts';
import { createTempGitRepo, makeTempDir } from '../test-kit/index.ts';
import { AGENT_CONCURRENCY_EDGES, REPO_COUNT_EDGES, bucketBytes, bucketCount, bucketLines, bucketMs } from './bucket.ts';
import { CATALOG_VERSION, defaultCatalogDir, loadCatalog, parseCatalog, valueFits } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { collectType } from './collect.ts';
import type { DiagnosticsSources } from './collect.ts';
import { CONSENT_FILE, CONSENT_MAX_BYTES, emptyConsent, loadConsent, reapprovalNeeded, saveConsent } from './consent.ts';
import type { Consent } from './consent.ts';
import { renderReport } from './preview.ts';
import { NOTE_CUT_MARKER, NOTE_MAX_CHARS, scrubNote } from './scrub.ts';

const catalog: Catalog = loadCatalog(defaultCatalogDir());

const HEADER_FIELDS = ['atlas_version', 'catalog_version'];
const headerOnly = (): Consent => ({ catalogVersion: 1, types: { header: { state: 'approved', fields: HEADER_FIELDS } } });

/** The first fenced block of a body, by info string. */
function blocks(body: string, info: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp('^```' + info + '\\n([\\s\\S]*?)\\n```$', 'gm');
  for (const match of body.matchAll(pattern)) found.push(match[1] as string);
  return found;
}

const validType = {
  id: 'x',
  title: 'X',
  fields: [{ name: 'a_field', example: '1', kind: 'integer' }],
  howItHelps: 'It helps.',
  cannotReveal: 'Nothing.',
};

describe('catalog schema', () => {
  it('the shipped catalog lists ten types, header first and required, notes last', () => {
    assert.equal(catalog.catalogVersion, CATALOG_VERSION);
    assert.equal(CATALOG_VERSION, 1);
    assert.deepEqual(
      catalog.types.map((type) => type.id),
      ['header', 'platform', 'agent_setup', 'languages', 'scale', 'performance', 'reliability', 'agent_behavior', 'ratings', 'notes'],
    );
    const header = catalog.types[0];
    assert.equal(header?.required, true);
    assert.deepEqual(header?.fields.map((field) => field.name), HEADER_FIELDS);
    for (const type of catalog.types) {
      assert.ok(type.howItHelps.length > 40, `${type.id} explains how it helps`);
      assert.ok(type.cannotReveal.length > 10, `${type.id} says what it cannot reveal`);
    }
  });

  it('the fields are exactly the ones docs/DIAGNOSTICS.md section 3 lists', () => {
    const names = Object.fromEntries(catalog.types.map((type) => [type.id, type.fields.map((field) => field.name)]));
    assert.deepEqual(names, {
      header: ['atlas_version', 'catalog_version'],
      platform: ['os_family', 'os_major', 'node_major'],
      agent_setup: ['agent_host', 'transport'],
      languages: ['languages_active', 'tiers_active', 'parse_error_rate', 'degraded_rate'],
      scale: ['repo_count_bucket', 'repo_size_bucket', 'worktree_count_bucket', 'agent_concurrency_bucket'],
      performance: ['build_time_bucket', 'store_size_bucket', 'query_latency', 'hook_latency', 'budget_breaches'],
      reliability: ['error_codes', 'crash_signature'],
      agent_behavior: ['gate_stats', 'atlas_vs_grep'],
      ratings: ['rating'],
      notes: ['note'],
    });
  });

  it('rejects a type without howItHelps, a type without cannotReveal, a duplicate field name and an unknown key', () => {
    const wrap = (type: unknown): unknown => ({ catalogVersion: 1, types: [type] });
    assert.equal(parseCatalog(wrap(validType)).ok, true);
    const { howItHelps: _h, ...noHelp } = validType;
    assert.equal(parseCatalog(wrap(noHelp)).ok, false);
    const { cannotReveal: _c, ...noReveal } = validType;
    assert.equal(parseCatalog(wrap(noReveal)).ok, false);
    const duplicate = { ...validType, fields: [validType.fields[0], validType.fields[0]] };
    assert.equal(parseCatalog(wrap(duplicate)).ok, false);
    assert.equal(parseCatalog(wrap({ ...validType, extra: true })).ok, false, 'unknown key on a type');
    assert.equal(parseCatalog({ catalogVersion: 1, types: [validType], extra: true }).ok, false, 'unknown key on the file');
    assert.equal(parseCatalog(wrap({ ...validType, fields: [{ ...validType.fields[0], extra: 1 }] })).ok, false, 'unknown key on a field');
    assert.equal(parseCatalog({ catalogVersion: 1, types: [validType, validType] }).ok, false, 'duplicate type id');
  });

  it('loadCatalog refuses a missing or oversized file with an error, not a partial catalog', () => {
    const tmp = makeTempDir();
    try {
      assert.throws(() => loadCatalog(tmp.path), /catalog/i);
      fs.writeFileSync(path.join(tmp.path, 'catalog.v1.json'), 'x'.repeat(2 * 1024 * 1024));
      assert.throws(() => loadCatalog(tmp.path), /catalog/i);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('off by default', () => {
  it('with no diagnostics.json every type is denied and nothing is written', () => {
    const tmp = makeTempDir();
    try {
      const userDir = path.join(tmp.path, 'user');
      const loaded = loadConsent(userDir, catalog);
      assert.equal(loaded.saved, false);
      assert.deepEqual(loaded.needsReview, []);
      assert.equal(loaded.warning, undefined);
      for (const type of catalog.types) assert.equal(loaded.consent.types[type.id]?.state, 'denied', type.id);
      assert.equal(fs.existsSync(userDir), false, 'loading created nothing, not even the folder');
    } finally {
      tmp.cleanup();
    }
  });

  it('a saved header approval is read back approved, every other type stays denied', () => {
    const tmp = makeTempDir();
    try {
      const saved = saveConsent(tmp.path, headerOnly());
      assert.deepEqual(saved, { ok: true });
      const loaded = loadConsent(tmp.path, catalog);
      assert.equal(loaded.saved, true);
      assert.equal(loaded.consent.types['header']?.state, 'approved');
      assert.deepEqual(loaded.consent.types['header']?.fields, HEADER_FIELDS);
      assert.equal(loaded.consent.types['platform']?.state, 'denied');
    } finally {
      tmp.cleanup();
    }
  });

  it('a file that fails validation is ignored whole with one warning, and is never overwritten', () => {
    const tmp = makeTempDir();
    try {
      const file = path.join(tmp.path, CONSENT_FILE);
      const hostile = JSON.stringify({ catalogVersion: 1, types: { header: { state: 'approved', fields: HEADER_FIELDS } }, autoSubmit: true });
      fs.writeFileSync(file, hostile);
      const loaded = loadConsent(tmp.path, catalog);
      assert.ok(loaded.warning !== undefined, 'one warning');
      for (const type of catalog.types) assert.equal(loaded.consent.types[type.id]?.state, 'denied', 'the whole file is ignored');
      const refused = saveConsent(tmp.path, headerOnly());
      assert.equal(refused.ok, false);
      assert.equal(fs.readFileSync(file, 'utf8'), hostile, 'the invalid file is untouched');
      assert.deepEqual(fs.readdirSync(tmp.path), [CONSENT_FILE], 'no temporary file is left behind');
    } finally {
      tmp.cleanup();
    }
  });

  it('a file larger than the cap is ignored without being parsed', () => {
    const tmp = makeTempDir();
    try {
      fs.writeFileSync(path.join(tmp.path, CONSENT_FILE), ' '.repeat(CONSENT_MAX_BYTES + 1));
      const loaded = loadConsent(tmp.path, catalog);
      assert.ok(loaded.warning !== undefined);
      assert.equal(loaded.consent.types['header']?.state, 'denied');
    } finally {
      tmp.cleanup();
    }
  });

  it('saving writes through a temporary file, mode 0600, and the folder is created on demand', { skip: process.platform === 'win32' }, () => {
    const tmp = makeTempDir();
    try {
      const userDir = path.join(tmp.path, 'a', 'b');
      assert.deepEqual(saveConsent(userDir, headerOnly()), { ok: true });
      assert.equal(fs.statSync(path.join(userDir, CONSENT_FILE)).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(userDir), [CONSENT_FILE]);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userDir, CONSENT_FILE), 'utf8')), {
        catalogVersion: 1,
        types: { header: { state: 'approved', fields: HEADER_FIELDS } },
      });
    } finally {
      tmp.cleanup();
    }
  });

  it('emptyConsent denies every type of the catalog', () => {
    const consent = emptyConsent(catalog);
    assert.equal(consent.catalogVersion, 1);
    assert.deepEqual(Object.keys(consent.types), catalog.types.map((type) => type.id));
    assert.ok(Object.values(consent.types).every((entry) => entry.state === 'denied' && entry.fields.length === 0));
  });
});

describe('header only report', () => {
  const header = { atlas_version: '1.2.3', catalog_version: 1 };

  it('the title, the labels and one diagnostics-v1 block with exactly the two header fields', () => {
    const report = renderReport({ catalog, consent: headerOnly(), values: { header }, version: '1.2.3' });
    assert.equal(report.title, '[diagnostics] atlas 1.2.3');
    assert.deepEqual(report.labels, ['diagnostics']);
    const found = blocks(report.body, 'diagnostics-v1');
    assert.equal(found.length, 1, 'one fenced block');
    assert.deepEqual(JSON.parse(found[0] as string), { catalog_version: 1, atlas_version: '1.2.3' });
    assert.deepEqual(report.json, { catalog_version: 1, atlas_version: '1.2.3' });
    assert.equal((report.body.match(/```/g) ?? []).length, 2, 'no other fence in the body');
  });

  it('collectType produces the header values from the sources', () => {
    assert.deepEqual(collectType('header', { atlasVersion: '1.2.3', catalogVersion: 1 }), header);
  });

  it('a type that is denied contributes nothing, even when values for it are supplied', () => {
    const report = renderReport({
      catalog,
      consent: headerOnly(),
      values: { header, platform: { os_family: 'macOS', os_major: 27, node_major: 24 } },
      version: '1.2.3',
    });
    assert.ok(!report.body.includes('macOS'));
    assert.ok(!report.title.includes('macOS'));
    assert.deepEqual(Object.keys(report.json), ['catalog_version', 'atlas_version']);
  });

  it('with the header denied nothing can be sent: the report is empty', () => {
    const consent: Consent = { catalogVersion: 1, types: { platform: { state: 'approved', fields: ['os_family', 'os_major', 'node_major'] } } };
    const report = renderReport({ catalog, consent, values: { header, platform: { os_family: 'macOS', os_major: 27, node_major: 24 } }, version: '1.2.3' });
    assert.equal(report.body, '');
    assert.deepEqual(report.json, {});
    assert.deepEqual(report.labels, []);
  });
});

describe('deterministic render', () => {
  it('two calls with the same input give byte-identical output', () => {
    const input = { catalog, consent: headerOnly(), values: { header: { atlas_version: '1.2.3', catalog_version: 1 } }, version: '1.2.3' };
    const first = renderReport(input);
    const second = renderReport({ ...input });
    assert.equal(first.title, second.title);
    assert.equal(first.body, second.body);
    assert.deepEqual(first.labels, second.labels);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});

describe('nothing written by preview', () => {
  it('after enabling the header only, diagnostics.json is the only file in the user directory and rendering writes nothing', () => {
    const tmp = makeTempDir();
    try {
      saveConsent(tmp.path, headerOnly());
      const before = fs.readdirSync(tmp.path);
      const loaded = loadConsent(tmp.path, catalog);
      renderReport({ catalog, consent: loaded.consent, values: { header: { atlas_version: '1.2.3', catalog_version: 1 } }, version: '1.2.3' });
      assert.deepEqual(fs.readdirSync(tmp.path), before);
      assert.deepEqual(before, [CONSENT_FILE]);
    } finally {
      tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Task 2: buckets, note scrubbing, collectors, version-aware re-approval.
// ---------------------------------------------------------------------------------------------------------------------

const MB = 1_000_000;
const GB = 1_000_000_000;

describe('bucket boundaries', () => {
  it('counts: every boundary, zero and a huge value, with the catalog examples (2–5, 6–20, 51–200)', () => {
    const edges = [1, 2, 6, 21];
    const table: Array<[number, string]> = [
      [0, '0'],
      [1, '1'],
      [2, '2–5'],
      [5, '2–5'],
      [6, '6–20'],
      [7, '6–20'],
      [20, '6–20'],
      [21, '21+'],
      [10_000_000, '21+'],
    ];
    for (const [value, label] of table) assert.equal(bucketCount(value, edges), label, String(value));
    assert.equal(bucketCount(7, [1, 2, 6, 21]), '6–20');
    assert.equal(bucketCount(100, AGENT_CONCURRENCY_EDGES), '51–200');
    assert.equal(bucketCount(201, AGENT_CONCURRENCY_EDGES), '201+');
    assert.equal(bucketCount(3, REPO_COUNT_EDGES), '2–5');
  });

  it('a value that is not a count has no bucket: negative, fractional, not finite', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(bucketCount(bad, [1, 2, 6, 21]), null, String(bad));
    assert.equal(bucketBytes(-1), null);
    assert.equal(bucketMs(Number.NaN), null);
    assert.equal(bucketLines(-5), null);
  });

  it('bytes: boundaries read like the catalog (50–100 MB), the label never carries the exact size', () => {
    const table: Array<[number, string]> = [
      [0, '<1 MB'],
      [MB - 1, '<1 MB'],
      [MB, '1–10 MB'],
      [50 * MB - 1, '10–50 MB'],
      [50 * MB, '50–100 MB'],
      [60 * MB, '50–100 MB'],
      [100 * MB, '100–500 MB'],
      [500 * MB, '500 MB–1 GB'],
      [GB, '1–5 GB'],
      [5 * GB, '5 GB+'],
      [Number.MAX_SAFE_INTEGER, '5 GB+'],
    ];
    for (const [value, label] of table) assert.equal(bucketBytes(value), label, String(value));
    assert.ok(!(bucketBytes(60 * MB) ?? '').includes('60'));
  });

  it('milliseconds (build time): boundaries read like the catalog (10–30 s)', () => {
    const table: Array<[number, string]> = [
      [0, '<1 s'],
      [999, '<1 s'],
      [1000, '1–10 s'],
      [10_000, '10–30 s'],
      [29_999, '10–30 s'],
      [30_000, '30–60 s'],
      [60_000, '1–5 min'],
      [300_000, '5–15 min'],
      [900_000, '15 min+'],
      [86_400_000, '15 min+'],
    ];
    for (const [value, label] of table) assert.equal(bucketMs(value), label, String(value));
  });

  it('lines of code: boundaries read like the catalog (100K–500K LOC)', () => {
    const table: Array<[number, string]> = [
      [0, '<1K LOC'],
      [999, '<1K LOC'],
      [1000, '1K–10K LOC'],
      [100_000, '100K–500K LOC'],
      [499_999, '100K–500K LOC'],
      [500_000, '500K–1M LOC'],
      [1_000_000, '1M–5M LOC'],
      [5_000_000, '5M+ LOC'],
    ];
    for (const [value, label] of table) assert.equal(bucketLines(value), label, String(value));
  });
});

describe('scrub paths urls emails secrets', () => {
  it('replaces each of the five shapes in the spec sentence with [removed] and keeps the other words', () => {
    const note =
      'see /Users/alice/proj/src/a.ts and https://x.example/y?token=abc, mail bob@corp.com, key ghp_0123456789abcdef0123456789abcdef0123, sha 3f2a9c1e7b5d4a60918273645a1b2c3d4e5f6071';
    assert.equal(scrubNote(note), 'see [removed] and [removed], mail [removed], key [removed], sha [removed]');
  });

  it('removes Windows, UNC, home and relative paths', () => {
    assert.equal(scrubNote('opened C:\\Users\\bob\\x now'), 'opened [removed] now');
    assert.equal(scrubNote('opened D:/work/app/src/index.ts now'), 'opened [removed] now');
    assert.equal(scrubNote('share \\\\fileserver\\team\\repo mounted'), 'share [removed] mounted');
    assert.equal(scrubNote('see ~/x and ~bob/y/z'), 'see [removed] and [removed]');
    assert.equal(scrubNote('edited src/deep/dir/file.ts today'), 'edited [removed] today');
    assert.equal(scrubNote('edited ./lib/a today'), 'edited [removed] today');
    assert.equal(scrubNote('edited lib/a.ts today'), 'edited [removed] today');
  });

  it('removes secret shapes: AWS keys, GitHub tokens, bearer tokens, sk- keys, JWTs, keyed values', () => {
    assert.equal(scrubNote('aws AKIAIOSFODNN7EXAMPLE end'), 'aws [removed] end');
    assert.equal(scrubNote('gh github_pat_11ABCDEFG0123456789_abcdefghijklmnop end'), 'gh [removed] end');
    assert.equal(scrubNote('header Authorization: Bearer abcdEFGH12345678.xyz end'), 'header Authorization: [removed] end');
    assert.equal(scrubNote('key sk-abcdefghijklmnopqrstuvwx end'), 'key [removed] end');
    assert.equal(
      scrubNote('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c end'),
      'jwt [removed] end',
    );
    assert.equal(scrubNote('password: hunter2 and token=abc123'), 'password: [removed] and token=[removed]');
    assert.equal(scrubNote('the password is hunter2 ok'), 'the password is [removed] ok');
  });

  it('removes host names, IP addresses and @mentions, and neutralizes backticks and control characters', () => {
    assert.equal(scrubNote('db at internal.corp.example down'), 'db at [removed] down');
    assert.equal(scrubNote('ip 10.0.0.12 down'), 'ip [removed] down');
    assert.equal(scrubNote('ping @octocat please'), 'ping [removed] please');
    assert.equal(scrubNote('use `rm` now'), "use 'rm' now");
    assert.equal(scrubNote('line one\nline\ttwo\u0000\u202e end'), 'line one line two end');
  });

  it('leaves ordinary words alone', () => {
    const plain = 'slow on first query after branch switch, and/or when the node.js watcher restarts (about 3 times)';
    assert.equal(scrubNote(plain), plain);
  });

  it('is idempotent: scrubbing a scrubbed note changes nothing', () => {
    const once = scrubNote('see /Users/alice/proj/a.ts and bob@corp.com');
    assert.equal(scrubNote(once), once);
  });

  it('scrubs before it cuts, so a secret cannot survive as a fragment at the cut', () => {
    const note = `${'word '.repeat(98)}ghp_0123456789abcdef0123456789abcdef0123 tail`;
    const out = scrubNote(note);
    assert.ok(!out.includes('ghp_'), out);
    assert.ok(!out.includes('0123456789abcdef'), out);
  });
});

describe('scrub caps length', () => {
  it('a note of 2,000 characters is cut at 500 with a marker', () => {
    const out = scrubNote('word '.repeat(400));
    assert.ok(out.endsWith(NOTE_CUT_MARKER), out.slice(-20));
    assert.ok(out.length <= NOTE_MAX_CHARS + NOTE_CUT_MARKER.length);
    assert.equal(out.slice(0, out.length - NOTE_CUT_MARKER.length), 'word '.repeat(400).trim().slice(0, NOTE_MAX_CHARS).trimEnd());
  });

  it('a note within the cap has no marker; an empty or blank note is empty', () => {
    assert.equal(scrubNote('short note'), 'short note');
    assert.equal(scrubNote('x'.repeat(10)), 'x'.repeat(10));
    assert.equal(scrubNote('   \n\t '), '');
    assert.equal(scrubNote(''), '');
  });

  it('a huge input is bounded before it is scanned', () => {
    const out = scrubNote('a '.repeat(5_000_000));
    assert.ok(out.length <= NOTE_MAX_CHARS + NOTE_CUT_MARKER.length);
  });
});

// Sources a Host would assemble; the repository module name is a marker that must never be reported.
const SOURCES: DiagnosticsSources = {
  atlasVersion: '1.2.3',
  catalogVersion: 1,
  platform: { osFamily: 'macOS', osMajor: 27, nodeMajor: 24 },
  agentHost: 'claude-code',
  transport: 'in-process',
  modules: [
    { name: 'typescript', source: 'builtin', tiers: [{ tier: 'grammar', active: true }, { tier: 'precise', active: false }] },
    { name: 'toy', source: 'builtin', tiers: [{ tier: 'grammar', active: true }] },
    { name: 'dormant', source: 'builtin', tiers: [{ tier: 'grammar', active: false }] },
    { name: 'ZEBRA_SYMBOL', source: 'repo', tiers: [{ tier: 'grammar', active: true }] },
    { name: 'home_mod', source: 'user', tiers: [{ tier: 'grammar', active: true }] },
  ],
  index: { files: 1000, errorFiles: 4, sizeBytes: 60 * MB },
  activity: { answersTotal: 200, degradedTotal: 24, latencyP50Ms: 5, latencyP95Ms: 20 },
  worktreeCount: 7,
  errorCodes: { invalid_args: 3, busy: 1, 'bad code': 9, '/home/x': 1, Upper: 2 },
  ratings: [
    { about: 'code_context', value: 'meh' },
    { about: '/home/x/y', value: 'up' },
  ],
  note: 'hello',
};

const BARE: DiagnosticsSources = { atlasVersion: '1', catalogVersion: 1 };

describe('collectors', () => {
  it('platform: the family, the OS major and the Node major only', () => {
    assert.deepEqual(collectType('platform', SOURCES), { os_family: 'macOS', os_major: 27, node_major: 24 });
    assert.deepEqual(collectType('platform', { ...SOURCES, platform: { osFamily: 'FreeBSD', osMajor: null, nodeMajor: 24 } }), {
      os_family: 'other',
      os_major: null,
      node_major: 24,
    });
    assert.deepEqual(collectType('platform', BARE), { os_family: null, os_major: null, node_major: null });
  });

  it('agent setup: a closed list of hosts and transports, "unknown" for anything else', () => {
    assert.deepEqual(collectType('agent_setup', SOURCES), { agent_host: 'claude-code', transport: 'in-process' });
    assert.deepEqual(collectType('agent_setup', { ...SOURCES, agentHost: '../../etc/passwd', transport: 'carrier-pigeon' }), {
      agent_host: 'unknown',
      transport: 'unknown',
    });
    assert.deepEqual(collectType('agent_setup', BARE), { agent_host: 'unknown', transport: null });
  });

  it('languages: only built-in modules, active tiers, three-decimal rates, nothing named by a repository or the user', () => {
    const values = collectType('languages', SOURCES);
    assert.deepEqual(values, {
      languages_active: ['toy', 'typescript'],
      tiers_active: { toy: ['grammar'], typescript: ['grammar'] },
      parse_error_rate: { all: 0.004 },
      degraded_rate: 0.12,
    });
    assert.ok(!JSON.stringify(values).includes('ZEBRA_SYMBOL'));
    assert.ok(!JSON.stringify(values).includes('home_mod'));
  });

  it('languages: rates are null with no files or no answers; modules unknown gives null lists', () => {
    const empty = collectType('languages', {
      ...SOURCES,
      index: { files: 0, errorFiles: 0, sizeBytes: 0 },
      activity: { answersTotal: 0, degradedTotal: 0, latencyP50Ms: null, latencyP95Ms: null },
    });
    assert.equal(empty['parse_error_rate'], null);
    assert.equal(empty['degraded_rate'], null);
    assert.deepEqual(collectType('languages', BARE), { languages_active: null, tiers_active: null, parse_error_rate: null, degraded_rate: null });
    const third = collectType('languages', { ...SOURCES, index: { files: 3, errorFiles: 1, sizeBytes: 0 } });
    assert.deepEqual(third['parse_error_rate'], { all: 0.333 });
    const over = collectType('languages', { ...SOURCES, activity: { answersTotal: 2, degradedTotal: 9, latencyP50Ms: 1, latencyP95Ms: 1 } });
    assert.equal(over['degraded_rate'], 1, 'a rate never exceeds one');
  });

  it('scale: bucket labels only, null where the machine has no number', () => {
    assert.deepEqual(collectType('scale', SOURCES), {
      repo_count_bucket: null,
      repo_size_bucket: null,
      worktree_count_bucket: '6–20',
      agent_concurrency_bucket: null,
    });
    assert.deepEqual(collectType('scale', { ...SOURCES, repoCount: 3, repoLines: 150_000, worktreeCount: 1, agentConcurrency: 100 }), {
      repo_count_bucket: '2–5',
      repo_size_bucket: '100K–500K LOC',
      worktree_count_bucket: '1',
      agent_concurrency_bucket: '51–200',
    });
  });

  it('performance: bucket labels, p50 and p95 from the histogram bounds, breach names from a fixed list', () => {
    assert.deepEqual(collectType('performance', SOURCES), {
      build_time_bucket: null,
      store_size_bucket: '50–100 MB',
      query_latency: { all: { p50_ms: 5, p95_ms: 20 } },
      hook_latency: null,
      budget_breaches: null,
    });
    const full = collectType('performance', { ...SOURCES, buildMs: 12_000, hookP95Ms: 9.4, budgetBreaches: ['store_size', 'store_size', '/home/x', 'warm_query'] });
    assert.deepEqual(full, {
      build_time_bucket: '10–30 s',
      store_size_bucket: '50–100 MB',
      query_latency: { all: { p50_ms: 5, p95_ms: 20 } },
      hook_latency: { p95_ms: 9 },
      budget_breaches: ['store_size', 'warm_query'],
    });
    const idle = collectType('performance', { ...SOURCES, activity: { answersTotal: 0, degradedTotal: 0, latencyP50Ms: null, latencyP95Ms: null } });
    assert.equal(idle['query_latency'], null);
  });

  it('reliability: error codes and counts from a closed shape, never a message', () => {
    assert.deepEqual(collectType('reliability', SOURCES), { error_codes: { invalid_args: 3, busy: 1 }, crash_signature: null });
    assert.deepEqual(collectType('reliability', BARE), { error_codes: null, crash_signature: null });
    assert.deepEqual(collectType('reliability', { ...SOURCES, errorCodes: {} }), { error_codes: {}, crash_signature: null });
  });

  it('agent behaviour is no data yet: null fields, no invented numbers', () => {
    assert.deepEqual(collectType('agent_behavior', SOURCES), { gate_stats: null, atlas_vs_grep: null });
  });

  it('ratings: closed values as the symbols, a closed about, nothing free', () => {
    assert.deepEqual(collectType('ratings', SOURCES), { rating: [{ about: 'code_context', value: '↔' }] });
    assert.deepEqual(
      collectType('ratings', { ...SOURCES, ratings: [{ about: 'session', value: 'up' }, { about: 'last', value: 'down' }] }),
      {
        rating: [
          { about: 'session', value: '↑' },
          { about: 'last', value: '↓' },
        ],
      },
    );
    assert.deepEqual(collectType('ratings', BARE), { rating: null });
  });

  it("notes: the user's own words, scrubbed", () => {
    assert.deepEqual(collectType('notes', SOURCES), { note: 'hello' });
    assert.deepEqual(collectType('notes', { ...SOURCES, note: 'at /home/secret/path hunter2' }), { note: 'at [removed] hunter2' });
    assert.deepEqual(collectType('notes', BARE), { note: null });
    assert.deepEqual(collectType('notes', { ...SOURCES, note: '   ' }), { note: null });
  });

  it('every collector returns exactly the fields the catalog lists for its type', () => {
    for (const type of catalog.types) {
      assert.deepEqual(Object.keys(collectType(type.id, SOURCES)).sort(), type.fields.map((field) => field.name).sort(), type.id);
    }
    assert.deepEqual(collectType('no_such_type', SOURCES), {});
  });

  it('every collected value fits the kind the catalog declares for its field', () => {
    for (const type of catalog.types) {
      const values = collectType(type.id, SOURCES);
      for (const field of type.fields) assert.ok(valueFits(field.kind, values[field.name]), `${type.id}.${field.name}`);
    }
  });
});

/** A consent that approves every type at the catalog's current field list. */
function approveAll(target: Catalog): Consent {
  return {
    catalogVersion: target.catalogVersion,
    types: Object.fromEntries(target.types.map((type) => [type.id, { state: 'approved' as const, fields: type.fields.map((field) => field.name) }])),
  };
}

function collectAll(target: Catalog, sources: DiagnosticsSources): Record<string, Record<string, unknown>> {
  return Object.fromEntries(target.types.map((type) => [type.id, { ...collectType(type.id, sources) }]));
}

describe('report from every approved type', () => {
  it('holds one flat JSON object with the catalog version and every catalog field, in catalog order', () => {
    const report = renderReport({ catalog, consent: approveAll(catalog), values: collectAll(catalog, SOURCES), version: '1.2.3' });
    const wanted = ['catalog_version', ...catalog.types.flatMap((type) => type.fields.map((field) => field.name)).filter((name) => name !== 'catalog_version')];
    assert.deepEqual(Object.keys(report.json), wanted);
    assert.equal(report.title, '[diagnostics] atlas 1.2.3 · macOS 27');
    assert.deepEqual(report.labels, ['diagnostics', 'os:macos']);
    assert.equal(blocks(report.body, 'diagnostics-v1').length, 1);
  });

  it('marks the types with no data yet in the summary, and reports their fields as null', () => {
    const report = renderReport({ catalog, consent: approveAll(catalog), values: collectAll(catalog, SOURCES), version: '1.2.3' });
    assert.equal(report.json['gate_stats'], null);
    assert.equal(report.json['atlas_vs_grep'], null);
    assert.match(report.body, /No data yet \(reported as null\):/);
    assert.match(report.body, /- Agent behaviour: gate_stats, atlas_vs_grep/);
  });

  it('agent behaviour is no data yet: approved alone it contributes null fields and says so, with no numbers', () => {
    const consent: Consent = {
      catalogVersion: 1,
      types: {
        header: { state: 'approved', fields: HEADER_FIELDS },
        agent_behavior: { state: 'approved', fields: ['gate_stats', 'atlas_vs_grep'] },
      },
    };
    const report = renderReport({ catalog, consent, values: collectAll(catalog, SOURCES), version: '1.2.3' });
    assert.deepEqual(report.json, { catalog_version: 1, atlas_version: '1.2.3', gate_stats: null, atlas_vs_grep: null });
    assert.match(report.body, /- Agent behaviour: gate_stats, atlas_vs_grep/);
  });

  it('a value that does not fit its field kind is reported as null, never passed through', () => {
    const values = collectAll(catalog, SOURCES);
    const report = renderReport({
      catalog,
      consent: approveAll(catalog),
      values: { ...values, platform: { os_family: 'macOS', os_major: '27; DROP', node_major: { x: 1 } } },
      version: '1.2.3',
    });
    assert.equal(report.json['os_major'], null);
    assert.equal(report.json['node_major'], null);
  });

  it('the title and labels name an OS only from the closed list', () => {
    const values = { ...collectAll(catalog, SOURCES), platform: { os_family: '/home/secret/path', os_major: 27, node_major: 24 } };
    const report = renderReport({ catalog, consent: approveAll(catalog), values, version: '1.2.3' });
    assert.equal(report.title, '[diagnostics] atlas 1.2.3');
    assert.deepEqual(report.labels, ['diagnostics']);
  });

  it('a user rating adds its symbol and feature to the title and a rating: label, only when ratings is approved', () => {
    const values = collectAll(catalog, SOURCES);
    const withRating = renderReport({ catalog, consent: approveAll(catalog), values, version: '1.2.3', rating: { about: 'code_context', value: 'meh' } });
    assert.equal(withRating.title, '[diagnostics] atlas 1.2.3 · macOS 27 · ↔ code_context');
    assert.deepEqual(withRating.labels, ['diagnostics', 'rating:side', 'os:macos']);
    assert.deepEqual(withRating.json['rating'], [{ about: 'code_context', value: '↔' }]);
    const all = approveAll(catalog);
    const noRatings: Consent = { ...all, types: { ...all.types, ratings: { state: 'denied', fields: [] } } };
    const without = renderReport({ catalog, consent: noRatings, values, version: '1.2.3', rating: { about: 'code_context', value: 'meh' } });
    assert.ok(!without.title.includes('↔'));
    assert.ok(!without.labels.some((label) => label.startsWith('rating:')));
    assert.ok(!('rating' in without.json));
    for (const [value, label] of [['up', 'rating:up'], ['down', 'rating:down']] as const) {
      assert.ok(renderReport({ catalog, consent: approveAll(catalog), values, version: '1.2.3', rating: { about: 'session', value } }).labels.includes(label));
    }
  });

  it('the note is scrubbed again when it is rendered, and only when notes is approved', () => {
    const values = collectAll(catalog, SOURCES);
    const report = renderReport({ catalog, consent: approveAll(catalog), values, version: '1.2.3', note: 'at /home/secret/path with AKIAIOSFODNN7EXAMPLE' });
    assert.equal(report.json['note'], 'at [removed] with [removed]');
    const all = approveAll(catalog);
    const noNotes: Consent = { ...all, types: { ...all.types, notes: { state: 'denied', fields: [] } } };
    const without = renderReport({ catalog, consent: noNotes, values, version: '1.2.3', note: 'hello' });
    assert.ok(!('note' in without.json));
    assert.ok(!without.body.includes('hello'));
  });

  it('a backtick in a value cannot close the fence', () => {
    const values = { ...collectAll(catalog, SOURCES), notes: { note: 'x```\n# injected' } };
    const report = renderReport({ catalog, consent: approveAll(catalog), values, version: '1.2.3' });
    assert.equal((report.body.match(/```/g) ?? []).length, 2);
    assert.equal(blocks(report.body, 'diagnostics-v1').length, 1);
  });

  it('"ask each time" types are left out unless the user said yes for this report', () => {
    const all = approveAll(catalog);
    const asked: Consent = { ...all, types: { ...all.types, platform: { state: 'ask', fields: all.types['platform']?.fields ?? [] } } };
    const values = collectAll(catalog, SOURCES);
    assert.ok(!('os_family' in renderReport({ catalog, consent: asked, values, version: '1.2.3' }).json));
    assert.ok('os_family' in renderReport({ catalog, consent: asked, values, version: '1.2.3', include: ['platform'] }).json);
    assert.ok(!('os_family' in renderReport({ catalog, consent: asked, values, version: '1.2.3', include: ['scale'] }).json));
  });
});

/** Catalog v2: the performance type gains a field and a brand-new type appears. */
function catalogV2(): Catalog {
  const parsed = parseCatalog({
    catalogVersion: 2,
    types: [
      ...catalog.types.map((type) =>
        type.id === 'performance' ? { ...type, fields: [...type.fields, { name: 'queue_depth_bucket', example: '6–20', kind: 'bucket' }] } : type,
      ),
      {
        id: 'hooks',
        title: 'Hooks',
        fields: [{ name: 'hook_events', example: '{"pre":3}', kind: 'map' }],
        howItHelps: 'Shows which hook events fire.',
        cannotReveal: 'What the hooks ran.',
      },
    ],
  });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.catalog;
}

describe('catalog v2 reverts changed type', () => {
  it('a type whose field list changed is denied and listed for review; unchanged types stay approved', () => {
    const tmp = makeTempDir();
    try {
      saveConsent(tmp.path, approveAll(catalog));
      const loaded = loadConsent(tmp.path, catalogV2());
      assert.deepEqual(loaded.needsReview, ['performance']);
      assert.equal(loaded.consent.types['performance']?.state, 'denied');
      assert.deepEqual(loaded.consent.types['performance']?.fields, []);
      for (const id of ['header', 'platform', 'agent_setup', 'languages', 'scale', 'reliability', 'agent_behavior', 'ratings', 'notes']) {
        assert.equal(loaded.consent.types[id]?.state, 'approved', id);
      }
      assert.equal(loaded.consent.catalogVersion, 2);
    } finally {
      tmp.cleanup();
    }
  });

  it('approving again with the new field list restores it', () => {
    const tmp = makeTempDir();
    try {
      saveConsent(tmp.path, approveAll(catalog));
      const v2 = catalogV2();
      const first = loadConsent(tmp.path, v2);
      const performance = v2.types.find((type) => type.id === 'performance');
      assert.ok(performance !== undefined);
      const again: Consent = {
        ...first.consent,
        types: { ...first.consent.types, performance: { state: 'approved', fields: performance.fields.map((field) => field.name) } },
      };
      assert.deepEqual(saveConsent(tmp.path, again), { ok: true });
      const loaded = loadConsent(tmp.path, v2);
      assert.deepEqual(loaded.needsReview, []);
      assert.equal(loaded.consent.types['performance']?.state, 'approved');
      assert.ok(loaded.consent.types['performance']?.fields.includes('queue_depth_bucket'));
    } finally {
      tmp.cleanup();
    }
  });

  it('reapprovalNeeded names the changed types of a consent against a newer catalog', () => {
    const v2 = catalogV2();
    assert.deepEqual(reapprovalNeeded(approveAll(catalog), v2), ['performance']);
    assert.deepEqual(reapprovalNeeded(approveAll(catalog), catalog), []);
    assert.deepEqual(reapprovalNeeded(emptyConsent(catalog), v2), [], 'a denied type needs nothing');
  });

  it('renderReport itself refuses a type approved against an older field list', () => {
    const v2 = catalogV2();
    const report = renderReport({ catalog: v2, consent: approveAll(catalog), values: collectAll(v2, SOURCES), version: '1.2.3' });
    assert.ok(!('store_size_bucket' in report.json));
    assert.ok('os_family' in report.json);
  });

  it('a saved denied type with a changed field list stays denied and needs no review', () => {
    const tmp = makeTempDir();
    try {
      const all = approveAll(catalog);
      saveConsent(tmp.path, { ...all, types: { ...all.types, performance: { state: 'denied', fields: [] } } });
      assert.deepEqual(loadConsent(tmp.path, catalogV2()).needsReview, []);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('new type absent until approved', () => {
  it('a type the saved file does not mention is denied and listed as new', () => {
    const tmp = makeTempDir();
    try {
      saveConsent(tmp.path, approveAll(catalog));
      const v2 = catalogV2();
      const loaded = loadConsent(tmp.path, v2);
      assert.equal(loaded.consent.types['hooks']?.state, 'denied');
      assert.deepEqual(loaded.newTypes, ['hooks']);
      const values = { ...collectAll(v2, SOURCES), hooks: { hook_events: { pre: 3 } } };
      const report = renderReport({ catalog: v2, consent: loaded.consent, values, version: '1.2.3' });
      assert.ok(!('hook_events' in report.json), 'the new type is absent from the report');
      assert.ok(!report.body.includes('Hooks'));
    } finally {
      tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Acceptance test 4: a repository full of identifying strings and secrets, indexed through the in-process Host.
// ---------------------------------------------------------------------------------------------------------------------

const MARKERS = ['ZEBRA_SYMBOL', '/home/secret/path', 'AKIAIOSFODNN7EXAMPLE', 'internal.corp.example', 'hunter2'] as const;
const TOY_MODULES = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules');
/** Setup commands (init, add, commit, branch, remote) are not in the production allowlist: setup uses the allow-all rule. */
const setupRunner = createRealRunner({ decide: allowAll });

/** The hostile repository: every marker sits in a file name, a symbol, a doc comment, a branch, a remote, a commit message or a committed config. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'ZEBRA_SYMBOL.toy': '// hunter2 AKIAIOSFODNN7EXAMPLE /home/secret/path\nfn ZEBRA_SYMBOL {\n  boot();\n}\nfn boot {\n}\n',
  'internal.corp.example.toy': 'fn helper {\n}\n',
  'README.md': '# ZEBRA_SYMBOL at internal.corp.example, password hunter2\n',
  '.gsd-atlas/config.json': JSON.stringify({ diagnostics: { enabled: true }, autoSubmit: true, token: 'AKIAIOSFODNN7EXAMPLE', host: 'internal.corp.example' }),
};

interface Fixture {
  readonly host: Host;
  readonly userDir: string;
  readonly repoDir: string;
  ask(args: Record<string, unknown>): Promise<Envelope>;
  cleanup(): Promise<void>;
}

async function hostileFixture(): Promise<Fixture> {
  const repo = await createTempGitRepo({ runner: setupRunner, world: { committed: FIXTURE_FILES } });
  await repo.git(['checkout', '-q', '-b', 'feature/ZEBRA_SYMBOL-hunter2']);
  await repo.git(['remote', 'add', 'origin', 'https://internal.corp.example/ZEBRA_SYMBOL.git']);
  repo.write('notes.toy', 'fn later {\n}\n');
  await repo.commitAll('touch /home/secret/path for hunter2');
  const tmp = makeTempDir();
  const userDir = path.join(tmp.path, 'user');
  const engine = createGrammarEngine();
  const manual = createManualEventSource();
  const host = createHost({
    roots: { repoRoot: repo.dir, userDir, builtinDir: TOY_MODULES, npmRoots: [] },
    engine,
    runner: createRealRunner(),
    cwd: repo.dir,
    userDir,
    cacheRoot: path.join(tmp.path, 'cache'),
    gitEnv: repo.envOverlay,
    eventSource: () => manual.source,
    version: '1.2.3',
  });
  const send = (kind: string, args: Record<string, unknown>): Promise<Envelope> => host.handle({ protocol: PROTOCOL_VERSION, kind, args });
  return {
    host,
    userDir,
    repoDir: repo.dir,
    ask: (args) => send('diagnostics', args),
    async cleanup() {
      await host.close();
      await engine.dispose();
      tmp.cleanup();
      repo.cleanup();
    },
  };
}

describe('privacy fixture contains no marker', () => {
  it('every type but notes approved plus a note that carries markers: none of the five markers reaches the title, labels, body or JSON', async () => {
    const f = await hostileFixture();
    try {
      // Index the repository first, so the report is built from a real index, real counters and a real recorder.
      const built = await f.host.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: f.repoDir } });
      assert.equal(built.ok, true, JSON.stringify(built.diagnostics));
      for (const name of ['boot', 'helper', 'ZEBRA_SYMBOL']) {
        await f.host.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { name, repo: f.repoDir } });
      }
      // A refused request leaves an outcome code in the recorder.
      await f.host.handle({ protocol: PROTOCOL_VERSION, kind: 'code_find', args: { repo: f.repoDir } });

      const catalogForFixture = loadCatalog(defaultCatalogDir());
      saveConsent(f.userDir, approveAll(catalogForFixture));
      const note = 'slow after switching, see /home/secret/path/x.ts and key AKIAIOSFODNN7EXAMPLE, host internal.corp.example';
      const reply = await f.ask({ action: 'preview', repo: f.repoDir, note, rating: 'meh', about: 'code_context' });
      assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
      const data = reply.data as { enabled: boolean; title: string; labels: string[]; body: string; json: Record<string, unknown> };
      assert.equal(data.enabled, true);

      // Not vacuous: the report really holds machine facts, the index figures and the scrubbed note.
      assert.equal(data.json['atlas_version'], '1.2.3');
      assert.equal(typeof data.json['os_family'], 'string');
      assert.equal(typeof data.json['node_major'], 'number');
      assert.equal(data.json['worktree_count_bucket'], '1');
      assert.equal(typeof data.json['store_size_bucket'], 'string');
      assert.notEqual(data.json['parse_error_rate'], null);
      assert.equal(data.json['note'], 'slow after switching, see [removed] and key [removed], host [removed]');
      assert.deepEqual(data.json['rating'], [{ about: 'code_context', value: '↔' }]);
      assert.ok(data.title.includes('↔ code_context'));
      assert.deepEqual(data.json['languages_active'], ['toy']);

      const everything = [data.title, ...data.labels, data.body, JSON.stringify(data.json), JSON.stringify(reply)].join('\n');
      for (const marker of MARKERS) {
        assert.ok(!everything.includes(marker), `the report carries ${marker}`);
      }
      // The repository's temporary location, its commit message and its remote are not there either.
      assert.ok(!everything.includes(f.repoDir));
      assert.ok(!everything.includes('origin'));
    } finally {
      await f.cleanup();
    }
  });

  it('the same holds with only the platform and languages types approved, and for the walkthrough values of every type', async () => {
    const f = await hostileFixture();
    try {
      await f.host.handle({ protocol: PROTOCOL_VERSION, kind: 'build', args: { repo: f.repoDir } });
      saveConsent(f.userDir, approveAll(loadCatalog(defaultCatalogDir())));
      const reply = await f.ask({ action: 'types', repo: f.repoDir });
      assert.equal(reply.ok, true, JSON.stringify(reply.diagnostics));
      const text = JSON.stringify(reply);
      for (const marker of MARKERS) assert.ok(!text.includes(marker), `the walkthrough shows ${marker}`);
      assert.ok(!text.includes(f.repoDir));
    } finally {
      await f.cleanup();
    }
  });
});
