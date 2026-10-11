import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOrkpackPath, sourceGgufFor } from '../src/orkpack.js';

// The fallback in pool.js rests on these two: a pack id is recognisable, and it maps back to the id its
// settings were written under. Both are pure, so the mapping is testable without a DB or a pool.
describe('pack -> source-gguf settings key', () => {
  test('a pack id maps to the gguf id settings were written against', () => {
    assert.equal(sourceGgufFor('Qwen3-1.7B-GGUF/Qwen3-1.7B-UD-Q4_K_XL.orkpack'),
                 'Qwen3-1.7B-GGUF/Qwen3-1.7B-UD-Q4_K_XL.gguf');
  });

  test('only pack ids take the fallback', () => {
    assert.equal(isOrkpackPath('a/b/model.orkpack'), true);
    assert.equal(isOrkpackPath('a/b/model.gguf'), false);
    assert.equal(isOrkpackPath('a/b/model.rkllm'), false);
    // the holed companion is not a pack id and must not be mapped
    assert.equal(isOrkpackPath('a/b/model.orkpack.gguf'), false);
  });

  test('the mapping is idempotent on an id that is already a gguf', () => {
    const g = 'x/y.gguf';
    assert.equal(sourceGgufFor(g), g);
  });

  // The READ path (GET /api/admin/models/settings/*) needs the same fallback the LOAD path has, or
  // the Settings dialog shows defaults for a model the pool is serving with the saved values. The
  // route's logic is this predicate; asserted here against the key a split model actually produces.
  test('the fallback key survives a split model\'s shard suffix', () => {
    const pack = 'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-BF16-00001-of-00002.orkpack';
    assert.equal(isOrkpackPath(pack), true);
    assert.equal(sourceGgufFor(pack),
                 'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-BF16-00001-of-00002.gguf');
  });
});
