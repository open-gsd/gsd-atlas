import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MANIFEST_SCHEMA_VERSION, SUPPORTED_MANIFEST_VERSIONS, adrDirsOf, parseManifest } from './manifest.ts';

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'manifests',
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8')) as unknown;
}

/** invalid fixture -> text that its single diagnostic message must contain (the failing field path). */
const INVALID_CASES: Record<string, string> = {
  'invalid-unknown-field.json': 'bogus',
  'invalid-schema-version.json': 'schemaVersion',
  'invalid-missing-name.json': 'name',
  'invalid-name-case.json': 'name',
  'invalid-absolute-wasm.json': 'grammar.wasm',
  'invalid-drive-letter.json': 'grammar.wasm',
  'invalid-dotdot-query.json': 'queries.tags',
  'invalid-backslash-path.json': 'grammar.wasm',
  'invalid-empty-extensions.json': 'extensions',
  'invalid-parse-budget.json': 'parseBudget',
  'invalid-v1-adrdirs.json': 'project.adrDirs',
};

/** A known-good manifest used as the base for inline mutations. */
function good(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'inline-lang',
    extensions: ['.il'],
    grammar: { wasm: 'grammar/a.wasm', lock: 'grammar/grammar.lock' },
    queries: { tags: 'queries/tags.scm' },
  };
}

describe('manifest fixtures', () => {
  it('ships exactly fourteen fixtures: three valid and eleven invalid', () => {
    const files = readdirSync(fixtureDir).filter((f) => f.endsWith('.json'));
    assert.deepEqual(files.filter((f) => f.startsWith('valid-')).sort(), ['valid-full.json', 'valid-minimal.json', 'valid-v2-adrdirs.json']);
    assert.deepEqual(
      files.filter((f) => f.startsWith('invalid-')).sort(),
      Object.keys(INVALID_CASES).sort(),
    );
  });

  it('writes new manifests at schema version 2 and reads versions 1 and 2', () => {
    assert.equal(MANIFEST_SCHEMA_VERSION, 2);
    assert.deepEqual([...SUPPORTED_MANIFEST_VERSIONS], [1, 2]);
  });

  it('valid-v2-adrdirs.json parses with its ADR directories carried through, and a version 1 manifest names none', () => {
    const result = parseManifest(loadFixture('valid-v2-adrdirs.json'), 'valid-v2-adrdirs.json');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.schemaVersion, 2);
    assert.deepEqual(adrDirsOf(result.manifest), ['docs/adr', 'doc/adr']);
    assert.deepEqual(result.manifest.project, { markers: ['fixture.toml'], model: 'fixture-project', adrDirs: ['docs/adr', 'doc/adr'] });

    const v1 = parseManifest(loadFixture('valid-minimal.json'));
    assert.equal(v1.ok, true);
    if (v1.ok) assert.deepEqual(adrDirsOf(v1.manifest), []);
    const bare = parseManifest({ ...good(), schemaVersion: 2 });
    assert.equal(bare.ok, true);
    if (bare.ok) assert.deepEqual(adrDirsOf(bare.manifest), [], 'a version 2 manifest that names no ADR directory names none');
  });

  it('valid-minimal.json parses and gets the defaults parseBudget 0.005 and tiers ["grammar"]', () => {
    const result = parseManifest(loadFixture('valid-minimal.json'), 'valid-minimal.json');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.parseBudget, 0.005);
    assert.deepEqual(result.manifest.tiers, ['grammar']);
    assert.equal(result.manifest.name, 'fixture-lang');
    assert.equal(result.manifest.precise, undefined);
  });

  it('valid-full.json parses with every field of the chosen option carried through', () => {
    const result = parseManifest(loadFixture('valid-full.json'));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const m = result.manifest;
    assert.equal(m.$schema, 'https://example.invalid/atlas-lang.schema.json');
    assert.equal(m.version, '1.2.3-beta.1');
    assert.equal(m.replace, true);
    assert.equal(m.parseBudget, 0.01);
    assert.deepEqual(m.tiers, ['grammar', 'precise', 'platform']);
    assert.deepEqual(m.testGlobs, ['test/**/*.fx', 'fixtures/*.fxi']);
    assert.equal(m.features, 'features.json');
    assert.deepEqual(m.project, {
      markers: ['fixture.toml', 'Fixture.lock'],
      model: 'fixture-project',
    });
    assert.deepEqual(m.precise, { command: ['fixture-indexer', '--json'] });
    assert.equal(m.queries.refs, 'queries/refs.scm');
    assert.equal(m.queries.imports, 'queries/imports.scm');
  });

  for (const [file, needle] of Object.entries(INVALID_CASES)) {
    it(`${file} is rejected with a manifest_invalid warning naming "${needle}"`, () => {
      const result = parseManifest(loadFixture(file), file);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(result.diagnostics.length >= 1);
      for (const d of result.diagnostics) {
        assert.equal(d.code, 'manifest_invalid');
        assert.equal(d.severity, 'warning');
        assert.equal(d.subject, file);
      }
      assert.ok(
        result.diagnostics.some((d) => d.message.includes(needle)),
        `no diagnostic names ${needle}: ${JSON.stringify(result.diagnostics)}`,
      );
    });
  }
});

describe('the built-in modules (plan 03-28)', () => {
  const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');

  for (const name of ['typescript', 'javascript']) {
    it(`${name} is a version 2 manifest with the ADR directory convention list`, () => {
      const json = JSON.parse(readFileSync(path.join(modulesDir, name, 'atlas-lang.json'), 'utf8')) as unknown;
      const result = parseManifest(json, name);
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(result.manifest.schemaVersion, 2);
      assert.deepEqual(adrDirsOf(result.manifest), ['docs/adr', 'docs/adrs', 'doc/adr', 'adr']);
    });
  }
});

describe('parseManifest never throws', () => {
  for (const [label, input] of [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'text'],
    ['an array', []],
    ['a number', 42],
    ['an empty object', {}],
  ] as const) {
    it(`returns diagnostics for ${label}`, () => {
      const result = parseManifest(input);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(result.diagnostics.length >= 1);
      assert.equal(result.diagnostics[0]?.code, 'manifest_invalid');
    });
  }

  it('survives a hostile object whose property access throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    const result = parseManifest(hostile);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.diagnostics[0]?.code, 'manifest_invalid');
  });
});

describe('manifest field rules', () => {
  it('accepts the optional $schema editor key', () => {
    const m = { ...good(), $schema: './atlas-lang.schema.json' };
    assert.equal(parseManifest(m).ok, true);
  });

  it('rejects a non-string $schema', () => {
    assert.equal(parseManifest({ ...good(), $schema: 1 }).ok, false);
  });

  it('rejects unknown keys at every nested object level', () => {
    const base = good();
    assert.equal(
      parseManifest({ ...base, grammar: { wasm: 'a.wasm', lock: 'l', extra: 1 } }).ok,
      false,
    );
    assert.equal(parseManifest({ ...base, queries: { tags: 't.scm', extra: 1 } }).ok, false);
    assert.equal(parseManifest({ ...base, project: { markers: ['x'], extra: 1 } }).ok, false);
  });

  it('reports a nested unknown key with its full path', () => {
    const result = parseManifest({ ...good(), queries: { tags: 't.scm', extra: 1 } });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.diagnostics.some((d) => d.message.includes('queries.extra')));
  });

  it('rejects absolute, drive-letter, backslash, NUL and .. forms on every asset path field', () => {
    const bad = [
      '/abs/x.scm',
      'C:/x.scm',
      'c:x.scm',
      'dir\\x.scm',
      'a\u0000b.scm',
      '..',
      '../x.scm',
      'a/../x.scm',
      'a/..',
      '',
    ];
    const fields: Array<(p: string) => Record<string, unknown>> = [
      (p) => ({ ...good(), grammar: { wasm: p, lock: 'l' } }),
      (p) => ({ ...good(), grammar: { wasm: 'w', lock: p } }),
      (p) => ({ ...good(), queries: { tags: p } }),
      (p) => ({ ...good(), queries: { tags: 't', refs: p } }),
      (p) => ({ ...good(), queries: { tags: 't', imports: p } }),
      (p) => ({ ...good(), features: p }),
    ];
    for (const make of fields) {
      for (const p of bad) {
        assert.equal(parseManifest(make(p)).ok, false, `accepted ${JSON.stringify(p)}`);
      }
    }
  });

  it('accepts ordinary relative asset paths, including names that merely contain dots', () => {
    for (const p of ['a.scm', 'dir/a.scm', './a.scm', 'a..b/c', '..hidden/x', 'dir/.hidden']) {
      const m = { ...good(), queries: { tags: p } };
      assert.equal(parseManifest(m).ok, true, `rejected ${p}`);
    }
  });

  it('enforces name, version and extension shapes', () => {
    assert.equal(parseManifest({ ...good(), name: '9lang' }).ok, false);
    assert.equal(parseManifest({ ...good(), name: 'a'.repeat(65) }).ok, false);
    assert.equal(parseManifest({ ...good(), name: 'a'.repeat(64) }).ok, true);
    assert.equal(parseManifest({ ...good(), version: '1.0' }).ok, false);
    assert.equal(parseManifest({ ...good(), version: '1.0.0' }).ok, true);
    assert.equal(parseManifest({ ...good(), extensions: ['ts'] }).ok, false);
    assert.equal(parseManifest({ ...good(), extensions: ['.t.s'] }).ok, false);
    assert.equal(parseManifest({ ...good(), extensions: Array(33).fill('.a') }).ok, false);
    assert.equal(parseManifest({ ...good(), extensions: Array(32).fill('.a') }).ok, true);
  });

  it('enforces tiers and parseBudget bounds', () => {
    assert.equal(parseManifest({ ...good(), tiers: [] }).ok, false);
    assert.equal(parseManifest({ ...good(), tiers: ['bogus'] }).ok, false);
    assert.equal(parseManifest({ ...good(), tiers: ['precise'] }).ok, true);
    assert.equal(parseManifest({ ...good(), parseBudget: -0.1 }).ok, false);
    assert.equal(parseManifest({ ...good(), parseBudget: 1 }).ok, true);
    assert.equal(parseManifest({ ...good(), parseBudget: 0 }).ok, true);
  });

  it('accepts precise as either {command} or {adapter} and never both', () => {
    assert.equal(parseManifest({ ...good(), precise: { command: ['idx'] } }).ok, true);
    assert.equal(parseManifest({ ...good(), precise: { adapter: 'typescript-6' } }).ok, true);
    assert.equal(parseManifest({ ...good(), precise: { command: [] } }).ok, false);
    assert.equal(parseManifest({ ...good(), precise: { command: [''] } }).ok, false);
    assert.equal(parseManifest({ ...good(), precise: { adapter: 'Not Kebab' } }).ok, false);
    assert.equal(
      parseManifest({ ...good(), precise: { command: ['idx'], adapter: 'typescript-6' } }).ok,
      false,
    );
    assert.equal(parseManifest({ ...good(), precise: {} }).ok, false);
  });

  it('enforces project and replace shapes', () => {
    assert.equal(parseManifest({ ...good(), project: {} }).ok, true);
    assert.equal(parseManifest({ ...good(), project: { model: 'Bad Model' } }).ok, false);
    assert.equal(parseManifest({ ...good(), replace: 'yes' }).ok, false);
    assert.equal(parseManifest({ ...good(), testGlobs: [1] }).ok, false);
  });

  it('project.adrDirs: at most eight relative paths, only from version 2', () => {
    const v2 = (adrDirs: unknown): Record<string, unknown> => ({ ...good(), schemaVersion: 2, project: { adrDirs } });
    assert.equal(parseManifest(v2(['docs/adr'])).ok, true);
    assert.equal(parseManifest(v2([])).ok, true);
    assert.equal(parseManifest(v2(Array.from({ length: 8 }, (_, i) => `d${String(i)}/adr`))).ok, true);
    assert.equal(parseManifest(v2(Array.from({ length: 9 }, (_, i) => `d${String(i)}/adr`))).ok, false, 'more than eight');
    for (const bad of ['../adr', 'docs/../../etc', '..', '/abs/adr', 'C:/adr', 'c:adr', 'docs\\adr', 'a\u0000b', '']) {
      assert.equal(parseManifest(v2([bad])).ok, false, `accepted ${JSON.stringify(bad)}`);
      assert.equal(parseManifest(v2(['docs/adr', bad])).ok, false, `accepted ${JSON.stringify(bad)} beside a good entry`);
    }
    assert.equal(parseManifest(v2('docs/adr')).ok, false, 'a string is not a list');
    assert.equal(parseManifest(v2([1])).ok, false);
    assert.equal(parseManifest({ ...good(), schemaVersion: 1, project: { adrDirs: ['docs/adr'] } }).ok, false, 'version 1 has no adrDirs');
    const refused = parseManifest({ ...good(), schemaVersion: 1, project: { adrDirs: ['docs/adr'] } });
    assert.ok(!refused.ok && refused.diagnostics.some((d) => d.message.includes('project.adrDirs')));
    assert.equal(parseManifest({ ...good(), schemaVersion: 3 }).ok, false, 'a future version is refused');
    assert.equal(parseManifest({ ...good(), schemaVersion: '2' }).ok, false, 'the version is a number');
  });

  it('treats precise.command as data: parsing never spawns or resolves it', () => {
    const marker = 'definitely-not-an-executable-gsd-atlas-test';
    const result = parseManifest({ ...good(), precise: { command: [marker] } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.manifest.precise, { command: [marker] });
  });
});
