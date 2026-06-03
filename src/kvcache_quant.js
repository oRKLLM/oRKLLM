// KV cache quantisation/dequantisation for .rkllmcache files (RKLLM v1.2.3).
//
// File structure (confirmed empirically, Qwen3-4B):
//   [0x000–0x125]  294 bytes   Binary metadata header (int32 array)
//   [0x126–0x963ca] 615,077 b  Fixed model-level overhead (RoPE tables / quant scales)
//   [0x963cb–EOF]   variable   FP16 KV tensors: 147,472 bytes × n_tokens
//                               Each token slot: 576 × 128-dim FP16 vectors + 16 bytes padding
//                               576 = 2(K+V) × 36 layers × 8 KV heads
//
// .q8cache format:
//   Same header + fixed overhead (verbatim), H[0] overwritten with magic 0xAA55AA55.
//   Per token: 576 × (4-byte FP32 scale + 128 INT8 values) + 16-byte padding.
//   Reduction: ~45% vs FP16 (INT8 per-vector with per-128-dim scale).

import fs from 'fs';
import os from 'os';
import path from 'path';

const FIXED_OVERHEAD    = 615371;   // bytes before KV section
const BYTES_PER_TOKEN   = 147472;   // FP16 bytes per token slot
const DIMS              = 128;      // head dimension
const BYTES_FP16_VEC    = DIMS * 2; // 256 bytes per vector
const PADDING           = 16;       // trailing padding per token slot
const VECS_PER_TOKEN    = (BYTES_PER_TOKEN - PADDING) / BYTES_FP16_VEC; // 576
const Q8_VEC_BYTES      = 4 + DIMS; // FP32 scale + 128 INT8
const Q8_TOKEN_BYTES    = VECS_PER_TOKEN * Q8_VEC_BYTES + PADDING; // 76,048
const MAGIC             = 0xAA55AA55;
const H0_ORIGINAL       = 43;

function fp16ToF32(u16) {
  const s = (u16 >> 15) & 1;
  const e = (u16 >> 10) & 0x1f;
  const m = u16 & 0x3ff;
  if (e === 0)  return (s ? -1 : 1) * (m / 1024) * 2 ** -14;
  if (e === 31) return m === 0 ? (s ? -Infinity : Infinity) : NaN;
  return (s ? -1 : 1) * (1 + m / 1024) * 2 ** (e - 15);
}

function f32ToFp16(f) {
  if (isNaN(f))       return 0x7e00;
  if (!isFinite(f))   return f > 0 ? 0x7c00 : 0xfc00;
  const s = f < 0 ? 1 : 0;
  f = Math.abs(f);
  if (f === 0) return s << 15;
  let e = Math.floor(Math.log2(f));
  let m;
  if (e < -14) { m = Math.round((f / 2 ** -14) * 1024); e = 0; }
  else         { m = Math.round((f / 2 ** e - 1) * 1024); e += 15; }
  if (m >= 1024) { m = 0; e++; }
  if (e >= 31) return (s << 15) | 0x7c00;
  return (s << 15) | (e << 10) | m;
}

function readNTokens(buf) {
  return buf.readInt32LE(8); // H[2]
}

function validateFP16File(buf) {
  const n = readNTokens(buf);
  const expected = FIXED_OVERHEAD + BYTES_PER_TOKEN * n;
  if (Math.abs(buf.length - expected) > 1)
    throw new Error(`Size mismatch: got ${buf.length}, expected ${expected} (n_tokens=${n})`);
  return n;
}

// Quantise .rkllmcache → .q8cache
export function quantize(srcPath, dstPath) {
  const src = fs.readFileSync(srcPath);
  const n = validateFP16File(src);

  const dst = Buffer.alloc(FIXED_OVERHEAD + Q8_TOKEN_BYTES * n);

  // Copy header + fixed overhead verbatim, stamp magic into H[0]
  src.copy(dst, 0, 0, FIXED_OVERHEAD);
  dst.writeUInt32LE(MAGIC, 0);

  let dstOff = FIXED_OVERHEAD;
  let maxErr = 0, sumSqErr = 0, nVals = 0;

  for (let t = 0; t < n; t++) {
    const tokBase = FIXED_OVERHEAD + t * BYTES_PER_TOKEN;

    for (let v = 0; v < VECS_PER_TOKEN; v++) {
      const vecBase = tokBase + v * BYTES_FP16_VEC;
      let maxAbs = 0;
      const vals = new Float32Array(DIMS);

      for (let d = 0; d < DIMS; d++) {
        vals[d] = fp16ToF32(src.readUInt16LE(vecBase + d * 2));
        if (Math.abs(vals[d]) > maxAbs) maxAbs = Math.abs(vals[d]);
      }

      const scale = maxAbs === 0 ? 1.0 : maxAbs / 127.0;
      dst.writeFloatLE(scale, dstOff); dstOff += 4;

      for (let d = 0; d < DIMS; d++) {
        const q   = Math.max(-127, Math.min(127, Math.round(vals[d] / scale)));
        const rec = fp16ToF32(f32ToFp16(q * scale));
        const err = Math.abs(vals[d] - rec);
        if (err > maxErr) maxErr = err;
        sumSqErr += err * err;
        nVals++;
        dst.writeInt8(q, dstOff++);
      }
    }

    // Padding verbatim
    src.copy(dst, dstOff, tokBase + VECS_PER_TOKEN * BYTES_FP16_VEC, tokBase + BYTES_PER_TOKEN);
    dstOff += PADDING;
  }

  fs.writeFileSync(dstPath, dst);
  return {
    n_tokens:       n,
    src_bytes:      src.length,
    dst_bytes:      dst.length,
    reduction_pct:  ((1 - dst.length / src.length) * 100).toFixed(1),
    max_abs_err:    maxErr.toFixed(6),
    rmse:           Math.sqrt(sumSqErr / nVals).toFixed(6),
  };
}

// Dequantise .q8cache → temp .rkllmcache (FP16) for RKLLM to load
export function dequantize(srcPath, dstPath) {
  const src = fs.readFileSync(srcPath);
  if (src.readUInt32LE(0) !== MAGIC)
    throw new Error('Not a .q8cache file (bad magic)');

  const n   = readNTokens(src);
  const dst = Buffer.alloc(FIXED_OVERHEAD + BYTES_PER_TOKEN * n);

  // Restore fixed overhead; put H[0] back
  src.copy(dst, 0, 0, FIXED_OVERHEAD);
  dst.writeUInt32LE(H0_ORIGINAL, 0);

  let srcOff = FIXED_OVERHEAD;

  for (let t = 0; t < n; t++) {
    const tokBase = FIXED_OVERHEAD + t * BYTES_PER_TOKEN;

    for (let v = 0; v < VECS_PER_TOKEN; v++) {
      const vecBase = tokBase + v * BYTES_FP16_VEC;
      const scale   = src.readFloatLE(srcOff); srcOff += 4;

      for (let d = 0; d < DIMS; d++) {
        const q  = src.readInt8(srcOff++);
        dst.writeUInt16LE(f32ToFp16(q * scale), vecBase + d * 2);
      }
    }

    // Padding verbatim
    const padBase = tokBase + VECS_PER_TOKEN * BYTES_FP16_VEC;
    src.copy(dst, padBase, srcOff, srcOff + PADDING);
    srcOff += PADDING;
  }

  fs.writeFileSync(dstPath, dst);
  return { n_tokens: n, src_bytes: src.length, dst_bytes: dst.length };
}

// Convenience: dequantize to a temp file and return its path
export function dequantizeToTemp(q8Path) {
  const tmp = path.join(os.tmpdir(), `rkllm_dequant_${Date.now()}.rkllmcache`);
  dequantize(q8Path, tmp);
  return tmp;
}
