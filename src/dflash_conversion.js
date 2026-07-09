// DFlash draft-head conversion scheduler (safetensors → GGUF).
//
// z-lab DFlash draft heads download as HuggingFace safetensors (config.json architectures =
// ["DFlashDraftModel"]). Before they can be used as a DFlash draft they must be converted to a
// GGUF with arch 'dflash' (the llama.cpp `conversion/dflash.py` handler emits it). This scheduler
// automates that the same way `ConversionScheduler` automates .orkpack builds:
//   • idle-driven — converts only when no model is loaded (the convert is a heavy CPU/torch job;
//     don't contend with a serving generation). Mirrors the orkpack scheduler's idle gate.
//   • serial + preemptible — one convert at a time; a user Load preempts and re-queues it.
//   • scan-at-startup + on-download — picks up any DFlash safetensors that lack their GGUF.
//
// Unlike the .orkpack path (a llama-completion C binary on-board), safetensors→GGUF needs Python +
// torch + the llama.cpp gguf-py, which the RK3588 inference target does not carry. The convert
// EXECUTION is therefore a configurable command (ORKLLM_DFLASH_CONVERT_CMD) so it can run in a
// local venv OR be offloaded to the conversion box (.239) without changing this scheduler:
//   ORKLLM_DFLASH_CONVERT_CMD='ssh 10.3.0.239 "docker exec conv python /w/convert_hf_to_gguf.py {draft} --target-model-dir {target} --outfile {outfile} --outtype {outtype}"'
// Placeholders {draft} {target} {outfile} {outtype} are substituted. The default runs a local
// python against the fork's convert_hf_to_gguf.py (requires a provisioned venv — see status()).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MODELS_DIR, LLAMA_RUNTIME_DIR } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, 'dflash_convert_runner.js');

const RETRY_MS = 30_000;
const OUTTYPE  = process.env.ORKLLM_DFLASH_OUTTYPE || 'q8_0'; // int8-tier: usable by the NPU DFlash path

// True iff <dir> is a DFlash draft head (HF safetensors with the DFlashDraftModel architecture).
export function isDflashDraftDir(absDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(absDir, 'config.json'), 'utf8'));
    const arch = cfg.architectures;
    return Array.isArray(arch) && arch.includes('DFlashDraftModel');
  } catch { return false; }
}

// The GGUF this draft dir should produce (adjacent to the safetensors, mirrors the onion515
// convention <name>-<outtype>.gguf so /v1/models surfaces it like any other draft GGUF).
export function dflashGgufFor(absDir) {
  return path.join(absDir, `${path.basename(absDir)}-${OUTTYPE}.gguf`);
}
export function hasDflashGguf(absDir) {
  try { return fs.statSync(dflashGgufFor(absDir)).size > 0; } catch { return false; }
}

export class DFlashConversionScheduler {
  constructor(pool) {
    this.pool    = pool;
    this.queue   = [];          // draft-dir rel-paths (under MODELS_DIR) awaiting conversion
    this.queued  = new Set();
    this.current = null;        // { rel, abs, proc } in flight, or null
    this.currentPromise = null;
    this._timer  = null;
    this.cmdTemplate = process.env.ORKLLM_DFLASH_CONVERT_CMD || null;  // offload override; default = native node runner
  }

  // Resolve a TARGET GGUF the draft speculates for — the native converter copies the tokenizer KVs
  // from it (the draft borrows the target's tokenizer/embeddings at run time). Heuristic: strip a
  // -DFlash/-dflash suffix from the draft dir's basename and find any non-DFlash .gguf whose path
  // contains that base name. Overridable per-model via settings.dflash_target_gguf.
  resolveTargetGguf(absDraftDir, savedTargetGguf = null) {
    if (savedTargetGguf) {
      const t = path.isAbsolute(savedTargetGguf) ? savedTargetGguf : path.join(MODELS_DIR, savedTargetGguf);
      if (fs.existsSync(t)) return t;
    }
    const base = path.basename(absDraftDir).replace(/[-_.]?dflash$/i, '').toLowerCase();
    let found = null;
    const walk = (dir, depth) => {
      if (found || depth > 4) return;
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (found) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (/\.gguf$/i.test(e.name) && !/dflash/i.test(p) && p.toLowerCase().includes(base)) { found = p; return; }
      }
    };
    walk(MODELS_DIR, 0);
    return found;
  }

  // Walk MODELS_DIR and enqueue every DFlash draft dir that lacks its GGUF. Called at startup and
  // after a download completes.
  scanAndEnqueue() {
    const walk = (dir, depth) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (isDflashDraftDir(p)) {
          if (!hasDflashGguf(p)) this.enqueue(path.relative(MODELS_DIR, p));
        } else if (depth < 3) {
          walk(p, depth + 1);
        }
      }
    };
    walk(MODELS_DIR, 0);
  }

  enqueue(rel) {
    if (this.queued.has(rel) || (this.current && this.current.rel === rel)) return;
    this.queued.add(rel);
    this.queue.push(rel);
    this._pump();
  }

  status() {
    return {
      runner: this.cmdTemplate ? 'offload' : 'native',
      current: this.current?.rel ?? null,
      pending: this.queue.length,
    };
  }

  _pump() {
    if (this.current || this.queue.length === 0) return;
    // Heavy CPU job — only run when idle, like the .orkpack scheduler. (The native runner needs the
    // addon's convert_dflash_gguf; if absent it fails per-item, no need to gate the whole scheduler.)
    if (this.pool.anyLoaded || (this.pool.queue && this.pool.queue.length)) { this._scheduleRetry(); return; }
    const rel = this.queue.shift();
    this._spawnConvert(rel).finally(() => this._pump());
  }

  // Build the argv for the convert. Default: local python fork/convert_hf_to_gguf.py. Offload: split
  // the ORKLLM_DFLASH_CONVERT_CMD template with placeholders substituted (run through a shell so an
  // ssh "..." template works). Returns { cmd, args, shell }.
  _buildCommand(absDraft, targetGguf, outfile) {
    if (this.cmdTemplate) {
      const line = this.cmdTemplate
        .replaceAll('{draft}', absDraft).replaceAll('{target}', targetGguf)
        .replaceAll('{outfile}', outfile).replaceAll('{outtype}', OUTTYPE);
      return { cmd: 'sh', args: ['-c', line], env: process.env };
    }
    // Default: the native node runner (no python/torch). It parses the safetensors + config, then the
    // addon's convert_dflash_gguf quantizes the weights and copies the tokenizer KVs from targetGguf.
    const addon = process.env.ORKLLM_ADDON     || path.join(__dirname, '../build/Release/orkllm_llama_napi.node');
    const lib   = process.env.ORKLLM_LLAMA_LIB || path.join(LLAMA_RUNTIME_DIR, 'libllama.so');
    return { cmd: process.execPath, args: [RUNNER, absDraft, targetGguf, outfile, OUTTYPE],
             env: { ...process.env, ORKLLM_ADDON: addon, ORKLLM_LLAMA_LIB: lib } };
  }

  _spawnConvert(rel, savedTargetGguf = null) {
    const pr = new Promise((resolve) => {
      const abs     = path.join(MODELS_DIR, rel);
      const outfile = dflashGgufFor(abs);
      if (hasDflashGguf(abs)) { this.queued.delete(rel); resolve(true); return; }

      const target = this.resolveTargetGguf(abs, savedTargetGguf);
      if (!target) {
        console.warn(`[dflash-convert] ${rel}: could not resolve a target GGUF (needed to copy the tokenizer) — set settings.dflash_target_gguf; skipping`);
        this.queued.delete(rel); resolve(false); return;
      }

      const progress = outfile + '.json';
      try { fs.writeFileSync(progress, JSON.stringify({ status: 'converting', progress: 0 })); } catch {}
      let srcSize = 0; try {
        for (const f of fs.readdirSync(abs)) if (/\.safetensors$/.test(f)) srcSize += fs.statSync(path.join(abs, f)).size;
      } catch {}

      const { cmd, args, env } = this._buildCommand(abs, target, outfile);
      console.log(`[dflash-convert] building ${rel} → ${path.basename(outfile)} (target=${path.relative(MODELS_DIR, target)}, outtype=${OUTTYPE}) …`);
      const proc = spawn(cmd, args, { env, stdio: 'ignore' });
      this.current = { rel, abs, proc };

      // Live progress: poll the outfile growth vs the source safetensors size (GGUF ends up smaller
      // when quantized, so this is a rough moving bar clamped < 100 until finalized).
      const tick = setInterval(() => {
        try {
          const w = fs.statSync(outfile).size;
          const p = srcSize > 0 ? Math.min(99, Math.round(100 * w / srcSize)) : 0;
          fs.writeFileSync(progress, JSON.stringify({ status: 'converting', progress: p }));
        } catch { /* outfile not created yet */ }
      }, 2000);

      const done = (ok) => {
        clearInterval(tick);
        this.current = null;
        this.currentPromise = null;
        this.queued.delete(rel);
        try { fs.unlinkSync(progress); } catch {}
        const built = hasDflashGguf(abs);
        if (built) console.log(`[dflash-convert] ${rel}: converted → ${path.basename(outfile)}`);
        else       console.warn(`[dflash-convert] ${rel}: ${ok ? 'no GGUF produced' : 'failed/killed'}`);
        resolve(built);
      };
      proc.on('exit',  (code) => done(code === 0));
      proc.on('error', ()     => done(false));
    });
    this.currentPromise = pr;
    return pr;
  }

  preempt() {
    if (!this.current) return;
    const { rel, proc } = this.current;
    console.log(`[dflash-convert] preempted by a model load — re-queuing ${rel}`);
    try { proc.kill('SIGTERM'); } catch {}
    this.queued.delete(rel);
    this.queue.unshift(rel);
  }

  onIdle() { this._pump(); }

  _scheduleRetry() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._pump(); }, RETRY_MS);
  }
}

let _instance = null;
export function initDFlashConversionScheduler(pool) { _instance = new DFlashConversionScheduler(pool); return _instance; }
export function getDFlashConversionScheduler() { return _instance; }
