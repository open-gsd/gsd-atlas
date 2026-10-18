/**
 * `gsd-atlas bug` (SKL-04, D-17; docs/DIAGNOSTICS.md section 9): the hasher, the sanitiser and the bundle. Task 1 of plan
 * 03-32 proves the smallest bundle there is (the header and the user's own scrubbed text) and the machinery every later
 * type is built on: tokens that are stable inside one bundle and unlinkable across bundles, typed leaves, and a preview
 * that is the bytes that are written.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import { BUG_TYPES, BUNDLE_FORMAT, buildBundle, renderPreview } from './bundle.ts';
import type { BugInput } from './bundle.ts';
import { createHasher } from './hash.ts';
import { leaf, sanitize } from './sanitize.ts';
import type { Tree } from './sanitize.ts';

const ZEROS = (size: number): Uint8Array => new Uint8Array(size);
const TOKEN = /^<h:[0-9a-f]{8}>$/;

const base = (extra: Partial<BugInput> = {}): BugInput => ({
  atlasVersion: '1.2.3',
  catalogVersion: 1,
  mode: 'hashed',
  include: [],
  problem: {},
  ...extra,
});

describe('hasher', () => {
  it('token stable within a bundle: one hasher gives one string one token, and the token has the documented shape', () => {
    const hasher = createHasher();
    const first = hasher.token('ZEBRA_SYMBOL');
    assert.match(first, TOKEN);
    assert.equal(hasher.token('ZEBRA_SYMBOL'), first);
    assert.notEqual(hasher.token('another'), first);
  });

  it('token differs across hashers: the key is random per bundle, so the same name is not linkable between bundles', () => {
    const one = createHasher();
    const two = createHasher();
    assert.notEqual(one.token('ZEBRA_SYMBOL'), two.token('ZEBRA_SYMBOL'));
  });

  it('200 distinct strings give 200 distinct tokens (injected key), and a pinned key gives a pinned token', () => {
    const hasher = createHasher(ZEROS);
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) seen.add(hasher.token(`symbol_${String(index)}`));
    assert.equal(seen.size, 200);
    const expected = `<h:${crypto.createHmac('sha256', Buffer.alloc(16)).update('src/main.ts').digest('hex').slice(0, 8)}>`;
    assert.equal(hasher.token('src/main.ts'), expected);
  });

  it('the key is 16 random bytes asked for once and is not an own property of the hasher', () => {
    const asked: number[] = [];
    const hasher = createHasher((size) => {
      asked.push(size);
      return new Uint8Array(size).fill(7);
    });
    hasher.token('x');
    hasher.token('y');
    assert.deepEqual(asked, [16]);
    assert.deepEqual(Object.keys(hasher), ['token']);
  });
});

describe('sanitiser', () => {
  const tree: Tree = {
    symbol: leaf.name('ZEBRA_SYMBOL'),
    file: leaf.path('/home/secret/path/x.ts'),
    fact: leaf.handle('sym/x.ts/0123456789abcdef0123456789abcdef01234567/0'),
    note: leaf.text('see /home/secret/path/x.ts and hunter2 is the password: hunter2'),
    kind: leaf.code('code_refs'),
    results: leaf.count(7),
    ok: true,
    nothing: null,
    list: [leaf.name('a'), leaf.name('a')],
  };

  it('hashed mode: names, paths and handles become tokens, text is scrubbed, codes and counts stay', () => {
    const out = sanitize(tree, 'hashed', createHasher(ZEROS)) as Record<string, unknown>;
    for (const key of ['symbol', 'file', 'fact']) assert.match(String(out[key]), TOKEN, key);
    assert.equal(out['kind'], 'code_refs');
    assert.equal(out['results'], 7);
    assert.equal(out['ok'], true);
    assert.equal(out['nothing'], null);
    assert.ok(!String(out['note']).includes('/home/secret'));
    assert.ok(String(out['note']).includes('[removed]'));
    const list = out['list'] as string[];
    assert.equal(list[0], list[1], 'a repeat stays visible as a repeat');
    assert.notEqual(out['symbol'], out['file']);
  });

  it('redacted mode: names, paths and handles are removed, the rest is as in hashed mode', () => {
    const out = sanitize(tree, 'redacted', createHasher(ZEROS)) as Record<string, unknown>;
    for (const key of ['symbol', 'file', 'fact']) assert.equal(out[key], '<removed>', key);
    assert.equal(out['kind'], 'code_refs');
    assert.equal(out['results'], 7);
    assert.deepEqual(out['list'], ['<removed>', '<removed>']);
  });

  it('raw mode: names, paths and handles are kept as they are, and user text is still scrubbed', () => {
    const out = sanitize(tree, 'raw', createHasher(ZEROS)) as Record<string, unknown>;
    assert.equal(out['symbol'], 'ZEBRA_SYMBOL');
    assert.equal(out['file'], '/home/secret/path/x.ts');
    assert.equal(out['fact'], 'sym/x.ts/0123456789abcdef0123456789abcdef01234567/0');
    assert.ok(!String(out['note']).includes('/home/secret'));
  });

  it('a code leaf that does not look like a code is treated as a name, so a mistake cannot leak one', () => {
    const odd: Tree = { kind: leaf.code('/home/secret/path/x.ts') };
    assert.match(String((sanitize(odd, 'hashed', createHasher(ZEROS)) as Record<string, unknown>)['kind']), TOKEN);
    assert.equal((sanitize(odd, 'redacted', createHasher(ZEROS)) as Record<string, unknown>)['kind'], '<removed>');
  });

  it('unknown leaf kind is an error: an untyped string, an untyped number and an invented kind are all refused', () => {
    const hasher = createHasher(ZEROS);
    assert.throws(() => sanitize({ name: 'ZEBRA_SYMBOL' } as unknown as Tree, 'hashed', hasher), /untyped|leaf/i);
    assert.throws(() => sanitize({ n: 3 } as unknown as Tree, 'hashed', hasher), /untyped|leaf/i);
    assert.throws(() => sanitize({ x: { leaf: 'secret', value: 'v' } } as unknown as Tree, 'hashed', hasher), /unknown leaf kind/i);
    assert.throws(() => sanitize(['bare'] as unknown as Tree, 'hashed', hasher), /untyped|leaf/i);
  });

  it('an object key outside the fixed key shape is refused, so repository text cannot become a key', () => {
    assert.throws(() => sanitize({ 'ZEBRA SYMBOL/x': true } as unknown as Tree, 'hashed', createHasher(ZEROS)), /key/i);
  });
});

describe('the bundle', () => {
  it('nothing approved bundle: the keys are exactly format, header and problem, and the user text is scrubbed', () => {
    const built = buildBundle(
      base({
        problem: {
          what: 'refs missed a caller in /Users/alice/x.ts, token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          expected: 'the caller of load',
        },
      }),
    );
    assert.deepEqual(Object.keys(built.bundle), ['format', 'header', 'problem']);
    assert.equal(built.bundle['format'], BUNDLE_FORMAT);
    assert.equal(BUNDLE_FORMAT, 'gsd-atlas-bug-v1');
    assert.deepEqual(built.bundle['header'], { atlas_version: '1.2.3', catalog_version: 1 });
    assert.deepEqual(built.bundle['problem'], { what_happened: 'refs missed a caller in [removed], token [removed]', expected: 'the caller of load' });
    assert.ok(!built.text.includes('alice'));
    assert.ok(!built.text.includes('ghp_'));
  });

  it('nothing approved bundle: only the fields the user supplied are there, and an empty problem is an empty object', () => {
    const built = buildBundle(base({ problem: { steps: 'run find' } }));
    assert.deepEqual(built.bundle['problem'], { steps: 'run find' });
    assert.deepEqual(buildBundle(base()).bundle['problem'], {});
  });

  it('a type that was not approved adds no key, even when its data was supplied', () => {
    const built = buildBundle(
      base({
        versions: { atlas: '1.2.3', node: '24.22.0', sqlite: '3.53.4', driver: 'node:sqlite', modules: [], typescript: null, config: {} },
        recorder: { events: [{ t: 1, tool: 'code_find', outcome: 'ok' }] },
      }),
    );
    assert.deepEqual(Object.keys(built.bundle), ['format', 'header', 'problem']);
    assert.ok(!built.text.includes('code_find'));
    assert.deepEqual(built.included, []);
  });

  it('preview equals written bytes: the preview holds the serialised bundle verbatim, after a short framing', () => {
    const built = buildBundle(base({ problem: { what: 'one' } }));
    assert.equal(built.text, `${JSON.stringify(built.bundle, null, 2)}\n`);
    assert.ok(built.preview.endsWith(built.text), 'the preview ends with the exact bytes of bundle.json');
    assert.ok(built.preview.includes(`sha256 ${built.digest.slice(0, 12)}`));
    assert.equal(built.digest, crypto.createHash('sha256').update(built.text).digest('hex'));
    assert.ok(!built.preview.startsWith('RAW MODE'));
  });

  it('the preview is a function of the same pieces: renderPreview over the built values gives the built preview', () => {
    const built = buildBundle(base({ problem: { what: 'one' } }));
    assert.equal(renderPreview({ mode: 'hashed', text: built.text, digest: built.digest, included: built.included }), built.preview);
  });

  it('raw mode opens the preview with the marked banner', () => {
    const built = buildBundle(base({ mode: 'raw', problem: { what: 'one' } }));
    assert.equal(built.preview.split('\n')[0], 'RAW MODE: names and paths are included as they are');
  });

  it('the five consent types are the documented list', () => {
    assert.deepEqual([...BUG_TYPES], ['problem', 'versions', 'health', 'recorder', 'failing']);
  });
});
