import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readGgufString, getGgufChatTemplate, supportsThinkingToggle, getGgufArchitecture, isRecurrentArch, parseGgufShard, isTrailingGgufShard, ggufDisplayName } from '../src/gguf.js';

// ── Minimal GGUF writer (mirrors the reader's understanding of the format) ────
const T = { UINT32: 4, STRING: 8, ARRAY: 9 };

function gstr(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(b.length));
  return Buffer.concat([len, b]);
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

function kvString(key, val) {
  return Buffer.concat([gstr(key), u32(T.STRING), gstr(val)]);
}
function kvU32Array(key, vals) {
  return Buffer.concat([gstr(key), u32(T.ARRAY), u32(T.UINT32), u64(vals.length), ...vals.map(u32)]);
}
function kvStringArray(key, vals) {
  return Buffer.concat([gstr(key), u32(T.ARRAY), u32(T.STRING), u64(vals.length), ...vals.map(gstr)]);
}

function writeGguf(kvs) {
  const header = Buffer.concat([
    u32(0x46554747), // "GGUF"
    u32(3),          // version
    u64(0),          // tensor_count
    u64(kvs.length), // metadata_kv_count
    ...kvs,
  ]);
  const p = path.join(os.tmpdir(), `orkllm-gguf-${process.pid}-${Math.round(performance.now() * 1000)}.gguf`);
  fs.writeFileSync(p, header);
  return p;
}

describe('gguf metadata reader', () => {
  test('extracts tokenizer.chat_template, skipping scalar + string arrays before it', () => {
    const p = writeGguf([
      kvString('general.architecture', 'qwen3moe'),
      kvU32Array('arch.some_list', [1, 2, 3, 4]),
      kvStringArray('tokenizer.ggml.tokens', ['a', 'bb', 'ccc', 'dddd']),
      kvString('tokenizer.chat_template', '{%- if enable_thinking %}<think>{% endif %}'),
    ]);
    try {
      assert.equal(readGgufString(p, 'tokenizer.chat_template'), '{%- if enable_thinking %}<think>{% endif %}');
      assert.equal(supportsThinkingToggle(p), true);
    } finally { fs.unlinkSync(p); }
  });

  test('reports no thinking toggle when the template lacks enable_thinking (LFM2.5-style)', () => {
    const p = writeGguf([
      kvString('general.architecture', 'lfm2moe'),
      kvString('tokenizer.chat_template', '{{ bos_token }}{% for m in messages %}<|im_start|>{{ m.role }}{% endfor %}'),
    ]);
    try {
      assert.equal(supportsThinkingToggle(p), false);
      assert.ok(getGgufChatTemplate(p).includes('im_start'));
    } finally { fs.unlinkSync(p); }
  });

  test('reads general.architecture and flags recurrent/hybrid archs', () => {
    const recurrent = writeGguf([kvString('general.architecture', 'lfm2moe'), kvString('tokenizer.chat_template', '<|im_start|>')]);
    const transformer = writeGguf([kvString('general.architecture', 'qwen3moe'), kvString('tokenizer.chat_template', '<|im_start|>')]);
    try {
      assert.equal(getGgufArchitecture(recurrent), 'lfm2moe');
      assert.equal(isRecurrentArch(recurrent), true);   // LFM2.5-MoE → recurrent
      assert.equal(getGgufArchitecture(transformer), 'qwen3moe');
      assert.equal(isRecurrentArch(transformer), false); // plain transformer → not recurrent
    } finally { fs.unlinkSync(recurrent); fs.unlinkSync(transformer); }
  });

  test('returns null for a missing key and empty template for a non-GGUF file', () => {
    const p = writeGguf([kvString('general.name', 'x')]);
    try {
      assert.equal(readGgufString(p, 'tokenizer.chat_template'), null);
    } finally { fs.unlinkSync(p); }

    const notGguf = path.join(os.tmpdir(), `orkllm-notgguf-${process.pid}.bin`);
    fs.writeFileSync(notGguf, Buffer.from('this is not a gguf file at all'));
    try {
      assert.equal(readGgufString(notGguf, 'tokenizer.chat_template'), null);
      assert.equal(supportsThinkingToggle(notGguf), false);
    } finally { fs.unlinkSync(notGguf); }
  });
});

describe('split (sharded) GGUF grouping', () => {
  test('parses the -NNNNN-of-MMMMM shard suffix, stripping it to a base name', () => {
    assert.deepEqual(parseGgufShard('foo-00001-of-00002.gguf'), { base: 'foo', index: 1, total: 2 });
    assert.deepEqual(parseGgufShard('foo-00002-of-00002.gguf'), { base: 'foo', index: 2, total: 2 });
    // keeps any directory prefix on the base
    assert.deepEqual(parseGgufShard('owner/repo/big-00003-of-00010.gguf'),
      { base: 'owner/repo/big', index: 3, total: 10 });
  });

  test('returns null for non-split names (single gguf, .rkllm, near-misses)', () => {
    assert.equal(parseGgufShard('model.gguf'), null);
    assert.equal(parseGgufShard('model.rkllm'), null);
    assert.equal(parseGgufShard('foo-1-of-2.gguf'), null);        // not 5 digits
    assert.equal(parseGgufShard('foo-00001-of-00002.bin'), null); // not .gguf
  });

  test('only trailing shards (index > 1) are filtered; the first shard is kept', () => {
    assert.equal(isTrailingGgufShard('foo-00001-of-00002.gguf'), false); // load target — keep
    assert.equal(isTrailingGgufShard('foo-00002-of-00002.gguf'), true);  // trailing — skip
    assert.equal(isTrailingGgufShard('foo-00010-of-00010.gguf'), true);
    assert.equal(isTrailingGgufShard('model.gguf'), false);              // single model — keep
    assert.equal(isTrailingGgufShard('model.rkllm'), false);             // rkllm — keep
  });

  test('grouping a directory listing yields ONE entry per split model, targeting shard 1', () => {
    const files = [
      'foo-00001-of-00002.gguf',
      'foo-00002-of-00002.gguf',
      'plain.gguf',
      'adapter.rkllm',
    ];
    const loadable = files.filter(f => !isTrailingGgufShard(f));
    assert.deepEqual(loadable, ['foo-00001-of-00002.gguf', 'plain.gguf', 'adapter.rkllm']);
    // the split model is shown under its base name; the load target is shard 1
    assert.equal(ggufDisplayName('foo-00001-of-00002.gguf'), 'foo.gguf');
    assert.equal(ggufDisplayName('plain.gguf'), 'plain.gguf');   // unchanged
    assert.equal(ggufDisplayName('adapter.rkllm'), 'adapter.rkllm'); // unchanged
    assert.ok(!loadable.includes('foo-00002-of-00002.gguf'));
  });
});
