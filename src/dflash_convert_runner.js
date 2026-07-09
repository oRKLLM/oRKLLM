// DFlash safetensors → GGUF convert runner (spawned as a subprocess by DFlashConversionScheduler).
//
// Parses the draft's config.json + model.safetensors header (pure JS — no torch), maps HF tensor
// names to the GGUF (arch dflash) names the loader expects, then hands the binary heavy-lifting
// (BF16→F32→quant, gguf write, tokenizer-KV copy from the target GGUF) to the native addon's
// convert_dflash_gguf. Runs in its own process so it's non-blocking + SIGTERM-preemptible.
//
// Usage: node dflash_convert_runner.js <draftDir> <targetGguf> <outfile> <outtype>
//   env ORKLLM_ADDON=<orkllm_llama_napi.node>  ORKLLM_LLAMA_LIB=<libllama.so>
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const [draftDir, targetGguf, outfile, outtype = 'q8_0'] = process.argv.slice(2);
const ADDON = process.env.ORKLLM_ADDON;
const LIB   = process.env.ORKLLM_LLAMA_LIB;
if (!draftDir || !targetGguf || !outfile || !ADDON || !LIB) {
  console.error('[dflash-runner] usage: <draftDir> <targetGguf> <outfile> [outtype]  (env ORKLLM_ADDON, ORKLLM_LLAMA_LIB)');
  process.exit(2);
}

// ---- hparams from config.json ----
const cfg = JSON.parse(fs.readFileSync(path.join(draftDir, 'config.json'), 'utf8'));
const dcfg = cfg.dflash_config || {};
const target_layers = dcfg.target_layer_ids || cfg.target_layer_ids;
if (!Array.isArray(target_layers) || !target_layers.length) {
  console.error('[dflash-runner] config missing dflash_config.target_layer_ids'); process.exit(2);
}
const head_dim = cfg.head_dim || Math.floor(cfg.hidden_size / cfg.num_attention_heads);
const meta = {
  block_size:  cfg.block_size ?? dcfg.block_size ?? 16,
  n_embd:      cfg.hidden_size,
  n_head:      cfg.num_attention_heads,
  n_head_kv:   cfg.num_key_value_heads,
  n_layer:     cfg.num_hidden_layers,
  n_ff:        cfg.intermediate_size,
  head_dim,
  n_vocab:     cfg.vocab_size,
  rms_eps:     cfg.rms_norm_eps ?? 1e-6,
  rope_theta:  cfg.rope_theta ?? 10000000,
  n_ctx_train: cfg.max_position_embeddings ?? 32768,
};

// ---- HF tensor name → GGUF (arch dflash) name ----
function ggufName(hf) {
  if (hf === 'fc.weight')          return 'fc.weight';
  if (hf === 'hidden_norm.weight') return 'enc.output_norm.weight';
  if (hf === 'norm.weight')        return 'output_norm.weight';
  const m = hf.match(/^layers\.(\d+)\.(.+)$/);
  if (!m) return null;             // tok_embd / lm_head absent (borrowed) — skip anything else
  const b = m[1], rest = m[2];
  const map = {
    'input_layernorm.weight':          `blk.${b}.attn_norm.weight`,
    'post_attention_layernorm.weight': `blk.${b}.ffn_norm.weight`,
    'self_attn.q_proj.weight':         `blk.${b}.attn_q.weight`,
    'self_attn.k_proj.weight':         `blk.${b}.attn_k.weight`,
    'self_attn.v_proj.weight':         `blk.${b}.attn_v.weight`,
    'self_attn.o_proj.weight':         `blk.${b}.attn_output.weight`,
    'self_attn.q_norm.weight':         `blk.${b}.attn_q_norm.weight`,
    'self_attn.k_norm.weight':         `blk.${b}.attn_k_norm.weight`,
    'mlp.gate_proj.weight':            `blk.${b}.ffn_gate.weight`,
    'mlp.up_proj.weight':              `blk.${b}.ffn_up.weight`,
    'mlp.down_proj.weight':            `blk.${b}.ffn_down.weight`,
  };
  return map[rest] ?? null;
}

// ---- parse the safetensors header (8-byte LE length + JSON) ----
const stPath = path.join(draftDir, 'model.safetensors');
const fd = fs.openSync(stPath, 'r');
const lenBuf = Buffer.alloc(8); fs.readSync(fd, lenBuf, 0, 8, 0);
const headerLen = Number(lenBuf.readBigUInt64LE(0));
const hdrBuf = Buffer.alloc(headerLen); fs.readSync(fd, hdrBuf, 0, headerLen, 8);
fs.closeSync(fd);
const header = JSON.parse(hdrBuf.toString('utf8'));
const dataStart = 8 + headerLen;   // absolute offset where tensor data begins

const tensors = [];
for (const [hf, info] of Object.entries(header)) {
  if (hf === '__metadata__') continue;
  const g = ggufName(hf);
  if (!g) { console.error(`[dflash-runner] skipping unmapped tensor ${hf}`); continue; }
  if (info.dtype !== 'BF16') { console.error(`[dflash-runner] ${hf}: dtype ${info.dtype} unsupported (expect BF16)`); process.exit(2); }
  const shape = info.shape;                              // HF [out, in] (2D) or [d] (1D)
  const [start] = info.data_offsets;
  // GGUF ne order: ne0 = fastest = in (shape[1]); ne1 = out (shape[0]). 1D → ne0=d, ne1=0.
  const ne0 = shape.length === 2 ? shape[1] : shape[0];
  const ne1 = shape.length === 2 ? shape[0] : 0;
  tensors.push({ gguf_name: g, offset: dataStart + start, ne0, ne1 });
}

console.error(`[dflash-runner] ${draftDir}: ${tensors.length} tensors → ${path.basename(outfile)} (outtype=${outtype}, target=${path.basename(targetGguf)})`);

const addon = require(ADDON);
if (!addon.load_library(LIB)) { console.error('[dflash-runner] load_library failed: ' + LIB); process.exit(1); }
const res = addon.convert_dflash_gguf({
  safetensors: stPath, target_gguf: targetGguf, outfile, outtype,
  general_name: cfg.general_name || path.basename(draftDir),
  meta, target_layers, tensors,
});
if (!res || !res.ok) { console.error('[dflash-runner] convert failed: ' + (res && res.error)); process.exit(1); }
console.error('[dflash-runner] OK → ' + outfile);
process.exit(0);
