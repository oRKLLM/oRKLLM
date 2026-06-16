import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readGgufString, getGgufChatTemplate, supportsThinkingToggle, getGgufArchitecture, isRecurrentArch } from '../src/gguf.js';

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
