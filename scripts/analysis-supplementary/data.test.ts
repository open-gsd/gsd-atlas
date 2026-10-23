import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fitPrices, weightedTokens } from './lib.ts';
import { loadAll } from './run.ts';

describe('the three datasets as logged (read only)', () => {
  const data = loadAll();
  it('has the expected shapes: 96 pilot sessions on 16 questions, 450 rows on 75 questions twice', () => {
    assert.equal(data.pilot.sessions.length, 96);
    assert.equal(data.pilot.questionIds.length, 16);
    assert.equal(data.registered.sessions.length, 450);
    assert.equal(data.registered.questionIds.length, 75);
    assert.equal(data.cleanroom.sessions.length, 450);
    assert.equal(data.cleanroom.questionIds.length, 75);
  });
  it('has a logged cost on every row and its token parts sum to the logged billable count', () => {
    for (const d of [data.pilot, data.registered, data.cleanroom]) {
      for (const s of d.sessions) {
        assert.ok(Number.isFinite(s.costUsd) && s.costUsd > 0);
        assert.equal(s.input + s.cacheCreation + s.cacheRead + s.output, s.billable);
      }
    }
  });
  it('shows the logged cost is exactly linear in the four token counts at 2 / 4 / 0.10 / 10 USD per million', () => {
    for (const d of [data.pilot, data.registered, data.cleanroom]) {
      const fit = fitPrices(d.sessions);
      assert.ok(Math.abs(fit.input * 1e6 - 2) < 1e-6);
      assert.ok(Math.abs(fit.cacheCreation * 1e6 - 4) < 1e-6);
      assert.ok(Math.abs(fit.cacheRead * 1e6 - 0.1) < 1e-6);
      assert.ok(Math.abs(fit.output * 1e6 - 10) < 1e-6);
      assert.ok(fit.maxResidual < 1e-9);
      // the 0.05-weight token measure is therefore the logged cost up to the constant 2 USD per million
      for (const s of d.sessions) assert.ok(Math.abs(weightedTokens(s, 0.05) * 2e-6 - s.costUsd) < 1e-9);
    }
  });
});
