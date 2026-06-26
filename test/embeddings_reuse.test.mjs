import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readEmbeddingsMeta,
  embeddingsMetaMatch,
  findReusableEmbeddings,
  copyEmbeddings,
} from '../src/hf_embeddings.js';

// ── Minimal single-tensor safetensors writer (mirrors hf_embeddings' format) ──
// Header = 8-byte LE length prefix + JSON header (8-byte aligned) + raw data.
function writeEmbeddings(file, { shape, dtype, nbytes }) {
  const out = {
    'model.embed_tokens.weight': { dtype, shape, data_offsets: [0, nbytes] },
  };
  let json = JSON.stringify(out);
  const pad = (8 - ((8 + Buffer.byteLength(json, 'utf8')) % 8)) % 8;
  json += ' '.repeat(pad);
  const headerBuf = Buffer.from(json, 'utf8');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0);
  // Fill the data section with a deterministic, recognizable pattern.
  const data = Buffer.alloc(nbytes);
  for (let i = 0; i < nbytes; i++) data[i] = i & 0xff;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([lenBuf, headerBuf, data]));
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orkllm-embreuse-'));
}

describe('embeddings reuse', () => {
  test('readEmbeddingsMeta reads shape/dtype/nbytes; null when absent', () => {
    const root = tmpRoot();
    const f = path.join(root, 'embeddings.safetensors');
    writeEmbeddings(f, { shape: [248320, 2048], dtype: 'BF16', nbytes: 256 });
    const meta = readEmbeddingsMeta(f);
    assert.deepEqual(meta.shape, [248320, 2048]);
    assert.equal(meta.dtype, 'BF16');
    assert.equal(meta.nbytes, 256);
    assert.equal(readEmbeddingsMeta(path.join(root, 'nope.safetensors')), null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('embeddingsMetaMatch matches identical shape+dtype only', () => {
    const a = { shape: [248320, 2048], dtype: 'BF16' };
    assert.equal(embeddingsMetaMatch(a, { shape: [248320, 2048], dtype: 'BF16' }), true);
    assert.equal(embeddingsMetaMatch(a, { shape: [248320, 2048], dtype: 'F16' }), false);  // dtype differs
    assert.equal(embeddingsMetaMatch(a, { shape: [151936, 2048], dtype: 'BF16' }), false); // vocab differs
    assert.equal(embeddingsMetaMatch(a, { shape: [248320], dtype: 'BF16' }), false);       // rank differs
    assert.equal(embeddingsMetaMatch(a, null), false);
  });

  test('findReusableEmbeddings discovers tables and honours excludeDir', () => {
    const root = tmpRoot();
    writeEmbeddings(path.join(root, 'Qwen', 'eagle3-A', 'embeddings.safetensors'), { shape: [248320, 2048], dtype: 'BF16', nbytes: 128 });
    writeEmbeddings(path.join(root, 'Qwen', 'dflash-B', 'embeddings.safetensors'), { shape: [248320, 2048], dtype: 'BF16', nbytes: 128 });
    fs.mkdirSync(path.join(root, 'Qwen', 'eagle3-C'), { recursive: true }); // no embeddings yet

    const all = findReusableEmbeddings(root);
    assert.equal(all.length, 2);
    assert.ok(all.every(c => c.dtype === 'BF16' && c.shape[0] === 248320));

    // Exclude the requesting draft's own dir.
    const others = findReusableEmbeddings(root, 'Qwen/eagle3-A');
    assert.equal(others.length, 1);
    assert.equal(others[0].dir, 'Qwen/dflash-B');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('copyEmbeddings reproduces the source (hardlink within one FS)', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'src', 'embeddings.safetensors');
    const dst = path.join(root, 'dst', 'embeddings.safetensors');
    writeEmbeddings(src, { shape: [248320, 2048], dtype: 'BF16', nbytes: 512 });
    fs.mkdirSync(path.dirname(dst), { recursive: true });

    const r = await copyEmbeddings({ srcPath: src, destPath: dst });
    assert.ok(r.linked === true || r.linked === false); // either path is acceptable
    assert.deepEqual(fs.readFileSync(dst), fs.readFileSync(src)); // byte-identical
    assert.deepEqual(readEmbeddingsMeta(dst).shape, [248320, 2048]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('copyEmbeddings rejects a shape/dtype mismatch against expect', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'src', 'embeddings.safetensors');
    const dst = path.join(root, 'dst.safetensors');
    writeEmbeddings(src, { shape: [151936, 2048], dtype: 'BF16', nbytes: 64 });
    await assert.rejects(
      () => copyEmbeddings({ srcPath: src, destPath: dst, expect: { shape: [248320, 2048], dtype: 'BF16' } }),
      /mismatch/,
    );
    assert.equal(fs.existsSync(dst), false); // nothing written on rejection
    fs.rmSync(root, { recursive: true, force: true });
  });
});
