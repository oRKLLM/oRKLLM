// Minimal .orkpack footer reader — the authoritative freshness check for a packed-weight cache.
//
// An .orkpack is ggml-ork's on-disk cache of pre-tiled NPU weights, laid out as
//   [ blobs ][ index ][ footer @ EOF ]
// and the 32-byte footer is self-describing: it records the schema version, ork-driver's on-disk
// format token, and the build-config precision signature. ggml-ork validates exactly those fields
// before adopting a pack (ggml_backend_ork_orkpack_valid / ork_persist_init); anything it rejects is
// "stale", and a stale pack over ORK_ORKPACK_MAX_REGEN_MB (default 2048) makes the runtime abort()
// rather than rebuild. So oRKLLM has to answer the same question the same way.
//
// Why re-implement it in JS rather than call the exported ggml_backend_ork_orkpack_valid():
//   1. It lives in libggml-ork.so, which is loaded by the WORKER. The freshness question is asked in
//      the MAIN process (model list, load guard, converter), and dlopening the NPU runtime into the
//      server just to stat a footer is a large, stateful side effect for a 32-byte read.
//   2. Its precision check reads ORK_QUANT/ORK_HYBRID from the CALLING process's environment, so
//      asking it about model B while model A's precision is in our env would give a wrong answer.
//      We need the check per-model, against values we pass in.
// Reading the footer ourselves is the same trick src/gguf.js already uses for GGUF headers: parse the
// few bytes that matter, no runtime, no model load.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LLAMA_RUNTIME_DIR, getPlatform, getPlatformSource, getNpuCoreCount, getDeviceDrivers } from './config.js';

// struct orkpack_footer { u64 index_off; u32 n_entries; u32 version; u32 ork_fmt; u32 quant_sig; char magic[8]; }
// 8-byte aligned, no tail padding needed (24 + 8 = 32).
const FOOTER_SIZE = 32;
const MAGIC = 'ORKPK01';

// EXACT match, not a range. v7/v8 existed briefly upstream and were collapsed back into v6, so a file
// stamped 7 or 8 is a DIFFERENT layout wearing a number that has been reused — it must be rejected.
const ORKPACK_VERSION = 6;

// Build-config precision signature bits (mirror of ggml-ork's ork_build_sig).
const SIG_QB_MASK = 0x0ff;   // the forced-precision char: '4', '8', or 0 = source-driven default
const SIG_HY_BIT  = 0x100;   // ORK_HYBRID
// Hadamard rotation. ggml-ork's ork_sig_compatible deliberately does NOT check this bit and its own
// comment calls that "a known hole … build/run-must-match by convention". We DO check it, because the
// consequence of a mismatch is not a refused load but a silently garbage model: rotation is orthogonal
// (R*A)·(R*B) == A*B, so a rotated pack run unrotated produces plausible-looking nonsense. Native W4A4
// is unconditionally rotated (unrotated W4A4 measures PPL ~104 vs ~24), so the bit is set for any pack
// built at the 4-bit tier unless ORK_I4_NOROT was used. Checking it costs nothing and closes the hole
// on our side; the runtime is free to keep ignoring it.
const SIG_HD_BIT  = 0x200;   // hadamard rotation (implied by native W4A4)

export function orkpackPathFor(absGguf) { return absGguf.replace(/\.gguf$/i, '.orkpack'); }

// ---- .orkpack as the servable artifact -------------------------------------------------------------
// A v6 pack embeds the source GGUF's metadata, so it is self-contained: ggml_backend_ork_extract_gguf
// rebuilds a SPARSE gguf from the pack alone (the packed tensors stay file HOLES that ork serves, the
// rest travel inside the pack). That extracted file is what llama.cpp is handed as -m, with
// ORK_SOURCE_IS_STUB=1 telling ork the holes are its responsibility.
//
// This is why the pack — not the gguf — is the model. Serving the FULL gguf alongside the pack carries
// every matmul weight twice (source bytes + packed int4 in IOVA): 40.8 GiB of working set for a 27B on
// a 31 GiB board, which does not fail as an OOM but as page churn, submit timeouts and an NPU
// self-heal loop that reads like a driver fault. The gguf is a build input; the pack is the model.
export function isOrkpackPath(name) { return /\.orkpack$/i.test(String(name)); }

// The sparse gguf extracted from a pack. Same name the runtime's own build-time stub uses, so the two
// are interchangeable and only ever one file exists.
export function stubPathFor(packPath) { return String(packPath) + '.gguf'; }

// The .gguf a pack was built FROM. It may well not exist any more — deleting it after packing is the
// point of the exercise — so this is for provenance and settings carry-over, never for loading.
export function sourceGgufFor(packPath) { return String(packPath).replace(/\.orkpack$/i, '.gguf'); }

// The ORK_QUANT tier to BUILD a pack at, from the source gguf's weight width and the per-model
// npu_quant setting ('auto' | 'int4' | 'int8'). Returns '4', '8', or null to leave it to the runtime.
//
// The auto rule is ggml-ork's measured guidance, and it is deliberately NOT "preserve the source
// precision" — the pack decides what the weights ARE; the gguf is only the material:
//   • UNQUANTIZED source (F16/F32/BF16) -> int4. The RECOMMENDED setup: an unquantized source
//     auto-selects the NF4 codebook, smaller AND faster than int8 (Qwen3-1.7B @P=128 on RK3588:
//     NF4-from-F16 215 tok/s prefill / 6.77 decode, vs the int8 reference ~178).
//   • ALREADY-QUANTIZED >=5-bit (Q8/Q6/Q5) -> int8. int4 from a quantized source is warned by the
//     runtime and falls back to UNIFORM int4, not NF4 — 172 / 2.96, less than half the decode.
//   • <5-bit (Q4_K and below) -> null; the runtime's mixed dispatch decides.
export function orkQuantForSource(bits, npuQuant = 'auto') {
  if (npuQuant === 'int8') return '8';
  if (npuQuant === 'int4') return '4';
  if (npuQuant !== 'auto') return null;
  if (!Number.isFinite(bits)) return null;
  if (bits >= 16) return '4';
  if (bits >= 5)  return '8';
  return null;
}

// Has this .gguf been superseded by its pack? Once the pack exists the gguf is a build input, not a
// servable model, and listing both would offer the same weights twice — once the cheap way and once the
// way that double-carries them. THE single enumeration rule, shared by /v1/models and
// /api/admin/library so the two cannot drift.
export function supersededByPack(absGguf) {
  try { return fs.statSync(orkpackPathFor(absGguf)).size > 0; } catch { return false; }
}

// The 32 bytes at EOF, or null when the file is absent, too short, or unreadable.
export function readOrkpackFooter(packPath) {
  let fd = null;
  try {
    const size = fs.statSync(packPath).size;
    if (size <= FOOTER_SIZE) return null;
    const buf = Buffer.allocUnsafe(FOOTER_SIZE);
    fd = fs.openSync(packPath, 'r');
    if (fs.readSync(fd, buf, 0, FOOTER_SIZE, size - FOOTER_SIZE) !== FOOTER_SIZE) return null;
    return {
      size,
      indexOff: Number(buf.readBigUInt64LE(0)),
      nEntries: buf.readUInt32LE(8),
      version:  buf.readUInt32LE(12),
      orkFmt:   buf.readUInt32LE(16),
      quantSig: buf.readUInt32LE(20),
      magic:    buf.toString('latin1', 24, 31),   // 8th byte is the NUL terminator
    };
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

// The weight tier a pack was BUILT at, decoded from its signature (ork_sig_qbits).
export function sigQbits(sig) { return (sig & SIG_QB_MASK) === 0x34 /* '4' */ ? 4 : 8; }

// The precision a pack was BUILT at, in the same {orkQuant, orkHybrid} shape the load path uses. This is
// what a run must adopt to be compatible with it — the pack is the artifact, so under 'auto' it is the
// authority, not the filename. (sigCompatible(sig, sigPrecision(sig)) is true by construction.)
export function sigPrecision(sig) {
  // No orkNoRot: a clear HD bit does not mean the pack was built unrotated (see sigCompatible), so
  // there is nothing here a run could safely adopt.
  return { orkQuant: String(sigQbits(sig)), orkHybrid: (sig & SIG_HY_BIT) ? '1' : null };
}

// Mirror of ggml-ork's ork_sig_compatible: would a run at this precision ADOPT this pack, or reject it?
//   • ORK_HYBRID is PRESCRIPTIVE — it changes WHICH tensors are packed at all, so a mismatch is a
//     genuinely unusable file and must match exactly.
//   • ORK_QUANT is DESCRIPTIVE — the pack records the tier it was built at and a run with no forced
//     precision simply adopts it. It is only a gate when the run forces a precision.
// (ggml-ork deliberately does NOT check the rotation bit here; neither do we. It sets ORK_I4_NOROT
// apart as build/run-must-match by convention, and oRKLLM never sets it.)
export function sigCompatible(packSig, { orkQuant = null, orkHybrid = null, orkNoRot = null } = {}) {
  if ((packSig & SIG_HY_BIT) !== (orkHybrid ? SIG_HY_BIT : 0)) return false;
  // Rotation (SIG_HD_BIT), which ggml-ork itself skips. Checked in ONE direction only, deliberately.
  //
  // A set bit is trustworthy: it can only have been stamped by a build that rotated, so refusing to
  // serve it from an ORK_I4_NOROT run is always right. A CLEAR bit is not evidence of anything — the
  // runtime's own comment calls the field "vestigial in the sig", and the only real 4-bit pack
  // available to check (v5, sig 0x34) carries HD=0 despite having been built rotated. Treating clear
  // as "unrotated" would therefore reject every existing int4 pack as stale, which above
  // ORK_ORKPACK_MAX_REGEN_MB means abort() rather than rebuild.
  //
  // So: catch the direction the bit can actually prove, and leave the other to the build/run-must-match
  // convention until a v6 int4 pack confirms the bit is populated. oRKLLM never sets ORK_I4_NOROT, so
  // this is inert today; it exists so that changing that cannot silently produce a garbage model
  // (rotation is orthogonal — (R*A)·(R*B) == A*B — so a mismatch reads as fluent nonsense, not an error).
  if (orkNoRot && (packSig & SIG_HD_BIT)) return false;
  if (orkQuant) return sigQbits(packSig) === (String(orkQuant)[0] === '4' ? 4 : 8);
  return true;
}

// The env a pack build / a serving worker needs so both land on the same signature.
export function orkEnvFrom({ orkQuant = null, orkHybrid = null, orkNoRot = null,
                             orkMixedW4A4 = null, orkPromote = null } = {}) {
  const env = {};
  if (orkQuant)  env.ORK_QUANT  = String(orkQuant);
  if (orkHybrid) env.ORK_HYBRID = '1';
  if (orkNoRot)  env.ORK_I4_NOROT = '1';
  // Native W4A4 — the only path that issues real 4-bit MACs. ORK_QUANT=4 alone is the int4 STORAGE
  // tier: 4-bit on disk, inflated to int8 on the NPU and computed by the W8A8 kernel. These two select
  // the COMPUTE path, so they must be set identically on the build AND on the serving worker.
  if (orkMixedW4A4) { env.ORK_MIXED_W4A4 = '1'; env.ORK_MIXED_DISPATCH = '1'; }
  if (orkPromote)   env.ORK_I4_PROMOTE = String(orkPromote);
  return env;
}

// Identity of the installed llama runtime (its build tag, e.g. "b10664-ork"). No longer a freshness
// key — the footer is — but it scopes the format-token calibration below and is useful in logs.
export function llamaRuntimeTag() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(LLAMA_RUNTIME_DIR, 'manifest.json'), 'utf8'));
    return m.tag || m.orkDriverCommit || m.llamaCommit || null;
  } catch { return null; }
}

// ---- ork-driver on-disk format token (footer.ork_fmt) ----
//
// ggml-ork rejects a pack whose ork_fmt != ork_pack_format_version(), a compile-time constant in
// ork-driver bumped ONLY when the persisted bytes change meaning (tile layout / quant rule). We cannot
// call that function without loading the runtime, and hardcoding its current value here would rot: too
// low and we would loop rebuilding every pack, too high and we would call a pack fresh that the
// runtime then rejects at load.
//
// So we LEARN it instead. Every pack this runtime builds stamps the token it expects, so the first
// successful build under a given runtime tag tells us the answer for every later check. Until one has
// been observed the token is simply not used as a signal — which is the safe default, because the
// overwhelmingly common case is that a runtime update does not change the format at all.
const FMT_STATE = () => path.join(LLAMA_RUNTIME_DIR, 'orkpack-fmt.json');

// The calibration is keyed by runtime tag AND chipset. A .orkpack holds weights pre-tiled for the NPU's
// MAC geometry, so it is inherently chipset-specific — an RK3576 pack is not loadable on an RK3588 and
// vice versa. Nothing in the footer we read (magic/version/ork_fmt/quant_sig) states the chipset, so if
// MODELS_DIR is ever shared between boards (NFS, a copied models tree) a cross-chipset pack is only
// rejected if ork-driver's own ork_fmt token happens to differ per chip — which is not something we can
// determine from here. Keying our calibration by platform at least stops a shared or copied state file
// from certifying another chip's format as this one's. An unknown platform degrades to tag-only, and an
// unknown ork_fmt is simply not used as a signal, so this fails closed.
export function expectedOrkFmt() {
  const tag = llamaRuntimeTag();
  if (!tag) return null;
  const plat = getPlatform() ?? null;
  try {
    const s = JSON.parse(fs.readFileSync(FMT_STATE(), 'utf8'));
    if (!s || s.tag !== tag || !Number.isInteger(s.orkFmt)) return null;
    if ((s.platform ?? null) !== plat) return null;         // different chip (or pre-platform state)
    return s.orkFmt;
  } catch { return null; }
}

// Called with the footer of a pack the CURRENT runtime just wrote.
export function recordOrkFmt(orkFmt) {
  const tag = llamaRuntimeTag();
  if (!tag || !Number.isInteger(orkFmt)) return;
  if (expectedOrkFmt() === orkFmt) return;                 // already calibrated
  try {
    fs.mkdirSync(LLAMA_RUNTIME_DIR, { recursive: true });
    const plat = getPlatform() ?? null;
    fs.writeFileSync(FMT_STATE(), JSON.stringify({ tag, platform: plat, orkFmt, observedAt: Date.now() }));
    console.log(`[orkpack] runtime ${tag} on ${plat ?? 'unknown-chipset'} builds packs at ork_fmt=${orkFmt} — calibrated`);
  } catch { /* advisory only */ }
}

// ---- provenance sidecar (<pack>.prov.json) ----
//
// A .orkpack is a HARDWARE-SPECIFIC build artifact: the weights inside it are pre-tiled for one NPU's
// MAC geometry, produced by one ork-driver against one kernel driver. Its 32-byte footer records only
// what the runtime needs in order to decide adoption (schema version, format token, precision
// signature) — nothing about the machine that built it. So a pack that turns up on a box (copied,
// restored from a backup, served off a shared MODELS_DIR) is unattributable: you cannot ask it which
// chip it was tiled for.
//
// This is the same problem a pg_dump header solves. pg_dump stamps the server version, the dump format
// version and the creating tool into the archive so a restore can refuse — or at least explain — a
// mismatch, instead of failing obscurely deep in the data. We stamp the equivalent beside the pack at
// GENERATION time: chipset (read from the kernel), NPU core count and kernel driver version, the OS and
// kernel it was built on, the llama-runtime build tag, the ork-driver version the build itself reported,
// the precision the build was configured for, the footer as written, and the identity of the source GGUF.
//
// Deliberately ADVISORY, never a gate. Freshness stays the footer's job (isOrkpackUsable): a pack built
// by a bare llama-completion run outside oRKLLM has no sidecar at all, and treating "no sidecar" as
// "stale" would condemn a perfectly good pack and, over ORK_ORKPACK_MAX_REGEN_MB, abort the runtime.
// Absent or unreadable provenance therefore means UNKNOWN, not wrong.
//
// The real fix belongs upstream — a provenance block inside the pack cannot be separated from it by a
// file copy, and a sidecar can. Until ggml-ork carries one, this is the record we can keep.
const PROV_SCHEMA = 1;
export const provPathFor = (packPath) => packPath + '.prov.json';

// Pretty OS name from /etc/os-release (e.g. "Debian GNU/Linux 12 (bookworm)"). null off-Linux.
function osPrettyName() {
  try {
    const m = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?(.*?)"?$/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Record who/what/where built this pack. Called once, right after a build produces the pack.
 * `source` identifies the GGUF it was built from, `build` the precision + CLI configuration, and
 * `orkDriver` the version string the build process itself printed (e.g. "1.0.99 (W4A4)") — the runtime
 * is the only party that knows it, so the caller passes it through from the child's stderr.
 * Best-effort: a failure to write provenance must never fail a successful build.
 */
export function writeOrkpackProvenance(packPath, { source = null, build = null, orkDriver = null } = {}) {
  try {
    const footer = readOrkpackFooter(packPath);
    const drivers = getDeviceDrivers?.() || null;
    const rec = {
      schema: PROV_SCHEMA,
      createdAt: new Date().toISOString(),
      producer: 'oRKLLM',
      // The machine. Chipset is read from the kernel, never configured — see getPlatform().
      hardware: {
        chipset: getPlatform() ?? null,
        chipsetSource: getPlatformSource?.() ?? null,
        npuCores: getNpuCoreCount(),
        npuDriver: drivers?.npu ?? null,
        arch: process.arch,
      },
      // The OS it was tiled on.
      system: {
        os: osPrettyName(),
        kernel: os.release(),
        hostname: os.hostname(),
      },
      // The software that did the tiling.
      runtime: {
        llamaTag: llamaRuntimeTag(),
        orkDriver: orkDriver ?? null,
      },
      // What was asked for, and what came out.
      build: build ?? null,
      footer: footer ? {
        version: footer.version, orkFmt: footer.orkFmt, quantSig: footer.quantSig,
        nEntries: footer.nEntries, size: footer.size,
      } : null,
      source,
    };
    fs.writeFileSync(provPathFor(packPath), JSON.stringify(rec, null, 2));
    return rec;
  } catch { return null; }
}

/** Read a pack's provenance, or null when absent/unreadable/a schema we don't know. */
export function readOrkpackProvenance(packPath) {
  try {
    const rec = JSON.parse(fs.readFileSync(provPathFor(packPath), 'utf8'));
    return rec && rec.schema === PROV_SCHEMA ? rec : null;
  } catch { return null; }
}

/**
 * Does this pack's recorded provenance CONTRADICT the machine we are on? Advisory, and deliberately
 * one-directional: only a chipset that is present in the record AND differs from the detected one is a
 * mismatch. No record, no chipset in the record, or an undetectable local chipset all return null
 * ("unknown") — never false confidence in either direction.
 */
export function provenanceChipsetMismatch(packPath) {
  const rec = readOrkpackProvenance(packPath);
  const built = rec?.hardware?.chipset ?? null;
  const here = getPlatform() ?? null;
  if (!built || !here) return null;
  return built === here ? false : { builtFor: built, running: here };
}

// Is this .orkpack one the runtime would ADOPT (no re-conversion)? Structural validity plus, when a
// serving precision is supplied, the signature check that decides adoption. Omit `precision` to ask
// the weaker question "is this a well-formed pack for this runtime" (e.g. for a UI badge).
export function isOrkpackUsable(packPath, precision = null) {
  const f = readOrkpackFooter(packPath);
  if (!f) return false;
  if (f.magic !== MAGIC) return false;
  if (f.version !== ORKPACK_VERSION) return false;
  if (!(f.indexOff < f.size)) return false;                // truncated / corrupt index offset
  const exp = expectedOrkFmt();
  if (exp !== null && f.orkFmt !== exp) return false;      // tiling/quant format changed under us
  if (precision && !sigCompatible(f.quantSig, precision)) return false;
  return true;
}

export { ORKPACK_VERSION, FOOTER_SIZE, MAGIC };
