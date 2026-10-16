import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Language, Parser } from 'web-tree-sitter';

import { measureErrors } from './measure.ts';
import { withTree } from './with-tree.ts';

// A tiny in-memory tree with the slice of the web-tree-sitter cursor API that measureErrors uses,
// so traversal rules and cursor deletion can be asserted without WASM.
interface FakeSpec {
  readonly type: 'ok' | 'ERROR' | 'MISSING';
  readonly start: number;
  readonly end: number;
  readonly children?: readonly FakeSpec[];
}

class FakeNode {
  readonly spec: FakeSpec;
  readonly children: FakeNode[];
  readonly parent: FakeNode | null;
  constructor(spec: FakeSpec, parent: FakeNode | null) {
    this.spec = spec;
    this.parent = parent;
    this.children = (spec.children ?? []).map((child) => new FakeNode(child, this));
  }
  get isError(): boolean {
    return this.spec.type === 'ERROR';
  }
  get isMissing(): boolean {
    return this.spec.type === 'MISSING';
  }
  get hasError(): boolean {
    return this.isError || this.isMissing || this.children.some((child) => child.hasError);
  }
  get startIndex(): number {
    return this.spec.start;
  }
  get endIndex(): number {
    return this.spec.end;
  }
}

class FakeCursor {
  deleted = 0;
  explodeOnVisit = false;
  private node: FakeNode;
  constructor(node: FakeNode) {
    this.node = node;
  }
  get currentNode(): FakeNode {
    if (this.explodeOnVisit) {
      throw new Error('cursor failure');
    }
    return this.node;
  }
  gotoFirstChild(): boolean {
    const [first] = this.node.children;
    if (first === undefined) return false;
    this.node = first;
    return true;
  }
  gotoNextSibling(): boolean {
    const { parent } = this.node;
    if (parent === null) return false;
    const index = parent.children.indexOf(this.node);
    const next = parent.children[index + 1];
    if (next === undefined) return false;
    this.node = next;
    return true;
  }
  gotoParent(): boolean {
    if (this.node.parent === null) return false;
    this.node = this.node.parent;
    return true;
  }
  delete(): void {
    this.deleted += 1;
  }
}

function fakeRoot(spec: FakeSpec): { root: { walk(): FakeCursor }; cursors: FakeCursor[] } {
  const rootNode = new FakeNode(spec, null);
  const cursors: FakeCursor[] = [];
  return {
    root: {
      walk() {
        const cursor = new FakeCursor(rootNode);
        cursors.push(cursor);
        return cursor;
      },
    },
    cursors,
  };
}

describe('measureErrors (fake tree)', () => {
  it('reports zero for a clean tree and totalBytes in UTF-8', () => {
    const text = 'héllo \u{1F600}';
    const { root } = fakeRoot({ type: 'ok', start: 0, end: text.length, children: [{ type: 'ok', start: 0, end: 5 }] });
    assert.deepEqual(measureErrors(root, text), {
      errorBytes: 0,
      totalBytes: Buffer.byteLength(text, 'utf8'),
      missingNodes: 0,
    });
  });

  it('sums only outermost ERROR nodes and does not descend into one', () => {
    const text = 'abcdefghij';
    const { root } = fakeRoot({
      type: 'ok',
      start: 0,
      end: 10,
      children: [
        { type: 'ERROR', start: 1, end: 5, children: [{ type: 'ERROR', start: 2, end: 4 }] },
        { type: 'ok', start: 5, end: 7 },
        { type: 'ERROR', start: 8, end: 10 },
      ],
    });
    assert.equal(measureErrors(root, text).errorBytes, 4 + 2);
  });

  it('counts the UTF-8 bytes of a multi-byte character inside an ERROR node, not its UTF-16 units', () => {
    const text = 'é\u{1F600}x';
    // U+00E9 is 1 UTF-16 unit and 2 UTF-8 bytes; the emoji is 2 units and 4 bytes.
    const { root } = fakeRoot({
      type: 'ok',
      start: 0,
      end: text.length,
      children: [{ type: 'ERROR', start: 0, end: 3 }],
    });
    const result = measureErrors(root, text);
    assert.equal(result.errorBytes, 6);
    assert.equal(result.totalBytes, 7);
  });

  it('counts zero-width MISSING nodes separately and adds no error bytes for them', () => {
    const text = 'fn a {';
    const { root } = fakeRoot({
      type: 'ok',
      start: 0,
      end: 6,
      children: [{ type: 'ok', start: 0, end: 6, children: [{ type: 'MISSING', start: 6, end: 6 }] }],
    });
    const result = measureErrors(root, text);
    assert.equal(result.missingNodes, 1);
    assert.equal(result.errorBytes, 0);
  });

  it('deletes its cursor exactly once on the normal path', () => {
    const { root, cursors } = fakeRoot({ type: 'ok', start: 0, end: 1, children: [{ type: 'ERROR', start: 0, end: 1 }] });
    measureErrors(root, 'x');
    assert.equal(cursors.length, 1);
    assert.equal(cursors[0]?.deleted, 1);
  });

  it('deletes its cursor exactly once when the traversal throws', () => {
    const { root, cursors } = fakeRoot({ type: 'ok', start: 0, end: 1 });
    const original = root.walk.bind(root);
    const exploding = {
      walk() {
        const cursor = original();
        cursor.explodeOnVisit = true;
        return cursor;
      },
    };
    assert.throws(() => measureErrors(exploding, 'x'), /cursor failure/);
    assert.equal(cursors.length, 1);
    assert.equal(cursors[0]?.deleted, 1);
  });
});

describe('measureErrors (real toy tree)', () => {
  const toyDir = path.resolve(import.meta.dirname, '..', '..', 'test', 'fixtures', 'modules', 'toy');

  async function measureFile(relative: string) {
    await Parser.init();
    const language = await Language.load(new Uint8Array(fs.readFileSync(path.join(toyDir, 'grammar.wasm'))));
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const text = fs.readFileSync(path.join(toyDir, relative), 'utf8').replace(/^﻿/, '');
      return withTree(parser, text, (tree) => measureErrors(tree.rootNode, text));
    } finally {
      parser.delete();
    }
  }

  for (const name of ['basic', 'emoji', 'crlf', 'bom']) {
    it(`reports errorBytes 0 for fixtures/${name}.toy`, async () => {
      const result = await measureFile(`fixtures/${name}.toy`);
      assert.equal(result.errorBytes, 0);
      assert.equal(result.missingNodes, 0);
    });
  }

  it('reports errorBytes above the 0.5 percent budget for fixtures-negative/broken.toy', async () => {
    const result = await measureFile('fixtures-negative/broken.toy');
    assert.ok(result.errorBytes > 0, 'broken.toy must contain ERROR bytes');
    assert.ok(result.errorBytes <= result.totalBytes);
    assert.ok(result.errorBytes / result.totalBytes > 0.005);
  });
});
