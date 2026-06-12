// Convert a PyTorch `pytorch_model.bin` (and `.pt`/`.pth`) to `.safetensors`,
// in pure Node — no Python, no torch. Some EAGLE-3 draft heads (e.g. several
// AngelSlim releases) ship only as a pickled PyTorch checkpoint, but the Vulkan
// draft loader (`src/addon/vk_eagle.hpp`) reads safetensors. This bridges them.
//
// A modern torch.save file is a ZIP (all entries STORED/uncompressed) holding:
//   <root>/data.pkl      — a protocol-2+ pickle describing the state_dict
//   <root>/data/<key>    — raw little-endian storage bytes (often shared: many
//                          tensors view into one storage at different offsets)
//   <root>/byteorder     — "little" | "big"  (we require little)
//
// The pickle builds an OrderedDict of name -> tensor, each tensor via
// `torch._utils._rebuild_tensor_v2(storage, storage_offset, size, stride, ...)`
// where `storage` is a persistent-id tuple ('storage', <Type>Storage, key,
// location, numel). Saved weights are contiguous, so each tensor's bytes are the
// contiguous slice storage[offset .. offset+prod(size)] — copied verbatim into
// safetensors (no dtype/layout conversion). We only interpret the small set of
// pickle opcodes torch emits; unknown REDUCE/BUILD targets resolve to inert
// placeholders so non-tensor bookkeeping (e.g. state_dict `_metadata`) is ignored.

import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

// torch storage class -> { safetensors dtype, bytes per element }
const STORAGE_DTYPE = {
  DoubleStorage:   { dtype: 'F64',  size: 8 },
  FloatStorage:    { dtype: 'F32',  size: 4 },
  HalfStorage:     { dtype: 'F16',  size: 2 },
  BFloat16Storage: { dtype: 'BF16', size: 2 },
  LongStorage:     { dtype: 'I64',  size: 8 },
  IntStorage:      { dtype: 'I32',  size: 4 },
  ShortStorage:    { dtype: 'I16',  size: 2 },
  CharStorage:     { dtype: 'I8',   size: 1 },
  ByteStorage:     { dtype: 'U8',   size: 1 },
  BoolStorage:     { dtype: 'BOOL', size: 1 },
};

// ── Minimal ZIP reader (central directory) ─────────────────────────────────
// Returns a Map name -> { method, dataStart, compSize, uncompSize } for a fd.
function readZipEntries(fd, fileSize) {
  // Find End Of Central Directory record (scan back from EOF; max comment 64KB).
  const tail = Math.min(fileSize, 65557);
  const buf = Buffer.alloc(tail);
  fs.readSync(fd, buf, 0, tail, fileSize - tail);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD) — is this a legacy pickle .bin?');
  const cdEntries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  // ZIP64 fallback when the 32-bit offset is saturated.
  if (cdOffset === 0xffffffff) cdOffset = fileSize - tail + eocd - cdSize;

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);

  const entries = new Map();
  let p = 0;
  for (let e = 0; e < cdEntries; e++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method   = cd.readUInt16LE(p + 10);
    const compSize  = cd.readUInt32LE(p + 20);
    const uncompSize = cd.readUInt32LE(p + 24);
    const nameLen  = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const cmtLen   = cd.readUInt16LE(p + 32);
    const lho      = cd.readUInt32LE(p + 42);
    const name     = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // Local file header: 30 bytes fixed + name + extra; data follows.
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, lho);
    const lhNameLen  = lh.readUInt16LE(26);
    const lhExtraLen = lh.readUInt16LE(28);
    const dataStart  = lho + 30 + lhNameLen + lhExtraLen;
    entries.set(name, { method, dataStart, compSize, uncompSize });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function readEntry(fd, entry) {
  const raw = Buffer.alloc(entry.compSize);
  fs.readSync(fd, raw, 0, entry.compSize, entry.dataStart);
  if (entry.method === 0) return raw;            // stored
  if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

// ── Minimal pickle VM (protocol 2–5, torch state_dict subset) ───────────────
// Custom objects we care about are tagged; everything else is inert.
const REBUILD_TENSOR = Symbol('rebuild_tensor');
const ORDERED_DICT   = Symbol('ordered_dict');

function unpickle(buf) {
  let i = 0;
  const stack = [];
  const memo = [];
  const marks = [];
  const rd = {
    u8:  () => buf[i++],
    i32: () => { const v = buf.readInt32LE(i); i += 4; return v; },
    u16: () => { const v = buf.readUInt16LE(i); i += 2; return v; },
    u32: () => { const v = buf.readUInt32LE(i); i += 4; return v; },
    u64: () => { const v = Number(buf.readBigUInt64LE(i)); i += 8; return v; },
    line: () => { const s = i; while (buf[i] !== 0x0a) i++; const v = buf.toString('latin1', s, i); i++; return v; },
    str: (n) => { const v = buf.toString('utf8', i, i + n); i += n; return v; },
  };
  const persistent_load = (pid) => {
    // torch: ('storage', <Type>Storage, key, location, numel)
    if (Array.isArray(pid) && pid[0] === 'storage') {
      const stype = pid[1];                      // global sentinel, e.g. name 'torch.LongStorage'
      const cls = (stype && stype.name ? stype.name : String(stype)).split('.').pop();
      return { __storage__: true, storageClass: cls, key: String(pid[2]), location: pid[3], numel: pid[4] };
    }
    return { __storage__: true, raw: pid };
  };
  const doReduce = (callable, args) => {
    if (callable === ORDERED_DICT) return new Map();
    if (callable === REBUILD_TENSOR) {
      const [storage, storageOffset, size, stride] = args;
      return { __tensor__: true, storage, storageOffset, size, stride };
    }
    if (callable && callable.__global__) return { __obj__: callable.name, args };
    return { __inert__: true };
  };

  for (;;) {
    const op = buf[i++];
    switch (op) {
      case 0x80: rd.u8(); break;                               // PROTO
      case 0x95: rd.u64(); break;                              // FRAME
      case 0x2e: return stack.pop();                           // STOP
      case 0x28: marks.push(stack.length); break;              // MARK
      case 0x4e: stack.push(null); break;                      // NONE
      case 0x88: stack.push(true); break;                      // NEWTRUE
      case 0x89: stack.push(false); break;                     // NEWFALSE
      case 0x4a: stack.push(rd.i32()); break;                  // BININT
      case 0x4b: stack.push(rd.u8()); break;                   // BININT1
      case 0x4d: stack.push(rd.u16()); break;                  // BININT2
      case 0x8a: { const n = rd.u8(); let v = 0n; for (let k = 0; k < n; k++) v |= BigInt(buf[i++]) << (8n * BigInt(k)); stack.push(Number(v)); break; } // LONG1
      case 0x47: { const v = buf.readDoubleBE(i); i += 8; stack.push(v); break; } // BINFLOAT
      case 0x58: stack.push(rd.str(rd.u32())); break;          // BINUNICODE
      case 0x8c: stack.push(rd.str(rd.u8())); break;           // SHORT_BINUNICODE
      case 0x8d: stack.push(rd.str(rd.u64())); break;          // BINUNICODE8
      case 0x55: stack.push(rd.str(rd.u8())); break;           // SHORT_BINSTRING
      case 0x54: stack.push(rd.str(rd.u32())); break;          // BINSTRING
      case 0x7d: stack.push(new Map()); break;                 // EMPTY_DICT
      case 0x5d: stack.push([]); break;                        // EMPTY_LIST
      case 0x29: stack.push([]); break;                        // EMPTY_TUPLE
      case 0x85: { const a = stack.pop(); stack.push([a]); break; }                         // TUPLE1
      case 0x86: { const b = stack.pop(), a = stack.pop(); stack.push([a, b]); break; }      // TUPLE2
      case 0x87: { const c = stack.pop(), b = stack.pop(), a = stack.pop(); stack.push([a, b, c]); break; } // TUPLE3
      case 0x74: { const m = marks.pop(); stack.push(stack.splice(m)); break; }              // TUPLE
      case 0x6c: { const m = marks.pop(); stack.push(stack.splice(m)); break; }              // LIST
      case 0x61: { const v = stack.pop(); stack[stack.length - 1].push(v); break; }          // APPEND
      case 0x65: { const m = marks.pop(); const items = stack.splice(m); stack[stack.length - 1].push(...items); break; } // APPENDS
      case 0x71: memo[rd.u8()] = stack[stack.length - 1]; break;   // BINPUT
      case 0x72: memo[rd.u32()] = stack[stack.length - 1]; break;  // LONG_BINPUT
      case 0x94: memo[memo.length] = stack[stack.length - 1]; break; // MEMOIZE
      case 0x68: stack.push(memo[rd.u8()]); break;                 // BINGET
      case 0x6a: stack.push(memo[rd.u32()]); break;                // LONG_BINGET
      case 0x63: { const mod = rd.line(), name = rd.line(); stack.push(resolveGlobal(mod, name)); break; } // GLOBAL
      case 0x93: { const name = stack.pop(), mod = stack.pop(); stack.push(resolveGlobal(mod, name)); break; } // STACK_GLOBAL
      case 0x51: stack.push(persistent_load(stack.pop())); break;  // BINPERSID
      case 0x52: { const args = stack.pop(), callable = stack.pop(); stack.push(doReduce(callable, args)); break; } // REDUCE
      case 0x81: { const args = stack.pop(), callable = stack.pop(); stack.push(doReduce(callable, args)); break; } // NEWOBJ
      case 0x73: { const v = stack.pop(), k = stack.pop(), d = stack[stack.length - 1]; if (d instanceof Map) d.set(k, v); break; } // SETITEM
      case 0x75: { const m = marks.pop(); const items = stack.splice(m); const d = stack[stack.length - 1]; // SETITEMS
                   if (d instanceof Map) for (let k = 0; k < items.length; k += 2) d.set(items[k], items[k + 1]); break; }
      case 0x62: { stack.pop(); break; }                           // BUILD (apply state — ignore; e.g. _metadata)
      default: throw new Error(`unsupported pickle opcode 0x${op.toString(16)} at byte ${i - 1}`);
    }
  }

  function resolveGlobal(mod, name) {
    if (mod === 'collections' && name === 'OrderedDict') return ORDERED_DICT;
    if (mod === 'torch._utils' && name === '_rebuild_tensor_v2') return REBUILD_TENSOR;
    // _rebuild_parameter(data, requires_grad, hooks) -> just unwrap data
    if (mod === 'torch._utils' && name === '_rebuild_parameter') return { __global__: true, name, unwrap: true };
    return { __global__: true, name: `${mod}.${name}` };
  }
}

// Flatten the unpickled state_dict (Map) into [name, tensorDesc] pairs,
// unwrapping _rebuild_parameter wrappers.
function collectTensors(root) {
  const out = [];
  if (!(root instanceof Map)) throw new Error('pickle root is not a state_dict');
  for (const [name, val] of root) {
    let t = val;
    if (t && t.__obj__ && t.unwrap && Array.isArray(t.args)) t = t.args[0];
    if (t && t.__tensor__) out.push([String(name), t]);
  }
  return out;
}

function contiguousStride(size) {
  const s = new Array(size.length);
  let acc = 1;
  for (let d = size.length - 1; d >= 0; d--) { s[d] = acc; acc *= size[d]; }
  return s;
}

/**
 * Convert a PyTorch checkpoint to safetensors.
 * @returns {Promise<{tensors:number, bytes:number, outPath:string}>}
 */
export async function convertPtToSafetensors(binPath, outPath, { log = () => {} } = {}) {
  const fd = fs.openSync(binPath, 'r');
  try {
    const { size: fileSize } = fs.fstatSync(fd);
    const entries = readZipEntries(fd, fileSize);

    // Root prefix (e.g. "pytorch_model/" or "archive/").
    let root = '';
    for (const k of entries.keys()) {
      if (k.endsWith('/data.pkl')) { root = k.slice(0, -('data.pkl'.length)); break; }
    }
    if (!entries.has(root + 'data.pkl')) throw new Error('no data.pkl in archive');

    const byteorderEntry = entries.get(root + 'byteorder');
    if (byteorderEntry) {
      const bo = readEntry(fd, byteorderEntry).toString('latin1').trim();
      if (bo && bo !== 'little') throw new Error(`big-endian checkpoint not supported (byteorder=${bo})`);
    }

    const pkl = readEntry(fd, entries.get(root + 'data.pkl'));
    const tensors = collectTensors(unpickle(pkl));
    if (!tensors.length) throw new Error('no tensors found in checkpoint');

    // Build safetensors header (tensors emitted in pickle/declaration order).
    const header = {};
    const plan = [];
    let dataOff = 0;
    for (const [name, t] of tensors) {
      const dt = STORAGE_DTYPE[t.storage.storageClass];
      if (!dt) throw new Error(`unknown storage type ${t.storage.storageClass} for ${name}`);
      const size = t.size.map(Number);
      const stride = t.stride.map(Number);
      const want = contiguousStride(size);
      const numel = size.reduce((a, b) => a * b, 1);
      if (numel > 0 && stride.join(',') !== want.join(',')) {
        throw new Error(`tensor ${name} is non-contiguous (stride ${stride} != ${want}); not supported`);
      }
      const byteLen = numel * dt.size;
      const storageEntry = entries.get(`${root}data/${t.storage.key}`);
      if (!storageEntry) throw new Error(`missing storage data/${t.storage.key} for ${name}`);
      plan.push({
        name, byteLen,
        srcPos: storageEntry.dataStart + (Number(t.storageOffset) * dt.size),
        method: storageEntry.method, storageEntry,
      });
      header[name] = { dtype: dt.dtype, shape: size, data_offsets: [dataOff, dataOff + byteLen] };
      dataOff += byteLen;
    }
    header.__metadata__ = { format: 'pt' };

    let headerJson = Buffer.from(JSON.stringify(header), 'utf8');
    // safetensors requires the header length (and thus data start) to be 8-aligned.
    const pad = (8 - (headerJson.length % 8)) % 8;
    if (pad) headerJson = Buffer.concat([headerJson, Buffer.alloc(pad, 0x20)]); // pad with spaces

    const out = fs.openSync(outPath, 'w');
    try {
      const lenBuf = Buffer.alloc(8);
      lenBuf.writeBigUInt64LE(BigInt(headerJson.length), 0);
      fs.writeSync(out, lenBuf);
      fs.writeSync(out, headerJson);
      // Stream each tensor's bytes from the zip (no full-storage buffering).
      const CHUNK = 8 * 1024 * 1024;
      const chunk = Buffer.alloc(CHUNK);
      for (const p of plan) {
        if (p.method === 0) {
          let remaining = p.byteLen, pos = p.srcPos;
          while (remaining > 0) {
            const n = Math.min(CHUNK, remaining);
            fs.readSync(fd, chunk, 0, n, pos);
            fs.writeSync(out, chunk, 0, n);
            remaining -= n; pos += n;
          }
        } else {
          // compressed storage: inflate the whole entry, then slice
          const full = readEntry(fd, p.storageEntry);
          const begin = p.srcPos - p.storageEntry.dataStart;
          fs.writeSync(out, full.subarray(begin, begin + p.byteLen));
        }
        log(`  ${p.name}: ${p.byteLen} bytes`);
      }
    } finally {
      fs.closeSync(out);
    }
    log(`Wrote ${tensors.length} tensors (${dataOff} bytes) → ${path.basename(outPath)}`);
    return { tensors: tensors.length, bytes: dataOff, outPath };
  } finally {
    fs.closeSync(fd);
  }
}
