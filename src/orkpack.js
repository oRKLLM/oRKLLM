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
import path from 'path';
import { LLAMA_RUNTIME_DIR } from './config.js';

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

export function orkpackPathFor(absGguf) { return absGguf.replace(/\.gguf$/i, '.orkpack'); }

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

// Mirror of ggml-ork's ork_sig_compatible: would a run at this precision ADOPT this pack, or reject it?
//   • ORK_HYBRID is PRESCRIPTIVE — it changes WHICH tensors are packed at all, so a mismatch is a
//     genuinely unusable file and must match exactly.
//   • ORK_QUANT is DESCRIPTIVE — the pack records the tier it was built at and a run with no forced
//     precision simply adopts it. It is only a gate when the run forces a precision.
// (ggml-ork deliberately does NOT check the rotation bit here; neither do we. It sets ORK_I4_NOROT
// apart as build/run-must-match by convention, and oRKLLM never sets it.)
export function sigCompatible(packSig, { orkQuant = null, orkHybrid = null } = {}) {
  if ((packSig & SIG_HY_BIT) !== (orkHybrid ? SIG_HY_BIT : 0)) return false;
  if (orkQuant) return sigQbits(packSig) === (String(orkQuant)[0] === '4' ? 4 : 8);
  return true;
}

// The env a pack build / a serving worker needs so both land on the same signature.
export function orkEnvFrom({ orkQuant = null, orkHybrid = null } = {}) {
  const env = {};
  if (orkQuant)  env.ORK_QUANT  = String(orkQuant);
  if (orkHybrid) env.ORK_HYBRID = '1';
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

export function expectedOrkFmt() {
  const tag = llamaRuntimeTag();
  if (!tag) return null;
  try {
    const s = JSON.parse(fs.readFileSync(FMT_STATE(), 'utf8'));
    return s && s.tag === tag && Number.isInteger(s.orkFmt) ? s.orkFmt : null;
  } catch { return null; }
}

// Called with the footer of a pack the CURRENT runtime just wrote.
export function recordOrkFmt(orkFmt) {
  const tag = llamaRuntimeTag();
  if (!tag || !Number.isInteger(orkFmt)) return;
  if (expectedOrkFmt() === orkFmt) return;                 // already calibrated
  try {
    fs.mkdirSync(LLAMA_RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(FMT_STATE(), JSON.stringify({ tag, orkFmt, observedAt: Date.now() }));
    console.log(`[orkpack] runtime ${tag} builds packs at ork_fmt=${orkFmt} — calibrated`);
  } catch { /* advisory only */ }
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
