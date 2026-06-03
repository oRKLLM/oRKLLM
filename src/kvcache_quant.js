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
//   Same header + fixed overhead (verbatim).
//   H[0] (offset 0) overwritten with magic 0xAA55AA55.
//   H[1] (offset 4) overwritten with actual fixed_overhead size in bytes
//        (varies slightly between model loads; derived as file_size - n_tokens*BYTES_PER_TOKEN).
//   Per token: 576 × (4-byte FP32 scale + 128 INT8 values) + 16-byte padding.
//   Reduction: ~45% vs FP16 (INT8 per-vector with per-128-dim scale).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// Prefer the native N-API addon (ARM NEON SIMD, runs on libuv thread pool).
// Falls back to pure-JS on macOS / x86 dev machines.
const _require = createRequire(import.meta.url);
let _native = null;
try {
  _native = _require('../build/Release/kvcache_quant_napi.node');
} catch {
  try {
    _native = _require('../build/Debug/kvcache_quant_napi.node');
  } catch { /* pure-JS fallback */ }
}

const BYTES_PER_TOKEN   = 147472;   // FP16 bytes per token slot (2*36L*8H*128D*2 + 16 pad)
const DIMS              = 128;      // head dimension
const BYTES_FP16_VEC    = DIMS * 2; // 256 bytes per vector
const PADDING           = 16;       // trailing padding per token slot
const VECS_PER_TOKEN    = (BYTES_PER_TOKEN - PADDING) / BYTES_FP16_VEC; // 576
const Q8_VEC_BYTES      = 4 + DIMS; // FP32 scale + 128 INT8
const Q8_TOKEN_BYTES    = VECS_PER_TOKEN * Q8_VEC_BYTES + PADDING; // 76,048
const MAGIC             = 0xAA55AA55;
const H0_ORIGINAL       = 43;
// Reasonable bounds for the fixed overhead (model-level data before KV tensors)
const FIXED_OVERHEAD_MIN = 600_000;
const FIXED_OVERHEAD_MAX = 640_000;

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

// Derive fixed_overhead dynamically — it varies slightly between model loads.
function parseFixedOverhead(buf) {
  const n = readNTokens(buf);
  const fixed = buf.length - BYTES_PER_TOKEN * n;
  if (fixed < FIXED_OVERHEAD_MIN || fixed > FIXED_OVERHEAD_MAX)
    throw new Error(`Implausible fixed overhead: ${fixed} bytes (n_tokens=${n}, file=${buf.length})`);
  return { n_tokens: n, fixed_overhead: fixed };
}

// Quantise .rkllmcache → .q8cache  (async when native addon is available)
export function quantize(srcPath, dstPath) {
  if (_native) return _native.quantize(srcPath, dstPath);
  return Promise.resolve(_quantizeJS(srcPath, dstPath));
}

// Polar INT8: norm(fp16) + direction(i8) — better precision than min-max INT8 for outlier vectors
export function quantizePolar8(srcPath, dstPath) {
  if (_native) return _native.quantizePolar8(srcPath, dstPath);
  return Promise.reject(new Error('polar quantisation requires native addon (ARM64 only)'));
}

// Polar INT4: norm(fp16) + direction(i4) — 74% reduction, quality ~= min-max INT8
export function quantizePolar4(srcPath, dstPath) {
  if (_native) return _native.quantizePolar4(srcPath, dstPath);
  return Promise.reject(new Error('polar quantisation requires native addon (ARM64 only)'));
}
function _quantizeJS(srcPath, dstPath) {
  const src = fs.readFileSync(srcPath);
  const { n_tokens: n, fixed_overhead } = parseFixedOverhead(src);

  const dst = Buffer.alloc(fixed_overhead + Q8_TOKEN_BYTES * n);

  // Copy header + fixed overhead verbatim
  src.copy(dst, 0, 0, fixed_overhead);
  // Stamp magic into H[0], store fixed_overhead size in H[1]
  dst.writeUInt32LE(MAGIC, 0);
  dst.writeUInt32LE(fixed_overhead, 4);

  let dstOff = fixed_overhead;
  let maxErr = 0, sumSqErr = 0, nVals = 0;

  for (let t = 0; t < n; t++) {
    const tokBase = fixed_overhead + t * BYTES_PER_TOKEN;

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

// Dequantise any quantised cache (.q8cache/.pq8cache/.pq4cache) → FP16 .rkllmcache
// The C++ addon reads the magic byte to dispatch the right scheme automatically.
export function dequantize(srcPath, dstPath) {
  if (_native) return _native.dequantize(srcPath, dstPath);
  return Promise.resolve(_dequantizeJS(srcPath, dstPath));
}
function _dequantizeJS(srcPath, dstPath) {
  const src = fs.readFileSync(srcPath);
  if (src.readUInt32LE(0) !== MAGIC)
    throw new Error('Not a .q8cache file (bad magic)');

  const fixed_overhead = src.readUInt32LE(4); // stored by quantize()
  const n              = readNTokens(src);
  const dst            = Buffer.alloc(fixed_overhead + BYTES_PER_TOKEN * n);

  // Restore fixed overhead verbatim, then put original H[0] and H[1] back
  src.copy(dst, 0, 0, fixed_overhead);
  dst.writeUInt32LE(H0_ORIGINAL, 0);
  // H[1] (n_kv_heads=8) was overwritten; restore from bytes 12 onwards which are intact
  // Original H[1] = 8; we know this from the model architecture.
  dst.writeUInt32LE(8, 4);

  let srcOff = fixed_overhead;

  for (let t = 0; t < n; t++) {
    const tokBase = fixed_overhead + t * BYTES_PER_TOKEN;

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
  return { n_tokens: n, fixed_overhead, src_bytes: src.length, dst_bytes: dst.length };
}

// Convenience: dequantize to a temp file and return its path
export async function dequantizeToTemp(q8Path) {
  const tmp = path.join(os.tmpdir(), `rkllm_dequant_${Date.now()}.rkllmcache`);
  await dequantize(q8Path, tmp);
  return tmp;
}

export const hasNativeAddon = _native !== null;
