import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isOrkpackPath, sourceGgufFor, stubPathFor, stubSiblingShards } from '../src/orkpack.js';
import { isOrkpackStub, isTrailingGgufShard } from '../src/gguf.js';

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

// llama.cpp (llama_split_prefix, via llama_get_list_splits) requires a split model's filename to END
// with `-NNNNN-of-MMMMM.gguf`. Appending `.gguf` to a pack that carries a shard suffix buries it, and
// the load dies with "invalid split file name" before a tensor is read — measured on a 27B whose pack
// was built from shard 1 of 2.
describe('stub naming for a pack built from a split gguf', () => {
  const pack = '/m/unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-BF16-00001-of-00002.orkpack';

  test('the shard suffix stays terminal', () => {
    assert.equal(stubPathFor(pack),
                 '/m/unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-BF16.orkpack-00001-of-00002.gguf');
    assert.match(stubPathFor(pack), /-00001-of-00002\.gguf$/);
  });

  test('an unsplit pack is untouched', () => {
    assert.equal(stubPathFor('/m/a/model.orkpack'), '/m/a/model.orkpack.gguf');
    assert.deepEqual(stubSiblingShards('/m/a/model.orkpack'), []);
  });

  test('every trailing shard gets a name under the stub prefix, pointing at the real shard', () => {
    assert.deepEqual(stubSiblingShards(pack), [{
      link:   '/m/unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-BF16.orkpack-00002-of-00002.gguf',
      target: '/m/unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-BF16-00002-of-00002.gguf',
    }]);
    // and a 3-way split names both siblings
    assert.equal(stubSiblingShards('/m/x-00001-of-00003.orkpack').length, 2);
  });

  test('both stub shapes stay out of every model enumeration', () => {
    assert.equal(isOrkpackStub('a/model.orkpack.gguf'), true);                    // unsplit
    assert.equal(isOrkpackStub('a/model.orkpack-00001-of-00002.gguf'), true);     // split stub
    assert.equal(isOrkpackStub('a/model.orkpack-00002-of-00002.gguf'), true);     // its sibling link
    assert.equal(isOrkpackStub('a/model.orkpack'), false);                        // the pack itself
    assert.equal(isOrkpackStub('a/model-00001-of-00002.gguf'), false);            // a real shard
    // belt and braces: the sibling is a trailing shard too
    assert.equal(isTrailingGgufShard('a/model.orkpack-00002-of-00002.gguf'), true);
  });
});
