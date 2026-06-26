// .orkpack conversion scheduler.
//
// Builds `<model>.orkpack` (the NPU-native pre-tiled weight cache) for every servable .gguf that
// lacks one, so loading a model becomes a fast DMA-copy instead of a slow dequant→quant→tile pass
// (see the ork-driver wiki: Layer-Streaming and .orkpack Persist). It is:
//   • serial      — the NPU is single-stream; one conversion at a time.
//   • idle-driven — converts only when no model is loaded (anyLoaded === false).
//   • preemptible — a user Load kills the in-flight conversion and re-queues it (the user wins the NPU).
//
// The conversion runs a separate `llama-completion` process with ORK_PERSIST set: it packs every
// weight once (pack→dump→free keeps ≤1 weight resident, so it fits any model size) and finalizes the
// .orkpack on its clean exit. We deliberately spawn the CLI rather than the serving worker — the worker
// is hard-killed on unload (no clean ggml-ork teardown → no finalize), whereas a CLI exit finalizes.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { MODELS_DIR, LLAMA_RUNTIME_DIR } from './config.js';

const RETRY_MS = 30_000;

export function orkpackPathFor(absGguf) { return absGguf.replace(/\.gguf$/i, '.orkpack'); }
export function hasOrkpack(absGguf) {
  try { return fs.statSync(orkpackPathFor(absGguf)).size > 0; } catch { return false; }
}

export class ConversionScheduler {
  constructor(pool) {
    this.pool    = pool;
    this.queue   = [];          // model rel-paths (under MODELS_DIR) awaiting conversion
    this.queued  = new Set();   // dedup
    this.current = null;        // { rel, abs, proc } in flight, or null
    this.binPath = this._findBin();
    this._timer  = null;
  }

  _findBin() {
    const cands = [
      process.env.ORKLLM_LLAMA_COMPLETION_BIN,
      LLAMA_RUNTIME_DIR && path.join(LLAMA_RUNTIME_DIR, 'llama-completion'),
      path.join(process.env.HOME || '', 'llama.cpp/build/bin/llama-completion'),
    ].filter(Boolean);
    return cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
  }

  // Walk MODELS_DIR for .gguf without a valid .orkpack (covers manually-dropped models, not just
  // downloaded ones) and enqueue them. Called at startup and after a download completes.
  scanAndEnqueue() {
    const walk = (dir) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.gguf$/i.test(e.name) && !hasOrkpack(p)) this.enqueue(path.relative(MODELS_DIR, p));
      }
    };
    walk(MODELS_DIR);
  }

  enqueue(rel) {
    if (this.queued.has(rel) || (this.current && this.current.rel === rel)) return;
    this.queued.add(rel);
    this.queue.push(rel);
    this._pump();
  }

  status() {
    return { binary: !!this.binPath, current: this.current?.rel ?? null, pending: this.queue.length };
  }

  // Start the next conversion if the NPU is free; otherwise retry shortly.
  _pump() {
    if (this.current || this.queue.length === 0) return;
    if (!this.binPath) { console.warn('[conversion] no llama-completion binary found — conversions disabled'); return; }
    if (this.pool.anyLoaded || (this.pool.queue && this.pool.queue.length)) { this._scheduleRetry(); return; }

    const rel  = this.queue.shift();
    const abs  = path.join(MODELS_DIR, rel);
    const pack = orkpackPathFor(abs);
    if (hasOrkpack(abs)) { this.queued.delete(rel); this._pump(); return; }   // built since enqueue
    // progress sidecar — /v1/models reads <model>.orkpack.json → UI shows "converting"
    try { fs.writeFileSync(pack + '.json', JSON.stringify({ status: 'converting', progress: 0 })); } catch {}
    let srcSize = 0; try { srcSize = fs.statSync(abs).size; } catch {}

    const env = { ...process.env,
      ORK_PERSIST: pack, ORK_EVICT_SRC: '1',
      LD_LIBRARY_PATH: [LLAMA_RUNTIME_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
    // A single 1-token forward pass packs+dumps every weight; --no-repack keeps weights host so the
    // ggml-ork matmul offload fires; -ngl 99 offloads all layers. `--device ORK` PINS them to the NPU:
    // the release runtime also ships ggml-vulkan (Mali), and ggml-ork is a BLAS-like ACCEL backend, so
    // a bare -ngl assigns the layers to the first GPU device (Vulkan0) — weights land in Mali buffers,
    // MUL_MAT runs on Vulkan, and ggml-ork packs ZERO weights → no .orkpack. Targeting the ORK device
    // (rather than disabling Vulkan) routes the matmuls to the NPU while leaving the GPU available.
    const args = ['-m', abs, '--device', 'ORK', '-ngl', '99', '-t', '4', '-c', '256', '--no-repack',
                  '-p', 'x', '-n', '1', '--temp', '0', '-no-cnv'];
    console.log(`[conversion] building ${rel}.orkpack …`);
    const proc = spawn(this.binPath, args, { env, stdio: 'ignore' });
    this.current = { rel, abs, proc };

    // Live progress: the conversion is one opaque subprocess, but ggml-ork streams the packed weights
    // into <pack>.tmp as it goes — poll its growth against the source GGUF size for a moving bar
    // (clamped <100% until the .orkpack is finalized). Without this the sidecar sat at 0 then jumped to done.
    const tick = setInterval(() => {
      try {
        const w = fs.statSync(pack + '.tmp').size;
        const p = srcSize > 0 ? Math.min(99, Math.round(100 * w / srcSize)) : 0;
        fs.writeFileSync(pack + '.json', JSON.stringify({ status: 'converting', progress: p }));
      } catch { /* .tmp not created yet (model still loading) — keep the last value */ }
    }, 1500);

    const done = (ok) => {
      clearInterval(tick);
      this.current = null;
      this.queued.delete(rel);
      try { fs.unlinkSync(pack + '.json'); } catch {}
      const built = hasOrkpack(abs);
      console.log(`[conversion] ${rel}: ${built ? 'converted' : (ok ? 'no .orkpack produced' : 'failed/killed')}`);
      this._pump();
    };
    proc.on('exit',  (code) => done(code === 0));
    proc.on('error', ()     => done(false));
  }

  // A user Load is taking the NPU — kill any in-flight conversion and re-queue it for later idle time.
  preempt() {
    if (!this.current) return;
    const { rel, proc } = this.current;
    console.log(`[conversion] preempted by a model load — re-queuing ${rel}`);
    try { proc.kill('SIGTERM'); } catch {}
    // exit handler clears this.current + re-pumps; ensure it converts again (partial .tmp is discarded)
    this.queued.delete(rel);
    this.queue.unshift(rel);
  }

  // The NPU went idle (a model unloaded) — resume converting.
  onIdle() { this._pump(); }

  _scheduleRetry() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._pump(); }, RETRY_MS);
  }
}

// Singleton — the load route preempts it (yield the NPU) without an import cycle.
let _instance = null;
export function initConversionScheduler(pool) { _instance = new ConversionScheduler(pool); return _instance; }
export function getConversionScheduler() { return _instance; }
