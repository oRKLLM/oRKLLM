// .orkpack conversion scheduler.
//
// Builds `<model>.orkpack` (the NPU-native pre-tiled weight cache) for every servable .gguf that
// lacks one, so loading a model becomes a fast DMA-copy instead of a slow dequant→quant→tile pass
// (see the ork-driver wiki: Layer-Streaming and .orkpack Persist). It is:
//   • serial      — the NPU is single-stream; one conversion at a time.
//   • idle-driven — converts only when no model is loaded (anyLoaded === false).
//   • preemptible — a user Load kills the in-flight conversion and re-queues it (the user wins the NPU).
//
// The conversion runs a separate `llama-completion` process: ggml-ork DERIVES the pack path from the
// -m model (<model-dir>/<basename>.orkpack — exactly orkpackPathFor) and builds an absent pack itself.
// It packs every weight once (pack→dump→free keeps ≤1 weight resident, so it fits any model size) and
// finalizes the .orkpack on its clean exit. We deliberately spawn the CLI rather than the serving worker
// — the worker is hard-killed on unload (no clean ggml-ork teardown → no finalize), a CLI exit finalizes.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { MODELS_DIR, LLAMA_RUNTIME_DIR } from './config.js';
import { isTrailingGgufShard, isOrkpackStub, getGgufArchitecture } from './gguf.js';
import { orkpackPathFor, isOrkpackUsable, readOrkpackFooter, recordOrkFmt, llamaRuntimeTag, orkEnvFrom } from './orkpack.js';

export { orkpackPathFor };

// Architectures the ggml-ork NPU MUL_MAT accelerator cannot pack into an .orkpack, detected up front
// so we skip at enqueue time (never spawn a doomed conversion that just churns the NPU):
//   • 'qwen35' (Qwen3.5/3.6) — SSM / Gated-Delta-Net hybrid: state-space + dynamic/batched matmuls,
//     not the static MUL_MAT the accelerator packs.
//   • 'dflash' — a DFlash speculative-draft head, not a standalone servable model; it runs co-resident
//     with its target via run_dflash and has no .orkpack of its own.
const UNSUPPORTED_ARCHS = new Set(['qwen35', 'dflash']);

const RETRY_MS = 30_000;
// How much of a failed conversion's stderr to keep, and how many lines of it to surface.
const STDERR_TAIL_CHARS = 16_384;
const STDERR_LOG_LINES  = 10;
// The runtime signs off with a per-domain residency table, so the raw tail is almost always the least
// informative part of the output. Prefer lines that actually say something went wrong, and fall back to
// the tail only when none match.
const STDERR_SIGNAL_RE = /error|fail|abort|assert|unsupported|refus|cannot|declin|invalid|not found|ORK (PERSIST|META|STUB)|warn/i;
const STDERR_NOISE_RE  = /^\s*\[ork RESIDENT\]\s+domain \d+:/i;

// Pick the most diagnostic lines out of a captured stderr tail.
function stderrHighlights(text) {
  const lines = String(text).split('\n').map(l => l.trimEnd()).filter(Boolean).filter(l => !STDERR_NOISE_RE.test(l));
  const signal = lines.filter(l => STDERR_SIGNAL_RE.test(l));
  return (signal.length ? signal : lines).slice(-STDERR_LOG_LINES);
}

// The env pair a given quantize configuration builds at — and, necessarily, that the serving run must
// adopt. ORK_QUANT alone is the int4 STORAGE tier: 4-bit on disk, inflated to int8 on the NPU and
// computed by the W8A8 kernel, so no 4-bit MAC ever runs. A genuinely mixed int4/int8 pack additionally
// needs the NATIVE W4A4 compute path, and a promotion tier that PERSISTS int8 rather than re-inflating:
// 'i8' is plain int8 with per-channel scales, where the default 'rot8' keeps the Hadamard basis — 11%
// worse on the runtime's own sweep, the rotation that helps 4 bits hurting 8.
export function orkPrecisionForBuild(bits, mixed) {
  const p = { orkQuant: String(bits) };
  if (mixed && bits === 4) { p.orkMixedW4A4 = '1'; p.orkPromote = 'i8'; }
  return p;
}

export function hasOrkpack(absGguf) {
  try { return fs.statSync(orkpackPathFor(absGguf)).size > 0; } catch { return false; }
}

// Is this model's .orkpack one the runtime would ADOPT as-is (no re-conversion)?
//
// This asks the PACK, not the calendar. It used to compare a sidecar recording the llama-runtime build
// tag that wrote the pack — which was wrong in both directions. Too coarse: the fork cuts ~8 build tags
// a day, so every runtime sync invalidated and rebuilt every pack on the box (measured upstream: 53
// packs / 220 GiB) even though ork-driver's on-disk format has not changed since 2026-07-20. Too loose:
// a tag match said nothing about the build-config PRECISION signature, so a pack built at one precision
// looked fresh to a load that would serve at another — and ggml-ork rejects that pack, which for one
// over ORK_ORKPACK_MAX_REGEN_MB (2048) means abort(), not a rebuild.
//
// The footer answers both exactly; see src/orkpack.js. Pass the precision this model will SERVE at so
// the signature check is the same one the runtime will apply; omit it for a weaker structural check.
export function isOrkpackFresh(absGguf, precision = null) {
  return isOrkpackUsable(orkpackPathFor(absGguf), precision);
}

// Remove an unusable .orkpack and every sidecar that belongs to it. The .gmax tuning profile and the
// stub GGUF describe the pack's specific contents, so leaving them behind would attach an old profile
// to a freshly built pack (ggml-ork only unlinks .gmax when IT sees the pack as stale — when we delete
// first, it just sees "absent" and that cleanup never runs). .meta.json is the retired freshness
// sidecar, swept here so old installs don't leave litter.
function removeOrkpack(absGguf) {
  const pack = orkpackPathFor(absGguf);
  for (const p of [pack, pack + '.tmp', pack + '.json', pack + '.meta.json', pack + '.gmax', pack + '.gguf']) {
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

  // Walk MODELS_DIR and enqueue every .gguf that needs a (re)build: one with no .orkpack, OR one whose
  // .orkpack this runtime would REFUSE (see isOrkpackFresh — footer schema, on-disk format token, and
  // the precision signature we'd serve it at). A refused pack is deleted here rather than left to be
  // met at load time: ggml-ork would re-pack it inline on every serve, and for a pack over
  // ORK_ORKPACK_MAX_REGEN_MB it aborts instead. Deleting first also means the rebuild sees "absent",
  // not "stale", so no oversize-regeneration guard stands in its way.
  // Called at startup (initialization) AND after a runtime install / user-initiated runtime change.
  scanAndEnqueue() {
    const tag = llamaRuntimeTag();
    let invalidated = 0;
    const walk = (dir) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.gguf$/i.test(e.name) || isTrailingGgufShard(e.name) || isOrkpackStub(e.name)) continue;
        const rel = path.relative(MODELS_DIR, p);
        if (hasOrkpack(p) && !isOrkpackFresh(p, this._precisionFor(rel))) {
          console.log(`[conversion] unusable .orkpack for ${rel} — discarding + rebuilding`);
          removeOrkpack(p);
          invalidated++;
        }
        if (!hasOrkpack(p)) this.enqueue(rel);
      }
    };
    walk(MODELS_DIR);
    if (invalidated) console.log(`[conversion] revalidation: ${invalidated} unusable .orkpack(s) discarded (runtime ${tag ?? 'unknown'})`);
    return invalidated;
  }

  // Public entry point for a runtime change (install / user-initiated switch in Settings): re-check ALL
  // models against the newly-installed runtime. A runtime update on its own does NOT invalidate anything
  // — only a pack the new runtime would actually refuse is discarded and rebuilt.
  revalidateForRuntime() { return this.scanAndEnqueue(); }

  enqueue(rel) {
    if (this.queued.has(rel) || (this.current && this.current.rel === rel)) return;
    const _arch = getGgufArchitecture(path.join(MODELS_DIR, rel));
    if (UNSUPPORTED_ARCHS.has(_arch)) {
      const why = _arch === 'dflash'
        ? 'DFlash speculative-draft head — runs co-resident, no standalone .orkpack'
        : 'SSM/GDN-hybrid, not static MUL_MAT';
      console.warn(`[conversion] ${rel}: arch '${_arch}' unsupported by the NPU matmul accelerator (${why}); skipping (no .orkpack).`);
      return;
    }
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
    // Same precision env the pool will SERVE this model with — see _buildEnvFor.
    this._spawnBuild(rel, this._buildEnvFor(rel)).finally(() => this._pump());   // idle-driven: build one, then chain
  }

  // The .orkpack footer stamps a build-config signature (ORK_QUANT + ORK_HYBRID) and ggml-ork REJECTS a
  // pack whose signature is incompatible with the run loading it — ORK_HYBRID strictly, ORK_QUANT whenever
  // the run sets it. A rejected pack counts as STALE, and stale over ORK_ORKPACK_MAX_REGEN_MB (default
  // 2048) makes the runtime abort() instead of rebuilding. So an idle build must not use the runtime
  // default precision; it must use whatever the pool would serve this model with.
  _buildEnvFor(rel) { return orkEnvFrom(this._precisionFor(rel)); }

  // The precision this model will be SERVED at — the same values the pool resolves at load. Asked of
  // the pool rather than imported, because pool.js imports this module (importing it back would cycle).
  _precisionFor(rel) {
    try { return this.pool?.orkPrecision?.(rel) ?? {}; } catch { return {}; }
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
  _spawnBuild(rel, envExtra = {}, packArgs = [], label = null) {
    const pr = new Promise((resolve) => {
      const abs  = path.join(MODELS_DIR, rel);
      const pack = orkpackPathFor(abs);
      if (hasOrkpack(abs)) { this.queued.delete(rel); resolve(true); return; }   // built since enqueue
      // progress sidecar — /v1/models reads <model>.orkpack.json → UI shows "converting"
      const sidecar = (progress) => { try {
        fs.writeFileSync(pack + '.json', JSON.stringify({ status: 'converting', progress, ...(label ? { label } : {}) }));
      } catch {} };
      sidecar(0);
      let srcSize = 0; try { srcSize = fs.statSync(abs).size; } catch {}

      // ORK_PERSIST is REMOVED upstream and now GGML_ABORTs the process — the pack path is derived from
      // -m, so it must NOT be set. ORK_NO_STUB=1 suppresses the companion stub GGUF that finalize would
      // otherwise drop at <model>.orkpack.gguf: a holed copy of the source (~2 GiB for a 12 GiB pack) that
      // our own .gguf scanners would list as a servable model and re-enqueue, and that is unloadable
      // without its pack.
      const env = { ...process.env,
        ORK_EVICT_SRC: '1', ORK_NO_STUB: '1', ...envExtra,   // envExtra (ORK_QUANT/ORK_HYBRID) matches the serve
        LD_LIBRARY_PATH: [LLAMA_RUNTIME_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
      // A single 1-token forward pass packs+dumps every weight; --no-repack keeps weights host so the
      // ggml-ork matmul offload fires; -ngl 99 offloads all layers. `--device ORK` PINS them to the NPU:
      // the release runtime also ships ggml-vulkan (Mali), and ggml-ork is a BLAS-like ACCEL backend, so
      // a bare -ngl assigns the layers to the first GPU device (Vulkan0) — weights land in Mali buffers,
      // MUL_MAT runs on Vulkan, and ggml-ork packs ZERO weights → no .orkpack. Targeting the ORK device
      // (rather than disabling Vulkan) routes the matmuls to the NPU while leaving the GPU available.
      const args = ['-m', abs, '--device', 'ORK', '-ngl', '99', '-t', '4', '-c', '256', '--no-repack',
                    ...packArgs,
                    '-p', 'x', '-n', '1', '--temp', '0', '-no-cnv'];
      console.log(`[conversion] building ${rel}.orkpack …${label ? ' (' + label + ')' : ''}`);
      // Keep the child's stderr. It was 'ignore', which meant every failure reported only
      // "no .orkpack produced" with the reason discarded — the runtime prints exactly why it declined
      // (wrong device, unsupported arch, a stale pack it refuses to regenerate, an abort), and that
      // line is the whole diagnosis. Bounded to the tail so a chatty run cannot grow unboundedly.
      const proc = spawn(this.binPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let errTail = '';
      proc.stderr?.on('data', (d) => {
        errTail = (errTail + d.toString()).slice(-STDERR_TAIL_CHARS);
      });
      this.current = { rel, abs, proc };

      // Live progress: ggml-ork streams packed weights into <pack>.tmp — poll its growth vs the source
      // GGUF size for a moving bar (clamped <100% until finalized).
      const tick = setInterval(() => {
        try {
          const w = fs.statSync(pack + '.tmp').size;
          const p = srcSize > 0 ? Math.min(99, Math.round(100 * w / srcSize)) : 0;
          sidecar(p);
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
          // This pack was written by the CURRENTLY-installed runtime, so its footer states the on-disk
          // format token that runtime expects. Record it — that is the one field of the freshness check
          // we cannot compute ourselves without loading the NPU runtime (see src/orkpack.js).
          const f = readOrkpackFooter(pack);
          if (f) recordOrkFmt(f.orkFmt);
        }
        // Success at INFO; a failure (crash/kill or no pack produced) is a real problem → WARN.
        if (built) console.log(`[conversion] ${rel}: converted`);
        else {
          console.warn(`[conversion] ${rel}: ${ok ? 'no .orkpack produced' : 'failed/killed'}`);
          // The runtime's own account of why — without it the failure is undiagnosable from the logs.
          for (const line of stderrHighlights(errTail)) console.warn(`[conversion] ${rel}: | ${line}`);
        }
        resolve(built);
      };
      proc.on('exit',  (code) => done(code === 0));
      proc.on('error', ()     => done(false));
    });
    this.currentPromise = pr;   // cleared in done()
    return pr;
  }

  // Build ONE model's pack to an explicit configuration, replacing whatever is there. This is the
  // user-driven "Quantize" action, as opposed to the idle pump's build-at-serving-defaults.
  //
  // A MIXED build is inherently TWO passes and the user does not choose them — promotion is ranked by
  // qerr, the measured per-weight quantisation error, and only a completed pack records it. So pass 1
  // builds uniform (recording qerr), pass 2 rebuilds reading it back via --pack-qerr-source. Pass 1's
  // pack is moved aside rather than copied: ggml-ork derives the output path from -m, so pass 2 would
  // otherwise overwrite the very file it ranks from, and _spawnBuild short-circuits on an existing pack.
  // The aside copy is scaffolding and is removed either way.
  async quantize(rel, cfg = {}) {
    if (!this.binPath) return { ok: false, error: 'no llama-completion binary' };
    const bits  = cfg.bits === 8 ? 8 : 4;
    const mixed = !!cfg.mixed;
    const abs   = path.join(MODELS_DIR, rel);
    const pack  = orkpackPathFor(abs);
    const qerrAt = pack.replace(/\.orkpack$/i, '.qerr.orkpack');

    if (!fs.existsSync(abs)) return { ok: false, error: 'no such model: ' + rel };
    const arch = getGgufArchitecture(abs);
    if (UNSUPPORTED_ARCHS.has(arch)) return { ok: false, error: "arch '" + arch + "' cannot be packed" };

    // The NPU is single-stream: take it from the idle pump, as a user Load does.
    this.queued.delete(rel);
    if (this.current) { this.preempt(); try { await this.currentPromise; } catch {} }

    const env = orkEnvFrom(orkPrecisionForBuild(bits, mixed));
    const clean = () => { for (const f of [qerrAt, qerrAt + '.gguf', qerrAt + '.tmp']) { try { fs.unlinkSync(f); } catch {} } };
    try {
      removeOrkpack(abs);                      // an explicit rebuild replaces, never adopts
      clean();

      // Pass 1 — uniform. For a mixed build its real product is the recorded qerr.
      const p1 = ['--pack-bits', String(bits), '--no-pack-mixed'];
      if (!await this._spawnBuild(rel, env, p1, mixed ? 'pass 1 of 2 - measuring' : 'quantizing')) {
        return { ok: false, error: 'pass 1 produced no .orkpack' };
      }
      if (!mixed) return { ok: true, bits, mixed };

      // Pass 2 — promote the worst-quantised weights, ranked by pass 1's qerr.
      fs.renameSync(pack, qerrAt);
      try { fs.renameSync(pack + '.gguf', qerrAt + '.gguf'); } catch {}
      const p2 = ['--pack-bits', String(bits), '--pack-mixed',
                  '--pack-qerr-source', qerrAt,
                  '--pack-budget',   String(cfg.budgetMB ?? 8),
                  '--pack-qerr-min', String(cfg.qerrMin ?? 0.05)];
      if (cfg.promote) p2.push('--pack-promote', String(cfg.promote));
      if (!await this._spawnBuild(rel, env, p2, 'pass 2 of 2 - promoting')) {
        try { fs.renameSync(qerrAt, pack); } catch {}   // keep the uniform pack; never leave nothing servable
        return { ok: false, error: 'pass 2 failed; kept the uniform pack' };
      }
      return { ok: true, bits, mixed };
    } finally {
      clean();
      this._pump();
    }
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
