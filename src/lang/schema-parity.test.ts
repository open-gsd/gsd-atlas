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
  if (Array.isArray(n.oneOf)) for (const child of n.oneOf) objectNodes(child, found);
  return found;
}

type Node = Record<string, unknown>;

/** The schema of each manifest version: the committed document is one `oneOf` over version 1 and version 2. */
function variants(): readonly [Node, Node] {
  const list = committed.oneOf as Node[];
  assert.equal(Array.isArray(list) && list.length, 2, 'the one document describes both versions');
  return [list[0] as Node, list[1] as Node];
}

const versionOf = (variant: Node): unknown => ((variant.properties as Record<string, Node>).schemaVersion as Node).const;

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

  it('requires exactly the required fields in each version (defaulted fields are not required)', () => {
    const [one, two] = variants();
    assert.deepEqual([versionOf(one), versionOf(two)], [1, 2]);
    for (const variant of [one, two]) {
      assert.deepEqual([...(variant.required as string[])].sort(), ['extensions', 'grammar', 'name', 'queries', 'schemaVersion']);
      const properties = variant.properties as Record<string, Record<string, unknown>>;
      assert.deepEqual([...(properties.grammar?.required as string[])].sort(), ['lock', 'wasm']);
      assert.deepEqual(properties.queries?.required, ['tags']);
    }
  });

  it('carries the shared path rule as a pattern on every asset path field, adrDirs included', () => {
    const [one, two] = variants();
    const all = new Set<unknown>();
    for (const variant of [one, two]) {
      const properties = variant.properties as Record<string, Record<string, unknown>>;
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
      for (const p of patterns) all.add(p);
    }
    const adrDirs = (((two.properties as Record<string, Node>).project as Node).properties as Record<string, Node>).adrDirs as Node;
    assert.equal(adrDirs.maxItems, 8);
    assert.equal((adrDirs.items as Node).pattern, [...all][0], 'adrDirs entries follow the same path rule');
  });

  it('documents project.adrDirs in version 2 only', () => {
    const [one, two] = variants();
    const projectKeys = (variant: Node): string[] => Object.keys(((variant.properties as Record<string, Node>).project as Node).properties as Node).sort();
    assert.deepEqual(projectKeys(one), ['markers', 'model']);
    assert.deepEqual(projectKeys(two), ['adrDirs', 'markers', 'model']);
  });
});

describe('Zod and Ajv agree on every fixture', () => {
  const files = fixtures();

  it('exercises the full fixture set', () => {
    assert.equal(files.length, 14);
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
    ['v2 adrDirs', { ...base, schemaVersion: 2, project: { adrDirs: ['docs/adr', 'adr'] } }],
    ['v2 empty adrDirs', { ...base, schemaVersion: 2, project: { adrDirs: [] } }],
    ['v2 eight adrDirs', { ...base, schemaVersion: 2, project: { adrDirs: Array.from({ length: 8 }, (_, i) => `d${String(i)}`) } }],
    ['v2 nine adrDirs', { ...base, schemaVersion: 2, project: { adrDirs: Array.from({ length: 9 }, (_, i) => `d${String(i)}`) } }],
    ['v2 adrDirs dotdot', { ...base, schemaVersion: 2, project: { adrDirs: ['../adr'] } }],
    ['v2 adrDirs nested dotdot', { ...base, schemaVersion: 2, project: { adrDirs: ['a/../../b'] } }],
    ['v2 adrDirs absolute', { ...base, schemaVersion: 2, project: { adrDirs: ['/etc'] } }],
    ['v2 adrDirs drive letter', { ...base, schemaVersion: 2, project: { adrDirs: ['C:/adr'] } }],
    ['v2 adrDirs backslash', { ...base, schemaVersion: 2, project: { adrDirs: ['docs\\adr'] } }],
    ['v2 adrDirs NUL', { ...base, schemaVersion: 2, project: { adrDirs: ['a\u0000b'] } }],
    ['v2 adrDirs empty entry', { ...base, schemaVersion: 2, project: { adrDirs: [''] } }],
    ['v2 adrDirs not a list', { ...base, schemaVersion: 2, project: { adrDirs: 'docs/adr' } }],
    ['v2 project unknown key', { ...base, schemaVersion: 2, project: { other: 1 } }],
    ['v1 adrDirs', { ...base, schemaVersion: 1, project: { adrDirs: ['docs/adr'] } }],
    ['v1 empty adrDirs', { ...base, schemaVersion: 1, project: { adrDirs: [] } }],
    ['version 3', { ...base, schemaVersion: 3 }],
    ['version 0', { ...base, schemaVersion: 0 }],
    ['version as text', { ...base, schemaVersion: '2' }],
    ['version missing', { name: 'edge', extensions: ['.e'], grammar: { wasm: 'g/a.wasm', lock: 'g/lock' }, queries: { tags: 'q/tags.scm' } }],
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
