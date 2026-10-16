import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020Module from 'ajv/dist/2020.js';

import { runSchemaBuild } from '../../scripts/schema-lib.ts';
import { makeTempDir } from '../test-kit/index.ts';
import { manifestJsonSchema, parseManifest } from './manifest.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = path.join(root, 'test', 'fixtures', 'manifests');
const schemaPath = path.join(root, 'schemas', 'atlas-lang.schema.json');

// ajv is a CommonJS package: under nodenext the class sits on `.default` of the default import.
type AjvCtor = new (options: { allErrors: boolean }) => {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown };
};
const Ajv2020 = (Ajv2020Module as unknown as { default: AjvCtor }).default;

const committedText = readFileSync(schemaPath, 'utf8');
const committed = JSON.parse(committedText) as Record<string, unknown>;

// Compile the committed file, not the in-memory schema, so drift fails here too.
// Default (strict) Ajv options are enough for what Zod emits; allErrors only widens reporting.
const validate = new Ajv2020({ allErrors: true }).compile(committed);

function fixtures(): string[] {
  return readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

// In-process: src/ must not spawn child processes (FND-06), so the CLI logic is called directly.
function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return runSchemaBuild(args);
}

/** Collect every object-typed schema node reachable through properties / items / anyOf. */
function objectNodes(node: unknown, found: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (node === null || typeof node !== 'object') return found;
  const n = node as Record<string, unknown>;
  if (n.type === 'object') found.push(n);
  const props = n.properties;
  if (props !== undefined && props !== null && typeof props === 'object') {
    for (const child of Object.values(props)) objectNodes(child, found);
  }
  objectNodes(n.items, found);
  if (Array.isArray(n.anyOf)) for (const child of n.anyOf) objectNodes(child, found);
  return found;
}

describe('committed JSON Schema', () => {
  it('equals the generated schema byte for byte, with LF endings', () => {
    const generated = `${JSON.stringify(manifestJsonSchema(), null, 2)}\n`;
    assert.equal(committedText, generated);
    assert.ok(!committedText.includes('\r'), 'committed schema must use LF endings');
  });

  it('declares draft 2020-12, the urn id and a title', () => {
    assert.equal(committed.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(committed.$id, 'urn:gsd-atlas:schema:atlas-lang:1');
    assert.equal(committed.title, 'gsd-atlas language module manifest');
  });

  it('forbids additional properties at every object level', () => {
    const nodes = objectNodes(committed);
    assert.ok(nodes.length >= 5, `expected nested objects, found ${nodes.length}`);
    for (const node of nodes) assert.equal(node.additionalProperties, false);
  });

  it('requires exactly the required fields (defaulted fields are not required)', () => {
    assert.deepEqual(
      [...(committed.required as string[])].sort(),
      ['extensions', 'grammar', 'name', 'queries', 'schemaVersion'],
    );
    const properties = committed.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(
      [...(properties.grammar?.required as string[])].sort(),
      ['lock', 'wasm'],
    );
    assert.deepEqual(properties.queries?.required, ['tags']);
  });

  it('carries the shared path rule as a pattern on every asset path field', () => {
    const properties = committed.properties as Record<string, Record<string, unknown>>;
    const grammar = properties.grammar?.properties as Record<string, Record<string, unknown>>;
    const queries = properties.queries?.properties as Record<string, Record<string, unknown>>;
    const patterns = [
      grammar.wasm?.pattern,
      grammar.lock?.pattern,
      queries.tags?.pattern,
      queries.refs?.pattern,
      queries.imports?.pattern,
      properties.features?.pattern,
    ];
    for (const p of patterns) assert.equal(typeof p, 'string');
    assert.equal(new Set(patterns).size, 1, 'one shared pattern for all asset paths');
  });
});

describe('Zod and Ajv agree on every fixture', () => {
  const files = fixtures();

  it('exercises the full fixture set', () => {
    assert.equal(files.length, 12);
  });

  for (const file of files) {
    it(`${file}: Zod verdict equals Ajv verdict equals ${file.startsWith('valid-')}`, () => {
      const data = JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf8')) as unknown;
      const zodOk = parseManifest(data, file).ok;
      const ajvOk = validate(data);
      assert.equal(zodOk, ajvOk, `Zod=${zodOk} Ajv=${ajvOk} ${JSON.stringify(validate.errors)}`);
      assert.equal(zodOk, file.startsWith('valid-'));
    });
  }
});

describe('Zod and Ajv agree on inline edge cases', () => {
  const base = {
    schemaVersion: 1,
    name: 'edge',
    extensions: ['.e'],
    grammar: { wasm: 'g/a.wasm', lock: 'g/lock' },
    queries: { tags: 'q/tags.scm' },
  };
  const cases: Array<[string, unknown]> = [
    ['precise command', { ...base, precise: { command: ['x'] } }],
    ['precise adapter', { ...base, precise: { adapter: 'typescript-6' } }],
    ['precise both', { ...base, precise: { command: ['x'], adapter: 'y' } }],
    ['precise empty command', { ...base, precise: { command: [] } }],
    ['precise empty object', { ...base, precise: {} }],
    ['NUL in path', { ...base, queries: { tags: 'a\u0000b' } }],
    ['nested ..', { ...base, queries: { tags: 'a/../b' } }],
    ['trailing ..', { ...base, queries: { tags: 'a/..' } }],
    ['dots inside a name', { ...base, queries: { tags: 'a..b/c' } }],
    ['lower drive letter', { ...base, features: 'c:x' }],
    ['newline then backslash', { ...base, features: 'a\n\\b' }],
    ['empty path', { ...base, queries: { tags: '' } }],
    ['name 64 chars', { ...base, name: 'a'.repeat(64) }],
    ['name 65 chars', { ...base, name: 'a'.repeat(65) }],
    ['33 extensions', { ...base, extensions: Array(33).fill('.a') }],
    ['bad version', { ...base, version: '1.0' }],
    ['parseBudget 0', { ...base, parseBudget: 0 }],
    ['parseBudget -1', { ...base, parseBudget: -1 }],
    ['empty tiers', { ...base, tiers: [] }],
    ['unknown tier', { ...base, tiers: ['nope'] }],
    ['project unknown key', { ...base, project: { other: 1 } }],
    ['project model not kebab', { ...base, project: { model: 'Not Kebab' } }],
    ['replace not boolean', { ...base, replace: 'yes' }],
    ['$schema number', { ...base, $schema: 1 }],
    ['not an object', 'text'],
    ['array', []],
    ['null', null],
  ];
  for (const [label, data] of cases) {
    it(label, () => {
      const zodOk = parseManifest(data).ok;
      const ajvOk = validate(data);
      assert.equal(zodOk, ajvOk, `Zod=${zodOk} Ajv=${ajvOk} ${JSON.stringify(validate.errors)}`);
    });
  }
});

describe('scripts/schema-build.ts --check', () => {
  it('exits 0 on the committed file', () => {
    const result = runScript(['--check']);
    assert.equal(result.status, 0, result.stderr);
  });

  it('exits 1 and names the fix command when the file has drifted', () => {
    const tmp = makeTempDir();
    try {
      const file = path.join(tmp.path, 'drifted.schema.json');
      writeFileSync(file, committedText.replace('language module manifest', 'language module manifesT'));
      const result = runScript(['--check', file]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes('npm run schema:build'), result.stderr);
    } finally {
      tmp.cleanup();
    }
  });

  it('exits 1 when the file is missing', () => {
    const tmp = makeTempDir();
    try {
      const result = runScript(['--check', path.join(tmp.path, 'absent.json')]);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes('npm run schema:build'), result.stderr);
    } finally {
      tmp.cleanup();
    }
  });

  it('treats CRLF line endings as equal (checkout normalisation)', () => {
    const tmp = makeTempDir();
    try {
      const file = path.join(tmp.path, 'crlf.schema.json');
      writeFileSync(file, committedText.replace(/\n/g, '\r\n'));
      assert.equal(runScript(['--check', file]).status, 0);
    } finally {
      tmp.cleanup();
    }
  });

  it('writes the schema with LF endings when given an output path and no flag', () => {
    const tmp = makeTempDir();
    try {
      const file = path.join(tmp.path, 'out.schema.json');
      const result = runScript([file]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(file, 'utf8'), committedText);
    } finally {
      tmp.cleanup();
    }
  });
});
