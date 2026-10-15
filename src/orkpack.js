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

// The footer is the LAST bytes of the file and it has GROWN, so its fields are addressed backwards from
// EOF, not forwards from a fixed offset. `magic` is the final 8 bytes in every version — that is the only
// anchor that has ever been stable, and it is what tells us we are looking at a pack at all.
//
//   v6 (32 B): u64 index_off | u32 n_entries | u32 version | u32 ork_fmt | u32 quant_sig | char magic[8]
//   v7 (64 B): …the same five, then u64 calib_off | u32 calib_n | u32 calib_pad
//                                 | u32 prov_flags | u32 prov_pad | u64 prov_imhash | char magic[8]
//
// v7 is the M-threshold calibration block plus build provenance (ggml-ork's orkpack_footer, as written
// by ork-driver >= 1.0.1xx / llama-runtime b11552-ork). Reading a v7 pack at the v6 offsets does not
// fail loudly: `magic` still lands, so the file is recognised as a pack, and the five fields are then
// read 32 bytes too early — every one of them zero in practice, so the pack reports version 0 with 0
// entries and is condemned as stale on every scan. That is a rebuild loop over packs that are perfectly
// good, which is why the layout is selected by the version field rather than assumed.
const MAGIC = 'ORKPK01';
// Every layout we can PARSE. This table is about readability, not acceptance: a v6 pack is still
// decoded at its own offsets so a stale pack reports accurately instead of as a zeroed unknown.
// v8 shares v7's LAYOUT — that bump is semantic (the declined set is stored QUANTISED, token_embd ->
// Q4_K / lm_head -> Q6_K, and the 4-bit tier is chosen by a measured RAM rule rather than an env flag),
// so it maps to the same 64 bytes.
const FOOTER_SIZES = { 6: 32, 7: 64, 8: 64 };
const MAX_FOOTER_SIZE = 64;

// ---- which version do we EXPECT? ask the runtime, do not assume ------------------------------------
//
// Acceptance is EXACT equality, mirroring ggml-ork's ork_pack_version_ok(), which is
// `v == ORKPACK_VERSION`. The question is whose ORKPACK_VERSION.
//
// It cannot be a number typed here. This service and the llama runtime are SEPARATELY DEPLOYED: the
// service ships as an apt package, the runtime as a tarball adopted independently
// (<LLAMA_RUNTIME_DIR>/manifest.json), and a board routinely runs a current package against a
// months-old runtime. If the reader says 8 and the deployed builder writes 7, nothing errors — it
// LOOPS: every pack on disk reads stale, the conversion scheduler rebuilds, the rebuild spawns the
// DEPLOYED runtime, that v7 builder writes a v7 pack, the reader calls it stale again. A v7 builder
// can never satisfy a v8 reader, and each turn is GGUF-load-bound (hours for a 27B), so the first
// casualty is the largest pack on the box. Keeping two numbers equal across two release channels was a
// merge-ordering rule someone had to remember; the second number is gone instead.
//
// So the runtime publishes what it actually builds. ggml-ork stamps its ORKPACK_VERSION into the
// library as "ORKPACK_FORMAT_VERSION=<n>" and the release workflow lifts it out of the built artifact
// into manifest.json as `orkpackVersion`. We read that.

// The newest layout this reader can parse — DERIVED from FOOTER_SIZES, so adding a row is the only
// edit. This is not what we expect; it is only how far ahead we can still read. See
// orkpackVersionInfo() for the number that actually decides acceptance.
const ORKPACK_VERSION_NEWEST_KNOWN = Math.max(...Object.keys(FOOTER_SIZES).map(Number));

// What to assume when the installed runtime does not say — i.e. ANY runtime built before the manifest
// carried `orkpackVersion`, which is every bundle currently in the wild.
//
// 7, explicitly, and NOT "the newest we know". The two directions are not symmetric:
//   • assume OLD and be wrong → we call a pack fresh that the runtime then declines, and the runtime
//     regenerates it once, on its own, at load. One rebuild, self-correcting.
//   • assume NEW and be wrong → the non-terminating rebuild loop above.
// So the fallback is the last version that shipped in a release bundle, and it must only ever move
// forward when a runtime that OMITS the field can no longer be the one installed.
const ORKPACK_VERSION_FALLBACK = 7;

/**
 * Resolve the pack version in force from a runtime manifest OBJECT. Pure — the caller supplies the
 * manifest, so this is exercised directly in tests without a runtime on disk and without an env knob.
 *
 * Returns { version, layoutKnown, fromManifest, source }:
 *   • version      — the number a pack's footer must carry to be adopted.
 *   • layoutKnown  — false when the runtime names a version we have no footer layout for (a runtime
 *                     NEWER than this service). We then cannot adjudicate freshness at all, and
 *                     isOrkpackUsable stops gating on the version rather than condemning every pack
 *                     to a rebuild whose result our own reader could never accept either.
 *   • fromManifest — did the runtime actually tell us, or are we assuming?
 *   • source       — one clause, for the log.
 */
export function resolveOrkpackVersion(manifest) {
  const fb = (source) => ({ version: ORKPACK_VERSION_FALLBACK, layoutKnown: true, fromManifest: false, source });
  if (!manifest || typeof manifest !== 'object') return fb('no readable runtime manifest');
  const v = manifest.orkpackVersion;
  if (v === undefined || v === null)
    // Every bundle built before the runtime started publishing the field. NOT an error — it is the
    // expected state on any board that has not yet adopted a newer runtime.
    return fb('installed runtime predates the manifest orkpackVersion field');
  if (!Number.isInteger(v) || v <= 0)
    return fb(`manifest orkpackVersion is not a version number (${JSON.stringify(v)})`);
  if (!(v in FOOTER_SIZES))
    return { version: v, layoutKnown: false, fromManifest: true,
             source: `installed runtime builds v${v}, newer than any layout this service can parse ` +
                     `(up to v${ORKPACK_VERSION_NEWEST_KNOWN}) — freshness NOT adjudicated here` };
  return { version: v, layoutKnown: true, fromManifest: true, source: 'installed runtime manifest' };
}

/**
 * The pack version in force, read from the installed runtime. Uncached, like llamaRuntimeTag(): a
 * runtime install REPLACES manifest.json mid-process (syncLlamaRuntime), and the conversion
 * scheduler's revalidation runs immediately after, so a cached answer would be the pre-install one at
 * exactly the moment it matters.
 */
export function orkpackVersionInfo() {
  const m = runtimeManifest();                 // read ONCE: this runs per pack during a models-dir scan
  return { ...resolveOrkpackVersion(m), tag: manifestTag(m) };
}

/** Just the number. */
export function orkpackVersion() { return orkpackVersionInfo().version; }

/** The footer size of a given version (default: the one in force). MAX for a layout we do not know. */
export function footerSize(version = orkpackVersion()) { return FOOTER_SIZES[version] ?? MAX_FOOTER_SIZE; }

/**
 * Say the pack version in force, and where it came from, once at startup. A reader/builder mismatch
 * should be visible in a log rather than inferred from a box that quietly rebuilds forever — the same
 * reason ggml-ork names the pack variant it picked on every run.
 */
export function logOrkpackVersionInForce() {
  const i = orkpackVersionInfo();
  console.log(`[orkpack] pack format v${i.version} in force — ${i.source}` +
              `${i.tag ? ` (llama-runtime ${i.tag})` : ''}` +
              `${i.fromManifest ? '' : ` [assumed; this reader parses up to v${ORKPACK_VERSION_NEWEST_KNOWN}]`}`);
  return i;
}

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

const PACK_SHARD_RE = /-(\d{5})-of-(\d{5})\.orkpack$/i;

// The sparse gguf extracted from a pack. Same name the runtime's own build-time stub uses, so the two
// are interchangeable and only ever one file exists.
//
// EXCEPT for a pack built from a SPLIT gguf. `orkpackPathFor` only swaps the extension, so such a pack
// carries the shard suffix — `<base>-00001-of-00002.orkpack` — and llama.cpp resolves a split model's
// sibling shards by requiring the filename it is handed to END with `-NNNNN-of-MMMMM.gguf`
// (`llama_split_prefix`, called from `llama_get_list_splits`). Plain `<pack>.gguf` buries the suffix
// mid-name and the load dies with
//     llama_model_load: error loading model: invalid split file name: …-00001-of-00002.orkpack.gguf
// before a single tensor is read. So keep the suffix TERMINAL: `<base>.orkpack-00001-of-00002.gguf`.
export function stubPathFor(packPath) {
  const p = String(packPath);
  const m = PACK_SHARD_RE.exec(p);
  // m[0] is `-NNNNN-of-MMMMM.orkpack`; move `.orkpack` in front of the suffix.
  return m ? `${p.slice(0, m.index)}.orkpack${m[0].replace(/\.orkpack$/i, '')}.gguf` : `${p}.gguf`;
}

// The sibling shards llama.cpp will go looking for once it has read `split.count` out of the stub, as
// [{ link, target }] — empty for an unsplit pack. The stub reproduces only the shard the pack was built
// FROM (shard 1); the rest of the model still lives in the source gguf's trailing shards, which are not
// renamed, so each needs a name under the stub's prefix. Symlinks, not copies: these are multi-GB files
// and the targets are exactly the shards already sitting next to the pack.
export function stubSiblingShards(packPath) {
  const p = String(packPath);
  const m = PACK_SHARD_RE.exec(p);
  if (!m) return [];
  const base = p.slice(0, m.index);            // …/Qwen3.8-27B-BF16
  const total = parseInt(m[2], 10);
  const out = [];
  for (let i = 2; i <= total; i++) {
    const sfx = `-${String(i).padStart(5, '0')}-of-${m[2]}`;
    out.push({ link: `${base}.orkpack${sfx}.gguf`, target: `${base}${sfx}.gguf` });
  }
  return out;
}

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

// The footer at EOF, or null when the file is absent, too short, unreadable, or not a pack.
//
// The layout is chosen by the version field, which is why each candidate is tried in turn: a footer is
// accepted only when the version it claims matches the size of the layout we read it at. A pack whose
// version is known to neither still returns a record (magic, size, version: 0) so callers can tell
// "unrecognised pack" from "not a pack" — both are stale, but only one is a file we wrote.
export function readOrkpackFooter(packPath) {
  let fd = null;
  try {
    const size = fs.statSync(packPath).size;
    if (size <= FOOTER_SIZES[6]) return null;
    const want = Math.min(size, MAX_FOOTER_SIZE);
    const buf = Buffer.allocUnsafe(want);
    fd = fs.openSync(packPath, 'r');
    if (fs.readSync(fd, buf, 0, want, size - want) !== want) return null;
    // magic is the final 8 bytes in every version (7 chars + NUL).
    const magic = buf.toString('latin1', want - 8, want - 1);
    if (magic !== MAGIC) return null;
    for (const [v, fsz] of Object.entries(FOOTER_SIZES)) {
      if (want < fsz) continue;
      const at = want - fsz;                                 // where this layout's footer would start
      if (buf.readUInt32LE(at + 12) !== Number(v)) continue; // version field — the layout's own witness
      const f = {
        size, magic,
        indexOff: Number(buf.readBigUInt64LE(at)),
        nEntries: buf.readUInt32LE(at + 8),
        version:  buf.readUInt32LE(at + 12),
        orkFmt:   buf.readUInt32LE(at + 16),
        quantSig: buf.readUInt32LE(at + 20),
      };
      if (fsz >= 64) {                                       // v7: calibration block + build provenance
        f.calibOff   = Number(buf.readBigUInt64LE(at + 24));
        f.calibN     = buf.readUInt32LE(at + 32);
        f.provFlags  = buf.readUInt32LE(at + 40);
        f.provImhash = buf.readBigUInt64LE(at + 48).toString(16);
      }
      return f;
    }
    return { size, magic, indexOff: 0, nEntries: 0, version: 0, orkFmt: 0, quantSig: 0 };
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

// The installed runtime bundle's manifest, or null when there is no runtime / it is unreadable. The
// bundle ships it (tag, llamaCommit, orkDriverCommit, orkpackVersion) and the adopt step adds the
// installed asset's identity (assetName/assetSize/assetSha) — see llama_sync.js. Everything we know
// about the runtime WITHOUT loading it comes from here.
function runtimeManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(LLAMA_RUNTIME_DIR, 'manifest.json'), 'utf8'));
    return (m && typeof m === 'object') ? m : null;
  } catch { return null; }
}

// Identity of the installed llama runtime (its build tag, e.g. "b10664-ork"). No longer a freshness
// key — the footer is — but it scopes the format-token calibration below and is useful in logs.
function manifestTag(m) { return m ? (m.tag || m.orkDriverCommit || m.llamaCommit || null) : null; }
export function llamaRuntimeTag() { return manifestTag(runtimeManifest()); }

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
//
// `expected` is the pack version in force; it defaults to whatever the INSTALLED runtime says it
// builds (orkpackVersionInfo) and is an argument rather than an env knob so tests can pass one.
export function isOrkpackUsable(packPath, precision = null, expected = orkpackVersionInfo()) {
  const f = readOrkpackFooter(packPath);
  if (!f) return false;
  if (f.magic !== MAGIC) return false;
  // EXACT equality, mirroring ork_pack_version_ok() — except when the runtime names a version whose
  // layout we cannot parse. Then our own reader could not accept the rebuild either, so gating here
  // would only spin the conversion scheduler; leave the verdict to the runtime, which is the one
  // party that can actually act on it. logOrkpackVersionInForce() says so at startup.
  if (expected.layoutKnown !== false && f.version !== expected.version) return false;
  if (!(f.indexOff < f.size)) return false;                // truncated / corrupt index offset
  const exp = expectedOrkFmt();
  if (exp !== null && f.orkFmt !== exp) return false;      // tiling/quant format changed under us
  if (precision && !sigCompatible(f.quantSig, precision)) return false;
  return true;
}

// No ORKPACK_VERSION / FOOTER_SIZE constants: there is no single right answer independent of the
// installed runtime. Use orkpackVersion() / orkpackVersionInfo() / footerSize().
export { ORKPACK_VERSION_FALLBACK, ORKPACK_VERSION_NEWEST_KNOWN, FOOTER_SIZES, MAGIC };
