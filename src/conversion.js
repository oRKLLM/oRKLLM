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
import { isOrkpackStub, getGgufArchitecture, parseGgufShard } from './gguf.js';
import { orkpackPathFor, isOrkpackUsable, readOrkpackFooter, recordOrkFmt, llamaRuntimeTag, orkEnvFrom,
         writeOrkpackProvenance, provPathFor } from './orkpack.js';
import { consolidateSplitGguf, consolidatedPathFor, splitGroupReady } from './gguf_merge.js';
import { measureFromPack, bpwDelivery, bpwDeliveryMessage, projectFromGguf, bytesAtBpw } from './quant_plan.js';

export { orkpackPathFor };

// (The bpw -> --pack-budget MiB conversion that used to live here is gone: ggml-ork takes
// --pack-bpw directly and owns the stopping rule, so this repo no longer carries a second
// implementation of the packer's promotion loop. quant_plan.budgetMbForBpw remains for the older
// --pack-budget shape and for the size projection the Quantization tab draws.)

// Did the finished pack come out at the rate that was asked for?
//
// The translation above is the weak joint in this chain: it replays the packer's CURRENT promotion
// loop, and the packer is free to change that loop. One way it can change is not merely wrong but
// SILENT — if the promotion set comes from ggml-ork's exclusive explicit-list clause, `--pack-budget`
// is read by nothing and the pack lands wherever that list puts it while the UI reports the rate the
// user chose. Nothing else in this repo would notice.
//
// So measure the artifact. `measureFromPack` reads blob bits over packed params straight off the
// finished file and knows nothing about ordering, tiers or selection policy, which is exactly why it
// stays true as those change — and it is the only check that would catch promoteBudgetMb's cost
// mirror drifting from ggml-ork's own `ork_promote_cost_mb`.
//
// REPORTS, NEVER FAILS. A divergence can be legitimate, and turning a conversion that produced a
// good pack into an error over a reporting mismatch would be the worse bug. Everything here is
// best-effort and swallowed: a pack that cannot be re-read is worth one line, not a lost build.
function reportBpwDelivered(rel, pack, cfg) {
  try {
    const m = measureFromPack(pack);
    const d = bpwDelivery(Number(cfg.bpw), m ? m.currentBpw : 0);
    const line = bpwDeliveryMessage(rel, d);
    if (d.status === 'ok' || d.status === 'unrequested') console.log(line);
    else console.warn(line);
  } catch (e) {
    console.warn(`[quantize] ${rel}: could not verify the pack's bits per weight — ${e.message}`);
  }
}

// "2 h 41 m", "18 m", "45 s" -- for the sidecar's etaText, which the UI shows verbatim.
export function humanDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return null;
  if (sec < 90) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  if (m < 90) return `${m} m`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m`;
}

// The bits-per-weight a spawn was asked for, read back off its own argv so the size projection and the
// build cannot disagree about what is being built. 4.0 when nothing says otherwise (the 4-bit base
// tier); 8.0 for an explicit int8 build.
function packArgsBpw(args) {
  const i = args.indexOf('--pack-bpw');
  if (i >= 0) { const v = Number(args[i + 1]); if (Number.isFinite(v)) return v; }
  const b = args.indexOf('--pack-bits');
  if (b >= 0 && args[b + 1] === '8') return 8;
  return 4;
}

// Architectures that have no .orkpack of their own, detected up front so we skip at enqueue time
// (never spawn a doomed conversion that just churns the NPU):
//   • 'dflash' — a DFlash speculative-draft head, not a standalone servable model; it runs co-resident
//     with its target via run_dflash.
//
// 'qwen35' (Qwen3.5/3.6/3.8) was listed here on the reasoning that a Gated-Delta-Net hybrid is
// state-space, not the static MUL_MAT the accelerator packs. That is wrong as a PACK gate: the
// recurrent layers are only part of the graph — the attention and FFN projections are ordinary
// MUL_MATs, and ggml-ork packs exactly those and leaves the rest to the CPU. Measured on RK3588
// (b11552-ork / ork-driver 1.0.168): Qwen3.5-0.8B-UD-Q8_K_XL packs 150 weights into a 1449 MiB
// .orkpack and exits 0. Two more qwen35 packs built by this scheduler are already on that board
// (Qwen3.6-27B-Q4_K_M, 112 entries; Qwen3.5-4B-UD-Q4_K_XL, 121) — and they are the proof the gate was
// never consistent with itself: convertNow(), the pool's build-before-load path, does NOT consult this
// set, so oRKLLM has been packing qwen35 models on every cold load while refusing the identical build
// when a user asked for it. A user Quantize on any Qwen3.5+ model failed with
// "arch 'qwen35' cannot be packed".
const UNSUPPORTED_ARCHS = new Set(['dflash']);

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
  for (const p of [pack, pack + '.tmp', pack + '.json', pack + '.meta.json', provPathFor(pack), pack + '.gmax', pack + '.gguf']) {
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

  // Walk MODELS_DIR and enqueue every .gguf whose EXISTING .orkpack this runtime would refuse (see
  // isOrkpackFresh — footer schema, on-disk format token, precision signature). Those are rebuilt.
  //
  // A MODEL WITH NO PACK IS NOT ENQUEUED, and that is the rule, not an optimisation. The first
  // quantisation of a model is a decision — tier, bits per weight, which quality-ladder rungs — and it
  // belongs to the user, who makes it from the Quantization tab. A freshly downloaded model simply
  // runs un-packed until they do. An automatic first build would also be the one place a multi-hour
  // GPTQ pass could ambush someone, and removing it settles that structurally rather than by policy.
  //
  // THE STALE PACK IS NO LONGER DELETED HERE. It used to be, to make the rebuild see "absent" and so
  // dodge ggml-ork's ORK_ORKPACK_MAX_REGEN_MB abort — a guard that no longer exists. Deleting it now
  // would be actively wrong: the runtime reads the OLD pack to recover the settings it was built with
  // (tier, bpw target, ladder) so the rebuild reproduces the user's choices instead of reverting them
  // to defaults. Destroy the recipe and the rebuild silently becomes a different model. It is replaced
  // in place, via <pack>.tmp and a rename.
  // Called at startup (initialization) AND after a runtime install / user-initiated runtime change.
  scanAndEnqueue() {
    const tag = llamaRuntimeTag();
    let invalidated = 0;
    const walk = (dir) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.gguf$/i.test(e.name) || isOrkpackStub(e.name)) continue;
        const rel = path.relative(MODELS_DIR, p);
        // A split model left on disk by an older build — or by a download that finished while the
        // service was down — is consolidated here. This walk is the ONLY restart-safe trigger: the
        // download queue is in-memory and does not survive a restart, so nothing else would ever
        // revisit those shards. Fire-and-forget: a 51 GiB merge must not block startup, and the
        // consolidation enqueues the merged file itself when it lands.
        if (parseGgufShard(rel)) {
          this.noteGguf(rel).catch(e2 => console.error(`[conversion] consolidate ${rel}: ${e2.message}`));
          continue;
        }
        if (hasOrkpack(p) && !isOrkpackFresh(p, this._precisionFor(rel))) {
          console.log(`[conversion] .orkpack for ${rel} is stale — rebuilding it to its own recorded settings`);
          invalidated++;
          this.enqueue(rel);
        }
        // No pack: left alone. The user quantises it when they choose to.
      }
    };
    walk(MODELS_DIR);
    if (invalidated) console.log(`[conversion] revalidation: ${invalidated} stale .orkpack(s) queued for rebuild (runtime ${tag ?? 'unknown'})`);
    return invalidated;
  }

  // Public entry point for a runtime change (install / user-initiated switch in Settings): re-check ALL
  // models against the newly-installed runtime. A runtime update on its own does NOT invalidate anything
  // — only a pack the new runtime would actually refuse is discarded and rebuilt.
  revalidateForRuntime() { return this.scanAndEnqueue(); }

  // THE entry point for "a .gguf exists / has just finished downloading". A split model is consolidated
  // into one file FIRST and the merged path is what gets packed — the split is an upstream distribution
  // artifact (HuggingFace's per-file size cap), and carrying it past the download is what made a 27B
  // unloadable: the pack inherits the shard suffix, the stub inherits it from the pack, and llama.cpp
  // then refuses the stub outright. Consolidating here means nothing downstream ever sees a split model.
  //
  // Returns the rel id that was (or will be) packed, so a caller holding an id can follow the rename.
  async noteGguf(rel) {
    const abs = path.join(MODELS_DIR, rel);
    const shard = parseGgufShard(rel);
    if (!shard) { this.enqueue(rel); return rel; }
    if (shard.index > 1) return null;                 // a trailing shard is not a model; shard 1 drives it

    // Downloads are one job per FILE with no server-side notion of a variant being complete, and the
    // queue does not survive a restart — so readiness is derived from the disk, which is also how every
    // other state in this server is derived.
    if (!splitGroupReady(abs)) return null;

    const mergedAbs = consolidatedPathFor(abs);
    const mergedRel = path.relative(MODELS_DIR, mergedAbs);
    const sidecar = orkpackPathFor(abs) + '.json';    // the shard-1 entry the UI is already watching
    const write = (progress) => { try {
      fs.writeFileSync(sidecar, JSON.stringify({ status: 'merging', progress, label: 'consolidating shards' }));
    } catch {} };
    try {
      write(0);
      const res = await consolidateSplitGguf(abs, {
        onProgress: ({ copied, total }) => write(total > 0 ? Math.min(99, Math.round(100 * copied / total)) : 0),
      });
      if (res.status === 'consolidated') this._discardSplitPack(abs);
    } catch (e) {
      console.error(`[conversion] consolidating ${rel} failed: ${e.message}`);
      try { fs.writeFileSync(sidecar, JSON.stringify({ status: 'error', progress: 0, label: e.message })); } catch {}
      return null;
    } finally {
      try { if (JSON.parse(fs.readFileSync(sidecar, 'utf8')).status === 'merging') fs.unlinkSync(sidecar); } catch {}
    }
    this.enqueue(mergedRel);
    return mergedRel;
  }

  // A pack built before consolidation is REBUILT, not salvaged. It is worth saying why, because the
  // obvious shortcut looks available and is not, and the numbers below were measured on the 27B that
  // prompted all this (400-entry pack, shards of 835 + 31 tensors).
  //
  // What such a pack DOES have: its index covers the whole model. It is keyed by tensor NAME and was
  // written during a load of the complete split model, so all 64 layers' packable matmuls are in it —
  // 390 of its 400 entries name tensors resident in shard 1, and 10 name tensors resident in shard 2.
  // Nothing about the tiled weight bytes is shard-shaped.
  //
  // Why it still cannot be re-headed onto the consolidated file:
  //   • The pack embeds ONE source gguf — the `-m` file it was built from, i.e. shard 1. Its metadata
  //     section is that file's header verbatim (split.no=0, split.count=2, 835 tensor infos) followed
  //     by the bytes of every tensor the pack did NOT take (n_kept=445, ~2.6 GB of them), each at its
  //     offset in shard 1. ggml_backend_ork_extract_gguf replays exactly that: truncate to the recorded
  //     total, write the header, write the kept bytes. It never consults the index.
  //   • So the pack can supply 400 packed + 445 kept = 845 tensors. The merged model has 866. The 21
  //     with no bytes anywhere in it are shard 2's non-packed tensors — the blk.62/63 norms, all of
  //     `blk.64.nextn.*`, and `output.weight`. A swapped-in 866-tensor header would extract them as
  //     FILE HOLES, i.e. zeros: a model that loads with a zeroed LM head and zeroed norms.
  //   • Nothing would catch it. `ork_fmt` binds the tile layout and `quant_sig` the precision; neither
  //     binds the header, and extraction does not cross-check the index. A wrong re-header is silent.
  //   • It would also not be a "re-head" in any small sense: the merged header is longer, so all 445
  //     kept offsets shift, the recorded total and data_off change, and the 21 missing tensors would
  //     have to be read out of shard 2 and appended. That is rewriting the whole 2.6 GB metadata
  //     section through pack-mutation code that does not exist today.
  // A rebuild is ~23 minutes and is also the right answer for a pack whose provenance we cannot verify
  // (these were produced by an older path, and this one carries no provenance record at all).
  _discardSplitPack(absFirstShard) {
    const pack = orkpackPathFor(absFirstShard);
    for (const f of [pack, pack + '.gguf', pack + '.json', provPathFor(pack)]) {
      try {
        const sz = fs.statSync(f).size;
        fs.unlinkSync(f);
        console.log(`[conversion] removed ${path.basename(f)} (${(sz / 1073741824).toFixed(2)} GiB): its embedded ` +
                    'metadata is a single shard\'s header, so its stub would be split (and short of the ' +
                    'tensors only the other shards carry) — rebuilding from the consolidated gguf');
      } catch {}
    }
  }

  // Queue a model for a pack REBUILD. Only ever called for a model that already HAS a pack this
  // runtime refuses — a model with no pack is not a conversion job, it is a model the user has not
  // quantised yet. The guard is here rather than only at the call sites so a future caller cannot
  // reintroduce the auto-build by accident.
  enqueue(rel) {
    if (this.queued.has(rel) || (this.current && this.current.rel === rel)) return;
    if (!hasOrkpack(path.join(MODELS_DIR, rel))) return;   // no pack = not quantised yet; the user decides
    const _arch = getGgufArchitecture(path.join(MODELS_DIR, rel));
    if (UNSUPPORTED_ARCHS.has(_arch)) {
      console.warn(`[conversion] ${rel}: arch '${_arch}' has no standalone .orkpack (DFlash speculative-draft head — runs co-resident with its target); skipping.`);
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
    const _abs = path.join(MODELS_DIR, rel);
    if (hasOrkpack(_abs)) {
      if (isOrkpackFresh(_abs, this._precisionFor(rel))) return true;       // already built and usable
      // Stale: rebuild it now, to its own recipe, before the load.
    } else {
      // NOT QUANTISED YET — and this path must not quantise it. The model loads un-packed; ggml-ork
      // packs each weight inline as it meets it, which is what every model without a pack has always
      // done. The user starts the first quantisation themselves, with settings they choose.
      return false;
    }
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
      /* The precision THIS build stamps, taken from the env it is about to run with rather than from
       * the pool — they are the same for an idle rebuild and deliberately different for a user
       * Quantize, and asking the pool would then call a perfectly good pack a failure. */
      const builtPrec = { orkQuant: envExtra.ORK_QUANT ?? null, orkHybrid: envExtra.ORK_HYBRID ?? null };
      // A FRESH pack appearing since enqueue means someone else built it — nothing to do. A STALE one
      // is exactly what we are here to replace, so it must not short-circuit (it used to, back when
      // the stale pack was deleted before the rebuild was queued).
      if (hasOrkpack(abs) && isOrkpackFresh(abs, builtPrec)) {
        this.queued.delete(rel); resolve(true); return;
      }
      /* progress sidecar — /v1/models reads <model>.orkpack.json -> UI shows "converting"
       *
       * IT NOW CARRIES AN ETA, because the build got long. The quality ladder runs GPTQ by default for
       * W4A4 packs, and GPTQ is O(K^3) per weight: on a 1.7B it is tens of minutes, and it scales with
       * sum(K^3) across the model. Every such build is now started deliberately -- nothing auto-builds
       * an absent pack any more -- so it is a job someone is watching, and a job someone is watching
       * needs a bar and a time. The same seconds with neither read as a hang.
       *
       * The estimate is the dumbest one that cannot be wrong about the mechanism: elapsed * (1 - p)/p
       * against the SAME progress fraction the bar shows. It needs no model of GPTQ's cost curve, and
       * it self-corrects as the build proceeds. It is withheld until the build is far enough in to
       * mean anything -- an ETA computed off 1% of a 12 GiB pack is noise wearing a number. */
      const t0 = Date.now();
      const sidecar = (progress) => { try {
        const elapsedSec = Math.round((Date.now() - t0) / 1000);
        const etaSec = progress >= 2 && elapsedSec >= 60
          ? Math.round(elapsedSec * (100 - progress) / progress) : null;
        fs.writeFileSync(pack + '.json', JSON.stringify({
          status: 'converting', progress, elapsedSec, etaSec,
          ...(etaSec != null ? { etaText: humanDuration(etaSec) } : {}),
          ...(label ? { label } : {}),
        }));
      } catch {} };
      sidecar(0);
      /* Progress is bytes written against bytes EXPECTED, and the expected size is not the source's.
       * A 4-bit pack is roughly a quarter of an f16 GGUF, so measuring against the source pinned the
       * bar near 25% for the whole build and then jumped. quant_plan projects the pack size from the
       * GGUF's tensor table at the rate being built; the source size stays as the fallback for a GGUF
       * it cannot read. */
      let srcSize = 0; try { srcSize = fs.statSync(abs).size; } catch {}
      let expectSize = srcSize;
      try {
        const plan = projectFromGguf(abs);
        const bpw = packArgsBpw(packArgs);
        if (plan) { const b = bytesAtBpw(plan, bpw); if (b && b.totalBytes > 0) expectSize = b.totalBytes; }
      } catch {}

      // ORK_PERSIST is REMOVED upstream and now GGML_ABORTs the process — the pack path is derived from
      // -m, so it must NOT be set. ORK_NO_STUB=1 suppresses the companion stub GGUF that finalize would
      // otherwise drop at <model>.orkpack.gguf: a holed copy of the source (~2 GiB for a 12 GiB pack) that
      // our own .gguf scanners would list as a servable model and re-enqueue, and that is unloadable
      // without its pack.
      const env = { ...process.env,
        ORK_NO_STUB: '1', ...envExtra,   // envExtra (ORK_QUANT/ORK_HYBRID) matches the serve
        LD_LIBRARY_PATH: [LLAMA_RUNTIME_DIR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
      // A single 1-token forward pass packs+dumps every weight; --no-repack keeps weights host so the
      // ggml-ork matmul offload fires; -ngl 99 offloads all layers. `--device ORK` PINS them to the NPU:
      // the release runtime also ships ggml-vulkan (Mali), and ggml-ork is a BLAS-like ACCEL backend, so
      // a bare -ngl assigns the layers to the first GPU device (Vulkan0) — weights land in Mali buffers,
      // MUL_MAT runs on Vulkan, and ggml-ork packs ZERO weights → no .orkpack. Targeting the ORK device
      // (rather than disabling Vulkan) routes the matmuls to the NPU while leaving the GPU available.
      // -c 512: the GPTQ calibration pass batches within the context the caller builds, and a bigger
      // batch is fewer passes over the corpus for the same accumulated rank. 512 is also ggml-ork's own
      // safe ceiling -- a wider prefill is the colsplit submit hazard.
      const args = ['-m', abs, '--device', 'ORK', '-ngl', '99', '-t', '4', '-c', '512', '--no-repack',
                    ...packArgs,
                    '-p', 'x', '-n', '1', '--temp', '0', '-no-cnv'];
      console.log(`[conversion] building ${rel}.orkpack …${label ? ' (' + label + ')' : ''}`);
      // Keep the child's stderr. It was 'ignore', which meant every failure reported only
      // "no .orkpack produced" with the reason discarded — the runtime prints exactly why it declined
      // (wrong device, unsupported arch, a stale pack it refuses to regenerate, an abort), and that
      // line is the whole diagnosis. Bounded to the tail so a chatty run cannot grow unboundedly.
      const proc = spawn(this.binPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let errTail = '';
      // The build announces its own driver: "[ork] ork-driver 1.0.99 (W8A8)". That version+mode pair is
      // known only to the runtime, and it is exactly what a later reader needs to know which software
      // tiled these weights — capture the first sighting for the provenance record.
      let orkDriver = null;
      proc.stderr?.on('data', (d) => {
        const chunk = d.toString();
        if (!orkDriver) {
          const m = chunk.match(/ork-driver\s+(\S+(?:\s+\([^)]*\))?)/);
          if (m) orkDriver = m[1];
        }
        errTail = (errTail + chunk).slice(-STDERR_TAIL_CHARS);
      });
      this.current = { rel, abs, proc };

      // Live progress: ggml-ork streams packed weights into <pack>.tmp — poll its growth vs the source
      // GGUF size for a moving bar (clamped <100% until finalized).
      const tick = setInterval(() => {
        try {
          const w = fs.statSync(pack + '.tmp').size;
          const p = expectSize > 0 ? Math.min(99, Math.round(100 * w / expectSize)) : 0;
          sidecar(p);
        } catch { /* .tmp not created yet (model still loading) — keep the last value */ }
      }, 1500);

      const done = (ok) => {
        clearInterval(tick);
        this.current = null;
        this.currentPromise = null;
        this.queued.delete(rel);
        try { fs.unlinkSync(pack + '.json'); } catch {}
        // A rebuild replaces the pack in place, so "a pack exists" is not evidence it succeeded — the
        // OLD one would satisfy it. Ask the question that distinguishes them: is the pack on disk one
        // this runtime would now accept, at the precision this build stamped?
        const built = hasOrkpack(abs) && isOrkpackFresh(abs, builtPrec);
        if (built) {
          // This pack was written by the CURRENTLY-installed runtime, so its footer states the on-disk
          // format token that runtime expects. Record it — that is the one field of the freshness check
          // we cannot compute ourselves without loading the NPU runtime (see src/orkpack.js).
          const f = readOrkpackFooter(pack);
          if (f) recordOrkFmt(f.orkFmt);
          // Stamp who/what/where built it. A pack carries no record of the machine it was tiled for, and
          // it is only valid on that chipset — so write the provenance beside it while we still know.
          let srcStat = null; try { srcStat = fs.statSync(abs); } catch {}
          writeOrkpackProvenance(pack, {
            source: { rel, bytes: srcStat?.size ?? null, mtimeMs: srcStat?.mtimeMs ?? null },
            build: {
              orkQuant:  envExtra.ORK_QUANT  ?? null,
              orkHybrid: envExtra.ORK_HYBRID ?? null,
              packArgs:  packArgs.length ? packArgs : null,
              label,
            },
            orkDriver,
          });
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
  // VERIFIED on RK3588, b10701-ork (Qwen3-1.7B-UD-Q4_K_XL): the two-pass flow works end to end.
  // Pass 1 records qerr on all 196 entries (0.156-0.219, worst are the ffn_down weights); pass 2 ranks
  // them and promotes the 5 worst to int8 within a 32 MiB budget (30.00 MiB spent), growing the pack
  // 968.7 -> 1000.1 MB with a final dtype split of 5 int8 / 191 int4.
  //
  // It needs a runtime >= b10701-ork. Before that, qerr was written only by ORK_GPTQ finalize so an
  // ordinary build recorded 0 everywhere and there was nothing to rank (llama.cpp-rockchip#2), and
  // --pack-bits set only the pack's signature and not its tier (#4). On an older runtime the passes
  // still run and simply produce a uniform pack; the [ORK PACK-PROMOTE] line says which case you are in.
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
    if (UNSUPPORTED_ARCHS.has(arch)) return { ok: false, error: "arch '" + arch + "' has no standalone .orkpack" };

    // The NPU is single-stream: take it from the idle pump, as a user Load does.
    this.queued.delete(rel);
    if (this.current) { this.preempt(); try { await this.currentPromise; } catch {} }

    const env = orkEnvFrom(orkPrecisionForBuild(bits, mixed));
    const clean = () => { for (const f of [qerrAt, qerrAt + '.gguf', qerrAt + '.tmp']) { try { fs.unlinkSync(f); } catch {} } };
    try {
      removeOrkpack(abs);                      // an explicit rebuild replaces, never adopts
      clean();

      /* ONE PASS. A mixed build used to be two: pass 1 built a uniform pack purely to record each
       * weight's measured quantisation error, pass 2 re-ran the whole thing ranking on that error and
       * promoting until a MiB budget was spent -- with the bpw -> MiB conversion implemented here, in
       * JavaScript, by replaying the packer's own greedy loop (quant_plan.budgetMbForBpw).
       *
       * The packer now takes the bits-per-weight target directly and owns the stopping rule, so the
       * second implementation of that rule is gone and so is the duplicated build. It also promotes in
       * a BETTER order: the Q4_K_M structural prior (attn_v, then ffn_down) rather than qerr ranking,
       * measured 3.8% better at a matched bit budget -- qerr is a poor ordering, not merely a flat one,
       * which is also why the whole measure-then-rank round trip was not buying what it cost.
       *
       * --pack-budget / --pack-qerr-min / --pack-promote still exist in the runtime and still work;
       * they are simply no longer how a bpw request is expressed. */
      // --pack-build: this IS the quantisation the user asked for, so the runtime may create a pack
      // that does not exist. Nothing else in this service passes it.
      const args = ['--pack-build', '--pack-bits', String(bits)];
      if (!mixed) args.push('--no-pack-mixed');
      else if (cfg.bpw != null) args.push('--pack-bpw', String(cfg.bpw));
      else if (cfg.budgetMB != null) args.push('--pack-mixed', '--pack-budget', String(cfg.budgetMB),
                                               '--pack-qerr-min', String(cfg.qerrMin ?? 0.05));
      if (cfg.promote) args.push('--pack-promote', String(cfg.promote));
      if (!await this._spawnBuild(rel, env, args, 'quantizing')) {
        return { ok: false, error: 'no .orkpack produced' };
      }
      reportBpwDelivered(rel, pack, cfg);   // measure the artifact, never fail on it
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
