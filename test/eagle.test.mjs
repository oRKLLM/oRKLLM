import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rejectionSample, cpuPlaceholderDraft } from '../src/eagle.js';

// ── rejectionSample ────────────────────────────────────────────────────────

describe('rejectionSample', () => {
  const VOC = 4; // tiny vocab for legibility

  // Build flat logits array [numTokens × vocabSize].
  // argmaxes: array of indices where that position's max should land.
  function makeLogits(argmaxes, vocabSize) {
    const arr = new Float32Array(argmaxes.length * vocabSize).fill(-1);
    for (let i = 0; i < argmaxes.length; i++) {
      arr[i * vocabSize + argmaxes[i]] = 1.0; // only winner is positive
    }
    return arr;
  }

  test('accepts all draft tokens when all match and returns bonus token', () => {
    // Target: positions 0,1,2 have argmax=[2,1,3]. Draft=[2,1]. k=2.
    // numTokens=3 so the last position (2) is the bonus slot.
    const logits = makeLogits([2, 1, 3], VOC); // bonus at idx 2 → token 3
    const { acceptedCount, correctionId } = rejectionSample(logits, VOC, 3, [2, 1]);
    assert.equal(acceptedCount, 2);
    assert.equal(correctionId, 3);
  });

  test('rejects at first mismatch and returns correction token', () => {
    // Target argmax=[2,1,3]. Draft=[2,0]. Position 1 mismatches (draft=0, target=1).
    const logits = makeLogits([2, 1, 3], VOC);
    const { acceptedCount, correctionId } = rejectionSample(logits, VOC, 3, [2, 0]);
    assert.equal(acceptedCount, 1);
    assert.equal(correctionId, 1); // target's choice at position 1
  });

  test('rejects immediately when first draft token mismatches', () => {
    const logits = makeLogits([2, 1, 3], VOC);
    const { acceptedCount, correctionId } = rejectionSample(logits, VOC, 3, [0, 1]);
    assert.equal(acceptedCount, 0);
    assert.equal(correctionId, 2);
  });

  test('handles k=1 draft — only bonus token returned on match', () => {
    // numTokens=2: position 0 is the single verify slot, position 1 is bonus.
    // Draft=[3], target argmax at pos 0 = 3 → match → bonus from pos 1.
    const logits = makeLogits([3, 0], VOC);
    const { acceptedCount, correctionId } = rejectionSample(logits, VOC, 2, [3]);
    assert.equal(acceptedCount, 1);
    assert.equal(correctionId, 0); // bonus from position 1
  });

  test('handles k=1 draft — correction on mismatch', () => {
    const logits = makeLogits([3, 0], VOC);
    const { acceptedCount, correctionId } = rejectionSample(logits, VOC, 2, [1]);
    assert.equal(acceptedCount, 0);
    assert.equal(correctionId, 3);
  });

  test('returns bonus token when all k=4 draft tokens accepted', () => {
    // numTokens = k+1 = 5
    const argmaxes = [1, 2, 3, 0, 1]; // last is bonus
    const logits = makeLogits(argmaxes, VOC);
    const draft = [1, 2, 3, 0]; // matches positions 0-3
    const { acceptedCount, correctionId } = rejectionSample(logits, VOC, 5, draft);
    assert.equal(acceptedCount, 4);
    assert.equal(correctionId, 1); // bonus from position 4
  });

  test('large vocab — argmax found correctly', () => {
    const VOCAB = 151936; // Qwen3 vocab size
    // Build logits where token 99999 is the winner at position 0
    const logits = new Float32Array((1 + 1) * VOCAB).fill(-99);
    logits[0 * VOCAB + 99999] = 100;
    logits[1 * VOCAB + 42]    = 100; // bonus
    const { acceptedCount, correctionId } = rejectionSample(logits, VOCAB, 2, [99999]);
    assert.equal(acceptedCount, 1);
    assert.equal(correctionId, 42);
  });
});

// ── cpuPlaceholderDraft ────────────────────────────────────────────────────

describe('cpuPlaceholderDraft', () => {
  const EMB = 4, TOK = 2, VOC = 1000;

  function makeHidden(emb, tok, seed = 1.0) {
    return new Float32Array(emb * tok).fill(seed);
  }

  test('returns exactly k token IDs', () => {
    const h = makeHidden(EMB, TOK);
    const draft = cpuPlaceholderDraft(h, EMB, TOK, 8, VOC);
    assert.equal(draft.length, 8);
  });

  test('all token IDs are in [0, vocabSize)', () => {
    const h = makeHidden(EMB, TOK);
    const draft = cpuPlaceholderDraft(h, EMB, TOK, 8, VOC);
    for (const id of draft) {
      assert.ok(id >= 0 && id < VOC, `id ${id} out of range`);
    }
  });

  test('is deterministic for same input', () => {
    const h = makeHidden(EMB, TOK, 2.5);
    const a = cpuPlaceholderDraft(h, EMB, TOK, 4, VOC);
    const b = cpuPlaceholderDraft(h, EMB, TOK, 4, VOC);
    assert.deepEqual(a, b);
  });

  test('produces different results for different hidden states', () => {
    // Choose values where sqrt(norm)*1000 % vocabSize differs:
    // seed = round(sqrt(EMB * v^2) * 1000) % VOC
    // v=1.3 → sqrt(4*1.69)*1000 % 1000 = round(2600) % 1000 = 600
    // v=2.0 → sqrt(4*4)*1000 % 1000    = round(4000) % 1000 = 0
    const h1 = makeHidden(EMB, TOK, 1.3);
    const h2 = makeHidden(EMB, TOK, 2.0);
    const a = cpuPlaceholderDraft(h1, EMB, TOK, 4, VOC);
    const b = cpuPlaceholderDraft(h2, EMB, TOK, 4, VOC);
    assert.notDeepEqual(a, b);
  });

  test('works with k=1', () => {
    const h = makeHidden(EMB, TOK);
    const draft = cpuPlaceholderDraft(h, EMB, TOK, 1, VOC);
    assert.equal(draft.length, 1);
    assert.ok(draft[0] >= 0 && draft[0] < VOC);
  });

  test('works with large vocab (Qwen3 size)', () => {
    const VOCAB = 151936;
    const h = makeHidden(2048, 64, 1.5);
    const draft = cpuPlaceholderDraft(h, 2048, 64, 8, VOCAB);
    assert.equal(draft.length, 8);
    for (const id of draft) assert.ok(id >= 0 && id < VOCAB);
  });
});
