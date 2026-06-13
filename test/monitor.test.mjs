import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { weightedCpuLoad } from '../src/monitor.js';

// RK3588 big.LITTLE: cpu0-3 = A55 @1.8 GHz (little), cpu4-7 = A76 @2.4 GHz (big).
const RK3588 = [1800000, 1800000, 1800000, 1800000, 2400000, 2400000, 2400000, 2400000];
const cpus = (loads) => loads.map((load) => ({ load }));

describe('weightedCpuLoad', () => {
  test('all cores idle → 0%', () => {
    assert.equal(weightedCpuLoad({ currentLoad: 0, cpus: cpus([0, 0, 0, 0, 0, 0, 0, 0]) }, RK3588), 0);
  });

  test('all cores saturated → 100%', () => {
    assert.equal(weightedCpuLoad({ currentLoad: 100, cpus: cpus([100, 100, 100, 100, 100, 100, 100, 100]) }, RK3588), 100);
  });

  test('little cores busy, big idle → BELOW the flat 50% mean', () => {
    // flat mean would be 50%; weighted by capacity it is Σ(load·f)/Σf = 4·100·1.8M / (4·1.8M+4·2.4M)
    const w = weightedCpuLoad({ currentLoad: 50, cpus: cpus([100, 100, 100, 100, 0, 0, 0, 0]) }, RK3588);
    assert.ok(w < 50, `expected < 50, got ${w}`);
    assert.ok(Math.abs(w - 42.857) < 0.01, `expected ~42.86, got ${w}`);
  });

  test('big cores busy, little idle → ABOVE the flat 50% mean', () => {
    const w = weightedCpuLoad({ currentLoad: 50, cpus: cpus([0, 0, 0, 0, 100, 100, 100, 100]) }, RK3588);
    assert.ok(w > 50, `expected > 50, got ${w}`);
    assert.ok(Math.abs(w - 57.143) < 0.01, `expected ~57.14, got ${w}`);
  });

  test('uniform-clock SoC → identical to the flat mean', () => {
    const uniform = [2000000, 2000000, 2000000, 2000000];
    const w = weightedCpuLoad({ currentLoad: 25, cpus: cpus([100, 0, 0, 0]) }, uniform);
    assert.equal(w, 25);
  });

  // --- fallbacks: never throw, return the flat mean ---
  test('weight/core count mismatch → flat mean', () => {
    assert.equal(weightedCpuLoad({ currentLoad: 73, cpus: cpus([50, 50, 50, 50]) }, RK3588), 73);
  });

  test('no per-core data → flat mean', () => {
    assert.equal(weightedCpuLoad({ currentLoad: 61, cpus: [] }, RK3588), 61);
    assert.equal(weightedCpuLoad({ currentLoad: 61 }, RK3588), 61);
  });

  test('empty weights (non-Linux / no cpufreq) → flat mean', () => {
    assert.equal(weightedCpuLoad({ currentLoad: 42, cpus: cpus([10, 90]) }, []), 42);
  });

  test('missing currentLoad → 0', () => {
    assert.equal(weightedCpuLoad({ cpus: [] }), 0);
    assert.equal(weightedCpuLoad({}), 0);
  });

  test('non-numeric per-core load treated as 0', () => {
    // only the big cores report; little cores undefined → contribute 0 load (not NaN)
    const w = weightedCpuLoad({ currentLoad: 50, cpus: [{}, {}, {}, {}, { load: 100 }, { load: 100 }, { load: 100 }, { load: 100 }] }, RK3588);
    assert.ok(Number.isFinite(w) && Math.abs(w - 57.143) < 0.01, `expected ~57.14, got ${w}`);
  });
});
