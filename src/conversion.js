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
import { isTrailingGgufShard } from './gguf.js';

const RETRY_MS = 30_000;

export function orkpackPathFor(absGguf) { return absGguf.replace(/\.gguf$/i, '.orkpack'); }
// Freshness sidecar: records the llama-runtime identity that BUILT this .orkpack, so a runtime
// update (which can change the pack tiling/format) can be detected and the pack regenerated.
export function orkpackMetaPath(absGguf) { return orkpackPathFor(absGguf) + '.meta.json'; }
export function hasOrkpack(absGguf) {
  try { return fs.statSync(orkpackPathFor(absGguf)).size > 0; } catch { return false; }
}

// Identity of the currently-installed llama runtime — the thing that, if it changes, means an
// existing .orkpack may be tiled/formatted for a different runtime and must be regenerated. The
// build `tag` (e.g. "b9857-ork") changes on every runtime build, so any runtime update invalidates
// stale packs. Returns null when the runtime/manifest is absent (then we can't verify → don't churn).
export function orkpackRuntimeId() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(LLAMA_RUNTIME_DIR, 'manifest.json'), 'utf8'));
    return m.tag || m.orkDriverCommit || m.llamaCommit || null;
  } catch { return null; }
}

// A .orkpack is FRESH iff it exists AND its freshness sidecar records the currently-installed
// runtime. Missing sidecar (built by an older oRKLLM that didn't stamp) or a different runtime id
// ⇒ stale ⇒ regenerate. When the current runtime id is unknown we cannot verify, so we fall back to
// mere existence (avoid needlessly discarding a possibly-good cache).
export function isOrkpackFresh(absGguf) {
  if (!hasOrkpack(absGguf)) return false;
  const cur = orkpackRuntimeId();
  if (!cur) return true;                       // can't determine runtime → trust existence
  try {
    const meta = JSON.parse(fs.readFileSync(orkpackMetaPath(absGguf), 'utf8'));
    return meta && meta.runtime === cur;
  } catch { return false; }                    // no/unreadable sidecar → treat as stale
}

// Remove a stale .orkpack and all its sidecars (freshness meta, progress json, partial .tmp).
function removeOrkpack(absGguf) {
  const pack = orkpackPathFor(absGguf);
  for (const p of [pack, pack + '.tmp', pack + '.json', orkpackMetaPath(absGguf)]) {
    try { fs.unlinkSync(p); } catch {}
  }
}

export class ConversionScheduler {
  constructor(pool) {
    this.pool    = pool;
    this.queue   = [];          // model rel-paths (under MODELS_DIR) awaiting conversion
    this.queued  = new Set();   // dedup
    this.current = null;        // { rel, abs, proc } in flight, or null
    this.currentPromise = null; // resolves when the in-flight build finishes (for convertNow to await a preempt)
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

  // Walk MODELS_DIR and enqueue every .gguf that needs a (re)build: one with no .orkpack, OR one
  // whose .orkpack is STALE for the current runtime (built by a different llama runtime — the tiling
  // /format can change across runtime versions). A stale pack is deleted here so it isn't loaded
  // (ggml-ork would reject it and re-pack inline every serve); the idle converter rebuilds it fresh.
  // Called at startup (initialization) AND after a runtime install / user-initiated runtime change.
  scanAndEnqueue() {
    const cur = orkpackRuntimeId();
    let invalidated = 0;
    const walk = (dir) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.gguf$/i.test(e.name) || isTrailingGgufShard(e.name)) continue;
        if (hasOrkpack(p) && !isOrkpackFresh(p)) {
          console.log(`[conversion] stale .orkpack for ${path.relative(MODELS_DIR, p)} (runtime changed → ${cur ?? 'unknown'}) — discarding + rebuilding`);
          removeOrkpack(p);
          invalidated++;
        }
        if (!hasOrkpack(p)) this.enqueue(path.relative(MODELS_DIR, p));
      }
    };
    walk(MODELS_DIR);
    if (invalidated) console.log(`[conversion] revalidation: ${invalidated} stale .orkpack(s) discarded for runtime ${cur ?? 'unknown'}`);
    return invalidated;
  }

  // Public entry point for a runtime change (install / user-initiated switch in Settings): re-check
  // ALL models against the newly-installed runtime and rebuild any whose cache is now stale.
  revalidateForRuntime() { return this.scanAndEnqueue(); }

  enqueue(rel) {
    if (this.queued.has(rel) || (this.current && this.current.rel === rel)) return;
    this.queued.add(rel);
    this.queue.push(rel);
    this._pump();
  }

  status() {
    return { binary: !!this.binPath, current: this.current?.rel ?? null, pending: this.queue.length };
  }

  // Start the next IDLE conversion if the NPU is free; otherwise retry shortly.
  _pump() {
    if (this.current || this.queue.length === 0) return;
    if (!this.binPath) { console.warn('[conversion] no llama-completion binary found — conversions disabled'); return; }
    if (this.pool.anyLoaded || (this.pool.queue && this.pool.queue.length)) { this._scheduleRetry(); return; }
    const rel = this.queue.shift();
    this._spawnBuild(rel).finally(() => this._pump());   // idle-driven: build one, then chain to the next
  }

  // Blocking, priority build of ONE model's .orkpack — for the pool's build-then-load cold-start guard.
  // The caller MUST have freed the NPU (evicted loaded models); this bypasses the idle-gate. Any idle
  // conversion of a DIFFERENT model in flight is preempted (single NPU stream) and re-queued, and we wait
  // for it to fully exit before starting ours (no this.current race). envExtra lets the caller pin the
  // build to the serving quant (e.g. ORK_QUANT) so the produced pack is loadable at serve time. Resolves
  // true iff the .orkpack was produced.
  async convertNow(rel, envExtra = {}) {
    if (!this.binPath) return false;
    if (hasOrkpack(path.join(MODELS_DIR, rel))) return true;   // already built
    this.queued.delete(rel);                                   // out of the idle queue — we build it now
    if (this.current && this.current.rel !== rel) {
      this.preempt();                                          // yield the NPU from a different idle build
      try { await this.currentPromise; } catch { /* preempted build settles */ }
    } else if (this.currentPromise) {
      return this.currentPromise;                              // this model is already being built — join it
    }
    return this._spawnBuild(rel, envExtra);
  }

  // Spawn ONE conversion subprocess; resolves true iff the .orkpack was produced. Shared by the idle pump
  // and the blocking convertNow. Holds this.current for the build's duration so the two paths can't run
  // concurrently on the single NPU stream.
  _spawnBuild(rel, envExtra = {}) {
    const pr = new Promise((resolve) => {
      const abs  = path.join(MODELS_DIR, rel);
      const pack = orkpackPathFor(abs);
      if (hasOrkpack(abs)) { this.queued.delete(rel); resolve(true); return; }   // built since enqueue
      // progress sidecar — /v1/models reads <model>.orkpack.json → UI shows "converting"
      try { fs.writeFileSync(pack + '.json', JSON.stringify({ status: 'converting', progress: 0 })); } catch {}
      let srcSize = 0; try { srcSize = fs.statSync(abs).size; } catch {}

      const env = { ...process.env,
        ORK_PERSIST: pack, ORK_EVICT_SRC: '1', ...envExtra,   // envExtra (e.g. ORK_QUANT) matches the serve
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

      // Live progress: ggml-ork streams packed weights into <pack>.tmp — poll its growth vs the source
      // GGUF size for a moving bar (clamped <100% until finalized).
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
        this.currentPromise = null;
        this.queued.delete(rel);
        try { fs.unlinkSync(pack + '.json'); } catch {}
        const built = hasOrkpack(abs);
        if (built) {
          // Stamp the runtime that built this pack so a later runtime change invalidates it.
          try { fs.writeFileSync(orkpackMetaPath(abs), JSON.stringify({ runtime: orkpackRuntimeId(), builtAt: Date.now() })); } catch {}
        }
        // Success at INFO; a failure (crash/kill or no pack produced) is a real problem → WARN.
        if (built) console.log(`[conversion] ${rel}: converted`);
        else console.warn(`[conversion] ${rel}: ${ok ? 'no .orkpack produced' : 'failed/killed'}`);
        resolve(built);
      };
      proc.on('exit',  (code) => done(code === 0));
      proc.on('error', ()     => done(false));
    });
    this.currentPromise = pr;   // cleared in done()
    return pr;
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
