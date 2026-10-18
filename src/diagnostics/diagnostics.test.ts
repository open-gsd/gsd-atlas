/**
 * User-controlled diagnostics (SKL-03; docs/DIAGNOSTICS.md, draft ADR "user-controlled diagnostics"). Task 1 of plan
 * 03-21: the catalog, the consent file and the report layout, proved with the smallest report there is (the header).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../test-kit/index.ts';
import { CATALOG_VERSION, defaultCatalogDir, loadCatalog, parseCatalog } from './catalog.ts';
import type { Catalog } from './catalog.ts';
import { CONSENT_FILE, CONSENT_MAX_BYTES, emptyConsent, loadConsent, saveConsent } from './consent.ts';
import type { Consent } from './consent.ts';
import { collectType } from './collect.ts';
import { renderReport } from './preview.ts';

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
