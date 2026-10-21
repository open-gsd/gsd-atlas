import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LIMITS, shouldStop } from './limits.ts';

const ok = { fiveHour: 0.1, sevenDay: 0.2, isUsingOverage: false, overageStatus: 'rejected' };

describe('shouldStop', () => {
  it('goes on under every limit', () => assert.equal(shouldStop({ spentUsd: 3, nextMaxUsd: 1, rate: ok }), null));
  it('stops when overage is in use', () => assert.match(shouldStop({ spentUsd: 0, nextMaxUsd: 1, rate: { ...ok, isUsingOverage: true } }) ?? '', /overage/));
  it('stops at five hour utilisation of 0.60', () => assert.match(shouldStop({ spentUsd: 0, nextMaxUsd: 1, rate: { ...ok, fiveHour: 0.6 } }) ?? '', /five-hour/));
  it('stops at seven day utilisation of 0.60', () => assert.match(shouldStop({ spentUsd: 0, nextMaxUsd: 1, rate: { ...ok, sevenDay: 0.61 } }) ?? '', /seven-day/));
  it('stops when the next session could pass the cost cap', () => {
    assert.match(shouldStop({ spentUsd: LIMITS.costCapUsd - 0.5, nextMaxUsd: 1, rate: ok }) ?? '', /cost/);
  });
  it('goes on when the rate is not known yet', () => {
    assert.equal(shouldStop({ spentUsd: 0, nextMaxUsd: 1, rate: { fiveHour: null, sevenDay: null, isUsingOverage: null, overageStatus: null } }), null);
  });
  it('has the briefed limits', () => {
    assert.equal(LIMITS.costCapUsd, 12);
    assert.equal(LIMITS.rateCap, 0.6);
  });
});
