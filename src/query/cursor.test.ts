import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCursor, encodeCursor, queryHash } from './cursor.ts';
import type { CursorPayload, QueryParts } from './cursor.ts';

const MAX = 1024;

const parts: QueryParts = { worktree: '/work/repo', name: 'parse', mode: 'auto' };
const hashOf = (): string => queryHash('code_find', parts);

const payloadOf = (): CursorPayload => ({
  key: [2, 0, 0, 0, 1, 'src/a.ts', 10, 4, 'sym/src%2Fa.ts/abc/3'],
  query: hashOf(),
  seq: 7,
});

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

describe('query hash: which requests a cursor belongs to', () => {
  it('is the same for the same tool and ranking-relevant arguments', () => {
    assert.equal(queryHash('code_find', { ...parts }), hashOf());
    assert.match(hashOf(), /^[0-9a-f]{32}$/);
  });

  it('differs when the tool, worktree, name, kind, mode, path or cwd differs', () => {
    const others = [
      queryHash('code_refs', parts),
      queryHash('code_find', { ...parts, worktree: '/work/other' }),
      queryHash('code_find', { ...parts, name: 'other' }),
      queryHash('code_find', { ...parts, kind: 'class' }),
      queryHash('code_find', { ...parts, mode: 'exact' }),
      queryHash('code_find', { ...parts, path: 'src/a.ts' }),
      queryHash('code_find', { ...parts, cwd: 'src' }),
    ];
    for (const other of others) assert.notEqual(other, hashOf());
    assert.equal(new Set(others).size, others.length, 'each difference gives its own hash');
  });

  it('does not depend on the budget or the limit, which may change between pages', () => {
    assert.equal(queryHash('code_find', { ...parts }), hashOf());
  });
});

describe('cursor: an opaque keyset position', () => {
  it('round-trips the sort key, the query hash and the watermark seq as base64url', () => {
    const payload = payloadOf();
    const text = encodeCursor(payload, MAX);
    assert.ok(text !== null);
    assert.match(text, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCursor(text, hashOf(), MAX), { ok: true, payload });
  });

  it('is JSON with the short keys k, q and w', () => {
    const text = encodeCursor(payloadOf(), MAX) ?? '';
    assert.deepEqual(JSON.parse(Buffer.from(text, 'base64url').toString('utf8')), { k: payloadOf().key, q: hashOf(), w: 7 });
  });

  it('rejects text that is not base64url', () => {
    for (const bad of ['not base64url!!', 'abc=', 'a+b/c', '', '   ']) {
      assert.deepEqual(decodeCursor(bad, hashOf(), MAX), { ok: false, problem: 'malformed' }, JSON.stringify(bad));
    }
  });

  it('rejects valid base64url that is not the expected JSON', () => {
    for (const text of ['hello world', '{"x":1}', '[1,2,3]', 'null', '{"k":[1],"q":"x","w":1}', '{"k":[0,0,0,0,0,"p",1,1,"h"],"q":"x","w":-1}']) {
      assert.deepEqual(decodeCursor(b64url(text), hashOf(), MAX), { ok: false, problem: 'malformed' }, text);
    }
  });

  it('rejects an oversized cursor before decoding it', () => {
    const huge = 'A'.repeat(MAX + 1);
    assert.deepEqual(decodeCursor(huge, hashOf(), MAX), { ok: false, problem: 'oversized' });
    const exact = 'A'.repeat(MAX);
    assert.notDeepEqual(decodeCursor(exact, hashOf(), MAX), { ok: false, problem: 'oversized' }, 'the limit itself is allowed');
  });

  it('rejects a cursor issued for a different query', () => {
    const text = encodeCursor(payloadOf(), MAX) ?? '';
    assert.deepEqual(decodeCursor(text, queryHash('code_find', { ...parts, name: 'other' }), MAX), { ok: false, problem: 'other_query' });
  });

  it('refuses to issue a cursor longer than the limit', () => {
    const long: CursorPayload = { ...payloadOf(), key: [2, 0, 0, 0, 1, 'x'.repeat(2000), 10, 4, 'h'] };
    assert.equal(encodeCursor(long, MAX), null);
  });
});
