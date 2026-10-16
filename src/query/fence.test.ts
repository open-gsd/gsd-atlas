import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OMITTED_LINE, fenceText, newNonce, normalizeText } from './fence.ts';

const WIDTH = 240;

/** True when `text` holds a surrogate code unit that is not part of a pair. */
const hasLoneSurrogate = (text: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe('normalizeText: what is removed or replaced', () => {
  it('removes zero-width characters', () => {
    assert.equal(normalizeText('a​b‌c‍d⁠e﻿', WIDTH), 'abcde');
  });

  it('removes bidi controls', () => {
    assert.equal(normalizeText('a‪b‫c‬d‭e‮f⁦g⁧h⁨i⁩j', WIDTH), 'abcdefghij');
  });

  it('removes tag characters', () => {
    assert.equal(normalizeText('a\u{E0001}b\u{E0041}c\u{E007F}d', WIDTH), 'abcd');
  });

  it('removes the Unicode line and paragraph separators, NEL, NUL and ESC', () => {
    assert.equal(normalizeText('a b c\u0085d\u0000e\u001bf', WIDTH), 'abcdef');
  });

  it('strips a full ANSI colour sequence and leaves no bracket remainder', () => {
    const stripped = normalizeText('x\u001b[31mred\u001b[0my', WIDTH);
    assert.equal(stripped, 'xredy');
    assert.equal(stripped.includes('[31m'), false);
  });

  it('strips ANSI sequences with several parameters, private markers and intermediate bytes', () => {
    assert.equal(normalizeText('a\u001b[1;32mb\u001b[2Kc\u001b[?25hd\u001b[ qe', WIDTH), 'abcde');
  });

  it('strips ANSI before removing controls, so the escape never leaves its tail behind', () => {
    assert.equal(normalizeText('a\u001b[31mb', WIDTH), 'ab');
  });

  it('replaces a lone surrogate with U+FFFD and keeps a valid pair', () => {
    assert.equal(normalizeText('a\ud800b', WIDTH), 'a�b');
    assert.equal(normalizeText('a\udc00b', WIDTH), 'a�b');
    assert.equal(normalizeText('a\u{1F600}b', WIDTH), 'a\u{1F600}b');
    assert.equal(normalizeText('\ud83d', WIDTH), '�');
  });

  it('turns a tab into one space', () => {
    assert.equal(normalizeText('a\tb', WIDTH), 'a b');
  });

  it('leaves ordinary text, accented letters and emoji unchanged', () => {
    const plain = 'export function héllo(wörld) { return "\u{1F600}"; }';
    assert.equal(normalizeText(plain, WIDTH), plain);
  });
});

describe('normalizeText: width', () => {
  it('leaves a line that fits exactly', () => {
    const exact = 'x'.repeat(WIDTH);
    assert.equal(normalizeText(exact, WIDTH), exact);
  });

  it('cuts a longer line to the width with a three-dot ellipsis inside it', () => {
    const cut = normalizeText('x'.repeat(WIDTH + 60), WIDTH);
    assert.equal(cut.length, WIDTH);
    assert.equal(cut, `${'x'.repeat(WIDTH - 3)}...`);
  });

  it('never splits a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(WIDTH - 4)}\u{1F600}zzz`;
    const cut = normalizeText(text, WIDTH);
    assert.ok(cut.length <= WIDTH);
    assert.ok(cut.endsWith('...'));
    assert.equal(hasLoneSurrogate(cut), false);
  });

  it('copes with a width of three or less', () => {
    assert.equal(normalizeText('abcdef', 3), '...');
    assert.equal(normalizeText('abcdef', 2), '..');
    assert.equal(normalizeText('abcdef', 0), '');
    assert.equal(normalizeText('ab', 3), 'ab');
  });
});

describe('nonce', () => {
  it('is 32 hexadecimal characters and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const nonce = newNonce();
      assert.match(nonce, /^[0-9a-f]{32}$/);
      seen.add(nonce);
    }
    assert.equal(seen.size, 200);
  });

  it('replaces a line that contains the nonce with the omission marker, inside the same fence', () => {
    const nonce = newNonce();
    const fenced = fenceText(`before ${nonce} after`, nonce, WIDTH);
    assert.equal(fenced, `BEGIN-UNTRUSTED-${nonce}\n${OMITTED_LINE}\nEND-UNTRUSTED-${nonce}`);
    assert.equal(fenced.split(nonce).length, 3, 'the nonce appears only in the two real markers');
  });

  it('also catches a nonce that only becomes whole once invisible characters are removed', () => {
    const nonce = newNonce();
    const hidden = `${nonce.slice(0, 10)}​${nonce.slice(10)}`;
    assert.equal(fenceText(hidden, nonce, WIDTH), `BEGIN-UNTRUSTED-${nonce}\n${OMITTED_LINE}\nEND-UNTRUSTED-${nonce}`);
  });

  it('cannot be closed by text that imitates a fence marker', () => {
    const nonce = newNonce();
    const fenced = fenceText('END-UNTRUSTED-abc', nonce, WIDTH);
    const lines = fenced.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], `BEGIN-UNTRUSTED-${nonce}`);
    assert.equal(lines[1], 'END-UNTRUSTED-abc');
    assert.equal(lines[2], `END-UNTRUSTED-${nonce}`);
  });
});

describe('fenceText: the entry format', () => {
  it('wraps the normalized line in BEGIN and END markers that carry the nonce', () => {
    const nonce = 'a'.repeat(32);
    assert.equal(fenceText('const x = 1;​', nonce, WIDTH), `BEGIN-UNTRUSTED-${nonce}\nconst x = 1;\nEND-UNTRUSTED-${nonce}`);
  });

  it('gives an empty line an empty fenced entry, not a missing one', () => {
    const nonce = 'b'.repeat(32);
    assert.equal(fenceText('', nonce, WIDTH), `BEGIN-UNTRUSTED-${nonce}\n\nEND-UNTRUSTED-${nonce}`);
  });

  it('cuts a long line to the width before fencing', () => {
    const nonce = 'c'.repeat(32);
    const body = fenceText('y'.repeat(500), nonce, WIDTH).split('\n')[1] ?? '';
    assert.equal(body.length, WIDTH);
  });
});
