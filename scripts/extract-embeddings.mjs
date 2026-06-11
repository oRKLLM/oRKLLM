#!/usr/bin/env node
// Extract the token-embedding table from a base HuggingFace checkpoint into a
// single-tensor `embeddings.safetensors`, for use by the Eagle-3 Vulkan draft
// head (vk_eagle.hpp), which reads one embedding row per draft step.
//
// EAGLE-3 draft heads share the target model's embedding table and therefore
// don't ship `embed_tokens` themselves. This pulls it out of the base model.
//
// Usage:
//   node scripts/extract-embeddings.mjs <base-model-dir> <out-dir>
//
//   <base-model-dir>  directory containing the base model's safetensors
//                     (single model.safetensors, or sharded with
//                     model.safetensors.index.json)
//   <out-dir>         directory to write embeddings.safetensors into
//                     (typically the Eagle-3 draft head's directory)
//
// Pure Node — no Python (per project policy). BF16 is copied through verbatim.

import fs from 'fs';
import path from 'path';

function die(msg) { console.error('error:', msg); process.exit(1); }

const [, , baseDir, outDir] = process.argv;
if (!baseDir || !outDir) die('usage: extract-embeddings.mjs <base-model-dir> <out-dir>');
if (!fs.existsSync(baseDir)) die(`base model dir not found: ${baseDir}`);
fs.mkdirSync(outDir, { recursive: true });

// Read a safetensors header → { tensors: {name: {dtype, shape, data_offsets}}, dataStart }
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const hlen = Number(lenBuf.readBigUInt64LE(0));
    const hdr = Buffer.alloc(hlen);
    fs.readSync(fd, hdr, 0, hlen, 8);
    return { tensors: JSON.parse(hdr.toString('utf8')), dataStart: 8 + hlen };
  } finally {
    fs.closeSync(fd);
  }
}

const EMBED_SUFFIX = 'embed_tokens.weight';

// Locate which file holds the embedding tensor and under what key.
function locateEmbedding() {
  const indexPath = path.join(baseDir, 'model.safetensors.index.json');
  if (fs.existsSync(indexPath)) {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const map = index.weight_map || {};
    const key = Object.keys(map).find(k => k.endsWith(EMBED_SUFFIX));
    if (!key) die(`no *.${EMBED_SUFFIX} in ${indexPath}`);
    return { key, file: path.join(baseDir, map[key]) };
  }
  // single-file checkpoint
  const single = path.join(baseDir, 'model.safetensors');
  if (!fs.existsSync(single)) die(`no index and no model.safetensors in ${baseDir}`);
  const { tensors } = readHeader(single);
  const key = Object.keys(tensors).find(k => k.endsWith(EMBED_SUFFIX));
  if (!key) die(`no *.${EMBED_SUFFIX} in ${single}`);
  return { key, file: single };
}

const { key, file } = locateEmbedding();
console.log(`found ${key} in ${path.basename(file)}`);

const { tensors, dataStart } = readHeader(file);
const info = tensors[key];
if (info.dtype !== 'BF16') die(`embedding dtype is ${info.dtype}, expected BF16`);
const [rows, cols] = info.shape;
const [begin, end] = info.data_offsets;
const nbytes = end - begin;
console.log(`embedding: [${rows} × ${cols}] BF16, ${(nbytes / 1e6).toFixed(1)} MB`);

// Build the output single-tensor safetensors header.
const outHeader = {
  'embed_tokens.weight': { dtype: 'BF16', shape: [rows, cols], data_offsets: [0, nbytes] },
};
let headerJson = JSON.stringify(outHeader);
// safetensors requires 8-byte alignment of the data section; pad header with spaces.
const headerBytes = Buffer.byteLength(headerJson, 'utf8');
const pad = (8 - ((8 + headerBytes) % 8)) % 8;
headerJson += ' '.repeat(pad);
const headerBuf = Buffer.from(headerJson, 'utf8');
const lenBuf = Buffer.alloc(8);
lenBuf.writeBigUInt64LE(BigInt(headerBuf.length), 0);

const outPath = path.join(outDir, 'embeddings.safetensors');
const outFd = fs.openSync(outPath, 'w');
const inFd = fs.openSync(file, 'r');
try {
  fs.writeSync(outFd, lenBuf);
  fs.writeSync(outFd, headerBuf);
  // Stream the tensor data in chunks (it's ~778 MB).
  const CHUNK = 16 * 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let remaining = nbytes;
  let srcPos = dataStart + begin;
  while (remaining > 0) {
    const want = Math.min(CHUNK, remaining);
    const got = fs.readSync(inFd, buf, 0, want, srcPos);
    if (got <= 0) die('unexpected EOF reading embedding data');
    fs.writeSync(outFd, buf, 0, got);
    srcPos += got;
    remaining -= got;
  }
} finally {
  fs.closeSync(inFd);
  fs.closeSync(outFd);
}

console.log(`wrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`);
