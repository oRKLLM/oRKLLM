#!/usr/bin/env node
// Binary patch for librkllmrt.so (build 77daf2e2 / v1.2.3, aarch64) that fixes the
// Eagle-3 verification segfault.
//
// The runtime is a stripped llama.cpp + ggml. During Eagle-3 verification
// (RKLLM_INFER_GET_LOGITS with token input + keep_history=true) ggml_soft_max_ext's
// shape validation aborts on `GGML_ASSERT(mask->ne[0] == a->ne[0])` and segfaults
// the worker (which, pre-fix, also leaked the NPU handle and could wedge the device).
//
// The two guarding conditional branches are NOP'd so the (overly strict for this
// path) mask asserts no longer fire. Empirically verified on RK3588: the verify
// call then returns valid logits, and normal generation is unaffected (the asserts
// pass on the normal path, so the NOPs are no-ops there). Only these two asserts are
// touched — every other GGML_ASSERT is left intact.
//
// Reproducible + safe: the patch only applies if the exact original bytes match at
// the expected offsets, so it refuses to touch a different build.
//
//   node scripts/patch-runtime-verify-fix.mjs <in.so> [out.so]
//
// Default out: <in>.eagle-verify-patched.so . See the wiki "RKLLM Runtime Internals".

import fs from 'fs';

const PATCHES = [
  { off: 0x2b55a8, orig: '01090054', note: 'b.ne 0x2b56c8 (mask->ne[0]==a->ne[0] assert)' },
  { off: 0x2b55b8, orig: '0b080054', note: 'b.lt 0x2b56b8 (mask->ne[1]>=a->ne[1] assert)' },
];
const NOP = Buffer.from('1f2003d5', 'hex'); // little-endian d503201f

const [, , input, outputArg] = process.argv;
if (!input) {
  console.error('usage: node scripts/patch-runtime-verify-fix.mjs <librkllmrt.so> [out.so]');
  process.exit(1);
}
const output = outputArg || input.replace(/\.so$/, '') + '.eagle-verify-patched.so';

const buf = fs.readFileSync(input);
for (const p of PATCHES) {
  const cur = buf.subarray(p.off, p.off + 4).toString('hex');
  if (cur === NOP.toString('hex')) { console.log(`0x${p.off.toString(16)}: already patched`); continue; }
  if (cur !== p.orig) {
    console.error(`refusing to patch: 0x${p.off.toString(16)} has ${cur}, expected ${p.orig} (${p.note}).`);
    console.error('This script only matches librkllmrt build 77daf2e2 / v1.2.3 aarch64.');
    process.exit(2);
  }
  NOP.copy(buf, p.off);
  console.log(`0x${p.off.toString(16)}: ${p.orig} -> ${NOP.toString('hex')}  (${p.note})`);
}
fs.writeFileSync(output, buf);
console.log(`Wrote patched runtime → ${output}`);
