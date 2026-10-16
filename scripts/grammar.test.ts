import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Language, Parser } from 'web-tree-sitter';
import { parseGrammarLock } from '../src/lang/grammar-lock.ts';
import { parseCliVersion } from './ensure-tree-sitter.ts';
import { checkAgainstLock, sha256Hex } from './grammar-build.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const toyDir = path.join(repoRoot, 'test', 'fixtures', 'modules', 'toy');

function readToyLock() {
  const text = fs.readFileSync(path.join(toyDir, 'grammar.lock'), 'utf8');
  const parsed = parseGrammarLock(text, 'test/fixtures/modules/toy/grammar.lock');
  assert.equal(parsed.ok, true, 'toy grammar.lock must parse');
  if (!parsed.ok) {
    throw new Error('unreachable');
  }
  return parsed.lock;
}

function hasErrorNode(node: { type: string; children: Array<unknown> }): boolean {
  if (node.type === 'ERROR') {
    return true;
  }
  return (node.children as Array<{ type: string; children: Array<unknown> }>).some(hasErrorNode);
}

describe('parseCliVersion', () => {
  it('extracts the version from tree-sitter --version output', () => {
    assert.equal(parseCliVersion('tree-sitter 0.27.1 (abc123)'), '0.27.1');
    assert.equal(parseCliVersion('tree-sitter 0.27.1\n'), '0.27.1');
  });

  it('returns null for unparsable text', () => {
    assert.equal(parseCliVersion('command not found'), null);
    assert.equal(parseCliVersion(''), null);
  });
});

describe('checkAgainstLock', () => {
  const lock = {
    ...readToyLock(),
    wasm: { file: 'grammar.wasm', sha256: 'c'.repeat(64) },
  };

  it('returns null on equality', () => {
    assert.equal(checkAgainstLock(lock, 'c'.repeat(64)), null);
  });

  it('names both hashes and the update-lock hint on inequality', () => {
    const text = checkAgainstLock(lock, 'd'.repeat(64));
    assert.ok(text !== null);
    assert.ok(text.includes('c'.repeat(64)));
    assert.ok(text.includes('d'.repeat(64)));
    assert.ok(text.includes('run with --update-lock if this change is intentional'));
  });
});

describe('sha256Hex', () => {
  it('hashes bytes to 64 lowercase hex', () => {
    assert.equal(
      sha256Hex(Buffer.from('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('committed toy grammar.wasm', () => {
  it('has the sha256 recorded in grammar.lock (catches line-ending corruption)', () => {
    const lock = readToyLock();
    const bytes = fs.readFileSync(path.join(toyDir, lock.wasm.file));
    assert.equal(sha256Hex(bytes), lock.wasm.sha256);
  });

  it('loads in web-tree-sitter as atlas_toy with the locked ABI and parses without errors', async () => {
    const lock = readToyLock();
    await Parser.init();
    const bytes = new Uint8Array(fs.readFileSync(path.join(toyDir, lock.wasm.file)));
    const language = await Language.load(bytes);
    const parser = new Parser();
    try {
      assert.equal(language.abiVersion, lock.abi);
      assert.equal(language.name, 'atlas_toy');
      parser.setLanguage(language);
      const tree = parser.parse('fn a { }');
      assert.ok(tree !== null);
      try {
        assert.equal(tree.rootNode.type, 'source_file');
        assert.equal(hasErrorNode(tree.rootNode), false);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });
});
