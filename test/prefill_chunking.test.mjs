import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ADDON = 'build/Release/orkllm_llama_napi.node';
let plan = null;
before(() => { if (fs.existsSync(ADDON)) plan = require('../' + ADDON).plan_prefill_chunks; });
const FILL = 0, BALANCED = 1, BORROW = 2;
const CAP = 512, FLOOR = 128;
const skip = () => plan === null;

// Prefill is issued in chunks of at most n_batch, and the division is not neutral: measured per-token
// cost on RK3588 is 3.63 ms at M=256 but 7.27 at M=32, and a 7-token tail cost 63.5 ms/token. These
// tests pin the planner's contract; which STRATEGY is best is an empirical question measured on-board.
describe('prefill chunk planner', { skip: skip() }, () => {
  test('a prompt at or below the cap is never split', () => {
    // The 3x5 trap: a 15-token prompt must stay one chunk, not become three unamortised ones.
    for (const n of [1, 15, 32, 511, 512]) {
      assert.deepEqual(plan(n, CAP, FLOOR, FILL), [n], `fill n=${n}`);
      assert.deepEqual(plan(n, CAP, FLOOR, BALANCED), [n], `balanced n=${n}`);
      assert.deepEqual(plan(n, CAP, FLOOR, BORROW), [n], `borrow n=${n}`);
    }
  });

  test('FILL reproduces today behaviour, tiny tail included', () => {
    assert.deepEqual(plan(519, CAP, FLOOR, FILL), [512, 7]);   // the 63.5 ms/token tail
    assert.deepEqual(plan(1024, CAP, FLOOR, FILL), [512, 512]);
    assert.deepEqual(plan(513, CAP, FLOOR, FILL), [512, 1]);
  });

  test('BALANCED splits evenly and never leaves a tiny tail', () => {
    assert.deepEqual(plan(519, CAP, FLOOR, BALANCED), [260, 259]);
    assert.deepEqual(plan(513, CAP, FLOOR, BALANCED), [257, 256]);
    assert.deepEqual(plan(1025, CAP, FLOOR, BALANCED), [342, 342, 341]);
  });

  test('BALANCED keeps M in [cap/2, cap], so the floor holds structurally', () => {
    for (let n = CAP + 1; n <= 4096; n += 37) {
      const p = plan(n, CAP, FLOOR, BALANCED);
      assert.equal(p.reduce((a, b) => a + b, 0), n, `sums to n at n=${n}`);
      assert.ok(Math.min(...p) >= CAP / 2 - 1, `min chunk ${Math.min(...p)} >= cap/2 at n=${n}`);
      assert.ok(Math.max(...p) <= CAP, `max chunk <= cap at n=${n}`);
    }
  });

  test('BORROW lifts a sub-floor tail to exactly the floor, keeping earlier chunks at cap', () => {
    assert.deepEqual(plan(519, CAP, FLOOR, BORROW), [391, 128]);
    assert.deepEqual(plan(1030, CAP, FLOOR, BORROW), [512, 390, 128]);
  });

  test('BORROW leaves an already-adequate tail alone', () => {
    assert.deepEqual(plan(700, CAP, FLOOR, BORROW), [512, 188]);
  });

  test('BORROW will not rob a donor below the floor to feed the tail', () => {
    // Two chunks that are both small: taking from the donor would just move the problem.
    const p = plan(CAP + 10, CAP, 400, BORROW);
    assert.equal(p.reduce((a, b) => a + b, 0), CAP + 10);
    assert.deepEqual(p, [512, 10], 'left as-is rather than creating a second unamortised chunk');
  });

  test('every strategy conserves the token count', () => {
    for (const s of [FILL, BALANCED, BORROW])
      for (const n of [1, 15, 512, 513, 519, 1024, 1025, 4097])
        assert.equal(plan(n, CAP, FLOOR, s).reduce((a, b) => a + b, 0), n, `s=${s} n=${n}`);
  });

  test('degenerate inputs yield no chunks rather than a bad plan', () => {
    assert.deepEqual(plan(0, CAP, FLOOR, FILL), []);
    assert.deepEqual(plan(-5, CAP, FLOOR, FILL), []);
    assert.deepEqual(plan(100, 0, FLOOR, FILL), []);
  });
});
