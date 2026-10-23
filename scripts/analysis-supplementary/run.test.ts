import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { breakText, fittedAt } from './run.ts';

const f2 = (v: number): string => v.toFixed(2);

describe('breakText', () => {
  it('reports a break-even with its interval and flags one outside the observed range as extrapolation', () => {
    const inside = breakText({ est: 4, lo: 3, hi: 5, usableDraws: 10_000 }, [1, 9], f2);
    assert.match(inside, /^4\.00 \(3\.00 to 5\.00\)$/);
    const outside = breakText({ est: 24, lo: 11, hi: 125, usableDraws: 10_000 }, [1, 9], f2);
    assert.match(outside, /EXTRAPOLATION/);
  });
  it('says "not identified" and prints no interval when fewer than 95 percent of draws have a falling fit', () => {
    const t = breakText({ est: 4.8e70, lo: 158, hi: 2.3e58, usableDraws: 5_211 }, [1, 9], f2);
    assert.match(t, /not identified/);
    assert.match(t, /5211 of 10000/);
    assert.doesNotMatch(t, /e\+/);
    assert.match(breakText({ est: NaN, lo: NaN, hi: NaN, usableDraws: 2_000 }, [1, 9], f2), /not identified/);
  });
});

describe('fittedAt', () => {
  it('evaluates the fitted ratio of a log-log fit at a given x', () => {
    assert.ok(Math.abs(fittedAt({ intercept: Math.log(3), slope: -0.5 }, 4) - 1.5) < 1e-12);
  });
});
