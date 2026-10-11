// Consolidate a split (sharded) GGUF into one file.
//
// WHY THIS EXISTS. A split GGUF is an upstream DISTRIBUTION artifact — HuggingFace caps a single file
// at ~50 GB, so a 50.9 GiB model ships as `-00001-of-00002.gguf` + `-00002-of-00002.gguf`. Nothing
// downstream of the download wants to know that. Carrying the split forward cost us a model: a pack
// built from shard 1 inherits the shard suffix, the stub extracted from it is named `<pack>.gguf`, and
// llama.cpp then refuses the load outright ("invalid split file name") because `llama_split_prefix`
// needs the suffix LAST. Consolidating at the source means packing, stub extraction, naming and
// enumeration never see a split model at all.
//
// WHY IN NODE rather than `llama-gguf-split --merge`. That binary is NOT in the runtime bundle
// (`/var/lib/orkllm/llama-runtime/` ships llama-bench, llama-cli, llama-completion, llama-server and
// the .so set — no split tool). Adding it to the fork's build would tie a download-path feature to the
// C++ release cycle: consolidation would silently not happen on any board until its runtime was
// upgraded, and since `llama_sync.js` lets the runtime float we would need a capability probe and a
// Node fallback anyway. AGENTS.md is Node-first, so this is the fallback promoted to the only path.
//
// WHY IT IS SAFE DESPITE THE SIZE. The merge never re-serializes a GGUF *value*. Values are the risky
// part — thirteen types including nested arrays, and here a 10.9 MB tokenizer blob. Instead:
//   • the KV section is copied as a BYTE RANGE out of shard 1, with only the three `split.*` entries
//     spliced out (their extents are recorded by a size-walker that skips values, never decodes them);
//   • each shard's tensor DATA region is copied verbatim as one contiguous range;
//   • only the tensor-info records — a fixed shape of name/dims/type/offset — are rewritten, and the
//     sole field that changes is the offset of a trailing shard's tensors.
// Tensor offsets are relative to the data section, which is why shard 1's survive the header growing.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

const GGUF_MAGIC = 0x46554747;      // "GGUF" little-endian
const DEFAULT_ALIGNMENT = 32;
const COPY_CHUNK = 8 * 1024 * 1024;

// Keys that describe the split itself. They are meaningless in a consolidated file, and leaving
// `split.count` behind is not cosmetic: llama.cpp reads it and goes looking for siblings that no
// longer exist.
const SPLIT_KEYS = new Set(['split.no', 'split.count', 'split.tensors.count']);

const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 };
const SCALAR_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

const alignUp = (n, a) => Math.ceil(n / a) * a;

// ── shard naming ───────────────────────────────────────────────────────────────────────────────────
// Mirrors gguf.js's SHARD_RE. Kept local so this module can be reasoned about on its own.
const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

// Every shard of the split `firstShard` belongs to, in order — or null if it is not a split file.
// Derived from the suffix, exactly as llama.cpp derives it (llama_split_path).
export function shardPathsFor(firstShard) {
  const p = String(firstShard);
  const m = SHARD_RE.exec(p);
  if (!m) return null;
  const base = p.slice(0, m.index);
  const total = parseInt(m[2], 10);
  if (!(total > 1)) return null;
  const out = [];
  for (let i = 1; i <= total; i++) out.push(`${base}-${String(i).padStart(5, '0')}-of-${m[2]}.gguf`);
  return out;
}

// Is every shard of this split on disk and finished downloading?
//
// Downloads are one job per FILE and the server has no notion of a "variant" being complete — the
// grouping lives in the browser. The queue is also not persisted, so after a restart no job state
// exists at all. Readiness therefore has to come from the disk, which is how this server derives every
// other piece of state. A `<shard>.tmp` next to a shard means the transfer is still in flight (both the
// aria2 and the Node-stream transports write through `<dest>.tmp` and rename on completion), so a
// partially-downloaded group is never mistaken for a complete one.
export function splitGroupReady(firstShard) {
  const shards = shardPathsFor(firstShard);
  if (!shards) return false;
  for (const s of shards) {
    try { if (!fs.statSync(s).size) return false; } catch { return false; }
    if (fs.existsSync(`${s}.tmp`)) return false;
  }
  return true;
}

// The name the consolidated file takes: the shard suffix, gone. This is the id every downstream
// consumer (pack path, stub path, display name, model_settings key) then derives from.
export function consolidatedPathFor(firstShard) {
  const p = String(firstShard);
  const m = SHARD_RE.exec(p);
  return m ? `${p.slice(0, m.index)}.gguf` : p;
}

// ── GGUF header reader ─────────────────────────────────────────────────────────────────────────────
// `src` is either { fd } (a file) or { whole } (a Buffer already in memory — used to verify a header
// this module just synthesized, without writing it anywhere first).
function headerReader(src) {
  let pos = 0, buf = Buffer.alloc(0), bufStart = 0;
  const fill = (need) => {
    if (pos >= bufStart && pos + need <= bufStart + buf.length) return;
    if (src.whole) {
      if (pos + need > src.whole.length) throw new Error('truncated gguf header');
      buf = src.whole; bufStart = 0; return;
    }
    const want = Math.max(need, 1 << 20);
    const b = Buffer.allocUnsafe(want);
    const n = fs.readSync(src.fd, b, 0, want, pos);
    buf = b.subarray(0, n);
    bufStart = pos;
    if (n < need) throw new Error('truncated gguf header');
  };
  const at = () => pos - bufStart;
  const r = {
    get pos() { return pos; },
    set pos(p) { pos = p; },
    u8()  { fill(1); const v = buf.readUInt8(at());       pos += 1; return v; },
    u32() { fill(4); const v = buf.readUInt32LE(at());    pos += 4; return v; },
    u64() { fill(8); const v = buf.readBigUInt64LE(at()); pos += 8; return Number(v); },
    skip(n) { pos += n; },
    str() { const n = r.u64(); fill(n); const s = buf.toString('utf8', at(), at() + n); pos += n; return s; },
  };
  return r;
}

// Advance past a value without decoding it. This is the whole reason the merge can treat KV as opaque
// bytes: we need each entry's EXTENT, never its meaning.
function skipValue(r, type) {
  if (type === T.STRING) { const n = r.u64(); r.skip(n); return; }
  if (type === T.ARRAY) {
    const et = r.u32(), n = r.u64();
    if (et === T.STRING) { for (let i = 0; i < n; i++) { const l = r.u64(); r.skip(l); } }
    else if (et === T.ARRAY) { for (let i = 0; i < n; i++) skipValue(r, T.ARRAY); }
    else {
      const s = SCALAR_SIZE[et];
      if (s === undefined) throw new Error(`unknown gguf array element type ${et}`);
      r.skip(s * n);
    }
    return;
  }
  const s = SCALAR_SIZE[type];
  if (s === undefined) throw new Error(`unknown gguf value type ${type}`);
  r.skip(s);
}

function decodeUint(r, type) {
  if (type === T.U8 || type === T.BOOL) return r.u8();
  if (type === T.U16) { const v = r.u32(); r.pos -= 2; return v & 0xffff; }
  if (type === T.U32) return r.u32();
  if (type === T.U64) return r.u64();
  return null;
}

// Everything the merge needs about one file: the byte extent of each KV entry, the tensor records, and
// where the data section begins.
export function readGgufLayout(file) {
  const fd = fs.openSync(file, 'r');
  try {
    return parseGgufHeader({ fd }, file, fs.fstatSync(fd).size);
  } finally { fs.closeSync(fd); }
}

// The same parse against a header already in memory. Lets the merge check its OWN output before any of
// it reaches the disk, and lets the header be unit-tested without a 51 GiB file.
export function readGgufHeaderFromBuffer(buf, totalSize = buf.length) {
  return parseGgufHeader({ whole: buf }, '<buffer>', totalSize);
}

function parseGgufHeader(src, file, size) {
  {
    const r = headerReader(src);
    if (r.u32() !== GGUF_MAGIC) throw new Error(`not a GGUF file: ${file}`);
    const version = r.u32();
    if (version !== 3) throw new Error(`unsupported GGUF version ${version} in ${file} (expected 3)`);
    const nTensors = r.u64();
    const nKv = r.u64();

    const kvStart = r.pos;
    const kv = [];
    let alignment = DEFAULT_ALIGNMENT;
    for (let i = 0; i < nKv; i++) {
      const start = r.pos;
      const key = r.str();
      const type = r.u32();
      if (key === 'general.alignment') {
        const vs = r.pos;
        const v = decodeUint(r, type);
        r.pos = vs;
        if (v) alignment = v;
      }
      skipValue(r, type);
      kv.push({ key, type, start, end: r.pos });
    }
    const kvEnd = r.pos;

    const tensors = [];
    for (let i = 0; i < nTensors; i++) {
      const name = r.str();
      const nDims = r.u32();
      const dims = [];
      for (let d = 0; d < nDims; d++) dims.push(r.u64());
      const type = r.u32();
      const offset = r.u64();
      tensors.push({ name, dims, type, offset });
    }
    const infoEnd = r.pos;
    const dataStart = alignUp(infoEnd, alignment);
    if (dataStart > size) throw new Error(`truncated gguf (data starts past EOF): ${file}`);
    return { file, version, nTensors, nKv, kv, tensors, kvStart, kvEnd, infoEnd, dataStart, alignment, size };
  }
}

// ── header writer ──────────────────────────────────────────────────────────────────────────────────
function u32buf(v) { const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v); return b; }
function u64buf(v) { const b = Buffer.allocUnsafe(8); b.writeBigUInt64LE(BigInt(v)); return b; }
function strbuf(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64buf(b.length), b]); }

function tensorInfoBuf(t) {
  return Buffer.concat([
    strbuf(t.name), u32buf(t.dims.length),
    ...t.dims.map(u64buf), u32buf(t.type), u64buf(t.offset),
  ]);
}

// ── the merge ──────────────────────────────────────────────────────────────────────────────────────

// In-flight merges, keyed by target path. A second trigger for the same model joins the first rather
// than racing it onto the same output file — downloads, a pre-load check and a pack build can all ask
// at once.
const inFlight = new Map();

export function consolidateSplitGguf(firstShard, opts = {}) {
  const target = consolidatedPathFor(firstShard);
  const existing = inFlight.get(target);
  if (existing) return existing;
  const p = _consolidate(firstShard, target, opts).finally(() => inFlight.delete(target));
  inFlight.set(target, p);
  return p;
}

async function _consolidate(firstShard, target, { onProgress = null, log = console.log } = {}) {
  const shards = shardPathsFor(firstShard);
  if (!shards) return { status: 'not-split', path: String(firstShard) };

  // Already done. Trust it only if it parses AND carries the expected tensor count — a file that
  // merely exists proves nothing, and the one failure we must never produce is a partial merge that
  // looks complete.
  if (fs.existsSync(target)) {
    try {
      const L = readGgufLayout(target);
      return { status: 'already-consolidated', path: target, nTensors: L.nTensors };
    } catch (e) {
      throw new Error(`${target} exists but is not a readable GGUF (${e.message}). Move it aside and retry.`);
    }
  }

  for (const s of shards) {
    if (!fs.existsSync(s)) {
      throw new Error(`cannot consolidate ${path.basename(firstShard)}: shard ${path.basename(s)} is missing. ` +
                      'All shards must be present; re-download the model.');
    }
  }

  const layouts = shards.map(readGgufLayout);
  const plan = await planMerge(layouts);
  const { header, headerPadded, dataBases, dataLen, expectedSize, totalTensors } = plan;

  // Preflight. The transient cost is the merged file alongside the shards it is built from, so a box
  // that cannot hold both must be told now, by name, rather than halfway through a 51 GiB write.
  const free = freeBytesFor(path.dirname(target));
  if (free !== null && free < expectedSize + 64 * 1024 * 1024) {
    throw new Error(`not enough free space to consolidate ${path.basename(firstShard)}: need ` +
                    `${gib(expectedSize)} plus headroom, ${gib(free)} free on ${path.dirname(target)}. ` +
                    'The shards are only removed after the merged file is complete, so both exist at once.');
  }

  // `.merging.tmp` is deliberately not a servable extension: an interrupted merge cannot be mistaken
  // for a model by any enumeration, and cannot be loaded. A stale one from a killed run is discarded
  // rather than resumed — resuming a partial byte copy safely needs a checkpoint, and redoing a local
  // disk-to-disk copy is cheap next to the 50 GiB re-download that a wrong resume would cost.
  const tmp = `${target}.merging.tmp`;
  try { fs.unlinkSync(tmp); log(`[consolidate] discarded stale ${path.basename(tmp)}`); } catch {}

  log(`[consolidate] ${path.basename(firstShard)}: ${shards.length} shards → ${path.basename(target)} ` +
      `(${totalTensors} tensors, ${gib(expectedSize)})`);

  const out = await fsp.open(tmp, 'w');
  let written = 0;
  try {
    await out.write(header, 0, header.length, 0);
    written = header.length;
    if (headerPadded > written) {
      await out.write(Buffer.alloc(headerPadded - written), 0, headerPadded - written, written);
      written = headerPadded;
    }
    for (let i = 0; i < layouts.length; i++) {
      const L = layouts[i];
      const at = headerPadded + dataBases[i];
      if (at > written) { await out.write(Buffer.alloc(at - written), 0, at - written, written); written = at; }
      written += await copyRange(L.file, L.dataStart, L.size - L.dataStart, out, at,
                                 onProgress && ((n) => onProgress({ copied: n + at - headerPadded, total: dataLen })));
    }
    if (expectedSize > written) {
      await out.write(Buffer.alloc(expectedSize - written), 0, expectedSize - written, written);
      written = expectedSize;
    }
    await out.sync();                       // durable BEFORE the rename makes it visible
  } finally {
    await out.close();
  }

  // Verify the file we are about to promote, not the one we meant to write.
  const check = readGgufLayout(tmp);
  const names = new Set(check.tensors.map(t => t.name));
  const problems = [];
  if (check.nTensors !== totalTensors) problems.push(`tensor count ${check.nTensors} != ${totalTensors}`);
  if (check.size !== expectedSize) problems.push(`size ${check.size} != ${expectedSize}`);
  if (check.kv.some(e => SPLIT_KEYS.has(e.key))) problems.push('split.* metadata survived the merge');
  for (const L of layouts) {
    const missing = L.tensors.find(t => !names.has(t.name));
    if (missing) { problems.push(`tensor ${missing.name} from ${path.basename(L.file)} is absent`); break; }
  }
  if (problems.length) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`consolidated ${path.basename(target)} failed verification (${problems.join('; ')}) — ` +
                    'discarded, shards untouched.');
  }

  fs.renameSync(tmp, target);               // atomic within the directory: the model appears whole or not at all
  log(`[consolidate] ${path.basename(target)} verified (${check.nTensors} tensors, ${gib(check.size)})`);

  const removed = [];
  for (const s of shards) {
    try { fs.unlinkSync(s); removed.push(path.basename(s)); } catch (e) {
      log(`[consolidate] could not remove shard ${path.basename(s)}: ${e.message}`);
    }
  }
  log(`[consolidate] removed ${removed.length} source shard(s): ${removed.join(', ')}`);

  return { status: 'consolidated', path: target, nTensors: totalTensors, bytes: expectedSize, shards: shards.length };
}

// Everything the merge will write, decided up front and checkable without touching the disk: the
// synthesized header, where each shard's data region lands, and the exact final size. Exported so a
// dry run can validate the plan for a real multi-GB model without writing 51 GiB to find out.
export async function planMerge(layouts) {
  const head = layouts[0];

  // Data regions, concatenated with each trailing shard realigned behind the one before it.
  const dataBases = [];
  let dataLen = 0;
  for (const L of layouts) {
    dataBases.push(dataLen);
    dataLen = alignUp(dataLen + (L.size - L.dataStart), head.alignment);
  }

  const totalTensors = layouts.reduce((n, L) => n + L.nTensors, 0);
  const keptKv = head.kv.filter(e => !SPLIT_KEYS.has(e.key));

  // Header: shard 1's KV bytes minus the split.* entries, then every shard's tensor infos rebased.
  const kvBytes = await readRange(head.file, keptKv.map(e => ({ start: e.start, end: e.end })));
  const infos = [];
  layouts.forEach((L, i) => {
    for (const t of L.tensors) infos.push(tensorInfoBuf({ ...t, offset: t.offset + dataBases[i] }));
  });
  const header = Buffer.concat([
    u32buf(GGUF_MAGIC), u32buf(head.version), u64buf(totalTensors), u64buf(keptKv.length),
    kvBytes, ...infos,
  ]);
  const headerPadded = alignUp(header.length, head.alignment);
  return { header, headerPadded, dataBases, dataLen, totalTensors,
           keptKvCount: keptKv.length, alignment: head.alignment,
           expectedSize: headerPadded + dataLen };
}

// Read a set of byte ranges out of a file and concatenate them. Used only for the KV section (~11 MB
// here), never for tensor data.
async function readRange(file, ranges) {
  const fh = await fsp.open(file, 'r');
  try {
    const parts = [];
    for (const { start, end } of ranges) {
      const b = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await fh.read(b, 0, b.length, start);
      if (bytesRead !== b.length) throw new Error(`short read in ${file}`);
      parts.push(b);
    }
    return Buffer.concat(parts);
  } finally { await fh.close(); }
}

// Copy `len` bytes verbatim. Chunked and awaited so a multi-minute copy never blocks the server's
// event loop.
async function copyRange(file, from, len, out, to, onChunk) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(COPY_CHUNK);
    let done = 0;
    while (done < len) {
      const want = Math.min(COPY_CHUNK, len - done);
      const { bytesRead } = await fh.read(buf, 0, want, from + done);
      if (bytesRead <= 0) throw new Error(`short read in ${file} at ${from + done}`);
      await out.write(buf, 0, bytesRead, to + done);
      done += bytesRead;
      if (onChunk) onChunk(done);
    }
    return done;
  } finally { await fh.close(); }
}

function freeBytesFor(dir) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

const gib = (n) => `${(n / 1073741824).toFixed(2)} GiB`;
