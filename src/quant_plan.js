// Pack-size arithmetic for the Quantization tab's bits-per-weight control.
//
// The tab used to ask for a PROMOTION BUDGET IN MEBIBYTES — ggml-ork's `--pack-budget`, passed
// straight through. That number is unreadable without knowing the model: 512 MiB (the old slider's
// maximum) buys 4.18 bpw on a 27B and the whole model several times over on a 1.7B. The unit people
// reason about, and the one the measured quality ladder is indexed by, is BITS PER WEIGHT. So the
// slider moves in bpw and the megabytes become a consequence, computed here.
//
// WHAT THIS FILE HAS TO GET RIGHT
//
//   1. WHICH TENSORS THE SLIDER ACTUALLY MOVES. Not all of them: a .orkpack holds the NPU-packed
//      weights PLUS a verbatim copy of everything the pack does not own (the GGUF header/KV/
//      tensor-info block, the norms, the embedding table, any weight the backend declined). That
//      carried region is several GiB on a large model and the slider does not touch a byte of it.
//      So membership is DERIVED, never hard-coded: from the pack's own index when a pack exists,
//      and otherwise from the same predicate ggml-ork's `supports_op` applies at pack time. The
//      thing that currently keeps `output.weight` out is an N-cap whose own comment in ggml-ork
//      calls it "an IOVA-budget policy, NOT a matmul limit" — a policy that is expected to move.
//      When it does, that tensor starts responding to the slider here with no edit to this file.
//
//   2. WHAT `--pack-budget` IS DENOMINATED IN. On-disk MiB, including the Bf sidecar an int8 entry
//      carries inside the K%512==0 && K<=4096 envelope (ggml-ork `ork_promote_cost_mb`). A promoted
//      weight can therefore cost 3x its blob delta, so "bpw delta converted to bytes" is NOT a valid
//      budget — it under-delivers by up to 3x. `budgetMbForBpw` reproduces the packer's own greedy
//      loop over the measured-qerr pack instead, which makes the conversion exact rather than close.
//
// Nothing here runs the model or maps a blob: a pack's index is a few hundred KiB at the tail of the
// file and a GGUF's tensor table is in its header.

import fs from 'fs';
import { readGgufTensors, ggufDisplayName, withQuantLabel } from './gguf.js';
import { readOrkpackFooter, isOrkpackPath, sigQbits } from './orkpack.js';

const MiB = 1048576;

export const INT4_BPW = 4.0;
export const INT8_BPW = 8.0;

// ── The packer's own eligibility predicate ───────────────────────────────────

// ggml-ork `supports_op`: `static const int max_n = getenv("ORK_MAXN") ? atoi(...) : 32768;`
// Read from the environment the build will actually run under, so a deployment that raises the cap
// (or a future default that raises it) changes the projection without changing this code.
export function packMaxN() {
  const n = Number(process.env.ORK_MAXN);
  return Number.isFinite(n) && n > 0 ? n : 32768;
}

// ggml-ork declines a sub-5-bit source outright ("q4/low-bit GGUF sources are UNSUPPORTED territory
// for the NPU path"), which also stops the pack from ever packing one.
const MIN_SOURCE_BITS = 5.0;

// The ONE exclusion that is not a policy: the embedding table is read by GGML_OP_GET_ROWS, a gather,
// not a matmul. There is no NPU op for it, so no bpw the pack could express applies to it. (Its size
// is still not fixed — that is a property of the source GGUF, changeable with
// `llama-quantize --tensor-type token_embd=…` — it is just not what the PACK's bpw governs.)
//
// TIED EMBEDDINGS. That is only true while a SEPARATE head tensor carries the vocabulary projection.
// In a tied model there is no `output.weight` and `token_embd` is both the gather AND the LM-head
// matmul, so excluding it by name would hide a genuinely packable weight. llama.cpp decides tying the
// same way — the head is `output.weight` if the file has one, else `token_embd.weight` — so the
// predicate is derived from the tensor list, not assumed from the name.
const EMBD = /(^|\.)token_embd\./;
const HEAD = /(^|\.)output\.weight$/;

// Classify one GGUF tensor against the pack-time predicate.
//   'slider' — a 2-D weight the backend accepts: int4/int8 tier, moved by the bpw control
//   'moe'    — an expert stack (3-D, MUL_MAT_ID): packed, but at the automatic MoE profile's own
//              NF4 tier, which is fixed by model type and not something the slider chooses
//   'carried'— everything else: copied into the pack verbatim at its source precision
function classify(t, maxN, tiedEmbeddings) {
  const nd = t.dims.length;
  if (!/\.weight$/.test(t.name)) return 'carried';
  if (EMBD.test(t.name) && !tiedEmbeddings) return 'carried';
  if (t.bits > 0 && t.bits < MIN_SOURCE_BITS) return 'carried';
  const N = Number(t.dims[1] || 0);
  if (N > maxN) return 'carried';
  if (nd === 3) return 'moe';
  if (nd !== 2) return 'carried';
  return 'slider';
}

// ── Projection from a GGUF, for a pack that does not exist yet ───────────────

// { sliderParams, moeParams, carriedBytes, headerBytes, nSlider, nMoe, nTensors, moe }
export function projectFromGguf(ggufPath) {
  const g = readGgufTensors(ggufPath);
  if (!g) return null;
  const maxN = packMaxN();
  const tied = !g.tensors.some(t => HEAD.test(t.name));
  let sliderParams = 0, moeParams = 0, carriedBytes = 0, nSlider = 0, nMoe = 0;
  for (const t of g.tensors) {
    switch (classify(t, maxN, tied)) {
      case 'slider': sliderParams += t.elements; nSlider++; break;
      case 'moe':    moeParams    += t.elements; nMoe++;    break;
      default:       carriedBytes += t.bytes;                break;
    }
  }
  return {
    source: 'gguf',
    sliderParams, moeParams, carriedBytes,
    headerBytes: g.dataStart,          // header + KV + tensor-info, copied into the pack verbatim
    nSlider, nMoe, nTensors: g.tensors.length,
    moe: nMoe > 0,
    tied,
    sourceBytes: g.fileSize,
  };
}

// ── The .orkpack index, for a pack that already exists ───────────────────────

// struct orkpack_entry {u32 K,N,dtype,bscale_n; u64 blob_off,blob_size,bscale_off,bf_size; f32 qerr; u32 smooth_n;}
// 56 bytes at natural alignment. `smooth_n` was the struct's `_pad`, so the size is unchanged across
// every pack version that has shipped — which is why the ENTRY layout needs no version switch even
// though the FOOTER does (orkpack.js readOrkpackFooter owns that part).
const ENTRY_BYTES = 56;

// Read a pack's index — the layout the ggml-ork load path reads: two u64 of metadata offsets, then
// n_entries of {u32 name_len, name bytes, orkpack_entry}. No blob is mapped; this is a tail read.
// Returns null if the file is not an .orkpack we can parse.
export function readOrkpackIndex(packPath) {
  let fd;
  try {
    const f = readOrkpackFooter(packPath);
    if (!f || !f.indexOff || !f.nEntries) return null;
    const fileSize = f.size;
    if (!(f.indexOff > 0 && f.indexOff < fileSize)) return null;

    // Read to EOF and parse exactly nEntries — the trailing footer is simply never reached, which
    // keeps this independent of how long the footer is in this pack's version.
    const idxLen = fileSize - f.indexOff;
    if (idxLen < 16) return null;
    fd = fs.openSync(packPath, 'r');
    const buf = Buffer.alloc(idxLen);
    if (fs.readSync(fd, buf, 0, idxLen, f.indexOff) !== idxLen) return null;
    const metaOff  = Number(buf.readBigUInt64LE(0));
    const metaSize = Number(buf.readBigUInt64LE(8));

    const entries = [];
    let p = 16;
    for (let i = 0; i < f.nEntries; i++) {
      if (p + 4 > idxLen) break;
      const nl = buf.readUInt32LE(p); p += 4;
      if (nl > idxLen - p) break;
      const name = buf.toString('utf8', p, p + nl); p += nl;
      if (p + ENTRY_BYTES > idxLen) break;
      entries.push({
        name,
        K:        buf.readUInt32LE(p),
        N:        buf.readUInt32LE(p + 4),
        dtype:    buf.readUInt32LE(p + 8),
        bscaleN:  buf.readUInt32LE(p + 12),
        blobSize: Number(buf.readBigUInt64LE(p + 24)),
        bfSize:   Number(buf.readBigUInt64LE(p + 40)),
        qerr:     buf.readFloatLE(p + 48),
      });
      p += ENTRY_BYTES;
    }
    return { entries, fileSize, metaOff, metaSize, version: f.version };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// The same shape projectFromGguf returns, but measured off a real pack rather than projected.
// THE ARTIFACT DECIDES: membership, tier and the carried-region size all come from the file.
export function measureFromPack(packPath) {
  const ix = readOrkpackIndex(packPath);
  if (!ix || !ix.entries.length) return null;
  let sliderParams = 0, blobBytes = 0, sidecarBytes = 0;
  for (const e of ix.entries) {
    sliderParams += e.K * e.N;
    blobBytes    += e.blobSize;
    sidecarBytes += e.bfSize + e.bscaleN * 4;
  }
  // Everything in the file that is not a weight blob: the embedded GGUF header/KV/tensor-info, the
  // tensors the pack does not own, the index and the footer.
  const carriedBytes = Math.max(0, ix.fileSize - blobBytes - sidecarBytes);
  return {
    source: 'pack',
    sliderParams, moeParams: 0, carriedBytes, headerBytes: 0,
    nSlider: ix.entries.length, nMoe: 0, nTensors: ix.entries.length,
    moe: false,
    packBytes: ix.fileSize,
    // What the pack on disk ACTUALLY is, which is where the slider should start.
    currentBpw: sliderParams > 0 ? (blobBytes * 8) / sliderParams : 0,
  };
}

// ── what a pack is CALLED ────────────────────────────────────────────────────
//
// A pack inherits the source GGUF's filename (orkpackPathFor is a pure extension swap), so it is
// named after the material rather than the product: `Qwen3.8-27B-BF16.orkpack` holds no bf16 at all.
// The name on disk cannot move — it is a lookup key (model_settings rows, settings carry-over,
// ggml-ork's own `<model-dir>/<basename>.orkpack` derivation) — so the correction is made in the
// LABEL, here, and the file is left exactly where it is.
//
// The number is MEASURED, never assumed: `measureFromPack().currentBpw` is packed-blob bits over
// packed params, read straight off the pack's own index. That is the same quantity the Quantization
// tab's slider reports and the same one `bpwDelivery` checks a build against, so the label cannot
// disagree with either. Nothing is estimated and nothing is derived from the filename.

// A pack's index is a tail read of a few hundred KiB, and this is called once per model per
// enumeration of the Models tree — so it is memoised on (mtime, size), the same pair that decides
// whether any other cached fact about a file is still true. A rebuilt pack changes both.
const LABEL_CACHE = new Map();
const LABEL_CACHE_MAX = 512;

function cachedPackLabel(packPath, compute) {
  let st;
  try { st = fs.statSync(packPath); } catch { LABEL_CACHE.delete(packPath); return null; }
  const hit = LABEL_CACHE.get(packPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.label;
  const label = compute();
  if (LABEL_CACHE.size >= LABEL_CACHE_MAX) LABEL_CACHE.delete(LABEL_CACHE.keys().next().value);
  LABEL_CACHE.set(packPath, { mtimeMs: st.mtimeMs, size: st.size, label });
  return label;
}

/** Drop the memoised labels. For tests, and for any caller that rewrites a pack in place. */
export function clearPackLabelCache() { LABEL_CACHE.clear(); }

// 4.89 -> "4.9bpw", 8.0 -> "8bpw". One decimal is all the precision the measurement earns at this
// size: promotion is granular (whole weights) and one weight moves a 27B by ~0.01 bpw, so a second
// decimal would churn in the UI without telling anyone anything.
function formatBpw(bpw) {
  if (!Number.isFinite(bpw) || bpw < 1 || bpw > 32) return null;   // not a rate we can have measured
  return `${Math.round(bpw * 10) / 10}bpw`;
}

/**
 * What to CALL this pack's quantization, or null when the file cannot tell us.
 *
 *   '4.9bpw'  — measured off the index: the honest answer, and the one the owner asked for.
 *   'int4'/'int8' — the tier from the footer's build signature, used ONLY when the index is
 *                   unreadable (truncated, mid-checkpoint, an entry layout we cannot walk). A tier
 *                   name is vague where a bpw is exact, but it is TRUE, and a fabricated number in
 *                   something that reads like a filename is worse than a vague one.
 *   null      — not a pack, absent, or no footer: the caller leaves the name alone entirely.
 *
 * Never throws: every reader underneath returns null on a bad file, and a model list must not fail
 * because one pack happens to be mid-write.
 */
export function packQuantLabel(packPath) {
  if (!packPath || !isOrkpackPath(packPath)) return null;
  return cachedPackLabel(packPath, () => {
    const m = measureFromPack(packPath);
    const bpw = m ? formatBpw(m.currentBpw) : null;
    if (bpw) return bpw;
    // Fallback, and a NARROW one. The footer's signature states a tier only when the build FORCED
    // a precision: the low byte is the ORK_QUANT character, and 0 means "source-driven default",
    // which is not a tier anyone can read off the file. sigQbits() answers 8 for that case because
    // its caller (the adopt gate) needs a decision; a label does not, and would be asserting int8
    // over what may well be an NF4 int4 pack. So an unforced or unrecognised footer gets no label.
    const f = readOrkpackFooter(packPath);
    if (!f || !f.version) return null;
    const forced = f.quantSig & 0xff;                       // '4' | '8' | 0
    return forced === 0x34 || forced === 0x38 ? `int${sigQbits(f.quantSig)}` : null;
  });
}

/**
 * The ONE display name for a model id, for every endpoint that shows one.
 *
 * `absPath` is the file the id resolves to; without it (or for anything that is not a pack) this is
 * exactly `ggufDisplayName` — shard suffix stripped, nothing else touched. The id itself is never
 * rewritten: it stays the load target and the settings key.
 */
export function modelDisplayName(id, absPath = null) {
  const name = ggufDisplayName(id);
  if (!isOrkpackPath(id)) return name;
  return withQuantLabel(name, packQuantLabel(absPath ?? id));
}

// ── bpw -> bytes ─────────────────────────────────────────────────────────────

// Estimated .orkpack size at a given bits-per-weight. `plan` is a projectFromGguf/measureFromPack
// result. MoE expert stacks are counted at the auto profile's fixed NF4 tier (4 bpw), which the
// slider does not choose. Per-channel scale sidecars (a few floats per entry) are under 0.1% and
// are not counted; the Bf sidecar a promoted int8 weight may carry is not counted either, because
// WHICH weights get promoted is decided by measured qerr that does not exist until pass 1 has run.
export function bytesAtBpw(plan, bpw) {
  if (!plan) return null;
  const weightBytes = (plan.sliderParams * bpw) / 8;
  const moeBytes    = (plan.moeParams * INT4_BPW) / 8;
  return {
    weightBytes,
    moeBytes,
    carriedBytes: plan.carriedBytes + (plan.headerBytes || 0),
    totalBytes: weightBytes + moeBytes + plan.carriedBytes + (plan.headerBytes || 0),
  };
}

// ── bpw -> --pack-budget, exactly ────────────────────────────────────────────

// ggml-ork `ork_promote_cost_mb`: promoting one int4 weight to int8 costs the blob delta (K*N/2)
// plus, inside the Bf envelope, a full K*N sidecar the int4 form never had.
function promoteCostMb(K, N) {
  const blobDelta = (K * N) / 2;
  const bf = (K % 512 === 0 && K <= 4096) ? K * N : 0;
  return (blobDelta + bf) / MiB;
}

// Turn a target bits-per-weight into the `--pack-budget` MiB that delivers it.
//
// This has to be computed against the measured pack, not estimated: the budget is spent in on-disk
// bytes (Bf included) while bpw is a property of the blobs, and the promotion set is whatever the
// qerr ranking picks — so the mapping is model- AND measurement-dependent. Replaying the packer's
// own greedy loop over pass 1's index is what makes it exact.
//
// Returns the budget in MiB, or null if the pack cannot be read / carries no qerr.
export function budgetMbForBpw(qerrPackPath, bpw, qerrMin = 0.05) {
  const ix = readOrkpackIndex(qerrPackPath);
  if (!ix || !ix.entries.length) return null;
  const total = ix.entries.reduce((a, e) => a + e.K * e.N, 0);
  if (!total) return null;
  if (bpw <= INT4_BPW) return 0;

  // bpw = (4*(P - Pp) + 8*Pp)/P  =>  Pp = P*(bpw - 4)/4
  const wantPromoted = Math.min(total, (total * (bpw - INT4_BPW)) / 4);

  const ranked = ix.entries.filter(e => e.qerr >= qerrMin).sort((a, b) => b.qerr - a.qerr);
  if (!ranked.length) return null;

  let promoted = 0, spent = 0;
  for (const e of ranked) {
    if (promoted >= wantPromoted) break;
    spent += promoteCostMb(e.K, e.N);
    promoted += e.K * e.N;
  }
  // A hair of slack so the packer's own `spent + mb > budget` comparison admits the last entry
  // despite float accumulation order, and no more (zero headroom admits nothing extra).
  return spent > 0 ? spent * (1 + 1e-9) + 1e-6 : 0;
}

// ── Did the pack come out at the rate that was asked for? ────────────────────

// Compare a requested bits-per-weight against what the finished pack actually IS, and say how to
// read the difference. `delivered` comes from measureFromPack — blob bits over packed params — so
// this knows nothing about ordering, tiers, or how promotion was selected. That is the whole point:
// it stays true however the packer's selection changes.
//
// WHY IT EXISTS. Between the slider and the pack sits a translation that this repo does not own:
// today a bpw target becomes `--pack-budget` MiB by replaying the packer's promotion loop, and the
// plan of record is for ggml-ork to take bpw directly (`--pack-bpw`) and own the stopping rule
// itself. Either way the question is the same one, and it is deliberately asked of the ARTIFACT
// rather than of the mechanism, so it keeps meaning the same thing across that change:
//
//   DRIFTED  promotion happened, but not the amount that was asked for. A wrong number.
//   IGNORED  nothing was promoted at all. Whatever governs the rate did not read the request, so the
//            pack sits at the base tier while the UI reports what the user chose — a CONFIDENT wrong
//            number, the worse of the two, and otherwise completely silent.
//
// The base-tier case is named separately because it is the one a reader needs a diagnosis for rather
// than just two numbers. The diagnosis names a likely cause without asserting it: as of writing, the
// way this happens is ggml-ork's `ork_i4_force_i8` answering from its EXCLUSIVE explicit-list clause
// (`--pack-promote` / ORK_I4_INT8_LAYERS), which returns before `ork_qerr_promote_set()` and leaves
// `--pack-budget` read by nothing. Once the packer takes bpw directly, the same symptom will mean
// the flag did not take effect. The symptom is the stable part; the cause is a hint, not a claim.
//
// NEVER AN ERROR. A divergence can be perfectly legitimate (a selection policy whose natural stopping
// point is simply a different rate), and failing a conversion that produced a good pack, over a
// reporting mismatch, would be a worse bug than the one this detects. Report and continue.
//
// `tol` is 0.1 bpw by default: promotion is granular (whole weights), and one weight is ~0.01 bpw on
// a 400-tensor model and ~0.08 on a very small one, so a tighter threshold would cry wolf over
// arithmetic that is working correctly.
export function bpwDelivery(requested, delivered, tol = 0.1) {
  if (!(delivered > 0)) return { status: 'unknown', gap: null };
  if (!(requested > 0)) return { status: 'unrequested', gap: null, delivered };
  const gap = delivered - requested;
  if (Math.abs(gap) <= tol) return { status: 'ok', gap, requested, delivered };
  // Nothing was promoted at all, though more than the base tier was asked for.
  if (Math.abs(delivered - INT4_BPW) < 0.01) return { status: 'ignored', gap, requested, delivered };
  return { status: 'drifted', gap, requested, delivered };
}

// The one-line human reading of the above. Returned rather than logged so the decision stays pure
// and testable, and the caller owns where it goes.
export function bpwDeliveryMessage(model, d) {
  switch (d.status) {
    case 'unrequested': return `[quantize] ${model}: pack is ${d.delivered.toFixed(2)} bpw`;
    case 'ok':          return `[quantize] ${model}: asked ${d.requested.toFixed(2)} bpw, got ${d.delivered.toFixed(2)}`;
    case 'ignored':     return `[quantize] ${model}: asked ${d.requested.toFixed(2)} bpw, got ${d.delivered.toFixed(2)} — `
                             + 'nothing was promoted, so the rate the UI shows is not the rate on disk. The pack itself is '
                             + 'fine; the bits-per-weight control is not steering it. Likely cause: the request reached '
                             + 'nothing that reads it — e.g. a promotion set fixed by the exclusive explicit-list clause '
                             + '(pack-promote / ORK_I4_INT8_LAYERS), which leaves the budget unread.';
    case 'drifted':     return `[quantize] ${model}: asked ${d.requested.toFixed(2)} bpw, got ${d.delivered.toFixed(2)} `
                             + `(${d.gap > 0 ? '+' : ''}${d.gap.toFixed(2)}) — promotion ran but stopped somewhere else. `
                             + 'Either the selection cannot land on this rate for this model, or the rule that converts '
                             + 'the request into a stopping point no longer matches the one the packer applies.';
    default:            return `[quantize] ${model}: could not measure the finished pack's bits per weight`;
  }
}

// ── The endpoint payload ─────────────────────────────────────────────────────

// Everything the Quantization tab needs to render the bpw control for one source model.
// `known: false` means the size estimate cannot be shown (unreadable/placeholder GGUF) — the slider
// still works, because bpw is meaningful without it; only the megabytes are withheld.
export function quantPlan(ggufAbs, packAbs) {
  const fromPack = packAbs && fs.existsSync(packAbs) ? measureFromPack(packAbs) : null;
  const plan = fromPack || projectFromGguf(ggufAbs);
  if (!plan) return { known: false, maxN: packMaxN() };
  return {
    known: plan.sliderParams > 0,
    source: plan.source,
    maxN: packMaxN(),
    sliderParams: plan.sliderParams,
    moeParams: plan.moeParams,
    moe: plan.moe,
    tied: plan.tied ?? null,
    nSlider: plan.nSlider,
    nMoe: plan.nMoe,
    nTensors: plan.nTensors,
    carriedBytes: plan.carriedBytes + (plan.headerBytes || 0),
    sourceBytes: plan.sourceBytes ?? null,
    packBytes: plan.packBytes ?? null,
    currentBpw: plan.currentBpw ?? null,
    // Precomputed so the client does the same arithmetic the server would.
    bytesAt: { 4: bytesAtBpw(plan, 4).totalBytes, 8: bytesAtBpw(plan, 8).totalBytes },
  };
}
