import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitCoreSets } from '../src/perf_governor.js';

// The bug this replaces: classifying big cores as `capacity === max` selected only the highest-clocked
// cluster. On RK3588 that is cpu6,7 (1024) while cpu4,5 are also A76s at 1003 — half the big cluster was
// handed to inference and two A76s were treated as little. Measured 176.3 tok/s prefill on the two cores
// it chose vs 251.6 on the full cluster.
describe('splitCoreSets', () => {
  test('RK3588: two A76 clusters at different clocks are ONE big tier', () => {
    // cpu0-3 A55 @405, cpu4-5 A76 @1003, cpu6-7 A76 @1024 — read off the board
    assert.deepEqual(splitCoreSets({ 0:405, 1:405, 2:405, 3:405, 4:1003, 5:1003, 6:1024, 7:1024 }),
                     { little: '0,1,2,3', big: '4,5,6,7' });
  });

  test('a single big tier still splits at the cluster boundary', () => {
    assert.deepEqual(splitCoreSets({ 0:400, 1:400, 2:400, 3:400, 4:1024, 5:1024, 6:1024, 7:1024 }),
                     { little: '0,1,2,3', big: '4,5,6,7' });
  });

  test('uniform cores are not big.LITTLE', () => {
    assert.equal(splitCoreSets({ 0:1024, 1:1024, 2:1024, 3:1024 }), null);
  });

  test('a same-cluster clock difference is not a cluster boundary', () => {
    // 1024/1000 = 1.02 — below MIN_TIER_RATIO, so this must NOT be split. This is the case the old
    // exact-equality test got wrong in the other direction.
    assert.equal(splitCoreSets({ 0:1000, 1:1000, 2:1024, 3:1024 }), null);
  });

  test('three genuine tiers split at the largest gap', () => {
    // 400 -> 700 is 1.75x, 700 -> 1024 is 1.46x: the boundary is the FIRST jump, so 700s count as big.
    assert.deepEqual(splitCoreSets({ 0:400, 1:400, 2:700, 3:700, 4:1024, 5:1024 }),
                     { little: '0,1', big: '2,3,4,5' });
  });

  test('degenerate inputs return null rather than an empty mask', () => {
    assert.equal(splitCoreSets({}), null);
    assert.equal(splitCoreSets({ 0: 1024 }), null);
  });
});
