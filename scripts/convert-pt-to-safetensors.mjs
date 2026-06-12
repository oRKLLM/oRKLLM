#!/usr/bin/env node
// CLI: convert a PyTorch checkpoint (pytorch_model.bin / .pt / .pth) to
// safetensors, in pure Node (no torch). Useful for EAGLE-3 draft heads that
// ship only as a pickled checkpoint (the Vulkan draft loader reads safetensors).
//
//   node scripts/convert-pt-to-safetensors.mjs <input.bin> [output.safetensors]
//
// Default output: <dir>/model.safetensors next to the input (the filename the
// Models page / Vulkan loader expect for a draft head).

import path from 'path';
import { convertPtToSafetensors } from '../src/pt_to_safetensors.js';

const [, , input, outputArg] = process.argv;
if (!input) {
  console.error('usage: node scripts/convert-pt-to-safetensors.mjs <input.bin> [output.safetensors]');
  process.exit(1);
}
const output = outputArg || path.join(path.dirname(input), 'model.safetensors');

try {
  const t0 = Date.now();
  const res = await convertPtToSafetensors(input, output, { log: (m) => console.log(m) });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${res.tensors} tensors, ${res.bytes} bytes → ${res.outPath}`);
} catch (e) {
  console.error('Conversion failed:', e.message);
  process.exit(1);
}
